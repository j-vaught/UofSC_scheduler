#!/usr/bin/env python3
"""
Build pre-computed embeddings for semantic course search.

Generates two files:
  1. static/data/course_embeddings.json — course metadata + embedding vectors
  2. static/data/word_embeddings.json — vocabulary word embeddings

At runtime, the client averages word embeddings to form a query vector,
then computes cosine similarity against course vectors. No model needed
in the browser — just fast array math.

Uses PCA to reduce from 384 dims to 128 for smaller file sizes while
retaining most similarity structure.
"""

import json
import os
import sys
import re
import numpy as np
from collections import Counter

INPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'course_data.json')
COURSE_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'data', 'course_embeddings.json')
WORD_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'data', 'word_embeddings.json')
DIMS = 128  # PCA target dimensions


def main():
    print("Loading course data...")
    with open(INPUT) as f:
        courses = json.load(f)

    # Filter to courses with descriptions
    courses = [c for c in courses if c.get('description') or c.get('title')]
    print(f"  {len(courses)} courses with content")

    # Build text for each course (title + description)
    texts = []
    for c in courses:
        t = (c.get('title', '') + '. ' + c.get('description', '')).strip()
        texts.append(t)

    # Extract vocabulary: all words that appear in course texts
    print("\nExtracting vocabulary...")
    word_freq = Counter()
    for t in texts:
        words = re.findall(r'[a-z]{3,}', t.lower())
        word_freq.update(words)

    # Keep words appearing in at least 2 courses, max 50% of courses
    max_freq = len(courses) * 0.5
    vocab = [w for w, c in word_freq.items() if 2 <= c <= max_freq]
    vocab.sort()
    print(f"  {len(vocab)} vocabulary words (from {len(word_freq)} total)")

    # Load sentence-transformers model
    print("\nLoading embedding model (all-MiniLM-L6-v2)...")
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer('all-MiniLM-L6-v2')

    # Embed all courses
    print(f"\nEmbedding {len(texts)} courses...")
    course_vecs = model.encode(texts, show_progress_bar=True, batch_size=256,
                                normalize_embeddings=True)
    print(f"  Shape: {course_vecs.shape}")

    # Embed vocabulary words
    print(f"\nEmbedding {len(vocab)} vocabulary words...")
    word_vecs = model.encode(vocab, show_progress_bar=True, batch_size=256,
                              normalize_embeddings=True)
    print(f"  Shape: {word_vecs.shape}")

    # PCA: fit on course embeddings, apply to both
    print(f"\nApplying PCA ({course_vecs.shape[1]} → {DIMS} dims)...")
    all_vecs = np.vstack([course_vecs, word_vecs])
    mean = all_vecs.mean(axis=0)
    centered = all_vecs - mean
    # SVD for PCA
    U, S, Vt = np.linalg.svd(centered, full_matrices=False)
    components = Vt[:DIMS]  # top-K principal components

    course_pca = (course_vecs - mean) @ components.T
    word_pca = (word_vecs - mean) @ components.T

    # Normalize after PCA
    course_norms = np.linalg.norm(course_pca, axis=1, keepdims=True)
    course_norms[course_norms == 0] = 1
    course_pca = course_pca / course_norms

    word_norms = np.linalg.norm(word_pca, axis=1, keepdims=True)
    word_norms[word_norms == 0] = 1
    word_pca = word_pca / word_norms

    # Variance explained
    total_var = (S ** 2).sum()
    explained_var = (S[:DIMS] ** 2).sum()
    print(f"  Variance explained: {explained_var/total_var:.1%}")

    # Quantize to int8 for compact storage (-128 to 127)
    # Since vectors are normalized, values are in [-1, 1]
    course_q = np.clip(np.round(course_pca * 127), -128, 127).astype(np.int8)
    word_q = np.clip(np.round(word_pca * 127), -128, 127).astype(np.int8)

    # Save course embeddings
    print("\nSaving course embeddings...")
    course_data = {
        'dims': DIMS,
        'courses': [],
    }
    for i, c in enumerate(courses):
        course_data['courses'].append({
            'code': c['code'],
            'title': c.get('title', ''),
            'subject': c.get('subject', ''),
            'key': c.get('key', ''),
            'vec': course_q[i].tolist(),
        })

    with open(COURSE_OUT, 'w') as f:
        json.dump(course_data, f, separators=(',', ':'))
    size_kb = os.path.getsize(COURSE_OUT) / 1024
    print(f"  Saved to {COURSE_OUT} ({size_kb:.0f} KB)")

    # Save word embeddings
    print("Saving word embeddings...")
    word_data = {
        'dims': DIMS,
        'words': {},
    }
    for i, w in enumerate(vocab):
        word_data['words'][w] = word_q[i].tolist()

    with open(WORD_OUT, 'w') as f:
        json.dump(word_data, f, separators=(',', ':'))
    size_kb = os.path.getsize(WORD_OUT) / 1024
    print(f"  Saved to {WORD_OUT} ({size_kb:.0f} KB)")

    # Test: similarity search for a few queries
    print("\n--- Test searches ---")
    test_queries = ['machine learning', 'machine learning engineering',
                    'robot AI autonomous exploration', 'organic chemistry']
    for q in test_queries:
        # Build query vector by averaging word embeddings
        tokens = re.findall(r'[a-z]{3,}', q.lower())
        token_vecs = []
        for t in tokens:
            idx = vocab.index(t) if t in vocab else -1
            if idx >= 0:
                token_vecs.append(word_pca[idx])
        if not token_vecs:
            print(f'\n  "{q}": no vocabulary matches')
            continue
        qvec = np.mean(token_vecs, axis=0)
        qvec = qvec / (np.linalg.norm(qvec) + 1e-10)

        # Cosine similarity against all courses
        sims = course_pca @ qvec
        top_idx = np.argsort(-sims)[:10]
        print(f'\n  "{q}" → top 10:')
        for idx in top_idx:
            c = courses[idx]
            print(f'    {sims[idx]:.3f}  {c["code"]}: {c["title"]}')


if __name__ == '__main__':
    main()

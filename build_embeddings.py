#!/usr/bin/env python3
"""
Build pre-computed embeddings for semantic course search.

Generates:
  static/data/word_embeddings.json — vocabulary word embeddings (int8, 128-dim PCA)
  static/data/phrase_embeddings.json — common academic phrase embeddings (int8, 128-dim PCA)

The phrase embeddings are bigrams/trigrams extracted from course titles and
descriptions. At search time, the client finds the nearest phrases to the
query vector and uses those as API search terms. This gives much better
expansion than single-word nearest neighbors.

Uses all-MiniLM-L6-v2 for embedding, PCA to 128 dims.
"""

import json
import os
import re
import numpy as np
from collections import Counter

INPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'course_data.json')
PHRASE_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'data', 'phrase_embeddings.json')
PCA_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'data', 'pca_params.json')
DIMS = 128

STOPWORDS = set("""
a an the and or but in on of to for with by at from is are was were be been
being have has had do does did will would shall should may might can could
this that these those it its they them their there here not no nor so as
such very more most also than other each every all any some no both few
many much how what which who whom whose when where why if then than too
only just about above after again against before between into through
during out over under further once up down off own same until while
per our his her your its we you one two three
""".split())

# Additional academic filler to exclude from phrases
ACADEMIC_FILLER = set("""
course courses student students study studies topic topics include includes
including included credit credits hour hours semester semesters class classes
prerequisite prerequisites corequisite required requires requirement focus
focuses focused introduction introductory advanced selected special offered
designed emphasis examines examination provides provided concepts principles
applications areas aspects methods techniques approaches overview survey
covers covered covering consideration development analysis problems readings
research reading experience experiences practice will various role use used
using major current contemporary week laboratory arranged instructor taken
""".split())


# Short but meaningful terms to always keep in vocabulary
KEEP_SHORT = {'ai', 'ml', 'cs', 'it', 'db', 'os', 'ui', 'ux', 'ip', 'rl'}


def tokenize(text):
    words = re.findall(r'[a-z]{2,}', text.lower())
    return [w for w in words
            if (w in KEEP_SHORT or len(w) >= 3)
            and w not in STOPWORDS and w not in ACADEMIC_FILLER]


def extract_phrases(texts, min_count=3, max_count_ratio=0.05):
    """Extract meaningful bigrams and trigrams from course texts."""
    max_count = int(len(texts) * max_count_ratio)
    bigram_counts = Counter()
    trigram_counts = Counter()

    for text in texts:
        words = tokenize(text)
        for i in range(len(words) - 1):
            # Skip phrases where both words are the same
            if words[i] != words[i+1]:
                bigram_counts[(words[i], words[i+1])] += 1
        for i in range(len(words) - 2):
            # Skip if any adjacent pair is the same word
            if words[i] != words[i+1] and words[i+1] != words[i+2]:
                trigram_counts[(words[i], words[i+1], words[i+2])] += 1

    phrases = []
    # Be more selective: bigrams need 3+ occurrences, trigrams need 3+
    for gram, count in bigram_counts.items():
        if min_count <= count <= max_count:
            # Skip phrases with generic filler combinations
            if len(set(gram)) == len(gram):  # all words unique
                phrases.append(' '.join(gram))
    for gram, count in trigram_counts.items():
        if min_count <= count <= max_count:
            if len(set(gram)) == len(gram):
                phrases.append(' '.join(gram))

    phrases = sorted(set(phrases))
    return phrases


def main():
    print("Loading course data...")
    with open(INPUT) as f:
        courses = json.load(f)

    courses = [c for c in courses if c.get('description') or c.get('title')]
    print(f"  {len(courses)} courses with content")

    texts = []
    for c in courses:
        t = (c.get('title', '') + '. ' + c.get('description', '')).strip()
        texts.append(t)

    # Extract phrases
    print("\nExtracting phrases (bigrams + trigrams)...")
    phrases = extract_phrases(texts, min_count=5, max_count_ratio=0.05)
    print(f"  {len(phrases)} phrases")

    # Load model
    print("\nLoading embedding model (all-MiniLM-L6-v2)...")
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer('all-MiniLM-L6-v2')

    # Embed phrases
    print(f"\nEmbedding {len(phrases)} phrases...")
    phrase_vecs = model.encode(phrases, show_progress_bar=True, batch_size=256,
                                normalize_embeddings=True)

    # PCA: fit on phrase vectors
    print(f"\nApplying PCA ({phrase_vecs.shape[1]} → {DIMS} dims)...")
    mean = phrase_vecs.mean(axis=0)
    centered = phrase_vecs - mean
    U, S, Vt = np.linalg.svd(centered, full_matrices=False)
    components = Vt[:DIMS]

    phrase_pca = centered @ components.T

    # Normalize
    phrase_norms = np.linalg.norm(phrase_pca, axis=1, keepdims=True)
    phrase_norms[phrase_norms == 0] = 1
    phrase_pca = phrase_pca / phrase_norms

    total_var = (S ** 2).sum()
    explained_var = (S[:DIMS] ** 2).sum()
    print(f"  Variance explained: {explained_var/total_var:.1%}")

    # Quantize phrase embeddings
    phrase_q = np.clip(np.round(phrase_pca * 127), -128, 127).astype(np.int8)

    # Save phrase embeddings
    print("\nSaving phrase embeddings...")
    phrase_data = {'dims': DIMS, 'phrases': {}}
    for i, p in enumerate(phrases):
        phrase_data['phrases'][p] = phrase_q[i].tolist()
    with open(PHRASE_OUT, 'w') as f:
        json.dump(phrase_data, f, separators=(',', ':'))
    print(f"  {os.path.getsize(PHRASE_OUT) / 1024:.0f} KB")

    # Save PCA params (for applying the same transform to query vectors in the browser)
    print("Saving PCA params...")
    pca_data = {
        'dims': DIMS,
        'mean': mean.tolist(),
        'components': components.tolist(),  # shape: [DIMS, 384]
    }
    with open(PCA_OUT, 'w') as f:
        json.dump(pca_data, f, separators=(',', ':'))
    print(f"  {os.path.getsize(PCA_OUT) / 1024:.0f} KB")

    # === TEST HARNESS ===
    # Test with the REAL model embedding full queries (simulates what Transformers.js will do)
    print("\n" + "="*70)
    print("QUERY EXPANSION TEST (using real model for query embedding)")
    print("="*70)

    test_queries = [
        'machine learning',
        'machine learning engineering',
        'robot AI autonomous exploration',
        'organic chemistry',
        'cyber security',
        'data science',
        'civil engineering structures',
        'Spanish literature',
        'transfer of heat',
        'car engineering',
        'coding for beginners',
        'brain science',
        'money and investing',
        'building bridges',
        'how computers work',
    ]

    for q in test_queries:
        # Embed the FULL query with the real model (same as Transformers.js will do)
        qvec_raw = model.encode(q, normalize_embeddings=True)
        # Apply PCA
        qvec_pca = (qvec_raw - mean) @ components.T
        qvec_pca = qvec_pca / (np.linalg.norm(qvec_pca) + 1e-10)

        # Find nearest phrases
        phrase_sims = phrase_pca @ qvec_pca
        top_phrase_idx = np.argsort(-phrase_sims)[:20]

        query_lower = q.lower().strip()
        selected = []
        for idx in top_phrase_idx:
            sim = phrase_sims[idx]
            if sim < 0.25:
                break
            p = phrases[idx]
            if p.lower().strip() == query_lower:
                continue
            selected.append((p, sim))
            if len(selected) >= 8:
                break

        print(f'\n  Query: "{q}"')
        print(f'  Top expanded phrases:')
        for p, sim in selected:
            print(f'    {sim:.3f}  "{p}"')

        api_searches = [q] + [p for p, _ in selected]
        print(f'  → {len(api_searches)} API calls: {api_searches}')


if __name__ == '__main__':
    main()

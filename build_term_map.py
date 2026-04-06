#!/usr/bin/env python3
"""
Build a term co-occurrence map from course_data.json using TF-IDF.

For each distinctive term found in course descriptions, finds the most
related terms (terms that frequently co-occur in the same descriptions).

Output: static/data/term_map.json
  {
    "machine": ["learning", "algorithms", "neural", "classification", ...],
    "robot": ["autonomous", "control", "sensors", "navigation", ...],
    ...
  }
"""

import json
import math
import re
import os
from collections import Counter, defaultdict

INPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'course_data.json')
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'data', 'term_map.json')

# Common English stopwords + academic filler words
STOPWORDS = set("""
a an the and or but in on of to for with by at from is are was were be been
being have has had do does did will would shall should may might can could
this that these those it its they them their there here not no nor so as
such very more most also than other each every all any some no both few
many much how what which who whom whose when where why if then than too
only just about above after again against before between into through
during out over under further once up down off own same until while
course courses student students study studies topic topics include includes
including included credit credits hour hours semester semesters class classes
prerequisite prerequisites corequisite required requires requirement focus
focuses focused introduction introductory advanced selected special
offered designed emphasis examines examination provides provided
concepts principles applications areas aspects methods techniques approaches
overview survey covers covered covering consideration development analysis
problems readings research reading experience experiences practice
will various role use used using major current contemporary
three two one per arranged instructor may taken
""".split())

# Minimum document frequency (must appear in at least N course descriptions)
MIN_DF = 2
# Maximum document frequency ratio (skip terms in >15% of all docs — stricter to remove generic academic words)
MAX_DF_RATIO = 0.15
# Number of related terms to store per term
TOP_K_RELATED = 12
# Minimum TF-IDF score to be considered a real term
MIN_TFIDF = 0.015


def tokenize(text):
    """Extract lowercase word tokens, filtering stopwords and short words."""
    words = re.findall(r'[a-z]{3,}', text.lower())
    return [w for w in words if w not in STOPWORDS and len(w) >= 3]


def main():
    with open(INPUT) as f:
        courses = json.load(f)

    # Combine title + description for richer text
    docs = []
    for c in courses:
        text = (c.get('title', '') + ' ' + c.get('description', '')).strip()
        if text:
            docs.append(tokenize(text))

    print(f"Loaded {len(docs)} course documents")

    # Build vocabulary with document frequencies
    df = Counter()  # term -> number of docs containing it
    for doc in docs:
        for term in set(doc):
            df[term] += 1

    n_docs = len(docs)
    max_df = int(n_docs * MAX_DF_RATIO)

    # Filter vocabulary
    vocab = {t for t, count in df.items() if MIN_DF <= count <= max_df}
    print(f"Vocabulary: {len(vocab)} terms (from {len(df)} total, filtered by df=[{MIN_DF}, {max_df}])")

    # Compute IDF for each term
    idf = {t: math.log(n_docs / df[t]) for t in vocab}

    # Build TF-IDF vectors per document (sparse)
    doc_vectors = []
    for doc in docs:
        tf = Counter(doc)
        doc_len = len(doc) or 1
        vec = {}
        for term in set(doc):
            if term in vocab:
                vec[term] = (tf[term] / doc_len) * idf[term]
        doc_vectors.append(vec)

    # Build co-occurrence matrix: for each pair of terms that appear in the same
    # document, accumulate a score = product of their TF-IDF weights in that doc.
    # This favors pairs that are both distinctive in the same document.
    print("Building co-occurrence matrix...")
    cooccur = defaultdict(lambda: defaultdict(float))

    for vec in doc_vectors:
        terms = [t for t, s in vec.items() if s >= MIN_TFIDF]
        for i, t1 in enumerate(terms):
            for t2 in terms[i+1:]:
                score = vec[t1] * vec[t2]
                cooccur[t1][t2] += score
                cooccur[t2][t1] += score

    # For each term, get top-K related terms
    print("Extracting top related terms...")
    term_map = {}
    for term in sorted(cooccur.keys()):
        related = sorted(cooccur[term].items(), key=lambda x: -x[1])
        top = [t for t, _ in related[:TOP_K_RELATED]]
        if top:
            term_map[term] = top

    print(f"Term map: {len(term_map)} terms with relationships")

    # Save
    with open(OUTPUT, 'w') as f:
        json.dump(term_map, f, separators=(',', ':'))

    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"Saved to {OUTPUT} ({size_kb:.0f} KB)")

    # Show some examples
    print("\n--- Sample entries ---")
    for sample in ['machine', 'robot', 'network', 'chemical', 'history', 'psychology']:
        if sample in term_map:
            print(f"  {sample}: {term_map[sample][:8]}")
        else:
            print(f"  {sample}: (not in map)")

    # Simulate query expansion
    print("\n--- Query expansion simulations ---")
    for query in ['machine learning', 'robot AI autonomous exploration']:
        tokens = tokenize(query)
        expanded = set(tokens)
        for t in tokens:
            if t in term_map:
                expanded.update(term_map[t][:8])
        # Group expanded terms into search phrases (single words become keyword searches)
        search_terms = sorted(expanded)
        print(f"\n  Query: \"{query}\"")
        print(f"  Tokens: {tokens}")
        print(f"  Expanded to {len(search_terms)} terms: {search_terms}")
        print(f"  API calls needed: {len(search_terms)} keyword searches")


if __name__ == '__main__':
    main()

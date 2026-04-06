#!/usr/bin/env python3
"""
Scrape all UofSC course data (code, title, description) from the bulletin API.

Strategy:
  1. Bulk search (1 request) gets all ~9700 course codes/titles/keys.
  2. Fetch details concurrently (10 at a time) for descriptions.
  3. Save to course_data.json.

Total requests: ~9,700 + 1. Runtime: ~3 minutes with 10 concurrent workers.
"""

import json
import time
import urllib.request
import urllib.error
import sys
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed

BULLETIN_API = 'https://academicbulletins.sc.edu/course-search/api/?page=fose&route='
SRCDB = '2026'
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'course_data.json')
CONCURRENCY = 10


def api_post(route, body):
    url = BULLETIN_API + route
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def strip_html(text):
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'&[a-zA-Z]+;', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def fetch_detail(key):
    """Fetch detail for a single course key. Returns (key, detail_dict) or (key, None)."""
    try:
        detail = api_post('details', {'group': f'key:{key}', 'srcdb': SRCDB})
        return (key, detail)
    except Exception:
        return (key, None)


def main():
    print(f"Scraping all UofSC courses from bulletin API (srcdb={SRCDB})")
    print(f"Concurrency: {CONCURRENCY} workers\n")

    # Step 1: Bulk search — 1 request for all courses
    print("Fetching full course catalog (1 request)...")
    data = api_post('search', {'other': {'srcdb': SRCDB}, 'criteria': []})
    all_courses = data.get('results', [])
    print(f"  Got {len(all_courses)} courses\n")

    if not all_courses:
        print("ERROR: No courses returned from bulk search.")
        sys.exit(1)

    # Build course entries
    courses = {}
    for c in all_courses:
        key = c.get('key', '')
        courses[key] = {
            'code': c.get('code', ''),
            'title': strip_html(c.get('title', '') or c.get('name', '')),
            'description': '',
            'subject': c.get('code', '').split(' ')[0],
            'key': key,
        }

    # Step 2: Fetch details concurrently
    keys = list(courses.keys())
    print(f"Fetching details for {len(keys)} courses ({CONCURRENCY} concurrent)...")
    start = time.time()
    fetched = 0
    errors = 0

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(fetch_detail, k): k for k in keys}
        for future in as_completed(futures):
            key, detail = future.result()
            if detail and isinstance(detail, dict):
                desc = detail.get('description', '')
                if desc:
                    courses[key]['description'] = strip_html(desc)
                # Also grab prereq text while we're here
                prereq = detail.get('prereq', '')
                if prereq:
                    courses[key]['prereq'] = strip_html(prereq)
                hours = detail.get('hours_html', '')
                if hours:
                    courses[key]['hours'] = strip_html(hours)
                fetched += 1
            else:
                errors += 1
            total = fetched + errors
            if total % 100 == 0 or total == len(keys):
                elapsed = time.time() - start
                rate = total / elapsed if elapsed > 0 else 0
                eta = (len(keys) - total) / rate if rate > 0 else 0
                sys.stdout.write(f"\r  [{total}/{len(keys)}] fetched={fetched} errors={errors} "
                                 f"({rate:.0f}/s, ETA {eta:.0f}s)")
                sys.stdout.flush()

    elapsed = time.time() - start
    print(f"\n\nDone in {elapsed:.1f}s ({len(keys)/elapsed:.0f} requests/s)")

    # Stats
    result = list(courses.values())
    with_desc = sum(1 for c in result if c['description'])
    without_desc = sum(1 for c in result if not c['description'])
    print(f"\nTotal: {len(result)} courses")
    print(f"  With description: {with_desc}")
    print(f"  Without description: {without_desc}")

    # Save
    with open(OUTPUT, 'w') as f:
        json.dump(result, f, indent=2)
    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"\nSaved to {OUTPUT} ({size_kb:.0f} KB)")


if __name__ == '__main__':
    main()

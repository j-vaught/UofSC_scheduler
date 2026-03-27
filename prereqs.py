"""Prerequisite fetcher using the UofSC Bulletin FOSE API."""

import json
import re
import urllib.request
import cache


BULLETIN_API = 'https://academicbulletins.sc.edu/course-search/api/?page=fose&route='


def fetch_bulletin_search(subject, srcdb='2026'):
    """Search the bulletin for all courses in a subject."""
    payload = json.dumps({
        'other': {'srcdb': srcdb},
        'criteria': [{'field': 'subject', 'value': subject}],
    }).encode()
    key = cache.make_key(BULLETIN_API + 'search', payload.decode())
    cached = cache.get(key)
    if cached:
        return json.loads(cached)
    req = urllib.request.Request(
        BULLETIN_API + 'search',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = resp.read()
    cache.put(key, data, ttl=86400)
    return json.loads(data)


def fetch_bulletin_details(bulletin_key, srcdb='2026'):
    """Get details (prereqs, etc.) for a specific course from the bulletin."""
    payload = json.dumps({
        'group': f'key:{bulletin_key}',
        'srcdb': srcdb,
    }).encode()
    key = cache.make_key(BULLETIN_API + 'details', payload.decode())
    cached = cache.get(key)
    if cached:
        return json.loads(cached)
    req = urllib.request.Request(
        BULLETIN_API + 'details',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = resp.read()
    cache.put(key, data, ttl=86400)
    return json.loads(data)


def parse_prereq_html(html):
    """Extract course codes from the prereq HTML string."""
    if not html:
        return []
    # Match course codes like MATH 242, EMCH 201, ENCP 260
    codes = re.findall(r'[A-Z]{3,4}\s+\d{3}[A-Z]?', html)
    return list(set(codes))


def get_prereqs_for_subject(subject, srcdb='2026'):
    """Get all prerequisites for courses in a subject. Returns {code: {prereqs, coreqs, title}}."""
    search = fetch_bulletin_search(subject, srcdb)
    result = {}
    for course in search.get('results', []):
        bkey = course.get('key')
        code = course.get('code', '')
        if not bkey:
            continue
        try:
            details = fetch_bulletin_details(bkey, srcdb)
            prereq_html = details.get('prereq', '')
            coreq_html = details.get('corequisite', '') or details.get('prerequisite_or_corequisite', '')
            result[code] = {
                'title': details.get('title', ''),
                'credits': details.get('hours_html', ''),
                'prereqs': parse_prereq_html(prereq_html),
                'prereq_raw': prereq_html,
                'coreqs': parse_prereq_html(coreq_html),
                'coreq_raw': coreq_html,
                'crosslisted': details.get('crosslisted', ''),
            }
        except Exception:
            result[code] = {'title': course.get('title', ''), 'prereqs': [], 'coreqs': []}
    return result


def check_prereqs(course_code, completed_courses, prereq_data):
    """Check if prerequisites are met for a course."""
    info = prereq_data.get(course_code)
    if not info:
        return {'met': True, 'missing': [], 'unknown': True}
    prereqs = info.get('prereqs', [])
    if not prereqs:
        return {'met': True, 'missing': []}
    completed_set = set(completed_courses)
    missing = [p for p in prereqs if p not in completed_set]
    return {'met': len(missing) == 0, 'missing': missing}

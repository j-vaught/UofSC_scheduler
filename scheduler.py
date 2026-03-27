"""CSP-based course schedule solver with weighted scoring."""

import json
import time
import copy


def parse_meeting_times(mt_str):
    """Parse the JSON-encoded meetingTimes string into structured dicts."""
    if not mt_str:
        return []
    try:
        raw = json.loads(mt_str) if isinstance(mt_str, str) else mt_str
        return [{'day': int(m['meet_day']), 'start': int(m['start_time']), 'end': int(m['end_time'])} for m in raw]
    except (json.JSONDecodeError, KeyError, TypeError):
        return []


def times_overlap(a_times, b_times):
    """Check if two sets of meeting times conflict."""
    for a in a_times:
        for b in b_times:
            if a['day'] == b['day']:
                if a['start'] < b['end'] and b['start'] < a['end']:
                    return True
    return False


def blocked_conflict(section_times, blocked):
    """Check if section times conflict with blocked time slots."""
    for st in section_times:
        for bl in blocked:
            if st['day'] == bl['day']:
                if st['start'] < bl['end'] and bl['start'] < st['end']:
                    return True
    return False


def is_consistent(section, assignment, blocked_times):
    """Check hard constraints for adding a section to current assignment."""
    s_times = section['_parsed_times']
    if blocked_conflict(s_times, blocked_times):
        return False
    for assigned in assignment.values():
        if times_overlap(s_times, assigned['_parsed_times']):
            return False
    return True


def score_schedule(assignment, prefs):
    """Score a feasible schedule based on soft constraints."""
    score = 0.0
    all_meetings = []

    for section in assignment.values():
        # Instructor preference
        instr = section.get('instr', '')
        if instr in prefs.get('preferred_instructors', {}):
            score += prefs['preferred_instructors'][instr] * 10
        if instr in prefs.get('avoided_instructors', {}):
            score -= prefs['avoided_instructors'][instr] * 10

        for mt in section['_parsed_times']:
            all_meetings.append(mt)

    if not all_meetings:
        return score

    pref_start = prefs.get('preferred_start', 800)
    pref_end = prefs.get('preferred_end', 2100)

    for m in all_meetings:
        if m['start'] < pref_start:
            score -= 5 * (pref_start - m['start']) / 100
        if m['end'] > pref_end:
            score -= 5 * (m['end'] - pref_end) / 100

    gap_weight = prefs.get('gap_penalty_weight', 2.0)
    compact_weight = prefs.get('day_compactness_weight', 3.0)
    consec_weight = prefs.get('consecutive_penalty_weight', 2.0)

    active_days = set()
    day_meetings = {}
    for m in all_meetings:
        active_days.add(m['day'])
        day_meetings.setdefault(m['day'], []).append(m)

    score -= compact_weight * len(active_days)

    for day, meetings in day_meetings.items():
        sorted_m = sorted(meetings, key=lambda x: x['start'])
        for i in range(1, len(sorted_m)):
            gap = sorted_m[i]['start'] - sorted_m[i - 1]['end']
            if gap > 30:
                score -= gap_weight * (gap / 60)
            elif gap < 15 and gap >= 0:
                score -= consec_weight

    return score


def solve(params):
    """
    Solve the scheduling problem.

    params: {
        courses: [{code, sections: [{crn, code, title, section, instr, meetingTimes, ...}]}],
        preferences: {
            blocked_times: [{day, start, end}],
            preferred_instructors: {name: weight},
            avoided_instructors: {name: weight},
            preferred_start: int,
            preferred_end: int,
            max_credits: int,
            gap_penalty_weight: float,
            day_compactness_weight: float,
            consecutive_penalty_weight: float,
        },
        max_results: int (default 10),
    }
    """
    courses = params.get('courses', [])
    prefs = params.get('preferences', {})
    max_k = params.get('max_results', 10)
    blocked = prefs.get('blocked_times', [])

    # Pre-parse meeting times for all sections
    for course in courses:
        for sec in course.get('sections', []):
            sec['_parsed_times'] = parse_meeting_times(sec.get('meetingTimes', ''))

    # Sort courses by domain size (MCV heuristic)
    courses_sorted = sorted(courses, key=lambda c: len(c.get('sections', [])))

    solutions = []
    target = max_k * 3
    deadline = time.time() + 5.0  # 5-second timeout

    def backtrack(idx, assignment):
        if time.time() > deadline:
            return True
        if idx == len(courses_sorted):
            solutions.append(copy.deepcopy(assignment))
            return len(solutions) >= target

        course = courses_sorted[idx]
        code = course['code']

        for section in course.get('sections', []):
            if not section.get('_parsed_times'):
                continue
            if is_consistent(section, assignment, blocked):
                assignment[code] = section
                if backtrack(idx + 1, assignment):
                    return True
                del assignment[code]

        return False

    backtrack(0, {})

    # Score and rank
    scored = []
    for sol in solutions:
        s = score_schedule(sol, prefs)
        # Clean up internal fields for response
        clean = {}
        for code, sec in sol.items():
            clean_sec = {k: v for k, v in sec.items() if not k.startswith('_')}
            clean[code] = clean_sec
        scored.append({'sections': clean, 'score': round(s, 2)})

    scored.sort(key=lambda x: x['score'], reverse=True)

    return {
        'total_found': len(solutions),
        'returned': min(max_k, len(scored)),
        'schedules': scored[:max_k],
    }

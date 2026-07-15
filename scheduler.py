"""CSP-based course schedule solver with weighted scoring."""

import copy
import json
import math
import time


def hhmm_to_minutes(value):
    """Convert a Banner-style HHMM value to minutes after midnight."""
    value = int(value)
    return (value // 100) * 60 + value % 100


def parse_meeting_times(mt_str):
    """Parse the JSON-encoded meetingTimes string into structured dicts."""
    if not mt_str:
        return []
    try:
        raw = json.loads(mt_str) if isinstance(mt_str, str) else mt_str
        return [
            {"day": int(m["meet_day"]), "start": int(m["start_time"]), "end": int(m["end_time"])}
            for m in raw
        ]
    except (json.JSONDecodeError, KeyError, TypeError):
        return []


def attach_walking_locations(meetings, locations):
    """Attach known building coordinates to their matching section meetings."""
    for meeting in meetings:
        meeting_start = hhmm_to_minutes(meeting["start"])
        for location in locations or []:
            try:
                if int(location["day"]) != meeting["day"]:
                    continue
                if abs(int(location["start"]) - meeting_start) > 5:
                    continue
                meeting["latitude"] = float(location["latitude"])
                meeting["longitude"] = float(location["longitude"])
                break
            except (KeyError, TypeError, ValueError):
                continue
    return meetings


def estimated_walk_minutes(first, second):
    """Estimate campus walking time from straight-line building coordinates."""
    required = ("latitude", "longitude")
    if not all(key in first and key in second for key in required):
        return None
    lat1 = math.radians(first["latitude"])
    lat2 = math.radians(second["latitude"])
    delta_lat = lat2 - lat1
    delta_lon = math.radians(second["longitude"] - first["longitude"])
    haversine = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    distance_meters = 6_371_000 * 2 * math.asin(math.sqrt(haversine))
    if distance_meters < 15:
        return 0
    return max(1, math.ceil((distance_meters * 1.25) / 80))


def is_asynchronous(section):
    """Return whether a section without meeting times is explicitly asynchronous."""
    text = " ".join(
        str(section.get(field, ""))
        for field in ("meets", "inst_mthd", "instructionalMethod", "instructional_method")
    ).lower()
    markers = (
        "asynchronous",
        "does not meet",
        "online",
        "distance",
        "web",
        "dweb",
        "b3web",
    )
    return any(marker in text for marker in markers)


def section_credits(section):
    """Read a section's credit value, using the UI's three-credit fallback."""
    for field in ("hours", "credits", "creditHours", "credit_hours"):
        value = section.get(field)
        if value in (None, ""):
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            # Variable-credit text is commonly formatted as "1 TO 3". Using the
            # largest value ensures the configured maximum is never exceeded.
            values = []
            for part in str(value).replace("-", " ").split():
                try:
                    values.append(float(part))
                except ValueError:
                    continue
            if values:
                return max(values)
    return 3.0


def times_overlap(a_times, b_times):
    """Check if two sets of meeting times conflict."""
    for a in a_times:
        for b in b_times:
            if a["day"] == b["day"]:
                if a["start"] < b["end"] and b["start"] < a["end"]:
                    return True
    return False


def blocked_conflict(section_times, blocked):
    """Check if section times conflict with blocked time slots."""
    for st in section_times:
        for bl in blocked:
            if st["day"] == bl["day"]:
                if st["start"] < bl["end"] and bl["start"] < st["end"]:
                    return True
    return False


def is_consistent(section, assignment, blocked_times):
    """Check hard constraints for adding a section to current assignment."""
    s_times = section["_parsed_times"]
    if blocked_conflict(s_times, blocked_times):
        return False
    for assigned in assignment.values():
        if times_overlap(s_times, assigned["_parsed_times"]):
            return False
    return True


def required_preferences_satisfied(assignment, prefs):
    """Return whether a complete schedule satisfies enabled hard preferences."""
    meetings = [meeting for section in assignment.values() for meeting in section["_parsed_times"]]

    if prefs.get("time_preferences_required"):
        required_start = hhmm_to_minutes(prefs.get("preferred_start", 800))
        required_end = hhmm_to_minutes(prefs.get("preferred_end", 2100))
        if any(
            hhmm_to_minutes(meeting["start"]) < required_start
            or hhmm_to_minutes(meeting["end"]) > required_end
            for meeting in meetings
        ):
            return False
        if blocked_conflict(meetings, prefs.get("avoided_time_blocks", [])):
            return False

    if prefs.get("avoided_days_required"):
        avoided_days = set()
        for day in prefs.get("avoided_days", []):
            try:
                avoided_days.add(int(day))
            except (TypeError, ValueError):
                continue
        if any(meeting["day"] in avoided_days for meeting in meetings):
            return False

    if prefs.get("walking_buffer_required"):
        try:
            required_buffer = max(1, int(prefs.get("minimum_walking_buffer_minutes", 1)))
        except (TypeError, ValueError):
            required_buffer = 1
        day_meetings = {}
        for meeting in meetings:
            day_meetings.setdefault(meeting["day"], []).append(meeting)
        for day_schedule in day_meetings.values():
            ordered = sorted(day_schedule, key=lambda meeting: meeting["start"])
            for first, second in zip(ordered, ordered[1:]):
                gap = hhmm_to_minutes(second["start"]) - hhmm_to_minutes(first["end"])
                walk = estimated_walk_minutes(first, second) or 0
                if gap - walk < required_buffer:
                    return False

    return True


def score_schedule(assignment, prefs):
    """Score a feasible schedule based on soft constraints."""
    score = 0.0
    all_meetings = []

    for section in assignment.values():
        # Instructor preference
        instr = section.get("instr", "")
        if instr in prefs.get("preferred_instructors", {}):
            score += prefs["preferred_instructors"][instr] * 10
        if instr in prefs.get("avoided_instructors", {}):
            score -= prefs["avoided_instructors"][instr] * 10

        for mt in section["_parsed_times"]:
            all_meetings.append(mt)

    if not all_meetings:
        return score

    pref_start = hhmm_to_minutes(prefs.get("preferred_start", 800))
    pref_end = hhmm_to_minutes(prefs.get("preferred_end", 2100))

    for m in all_meetings:
        start = hhmm_to_minutes(m["start"])
        end = hhmm_to_minutes(m["end"])
        if start < pref_start:
            score -= 5 * (pref_start - start) / 60
        if end > pref_end:
            score -= 5 * (end - pref_end) / 60

        for block in prefs.get("avoided_time_blocks", []):
            try:
                if int(block.get("day")) != int(m["day"]):
                    continue
                block_start = hhmm_to_minutes(int(block.get("start")))
                block_end = hhmm_to_minutes(int(block.get("end")))
            except (TypeError, ValueError):
                continue
            overlap = max(0, min(end, block_end) - max(start, block_start))
            score -= 8 * overlap / 30

    gap_weight = prefs.get("gap_penalty_weight", 2.0)
    compact_weight = prefs.get("day_compactness_weight", 3.0)
    consec_weight = prefs.get("consecutive_penalty_weight", 2.0)
    try:
        preferred_remaining_time = max(1, int(prefs.get("minimum_walking_buffer_minutes", 1)))
    except (TypeError, ValueError):
        preferred_remaining_time = 1

    active_days = set()
    day_meetings = {}
    route_transitions = []
    for m in all_meetings:
        active_days.add(m["day"])
        day_meetings.setdefault(m["day"], []).append(m)

    score -= compact_weight * len(active_days)
    avoided_days = set()
    for day in prefs.get("avoided_days", []):
        try:
            avoided_days.add(int(day))
        except (TypeError, ValueError):
            continue
    score -= 12 * len(active_days & avoided_days)

    for day, meetings in day_meetings.items():
        sorted_m = sorted(meetings, key=lambda x: x["start"])
        for i in range(1, len(sorted_m)):
            gap = hhmm_to_minutes(sorted_m[i]["start"]) - hhmm_to_minutes(sorted_m[i - 1]["end"])
            walk = estimated_walk_minutes(sorted_m[i - 1], sorted_m[i])
            if walk is not None:
                route_transitions.append({"travel": walk, "remaining": gap - walk})
            if gap > 30:
                score -= gap_weight * (gap / 60)
            elif gap < 15 and gap >= 0:
                score -= consec_weight

    if route_transitions:
        longest_route = max(transition["travel"] for transition in route_transitions)
        smallest_buffer = min(transition["remaining"] for transition in route_transitions)
        score -= longest_route * 0.5
        if smallest_buffer <= preferred_remaining_time:
            score -= 30 + 5 * (preferred_remaining_time - smallest_buffer)

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
            avoided_days: [int],
            avoided_time_blocks: [{day, start, end}],
            minimum_walking_buffer_minutes: int,
            time_preferences_required: bool,
            walking_buffer_required: bool,
            avoided_days_required: bool,
            max_credits: int,
            gap_penalty_weight: float,
            day_compactness_weight: float,
            consecutive_penalty_weight: float,
        },
        max_results: int (default 10),
    }
    """
    courses = params.get("courses", [])
    prefs = params.get("preferences", {})
    max_k = params.get("max_results", 10)
    blocked = prefs.get("blocked_times", [])
    max_credits = prefs.get("max_credits")
    try:
        max_credits = float(max_credits) if max_credits is not None else None
    except (TypeError, ValueError):
        max_credits = None

    # Pre-parse meeting times for all sections
    for course in courses:
        for sec in course.get("sections", []):
            sec["_parsed_times"] = attach_walking_locations(
                parse_meeting_times(sec.get("meetingTimes", "")),
                sec.get("_walking_locations", []),
            )
            sec["_is_async"] = not sec["_parsed_times"] and is_asynchronous(sec)
            sec["_credits"] = section_credits(sec)

    # Sort courses by domain size (MCV heuristic)
    courses_sorted = sorted(courses, key=lambda c: len(c.get("sections", [])))

    solutions = []
    target = max_k * 3
    deadline = time.time() + 5.0  # 5-second timeout

    def backtrack(idx, assignment, assigned_credits):
        if time.time() > deadline:
            return True
        if idx == len(courses_sorted):
            if required_preferences_satisfied(assignment, prefs):
                solutions.append(copy.deepcopy(assignment))
            return len(solutions) >= target

        course = courses_sorted[idx]
        code = course["code"]

        for section in course.get("sections", []):
            if not section.get("_parsed_times") and not section.get("_is_async"):
                continue
            next_credits = assigned_credits + section["_credits"]
            if max_credits is not None and next_credits > max_credits:
                continue
            if is_consistent(section, assignment, blocked):
                assignment[code] = section
                if backtrack(idx + 1, assignment, next_credits):
                    return True
                del assignment[code]

        return False

    backtrack(0, {}, 0.0)

    # Score and rank
    scored = []
    for sol in solutions:
        s = score_schedule(sol, prefs)
        # Clean up internal fields for response
        clean = {}
        for code, sec in sol.items():
            clean_sec = {k: v for k, v in sec.items() if not k.startswith("_")}
            clean[code] = clean_sec
        scored.append({"sections": clean, "score": round(s, 2)})

    scored.sort(key=lambda x: x["score"], reverse=True)

    return {
        "total_found": len(solutions),
        "returned": min(max_k, len(scored)),
        "schedules": scored[:max_k],
    }

"""Offering frequency analysis and prediction.

Analyzes historical offering data to detect patterns (Fall only, every semester,
every N semesters, etc.) and predict when a course will next be available.
"""

from datetime import date


def term_to_parts(term_code):
    """Parse a term code like '202608' into (year, semester_type).

    Semester types: '01' = Spring, '05' = Summer, '08' = Fall.
    """
    year = int(term_code[:4])
    sem = term_code[4:]
    return year, sem


def semester_type_label(sem_code):
    """Convert semester code to label."""
    return {"01": "Spring", "05": "Summer", "08": "Fall"}.get(sem_code, "Unknown")


def term_label(term_code):
    """Convert term code to human-readable label like 'Fall 2026'."""
    year, sem = term_to_parts(term_code)
    return f"{semester_type_label(sem)} {year}"


def term_sort_key(term_code):
    """Sort key for chronological ordering of term codes."""
    year, sem = term_to_parts(term_code)
    sem_order = {"01": 0, "05": 1, "08": 2}
    return (year, sem_order.get(sem, 0))


def next_term(term_code, include_summer=False):
    """Get the next term code chronologically.

    If include_summer is False, skips Summer terms.
    """
    year, sem = term_to_parts(term_code)

    if sem == "01":  # Spring
        if include_summer:
            return f"{year}05"
        else:
            return f"{year}08"
    elif sem == "05":  # Summer
        return f"{year}08"
    elif sem == "08":  # Fall
        return f"{year + 1}01"

    return f"{year + 1}01"


def terms_between(start_term, end_term, include_summer=False):
    """Generate all term codes between start and end (inclusive)."""
    terms = []
    current = start_term
    while term_sort_key(current) <= term_sort_key(end_term):
        year, sem = term_to_parts(current)
        if include_summer or sem != "05":
            terms.append(current)
        current = next_term(current, include_summer=True)
        # Safety limit
        if len(terms) > 50:
            break
    return terms


def current_academic_term(today=None):
    """Return the active academic term used as a history cutoff."""
    today = today or date.today()
    if today.month <= 5:
        semester = "01"
    elif today.month <= 7:
        semester = "05"
    else:
        semester = "08"
    return f"{today.year}{semester}"


def _eligible_history_terms(terms, as_of_term=None):
    """Return completed, readable terms that precede ``as_of_term``.

    Failed lookups are not evidence that a course was unavailable, so they are
    excluded from frequency denominators.  The ``as_of_term`` boundary is
    exclusive because a term being planned is not yet historical evidence.
    """
    eligible = []
    for term in terms:
        term_code = str(term.get("term", ""))
        if len(term_code) != 6 or term_code[4:] not in {"01", "05", "08"}:
            continue
        if term.get("error") or term.get("available") is False:
            continue
        if term.get("complete") is False or term.get("future") is True:
            continue
        if as_of_term and term_sort_key(term_code) >= term_sort_key(as_of_term):
            continue
        eligible.append(term)
    return eligible


def _number(value):
    """Coerce a supplied enrollment metric to a number when possible."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _term_metric(term, names):
    for name in names:
        value = _number(term.get(name))
        if value is not None:
            return value
    return None


def summarize_enrollment(terms):
    """Summarize optional term-level enrollment and capacity observations."""
    observations = []
    for term in terms:
        enrollment = _term_metric(term, ("enrollment", "enrolled", "actual_enrollment"))
        capacity = _term_metric(term, ("capacity", "max_enrollment", "maximum_enrollment"))
        if enrollment is None and capacity is None:
            continue
        observations.append(
            {
                "term": term["term"],
                "enrollment": enrollment,
                "capacity": capacity,
            }
        )

    if not observations:
        return None

    enrollments = [o["enrollment"] for o in observations if o["enrollment"] is not None]
    paired = [
        o for o in observations if o["enrollment"] is not None and o["capacity"] not in (None, 0)
    ]
    total_enrollment = sum(o["enrollment"] for o in paired)
    total_capacity = sum(o["capacity"] for o in paired)
    latest = max(observations, key=lambda o: term_sort_key(o["term"]))

    return {
        "terms_with_data": len(observations),
        "average_enrollment": round(sum(enrollments) / len(enrollments), 1)
        if enrollments
        else None,
        "average_fill_rate": round(total_enrollment / total_capacity, 3)
        if total_capacity
        else None,
        "latest_term": latest["term"],
        "latest_enrollment": latest["enrollment"],
        "latest_capacity": latest["capacity"],
    }


def analyze_offering_pattern(history_data, as_of_term=None):
    """Analyze historical offering data to detect a pattern.

    Args:
        history_data: dict with 'terms' list, each having 'term', 'offered' keys.
            Example: {'code': 'CSCE 350', 'terms': [
                {'term': '202308', 'offered': True, ...},
                {'term': '202401', 'offered': True, ...},
                ...
            ]}

    Returns: dict with pattern info:
        {
            'pattern': 'every_semester' | 'fall_only' | 'spring_only' |
                       'fall_and_spring' | 'every_other_fall' | 'every_N_semesters' |
                       'irregular' | 'unknown',
            'label': 'Offered every Fall',
            'semesters_offered': ['Fall', 'Spring'],
            'frequency': 1.0,  # fraction of eligible terms offered
            'avg_gap': 1.5,    # average gap in semesters between offerings
            'confidence': 0.9, # how confident we are in the pattern
            'total_terms_checked': 10,
            'times_offered': 8
        }
    """
    all_terms = history_data.get("terms", [])
    as_of_term = as_of_term or history_data.get("as_of_term") or current_academic_term()
    terms = _eligible_history_terms(all_terms, as_of_term)
    if not terms:
        return {
            "pattern": "unknown",
            "label": "No offering history available",
            "pattern_label": "No offering history available",
            "semesters_offered": [],
            "frequency": 0,
            "avg_gap": None,
            "confidence": 0,
            "total_terms_checked": 0,
            "times_offered": 0,
            "last_offered_term": None,
            "last_offered_label": None,
            "enrollment": None,
        }

    # Count offerings by semester type
    fall_offered = 0
    fall_total = 0
    spring_offered = 0
    spring_total = 0
    summer_offered = 0
    summer_total = 0

    offered_terms = []

    for t in terms:
        term_code = t.get("term", "")
        offered = t.get("offered", False)
        _, sem = term_to_parts(term_code)

        if sem == "08":
            fall_total += 1
            if offered:
                fall_offered += 1
        elif sem == "01":
            spring_total += 1
            if offered:
                spring_offered += 1
        elif sem == "05":
            summer_total += 1
            if offered:
                summer_offered += 1

        if offered:
            offered_terms.append(term_code)

    total_offered = fall_offered + spring_offered + summer_offered
    total_terms = len(terms)

    if total_offered == 0:
        return {
            "pattern": "unknown",
            "label": f"Not offered in {total_terms} recent terms",
            "pattern_label": "Not offered in recent terms",
            "semesters_offered": [],
            "frequency": 0,
            "avg_gap": None,
            "confidence": 0.5,
            "total_terms_checked": total_terms,
            "times_offered": 0,
            "last_offered_term": None,
            "last_offered_label": None,
            "enrollment": summarize_enrollment(terms),
        }

    # Compute average gap between offerings (in semester units)
    avg_gap = None
    if len(offered_terms) > 1:
        sorted_terms = sorted(offered_terms, key=term_sort_key)
        gaps = []
        for i in range(1, len(sorted_terms)):
            all_between = terms_between(sorted_terms[i - 1], sorted_terms[i], include_summer=True)
            gaps.append(len(all_between) - 1)  # -1 because we don't count the start term
        avg_gap = sum(gaps) / len(gaps) if gaps else None

    # Detect pattern
    semesters_offered = []
    fall_rate = fall_offered / fall_total if fall_total > 0 else 0
    spring_rate = spring_offered / spring_total if spring_total > 0 else 0
    summer_rate = summer_offered / summer_total if summer_total > 0 else 0

    if fall_rate > 0.6:
        semesters_offered.append("Fall")
    if spring_rate > 0.6:
        semesters_offered.append("Spring")
    if summer_rate > 0.6:
        semesters_offered.append("Summer")

    # Classify
    pattern = "irregular"
    confidence = 0.5

    if fall_rate >= 0.8 and spring_rate >= 0.8:
        if summer_rate >= 0.8:
            pattern = "every_semester"
            confidence = min(fall_rate, spring_rate, summer_rate)
        else:
            pattern = "fall_and_spring"
            confidence = min(fall_rate, spring_rate)
    elif fall_rate >= 0.8 and spring_rate < 0.3:
        pattern = "fall_only"
        confidence = fall_rate
    elif spring_rate >= 0.8 and fall_rate < 0.3:
        pattern = "spring_only"
        confidence = spring_rate
    elif fall_rate >= 0.4 and fall_rate < 0.8 and spring_rate < 0.3:
        pattern = "every_other_fall"
        confidence = 0.6
    elif spring_rate >= 0.4 and spring_rate < 0.8 and fall_rate < 0.3:
        pattern = "every_other_spring"
        confidence = 0.6
    elif avg_gap and avg_gap > 2:
        gap_rounded = round(avg_gap)
        pattern = f"every_{gap_rounded}_semesters"
        confidence = 0.5

    frequency = total_offered / total_terms if total_terms > 0 else 0
    frequency_percent = round(frequency * 100)
    last_offered_term = max(offered_terms, key=term_sort_key)

    return {
        "pattern": pattern,
        "label": f"Offered in {frequency_percent}% of recent terms",
        "pattern_label": _pattern_label(pattern, semesters_offered, avg_gap),
        "semesters_offered": semesters_offered,
        "frequency": round(frequency, 2),
        "avg_gap": round(avg_gap, 1) if avg_gap else None,
        "confidence": round(confidence, 2),
        "total_terms_checked": total_terms,
        "times_offered": total_offered,
        "last_offered_term": last_offered_term,
        "last_offered_label": term_label(last_offered_term),
        "enrollment": summarize_enrollment(terms),
    }


def _pattern_label(pattern, semesters, avg_gap):
    """Generate a human-readable label for the offering pattern."""
    labels = {
        "every_semester": "Offered every semester (Fall, Spring, and Summer)",
        "fall_and_spring": "Offered every Fall and Spring",
        "fall_only": "Offered Fall only",
        "spring_only": "Offered Spring only",
        "every_other_fall": "Offered approximately every other Fall",
        "every_other_spring": "Offered approximately every other Spring",
        "unknown": "No offering history available",
    }

    if pattern in labels:
        return labels[pattern]

    if pattern.startswith("every_") and pattern.endswith("_semesters"):
        n = pattern.replace("every_", "").replace("_semesters", "")
        return f"Offered approximately every {n} semesters"

    if semesters:
        return f"Offered irregularly, typically in {', '.join(semesters)}"

    return "Offering pattern is irregular"


def predict_next_offering(pattern_data, current_term):
    """Predict the next term a course will be offered.

    Args:
        pattern_data: result from analyze_offering_pattern()
        current_term: current term code (e.g., '202608')

    Returns: term code string or None if unpredictable.
    """
    pattern = pattern_data.get("pattern", "unknown")
    if pattern == "unknown":
        return None

    year, sem = term_to_parts(current_term)
    # For known patterns, find the next matching semester
    if pattern in ("every_semester",):
        return next_term(current_term)

    if pattern == "fall_and_spring":
        return next_term(current_term, include_summer=False)

    if pattern == "fall_only":
        if sem == "08":
            return f"{year + 1}08"
        return f"{year}08" if sem == "01" else f"{year}08"

    if pattern == "spring_only":
        if sem == "01":
            return f"{year + 1}01"
        return f"{year + 1}01"

    if pattern == "every_other_fall":
        # Next Fall or the one after
        next_fall = f"{year}08" if sem != "08" else f"{year + 1}08"
        return next_fall  # Best guess

    if pattern == "every_other_spring":
        next_spring = f"{year + 1}01" if sem != "01" else f"{year + 1}01"
        return next_spring

    # For every_N_semesters, estimate from avg_gap
    avg_gap = pattern_data.get("avg_gap")
    if avg_gap:
        # Rough estimate: advance by avg_gap semesters
        result = current_term
        for _ in range(max(1, round(avg_gap))):
            result = next_term(result, include_summer=False)
        return result

    return None


def get_offering_summary(history_data, current_term):
    """Get a complete offering analysis summary for display.

    Returns a dict combining pattern analysis with next offering prediction.
    """
    analysis = analyze_offering_pattern(history_data, as_of_term=current_term)
    next_offering = predict_next_offering(analysis, current_term)

    summary = {**analysis}
    summary["next_predicted_term"] = next_offering
    summary["next_predicted_label"] = term_label(next_offering) if next_offering else "Unknown"

    return summary

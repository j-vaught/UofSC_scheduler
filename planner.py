"""Multi-semester degree planner.

Uses topological sorting on prerequisite DAGs and constrained bin-packing
to generate optimal semester-by-semester course plans to graduation.
"""

import json
import os
from collections import defaultdict, deque
from offering_analyzer import (
    term_to_parts, semester_type_label, term_label,
    term_sort_key, next_term, terms_between, analyze_offering_pattern,
    predict_next_offering
)

MAPS_DIR = os.path.join(os.path.dirname(__file__), 'data', 'maps')

# Planning mode credit limits
MODE_CREDITS = {
    'full_time': {'min': 14, 'max': 18, 'target': 15},
    'scholarship': {'min': 12, 'max': 18, 'target': 15},
    'part_time': {'min': 3, 'max': 9, 'target': 6},
}

SCHOLARSHIP_ANNUAL_MIN = 30


def load_major_map(map_id):
    """Load a major map JSON file by ID."""
    path = os.path.join(MAPS_DIR, f'{map_id}.json')
    if not os.path.exists(path):
        return None
    with open(path, 'r') as f:
        return json.load(f)


def list_major_maps():
    """List all available major maps."""
    maps = []
    if not os.path.isdir(MAPS_DIR):
        return maps
    for fname in sorted(os.listdir(MAPS_DIR)):
        if fname.endswith('.json'):
            try:
                with open(os.path.join(MAPS_DIR, fname), 'r') as f:
                    data = json.load(f)
                maps.append({
                    'id': data.get('id', fname.replace('.json', '')),
                    'major': data.get('major', ''),
                    'program': data.get('program', ''),
                    'college': data.get('college', ''),
                    'catalog_year': data.get('catalog_year', ''),
                    'total_credits': data.get('total_credits_required', 120)
                })
            except (json.JSONDecodeError, IOError):
                continue
    return maps


def compute_remaining(major_map, completed_codes, concentration='general'):
    """Compute courses remaining for degree completion.

    Args:
        major_map: loaded major map dict
        completed_codes: set of completed course code strings
        concentration: concentration key (e.g., 'general', 'ai', 'cybersecurity')

    Returns: dict with:
        - required_remaining: list of course dicts still needed
        - elective_groups_remaining: list of elective group dicts with slots to fill
        - total_credits_remaining: estimated credits still needed
        - completed_credits: credits already earned
        - categories: dict of category -> {required, completed, remaining}
    """
    completed = set(completed_codes)
    required = major_map.get('required_courses', [])
    elective_groups = major_map.get('elective_groups', [])
    total_required = major_map.get('total_credits_required', 120)

    # Find remaining required courses
    required_remaining = []
    completed_credits = 0
    categories = defaultdict(lambda: {'required': 0, 'completed': 0, 'remaining': 0})

    for course in required:
        code = course['code']
        cat = course.get('category', 'other')
        credits = course.get('credits', 3)
        categories[cat]['required'] += credits

        if code in completed:
            completed_credits += credits
            categories[cat]['completed'] += credits
        else:
            required_remaining.append(course)
            categories[cat]['remaining'] += credits

    # Handle concentration-specific requirements
    conc_data = major_map.get('concentrations', {}).get(concentration, {})
    extra_required = conc_data.get('extra_required', [])
    for code in extra_required:
        if code not in completed and not any(c['code'] == code for c in required_remaining):
            required_remaining.append({
                'code': code,
                'title': f'{code} (Concentration)',
                'credits': 3,
                'typical_year': 3,
                'typical_semester': 'Fall',
                'prerequisites': [],
                'corequisites': [],
                'category': 'major_electives'
            })

    # Compute remaining elective slots
    elective_groups_remaining = []
    for group in elective_groups:
        group_id = group.get('id', '')
        options = group.get('options', [])
        total_pick = group.get('pick', 0)
        pick_credits = group.get('pick_credits', 0)
        credits_each = group.get('credits_each', 3)

        # Count how many options the student has already completed
        completed_in_group = [c for c in options if c in completed]

        if pick_credits > 0:
            # Credit-based group (e.g., free electives)
            earned = len(completed_in_group) * credits_each
            remaining_credits = max(0, pick_credits - earned)
            if remaining_credits > 0:
                elective_groups_remaining.append({
                    **group,
                    'completed_count': len(completed_in_group),
                    'remaining_credits': remaining_credits,
                    'remaining_pick': max(1, remaining_credits // credits_each)
                })
        elif total_pick > 0:
            remaining_pick = max(0, total_pick - len(completed_in_group))
            if remaining_pick > 0:
                remaining_options = [c for c in options if c not in completed]
                elective_groups_remaining.append({
                    **group,
                    'completed_count': len(completed_in_group),
                    'remaining_pick': remaining_pick,
                    'remaining_options': remaining_options,
                    'remaining_credits': remaining_pick * credits_each
                })
                categories[group.get('category', 'electives')]['remaining'] += remaining_pick * credits_each

    # Compute total remaining
    remaining_required_credits = sum(c.get('credits', 3) for c in required_remaining)
    remaining_elective_credits = sum(g.get('remaining_credits', 0) for g in elective_groups_remaining)
    total_remaining = max(
        remaining_required_credits + remaining_elective_credits,
        total_required - completed_credits
    )

    return {
        'required_remaining': required_remaining,
        'elective_groups_remaining': elective_groups_remaining,
        'total_credits_remaining': total_remaining,
        'completed_credits': completed_credits,
        'categories': dict(categories)
    }


def build_prerequisite_dag(courses, major_map):
    """Build a prerequisite DAG from the course list.

    Returns:
        adjacency: dict of course_code -> list of courses that depend on it
        in_degree: dict of course_code -> number of prerequisites
        prereqs: dict of course_code -> set of prerequisite codes
    """
    # Build prereq lookup from major map
    prereq_lookup = {}
    for course in major_map.get('required_courses', []):
        prereq_lookup[course['code']] = set(course.get('prerequisites', []))

    course_codes = {c['code'] for c in courses}
    adjacency = defaultdict(list)
    in_degree = defaultdict(int)
    prereqs = {}

    for course in courses:
        code = course['code']
        course_prereqs = prereq_lookup.get(code, set())
        # Only count prereqs that are in our remaining set
        relevant_prereqs = course_prereqs & course_codes
        prereqs[code] = relevant_prereqs
        in_degree[code] = len(relevant_prereqs)

        for pr in relevant_prereqs:
            adjacency[pr].append(code)

    return adjacency, dict(in_degree), prereqs


def topological_sort(courses, adjacency, in_degree):
    """Topological sort using Kahn's algorithm.

    Returns courses in prerequisite-respecting order.
    """
    course_map = {c['code']: c for c in courses}
    in_deg = dict(in_degree)

    # Initialize with zero in-degree nodes
    queue = deque()
    for course in courses:
        code = course['code']
        if in_deg.get(code, 0) == 0:
            queue.append(code)

    sorted_courses = []
    while queue:
        # Sort the queue to prefer lower typical_year courses first
        items = list(queue)
        items.sort(key=lambda c: (
            course_map.get(c, {}).get('typical_year', 5),
            course_map.get(c, {}).get('credits', 3)
        ))
        queue.clear()

        code = items[0]
        remaining = items[1:]
        queue.extend(remaining)

        sorted_courses.append(course_map[code])

        for dependent in adjacency.get(code, []):
            in_deg[dependent] -= 1
            if in_deg[dependent] == 0:
                queue.append(dependent)

    return sorted_courses


def _semester_type(term_code):
    """Get semester type from term code."""
    _, sem = term_to_parts(term_code)
    return semester_type_label(sem)


def _can_offer_in_term(course, term_code, offering_hints):
    """Check if a course can be offered in a given term based on restrictions."""
    code = course['code']
    restriction = course.get('offering_restriction') or offering_hints.get(code)
    sem_type = _semester_type(term_code).lower()

    if restriction == 'fall_only' and sem_type != 'fall':
        return False
    if restriction == 'spring_only' and sem_type != 'spring':
        return False
    if restriction == 'summer_only' and sem_type != 'summer':
        return False

    return True


def plan_degree(major_map, completed_codes, mode='full_time', pins=None,
                start_term='202608', include_summer=False, custom_credits=None,
                concentration='general', offering_history=None):
    """Generate a multi-semester degree plan.

    Args:
        major_map: loaded major map dict
        completed_codes: list of completed course codes
        mode: 'full_time', 'scholarship', 'part_time', or 'custom'
        pins: dict of course_code -> term_code (user-pinned courses)
        start_term: first term to plan for
        include_summer: whether to plan summer semesters
        custom_credits: dict with 'min', 'max', 'target' if mode is 'custom'
        concentration: concentration key
        offering_history: dict of course_code -> history_data for pattern analysis

    Returns: dict with:
        - semesters: list of {term, label, courses: [{code, title, credits, pinned}], total_credits}
        - warnings: list of warning strings
        - total_credits_remaining: int
        - estimated_graduation: term label string
    """
    completed = set(completed_codes)
    pins = pins or {}
    offering_hints = major_map.get('offering_hints', {})
    offering_history = offering_history or {}

    # Get remaining courses
    remaining = compute_remaining(major_map, completed, concentration)
    remaining_courses = list(remaining['required_remaining'])

    # Build the DAG
    adjacency, in_degree, prereqs = build_prerequisite_dag(remaining_courses, major_map)

    # Get credit limits for the mode
    if mode == 'custom' and custom_credits:
        credit_limits = custom_credits
    else:
        credit_limits = MODE_CREDITS.get(mode, MODE_CREDITS['full_time'])

    # Plan semesters
    semesters = []
    warnings = []
    placed = set()
    current_term = start_term
    max_semesters = 20  # Safety limit

    # Track annual credits for scholarship mode
    annual_credits = defaultdict(int)

    while remaining_courses and len(semesters) < max_semesters:
        year, sem = term_to_parts(current_term)
        sem_type = _semester_type(current_term)

        # Skip summer unless included
        if sem_type.lower() == 'summer' and not include_summer:
            current_term = next_term(current_term, include_summer=False)
            continue

        # Find available courses (prereqs satisfied + offered this term)
        available = []
        for course in remaining_courses:
            code = course['code']
            if code in placed:
                continue

            # Check prereqs are satisfied
            course_prereqs = prereqs.get(code, set())
            if not course_prereqs.issubset(completed | placed):
                continue

            # Check offering restriction
            if not _can_offer_in_term(course, current_term, offering_hints):
                continue

            available.append(course)

        # Handle pinned courses first
        semester_courses = []
        semester_credits = 0

        for code, pin_term in pins.items():
            if pin_term == current_term:
                course = next((c for c in available if c['code'] == code), None)
                if course:
                    semester_courses.append({**course, 'pinned': True})
                    semester_credits += course.get('credits', 3)
                    available = [c for c in available if c['code'] != code]

        # Fill remaining capacity with available courses
        # Sort by: typical_year (earlier first), then prerequisite chain depth
        available.sort(key=lambda c: (
            c.get('typical_year', 5),
            -len(prereqs.get(c['code'], set())),
            -c.get('credits', 3)
        ))

        for course in available:
            credits = course.get('credits', 3)
            if semester_credits + credits <= credit_limits['max']:
                semester_courses.append({**course, 'pinned': False})
                semester_credits += credits

            if semester_credits >= credit_limits['target']:
                break

        # Only create a semester entry if there are courses to take
        if semester_courses:
            placed_codes = {c['code'] for c in semester_courses}
            placed |= placed_codes

            semesters.append({
                'term': current_term,
                'label': term_label(current_term),
                'courses': [{
                    'code': c['code'],
                    'title': c.get('title', ''),
                    'credits': c.get('credits', 3),
                    'category': c.get('category', ''),
                    'pinned': c.get('pinned', False),
                    'offering_restriction': c.get('offering_restriction') or offering_hints.get(c['code'])
                } for c in semester_courses],
                'total_credits': semester_credits
            })

            # Track annual credits
            academic_year = year if sem != '01' else year - 1
            annual_credits[academic_year] += semester_credits

            # Remove placed courses from remaining
            remaining_courses = [c for c in remaining_courses if c['code'] not in placed_codes]

        current_term = next_term(current_term, include_summer=include_summer)

    # Add elective placeholders
    elective_semesters = _distribute_electives(
        remaining['elective_groups_remaining'],
        semesters,
        credit_limits,
        offering_history
    )

    # Merge elective placeholders into semesters
    for sem_idx, electives in elective_semesters.items():
        if sem_idx < len(semesters):
            semesters[sem_idx]['courses'].extend(electives)
            semesters[sem_idx]['total_credits'] += sum(e.get('credits', 3) for e in electives)

    # Generate warnings
    warnings = _generate_warnings(
        semesters, major_map, mode, annual_credits,
        remaining_courses, credit_limits, offering_hints
    )

    # Estimated graduation
    graduation_term = semesters[-1]['label'] if semesters else 'Unknown'

    return {
        'semesters': semesters,
        'warnings': warnings,
        'total_credits_remaining': remaining['total_credits_remaining'],
        'completed_credits': remaining['completed_credits'],
        'estimated_graduation': graduation_term,
        'categories': remaining['categories']
    }


def _distribute_electives(elective_groups, semesters, credit_limits, offering_history):
    """Distribute elective placeholders across existing semesters.

    Returns: dict of semester_index -> list of elective placeholder dicts.
    """
    result = defaultdict(list)

    for group in elective_groups:
        remaining_pick = group.get('remaining_pick', 0)
        credits_each = group.get('credits_each', 3)
        label = group.get('label', 'Elective')
        group_id = group.get('id', '')

        slots_placed = 0
        for i, sem in enumerate(semesters):
            if slots_placed >= remaining_pick:
                break

            current_credits = sem['total_credits'] + sum(
                e.get('credits', 3) for e in result.get(i, [])
            )

            if current_credits + credits_each <= credit_limits['max']:
                result[i].append({
                    'code': f'[{label}]',
                    'title': f'Choose from {group_id}',
                    'credits': credits_each,
                    'category': group.get('category', 'electives'),
                    'is_elective_slot': True,
                    'elective_group_id': group_id,
                    'options': group.get('remaining_options', group.get('options', [])),
                    'pinned': False
                })
                slots_placed += 1

    return result


def _generate_warnings(semesters, major_map, mode, annual_credits,
                       unplaced, credit_limits, offering_hints):
    """Generate warning messages for the degree plan."""
    warnings = []

    # Check for unplaced courses
    if unplaced:
        codes = [c['code'] for c in unplaced]
        warnings.append({
            'type': 'error',
            'message': f'Could not place {len(unplaced)} course(s): {", ".join(codes)}. '
                       'Check prerequisites and offering restrictions.'
        })

    # Check for overloaded semesters
    for sem in semesters:
        if sem['total_credits'] > credit_limits['max']:
            warnings.append({
                'type': 'warning',
                'message': f'{sem["label"]}: {sem["total_credits"]} credits exceeds '
                           f'the {credit_limits["max"]} credit maximum.'
            })

    # Check for light semesters
    for sem in semesters:
        if sem['total_credits'] < credit_limits['min']:
            warnings.append({
                'type': 'info',
                'message': f'{sem["label"]}: Only {sem["total_credits"]} credits planned. '
                           f'Consider adding electives to reach {credit_limits["min"]} credits.'
            })

    # Scholarship mode: check 30 credits per year
    if mode == 'scholarship':
        for year, credits in annual_credits.items():
            if credits < SCHOLARSHIP_ANNUAL_MIN:
                deficit = SCHOLARSHIP_ANNUAL_MIN - credits
                warnings.append({
                    'type': 'warning',
                    'message': f'Academic year {year}-{year + 1}: Only {credits} credits planned. '
                               f'Need {SCHOLARSHIP_ANNUAL_MIN} credits/year for most scholarships. '
                               f'Consider adding {deficit} summer credits.'
                })

    # Check for Fall-only / Spring-only mismatches
    for sem in semesters:
        term = sem['term']
        sem_type = _semester_type(term).lower()
        for course in sem['courses']:
            restriction = course.get('offering_restriction')
            if restriction == 'fall_only' and sem_type != 'fall':
                warnings.append({
                    'type': 'error',
                    'message': f'{course["code"]} is Fall only but planned for {sem["label"]}.'
                })
            elif restriction == 'spring_only' and sem_type != 'spring':
                warnings.append({
                    'type': 'error',
                    'message': f'{course["code"]} is Spring only but planned for {sem["label"]}.'
                })

    return warnings

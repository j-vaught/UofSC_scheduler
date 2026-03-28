"""Transcript parsing and course code normalization.

Handles flexible input formats: comma/semicolon/period/newline separated,
case-insensitive, with or without space between subject letters and number.
Also parses CSV files with auto-detected column mapping.
"""

import re
import csv
import io

# Matches 3-4 uppercase/lowercase letters followed by optional space then 3 digits + optional letter
COURSE_CODE_RE = re.compile(r'([A-Za-z]{3,4})\s*(\d{3}[A-Za-z]?)')

# Valid grade values (anything that counts as having taken the course)
PASSING_GRADES = {'A', 'A+', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'S', 'P', 'T'}
ALL_GRADES = PASSING_GRADES | {'F', 'W', 'WF', 'I', 'NR', 'U', 'NC'}


def normalize_code(raw):
    """Normalize a course code to canonical 'SUBJ NNN' format.

    Accepts: 'csce145', 'CSCE 145', 'Csce145', 'CSCE  145', 'math141', etc.
    Returns: 'CSCE 145', 'MATH 141', etc. or None if no match.
    """
    raw = raw.strip()
    m = COURSE_CODE_RE.search(raw)
    if not m:
        return None
    subject = m.group(1).upper()
    number = m.group(2).upper()
    return f'{subject} {number}'


def parse_text(raw_text):
    """Parse free-form text input into a list of normalized course codes.

    Accepts courses separated by comma, semicolon, period, or newline.
    Case-insensitive, space between letters and digits is optional.

    Returns: list of unique normalized course code strings.
    """
    # Split on common delimiters
    tokens = re.split(r'[,;\.\n]+', raw_text)

    codes = []
    seen = set()
    for token in tokens:
        token = token.strip()
        if not token:
            continue
        code = normalize_code(token)
        if code and code not in seen:
            codes.append(code)
            seen.add(code)

    return codes


def parse_csv(csv_text):
    """Parse CSV text into a list of course records.

    Auto-detects column mapping by looking for headers containing:
    course/subject/code, number, grade, credits, semester/term.

    Also handles a simple two-column format (Course, Grade) or
    single-column format (just course codes).

    Returns: list of dicts with keys: code, grade, credits, semester.
    """
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)

    if not rows:
        return []

    # Try to detect header row
    header = [h.strip().lower() for h in rows[0]]

    # Map column indices
    col_map = _detect_columns(header)

    if col_map is None:
        # No recognizable header — treat every row as course codes
        results = []
        seen = set()
        for row in rows:
            for cell in row:
                code = normalize_code(cell.strip())
                if code and code not in seen:
                    results.append({'code': code, 'grade': None, 'credits': None, 'semester': None})
                    seen.add(code)
        return results

    # Parse data rows using detected columns
    data_rows = rows[1:]
    results = []
    seen = set()

    for row in data_rows:
        if not row or all(c.strip() == '' for c in row):
            continue

        record = _parse_row(row, col_map)
        if record and record['code'] not in seen:
            results.append(record)
            seen.add(record['code'])

    return results


def _detect_columns(header):
    """Detect which columns contain course, grade, credits, semester data."""
    col_map = {}

    for i, h in enumerate(header):
        if any(k in h for k in ['course', 'code', 'subject', 'class']):
            col_map['course'] = i
        elif h in ['number', 'num', 'no', 'no.']:
            col_map['number'] = i
        elif 'grade' in h or h == 'grd':
            col_map['grade'] = i
        elif 'credit' in h or 'hour' in h or h == 'cr' or h == 'hrs':
            col_map['credits'] = i
        elif any(k in h for k in ['semester', 'term', 'session', 'period']):
            col_map['semester'] = i

    # Must have at least a course column
    if 'course' not in col_map:
        return None

    return col_map


def _parse_row(row, col_map):
    """Parse a single CSV row using the detected column mapping."""
    try:
        # Get course code
        course_idx = col_map['course']
        if course_idx >= len(row):
            return None

        raw_course = row[course_idx].strip()

        # If there's a separate number column, combine them
        if 'number' in col_map and col_map['number'] < len(row):
            raw_number = row[col_map['number']].strip()
            raw_course = f'{raw_course} {raw_number}'

        code = normalize_code(raw_course)
        if not code:
            return None

        # Get optional fields
        grade = None
        if 'grade' in col_map and col_map['grade'] < len(row):
            grade = row[col_map['grade']].strip().upper() or None

        credits = None
        if 'credits' in col_map and col_map['credits'] < len(row):
            try:
                credits = int(float(row[col_map['credits']].strip()))
            except (ValueError, TypeError):
                credits = None

        semester = None
        if 'semester' in col_map and col_map['semester'] < len(row):
            semester = row[col_map['semester']].strip() or None

        return {
            'code': code,
            'grade': grade,
            'credits': credits,
            'semester': semester
        }
    except (IndexError, KeyError):
        return None


def is_passing(grade, min_grade='C'):
    """Check if a grade meets the minimum requirement.

    Default minimum is C (required for most CS/Math courses).
    """
    if not grade:
        return True  # Assume passing if no grade provided

    grade = grade.upper().strip()

    # Transfer/satisfactory always counts
    if grade in ('T', 'S', 'P'):
        return True

    # Failing grades
    if grade in ('F', 'W', 'WF', 'I', 'NR', 'U', 'NC'):
        return False

    grade_order = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-']

    try:
        grade_idx = grade_order.index(grade)
        min_idx = grade_order.index(min_grade)
        return grade_idx <= min_idx
    except ValueError:
        return True  # Unknown grade format, assume passing

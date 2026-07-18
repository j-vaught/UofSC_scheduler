(function initTranscriptParserRuntime(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.TranscriptParserRuntime = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    const COURSE_CODE_RE = /([A-Za-z]{2,5})\s*(\d{3}[A-Za-z]?)/;
    const PASSING_GRADES = new Set([
        'A', 'A+', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-',
        'D+', 'D', 'D-', 'S', 'P', 'T', 'TR',
    ]);
    const FAILING_GRADES = new Set(['F', 'FN', 'WF', 'U', 'NC']);
    const WITHDRAWN_GRADES = new Set(['W', 'WP']);
    const INCOMPLETE_GRADES = new Set(['I', 'NR']);
    const IN_PROGRESS_GRADES = new Set(['IP']);
    const ALL_GRADES = new Set([
        ...PASSING_GRADES,
        ...FAILING_GRADES,
        ...WITHDRAWN_GRADES,
        ...INCOMPLETE_GRADES,
        ...IN_PROGRESS_GRADES,
    ]);
    const LEVEL_LABELS = Object.freeze({
        UG: 'Undergraduate',
        GR: 'Graduate',
        LW: 'Law',
        MD: 'Medicine',
        PH: 'Pharmacy',
    });
    const TERM_RE = /\bTerm\s*:\s*(Spring|Summer|Fall|Winter)\s+(\d{4})\b/i;
    const COURSE_ROW_RE = /^([A-Z]{2,5})\s+(\d{3}[A-Z]?)\s+([A-Z]{2,4})\s+(.+)$/;
    const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

    class TranscriptFormatError extends Error {
        constructor(message, code = 'UNRECOGNIZED_TRANSCRIPT') {
            super(message);
            this.name = 'TranscriptFormatError';
            this.code = code;
        }
    }

    function normalizeWhitespace(value) {
        return String(value ?? '')
            .replace(/[\u00a0\u2007\u202f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeCode(raw) {
        const match = normalizeWhitespace(raw).match(COURSE_CODE_RE);
        if (!match) return null;
        return `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
    }

    function parseText(rawText) {
        const codes = [];
        const seen = new Set();
        for (const token of String(rawText ?? '').split(/[,;.\n]+/)) {
            if (!token.trim()) continue;
            const code = normalizeCode(token);
            if (code && !seen.has(code)) {
                codes.push(code);
                seen.add(code);
            }
        }
        return codes;
    }

    function parseCsvRows(csvText) {
        const rows = [];
        let row = [];
        let cell = '';
        let quoted = false;
        const source = String(csvText ?? '');

        for (let index = 0; index < source.length; index += 1) {
            const character = source[index];
            if (quoted) {
                if (character === '"' && source[index + 1] === '"') {
                    cell += '"';
                    index += 1;
                } else if (character === '"') {
                    quoted = false;
                } else {
                    cell += character;
                }
                continue;
            }
            if (character === '"') {
                quoted = true;
            } else if (character === ',') {
                row.push(cell);
                cell = '';
            } else if (character === '\n' || character === '\r') {
                if (character === '\r' && source[index + 1] === '\n') index += 1;
                row.push(cell);
                rows.push(row);
                row = [];
                cell = '';
            } else {
                cell += character;
            }
        }
        if (cell.length || row.length || source.endsWith(',')) {
            row.push(cell);
            rows.push(row);
        }
        return rows;
    }

    function detectColumns(header) {
        const columns = {};
        header.forEach((rawHeader, index) => {
            const value = normalizeWhitespace(rawHeader).toLowerCase();
            if (['course', 'code', 'subject', 'class'].some(key => value.includes(key))) {
                columns.course = index;
            } else if (['number', 'num', 'no', 'no.'].includes(value)) {
                columns.number = index;
            } else if (value.includes('grade') || value === 'grd') {
                columns.grade = index;
            } else if (
                value.includes('credit')
                || value.includes('hour')
                || value === 'cr'
                || value === 'hrs'
            ) {
                columns.credits = index;
            } else if (['semester', 'term', 'session', 'period'].some(key => value.includes(key))) {
                columns.semester = index;
            }
        });
        return Object.hasOwn(columns, 'course') ? columns : null;
    }

    function parseRow(row, columns) {
        try {
            if (columns.course >= row.length) return null;
            let rawCourse = normalizeWhitespace(row[columns.course]);
            if (Object.hasOwn(columns, 'number') && columns.number < row.length) {
                rawCourse = `${rawCourse} ${normalizeWhitespace(row[columns.number])}`;
            }
            const code = normalizeCode(rawCourse);
            if (!code) return null;

            let grade = null;
            if (Object.hasOwn(columns, 'grade') && columns.grade < row.length) {
                grade = normalizeWhitespace(row[columns.grade]).toUpperCase() || null;
            }

            let credits = null;
            if (Object.hasOwn(columns, 'credits') && columns.credits < row.length) {
                const rawCredits = normalizeWhitespace(row[columns.credits]);
                const parsedCredits = Number(rawCredits);
                credits = rawCredits && Number.isFinite(parsedCredits) ? parsedCredits : null;
            }

            let semester = null;
            if (Object.hasOwn(columns, 'semester') && columns.semester < row.length) {
                semester = normalizeWhitespace(row[columns.semester]) || null;
            }
            return { code, grade, credits, semester };
        } catch (error) {
            return null;
        }
    }

    function parseCsv(csvText) {
        const rows = parseCsvRows(csvText);
        if (!rows.length) return [];
        const header = rows[0].map(value => normalizeWhitespace(value).toLowerCase());
        const columns = detectColumns(header);

        if (!columns) {
            const results = [];
            const seen = new Set();
            for (const row of rows) {
                for (const cell of row) {
                    const code = normalizeCode(normalizeWhitespace(cell));
                    if (code && !seen.has(code)) {
                        results.push({ code, grade: null, credits: null, semester: null });
                        seen.add(code);
                    }
                }
            }
            return results;
        }

        const results = [];
        const seen = new Set();
        for (const row of rows.slice(1)) {
            if (!row.length || row.every(cell => !normalizeWhitespace(cell))) continue;
            const record = parseRow(row, columns);
            if (record && !seen.has(record.code)) {
                results.push(record);
                seen.add(record.code);
            }
        }
        return results;
    }

    function isPassing(grade, minimumGrade = 'C') {
        if (!grade) return false;
        const normalized = normalizeGrade(grade);
        if (!normalized) return false;
        if (['T', 'TR', 'S', 'P'].includes(normalized)) return true;
        if (
            FAILING_GRADES.has(normalized)
            || WITHDRAWN_GRADES.has(normalized)
            || INCOMPLETE_GRADES.has(normalized)
            || IN_PROGRESS_GRADES.has(normalized)
        ) return false;

        const order = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-'];
        const gradeIndex = order.indexOf(normalized);
        const minimumIndex = order.indexOf(String(minimumGrade ?? '').toUpperCase().trim());
        if (gradeIndex < 0 || minimumIndex < 0) return false;
        return gradeIndex <= minimumIndex;
    }

    function normalizeGrade(rawGrade) {
        const raw = normalizeWhitespace(rawGrade).toUpperCase();
        if (!raw) return null;
        if (raw.endsWith('_TR')) return raw.slice(0, -3) || 'TR';
        if (raw.startsWith('TR-')) return raw.slice(3) || 'TR';
        return raw;
    }

    function classifyGrade(rawGrade, creditHours = null) {
        const grade = normalizeGrade(rawGrade);
        if (!grade) {
            return {
                status: 'in_progress',
                counts_as_completed: false,
                normalized_grade: null,
                known: true,
            };
        }
        if (PASSING_GRADES.has(grade)) {
            return {
                status: 'completed',
                counts_as_completed: true,
                normalized_grade: grade,
                known: true,
            };
        }
        if (FAILING_GRADES.has(grade)) {
            return {
                status: 'failed',
                counts_as_completed: false,
                normalized_grade: grade,
                known: true,
            };
        }
        if (WITHDRAWN_GRADES.has(grade)) {
            return {
                status: 'withdrawn',
                counts_as_completed: false,
                normalized_grade: grade,
                known: true,
            };
        }
        if (INCOMPLETE_GRADES.has(grade)) {
            return {
                status: 'incomplete',
                counts_as_completed: false,
                normalized_grade: grade,
                known: true,
            };
        }
        if (IN_PROGRESS_GRADES.has(grade)) {
            return {
                status: 'in_progress',
                counts_as_completed: false,
                normalized_grade: grade,
                known: true,
            };
        }
        return {
            status: 'unknown',
            counts_as_completed: null,
            normalized_grade: grade,
            known: false,
            credit_hours: creditHours,
        };
    }

    function numericOrNull(value) {
        const normalized = normalizeWhitespace(value).replace(/,/g, '');
        if (!NUMBER_RE.test(normalized)) return null;
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function normalizeTextItem(rawItem, pageNumber = 1) {
        const text = normalizeWhitespace(rawItem?.str ?? rawItem?.text);
        if (!text) return null;
        const transform = Array.isArray(rawItem?.transform) ? rawItem.transform : [];
        const x = Number(rawItem?.x ?? transform[4] ?? 0);
        const y = Number(rawItem?.y ?? transform[5] ?? 0);
        const width = Number(rawItem?.width ?? 0);
        const height = Math.abs(Number(rawItem?.height ?? transform[3] ?? 10)) || 10;
        return {
            text,
            x: Number.isFinite(x) ? x : 0,
            y: Number.isFinite(y) ? y : 0,
            width: Number.isFinite(width) ? width : 0,
            height: Number.isFinite(height) ? height : 10,
            page: Number(rawItem?.page ?? pageNumber) || pageNumber,
        };
    }

    function reconstructLines(pages) {
        const sourcePages = Array.isArray(pages) ? pages : [];
        const lines = [];
        sourcePages.forEach((rawPage, pageIndex) => {
            const pageNumber = Number(rawPage?.page ?? rawPage?.pageNumber ?? pageIndex + 1);
            const rawItems = Array.isArray(rawPage) ? rawPage : rawPage?.items || [];
            const items = rawItems
                .map(item => normalizeTextItem(item, pageNumber))
                .filter(Boolean)
                .sort((left, right) => right.y - left.y || left.x - right.x);
            const pageLines = [];
            for (const item of items) {
                const tolerance = Math.max(1.5, Math.min(4, item.height * 0.35));
                let line = pageLines.find(candidate => Math.abs(candidate.y - item.y) <= tolerance);
                if (!line) {
                    line = { page: pageNumber, y: item.y, items: [] };
                    pageLines.push(line);
                }
                line.items.push(item);
                line.y = line.items.reduce((sum, entry) => sum + entry.y, 0) / line.items.length;
            }
            pageLines.sort((left, right) => right.y - left.y);
            for (const line of pageLines) {
                line.items.sort((left, right) => left.x - right.x);
                line.text = normalizeWhitespace(line.items.map(item => item.text).join(' '));
                line.x = line.items[0]?.x ?? 0;
                lines.push(line);
            }
        });
        return lines;
    }

    function looksLikeTranscript(lines) {
        const text = lines.map(line => line.text.toLowerCase()).join('\n');
        const markers = [
            /academic transcript/,
            /institution credit|transfer credit/,
            /subject\s+course\s+level\s+title/,
            /credit hours/,
            /transcript totals|current term|cumulative/,
        ];
        const matched = markers.filter(pattern => pattern.test(text));
        return { valid: matched.length >= 3, score: matched.length / markers.length };
    }

    function detectSource(lineText, currentSource) {
        const normalized = lineText.toUpperCase();
        if (normalized.includes('TRANSFER CREDIT')) return 'transfer';
        if (normalized.includes('TEST CREDIT')) return 'test';
        if (normalized.includes('INSTITUTION CREDIT')) return 'institution';
        if (normalized.includes('COURSES IN PROGRESS')) return 'institution';
        return currentSource;
    }

    function detectTransferInstitution(lineText) {
        const direct = lineText.match(/transfer institution\s*:\s*(.+)$/i);
        if (direct) return normalizeWhitespace(direct[1]);
        const accepted = lineText.match(/transfer credit accepted (?:by|from)\s+(.+)$/i);
        if (accepted && !/institution$/i.test(accepted[1])) return normalizeWhitespace(accepted[1]);
        return null;
    }

    function parseProgramMetadata(lines) {
        const metadata = {
            programs: [],
            levels: [],
        };
        const levelSet = new Set();
        const fields = new Set(['college', 'major', 'minor', 'concentration', 'degree', 'program', 'campus']);
        let currentProgram = null;
        for (let index = 0; index < lines.length; index += 1) {
            const text = lines[index].text;
            for (const [code, label] of Object.entries(LEVEL_LABELS)) {
                if (new RegExp(`\\b${label}\\b`, 'i').test(text)) levelSet.add(code);
            }
            if (/current program/i.test(text)) {
                currentProgram = {};
                metadata.programs.push(currentProgram);
                continue;
            }
            const match = text.match(/^(College|Major|Minor|Concentration|Degree|Program|Campus)\s*:\s*(.*)$/i);
            if (!match) continue;
            const key = match[1].toLowerCase();
            if (!fields.has(key)) continue;
            let value = normalizeWhitespace(match[2]);
            if (!value && lines[index + 1] && !/:/.test(lines[index + 1].text)) {
                value = normalizeWhitespace(lines[index + 1].text);
            }
            if (!value) continue;
            if (!currentProgram) {
                currentProgram = {};
                metadata.programs.push(currentProgram);
            }
            currentProgram[key] = value;
        }
        metadata.levels = [...levelSet];
        return metadata;
    }

    function findColumnPositions(line) {
        const positions = {};
        for (const item of line.items || []) {
            const text = item.text.toLowerCase();
            if (/^subject\b/.test(text)) positions.subject = item.x;
            else if (/^course\b/.test(text)) positions.course = item.x;
            else if (/^level\b/.test(text)) positions.level = item.x;
            else if (/^title\b/.test(text)) positions.title = item.x;
            else if (/^grade\b/.test(text)) positions.grade = item.x;
            else if (/^credit(?:\s+hours?)?\b/.test(text)) positions.credit = item.x;
            else if (/^quality(?:\s+points?)?\b/.test(text)) positions.quality = item.x;
            else if (/^r$|^repeat/.test(text)) positions.repeat = item.x;
        }
        const text = line.text.toLowerCase();
        if (!('subject' in positions) || !('course' in positions)) return null;
        if (!/level/.test(text) || !/title/.test(text)) return null;
        const order = Object.entries(positions).sort((left, right) => left[1] - right[1]);
        return order.length >= 4 ? Object.fromEntries(order) : null;
    }

    function cellsFromColumns(line, columns) {
        const ordered = Object.entries(columns).sort((left, right) => left[1] - right[1]);
        const cells = {};
        for (const item of line.items || []) {
            let selected = ordered[0]?.[0];
            for (let index = 0; index < ordered.length; index += 1) {
                const [name, start] = ordered[index];
                const nextStart = ordered[index + 1]?.[1] ?? Number.POSITIVE_INFINITY;
                const boundary = index === 0 ? Number.NEGATIVE_INFINITY : (ordered[index - 1][1] + start) / 2;
                const nextBoundary = (start + nextStart) / 2;
                if (item.x >= boundary && item.x < nextBoundary) {
                    selected = name;
                    break;
                }
            }
            cells[selected] = normalizeWhitespace(`${cells[selected] || ''} ${item.text}`);
        }
        return cells;
    }

    function stripRepeatMarker(raw) {
        const value = normalizeWhitespace(raw).toUpperCase();
        if (!value) return { indicator: null, repeated: false, excluded: false };
        return {
            indicator: value,
            repeated: ['R', 'I', 'A'].includes(value),
            excluded: ['E', 'X'].includes(value),
        };
    }

    function parseCourseCells(cells) {
        const subject = normalizeWhitespace(cells.subject).toUpperCase();
        const number = normalizeWhitespace(cells.course).toUpperCase();
        if (!/^[A-Z]{2,5}$/.test(subject) || !/^\d{3}[A-Z]?$/.test(number)) return null;
        const rawGrade = normalizeWhitespace(cells.grade).toUpperCase() || null;
        return {
            subject,
            course_number: number,
            code: `${subject} ${number}`,
            level: normalizeWhitespace(cells.level).toUpperCase() || null,
            title: normalizeWhitespace(cells.title) || null,
            raw_grade: rawGrade,
            credit_hours: numericOrNull(cells.credit),
            quality_points: numericOrNull(cells.quality),
            repeat: stripRepeatMarker(cells.repeat),
        };
    }

    function parseCourseText(lineText) {
        const match = normalizeWhitespace(lineText).toUpperCase().match(COURSE_ROW_RE);
        if (!match) return null;
        const [, subject, courseNumber, level, rawRemainder] = match;
        const tokens = rawRemainder.split(/\s+/);
        let repeat = { indicator: null, repeated: false, excluded: false };
        if (/^[A-Z]$/.test(tokens.at(-1) || '') && !ALL_GRADES.has(tokens.at(-1))) {
            repeat = stripRepeatMarker(tokens.pop());
        }
        const numeric = [];
        while (tokens.length && NUMBER_RE.test(tokens.at(-1))) numeric.unshift(Number(tokens.pop()));
        if (!numeric.length) return null;

        let rawGrade = null;
        if (tokens.length) {
            const candidate = tokens.at(-1);
            if (/^[A-Z][A-Z+_-]{0,7}$/.test(candidate)) rawGrade = tokens.pop();
        }
        const title = normalizeWhitespace(tokens.join(' '));
        if (!title) return null;
        return {
            subject,
            course_number: courseNumber,
            code: `${subject} ${courseNumber}`,
            level,
            title,
            raw_grade: rawGrade,
            credit_hours: numeric[0] ?? null,
            quality_points: numeric[1] ?? null,
            repeat,
        };
    }

    function inferEarnedCredits(course, classification) {
        if (course.credit_hours == null) return null;
        if (classification.status === 'completed') return course.credit_hours;
        if (['failed', 'withdrawn'].includes(classification.status)) return 0;
        return null;
    }

    function buildConfidence(course, context) {
        const reasons = [];
        let score = context.usedColumns ? 0.92 : 0.82;
        if (!context.term) {
            score -= 0.15;
            reasons.push('Term was not identified for this course attempt.');
        }
        if (!course.title) {
            score -= 0.1;
            reasons.push('Course title was not identified.');
        }
        if (course.credit_hours == null) {
            score -= 0.12;
            reasons.push('Credit hours were not identified.');
        }
        if (!context.classification.known) {
            score -= 0.25;
            reasons.push(`Grade ${course.raw_grade || '(blank)'} requires review.`);
        }
        if (context.source === 'unknown') {
            score -= 0.1;
            reasons.push('Course source was not identified.');
        }
        return {
            score: Math.max(0, Math.min(1, Math.round(score * 100) / 100)),
            level: score >= 0.85 ? 'high' : score >= 0.65 ? 'medium' : 'low',
            reasons,
        };
    }

    function parseSummaryValues(lineText) {
        const match = lineText.match(/^(Current Term|Cumulative)\s*:\s*(.*)$/i);
        if (!match) return null;
        const values = match[2].match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
        if (values.length < 5) return null;
        return {
            kind: match[1].toLowerCase().startsWith('current') ? 'current' : 'cumulative',
            attempted_credits: values[0] ?? null,
            passed_credits: values[1] ?? null,
            earned_credits: values[2] ?? null,
            gpa_credits: values[3] ?? null,
            quality_points: values[4] ?? null,
            gpa: values[5] ?? null,
        };
    }

    function summarizeAttempts(attempts) {
        const summary = {
            total_attempts: attempts.length,
            completed: 0,
            in_progress: 0,
            transfer: 0,
            needs_review: 0,
        };
        for (const attempt of attempts) {
            if (attempt.status === 'completed') summary.completed += 1;
            if (attempt.status === 'in_progress') summary.in_progress += 1;
            if (attempt.source === 'transfer') summary.transfer += 1;
            if (attempt.needs_review) summary.needs_review += 1;
        }
        return summary;
    }

    function parseAdvisingTranscriptItems(pages, options = {}) {
        const lines = reconstructLines(pages);
        if (!lines.length) {
            throw new TranscriptFormatError(
                'This PDF does not contain readable text. Save the advising transcript as a PDF instead of scanning it.',
                'NO_EXTRACTABLE_TEXT',
            );
        }
        const detection = looksLikeTranscript(lines);
        if (!detection.valid) {
            throw new TranscriptFormatError(
                'This file does not look like a Banner advising transcript.',
            );
        }

        const program = parseProgramMetadata(lines);
        const attempts = [];
        const terms = [];
        const warnings = [];
        const termOccurrences = new Map();
        let currentSource = 'unknown';
        let currentTransferInstitution = null;
        let currentTerm = null;
        let currentColumns = null;
        let currentTermRecord = null;

        for (const line of lines) {
            currentSource = detectSource(line.text, currentSource);
            const transferInstitution = detectTransferInstitution(line.text);
            if (transferInstitution) currentTransferInstitution = transferInstitution;

            const termMatch = /catalog\s+term/i.test(line.text) ? null : line.text.match(TERM_RE);
            if (termMatch) {
                currentTerm = `${termMatch[1][0].toUpperCase()}${termMatch[1].slice(1).toLowerCase()} ${termMatch[2]}`;
                currentTermRecord = {
                    term: currentTerm,
                    source: currentSource,
                    page: line.page,
                    totals: {},
                };
                terms.push(currentTermRecord);
                currentColumns = null;
                continue;
            }

            const columns = findColumnPositions(line);
            if (columns) {
                currentColumns = columns;
                continue;
            }

            const termSummary = parseSummaryValues(line.text);
            if (termSummary && currentTermRecord) {
                currentTermRecord.totals[termSummary.kind] = termSummary;
                continue;
            }

            let course = null;
            let usedColumns = false;
            if (currentColumns) {
                course = parseCourseCells(cellsFromColumns(line, currentColumns));
                usedColumns = Boolean(course);
            }
            if (!course) course = parseCourseText(line.text);
            if (!course) continue;

            const classification = classifyGrade(course.raw_grade, course.credit_hours);
            const source = currentSource;
            const ordinalKey = `${source}|${currentTerm || 'unknown'}|${course.code}`;
            const ordinal = (termOccurrences.get(ordinalKey) || 0) + 1;
            termOccurrences.set(ordinalKey, ordinal);
            const confidence = buildConfidence(course, {
                classification,
                source,
                term: currentTerm,
                usedColumns,
            });
            const record = {
                attempt_id: `${source}:${currentTerm || 'unknown'}:${course.code}:${ordinal}`,
                code: course.code,
                subject: course.subject,
                course_number: course.course_number,
                title: course.title,
                term: currentTerm,
                level: course.level || options.level || program.levels[0] || null,
                raw_grade: course.raw_grade,
                normalized_grade: classification.normalized_grade,
                credit_hours: course.credit_hours,
                attempted_credits: course.credit_hours,
                earned_credits: inferEarnedCredits(course, classification),
                quality_points: course.quality_points,
                source,
                transfer_institution: source === 'transfer' ? currentTransferInstitution : null,
                repeat: course.repeat,
                status: classification.status,
                counts_as_completed: classification.counts_as_completed,
                confidence,
                needs_review: confidence.level !== 'high' || classification.status === 'unknown',
                evidence: {
                    page: line.page,
                    line: line.text,
                    extraction: usedColumns ? 'positioned-columns' : 'line-pattern',
                },
            };
            attempts.push(record);
            if (!classification.known) {
                warnings.push({
                    code: 'UNKNOWN_GRADE',
                    severity: 'warning',
                    page: line.page,
                    attempt_id: record.attempt_id,
                    message: `Review the grade recorded for ${record.code}.`,
                });
            }
        }

        if (!attempts.length) {
            throw new TranscriptFormatError(
                'The transcript was recognized, but no course attempts could be read.',
                'NO_COURSE_ATTEMPTS',
            );
        }

        return {
            schema_version: 1,
            document: {
                kind: 'uofsc-advising-transcript',
                page_count: Number(options.pageCount || pages.length || 0),
                detection_confidence: Math.round(detection.score * 100) / 100,
                levels: program.levels,
                programs: program.programs,
            },
            attempts,
            terms,
            summary: summarizeAttempts(attempts),
            warnings,
            needs_review: attempts.some(attempt => attempt.needs_review),
        };
    }

    return Object.freeze({
        TranscriptFormatError,
        PASSING_GRADES,
        ALL_GRADES,
        normalizeCode,
        normalizeGrade,
        classifyGrade,
        parseText,
        parseCsv,
        isPassing,
        reconstructLines,
        parseAdvisingTranscriptItems,
    });
}));

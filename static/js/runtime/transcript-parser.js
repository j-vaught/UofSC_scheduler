(function initTranscriptParserRuntime(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.TranscriptParserRuntime = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    const COURSE_CODE_RE = /([A-Za-z]{3,4})\s*(\d{3}[A-Za-z]?)/;
    const PASSING_GRADES = new Set([
        'A', 'A+', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-',
        'D+', 'D', 'D-', 'S', 'P', 'T',
    ]);
    const ALL_GRADES = new Set([...PASSING_GRADES, 'F', 'W', 'WF', 'I', 'NR', 'U', 'NC']);

    function normalizeCode(raw) {
        const match = String(raw ?? '').trim().match(COURSE_CODE_RE);
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
            const value = String(rawHeader).trim().toLowerCase();
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
            let rawCourse = String(row[columns.course]).trim();
            if (Object.hasOwn(columns, 'number') && columns.number < row.length) {
                rawCourse = `${rawCourse} ${String(row[columns.number]).trim()}`;
            }
            const code = normalizeCode(rawCourse);
            if (!code) return null;

            let grade = null;
            if (Object.hasOwn(columns, 'grade') && columns.grade < row.length) {
                grade = String(row[columns.grade]).trim().toUpperCase() || null;
            }

            let credits = null;
            if (Object.hasOwn(columns, 'credits') && columns.credits < row.length) {
                const rawCredits = String(row[columns.credits]).trim();
                const parsedCredits = Number(rawCredits);
                credits = rawCredits && Number.isFinite(parsedCredits) ? Math.trunc(parsedCredits) : null;
            }

            let semester = null;
            if (Object.hasOwn(columns, 'semester') && columns.semester < row.length) {
                semester = String(row[columns.semester]).trim() || null;
            }
            return { code, grade, credits, semester };
        } catch (error) {
            return null;
        }
    }

    function parseCsv(csvText) {
        const rows = parseCsvRows(csvText);
        if (!rows.length) return [];
        const header = rows[0].map(value => String(value).trim().toLowerCase());
        const columns = detectColumns(header);

        if (!columns) {
            const results = [];
            const seen = new Set();
            for (const row of rows) {
                for (const cell of row) {
                    const code = normalizeCode(String(cell).trim());
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
            if (!row.length || row.every(cell => !String(cell).trim())) continue;
            const record = parseRow(row, columns);
            if (record && !seen.has(record.code)) {
                results.push(record);
                seen.add(record.code);
            }
        }
        return results;
    }

    function isPassing(grade, minimumGrade = 'C') {
        if (!grade) return true;
        const normalized = String(grade).toUpperCase().trim();
        if (['T', 'S', 'P'].includes(normalized)) return true;
        if (['F', 'W', 'WF', 'I', 'NR', 'U', 'NC'].includes(normalized)) return false;

        const order = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-'];
        const gradeIndex = order.indexOf(normalized);
        const minimumIndex = order.indexOf(minimumGrade);
        if (gradeIndex < 0 || minimumIndex < 0) return true;
        return gradeIndex <= minimumIndex;
    }

    return Object.freeze({
        PASSING_GRADES,
        ALL_GRADES,
        normalizeCode,
        parseText,
        parseCsv,
        isPassing,
    });
}));

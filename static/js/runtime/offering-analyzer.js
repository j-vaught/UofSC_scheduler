(function initOfferingAnalyzerRuntime(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.OfferingAnalyzerRuntime = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    const SEMESTER_LABELS = Object.freeze({
        '01': 'Spring',
        '05': 'Summer',
        '08': 'Fall',
    });
    const SEMESTER_ORDER = Object.freeze({ '01': 0, '05': 1, '08': 2 });

    function termToParts(termCode) {
        const value = String(termCode);
        return [Number.parseInt(value.slice(0, 4), 10), value.slice(4)];
    }

    function semesterTypeLabel(semesterCode) {
        return SEMESTER_LABELS[String(semesterCode)] || 'Unknown';
    }

    function termLabel(termCode) {
        const [year, semester] = termToParts(termCode);
        return `${semesterTypeLabel(semester)} ${year}`;
    }

    function compareTerms(left, right) {
        const [leftYear, leftSemester] = termToParts(left);
        const [rightYear, rightSemester] = termToParts(right);
        if (leftYear !== rightYear) return leftYear - rightYear;
        return (SEMESTER_ORDER[leftSemester] || 0) - (SEMESTER_ORDER[rightSemester] || 0);
    }

    function nextTerm(termCode, includeSummer = false) {
        const [year, semester] = termToParts(termCode);
        if (semester === '01') return includeSummer ? `${year}05` : `${year}08`;
        if (semester === '05') return `${year}08`;
        if (semester === '08') return `${year + 1}01`;
        return `${year + 1}01`;
    }

    function termsBetween(startTerm, endTerm, includeSummer = false) {
        const terms = [];
        let current = String(startTerm);
        while (compareTerms(current, endTerm) <= 0) {
            const [, semester] = termToParts(current);
            if (includeSummer || semester !== '05') terms.push(current);
            current = nextTerm(current, true);
            if (terms.length > 50) break;
        }
        return terms;
    }

    function currentAcademicTerm(today = new Date()) {
        const month = today.getMonth() + 1;
        const semester = month <= 5 ? '01' : month <= 7 ? '05' : '08';
        return `${today.getFullYear()}${semester}`;
    }

    function roundHalfEven(value, digits = 0) {
        if (!Number.isFinite(value)) return value;
        if (!Number.isInteger(digits) || digits < 0) return Number(value.toFixed(digits));
        const absolute = Math.abs(value);
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, absolute, false);
        const bits = view.getBigUint64(0, false);
        const exponentBits = Number((bits >> 52n) & 0x7ffn);
        const fractionBits = bits & ((1n << 52n) - 1n);
        let mantissa;
        let exponent;
        if (exponentBits === 0) {
            mantissa = fractionBits;
            exponent = -1074;
        } else {
            mantissa = (1n << 52n) | fractionBits;
            exponent = exponentBits - 1023 - 52;
        }

        let numerator = mantissa * (5n ** BigInt(digits));
        const binaryExponent = exponent + digits;
        if (binaryExponent >= 0) {
            numerator <<= BigInt(binaryExponent);
        } else {
            const denominator = 1n << BigInt(-binaryExponent);
            let quotient = numerator / denominator;
            const remainder = numerator % denominator;
            const doubled = remainder * 2n;
            if (doubled > denominator || (doubled === denominator && quotient % 2n !== 0n)) {
                quotient += 1n;
            }
            numerator = quotient;
        }
        const rounded = Number(numerator) / (10 ** digits);
        return value < 0 ? -rounded : rounded;
    }

    function eligibleHistoryTerms(terms, asOfTerm = null) {
        return (terms || []).filter(term => {
            const termCode = String(term?.term || '');
            if (termCode.length !== 6 || !Object.hasOwn(SEMESTER_LABELS, termCode.slice(4))) {
                return false;
            }
            if (term.error || term.available === false) return false;
            if (term.complete === false || term.future === true) return false;
            return !asOfTerm || compareTerms(termCode, asOfTerm) < 0;
        });
    }

    function numberOrNull(value) {
        if (typeof value === 'boolean' || value === null || value === undefined) return null;
        const normalized = String(value).replace(/,/g, '').trim();
        if (!normalized) return null;
        const parsed = Number(normalized);
        return Number.isNaN(parsed) ? null : parsed;
    }

    function termMetric(term, names) {
        for (const name of names) {
            const value = numberOrNull(term?.[name]);
            if (value !== null) return value;
        }
        return null;
    }

    function summarizeEnrollment(terms) {
        const observations = [];
        for (const term of terms || []) {
            const enrollment = termMetric(term, ['enrollment', 'enrolled', 'actual_enrollment']);
            const capacity = termMetric(term, ['capacity', 'max_enrollment', 'maximum_enrollment']);
            if (enrollment === null && capacity === null) continue;
            observations.push({ term: term.term, enrollment, capacity });
        }
        if (!observations.length) return null;

        const enrollments = observations
            .filter(observation => observation.enrollment !== null)
            .map(observation => observation.enrollment);
        const paired = observations.filter(observation => (
            observation.enrollment !== null
            && observation.capacity !== null
            && observation.capacity !== 0
        ));
        const totalEnrollment = paired.reduce((sum, item) => sum + item.enrollment, 0);
        const totalCapacity = paired.reduce((sum, item) => sum + item.capacity, 0);
        const latest = [...observations].sort((left, right) => compareTerms(right.term, left.term))[0];

        return {
            terms_with_data: observations.length,
            average_enrollment: enrollments.length
                ? roundHalfEven(enrollments.reduce((sum, value) => sum + value, 0) / enrollments.length, 1)
                : null,
            average_fill_rate: totalCapacity
                ? roundHalfEven(totalEnrollment / totalCapacity, 3)
                : null,
            latest_term: latest.term,
            latest_enrollment: latest.enrollment,
            latest_capacity: latest.capacity,
        };
    }

    function patternLabel(pattern, semesters, averageGap) {
        const labels = {
            every_semester: 'Offered every semester (Fall, Spring, and Summer)',
            fall_and_spring: 'Offered every Fall and Spring',
            fall_only: 'Offered Fall only',
            spring_only: 'Offered Spring only',
            every_other_fall: 'Offered approximately every other Fall',
            every_other_spring: 'Offered approximately every other Spring',
            unknown: 'No offering history available',
        };
        if (labels[pattern]) return labels[pattern];
        if (pattern.startsWith('every_') && pattern.endsWith('_semesters')) {
            const count = pattern.replace('every_', '').replace('_semesters', '');
            return `Offered approximately every ${count} semesters`;
        }
        if (semesters.length) return `Offered irregularly, typically in ${semesters.join(', ')}`;
        return 'Offering pattern is irregular';
    }

    function unknownAnalysis(label = 'No offering history available', totalTerms = 0, enrollment = null) {
        return {
            pattern: 'unknown',
            label,
            pattern_label: totalTerms ? 'Not offered in recent terms' : 'No offering history available',
            semesters_offered: [],
            frequency: 0,
            avg_gap: null,
            confidence: totalTerms ? 0.5 : 0,
            total_terms_checked: totalTerms,
            times_offered: 0,
            last_offered_term: null,
            last_offered_label: null,
            enrollment,
        };
    }

    function analyzeOfferingPattern(historyData, asOfTerm = null) {
        const history = historyData || {};
        const cutoff = asOfTerm || history.as_of_term || currentAcademicTerm();
        const terms = eligibleHistoryTerms(history.terms || [], cutoff);
        if (!terms.length) return unknownAnalysis();

        const totals = { '01': 0, '05': 0, '08': 0 };
        const offered = { '01': 0, '05': 0, '08': 0 };
        const offeredTerms = [];
        for (const term of terms) {
            const termCode = String(term.term || '');
            const semester = termCode.slice(4);
            totals[semester] += 1;
            if (term.offered) offered[semester] += 1;
            if (term.offered) offeredTerms.push(termCode);
        }

        const totalOffered = offered['01'] + offered['05'] + offered['08'];
        if (!totalOffered) {
            return unknownAnalysis(
                `Not offered in ${terms.length} recent terms`,
                terms.length,
                summarizeEnrollment(terms),
            );
        }

        let averageGap = null;
        if (offeredTerms.length > 1) {
            const sorted = [...offeredTerms].sort(compareTerms);
            const gaps = sorted.slice(1).map((term, index) => (
                termsBetween(sorted[index], term, true).length - 1
            ));
            averageGap = gaps.length
                ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length
                : null;
        }

        const fallRate = totals['08'] ? offered['08'] / totals['08'] : 0;
        const springRate = totals['01'] ? offered['01'] / totals['01'] : 0;
        const summerRate = totals['05'] ? offered['05'] / totals['05'] : 0;
        const semesters = [];
        if (fallRate > 0.6) semesters.push('Fall');
        if (springRate > 0.6) semesters.push('Spring');
        if (summerRate > 0.6) semesters.push('Summer');

        let pattern = 'irregular';
        let confidence = 0.5;
        if (fallRate >= 0.8 && springRate >= 0.8) {
            if (summerRate >= 0.8) {
                pattern = 'every_semester';
                confidence = Math.min(fallRate, springRate, summerRate);
            } else {
                pattern = 'fall_and_spring';
                confidence = Math.min(fallRate, springRate);
            }
        } else if (fallRate >= 0.8 && springRate < 0.3) {
            pattern = 'fall_only';
            confidence = fallRate;
        } else if (springRate >= 0.8 && fallRate < 0.3) {
            pattern = 'spring_only';
            confidence = springRate;
        } else if (fallRate >= 0.4 && fallRate < 0.8 && springRate < 0.3) {
            pattern = 'every_other_fall';
            confidence = 0.6;
        } else if (springRate >= 0.4 && springRate < 0.8 && fallRate < 0.3) {
            pattern = 'every_other_spring';
            confidence = 0.6;
        } else if (averageGap && averageGap > 2) {
            pattern = `every_${roundHalfEven(averageGap)}_semesters`;
            confidence = 0.5;
        }

        const frequency = totalOffered / terms.length;
        const lastOfferedTerm = [...offeredTerms].sort(compareTerms).at(-1);
        return {
            pattern,
            label: `Offered in ${roundHalfEven(frequency * 100)}% of recent terms`,
            pattern_label: patternLabel(pattern, semesters, averageGap),
            semesters_offered: semesters,
            frequency: roundHalfEven(frequency, 2),
            avg_gap: averageGap ? roundHalfEven(averageGap, 1) : null,
            confidence: roundHalfEven(confidence, 2),
            total_terms_checked: terms.length,
            times_offered: totalOffered,
            last_offered_term: lastOfferedTerm,
            last_offered_label: termLabel(lastOfferedTerm),
            enrollment: summarizeEnrollment(terms),
        };
    }

    function predictNextOffering(patternData, currentTerm) {
        const pattern = patternData?.pattern || 'unknown';
        if (pattern === 'unknown') return null;
        const [year, semester] = termToParts(currentTerm);
        if (pattern === 'every_semester') return nextTerm(currentTerm);
        if (pattern === 'fall_and_spring') return nextTerm(currentTerm, false);
        if (pattern === 'fall_only') return semester === '08' ? `${year + 1}08` : `${year}08`;
        if (pattern === 'spring_only') return `${year + 1}01`;
        if (pattern === 'every_other_fall') return semester === '08' ? `${year + 1}08` : `${year}08`;
        if (pattern === 'every_other_spring') return `${year + 1}01`;

        const averageGap = patternData?.avg_gap;
        if (averageGap) {
            let result = String(currentTerm);
            for (let index = 0; index < Math.max(1, roundHalfEven(averageGap)); index += 1) {
                result = nextTerm(result, false);
            }
            return result;
        }
        return null;
    }

    function getOfferingSummary(historyData, currentTerm) {
        const analysis = analyzeOfferingPattern(historyData, currentTerm);
        const nextOffering = predictNextOffering(analysis, currentTerm);
        return {
            ...analysis,
            next_predicted_term: nextOffering,
            next_predicted_label: nextOffering ? termLabel(nextOffering) : 'Unknown',
        };
    }

    return Object.freeze({
        termToParts,
        semesterTypeLabel,
        termLabel,
        compareTerms,
        nextTerm,
        termsBetween,
        currentAcademicTerm,
        summarizeEnrollment,
        analyzeOfferingPattern,
        predictNextOffering,
        getOfferingSummary,
    });
}));

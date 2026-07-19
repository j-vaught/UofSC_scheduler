/*
 * Error vocabulary.
 *
 * The problem this exists to stop: a catch block that renders every failure as
 * absence. grades.js turned any thrown error -- a relay 502, a dropped
 * connection, a blocked script, a malformed payload -- into "No Columbia grade
 * history is available for this course." A student reading that concludes their
 * course has no grade data, and stops looking. The application knew the
 * difference and threw it away.
 *
 * One rule governs the whole file: only a code in NOT_FOUND may render as "this
 * does not exist." Everything else has to say that something went wrong, so the
 * student knows to retry rather than to give up.
 */
(function initErrors(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.AppErrors = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    const CODES = Object.freeze({
        // Genuine absence. Safe to tell the student the thing is not there.
        NOT_FOUND: 'NOT_FOUND',
        NO_GRADE_HISTORY: 'NO_GRADE_HISTORY',
        NO_OFFERING_HISTORY: 'NO_OFFERING_HISTORY',
        TERM_NOT_PUBLISHED: 'TERM_NOT_PUBLISHED',

        // Something failed. Never render these as absence.
        NETWORK: 'NETWORK',
        UPSTREAM: 'UPSTREAM',
        TIMEOUT: 'TIMEOUT',
        RATE_LIMITED: 'RATE_LIMITED',
        BLOCKED: 'BLOCKED',
        INTEGRITY: 'INTEGRITY',
        STORAGE: 'STORAGE',
        MALFORMED: 'MALFORMED',
        UNKNOWN: 'UNKNOWN',
    });

    // The only codes permitted to claim absence.
    const NOT_FOUND_CODES = Object.freeze(new Set([
        CODES.NOT_FOUND,
        CODES.NO_GRADE_HISTORY,
        CODES.NO_OFFERING_HISTORY,
        CODES.TERM_NOT_PUBLISHED,
    ]));

    const MESSAGES = Object.freeze({
        [CODES.NOT_FOUND]: 'That is not available.',
        [CODES.NO_GRADE_HISTORY]: 'No Columbia grade history is recorded for this course.',
        [CODES.NO_OFFERING_HISTORY]: 'No offering history is recorded for this course.',
        [CODES.TERM_NOT_PUBLISHED]: 'The university has not published sections for this term yet.',

        [CODES.NETWORK]: 'Could not reach the university. Check your connection and try again.',
        [CODES.UPSTREAM]: 'The university system did not respond correctly. Try again shortly.',
        [CODES.TIMEOUT]: 'The university system took too long to respond. Try again.',
        [CODES.RATE_LIMITED]: 'Too many requests in a row. Wait a moment and try again.',
        [CODES.BLOCKED]: 'The browser blocked part of this page. A reload usually fixes it.',
        [CODES.INTEGRITY]: 'Course data failed its integrity check and was not used. Reload to fetch it again.',
        [CODES.STORAGE]: 'This browser will not let the page save data, so changes will not persist.',
        [CODES.MALFORMED]: 'The response could not be read. Try again shortly.',
        [CODES.UNKNOWN]: 'Something went wrong. Try again.',
    });

    class AppError extends Error {
        constructor(code, options = {}) {
            const known = Object.prototype.hasOwnProperty.call(MESSAGES, code);
            super(options.message || MESSAGES[known ? code : CODES.UNKNOWN]);
            this.name = 'AppError';
            this.code = known ? code : CODES.UNKNOWN;
            this.cause = options.cause;
            this.context = options.context || {};
        }

        get isNotFound() {
            return NOT_FOUND_CODES.has(this.code);
        }
    }

    /*
     * Classify something thrown by fetch, the data store, or a worker. Nothing
     * upstream is guaranteed to be an AppError, so this has to cope with a bare
     * Error, a DOMException, or a rejected value that is not an Error at all.
     */
    function classify(thrown) {
        if (thrown instanceof AppError) return thrown;

        const raw = thrown && typeof thrown === 'object' ? thrown : {};
        const text = String(raw.message || thrown || '');
        const status = Number(raw.status || raw.statusCode || 0);

        if (raw.code && Object.prototype.hasOwnProperty.call(MESSAGES, raw.code)) {
            return new AppError(raw.code, { cause: thrown });
        }
        if (raw.name === 'AbortError' || /timed? ?out/i.test(text)) {
            return new AppError(CODES.TIMEOUT, { cause: thrown });
        }
        if (status === 429) return new AppError(CODES.RATE_LIMITED, { cause: thrown });
        if (status === 404) return new AppError(CODES.NOT_FOUND, { cause: thrown });
        if (status >= 500) return new AppError(CODES.UPSTREAM, { cause: thrown });
        // A CSP block and an offline fetch both surface as a bare TypeError from
        // fetch, so they are reported as network rather than guessed at.
        if (raw instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(text)) {
            return new AppError(CODES.NETWORK, { cause: thrown });
        }
        if (/integrity|sha-?256|digest/i.test(text)) {
            return new AppError(CODES.INTEGRITY, { cause: thrown });
        }
        if (/quota|storage|indexeddb|localstorage/i.test(text)) {
            return new AppError(CODES.STORAGE, { cause: thrown });
        }
        if (/json|unexpected token|parse/i.test(text)) {
            return new AppError(CODES.MALFORMED, { cause: thrown });
        }
        return new AppError(CODES.UNKNOWN, { cause: thrown });
    }

    function toUserMessage(thrown) {
        return classify(thrown).message;
    }

    /*
     * The guard that enforces the rule. A caller that wants to render absence
     * must ask, and gets told no when the failure was not absence.
     */
    function isAbsence(thrown) {
        return classify(thrown).isNotFound;
    }

    return { CODES, NOT_FOUND_CODES, MESSAGES, AppError, classify, toUserMessage, isAbsence };
}));

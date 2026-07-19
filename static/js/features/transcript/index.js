/*
 * Transcript import, fenced.
 *
 * The third feature extracted under phase 7a, and the first whose boundary was
 * already mostly drawn: transcript-pdf.js and transcript-upload-dialog.js reach
 * for nothing but pdfjsLib and their own dialog. All the coupling lived in the
 * 80-line seam file that joined them to the application, which is what moved.
 *
 * Two dependencies are worth naming individually, because they are the ones a
 * future change is most likely to get wrong.
 *
 * persist() is not savePlan(). savePlan() snapshots the whole application over
 * the student's stored plan, so importing a transcript used to destroy the
 * schedule saved under that name. An import only learns coursework, so it only
 * writes coursework. That distinction is a bug fix that predates this fence and
 * is preserved here deliberately rather than rediscovered later.
 *
 * onApplied() replaces a refreshViews() that called into Profile and DegreePlan
 * directly, each behind a typeof guard. Those guards are why this had to become
 * a declared dependency: inside a fenced module both globals are always
 * undefined, so the guards would pass silently and the views would never
 * refresh -- the same failure the map extraction hit. A caller now says what
 * happens after an import, and this module does not know those features exist.
 *
 * The body is the previous implementation apart from those seams. A fence is
 * not a rewrite; mixing the two is how extractions introduce bugs that look
 * like refactors.
 */
(function initTranscriptFeature(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.Features) root.Features = {};
    root.Features.transcript = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createTranscriptFeature(deps) {
        for (const name of ['parsePDF', 'applyAttempts', 'restoreSnapshot', 'persist', 'onApplied']) {
            if (typeof deps?.[name] !== 'function') {
                throw new TypeError(`transcript feature needs a ${name}() dependency`);
            }
        }

        const feature = {
            /*
             * Bind the reusable dialog. Passed in rather than reached for, so a
             * different dialog -- or none, in a CLI -- is a call-site change.
             */
            init(dialog) {
                if (!dialog || typeof dialog.init !== 'function') return false;
                dialog.init({
                    processor: input => this.process(input),
                    applyHandler: detail => this.apply(detail),
                });
                return true;
            },

            /*
             * Extraction reports its own progress from 0 to 100 several times
             * over. This maps each phase onto a slice of one bar, so the
             * student sees a number that only ever goes up.
             */
            progressEvent(onProgress, event = {}) {
                if (typeof onProgress !== 'function') return;
                const phase = String(event.phase || 'extracting');
                const sourcePercent = Math.max(0, Math.min(100, Number(event.percent) || 0));
                const ranges = {
                    opening: [2, 12, 'Opening PDF'],
                    extracting: [12, 92, 'Reading transcript pages'],
                    parsing: [92, 100, 'Organizing coursework'],
                };
                const [start, end, message] = ranges[phase] || ranges.extracting;
                onProgress({
                    percent: Math.round(start + ((end - start) * sourcePercent / 100)),
                    message,
                });
            },

            async process({ file, level, onProgress }) {
                return deps.parsePDF(file, {
                    level,
                    onProgress: event => this.progressEvent(onProgress, event),
                });
            },

            async apply({ result, mode, level }) {
                const attempts = Array.isArray(result?.attempts)
                    ? result.attempts
                    : Array.isArray(result?.records) ? result.records : [];
                if (!attempts.length) throw new Error('No course attempts are available to import.');

                const applied = deps.applyAttempts(attempts, { mode, level });
                deps.persist();
                deps.onApplied();

                return {
                    message: applied.duplicates > 0
                        ? `${applied.added} new attempts added. ${applied.duplicates} duplicates were already in your profile.`
                        : `${applied.added} attempts added. ${applied.completedCourses} completed courses are ready for degree planning.`,
                    /*
                     * Undo runs the same two steps as apply, in the same order.
                     * A transcript import is the largest single change a student
                     * makes to their profile, so it has to be reversible without
                     * a reload.
                     */
                    undo: async () => {
                        deps.restoreSnapshot(applied.snapshot);
                        deps.persist();
                        deps.onApplied();
                    },
                };
            },
        };

        return feature;
    }

    return { createTranscriptFeature };
}));

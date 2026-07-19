/*
 * Composition point for the fenced transcript feature.
 *
 * The logic moved to static/js/features/transcript/index.js. What is left is
 * the wiring: this file is the only place that knows the feature is driven by
 * API, State, Profile and DegreePlan, and it is deliberately the boring half.
 *
 * TranscriptImport is the feature instance rather than a wrapper around it.
 * Wrapping was tried during the history extraction and dropped: a facade that
 * forwards methods drops anything a caller replaces on the object, and the
 * failure is silent because the forwarding still works.
 */
const TranscriptImport = (() => {
    const factory = (typeof Features !== 'undefined' && Features.transcript)
        || (typeof require === 'function' ? require('./features/transcript/index.js') : null);
    if (!factory) throw new Error('transcript feature is not loaded');

    const feature = factory.createTranscriptFeature({
        parsePDF: (file, options) => API.parseTranscriptPDF(file, options),

        applyAttempts: (attempts, options) => State.applyTranscriptAttempts(attempts, options),

        restoreSnapshot: snapshot => State.restoreTranscriptSnapshot(snapshot),

        // Coursework only. savePlan() would write the whole application over
        // the student's stored plan, which is how importing a transcript used
        // to destroy the schedule saved under that name.
        persist: () => State.saveCompletedCoursework(),

        /*
         * Everything that has to repaint after coursework changes. These stay
         * behind typeof guards because this file runs in a browser where load
         * order is a fact of the markup, not a promise -- but the guards belong
         * out here, where a missing global is genuinely possible, rather than
         * inside the feature, where it never is.
         */
        onApplied: () => {
            if (typeof Profile !== 'undefined') {
                Profile.renderCompletedChips();
                Profile.renderCreditSummary();
            }
            if (typeof DegreePlan !== 'undefined') {
                DegreePlan.buildCompletedSemesters();
                DegreePlan.updateSidebar();
                DegreePlan.render();
            }
        },
    });

    /*
     * Supply the dialog here so the feature never reaches for a global, while
     * boot keeps calling init() with no arguments. Defaulting at the seam
     * rather than inside the feature is the whole point: the feature works with
     * any dialog, and this file is the one that knows which one exists.
     */
    const start = feature.init.bind(feature);
    feature.init = dialog => start(
        dialog ?? (typeof TranscriptUploadDialog !== 'undefined' ? TranscriptUploadDialog : null),
    );

    return feature;
})();

if (typeof globalThis !== 'undefined') {
    globalThis.TranscriptImport = TranscriptImport;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = TranscriptImport;
}

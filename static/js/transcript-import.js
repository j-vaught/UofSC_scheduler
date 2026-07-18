/* Connect the reusable transcript dialog to local PDF extraction and profile state. */
const TranscriptImport = {
    init() {
        if (typeof TranscriptUploadDialog === 'undefined') return;
        TranscriptUploadDialog.init({
            processor: input => this.process(input),
            applyHandler: detail => this.apply(detail),
        });
    },

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
        return API.parseTranscriptPDF(file, {
            level,
            onProgress: event => this.progressEvent(onProgress, event),
        });
    },

    refreshViews() {
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

    persist() {
        State.savePlan();
    },

    async apply({ result, mode, level }) {
        const attempts = Array.isArray(result?.attempts)
            ? result.attempts
            : Array.isArray(result?.records) ? result.records : [];
        if (!attempts.length) throw new Error('No course attempts are available to import.');

        const applied = State.applyTranscriptAttempts(attempts, { mode, level });
        this.persist();
        this.refreshViews();

        return {
            message: applied.duplicates > 0
                ? `${applied.added} new attempts added. ${applied.duplicates} duplicates were already in your profile.`
                : `${applied.added} attempts added. ${applied.completedCourses} completed courses are ready for degree planning.`,
            undo: async () => {
                State.restoreTranscriptSnapshot(applied.snapshot);
                this.persist();
                this.refreshViews();
            },
        };
    },
};

if (typeof globalThis !== 'undefined') {
    globalThis.TranscriptImport = TranscriptImport;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = TranscriptImport;
}

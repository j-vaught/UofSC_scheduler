/*
 * Composition point for the fenced calendar export feature.
 *
 * The logic moved to static/js/features/export/index.js. This file knows the
 * exporter reads its schedule from State, and nothing else does.
 *
 * This module used to own the Saved Plans panel as well. That panel is gone,
 * and its removal is why State persists on every change and rehydrates at
 * startup: the manual controls were the only thing that ever called savePlan(),
 * so a student who never found the panel lost their schedule on every refresh.
 */
const Export = (() => {
    const factory = (typeof Features !== 'undefined' && Features.export)
        || (typeof require === 'function' ? require('./features/export/index.js') : null);
    if (!factory) throw new Error('export feature is not loaded');

    return factory.createExportFeature({
        selectedSections: () => State.selectedSections,
        currentTerm: () => State.term,
    });
})();

if (typeof module === 'object' && module.exports) module.exports = Export;
if (typeof globalThis === 'object') globalThis.Export = Export;

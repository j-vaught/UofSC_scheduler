/*
 * History, wired to its fenced implementation.
 *
 * The logic lives in features/history/index.js, which names its dependencies
 * instead of reaching for globals. This file is the composition point: it
 * supplies the three real dependencies and exposes the resulting instance under
 * the name existing callers already use.
 *
 * It exposes the instance itself rather than wrapping it, because the suites
 * override internals (`history._activeTerm = ...`) to control time. A
 * delegating wrapper would silently drop those overrides, which is a worse
 * failure than the coupling it would be hiding.
 *
 * Dependencies resolve lazily, so a test that injects API or State through a
 * sandbox still works.
 */
const History = (() => {
    'use strict';

    const factory = (typeof globalThis !== 'undefined' && (globalThis.Features || {}).history)
        || (typeof require === 'function' ? require('./features/history/index.js') : null);
    if (!factory) throw new Error('History feature is not loaded');

    return factory.createHistoryFeature({
        getHistory: (code, onProgress) => API.getHistory(code, onProgress),
        currentTerm: () => (typeof State !== 'undefined' && State.term) || '',
        container: () => document.getElementById('history-container'),
        createElement: tag => document.createElement(tag),
    });
})();

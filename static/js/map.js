/*
 * Campus map, wired to its fenced implementation.
 *
 * The logic lives in features/map/index.js. This file supplies the four real
 * dependencies and the route cache, and exposes the instance under the name the
 * fourteen existing call sites already use.
 *
 * As with history, it exposes the instance rather than wrapping it: callers
 * reach for internals such as WalkingMap._map and WalkingMap.buildings, and a
 * delegating wrapper would drop those silently.
 */
const WalkingMap = (() => {
    'use strict';

    const factory = (typeof globalThis !== 'undefined' && (globalThis.Features || {}).map)
        || (typeof require === 'function' ? require('./features/map/index.js') : null);
    if (!factory) throw new Error('Map feature is not loaded');

    // Storage is denied outright in some privacy modes, so the composition point
    // absorbs that rather than letting every call site guard it.
    const storage = {
        getItem(key) {
            try { return localStorage.getItem(key); } catch (error) { return null; }
        },
        setItem(key, value) {
            try { localStorage.setItem(key, value); return true; } catch (error) { return false; }
        },
    };

    return factory.createMapFeature({
        getDetails: (crn, term, options) => API.getDetails(crn, term, options),
        currentTerm: () => (typeof State !== 'undefined' && State.term) || '',
        selectedSections: () => (typeof State !== 'undefined' && State.selectedSections) || {},
        onStateChange: (event, handler) => State.on(event, handler),
        fetch: (...args) => fetch(...args),
        storage,
    });
})();

/*
 * Composition point for the fenced custom major map feature.
 *
 * The logic moved to static/js/features/custom-major-map/index.js. This file is
 * the only place that knows the builder is wired to State, Profile, AppModal
 * and localStorage, and it is deliberately the boring half.
 *
 * CustomMajorMap is the feature instance rather than a wrapper around it. A
 * facade that forwards methods drops anything a caller replaces on the object,
 * and the failure is silent because the forwarding still works.
 */
const CustomMajorMap = (() => {
    const factory = (typeof Features !== 'undefined' && Features.customMajorMap)
        || (typeof require === 'function' ? require('./features/custom-major-map/index.js') : null);
    if (!factory) throw new Error('custom major map feature is not loaded');

    const STORAGE_KEY = 'uosc-custom-major-maps-v1';

    /*
     * A bare key, deliberately unchanged for now.
     *
     * Device-local accounts prefix their keys through Keyspace, and this one is
     * not routed that way, so every account on a shared machine sees the same
     * custom maps. Routing it now would orphan maps students have already
     * saved, so it needs a migration rather than a one-line change. Recorded in
     * TODO.md; the seam is here so the fix is local when it happens.
     */
    function readMaps() {
        try {
            return typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
        } catch (error) {
            // Storage access throws outright in some privacy modes.
            return null;
        }
    }

    function writeMaps(value) {
        try {
            if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, value);
        } catch (error) {
            // Quota exhausted or storage denied. The builder stays usable; the
            // map just does not survive the session.
        }
    }

    return factory.createCustomMajorMapFeature({
        readMaps,
        writeMaps,

        currentProfile: () => (typeof State !== 'undefined' ? State.profile : {}),

        onProfileChange: handler => {
            if (typeof State !== 'undefined') State.on('profile-updated', handler);
        },

        /*
         * Make a freshly saved map the active one. This is six Profile calls in
         * a specific order -- register, repopulate, select, load -- and it lived
         * inside the builder behind a `typeof Profile === 'undefined'` guard.
         * Inside a fence that guard always passes, so the map would save and
         * never become active, with no error anywhere.
         */
        onMapSaved: map => {
            if (typeof Profile === 'undefined') return;
            Profile.majorMaps = Profile.majorMaps.filter(item => item.id !== map.id);
            Profile.majorMaps.push(map);
            Profile.populateProgramSelect();
            const programKey = Profile.programKey(map);
            const select = document.getElementById('major-program-select');
            if (select) select.value = programKey;
            Profile.populateCatalogYears(programKey, map.id);
            void Profile.onMajorChange(map.id);
        },

        onMapDeleted: () => {
            if (typeof Profile !== 'undefined') void Profile.loadMajorMaps();
        },

        // Optional chaining used to hide a missing modal; a stub keeps the
        // feature's requirement honest without making the page fail to load.
        modal: {
            open: (html, options) => globalThis.AppModal?.open(html, options),
            close: () => globalThis.AppModal?.close(),
        },
    });
})();

if (typeof module === 'object' && module.exports) module.exports = CustomMajorMap;
if (typeof globalThis === 'object') globalThis.CustomMajorMap = CustomMajorMap;

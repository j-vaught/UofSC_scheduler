/*
 * Composition point for the fenced profile feature.
 *
 * The logic moved to static/js/features/profile/index.js. This file is the only
 * place that knows the profile is wired to State, API and the custom map
 * builder, and it is deliberately the boring half.
 *
 * This is also where the CustomMajorMap cycle is resolved. The builder no
 * longer calls Profile and Profile no longer calls the builder; each is given
 * the other's operations here, at load time, where the order is a fact of the
 * markup rather than an assumption inside a module.
 *
 * Profile is the feature instance rather than a wrapper around it. A facade
 * that forwards methods drops anything a caller replaces on the object, and the
 * failure is silent because the forwarding still works -- and the builder does
 * exactly that, assigning Profile.majorMaps directly.
 */
const Profile = (() => {
    const factory = (typeof Features !== 'undefined' && Features.profile)
        || (typeof require === 'function' ? require('./features/profile/index.js') : null);
    if (!factory) throw new Error('profile feature is not loaded');

    /*
     * The custom map builder may legitimately not be loaded -- it is a separate
     * script tag, and the page should still show official maps without it. That
     * is why these two stay guarded here: out at the composition point a missing
     * global is a real possibility, unlike inside the feature where it was a
     * certainty and the guard silently emptied the list.
     */
    const customMaps = () => (typeof CustomMajorMap !== 'undefined' ? CustomMajorMap : null);

    return factory.createProfileFeature({
        getMajorMaps: () => API.getMajorMaps(),
        getMajorMap: id => API.getMajorMap(id),

        listCustomMaps: () => customMaps()?.listMaps() ?? [],
        getCustomMap: id => customMaps()?.get(id) ?? null,

        parseTranscript: text => API.parseTranscript(text),
        parseTranscriptCSV: csv => API.parseTranscriptCSV(csv),

        profile: () => State.profile,
        completedCourses: () => State.completedCourses,
        completedDetails: () => State.completedDetails,

        addManualCompleted: records => State.addManualCompletedRecords(records),
        removeCompleted: code => State.removeCompletedCourse(code),

        emitProfileUpdated: () => State.emit('profile-updated'),
        onTranscriptChange: handler => State.on('transcript-updated', handler),
    });
})();

if (typeof module === 'object' && module.exports) module.exports = Profile;
if (typeof globalThis === 'object') globalThis.Profile = Profile;

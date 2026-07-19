/*
 * Composition point for the fenced degree plan feature.
 *
 * The logic moved to static/js/features/degree-plan/index.js. This file is the
 * only place that knows the tab is wired to State, API, Profile, Prereqs,
 * Scheduler and Search, and it is deliberately the boring half.
 *
 * The navigation seams -- showCourse, searchFor -- are why this tab could be
 * fenced before Search and Scheduler are. They were never data dependencies,
 * only "take the student somewhere", so they cost nothing as callbacks and they
 * remove two inbound edges from the cycle that gets untangled last.
 */
const DegreePlan = (() => {
    const factory = (typeof Features !== 'undefined' && Features.degreePlan)
        || (typeof require === 'function' ? require('./features/degree-plan/index.js') : null);
    if (!factory) throw new Error('degree plan feature is not loaded');

    return factory.createDegreePlanFeature({
        getDegreePlan: request => API.getDegreePlan(request),
        bulletinSearch: subject => API.bulletinSearch(subject),
        getOfferingAnalysis: (code, term) => API.getOfferingAnalysis(code, term),

        /*
         * Prerequisite enrichment, optional by design. The feature plans from
         * the unenriched map when this is absent, which is the correct
         * degradation for a layer that arrives as a separate script tag.
         *
         * Enrichment has an open problem of its own: it injects bulletin
         * prerequisites naming courses outside the degree map, which makes some
         * courses unplaceable. See TODO.md. This seam is where a fix or a
         * different enricher would go.
         */
        enrichMajorMap: (typeof Prereqs !== 'undefined' && Prereqs.enrichMajorMap)
            ? majorData => Prereqs.enrichMajorMap(majorData)
            : undefined,

        plan: () => State.degreePlan,
        profile: () => State.profile,
        completedCourses: () => State.completedCourses,
        completedDetails: () => State.completedDetails,
        selectedSections: () => State.selectedSections,
        selectedCourses: () => State.selectedCourses,
        sectionLocks: () => State.sectionLocks,
        currentTerm: () => State.term,

        setSectionLock: (code, crn) => State.setSectionLock(code, crn),
        removeCourse: code => State.removeCourse(code),
        emitPlanUpdated: () => State.emit('degree-plan-updated'),

        // Major-map presentation, owned by Profile because the sidebar shows
        // the same catalog year and source line the profile panel does.
        findMajorMap: id => Profile.majorMaps?.find(map => map.id === id) || null,
        catalogYearLabel: map => Profile.catalogYearLabel(map),
        sourceUrl: map => Profile.sourceUrl(map),
        sourceLabel: map => Profile.sourceLabel(map),

        onCourseworkChanged: () => {
            Profile.renderCompletedChips();
            Profile.renderCreditSummary();
        },

        // Navigation. Not data: these hand the student to another tab.
        showCourse: (course, section = null) => Scheduler.openCourseQuickView(course, section),

        searchFor: title => {
            Tabs.switchTo('semester');
            const input = Search.activeSearchInput();
            if (input) input.value = title;
            Search.doSearch();
        },

        onProfileChange: handler => State.on('profile-updated', handler),
        onTranscriptChange: handler => State.on('transcript-updated', handler),
        onPlanChange: handler => State.on('degree-plan-updated', handler),
    });
})();

/*
 * Untouched, and still here on purpose. ScheduleSidebar shared this file with
 * DegreePlan without sharing anything else; it belongs with the schedule tab,
 * which the plan fences later. Moving it now would hide a second extraction
 * inside this one.
 */
/* Schedule sidebar (selected courses list in Schedule tab) */
const ScheduleSidebar = {
    render() {
        const list = document.getElementById('selected-courses-list');
        const creditsEl = document.getElementById('selected-credits');
        const countEl = document.getElementById('schedule-selected-count');
        if (!list) return;

        const courses = State.selectedCourses;
        const codes = Object.keys(courses);
        if (countEl) countEl.textContent = codes.length > 0 ? `(${codes.length} selected)` : '';

        if (codes.length === 0) {
            list.innerHTML = '<p class="hint">Add courses from the results above. You do not need to choose a section.</p>';
            if (creditsEl) creditsEl.textContent = '';
            return;
        }

        let html = '';
        let totalCredits = 0;

        codes.forEach(code => {
            const course = courses[code];
            const title = course.title || code;
            const openSections = (course.sections || []).filter(section => !section.stat || section.stat === 'A');
            const applied = State.selectedSections[code];
            const lockedCrn = State.sectionLocks[code] || '';
            const lockedSection = (course.sections || []).find(section =>
                String(section.crn) === String(lockedCrn),
            );
            const lockedSectionIsFull = Boolean(
                lockedSection && lockedSection.stat && lockedSection.stat !== 'A',
            );
            const defaultSectionLabel = applied?.section
                ? `Section ${applied.section} selected`
                : `${openSections.length} open section${openSections.length === 1 ? '' : 's'}`;
            const sortedSections = [...(course.sections || [])].sort((left, right) => {
                const leftOpen = !left.stat || left.stat === 'A';
                const rightOpen = !right.stat || right.stat === 'A';
                if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
                return String(left.section || '').localeCompare(
                    String(right.section || ''),
                    undefined,
                    { numeric: true, sensitivity: 'base' },
                );
            });
            const sectionOptions = sortedSections.map(section => {
                const instructor = (section.instructor || section.instr) && (section.instructor || section.instr) !== 'Staff' ? (section.instructor || section.instr) : 'Undecided';
                const availability = !section.stat || section.stat === 'A' ? '' : ' — FULL';
                const selected = String(section.crn) === String(lockedCrn) ? ' selected' : '';
                return `<option value="${section.crn}"${selected}>Section ${section.section || '?'} — ${instructor} — ${section.meets || 'TBA'}${availability}</option>`;
            }).join('');

            html += `
                <div class="selected-course-item">
                    <div class="selected-course-header">
                        <button type="button" class="selected-course-open" data-code="${code}" title="View details for ${code}"><strong>${code}</strong></button>
                        <button type="button" class="btn-remove" data-code="${code}" title="Remove ${code} from your courses">REMOVE</button>
                    </div>
                    <div class="selected-course-detail">${title}</div>
                    <label class="section-lock-label" for="section-lock-${code.replace(/\s+/g, '-')}">Section preference</label>
                    <div class="section-lock-control">
                        <select class="section-lock-select" id="section-lock-${code.replace(/\s+/g, '-')}" data-code="${code}">
                            <option value="">${defaultSectionLabel}</option>
                            ${sectionOptions}
                        </select>
                        <span class="section-lock-arrow" aria-hidden="true">▼</span>
                    </div>
                    ${lockedCrn ? `<button type="button" class="btn-clear-section" data-code="${code}">CLEAR SECTION</button>` : ''}
                    ${lockedSectionIsFull
                        ? '<div class="section-lock-warning">Full section selected. Planning only; enrollment requires an opening or override.</div>'
                        : ''}
                </div>
            `;
            const creditValues = String(
                course.credits ?? (course.sections || [])[0]?.hours ?? 3,
            ).match(/\d+(?:\.\d+)?/g) || ['3'];
            totalCredits += Math.max(...creditValues.map(Number));
        });

        list.innerHTML = html;
        if (creditsEl) creditsEl.textContent = `${totalCredits} credits`;

        list.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                State.removeCourse(btn.dataset.code);
            });
        });
        list.querySelectorAll('.selected-course-open').forEach(button => {
            button.addEventListener('click', () => {
                const course = State.selectedCourses[button.dataset.code];
                if (!course || typeof Scheduler === 'undefined') return;
                const crn = State.sectionLocks[button.dataset.code] || State.selectedSections[button.dataset.code]?.crn;
                const section = (course.sections || []).find(candidate => String(candidate.crn) === String(crn));
                Scheduler.openCourseQuickView(course, section || null);
            });
        });
        list.querySelectorAll('.btn-clear-section').forEach(button => {
            button.addEventListener('click', () => State.setSectionLock(button.dataset.code, ''));
        });
        list.querySelectorAll('.section-lock-select').forEach(select => {
            select.addEventListener('change', () => {
                State.setSectionLock(select.dataset.code, select.value);
            });
        });
    },
};

if (typeof module === 'object' && module.exports) module.exports = DegreePlan;
if (typeof globalThis === 'object') globalThis.DegreePlan = DegreePlan;

/*
 * Generating a plan and deriving completed semesters.
 *
 * One part of the degree-plan feature, which was a single module of over two
 * thousand lines. Each part is a factory returning plain methods; index.js
 * merges them onto one object, so `this` still reaches every method and no
 * call site changed.
 *
 * Cut at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly.
 */
(function initPlanPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.DegreePlanParts) root.DegreePlanParts = {};
    root.DegreePlanParts.createPlanPart = api.createPlanPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createPlanPart(deps) {
        return {
        bindGenerateButton() {
            const btn = document.getElementById('btn-generate-plan');
            if (!btn) return;
            btn.addEventListener('click', () => this.generatePlan());
        },

        async generatePlan() {
            const majorData = deps.profile().majorData;
            if (!majorData) {
                // Shown in place for the same reason as the scheduler's empty state:
                // the control the student needs is on screen, so a modal dialog only
                // stands between them and it.
                const list = document.getElementById('requirements-list');
                if (list) {
                    list.innerHTML = '<p class="hint">Choose a major and catalog year above, '
                        + 'then generate a plan.</p>';
                }
                return;
            }

            // No confirmation for an empty coursework list. The wizard's second step
            // has an explicit "I have not taken any courses yet" control, so the
            // student has already answered this question; asking again blocks the
            // page on a modal dialog to learn nothing. Starting from zero completed
            // courses is the normal case for an incoming student.

            const btn = document.getElementById('btn-generate-plan');
            btn.textContent = 'GENERATING...';
            btn.disabled = true;

            try {
                // Was existence-guarded on a global. Inside a fence that guard
                // always fails, so the plan would silently be built from the
                // unenriched map -- a different plan, with no error.
                const enrichedMajorData = deps.enrichMajorMap
                    ? await deps.enrichMajorMap(majorData)
                    : majorData;
                deps.profile().majorData = enrichedMajorData;
                const plan = await deps.getDegreePlan({
                    map_id: deps.profile().major,
                    major_map: enrichedMajorData,
                    completed: deps.completedCourses(),
                    mode: deps.profile().planMode,
                    pins: deps.plan().pins || {},
                    start_term: deps.currentTerm() || '202608',
                    include_summer: deps.profile().includeSummer,
                    custom_credits: deps.profile().planMode === 'custom' ? deps.profile().customCredits : null,
                    concentration: deps.profile().concentration,
                    strategy: deps.profile().degreeStrategy || 'major_map',
                });

                if (plan.error) {
                    alert('Error: ' + plan.error);
                    return;
                }

                deps.plan().semesters = plan.semesters || [];
                deps.plan().warnings = plan.warnings || [];
                deps.plan().totalRemaining = plan.total_credits_remaining || 0;
                deps.plan().completedCredits = plan.completed_credits || 0;
                deps.plan().estimatedGraduation = plan.estimated_graduation || '';
                deps.plan().categories = plan.categories || {};

                // Auto-collapse completed section after generating
                deps.plan().completedCollapsed = true;

                deps.emitPlanUpdated();
            } catch (e) {
                console.error('Degree plan generation failed:', e);
                alert('Failed to generate degree plan. Please try again.');
            } finally {
                btn.textContent = 'GENERATE DEGREE PLAN';
                btn.disabled = false;
            }
        },

        // Build completed semester columns from deps.completedCourses() + completedDetails
        buildCompletedSemesters() {
            const majorData = deps.profile().majorData;
            if (!majorData) return;

            // Group completed courses by their typical semester
            const semMap = {};
            const completed = deps.completedCourses();

            // If there are existing completed semesters with courses, preserve their assignment
            const existingAssignments = {};
            (deps.plan().completedSemesters || []).forEach(sem => {
                sem.courses.forEach(c => { existingAssignments[c.code] = sem.term; });
            });

            // Build a mapping of typical_year + semester -> past term code
            // Work backwards from the current term
            const currentTerm = deps.currentTerm() || '202608';
            const currentYear = parseInt(currentTerm.slice(0, 4));
            const pastTermMap = {}; // { '1_Fall': '202308', '1_Spring': '202401', ... }
            for (let yr = 1; yr <= 4; yr++) {
                const pastYear = currentYear - (4 - yr) - 1; // e.g. for yr=1 with current 2026: 2022
                pastTermMap[`${yr}_Fall`] = `${pastYear}08`;
                pastTermMap[`${yr}_Spring`] = `${pastYear + 1}01`;
            }
            const termNames = { '01': 'Spring', '05': 'Summer', '08': 'Fall' };

            completed.forEach(code => {
                const mapCourse = majorData.required_courses.find(c => c.code === code);
                const detail = deps.completedDetails().find(d => d.code === code);

                let termKey, termLabel, semType;
                if (existingAssignments[code]) {
                    termKey = existingAssignments[code];
                    const existing = (deps.plan().completedSemesters || []).find(s => s.term === termKey);
                    termLabel = existing ? existing.label : termKey;
                    semType = 'completed';
                } else if (detail && detail.semester) {
                    termKey = detail.semester;
                    termLabel = detail.semester;
                    semType = 'completed';
                } else if (mapCourse && mapCourse.typical_year) {
                    // Spread across past semesters based on typical year/semester
                    const sem = mapCourse.typical_semester || 'Fall';
                    const key = `${mapCourse.typical_year}_${sem}`;
                    termKey = pastTermMap[key] || 'prior';
                    if (termKey !== 'prior') {
                        const yr = termKey.slice(0, 4);
                        const semCode = termKey.slice(4);
                        termLabel = `${termNames[semCode] || ''} ${yr}`;
                    } else {
                        termLabel = 'Prior Courses';
                    }
                    semType = 'completed';
                } else {
                    termKey = 'prior';
                    termLabel = 'Prior Courses';
                    semType = 'completed';
                }

                if (!semMap[termKey]) {
                    semMap[termKey] = {
                        term: termKey,
                        label: termLabel,
                        courses: [],
                        total_credits: 0,
                        type: semType,
                    };
                }

                const credits = (mapCourse && mapCourse.credits) || (detail && detail.credits) || 3;
                semMap[termKey].courses.push({
                    code: code,
                    title: mapCourse ? mapCourse.title : code,
                    credits: credits,
                    category: mapCourse ? mapCourse.category : '',
                });
                semMap[termKey].total_credits += credits;
            });

            // Sort by term key
            const sorted = Object.values(semMap).sort((a, b) => {
                if (a.term === 'unknown') return -1;
                if (b.term === 'unknown') return 1;
                return a.term.localeCompare(b.term);
            });

            deps.plan().completedSemesters = sorted;
        },

        };
    }

    return { createPlanPart };
}));

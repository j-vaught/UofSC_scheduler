/*
 * The degree plan tab, fenced: the multi-semester course roadmap.
 *
 * The sixth extraction under phase 7a and the widest so far -- twenty-four
 * dependencies across state, the degree API, major-map presentation, and
 * navigation into two other tabs. The count is what it is because this tab is
 * where everything else meets: it reads the profile and the transcript, calls
 * the planner, and sends the student to search or to a course detail.
 *
 * The edges into Search and Scheduler are the interesting ones, and they are
 * why this could be fenced before those modules are. Neither is a data
 * dependency; both are "take the student somewhere" -- open this course, search
 * for this title. As callbacks they cost nothing here and remove inbound edges
 * from the cycle that has to be untangled last.
 *
 * One more existence-guarded ternary came out, making at least one in every
 * extraction so far. This one guarded prerequisite enrichment, so inside a
 * fence the plan would have been built from the unenriched major map: a
 * different plan, quietly, with nothing to indicate it.
 *
 * Note that enrichment is itself the subject of an open problem in TODO.md --
 * it injects bulletin prerequisites naming courses outside the degree, which
 * makes some courses unplaceable. Fencing does not change that behaviour, and
 * deliberately so, but it does make the dependency visible and swappable, which
 * is what that investigation will need.
 *
 * ScheduleSidebar stays in the composition file. It shared degree-plan.js
 * without sharing anything else, and it belongs with the schedule tab, which
 * the plan fences later. Moving it now would be a second extraction hidden
 * inside this one.
 *
 * The DOM stays ambient, as in the other view features.
 *
 * The body is the previous implementation verbatim apart from those seams.
 */
(function initDegreePlanFeature(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.Features) root.Features = {};
    root.Features.degreePlan = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createDegreePlanFeature(deps) {
        for (const name of ['getDegreePlan', 'bulletinSearch', 'getOfferingAnalysis',
            'plan', 'profile', 'completedCourses', 'completedDetails',
            'selectedSections', 'selectedCourses', 'sectionLocks', 'currentTerm',
            'setSectionLock', 'removeCourse', 'emitPlanUpdated',
            'findMajorMap', 'catalogYearLabel', 'sourceUrl', 'sourceLabel',
            'onCourseworkChanged', 'showCourse', 'searchFor',
            'onProfileChange', 'onTranscriptChange', 'onPlanChange']) {
            if (typeof deps?.[name] !== 'function') {
                throw new TypeError(`degree plan feature needs a ${name}() dependency`);
            }
        }
        // Optional on purpose: a deployment without the prerequisite layer
        // should still plan, from the unenriched map.
        if (deps.enrichMajorMap !== undefined && typeof deps.enrichMajorMap !== 'function') {
            throw new TypeError('degree plan feature needs enrichMajorMap() to be a function when supplied');
        }

        const feature = {        init() {
            this.bindGenerateButton();
            this.bindDragDrop();

            deps.onProfileChange(() => this.updateSidebar());
            deps.onTranscriptChange(() => {
                this.buildCompletedSemesters();
                this.updateSidebar();
                this.render();
            });
            deps.onPlanChange(() => {
                this.buildCompletedSemesters();
                this.render();
            });

            if (deps.plan().semesters.length > 0) {
                this.render();
            }
            this.updateSidebar();
        },

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

        updateSidebar() {
            const majorData = deps.profile().majorData;
            const list = document.getElementById('degree-requirements-list');
            const modeLabel = document.getElementById('plan-mode-label');
            this.renderMapContext(majorData);

            if (!majorData) {
                list.innerHTML = '<p class="hint">Choose a program above to see its requirements.</p>';
                return;
            }

            const modeNames = {
                'full_time': 'Full-Time (~15 cr/sem)',
                'scholarship': 'Scholarship (30 cr/yr)',
                'part_time': 'Part-Time (6-9 cr/sem)',
                'custom': 'Custom',
            };
            if (modeLabel) {
                modeLabel.textContent = `Mode: ${modeNames[deps.profile().planMode] || deps.profile().planMode}`;
            }

            const totalRequired = majorData.total_credits_required;
            const completed = deps.plan().completedCredits || this.estimateCompletedCredits();
            const pct = Math.min(100, Math.round((completed / totalRequired) * 100));

            document.getElementById('progress-overall-fill').style.width = pct + '%';
            document.getElementById('progress-overall-text').textContent = `${completed} / ${totalRequired} credits (${pct}%)`;

            const catData = deps.plan().categories || {};
            // No published major map carries category_labels — all 185 omit it — so
            // relying on it alone left the requirements panel showing its "generate a
            // plan" placeholder forever, for every major, even with a plan on screen.
            // The categories the planner returns are the real source; labels are only
            // presentation, so derive them when the map does not supply any.
            const categories = Object.keys(majorData.category_labels || {}).length
                ? majorData.category_labels
                : Object.fromEntries(Object.keys(catData).map(key => [key, this.categoryLabel(key)]));

            let html = '';
            for (const [catKey, catLabel] of Object.entries(categories)) {
                const data = catData[catKey] || { required: 0, completed: 0, remaining: 0 };
                const catPct = data.required > 0 ? Math.round((data.completed / data.required) * 100) : 0;
                const status = data.remaining === 0 ? 'complete' : 'incomplete';

                html += `
                    <div class="req-category ${status}">
                        <div class="req-category-header">
                            <span class="req-category-name">${catLabel}</span>
                            <span class="req-category-count">${data.completed}/${data.required} cr</span>
                        </div>
                        <div class="progress-bar small"><div class="progress-fill" style="width:${catPct}%"></div></div>
                    </div>
                `;
            }

            list.innerHTML = html || '<p class="hint">Generate a plan to see requirement details.</p>';
        },

        // Human-readable name for a requirement category key. Known keys are spelled
        // out; anything new degrades to a title-cased version of the key rather than
        // disappearing from the panel.
        CATEGORY_LABELS: {
            carolina_core: 'Carolina Core',
            program_requirements: 'Program requirements',
            major_courses: 'Major courses',
            major_core: 'Major core',
            major_electives: 'Major electives',
            electives: 'Electives',
            cognate: 'Cognate or minor',
            other: 'Other requirements',
        },

        categoryLabel(key) {
            if (this.CATEGORY_LABELS[key]) return this.CATEGORY_LABELS[key];
            return String(key || '')
                .replace(/[_-]+/g, ' ')
                .replace(/^\s*\w/, match => match.toUpperCase())
                .trim() || 'Requirements';
        },

        renderMapContext(majorData) {
            const context = document.getElementById('degree-map-context');
            if (!context) return;
            if (!majorData) {
                context.hidden = true;
                context.replaceChildren();
                return;
            }

            const indexEntry = deps.findMajorMap(deps.profile().major) || {};
            const map = { ...indexEntry, ...majorData };
            const title = document.createElement('strong');
            title.textContent = `${map.major} — ${map.program}`;
            const year = document.createElement('span');
            year.textContent = deps.catalogYearLabel(map);
            const sourceUrl = deps.sourceUrl(map);
            const source = document.createElement(sourceUrl ? 'a' : 'span');
            source.textContent = deps.sourceLabel(map);
            if (sourceUrl) {
                source.href = sourceUrl;
                source.target = '_blank';
                source.rel = 'noopener noreferrer';
                source.title = 'Open the official major map in a new tab';
            }
            context.replaceChildren(title, year, source);
            context.hidden = false;
        },

        estimateCompletedCredits() {
            let credits = 0;
            const majorData = deps.profile().majorData;
            deps.completedCourses().forEach(code => {
                if (majorData) {
                    const c = majorData.required_courses.find(r => r.code === code);
                    credits += c ? c.credits : 3;
                } else {
                    credits += 3;
                }
            });
            return credits;
        },

        render() {
            const container = document.getElementById('semester-columns');
            const warningsEl = document.getElementById('degree-warnings');
            const plannedSemesters = deps.plan().semesters;
            const completedSemesters = deps.plan().completedSemesters || [];

            if (plannedSemesters.length === 0 && completedSemesters.length === 0) {
                container.innerHTML = '<p class="hint" style="padding:20px">Set up your profile and click "Generate Degree Plan" to see your semester-by-semester course plan.</p>';
                warningsEl.innerHTML = '';
                return;
            }

            this.renderWarnings(warningsEl);

            let html = '';

            // Completed section
            if (completedSemesters.length > 0) {
                const collapsed = deps.plan().completedCollapsed;
                const totalCompCredits = completedSemesters.reduce((sum, s) => sum + s.total_credits, 0);
                const totalCompCourses = completedSemesters.reduce((sum, s) => sum + s.courses.length, 0);

                html += `<div class="completed-section ${collapsed ? 'collapsed' : ''}">`;

                // Collapse bar
                html += `
                    <button type="button" class="completed-collapse-bar" id="completed-toggle" aria-expanded="${!collapsed}">
                        <span class="completed-collapse-arrow">${collapsed ? '&#9654;' : '&#9660;'}</span>
                        <span class="completed-collapse-label">COMPLETED: ${totalCompCredits} credits (${totalCompCourses} courses) across ${completedSemesters.length} semester${completedSemesters.length !== 1 ? 's' : ''}</span>
                    </button>
                `;

                if (!collapsed) {
                    html += '<div class="completed-columns">';

                    // Add Semester button
                    html += `
                        <button type="button" class="add-semester-btn" id="btn-add-completed-sem">
                            <span>+</span>
                            <span style="font-size:0.7rem">ADD<br>SEMESTER</span>
                        </button>
                    `;

                    completedSemesters.forEach((sem, idx) => {
                        html += this.renderCompletedColumn(sem, idx);
                    });

                    html += '</div>';

                    // Add course input
                    const savedInput = this._addInputValue || '';
                    const savedErrors = this._addErrors || [];
                    const errorsHtml = savedErrors.length > 0
                        ? savedErrors.map(e => `<div class="add-error-item">${e}</div>`).join('')
                        : '';
                    html += `
                        <div class="completed-add-course">
                            <input type="text" id="completed-add-input" placeholder="Add courses: CSCE 145, MATH 141, ..." value="${savedInput.replace(/"/g, '&quot;')}">
                            <button id="btn-add-completed" class="btn-garnet">ADD</button>
                        </div>
                        <div id="completed-add-errors" class="completed-add-errors">${errorsHtml}</div>
                    `;
                }

                html += '</div>';

                // Divider
                html += '<div class="plan-divider"><span class="plan-divider-label">PLANNED</span></div>';
            }

            // Planned semesters
            html += '<div class="planned-columns">';
            plannedSemesters.forEach((sem, idx) => {
                html += this.renderSemesterColumn(sem, idx);
            });

            // Graduation marker
            if (deps.plan().estimatedGraduation) {
                html += `
                    <div class="semester-column graduation-column">
                        <div class="semester-header graduation-header">GRADUATION</div>
                        <div class="graduation-content">
                            <div class="graduation-icon">&#127891;</div>
                            <div class="graduation-text">${deps.plan().estimatedGraduation}</div>
                        </div>
                    </div>
                `;
            }
            html += '</div>';

            container.innerHTML = html;

            this.bindCourseCards();
            this.bindCompletedControls();
            this.updateSidebar();
        },

        renderCompletedColumn(sem, idx) {
            const isCurrent = sem.type === 'current';
            const headerClass = isCurrent ? 'semester-header current-header' : 'semester-header completed-header';

            let coursesHtml = '';
            sem.courses.forEach(course => {
                coursesHtml += `
                    <div class="course-card completed-card" data-code="${course.code}" data-semester="${sem.term}" data-section="completed" draggable="true">
                        <div class="course-card-header">
                            <span class="course-card-code">${isElective ? course.title : course.code}</span>
                            <button type="button" class="card-remove-badge" data-code="${course.code}" aria-label="Remove ${course.code}">REMOVE</button>
                        </div>
                        <div class="course-card-title">${course.title} <span class="course-card-credits">${course.credits} cr</span></div>
                    </div>
                `;
            });

            const deleteBtn = sem.courses.length === 0
                ? `<button type="button" class="sem-delete-btn" data-term="${sem.term}" title="Delete semester" aria-label="Delete ${sem.label}">&times;</button>`
                : '';

            return `
                <div class="semester-column completed-column ${isCurrent ? 'current' : ''}" data-term="${sem.term}" data-index="${idx}" data-section="completed">
                    <div class="${headerClass}">
                        <span class="semester-label">${sem.label}</span>
                        <span class="semester-credits">${sem.total_credits} cr ${deleteBtn}</span>
                    </div>
                    <div class="semester-courses" data-term="${sem.term}" data-section="completed">
                        ${coursesHtml}
                    </div>
                </div>
            `;
        },

        renderSemesterColumn(sem, idx) {
            const isSummer = sem.label && sem.label.startsWith('Summer');
            const semClass = isSummer ? 'semester-column summer' : 'semester-column';
            const creditWarning = sem.total_credits > 18 ? ' overloaded' : sem.total_credits < 12 ? ' light' : '';

            let coursesHtml = '';
            sem.courses.forEach(course => {
                const isElective = course.is_elective_slot;
                const isPinned = course.pinned;
                const restriction = course.offering_restriction;
                let badges = '';

                if (restriction === 'fall_only') badges += '<span class="badge-restriction">FALL ONLY</span>';
                if (restriction === 'spring_only') badges += '<span class="badge-restriction">SPRING ONLY</span>';
                if (isPinned) badges += '<span class="badge-pinned">PINNED</span>';
                if (isElective) badges += '<span class="badge-elective">ELECTIVE</span>';

                const cardClass = isElective ? 'course-card elective-slot' : 'course-card';

                coursesHtml += `
                    <div class="${cardClass}" data-code="${course.code}" data-semester="${sem.term}" data-section="planned" draggable="true">
                        <div class="course-card-header">
                            <span class="course-card-code">${course.code}</span>
                            <span class="course-card-actions">${isElective ? '' : `<button type="button" class="course-card-info" aria-label="View details and current offerings for ${course.code}" title="View course details, grades, history, and current offerings">i</button>`}<span class="course-card-credits">${course.credits} cr</span></span>
                        </div>
                        <div class="course-card-title">${course.title}</div>
                        <div class="course-card-badges">${badges}</div>
                    </div>
                `;
            });

            return `
                <div class="${semClass}${creditWarning}" data-term="${sem.term}" data-index="${idx}" data-section="planned">
                    <div class="semester-header">
                        <span class="semester-label">${sem.label}</span>
                        <span class="semester-credits">${sem.total_credits} cr</span>
                    </div>
                    <div class="semester-courses" data-term="${sem.term}" data-section="planned">
                        ${coursesHtml}
                    </div>
                </div>
            `;
        },

        renderWarnings(container) {
            const warnings = deps.plan().warnings;
            if (!warnings || warnings.length === 0) {
                container.innerHTML = '';
                return;
            }

            let html = '';
            warnings.forEach(w => {
                const icon = w.type === 'error' ? '&#9888;' : w.type === 'warning' ? '&#9888;' : '&#8505;';
                html += `<div class="warning-item warning-${w.type}">${icon} ${w.message}</div>`;
            });
            container.innerHTML = html;
        },

        bindCompletedControls() {
            // Collapse toggle
            const toggle = document.getElementById('completed-toggle');
            if (toggle) {
                toggle.addEventListener('click', () => {
                    deps.plan().completedCollapsed = !deps.plan().completedCollapsed;
                    this.render();
                });
            }

            // Add completed course input
            const addBtn = document.getElementById('btn-add-completed');
            const addInput = document.getElementById('completed-add-input');
            const addError = document.getElementById('completed-add-errors');
            if (addBtn && addInput) {
                const doAdd = async () => {
                    const text = addInput.value.trim();
                    if (!text) return;

                    // Parse with same flexible format
                    const rawTokens = text.split(/[,;.\n]+/).map(s => s.trim()).filter(Boolean);
                    const parsed = rawTokens.map(s => {
                        const m = s.match(/([A-Za-z]{3,4})\s*(\d{3}[A-Za-z]?)/);
                        return m ? { raw: s, code: m[1].toUpperCase() + ' ' + m[2].toUpperCase() } : { raw: s, code: null };
                    });

                    // Separate parseable from unparseable
                    const unparseable = parsed.filter(p => !p.code);
                    const candidates = parsed.filter(p => p.code);

                    // Validate against bulletin — group by subject for efficiency
                    const subjects = [...new Set(candidates.map(c => c.code.split(' ')[0]))];
                    const validCodes = new Set();

                    addBtn.textContent = 'CHECKING...';
                    addBtn.disabled = true;

                    for (const subj of subjects) {
                        try {
                            const data = await deps.bulletinSearch(subj);
                            (data.results || []).forEach(r => validCodes.add(r.code));
                        } catch (e) {
                            // If bulletin fails, accept all from this subject (don't block the user)
                            candidates.filter(c => c.code.startsWith(subj)).forEach(c => validCodes.add(c.code));
                        }
                    }

                    const valid = candidates.filter(c => validCodes.has(c.code));
                    const invalid = candidates.filter(c => !validCodes.has(c.code));

                    // Add valid courses
                    valid.forEach(({ code }) => {
                        if (!deps.completedCourses().includes(code)) {
                            deps.completedCourses().push(code);
                            const majorData = deps.profile().majorData;
                            const mc = majorData ? majorData.required_courses.find(c => c.code === code) : null;
                            deps.completedDetails().push({ code, grade: null, credits: mc ? mc.credits : 3, semester: null });
                        }
                    });

                    // Store errors and invalid input text for re-render
                    const errors = [
                        ...unparseable.map(p => `"${p.raw}" — could not parse`),
                        ...invalid.map(p => `${p.code} — not found in catalog`),
                    ];
                    this._addErrors = errors;

                    if (errors.length > 0) {
                        const invalidTexts = [...unparseable.map(p => p.raw), ...invalid.map(p => p.code)];
                        this._addInputValue = invalidTexts.join(', ');
                    } else {
                        this._addInputValue = '';
                    }

                    this.buildCompletedSemesters();
                    this.render();
                    if (typeof Profile !== 'undefined') {
                        deps.onCourseworkChanged();
                    }
                };
                addBtn.addEventListener('click', doAdd);
                addInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
                });
                addInput.addEventListener('input', () => {
                    // Clear errors when user edits
                    this._addErrors = [];
                    const errEl = document.getElementById('completed-add-errors');
                    if (errEl) errEl.innerHTML = '';
                });
            }

            // Add semester button
            const addSemBtn = document.getElementById('btn-add-completed-sem');
            if (addSemBtn) {
                addSemBtn.addEventListener('click', () => this.showAddSemesterModal());
            }

            // Remove badges on completed cards
            document.querySelectorAll('.completed-card .card-remove-badge').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const code = btn.dataset.code;
                    deps.completedCourses() = deps.completedCourses().filter(c => c !== code);
                    deps.completedDetails() = deps.completedDetails().filter(c => c.code !== code);
                    this.buildCompletedSemesters();
                    this.render();
                    if (typeof Profile !== 'undefined') {
                        deps.onCourseworkChanged();
                    }
                });
            });

            // Delete empty completed semesters
            document.querySelectorAll('.sem-delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const term = btn.dataset.term;
                    deps.plan().completedSemesters = (deps.plan().completedSemesters || []).filter(s => s.term !== term);
                    this.render();
                });
            });
        },

        showAddSemesterModal() {
            const modal = document.getElementById('modal-overlay');
            const content = document.getElementById('modal-content');

            // Generate past/current term options
            const currentYear = new Date().getFullYear();
            let termsHtml = '';
            for (let y = currentYear; y >= currentYear - 5; y--) {
                termsHtml += `<option value="${y}08">Fall ${y}</option>`;
                termsHtml += `<option value="${y}05">Summer ${y}</option>`;
                termsHtml += `<option value="${y}01">Spring ${y}</option>`;
            }

            content.innerHTML = `
                <h2>Add a Semester</h2>
                <p>Add a past or current semester to track completed courses.</p>
                <div class="form-row" style="margin-top:12px">
                    <label for="add-sem-term">Semester</label>
                    <select id="add-sem-term">${termsHtml}</select>
                </div>
                <div style="margin-top:12px">
                    <button id="btn-confirm-add-sem" class="btn-garnet">ADD SEMESTER</button>
                </div>
            `;
            modal.classList.remove('hidden');

            document.getElementById('btn-confirm-add-sem').addEventListener('click', () => {
                const termCode = document.getElementById('add-sem-term').value;
                const termNames = { '01': 'Spring', '05': 'Summer', '08': 'Fall' };
                const year = termCode.slice(0, 4);
                const sem = termNames[termCode.slice(4)] || '';
                const label = `${sem} ${year}`;

                // Check if already exists
                if (!deps.plan().completedSemesters) deps.plan().completedSemesters = [];
                const exists = deps.plan().completedSemesters.find(s => s.term === termCode);
                if (exists) {
                    modal.classList.add('hidden');
                    return;
                }

                deps.plan().completedSemesters.push({
                    term: termCode,
                    label: label,
                    courses: [],
                    total_credits: 0,
                    type: 'completed',
                });

                // Sort
                deps.plan().completedSemesters.sort((a, b) => a.term.localeCompare(b.term));

                modal.classList.add('hidden');
                this.render();
            });
        },

        bindCourseCards() {
            // Click to view details / pin/unpin (planned courses only)
            document.querySelectorAll('#semester-columns .course-card[data-section="planned"]').forEach(card => {
                card.addEventListener('click', (e) => {
                    const code = card.dataset.code;
                    const term = card.dataset.semester;

                    if (card.classList.contains('elective-slot')) {
                        this.openElectivePicker(card);
                        return;
                    }

                    if (e.ctrlKey || e.metaKey) {
                        if (deps.plan().pins[code]) {
                            delete deps.plan().pins[code];
                        } else {
                            deps.plan().pins[code] = term;
                        }
                        this.render();
                    }
                });
            });
            document.querySelectorAll('#semester-columns .course-card-info').forEach(button => {
                button.addEventListener('click', event => {
                    event.stopPropagation();
                    const card = button.closest('.course-card');
                    const code = card?.dataset.code;
                    if (!code || code.startsWith('ELECTIVE-')) return;
                    const course = deps.profile().majorData?.required_courses?.find(item => item.code === code) || { code };
                    deps.showCourse({
                        code,
                        title: course.title || code,
                        credits: course.credits,
                        sections: [],
                    });
                });
            });
        },

        async openElectivePicker(card) {
            const groupId = card.dataset.code;
            const term = card.dataset.semester;
            const sem = deps.plan().semesters.find(s => s.term === term);
            if (!sem) return;

            const course = sem.courses.find(c => c.code === groupId);
            if (!course) return;

            const coreCode = this.carolinaCoreCode(course);
            if (this.isCarolinaCoreRequirement(course)) {
                await this.openCarolinaCorePicker({ course, groupId, term, coreCode });
                return;
            }
            if (!course.options || course.options.length === 0) {
                const modal = document.getElementById('modal-overlay');
                const content = document.getElementById('modal-content');
                content.innerHTML = `
                    <div class="requirement-picker-empty">
                        <span class="degree-eyebrow">DEGREE REQUIREMENT</span>
                        <h2>${course.title || 'Choose a course'}</h2>
                        <p>The official map identifies the requirement but does not prescribe a fixed course list.</p>
                        <button type="button" id="requirement-search-btn" class="btn-garnet">FIND A COURSE</button>
                    </div>`;
                modal.classList.remove('hidden');
                content.querySelector('#requirement-search-btn').addEventListener('click', () => {
                    modal.classList.add('hidden');
                    deps.searchFor(course.title);
                });
                return;
            }

            const modal = document.getElementById('modal-overlay');
            const content = document.getElementById('modal-content');

            let optionsHtml = `<h2>${coreCode ? 'Choose a Carolina Core course' : 'Choose a course'}</h2><p>${course.title}</p><div class="elective-options">`;
            for (const opt of course.options.slice(0, 20)) {
                optionsHtml += `
                    <div class="elective-option" data-code="${opt}">
                        <span class="elective-option-code">${opt}</span>
                        <button class="btn-small btn-garnet elective-select-btn" data-code="${opt}" data-term="${term}" data-group="${groupId}">SELECT</button>
                        <button class="btn-small btn-black elective-history-btn" data-code="${opt}">HISTORY</button>
                    </div>
                `;
            }
            optionsHtml += '</div>';
            content.innerHTML = optionsHtml;
            modal.classList.remove('hidden');

            content.querySelectorAll('.elective-select-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const code = btn.dataset.code;
                    const targetTerm = btn.dataset.term;
                    const semData = deps.plan().semesters.find(s => s.term === targetTerm);
                    if (semData) {
                        const idx = semData.courses.findIndex(c => c.code === groupId);
                        if (idx >= 0) {
                            semData.courses[idx] = {
                                code: code, title: code,
                                credits: semData.courses[idx].credits,
                                category: semData.courses[idx].category,
                                pinned: true, is_elective_slot: false,
                            };
                            deps.plan().pins[code] = targetTerm;
                        }
                    }
                    modal.classList.add('hidden');
                    this.render();
                });
            });

            content.querySelectorAll('.elective-history-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const code = btn.dataset.code;
                    btn.textContent = '...';
                    try {
                        const analysis = await deps.getOfferingAnalysis(code, deps.currentTerm());
                        const parent = btn.closest('.elective-option');
                        let infoEl = parent.querySelector('.elective-info');
                        if (!infoEl) {
                            infoEl = document.createElement('div');
                            infoEl.className = 'elective-info';
                            parent.appendChild(infoEl);
                        }
                        infoEl.innerHTML = `
                            <span class="offering-label">${analysis.label}</span>
                            ${analysis.next_predicted_label ? `<span class="offering-next">Next: ${analysis.next_predicted_label}</span>` : ''}
                            <span class="offering-freq">Offered ${Math.round(analysis.frequency * 100)}% of terms</span>
                        `;
                    } catch (e) {
                        btn.textContent = 'ERROR';
                    }
                });
            });
        },

        async openCarolinaCorePicker({ course, groupId, term, coreCode = '' }) {
            const loadingMarkup = `
                <section class="core-course-picker" aria-busy="true">
                    <span class="degree-eyebrow">CAROLINA CORE</span>
                    <h2>Choose a Carolina Core course</h2>
                    <p>Loading approved courses from the current Academic Bulletin&hellip;</p>
                </section>`;
            if (window.AppModal?.open) {
                window.AppModal.open(loadingMarkup, {
                    className: 'carolina-core-picker-modal',
                    label: 'Choose a Carolina Core course',
                });
            } else {
                document.getElementById('modal-content').innerHTML = loadingMarkup;
                document.getElementById('modal-overlay').classList.remove('hidden');
            }
            const modalVersion = window.AppModal?.version;

            let catalog;
            try {
                catalog = await CarolinaCore.loadCatalog();
            } catch (error) {
                if (modalVersion !== undefined && modalVersion !== window.AppModal?.version) return;
                document.getElementById('modal-content').innerHTML = `
                    <section class="core-course-picker core-course-picker-error">
                        <span class="degree-eyebrow">CAROLINA CORE</span>
                        <h2>Approved courses could not be loaded</h2>
                        <p>Close this window and try again.</p>
                    </section>`;
                return;
            }
            if (modalVersion !== undefined && modalVersion !== window.AppModal?.version) return;

            const fixedOutcome = String(coreCode || '').toUpperCase();
            const categoryControl = fixedOutcome
                ? `<div class="core-picker-fixed-category"><strong>${fixedOutcome}</strong><span>${this.escapeText(CarolinaCore.label(fixedOutcome))}</span></div>`
                : `<label class="core-picker-field" for="core-picker-outcome">
                        <span>Core requirement</span>
                        <select id="core-picker-outcome">
                            <option value="">All Carolina Core areas</option>
                            ${Object.entries(CarolinaCore.labels).map(([code, label]) => (
                                `<option value="${code}">${code} — ${this.escapeText(label)}</option>`
                            )).join('')}
                        </select>
                    </label>`;
            const content = document.getElementById('modal-content');
            content.innerHTML = `
                <section class="core-course-picker" aria-busy="false">
                    <header class="core-picker-header">
                        <span class="degree-eyebrow">CAROLINA CORE</span>
                        <h2>Choose a course</h2>
                        <p>${this.escapeText(course.title || 'Carolina Core Requirement')}</p>
                    </header>
                    <div class="core-picker-controls">
                        ${categoryControl}
                        <label class="core-picker-field" for="core-picker-query">
                            <span>Filter courses</span>
                            <input id="core-picker-query" type="search" placeholder="Course code or title" autocomplete="off">
                        </label>
                    </div>
                    <div id="core-picker-summary" class="core-picker-summary" aria-live="polite"></div>
                    <div id="core-picker-results" class="core-picker-results"></div>
                    <footer class="core-picker-footer">
                        <span>Approved foundational courses from the ${this.escapeText(catalog.catalog_year || 'current')} Academic Bulletin.</span>
                        <a href="${this.escapeText(catalog.source_url || 'https://academicbulletins.sc.edu/undergraduate/carolina-core-courses/')}" target="_blank" rel="noopener noreferrer">VIEW OFFICIAL LIST</a>
                    </footer>
                </section>`;

            const renderResults = () => {
                const selectedOutcome = fixedOutcome
                    || content.querySelector('#core-picker-outcome')?.value
                    || '';
                const query = content.querySelector('#core-picker-query')?.value || '';
                const matches = CarolinaCore.filterCourses(catalog.courses, {
                    outcome: selectedOutcome,
                    query,
                });
                const summary = content.querySelector('#core-picker-summary');
                const results = content.querySelector('#core-picker-results');
                summary.innerHTML = `<strong>${matches.length} approved ${matches.length === 1 ? 'course' : 'courses'}</strong>${selectedOutcome ? `<span>${selectedOutcome} — ${this.escapeText(CarolinaCore.label(selectedOutcome))}</span>` : '<span>Choose any Core area or narrow the list.</span>'}`;
                results.innerHTML = matches.length ? matches.map(item => `
                    <article class="core-picker-course">
                        <div class="core-picker-course-copy">
                            <div class="core-picker-course-heading">
                                <strong>${this.escapeText(item.code)}</strong>
                                <span>${(item.outcomes || []).map(outcome => `<b>${this.escapeText(outcome)}</b>`).join('')}</span>
                            </div>
                            <p>${this.escapeText(item.title)}</p>
                            <small>${item.overlay ? 'Overlay eligible · ' : ''}Effective ${this.escapeText(item.effective_term || 'current catalog')}</small>
                        </div>
                        <button type="button" class="btn-small btn-garnet core-course-select" data-code="${this.escapeText(item.code)}">SELECT</button>
                    </article>`).join('') : '<p class="core-picker-no-results">No approved courses match these filters.</p>';
                results.querySelectorAll('.core-course-select').forEach(button => {
                    button.addEventListener('click', () => {
                        const selected = catalog.courses.find(item => item.code === button.dataset.code);
                        if (!selected) return;
                        this.selectRequirementCourse({
                            groupId,
                            term,
                            slot: course,
                            selected,
                        });
                    });
                });
            };

            content.querySelector('#core-picker-outcome')?.addEventListener('change', renderResults);
            content.querySelector('#core-picker-query')?.addEventListener('input', renderResults);
            renderResults();
        },

        selectRequirementCourse({ groupId, term, slot, selected }) {
            const semester = deps.plan().semesters.find(item => item.term === term);
            if (!semester) return;
            const index = semester.courses.findIndex(item => item.code === groupId);
            if (index < 0) return;
            semester.courses[index] = {
                code: selected.code,
                title: selected.title || selected.code,
                credits: slot.credits,
                category: 'carolina_core',
                carolina_core: selected.outcomes || [],
                satisfies_requirement: slot.title || '',
                elective_group_id: slot.elective_group_id || groupId,
                pinned: true,
                is_elective_slot: false,
            };
            deps.plan().pins[selected.code] = term;
            if (window.AppModal?.close) window.AppModal.close();
            else document.getElementById('modal-overlay').classList.add('hidden');
            this.render();
        },

        isCarolinaCoreRequirement(course) {
            return course.category === 'carolina_core'
                || /carolina core|\bcc[- ]/i.test(course.title || '');
        },

        carolinaCoreCode(course) {
            if (!this.isCarolinaCoreRequirement(course)) return '';
            const text = `${course.title || ''} ${course.elective_group_id || ''}`.toUpperCase();
            const match = text.match(/(?:CC[- _]?)?(AIU|ARP|CMS|CMW|GFL|GHS|GSS|INF|SCI|VSR)\b/);
            return match ? match[1] : '';
        },

        escapeText(value) {
            return String(value ?? '')
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;')
                .replaceAll('"', '&quot;')
                .replaceAll("'", '&#39;');
        },

        bindDragDrop() {
            const container = document.getElementById('semester-columns');
            if (!container) return;

            container.addEventListener('dragstart', (e) => {
                const card = e.target.closest('.course-card');
                if (!card) { e.preventDefault(); return; }
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    code: card.dataset.code,
                    fromTerm: card.dataset.semester,
                    fromSection: card.dataset.section || 'planned',
                }));
                card.classList.add('dragging');
            });

            container.addEventListener('dragend', (e) => {
                const card = e.target.closest('.course-card');
                if (card) card.classList.remove('dragging');
            });

            container.addEventListener('dragover', (e) => {
                const zone = e.target.closest('.semester-courses');
                if (zone) {
                    e.preventDefault();
                    zone.classList.add('drag-over');
                }
            });

            container.addEventListener('dragleave', (e) => {
                const zone = e.target.closest('.semester-courses');
                if (zone) zone.classList.remove('drag-over');
            });

            container.addEventListener('drop', (e) => {
                e.preventDefault();
                const zone = e.target.closest('.semester-courses');
                if (!zone) return;
                zone.classList.remove('drag-over');

                try {
                    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                    const toTerm = zone.dataset.term;
                    const toSection = zone.dataset.section || 'planned';

                    if (data.fromTerm === toTerm) return;

                    // Enforce drag rules:
                    // completed/current -> completed/current: OK
                    // completed/current -> planned: NOT allowed (use delete instead)
                    // planned -> planned: OK
                    // planned -> completed/current: NOT allowed
                    if (data.fromSection === 'completed' && toSection === 'planned') return;
                    if (data.fromSection === 'planned' && toSection === 'completed') return;

                    this.moveCourse(data.code, data.fromTerm, toTerm, data.fromSection, toSection);
                } catch (err) {
                    console.error('Drop error:', err);
                }
            });
        },

        linkedCourseCodesForMove(code, fromSem) {
            const majorCourses = deps.profile().majorData?.required_courses || [];
            const definition = majorCourses.find(item => item.code === code) || {};
            const linked = new Set(definition.corequisites || []);
            DegreePlannerRuntime.corequisiteGroupsForCourse(definition).forEach(group => {
                const candidates = group.courses || [];
                if (group.type === 'or') {
                    const selected = candidates.find(linkedCode => (
                        fromSem.courses.some(item => item.code === linkedCode)
                    ));
                    if (selected) linked.add(selected);
                } else candidates.forEach(linkedCode => linked.add(linkedCode));
            });
            if (/\d{3}L$/.test(code)) linked.add(code.slice(0, -1));
            else if (/\d{3}$/.test(code)) linked.add(`${code}L`);
            majorCourses.forEach(item => {
                if ((item.corequisites || []).includes(code)) linked.add(item.code);
                if (DegreePlannerRuntime.corequisiteGroupsForCourse(item)
                    .some(group => (group.courses || []).includes(code))) linked.add(item.code);
            });
            return new Set([code, ...[...linked].filter(linkedCode => (
                fromSem.courses.some(item => item.code === linkedCode)
            ))]);
        },

        validatePlannedMove(code, fromTerm, toTerm) {
            const semesters = deps.plan().semesters || [];
            const fromSem = semesters.find(semester => semester.term === fromTerm);
            const toSem = semesters.find(semester => semester.term === toTerm);
            if (!fromSem || !toSem) return { valid: false, reason: 'missing_semester' };
            const definitions = deps.profile().majorData?.required_courses || [];
            const definitionsByCode = new Map(definitions.map(course => [course.code, course]));
            const movedCodes = this.linkedCourseCodesForMove(code, fromSem);
            const termByCode = new Map();
            semesters.forEach(semester => {
                semester.courses.forEach(course => termByCode.set(course.code, String(semester.term)));
            });
            movedCodes.forEach(movedCode => termByCode.set(movedCode, String(toTerm)));

            const affected = new Set(movedCodes);
            definitions.forEach(definition => {
                const groups = DegreePlannerRuntime.requirementGroupsForCourse(definition);
                if (groups.some(group => (group.courses || []).some(required => movedCodes.has(required)))) {
                    affected.add(definition.code);
                }
            });

            for (const affectedCode of affected) {
                const definition = definitionsByCode.get(affectedCode) || {};
                const targetTerm = termByCode.get(affectedCode);
                if (!targetTerm) continue;
                const priorTerms = new Set(deps.completedCourses() || []);
                termByCode.forEach((term, plannedCode) => {
                    if (term < targetTerm) priorTerms.add(plannedCode);
                });
                const groups = DegreePlannerRuntime.requirementGroupsForCourse(definition);
                const requirementStatus = DegreePlannerRuntime.evaluateRequirementGroups(groups, priorTerms);
                if (!requirementStatus.eligible) {
                    return {
                        valid: false,
                        reason: affectedCode === code ? 'prerequisite' : 'dependent',
                        course: affectedCode,
                        missing: requirementStatus.missing,
                    };
                }

                const plannedCourse = semesters
                    .flatMap(semester => semester.courses)
                    .find(course => course.code === affectedCode) || {};
                const restriction = definition.offering_restriction || plannedCourse.offering_restriction;
                const destination = semesters.find(semester => String(semester.term) === targetTerm);
                const destinationLabel = String(destination?.label || '').toLowerCase();
                if ((restriction === 'fall_only' && !destinationLabel.startsWith('fall'))
                    || (restriction === 'spring_only' && !destinationLabel.startsWith('spring'))) {
                    return {
                        valid: false,
                        reason: 'offering',
                        course: affectedCode,
                        restriction,
                    };
                }
            }
            return { valid: true, movedCodes };
        },

        moveCourse(code, fromTerm, toTerm, fromSection, toSection) {
            const fromList = fromSection === 'completed' ? deps.plan().completedSemesters : deps.plan().semesters;
            const toList = toSection === 'completed' ? deps.plan().completedSemesters : deps.plan().semesters;

            const fromSem = fromList.find(s => s.term === fromTerm);
            const toSem = toList.find(s => s.term === toTerm);

            if (!fromSem || !toSem) return;

            const courseIdx = fromSem.courses.findIndex(c => c.code === code);
            if (courseIdx < 0) return;

            const course = fromSem.courses[courseIdx];

            if (fromSection === 'planned' && toSection === 'planned') {
                const validation = this.validatePlannedMove(code, fromTerm, toTerm);
                if (!validation.valid && validation.reason === 'dependent') {
                    alert(`${code} cannot be moved to ${toSem.label} because ${validation.course} requires it first.`);
                    return;
                }
                if (!validation.valid && validation.reason === 'prerequisite') {
                    alert(`${code} cannot be moved to ${toSem.label}. Complete ${validation.missing.join(' or ')} first.`);
                    return;
                }
                if (!validation.valid && validation.reason === 'offering') {
                    alert(`${validation.course} is marked ${validation.restriction === 'fall_only' ? 'Fall only' : 'Spring only'} and cannot be placed in ${toSem.label}.`);
                    return;
                }
                if (!validation.valid) return;
            }

            fromSem.courses.splice(courseIdx, 1);
            fromSem.total_credits -= course.credits;
            toSem.courses.push(course);
            toSem.total_credits += course.credits;

            if (fromSection === 'planned' && toSection === 'planned') {
                const linked = this.linkedCourseCodesForMove(code, fromSem);
                linked.delete(code);
                linked.forEach(linkedCode => {
                    const index = fromSem.courses.findIndex(item => item.code === linkedCode);
                    if (index < 0) return;
                    const [linkedCourse] = fromSem.courses.splice(index, 1);
                    fromSem.total_credits -= linkedCourse.credits;
                    toSem.courses.push(linkedCourse);
                    toSem.total_credits += linkedCourse.credits;
                    deps.plan().pins[linkedCode] = toTerm;
                });
            }

            if (toSection === 'planned') {
                deps.plan().pins[code] = toTerm;
            }

            this.render();
        },};

        return feature;
    }

    return { createDegreePlanFeature };
}));

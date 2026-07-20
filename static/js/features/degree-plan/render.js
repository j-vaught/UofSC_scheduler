/*
 * Rendering the sidebar, semester columns, and warnings.
 *
 * One part of the degree-plan feature, which was a single module of over two
 * thousand lines. Each part is a factory returning plain methods; index.js
 * merges them onto one object, so `this` still reaches every method and no
 * call site changed.
 *
 * Cut at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly.
 */
(function initRenderPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.DegreePlanParts) root.DegreePlanParts = {};
    root.DegreePlanParts.createRenderPart = api.createRenderPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createRenderPart(deps) {
        return {
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

        };
    }

    return { createRenderPart };
}));

/*
 * Completed-coursework controls and requirement selection.
 *
 * One part of the degree-plan feature, which was a single module of over two
 * thousand lines. Each part is a factory returning plain methods; index.js
 * merges them onto one object, so `this` still reaches every method and no
 * call site changed.
 *
 * Cut at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly.
 */
(function initCourseworkPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.DegreePlanParts) root.DegreePlanParts = {};
    root.DegreePlanParts.createCourseworkPart = api.createCourseworkPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createCourseworkPart(deps) {
        return {
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

        };
    }

    return { createCourseworkPart };
}));

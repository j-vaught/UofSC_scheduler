/* Degree Plan tab: multi-semester course roadmap */
const DegreePlan = {
    init() {
        this.bindGenerateButton();
        this.bindDragDrop();

        State.on('profile-updated', () => this.updateSidebar());
        State.on('transcript-updated', () => {
            this.buildCompletedSemesters();
            this.updateSidebar();
            this.render();
        });
        State.on('degree-plan-updated', () => {
            this.buildCompletedSemesters();
            this.render();
        });

        if (State.degreePlan.semesters.length > 0) {
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
        const majorData = State.profile.majorData;
        if (!majorData) {
            alert('Choose your major and catalog year above before generating a plan.');
            return;
        }

        if (State.completedCourses.length === 0) {
            if (!confirm('No completed courses entered. Generate plan as a new student?')) {
                return;
            }
        }

        const btn = document.getElementById('btn-generate-plan');
        btn.textContent = 'GENERATING...';
        btn.disabled = true;

        try {
            const enrichedMajorData = typeof Prereqs !== 'undefined' && Prereqs.enrichMajorMap
                ? await Prereqs.enrichMajorMap(majorData)
                : majorData;
            State.profile.majorData = enrichedMajorData;
            const plan = await API.getDegreePlan({
                map_id: State.profile.major,
                major_map: enrichedMajorData,
                completed: State.completedCourses,
                mode: State.profile.planMode,
                pins: State.degreePlan.pins || {},
                start_term: State.term || '202608',
                include_summer: State.profile.includeSummer,
                custom_credits: State.profile.planMode === 'custom' ? State.profile.customCredits : null,
                concentration: State.profile.concentration,
                strategy: State.profile.degreeStrategy || 'major_map',
            });

            if (plan.error) {
                alert('Error: ' + plan.error);
                return;
            }

            State.degreePlan.semesters = plan.semesters || [];
            State.degreePlan.warnings = plan.warnings || [];
            State.degreePlan.totalRemaining = plan.total_credits_remaining || 0;
            State.degreePlan.completedCredits = plan.completed_credits || 0;
            State.degreePlan.estimatedGraduation = plan.estimated_graduation || '';
            State.degreePlan.categories = plan.categories || {};

            // Auto-collapse completed section after generating
            State.degreePlan.completedCollapsed = true;

            State.emit('degree-plan-updated');
        } catch (e) {
            console.error('Degree plan generation failed:', e);
            alert('Failed to generate degree plan. Please try again.');
        } finally {
            btn.textContent = 'GENERATE DEGREE PLAN';
            btn.disabled = false;
        }
    },

    // Build completed semester columns from State.completedCourses + completedDetails
    buildCompletedSemesters() {
        const majorData = State.profile.majorData;
        if (!majorData) return;

        // Group completed courses by their typical semester
        const semMap = {};
        const completed = State.completedCourses;

        // If there are existing completed semesters with courses, preserve their assignment
        const existingAssignments = {};
        (State.degreePlan.completedSemesters || []).forEach(sem => {
            sem.courses.forEach(c => { existingAssignments[c.code] = sem.term; });
        });

        // Build a mapping of typical_year + semester -> past term code
        // Work backwards from the current term
        const currentTerm = State.term || '202608';
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
            const detail = State.completedDetails.find(d => d.code === code);

            let termKey, termLabel, semType;
            if (existingAssignments[code]) {
                termKey = existingAssignments[code];
                const existing = (State.degreePlan.completedSemesters || []).find(s => s.term === termKey);
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

        State.degreePlan.completedSemesters = sorted;
    },

    updateSidebar() {
        const majorData = State.profile.majorData;
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
            modeLabel.textContent = `Mode: ${modeNames[State.profile.planMode] || State.profile.planMode}`;
        }

        const totalRequired = majorData.total_credits_required;
        const completed = State.degreePlan.completedCredits || this.estimateCompletedCredits();
        const pct = Math.min(100, Math.round((completed / totalRequired) * 100));

        document.getElementById('progress-overall-fill').style.width = pct + '%';
        document.getElementById('progress-overall-text').textContent = `${completed} / ${totalRequired} credits (${pct}%)`;

        const categories = majorData.category_labels || {};
        const catData = State.degreePlan.categories || {};

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

    renderMapContext(majorData) {
        const context = document.getElementById('degree-map-context');
        if (!context) return;
        if (!majorData) {
            context.hidden = true;
            context.replaceChildren();
            return;
        }

        const indexEntry = Profile.majorMaps?.find(map => map.id === State.profile.major) || {};
        const map = { ...indexEntry, ...majorData };
        const title = document.createElement('strong');
        title.textContent = `${map.major} — ${map.program}`;
        const year = document.createElement('span');
        year.textContent = Profile.catalogYearLabel(map);
        const sourceUrl = Profile.sourceUrl(map);
        const source = document.createElement(sourceUrl ? 'a' : 'span');
        source.textContent = Profile.sourceLabel(map);
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
        const majorData = State.profile.majorData;
        State.completedCourses.forEach(code => {
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
        const plannedSemesters = State.degreePlan.semesters;
        const completedSemesters = State.degreePlan.completedSemesters || [];

        if (plannedSemesters.length === 0 && completedSemesters.length === 0) {
            container.innerHTML = '<p class="hint" style="padding:20px">Set up your profile and click "Generate Degree Plan" to see your semester-by-semester course plan.</p>';
            warningsEl.innerHTML = '';
            return;
        }

        this.renderWarnings(warningsEl);

        let html = '';

        // Completed section
        if (completedSemesters.length > 0) {
            const collapsed = State.degreePlan.completedCollapsed;
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
        if (State.degreePlan.estimatedGraduation) {
            html += `
                <div class="semester-column graduation-column">
                    <div class="semester-header graduation-header">GRADUATION</div>
                    <div class="graduation-content">
                        <div class="graduation-icon">&#127891;</div>
                        <div class="graduation-text">${State.degreePlan.estimatedGraduation}</div>
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
        const warnings = State.degreePlan.warnings;
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
                State.degreePlan.completedCollapsed = !State.degreePlan.completedCollapsed;
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
                        const data = await API.bulletinSearch(subj);
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
                    if (!State.completedCourses.includes(code)) {
                        State.completedCourses.push(code);
                        const majorData = State.profile.majorData;
                        const mc = majorData ? majorData.required_courses.find(c => c.code === code) : null;
                        State.completedDetails.push({ code, grade: null, credits: mc ? mc.credits : 3, semester: null });
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
                    Profile.renderCompletedChips();
                    Profile.renderCreditSummary();
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
                State.completedCourses = State.completedCourses.filter(c => c !== code);
                State.completedDetails = State.completedDetails.filter(c => c.code !== code);
                this.buildCompletedSemesters();
                this.render();
                if (typeof Profile !== 'undefined') {
                    Profile.renderCompletedChips();
                    Profile.renderCreditSummary();
                }
            });
        });

        // Delete empty completed semesters
        document.querySelectorAll('.sem-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const term = btn.dataset.term;
                State.degreePlan.completedSemesters = (State.degreePlan.completedSemesters || []).filter(s => s.term !== term);
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
            if (!State.degreePlan.completedSemesters) State.degreePlan.completedSemesters = [];
            const exists = State.degreePlan.completedSemesters.find(s => s.term === termCode);
            if (exists) {
                modal.classList.add('hidden');
                return;
            }

            State.degreePlan.completedSemesters.push({
                term: termCode,
                label: label,
                courses: [],
                total_credits: 0,
                type: 'completed',
            });

            // Sort
            State.degreePlan.completedSemesters.sort((a, b) => a.term.localeCompare(b.term));

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
                    if (State.degreePlan.pins[code]) {
                        delete State.degreePlan.pins[code];
                    } else {
                        State.degreePlan.pins[code] = term;
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
                const course = State.profile.majorData?.required_courses?.find(item => item.code === code) || { code };
                Scheduler.openCourseQuickView({
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
        const sem = State.degreePlan.semesters.find(s => s.term === term);
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
                Tabs.switchTo('semester');
                const input = Search.activeSearchInput();
                if (input) input.value = course.title;
                Search.doSearch();
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
                const semData = State.degreePlan.semesters.find(s => s.term === targetTerm);
                if (semData) {
                    const idx = semData.courses.findIndex(c => c.code === groupId);
                    if (idx >= 0) {
                        semData.courses[idx] = {
                            code: code, title: code,
                            credits: semData.courses[idx].credits,
                            category: semData.courses[idx].category,
                            pinned: true, is_elective_slot: false,
                        };
                        State.degreePlan.pins[code] = targetTerm;
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
                    const analysis = await API.getOfferingAnalysis(code, State.term);
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
        const semester = State.degreePlan.semesters.find(item => item.term === term);
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
        State.degreePlan.pins[selected.code] = term;
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
        const majorCourses = State.profile.majorData?.required_courses || [];
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
        const semesters = State.degreePlan.semesters || [];
        const fromSem = semesters.find(semester => semester.term === fromTerm);
        const toSem = semesters.find(semester => semester.term === toTerm);
        if (!fromSem || !toSem) return { valid: false, reason: 'missing_semester' };
        const definitions = State.profile.majorData?.required_courses || [];
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
            const priorTerms = new Set(State.completedCourses || []);
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
        const fromList = fromSection === 'completed' ? State.degreePlan.completedSemesters : State.degreePlan.semesters;
        const toList = toSection === 'completed' ? State.degreePlan.completedSemesters : State.degreePlan.semesters;

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
                State.degreePlan.pins[linkedCode] = toTerm;
            });
        }

        if (toSection === 'planned') {
            State.degreePlan.pins[code] = toTerm;
        }

        this.render();
    },
};

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
                const instructor = section.instr && section.instr !== 'Staff' ? section.instr : 'Undecided';
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

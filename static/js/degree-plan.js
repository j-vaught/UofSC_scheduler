/* Degree Plan tab: multi-semester course roadmap */
const DegreePlan = {
    init() {
        this.bindGenerateButton();
        this.bindDragDrop();

        State.on('profile-updated', () => this.updateSidebar());
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
            alert('Please select a major in the Profile tab first.');
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
            const resp = await fetch('/api/degree-plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    map_id: State.profile.major,
                    completed: State.completedCourses,
                    mode: State.profile.planMode,
                    pins: State.degreePlan.pins || {},
                    start_term: State.term || '202608',
                    include_summer: State.profile.includeSummer,
                    custom_credits: State.profile.planMode === 'custom' ? State.profile.customCredits : null,
                    concentration: State.profile.concentration,
                })
            });

            const plan = await resp.json();

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
            alert('Failed to generate degree plan. Is the server running?');
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

        if (!majorData) {
            list.innerHTML = '<p class="hint">Select a major in the Profile tab to see requirements.</p>';
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
                <div class="completed-collapse-bar" id="completed-toggle">
                    <span class="completed-collapse-arrow">${collapsed ? '&#9654;' : '&#9660;'}</span>
                    <span class="completed-collapse-label">COMPLETED: ${totalCompCredits} credits (${totalCompCourses} courses) across ${completedSemesters.length} semester${completedSemesters.length !== 1 ? 's' : ''}</span>
                </div>
            `;

            if (!collapsed) {
                html += '<div class="completed-columns">';

                // Add Semester button
                html += `
                    <div class="add-semester-btn" id="btn-add-completed-sem">
                        <span>+</span>
                        <span style="font-size:0.7rem">ADD<br>SEMESTER</span>
                    </div>
                `;

                completedSemesters.forEach((sem, idx) => {
                    html += this.renderCompletedColumn(sem, idx);
                });

                html += '</div>';

                // Add course input
                html += `
                    <div class="completed-add-course">
                        <input type="text" id="completed-add-input" placeholder="Add courses: CSCE 145, MATH 141, ...">
                        <button id="btn-add-completed" class="btn-garnet">ADD</button>
                    </div>
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
                        <span class="course-card-code">${course.code}</span>
                        <span class="card-remove-badge" data-code="${course.code}">REMOVE</span>
                    </div>
                    <div class="course-card-title">${course.title} <span class="course-card-credits">${course.credits} cr</span></div>
                </div>
            `;
        });

        const deleteBtn = sem.courses.length === 0
            ? `<span class="sem-delete-btn" data-term="${sem.term}" title="Delete semester">&times;</span>`
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
                        <span class="course-card-credits">${course.credits} cr</span>
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
        if (addBtn && addInput) {
            const doAdd = () => {
                const text = addInput.value.trim();
                if (!text) return;
                // Parse with same flexible format
                const codes = text.split(/[,;.\n]+/).map(s => {
                    const m = s.trim().match(/([A-Za-z]{3,4})\s*(\d{3}[A-Za-z]?)/);
                    return m ? m[1].toUpperCase() + ' ' + m[2].toUpperCase() : null;
                }).filter(Boolean);

                codes.forEach(code => {
                    if (!State.completedCourses.includes(code)) {
                        State.completedCourses.push(code);
                        const majorData = State.profile.majorData;
                        const mc = majorData ? majorData.required_courses.find(c => c.code === code) : null;
                        State.completedDetails.push({ code, grade: null, credits: mc ? mc.credits : 3, semester: null });
                    }
                });

                addInput.value = '';
                this.buildCompletedSemesters();
                this.render();
                if (typeof Profile !== 'undefined') {
                    Profile.renderCompletedChips();
                    Profile.renderCreditSummary();
                }
            };
            addBtn.addEventListener('click', doAdd);
            addInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') doAdd();
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
    },

    async openElectivePicker(card) {
        const groupId = card.dataset.code;
        const term = card.dataset.semester;
        const sem = State.degreePlan.semesters.find(s => s.term === term);
        if (!sem) return;

        const course = sem.courses.find(c => c.code === groupId);
        if (!course || !course.options || course.options.length === 0) {
            alert('No specific options listed for this elective group. Choose any course that satisfies: ' + (course.title || groupId));
            return;
        }

        const modal = document.getElementById('modal-overlay');
        const content = document.getElementById('modal-content');

        let optionsHtml = `<h2>Choose an Elective</h2><p>${course.title}</p><div class="elective-options">`;
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
                    const resp = await fetch('/api/offering-analysis', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ code: code, current_term: State.term })
                    });
                    const analysis = await resp.json();
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

    moveCourse(code, fromTerm, toTerm, fromSection, toSection) {
        const fromList = fromSection === 'completed' ? State.degreePlan.completedSemesters : State.degreePlan.semesters;
        const toList = toSection === 'completed' ? State.degreePlan.completedSemesters : State.degreePlan.semesters;

        const fromSem = fromList.find(s => s.term === fromTerm);
        const toSem = toList.find(s => s.term === toTerm);

        if (!fromSem || !toSem) return;

        const courseIdx = fromSem.courses.findIndex(c => c.code === code);
        if (courseIdx < 0) return;

        const course = fromSem.courses[courseIdx];

        fromSem.courses.splice(courseIdx, 1);
        fromSem.total_credits -= course.credits;
        toSem.courses.push(course);
        toSem.total_credits += course.credits;

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
        if (!list) return;

        const sections = State.selectedSections;
        const codes = Object.keys(sections);

        if (codes.length === 0) {
            list.innerHTML = '<p class="hint">Add courses from the Browse tab to build your schedule.</p>';
            if (creditsEl) creditsEl.textContent = '';
            return;
        }

        let html = '';
        let totalCredits = 0;

        codes.forEach(code => {
            const sec = sections[code];
            const title = sec.title || code;
            const instr = (sec.instr && sec.instr !== 'Staff') ? sec.instr : 'Undecided';
            const meets = sec.meets || 'TBA';

            html += `
                <div class="selected-course-item">
                    <div class="selected-course-header">
                        <strong>${code}</strong>
                        <button class="btn-remove" data-code="${code}">&times;</button>
                    </div>
                    <div class="selected-course-detail">${title}</div>
                    <div class="selected-course-detail">${sec.section || ''} &bull; ${instr} &bull; ${meets}</div>
                </div>
            `;
            totalCredits += parseInt(sec.hours || '3', 10);
        });

        list.innerHTML = html;
        if (creditsEl) creditsEl.textContent = `${totalCredits} credits selected`;

        list.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                State.removeSection(btn.dataset.code);
            });
        });
    },
};

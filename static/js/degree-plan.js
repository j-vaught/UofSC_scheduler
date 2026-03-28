/* Degree Plan tab: multi-semester course roadmap */
const DegreePlan = {
    init() {
        this.bindGenerateButton();
        this.bindDragDrop();

        State.on('profile-updated', () => this.updateSidebar());
        State.on('degree-plan-updated', () => this.render());

        // Initial render if data exists
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

            State.emit('degree-plan-updated');
        } catch (e) {
            console.error('Degree plan generation failed:', e);
            alert('Failed to generate degree plan. Is the server running?');
        } finally {
            btn.textContent = 'GENERATE DEGREE PLAN';
            btn.disabled = false;
        }
    },

    updateSidebar() {
        const majorData = State.profile.majorData;
        const list = document.getElementById('degree-requirements-list');
        const modeLabel = document.getElementById('plan-mode-label');

        if (!majorData) {
            list.innerHTML = '<p class="hint">Select a major in the Profile tab to see requirements.</p>';
            return;
        }

        // Mode label
        const modeNames = {
            'full_time': 'Full-Time (~15 cr/sem)',
            'scholarship': 'Scholarship (30 cr/yr)',
            'part_time': 'Part-Time (6-9 cr/sem)',
            'custom': 'Custom',
        };
        if (modeLabel) {
            modeLabel.textContent = `Mode: ${modeNames[State.profile.planMode] || State.profile.planMode}`;
        }

        // Overall progress
        const totalRequired = majorData.total_credits_required;
        const completed = State.degreePlan.completedCredits || this.estimateCompletedCredits();
        const pct = Math.min(100, Math.round((completed / totalRequired) * 100));

        document.getElementById('progress-overall-fill').style.width = pct + '%';
        document.getElementById('progress-overall-text').textContent = `${completed} / ${totalRequired} credits (${pct}%)`;

        // Requirements by category
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
        const semesters = State.degreePlan.semesters;

        if (!semesters || semesters.length === 0) {
            container.innerHTML = '<p class="hint" style="padding:20px">Set up your profile and click "Generate Degree Plan" to see your semester-by-semester course plan.</p>';
            warningsEl.innerHTML = '';
            return;
        }

        // Render warnings
        this.renderWarnings(warningsEl);

        // Render semester columns
        let html = '';
        semesters.forEach((sem, idx) => {
            html += this.renderSemesterColumn(sem, idx);
        });

        // Add graduation marker
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

        container.innerHTML = html;

        // Bind course card interactions
        this.bindCourseCards();
        this.updateSidebar();
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
                <div class="${cardClass}" data-code="${course.code}" data-semester="${sem.term}" draggable="${!isElective}">
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
            <div class="${semClass}${creditWarning}" data-term="${sem.term}" data-index="${idx}">
                <div class="semester-header">
                    <span class="semester-label">${sem.label}</span>
                    <span class="semester-credits">${sem.total_credits} cr</span>
                </div>
                <div class="semester-courses" data-term="${sem.term}">
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

    bindCourseCards() {
        // Click to view details / pin/unpin
        document.querySelectorAll('#semester-columns .course-card').forEach(card => {
            card.addEventListener('click', (e) => {
                const code = card.dataset.code;
                const term = card.dataset.semester;

                if (card.classList.contains('elective-slot')) {
                    this.openElectivePicker(card);
                    return;
                }

                // Toggle pin
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
        const groupId = card.dataset.code; // The "[label]" placeholder
        // Find the elective group data from the semester courses
        const term = card.dataset.semester;
        const sem = State.degreePlan.semesters.find(s => s.term === term);
        if (!sem) return;

        const course = sem.courses.find(c => c.code === groupId);
        if (!course || !course.options || course.options.length === 0) {
            alert('No specific options listed for this elective group. Choose any course that satisfies: ' + (course.title || groupId));
            return;
        }

        // Show modal with options
        const modal = document.getElementById('modal-overlay');
        const content = document.getElementById('modal-content');

        let optionsHtml = `<h2>Choose an Elective</h2><p>${course.title}</p><div class="elective-options">`;

        for (const opt of course.options.slice(0, 20)) {
            // Fetch offering analysis
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

        // Bind select buttons
        content.querySelectorAll('.elective-select-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const code = btn.dataset.code;
                const targetTerm = btn.dataset.term;
                // Replace the placeholder in the semester
                const semData = State.degreePlan.semesters.find(s => s.term === targetTerm);
                if (semData) {
                    const idx = semData.courses.findIndex(c => c.code === groupId);
                    if (idx >= 0) {
                        semData.courses[idx] = {
                            code: code,
                            title: code,
                            credits: semData.courses[idx].credits,
                            category: semData.courses[idx].category,
                            pinned: true,
                            is_elective_slot: false,
                        };
                        State.degreePlan.pins[code] = targetTerm;
                    }
                }
                modal.classList.add('hidden');
                this.render();
            });
        });

        // Bind history buttons
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
        // Use event delegation on the semester columns container
        const container = document.getElementById('semester-columns');
        if (!container) return;

        container.addEventListener('dragstart', (e) => {
            const card = e.target.closest('.course-card');
            if (!card || card.classList.contains('elective-slot')) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.setData('text/plain', JSON.stringify({
                code: card.dataset.code,
                fromTerm: card.dataset.semester,
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

                if (data.fromTerm === toTerm) return;

                this.moveCourse(data.code, data.fromTerm, toTerm);
            } catch (err) {
                console.error('Drop error:', err);
            }
        });
    },

    moveCourse(code, fromTerm, toTerm) {
        const semesters = State.degreePlan.semesters;
        const fromSem = semesters.find(s => s.term === fromTerm);
        const toSem = semesters.find(s => s.term === toTerm);

        if (!fromSem || !toSem) return;

        const courseIdx = fromSem.courses.findIndex(c => c.code === code);
        if (courseIdx < 0) return;

        const course = fromSem.courses[courseIdx];

        // Move it
        fromSem.courses.splice(courseIdx, 1);
        fromSem.total_credits -= course.credits;
        toSem.courses.push(course);
        toSem.total_credits += course.credits;

        // Pin it to the new semester
        State.degreePlan.pins[code] = toTerm;

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
            list.innerHTML = '<p class="hint">Add courses from the Semester tab to build your schedule.</p>';
            if (creditsEl) creditsEl.textContent = '';
            return;
        }

        let html = '';
        let totalCredits = 0;

        codes.forEach(code => {
            const sec = sections[code];
            const title = sec.title || code;
            const instr = sec.instr || 'TBA';
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

        // Bind remove buttons
        list.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                State.removeSection(btn.dataset.code);
            });
        });
    },
};

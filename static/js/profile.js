/* Profile tab: major selection, transcript entry, planning preferences */
const Profile = {
    init() {
        this.loadMajorMaps();
        this.bindMajorSelect();
        this.bindTranscript();
        this.bindPlanMode();
        this.renderCompletedChips();
        this.renderCreditSummary();
    },

    async loadMajorMaps() {
        try {
            const resp = await fetch('/api/major-maps');
            const maps = await resp.json();
            const select = document.getElementById('major-select');
            maps.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = `${m.major} — ${m.program} (${m.catalog_year})`;
                select.appendChild(opt);
            });

            // Restore saved selection
            if (State.profile.major) {
                select.value = State.profile.major;
                this.onMajorChange(State.profile.major);
            }
        } catch (e) {
            console.error('Failed to load major maps:', e);
        }
    },

    bindMajorSelect() {
        const majorSel = document.getElementById('major-select');
        const concSel = document.getElementById('concentration-select');

        majorSel.addEventListener('change', () => {
            this.onMajorChange(majorSel.value);
        });

        concSel.addEventListener('change', () => {
            State.profile.concentration = concSel.value;
            State.emit('profile-updated');
        });
    },

    async onMajorChange(mapId) {
        if (!mapId) {
            State.profile.major = null;
            State.profile.majorData = null;
            document.getElementById('major-summary').innerHTML = '';
            return;
        }

        try {
            const resp = await fetch('/api/major-map', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: mapId })
            });
            const data = await resp.json();
            State.profile.major = mapId;
            State.profile.majorData = data;

            // Populate concentrations
            const concSel = document.getElementById('concentration-select');
            concSel.innerHTML = '';
            const concs = data.concentrations || {};
            for (const [key, val] of Object.entries(concs)) {
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = val.label;
                concSel.appendChild(opt);
            }
            if (State.profile.concentration && concs[State.profile.concentration]) {
                concSel.value = State.profile.concentration;
            }

            // Show summary
            const summary = document.getElementById('major-summary');
            summary.innerHTML = `
                <div class="summary-item"><strong>${data.major}</strong> — ${data.program}</div>
                <div class="summary-item">${data.college}</div>
                <div class="summary-item">${data.total_credits_required} credits required</div>
                <div class="summary-item">Catalog: ${data.catalog_year}</div>
            `;

            this.renderCreditSummary();
            State.emit('profile-updated');
        } catch (e) {
            console.error('Failed to load major map:', e);
        }
    },

    bindTranscript() {
        // Parse button
        document.getElementById('btn-parse-transcript').addEventListener('click', () => {
            const text = document.getElementById('transcript-input').value.trim();
            if (!text) return;
            this.parseAndAddCourses(text);
            document.getElementById('transcript-input').value = '';
        });

        // Also allow Enter key in textarea with Ctrl/Cmd
        document.getElementById('transcript-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                document.getElementById('btn-parse-transcript').click();
            }
        });

        // CSV upload
        document.getElementById('csv-upload').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const resp = await fetch('/api/parse-transcript', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ csv: ev.target.result })
                    });
                    const data = await resp.json();
                    if (data.courses) {
                        data.courses.forEach(c => {
                            if (!State.completedCourses.includes(c.code)) {
                                State.completedCourses.push(c.code);
                                State.completedDetails.push(c);
                            }
                        });
                        this.renderCompletedChips();
                        this.renderCreditSummary();
                        State.emit('profile-updated');
                    }
                } catch (err) {
                    console.error('CSV parse error:', err);
                }
            };
            reader.readAsText(file);
            e.target.value = ''; // Reset input
        });
    },

    async parseAndAddCourses(text) {
        try {
            const resp = await fetch('/api/parse-transcript', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text })
            });
            const data = await resp.json();
            if (data.courses) {
                data.courses.forEach(c => {
                    if (!State.completedCourses.includes(c.code)) {
                        State.completedCourses.push(c.code);
                        State.completedDetails.push(c);
                    }
                });
                this.renderCompletedChips();
                this.renderCreditSummary();
                State.emit('profile-updated');
            }
        } catch (e) {
            console.error('Parse error:', e);
        }
    },

    renderCompletedChips() {
        const container = document.getElementById('completed-chips');
        if (!container) return;
        container.innerHTML = '';

        if (State.completedCourses.length === 0) {
            container.innerHTML = '<p class="hint">No courses added yet.</p>';
            return;
        }

        // Sort alphabetically
        const sorted = [...State.completedCourses].sort();
        sorted.forEach(course => {
            const chip = document.createElement('span');
            chip.className = 'completed-chip';
            chip.innerHTML = `${course} <span class="remove">&times;</span>`;
            chip.querySelector('.remove').addEventListener('click', () => {
                State.completedCourses = State.completedCourses.filter(c => c !== course);
                State.completedDetails = State.completedDetails.filter(c => c.code !== course);
                this.renderCompletedChips();
                this.renderCreditSummary();
                State.emit('profile-updated');
            });
            container.appendChild(chip);
        });
    },

    renderCreditSummary() {
        const el = document.getElementById('credit-summary');
        if (!el) return;

        const totalCompleted = State.completedCourses.length;
        const majorData = State.profile.majorData;

        if (!majorData) {
            el.innerHTML = `<strong>${totalCompleted}</strong> courses entered`;
            return;
        }

        // Estimate credits (3 per course if no detail data)
        let creditsDone = 0;
        State.completedDetails.forEach(c => {
            creditsDone += c.credits || 3;
        });
        // For courses without details, assume 3 credits
        const detailedCodes = new Set(State.completedDetails.map(c => c.code));
        State.completedCourses.forEach(code => {
            if (!detailedCodes.has(code)) {
                // Check major map for credits
                const mapCourse = majorData.required_courses.find(c => c.code === code);
                creditsDone += mapCourse ? mapCourse.credits : 3;
            }
        });

        const totalRequired = majorData.total_credits_required;
        const remaining = Math.max(0, totalRequired - creditsDone);

        el.innerHTML = `
            <strong>${creditsDone}</strong> credits completed &bull;
            <strong>${remaining}</strong> credits remaining &bull;
            <strong>${totalRequired}</strong> total required
        `;
    },

    bindPlanMode() {
        document.querySelectorAll('input[name="plan-mode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                State.profile.planMode = e.target.value;
                const customPanel = document.getElementById('custom-credits-panel');
                if (e.target.value === 'custom') {
                    customPanel.classList.remove('hidden');
                } else {
                    customPanel.classList.add('hidden');
                }
                this.checkScholarshipWarning();
                State.emit('profile-updated');
            });
        });

        // Custom credit inputs
        ['custom-min', 'custom-max', 'custom-target'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => {
                    State.profile.customCredits = {
                        min: parseInt(document.getElementById('custom-min').value) || 12,
                        max: parseInt(document.getElementById('custom-max').value) || 18,
                        target: parseInt(document.getElementById('custom-target').value) || 15,
                    };
                });
            }
        });

        // Restore saved mode
        const savedMode = State.profile.planMode;
        const radio = document.querySelector(`input[name="plan-mode"][value="${savedMode}"]`);
        if (radio) radio.checked = true;
        if (savedMode === 'custom') {
            document.getElementById('custom-credits-panel').classList.remove('hidden');
        }

        this.checkScholarshipWarning();
    },

    checkScholarshipWarning() {
        const warning = document.getElementById('scholarship-warning');
        if (!warning) return;
        if (State.profile.planMode === 'scholarship' || State.profile.planMode === 'part_time') {
            warning.classList.remove('hidden');
        } else {
            warning.classList.add('hidden');
        }
    },
};

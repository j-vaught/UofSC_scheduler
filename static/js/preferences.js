/* Preferences UI: time blocking, professor prefs, day toggles */
const Preferences = {
    init() {
        this.buildBlockCalendar();
        this.bindProfPrefs();
        this.bindWeights();
        this.bindTimeWindow();
        this.bindDayToggles();
    },

    buildBlockCalendar() {
        const cal = document.getElementById('block-calendar');
        if (!cal) return;
        cal.innerHTML = '';

        // Header row
        const emptyCorner = document.createElement('div');
        emptyCorner.className = 'block-day-label';
        cal.appendChild(emptyCorner);
        ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].forEach(d => {
            const lbl = document.createElement('div');
            lbl.className = 'block-day-label';
            lbl.textContent = d;
            cal.appendChild(lbl);
        });

        // Time rows (30-min slots from 8am to 9pm)
        for (let h = 8; h < 21; h++) {
            for (let half = 0; half < 2; half++) {
                const min = half * 30;
                const timeVal = h * 100 + min;
                const endVal = min === 0 ? h * 100 + 30 : (h + 1) * 100;

                // Time label
                const label = document.createElement('div');
                label.className = 'block-time-label';
                if (half === 0) {
                    const h12 = h > 12 ? h - 12 : h;
                    label.textContent = `${h12}${h >= 12 ? 'p' : 'a'}`;
                }
                cal.appendChild(label);

                // Day cells
                for (let day = 0; day < 5; day++) {
                    const cell = document.createElement('div');
                    cell.className = 'block-cell';
                    cell.dataset.day = day;
                    cell.dataset.start = timeVal;
                    cell.dataset.end = endVal;

                    if (this.isBlocked(day, timeVal, endVal)) {
                        cell.classList.add('blocked');
                    }

                    cell.addEventListener('click', () => {
                        cell.classList.toggle('blocked');
                        this.updateBlockedTimes();
                    });

                    cell.addEventListener('mousedown', () => { this._dragging = true; this._dragState = !cell.classList.contains('blocked'); });
                    cell.addEventListener('mouseenter', () => {
                        if (this._dragging) {
                            cell.classList.toggle('blocked', this._dragState);
                        }
                    });

                    cal.appendChild(cell);
                }
            }
        }

        document.addEventListener('mouseup', () => {
            if (this._dragging) {
                this._dragging = false;
                this.updateBlockedTimes();
            }
        });
    },

    isBlocked(day, start, end) {
        return State.blockedTimes.some(bt => bt.day === day && bt.start === start && bt.end === end);
    },

    updateBlockedTimes() {
        const cells = document.querySelectorAll('#block-calendar .block-cell.blocked');
        State.blockedTimes = Array.from(cells).map(c => ({
            day: parseInt(c.dataset.day),
            start: parseInt(c.dataset.start),
            end: parseInt(c.dataset.end),
        }));
        State.emit('preferences-changed');
    },

    bindProfPrefs() {
        const btn = document.getElementById('btn-add-prof-pref');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const name = document.getElementById('prof-name-input').value.trim();
            const type = document.getElementById('prof-pref-type').value;
            if (!name) return;

            if (type === 'prefer') {
                State.preferredInstructors[name] = 1;
                delete State.avoidedInstructors[name];
            } else {
                State.avoidedInstructors[name] = 1;
                delete State.preferredInstructors[name];
            }

            document.getElementById('prof-name-input').value = '';
            this.renderProfPrefs();
            State.emit('preferences-changed');
        });
    },

    renderProfPrefs() {
        const list = document.getElementById('prof-prefs-list');
        if (!list) return;
        list.innerHTML = '';

        const all = [
            ...Object.keys(State.preferredInstructors).map(n => ({ name: n, type: 'prefer' })),
            ...Object.keys(State.avoidedInstructors).map(n => ({ name: n, type: 'avoid' })),
        ];

        all.forEach(({ name, type }) => {
            const item = document.createElement('div');
            item.className = 'prof-pref-item';
            item.innerHTML = `
                <span>${name}</span>
                <span style="color:${type === 'prefer' ? '#2e7d32' : '#c62828'}">${type}</span>
                <span class="remove" title="Remove">&times;</span>
            `;
            item.querySelector('.remove').addEventListener('click', () => {
                delete State.preferredInstructors[name];
                delete State.avoidedInstructors[name];
                this.renderProfPrefs();
                State.emit('preferences-changed');
            });
            list.appendChild(item);
        });
    },

    bindWeights() {
        ['gap', 'compact', 'consec'].forEach(w => {
            const slider = document.getElementById(`weight-${w}`);
            const valSpan = document.getElementById(`weight-${w}-val`);
            if (!slider || !valSpan) return;
            slider.addEventListener('input', () => {
                valSpan.textContent = slider.value;
                if (w === 'gap') State.gapWeight = parseFloat(slider.value);
                if (w === 'compact') State.compactWeight = parseFloat(slider.value);
                if (w === 'consec') State.consecWeight = parseFloat(slider.value);
            });
        });
    },

    bindTimeWindow() {
        const startEl = document.getElementById('pref-start');
        const endEl = document.getElementById('pref-end');
        if (startEl) {
            startEl.addEventListener('change', (e) => {
                const [h, m] = e.target.value.split(':').map(Number);
                State.preferredStart = h * 100 + m;
            });
        }
        if (endEl) {
            endEl.addEventListener('change', (e) => {
                const [h, m] = e.target.value.split(':').map(Number);
                State.preferredEnd = h * 100 + m;
            });
        }
    },

    bindDayToggles() {
        const mwfToggle = document.getElementById('pref-mwf');
        const trToggle = document.getElementById('pref-tr');

        if (mwfToggle) {
            mwfToggle.addEventListener('change', () => {
                if (mwfToggle.checked) {
                    if (trToggle) trToggle.checked = false;
                    // Block Tu (1) and Th (3)
                    this.blockEntireDays([1, 3]);
                } else {
                    this.unblockEntireDays([1, 3]);
                }
            });
        }

        if (trToggle) {
            trToggle.addEventListener('change', () => {
                if (trToggle.checked) {
                    if (mwfToggle) mwfToggle.checked = false;
                    // Block Mon (0), Wed (2), Fri (4)
                    this.blockEntireDays([0, 2, 4]);
                } else {
                    this.unblockEntireDays([0, 2, 4]);
                }
            });
        }
    },

    blockEntireDays(days) {
        document.querySelectorAll('#block-calendar .block-cell').forEach(cell => {
            const day = parseInt(cell.dataset.day);
            if (days.includes(day)) {
                cell.classList.add('blocked');
            }
        });
        this.updateBlockedTimes();
    },

    unblockEntireDays(days) {
        document.querySelectorAll('#block-calendar .block-cell').forEach(cell => {
            const day = parseInt(cell.dataset.day);
            if (days.includes(day)) {
                cell.classList.remove('blocked');
            }
        });
        this.updateBlockedTimes();
    },
};

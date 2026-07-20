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
        const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

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
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.className = 'block-cell';
                    cell.dataset.day = day;
                    cell.dataset.start = timeVal;
                    cell.dataset.end = endVal;
                    const startHour = h > 12 ? h - 12 : h;
                    const startLabel = `${startHour}:${String(min).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
                    cell.setAttribute('aria-label', `${dayNames[day]} at ${startLabel}`);

                    if (this.isBlocked(day, timeVal, endVal)) {
                        cell.classList.add('blocked');
                    }
                    cell.setAttribute('aria-pressed', String(cell.classList.contains('blocked')));

                    cell.addEventListener('click', () => {
                        delete cell.dataset.dayPreferenceBlocked;
                        this.setBlockedCell(cell, !cell.classList.contains('blocked'));
                        this.updateBlockedTimes();
                    });

                    cell.addEventListener('mousedown', () => {
                        delete cell.dataset.dayPreferenceBlocked;
                        this._dragging = true;
                        this._dragState = !cell.classList.contains('blocked');
                    });
                    cell.addEventListener('mouseenter', () => {
                        if (this._dragging) {
                            delete cell.dataset.dayPreferenceBlocked;
                            this.setBlockedCell(cell, this._dragState);
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

    setBlockedCell(cell, blocked) {
        if (blocked) cell.classList.add('blocked');
        else cell.classList.remove('blocked');
        cell.setAttribute?.('aria-pressed', String(blocked));
    },

    isBlocked(day, start, end) {
        return State.blockedTimes.some(bt => bt.day === day && bt.start === start && bt.end === end);
    },

    updateBlockedTimes() {
        const cells = document.querySelectorAll('#block-calendar .block-cell.blocked');
        // Field write plus 'preferences-changed', now in one call.
        State.setPreference('blockedTimes', Array.from(cells).map(c => ({
            day: parseInt(c.dataset.day),
            start: parseInt(c.dataset.start),
            end: parseInt(c.dataset.end),
        })));
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
                <button type="button" class="remove" title="Remove ${name}" aria-label="Remove ${name}">&times;</button>
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
                // { event: null } preserves the existing behaviour: these
                // inputs write the field but do not announce it, unlike the
                // blocked-times and instructor controls above.
                State.setPreference('preferredStart', h * 100 + m, { event: null });
            });
        }
        if (endEl) {
            endEl.addEventListener('change', (e) => {
                const [h, m] = e.target.value.split(':').map(Number);
                State.setPreference('preferredEnd', h * 100 + m, { event: null });
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
                    this.setDayPreference([1, 3]);
                } else {
                    this.setDayPreference([]);
                }
            });
        }

        if (trToggle) {
            trToggle.addEventListener('change', () => {
                if (trToggle.checked) {
                    if (mwfToggle) mwfToggle.checked = false;
                    this.setDayPreference([0, 2, 4]);
                } else {
                    this.setDayPreference([]);
                }
            });
        }
    },

    setDayPreference(days) {
        const cells = document.querySelectorAll('#block-calendar .block-cell');

        cells.forEach(cell => {
            if (cell.dataset.dayPreferenceBlocked === 'true') {
                this.setBlockedCell(cell, false);
                delete cell.dataset.dayPreferenceBlocked;
            }
        });

        cells.forEach(cell => {
            const day = parseInt(cell.dataset.day);
            if (days.includes(day) && !cell.classList.contains('blocked')) {
                this.setBlockedCell(cell, true);
                cell.dataset.dayPreferenceBlocked = 'true';
            }
        });
        this.updateBlockedTimes();
    },

    blockEntireDays(days) {
        document.querySelectorAll('#block-calendar .block-cell').forEach(cell => {
            const day = parseInt(cell.dataset.day);
            if (days.includes(day)) {
                this.setBlockedCell(cell, true);
            }
        });
        this.updateBlockedTimes();
    },

    unblockEntireDays(days) {
        document.querySelectorAll('#block-calendar .block-cell').forEach(cell => {
            const day = parseInt(cell.dataset.day);
            if (days.includes(day)) {
                this.setBlockedCell(cell, false);
            }
        });
        this.updateBlockedTimes();
    },
};

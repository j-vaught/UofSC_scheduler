/* Preferences UI: time blocking, professor prefs, completed courses */
const Preferences = {
    init() {
        this.buildBlockCalendar();
        this.bindProfPrefs();
        this.bindWeights();
        this.bindCompletedCourses();
        this.bindTimeWindow();
    },

    buildBlockCalendar() {
        const cal = document.getElementById('block-calendar');
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

                    // Check if already blocked
                    if (this.isBlocked(day, timeVal, endVal)) {
                        cell.classList.add('blocked');
                    }

                    cell.addEventListener('click', () => {
                        cell.classList.toggle('blocked');
                        this.updateBlockedTimes();
                    });

                    // Support click-drag
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
                <span style="color:${type === 'prefer' ? '#4caf50' : '#f44336'}">${type}</span>
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
            slider.addEventListener('input', () => {
                valSpan.textContent = slider.value;
                if (w === 'gap') State.gapWeight = parseFloat(slider.value);
                if (w === 'compact') State.compactWeight = parseFloat(slider.value);
                if (w === 'consec') State.consecWeight = parseFloat(slider.value);
            });
        });
    },

    bindCompletedCourses() {
        const textarea = document.getElementById('completed-courses');
        textarea.addEventListener('change', () => {
            State.completedCourses = textarea.value
                .split(',')
                .map(s => s.trim().toUpperCase())
                .filter(s => s.length > 0);
        });
    },

    bindTimeWindow() {
        document.getElementById('pref-start').addEventListener('change', (e) => {
            const [h, m] = e.target.value.split(':').map(Number);
            State.preferredStart = h * 100 + m;
        });
        document.getElementById('pref-end').addEventListener('change', (e) => {
            const [h, m] = e.target.value.split(':').map(Number);
            State.preferredEnd = h * 100 + m;
        });
    },
};

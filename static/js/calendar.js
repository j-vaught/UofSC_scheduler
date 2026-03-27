/* Weekly calendar grid rendering */
const Calendar = {
    START_HOUR: 8,
    END_HOUR: 21,
    PX_PER_MIN: 1.5,
    COLORS: [
        '#73000A', '#1a4a8a', '#2e7d32', '#e65100', '#4a148c',
        '#00695c', '#bf360c', '#1565c0', '#6a1b9a', '#33691e',
    ],
    _colorMap: {},
    _colorIdx: 0,

    init() {
        this.buildGrid();
        State.on('sections-changed', () => this.render());
    },

    getColor(code) {
        if (!this._colorMap[code]) {
            this._colorMap[code] = this.COLORS[this._colorIdx % this.COLORS.length];
            this._colorIdx++;
        }
        return this._colorMap[code];
    },

    buildGrid() {
        const body = document.getElementById('cal-body');
        body.innerHTML = '';

        // Time labels column
        const totalSlots = this.END_HOUR - this.START_HOUR;
        const gridHeight = totalSlots * 60 * this.PX_PER_MIN;

        // Create time labels
        for (let h = this.START_HOUR; h < this.END_HOUR; h++) {
            const label = document.createElement('div');
            label.className = 'cal-time-slot';
            label.style.position = 'absolute';
            label.style.top = ((h - this.START_HOUR) * 60 * this.PX_PER_MIN) + 'px';
            label.style.left = '0';
            label.style.width = '60px';
            const hour12 = h > 12 ? h - 12 : h;
            const ampm = h >= 12 ? 'p' : 'a';
            label.textContent = `${hour12}${ampm}`;
            body.appendChild(label);
        }

        // Create day columns
        this._dayColumns = [];
        for (let d = 0; d < 5; d++) {
            const col = document.createElement('div');
            col.className = 'cal-day-column';
            col.style.position = 'absolute';
            col.style.left = `calc(60px + ${d} * (100% - 60px) / 5)`;
            col.style.width = `calc((100% - 60px) / 5)`;
            col.style.top = '0';
            col.style.height = gridHeight + 'px';

            // Hour lines
            for (let h = this.START_HOUR; h < this.END_HOUR; h++) {
                const line = document.createElement('div');
                line.className = 'cal-hour-line';
                line.style.top = ((h - this.START_HOUR) * 60 * this.PX_PER_MIN) + 'px';
                col.appendChild(line);
            }

            body.appendChild(col);
            this._dayColumns.push(col);
        }

        body.style.position = 'relative';
        body.style.height = gridHeight + 'px';
    },

    parseMeetingTimes(mt) {
        if (!mt) return [];
        try {
            const raw = typeof mt === 'string' ? JSON.parse(mt) : mt;
            return raw.map(m => ({
                day: parseInt(m.meet_day),
                start: parseInt(m.start_time),
                end: parseInt(m.end_time),
            }));
        } catch (e) {
            return [];
        }
    },

    timeToMinutes(t) {
        const h = Math.floor(t / 100);
        const m = t % 100;
        return h * 60 + m;
    },

    render() {
        // Clear existing blocks
        this._dayColumns.forEach(col => {
            col.querySelectorAll('.cal-block').forEach(b => b.remove());
        });

        const sections = Object.values(State.selectedSections);

        // Check for conflicts
        const allMeetings = [];
        sections.forEach(sec => {
            const times = this.parseMeetingTimes(sec.meetingTimes);
            times.forEach(mt => {
                allMeetings.push({ ...mt, crn: sec.crn, code: sec.code });
            });
        });

        const conflicts = new Set();
        for (let i = 0; i < allMeetings.length; i++) {
            for (let j = i + 1; j < allMeetings.length; j++) {
                const a = allMeetings[i], b = allMeetings[j];
                if (a.day === b.day && a.start < b.end && b.start < a.end) {
                    conflicts.add(a.crn);
                    conflicts.add(b.crn);
                }
            }
        }

        // Render blocks
        sections.forEach(sec => {
            const times = this.parseMeetingTimes(sec.meetingTimes);
            const color = this.getColor(sec.code);
            const hasConflict = conflicts.has(sec.crn);

            times.forEach(mt => {
                if (mt.day < 0 || mt.day > 4) return; // skip Sat/Sun
                const col = this._dayColumns[mt.day];
                const startMin = this.timeToMinutes(mt.start);
                const endMin = this.timeToMinutes(mt.end);
                const top = (startMin - this.START_HOUR * 60) * this.PX_PER_MIN;
                const height = (endMin - startMin) * this.PX_PER_MIN;

                const block = document.createElement('div');
                block.className = 'cal-block' + (hasConflict ? ' conflict' : '');
                block.style.top = top + 'px';
                block.style.height = height + 'px';
                block.style.background = color;

                block.style.color = '#ffffff';
                block.innerHTML = `
                    <div class="block-title">${sec.code}</div>
                    <div class="block-info">${sec.instr || 'Staff'}</div>
                    ${height > 40 ? `<div class="block-info">${sec.meets || ''}</div>` : ''}
                `;

                block.addEventListener('click', () => {
                    showCourseDetail(sec);
                });

                col.appendChild(block);
            });
        });
    },
};

function showCourseDetail(section) {
    const tab = document.getElementById('tab-details');
    tab.innerHTML = `
        <h3>${section.code} - ${section.title}</h3>
        <p><strong>Section:</strong> ${section.section} (CRN: ${section.crn})</p>
        <p><strong>Instructor:</strong> ${section.instr || 'Staff'}</p>
        <p><strong>Meets:</strong> ${section.meets || 'TBA'}</p>
        <p><strong>Method:</strong> ${section.inst_mthd || 'N/A'}</p>
        <p><strong>Status:</strong> ${section.stat === 'A' ? '<span style="color:#2e7d32;font-weight:700">Open</span>' : '<span style="color:#c62828;font-weight:700">Full</span>'}</p>
        <p class="loading">Loading details</p>
    `;

    // Switch to details tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-tab="details"]').classList.add('active');
    tab.classList.add('active');

    // Fetch full details
    API.getDetails(section.crn, State.term).then(data => {
        const seatsMatch = (data.seats || '').match(/seats_avail[^>]*>(\d+)/);
        const maxMatch = (data.seats || '').match(/seats_max[^>]*>(\d+)/);
        const seats = seatsMatch ? seatsMatch[1] : '?';
        const max = maxMatch ? maxMatch[1] : '?';

        // Strip HTML tags from description for clean display
        const desc = (data.description || '').replace(/<[^>]+>/g, ' ').trim();
        const room = (data.meeting_html || '').replace(/<[^>]+>/g, ' ').trim();

        tab.innerHTML = `
            <h3>${section.code} - ${section.title}</h3>
            <p><strong>Section:</strong> ${section.section} (CRN: ${section.crn})</p>
            <p><strong>Instructor:</strong> ${section.instr || 'Staff'}</p>
            <p><strong>Meets:</strong> ${room || section.meets || 'TBA'}</p>
            <p><strong>Credits:</strong> ${data.hours_html || 'N/A'}</p>
            <p><strong>Seats:</strong> <span class="seats-info">${seats} / ${max} available</span></p>
            <p><strong>Method:</strong> ${data.inst_mthd || section.inst_mthd || 'N/A'}</p>
            <p><strong>Campus:</strong> ${data.campus || 'N/A'}</p>
            ${desc ? `<p><strong>Description:</strong> ${desc.substring(0, 300)}${desc.length > 300 ? '...' : ''}</p>` : ''}
            ${data.clssnotes ? `<p><strong>Notes:</strong> ${data.clssnotes.replace(/<[^>]+>/g, ' ').trim()}</p>` : ''}
            <div style="margin-top:8px">
                <button onclick="Prereqs.loadForCourse('${section.code}')">View Prerequisites</button>
                <button onclick="History.loadForCourse('${section.code}')">View History</button>
            </div>
        `;
    }).catch(() => {
        tab.querySelector('.loading')?.remove();
    });
}

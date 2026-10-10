/* Weekly calendar grid rendering */
const Calendar = {
    START_HOUR: 8,
    END_HOUR: 22,
    PX_PER_MIN: 1,
    DAY_LABELS: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    // Brand accents, assigned in order. Garnet is reserved for application
    // chrome and must never identify a course.
    COLORS: [
        '#466A9F', // Atlantic
        '#1F414D', // Congaree
        '#65780B', // Horseshoe
        '#CC2E40', // Rose
        '#A49137', // Honeycomb
    ],
    OVERFLOW_COLOR: '#676156', // Warm Grey, for the sixth course and beyond
    _colorMap: {},
    _colorIdx: 0,

    init() {
        this.buildGrid(5);
        this.setAgendaView(window.matchMedia('(max-width: 480px)').matches);
        document.getElementById('calendar-view-toggle').addEventListener('click', () => {
            this.setAgendaView(!this._agendaView);
            this.render();
        });
        State.on('sections-changed', () => this.render());
        // Paint what is already selected. Subscribing alone was enough while
        // the schedule was always empty at startup; now that State restores a
        // saved schedule before any module initialises, the first change event
        // may never come, and the calendar would sit empty over real data.
        this.render();
        const container = document.getElementById('calendar-container');
        this._sizeObserver = new ResizeObserver(() => {
            if (!container.clientHeight) return;
            const scrollMinutes = container.scrollTop / this.PX_PER_MIN;
            this.render({ sections: this._renderedSections, preview: this._preview });
            container.scrollTop = scrollMinutes * this.PX_PER_MIN;
        });
        this._sizeObserver.observe(container);
    },

    setAgendaView(agenda) {
        this._agendaView = agenda;
        const button = document.getElementById('calendar-view-toggle');
        button.setAttribute('aria-pressed', String(agenda));
        button.textContent = agenda ? 'Weekly view' : 'List view';
        button.title = agenda ? 'Show meetings on the weekly calendar.' : 'Show meetings in a chronological list.';
        document.getElementById('calendar-grid').hidden = agenda;
        document.getElementById('calendar-agenda').hidden = !agenda;
        document.getElementById('calendar-container').scrollTop = 0;
    },

    getColor(code) {
        if (!this._colorMap[code]) {
            this._colorMap[code] =
                this._colorIdx < this.COLORS.length
                    ? this.COLORS[this._colorIdx]
                    : this.OVERFLOW_COLOR;
            this._colorIdx++;
        }
        return this._colorMap[code];
    },

    buildGrid(dayCount = 5) {
        this._dayCount = dayCount;
        const grid = document.getElementById('calendar-grid');
        const header = grid.querySelector('.cal-header');
        const body = document.getElementById('cal-body');
        header.innerHTML = `
            <div class="cal-time-label"></div>
            ${this.DAY_LABELS.slice(0, dayCount).map(day => `<div class="cal-day-label">${day}</div>`).join('')}
        `;
        header.style.gridTemplateColumns = `var(--calendar-time-width) repeat(${dayCount}, 1fr)`;
        grid.classList.toggle('calendar-seven-day', dayCount === 7);
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
            label.style.width = 'var(--calendar-time-width, 42px)';
            const hour12 = h % 12 || 12;
            const ampm = h >= 12 ? 'p' : 'a';
            label.textContent = `${hour12}${ampm}`;
            body.appendChild(label);
        }

        // Create day columns
        this._dayColumns = [];
        for (let d = 0; d < dayCount; d++) {
            const col = document.createElement('div');
            col.className = 'cal-day-column';
            col.style.position = 'absolute';
            col.style.left = `calc(var(--calendar-time-width, 42px) + ${d} * (100% - var(--calendar-time-width, 42px)) / ${dayCount})`;
            col.style.width = `calc((100% - var(--calendar-time-width, 42px)) / ${dayCount})`;
            col.style.top = '0';
            col.style.height = gridHeight + 'px';

            // Hour lines
            for (let h = this.START_HOUR; h < this.END_HOUR; h++) {
                const line = document.createElement('div');
                line.className = 'cal-hour-line';
                line.style.top = ((h - this.START_HOUR) * 60 * this.PX_PER_MIN) + 'px';
                col.appendChild(line);

                const halfHourLine = document.createElement('div');
                halfHourLine.className = 'cal-half-hour-line';
                halfHourLine.style.top = ((h - this.START_HOUR) * 60 * this.PX_PER_MIN + 30 * this.PX_PER_MIN) + 'px';
                col.appendChild(halfHourLine);
            }

            body.appendChild(col);
            this._dayColumns.push(col);
        }

        body.style.position = 'relative';
        body.style.height = gridHeight + 'px';
    },

    // Both delegate to the shared meeting-times util (loaded before this file).
    // parseHHMM keeps start/end as HHMM integers, which is what the grid math
    // below expects. It discards a whole malformed meeting list rather than
    // rendering half of one -- the solver's contract, adopted here so a section
    // reads the same way on the calendar as it schedules.
    parseMeetingTimes(mt) {
        return MeetingTimes.parseHHMM(mt);
    },

    timeToMinutes(t) {
        return MeetingTimes.hhmmToMinutes(t);
    },

    meetingLabel(section, meeting) {
        const time = minutes => `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${minutes >= 720 ? 'PM' : 'AM'}`;
        return `${section.code}, section ${section.section || 'unspecified'}. ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][meeting.day]}, ${time(this.timeToMinutes(meeting.start))} to ${time(this.timeToMinutes(meeting.end))}.`;
    },

    renderAgenda(sections) {
        const signature = JSON.stringify(sections.map(section => [section.code, section.crn, section.section, section.meetingTimes, section.instructor || section.instr]));
        if (signature === this._agendaSignature) return;
        this._agendaSignature = signature;
        const agenda = document.getElementById('calendar-agenda');
        agenda.replaceChildren();
        const events = sections.flatMap(section => this.parseMeetingTimes(section.meetingTimes).map(meeting => ({ section, meeting })))
            .sort((a, b) => a.meeting.day - b.meeting.day || a.meeting.start - b.meeting.start);
        let lastDay = null;
        events.forEach(({ section, meeting }) => {
            if (meeting.day !== lastDay) {
                const heading = document.createElement('h4');
                heading.textContent = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][meeting.day];
                agenda.appendChild(heading);
                lastDay = meeting.day;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = this.meetingLabel(section, meeting);
            const instructor = document.createElement('span');
            instructor.textContent = section.instructor || section.instr || 'Instructor undecided';
            button.appendChild(instructor);
            button.addEventListener('click', () => this.showCourseDetail(section));
            agenda.appendChild(button);
        });
        sections.filter(section => !this.parseMeetingTimes(section.meetingTimes).length).forEach(section => {
            const text = document.createElement('p');
            text.textContent = `${section.code}, section ${section.section || 'unspecified'}. No scheduled meeting times.`;
            agenda.appendChild(text);
        });
        if (!sections.length) agenda.textContent = 'No classes selected.';
    },

    visibleDayCount(sections) {
        const hasWeekendMeeting = sections.some(section =>
            this.parseMeetingTimes(section.meetingTimes).some(meeting => meeting.day === 5 || meeting.day === 6),
        );
        return hasWeekendMeeting ? 7 : 5;
    },

    timedMeetings(sections) {
        return sections.flatMap(section => this.parseMeetingTimes(section.meetingTimes))
            .map(meeting => ({ ...meeting, start: this.timeToMinutes(meeting.start), end: this.timeToMinutes(meeting.end) }))
            .filter(meeting => meeting.day >= 0 && meeting.day <= 6 && meeting.end > meeting.start);
    },

    timeRange(sections) {
        const meetings = this.timedMeetings(sections);
        if (!meetings.length) return { start: 8, end: 22 };
        const start = Math.max(0, Math.floor((Math.min(...meetings.map(meeting => meeting.start)) - 30) / 60));
        const end = Math.min(24, Math.ceil((Math.max(...meetings.map(meeting => meeting.end)) + 30) / 60));
        return { start, end };
    },

    fittedScale(sections) {
        const container = document.getElementById('calendar-container');
        const meetings = this.timedMeetings(sections);
        // Leave two readable lines in the shortest class. Long days scroll
        // rather than compressing small meetings into unusable targets.
        const minimumScale = meetings.length
            ? Math.max(0.6, 40 / Math.min(...meetings.map(meeting => meeting.end - meeting.start)))
            : 1;
        if (!container.clientHeight) return minimumScale;
        const headerHeight = document.querySelector('#calendar-grid .cal-header')?.offsetHeight || 30;
        return Math.max(minimumScale, (container.clientHeight - headerHeight - 10) / ((this.END_HOUR - this.START_HOUR) * 60));
    },

    render(options = {}) {
        const sections = options.sections || Object.values(State.selectedSections);
        const range = options.preview ? { start: this.START_HOUR, end: this.END_HOUR } : this.timeRange(sections);
        // The thumbnail popup still previews every option. Keep the main
        // calendar on the selected schedule when a hover needs another range.
        if (options.preview && this.timedMeetings(sections).some(meeting => meeting.start < range.start * 60 || meeting.end > range.end * 60)) {
            this.render();
            return;
        }
        const rangeChanged = range.start !== this.START_HOUR || range.end !== this.END_HOUR;
        this.START_HOUR = range.start;
        this.END_HOUR = range.end;
        const scale = this.fittedScale(options.preview ? Object.values(State.selectedSections) : sections);
        const scaleChanged = Math.abs(scale - this.PX_PER_MIN) >= 0.005;
        this.PX_PER_MIN = scale;
        this._renderedSections = sections;
        this._preview = Boolean(options.preview);
        if (!options.preview) this.renderAgenda(sections);
        const dayCount = this.visibleDayCount(sections);
        if (!this._dayColumns || this._dayCount !== dayCount || rangeChanged || scaleChanged) {
            this.buildGrid(dayCount);
            if (rangeChanged) document.getElementById('calendar-container').scrollTop = 0;
        } else {
            this._dayColumns.forEach(col => {
                col.querySelectorAll('.cal-block').forEach(b => b.remove());
            });
        }

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
                if (mt.day < 0 || mt.day >= this._dayCount) return;
                const col = this._dayColumns[mt.day];
                const startMin = this.timeToMinutes(mt.start);
                const endMin = this.timeToMinutes(mt.end);
                const top = (startMin - this.START_HOUR * 60) * this.PX_PER_MIN;
                const height = (endMin - startMin) * this.PX_PER_MIN;

                const block = document.createElement('button');
                block.type = 'button';
                block.className = `cal-block${hasConflict ? ' conflict' : ''}${options.preview ? ' preview' : ''}`;
                block.disabled = Boolean(options.preview);
                block.setAttribute('aria-label', this.meetingLabel(sec, mt));
                block.style.top = top + 'px';
                block.style.height = height + 'px';
                block.style.background = color;

                block.style.color = '#ffffff';
                block.innerHTML = `
                    <span class="block-title">${sec.code}</span>
                    <span class="block-info">${((sec.instructor || sec.instr) && (sec.instructor || sec.instr) !== 'Staff' ? (sec.instructor || sec.instr) : 'Undecided')}</span>
                    ${height > 55 ? `<span class="block-info">${sec.meets || ''}</span>` : ''}
                `;

                if (!options.preview) {
                    block.addEventListener('click', () => {
                        Calendar.showCourseDetail(sec);
                    });
                }

                col.appendChild(block);
            });
        });
    },
};

// Attach showCourseDetail as a Calendar method for use by other modules
Calendar.showCourseDetail = function(section) {
    if (typeof Scheduler !== 'undefined' && typeof Scheduler.openSectionQuickView === 'function') {
        Scheduler.openSectionQuickView(section);
        return;
    }
    const tab = document.getElementById('tab-details');
    if (!tab) return;

    tab.innerHTML = `
        <h3>${section.code} - ${section.title}</h3>
        <p><strong>Section:</strong> ${section.section} (CRN: ${section.crn})</p>
        <p><strong>Instructor:</strong> ${((section.instructor || section.instr) && (section.instructor || section.instr) !== 'Staff' ? (section.instructor || section.instr) : 'Undecided')}</p>
        <p><strong>Meets:</strong> ${section.meets || 'TBA'}</p>
        <p><strong>Method:</strong> ${(section.instructionalMethod || section.inst_mthd) || 'N/A'}</p>
        <p><strong>Status:</strong> ${section.stat === 'A' ? '<span style="color:#2e7d32;font-weight:700">Open</span>' : '<span style="color:#c62828;font-weight:700">Full</span>'}</p>
        <p class="loading">Loading details</p>
    `;

    // Fetch full details
    API.getDetails(section.crn, State.term).then(data => {
        const seatsMatch = (data.seats || '').match(/seats_avail[^>]*>(\d+)/);
        const maxMatch = (data.seats || '').match(/seats_max[^>]*>(\d+)/);
        const seats = seatsMatch ? seatsMatch[1] : '?';
        const max = maxMatch ? maxMatch[1] : '?';

        const desc = (data.description || '').replace(/<[^>]+>/g, ' ').trim();
        const room = (data.meeting_html || '').replace(/<[^>]+>/g, ' ').trim();

        tab.innerHTML = `
            <h3>${section.code} - ${section.title}</h3>
            <p><strong>Section:</strong> ${section.section} (CRN: ${section.crn})</p>
            <p><strong>Instructor:</strong> ${((section.instructor || section.instr) && (section.instructor || section.instr) !== 'Staff' ? (section.instructor || section.instr) : 'Undecided')}</p>
            <p><strong>Meets:</strong> ${room || section.meets || 'TBA'}</p>
            <p><strong>Credits:</strong> ${data.hours_html || 'N/A'}</p>
            <p><strong>Seats:</strong> <span class="seats-info">${seats} / ${max} available</span></p>
            <p><strong>Method:</strong> ${(data.instructionalMethod || data.inst_mthd) || (section.instructionalMethod || section.inst_mthd) || 'N/A'}</p>
            <p><strong>Campus:</strong> ${data.campus || 'N/A'}</p>
            ${desc ? `<p><strong>Description:</strong> ${desc.substring(0, 300)}${desc.length > 300 ? '...' : ''}</p>` : ''}
            ${data.clssnotes ? `<p><strong>Notes:</strong> ${data.clssnotes.replace(/<[^>]+>/g, ' ').trim()}</p>` : ''}
        `;
    }).catch(() => {
        tab.querySelector('.loading')?.remove();
    });
};

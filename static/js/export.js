/* ICS calendar export */
const Export = {
    DAY_MAP: { 0: 'MO', 1: 'TU', 2: 'WE', 3: 'TH', 4: 'FR', 5: 'SA', 6: 'SU' },

    init() {
        document.getElementById('btn-export').addEventListener('click', () => this.exportICS());
    },

    exportICS() {
        const sections = Object.values(State.selectedSections);
        if (sections.length === 0) {
            alert('No courses selected to export.');
            return;
        }

        let ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//UofSC Course Scheduler//EN',
            'CALSCALE:GREGORIAN',
        ];

        sections.forEach(sec => {
            const times = this.parseMeetingTimes(sec.meetingTimes);
            if (times.length === 0) return;

            const startDate = sec.start_date || '2026-08-18';
            const endDate = sec.end_date || '2026-12-14';

            // Group by unique time (some sections have same time on multiple days)
            const byTime = {};
            times.forEach(mt => {
                const key = `${mt.start}-${mt.end}`;
                if (!byTime[key]) byTime[key] = { start: mt.start, end: mt.end, days: [] };
                byTime[key].days.push(mt.day);
            });

            Object.values(byTime).forEach(group => {
                const days = group.days.map(d => this.DAY_MAP[d]).filter(Boolean);
                if (days.length === 0) return;

                // Find first occurrence date
                const firstDate = this.findFirstDate(startDate, group.days[0]);
                const dtstart = this.formatDateTime(firstDate, group.start);
                const dtend = this.formatDateTime(firstDate, group.end);
                const until = this.formatDate(endDate) + 'T235959Z';

                ics.push('BEGIN:VEVENT');
                ics.push(`DTSTART;TZID=America/New_York:${dtstart}`);
                ics.push(`DTEND;TZID=America/New_York:${dtend}`);
                ics.push(`RRULE:FREQ=WEEKLY;UNTIL=${until};BYDAY=${days.join(',')}`);
                ics.push(`SUMMARY:${sec.code} - ${sec.title}`);
                ics.push(`DESCRIPTION:Section ${sec.section} | ${sec.instr || 'Staff'} | CRN: ${sec.crn}`);
                ics.push(`LOCATION:${sec.meets || 'TBA'}`);
                ics.push(`UID:${sec.crn}-${group.start}-${Date.now()}@uosc-scheduler`);
                ics.push('END:VEVENT');
            });
        });

        ics.push('END:VCALENDAR');

        const blob = new Blob([ics.join('\r\n')], { type: 'text/calendar' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `schedule-${State.term}.ics`;
        a.click();
        URL.revokeObjectURL(url);
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
        } catch (e) { return []; }
    },

    findFirstDate(startDateStr, targetDay) {
        // targetDay: 0=Mon, 1=Tue...
        const d = new Date(startDateStr + 'T00:00:00');
        const jsDay = d.getDay(); // 0=Sun
        // Convert our day (0=Mon) to JS day (1=Mon)
        const targetJsDay = (targetDay + 1) % 7;
        let diff = targetJsDay - jsDay;
        if (diff < 0) diff += 7;
        d.setDate(d.getDate() + diff);
        return d;
    },

    formatDateTime(date, timeInt) {
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const dy = String(date.getDate()).padStart(2, '0');
        const h = String(Math.floor(timeInt / 100)).padStart(2, '0');
        const m = String(timeInt % 100).padStart(2, '0');
        return `${y}${mo}${dy}T${h}${m}00`;
    },

    formatDate(dateStr) {
        return dateStr.replace(/-/g, '');
    },
};

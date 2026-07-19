/*
 * Calendar export, fenced.
 *
 * The smallest feature in the tree by coupling: two state reads and the DOM.
 * It earns a fence anyway, because "turn a schedule into an ICS file" is
 * exactly the operation a CLI or an agent surface would want, and the only
 * thing that stopped it being callable outside a browser was where it read the
 * schedule from.
 *
 * Blob, URL and document stay ambient, so exportICS() still both builds the
 * file and downloads it. Splitting the build from the download is what a
 * non-browser caller actually needs, and it is deliberately not done here: a
 * fence is not a rewrite, and mixing the two is how extractions introduce bugs
 * that look like refactors. The seam this adds is what makes that split a
 * local change later.
 *
 * The body is the previous implementation verbatim apart from those seams.
 */
(function initExportFeature(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.Features) root.Features = {};
    root.Features.export = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createExportFeature(deps) {
        for (const name of ['selectedSections', 'currentTerm']) {
            if (typeof deps?.[name] !== 'function') {
                throw new TypeError(`export feature needs a ${name}() dependency`);
            }
        }

        const feature = {        DAY_MAP: { 0: 'MO', 1: 'TU', 2: 'WE', 3: 'TH', 4: 'FR', 5: 'SA', 6: 'SU' },

        init() {
            const btnExport = document.getElementById('btn-export');
            if (btnExport) btnExport.addEventListener('click', () => this.exportICS());
        },

        exportICS() {
            const sections = Object.values(deps.selectedSections());
            if (sections.length === 0) {
                alert('No courses selected to export.');
                return;
            }

            let ics = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//Course Scheduler//EN',
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

                    const firstDate = this.findFirstDate(startDate, group.days[0]);
                    const dtstart = this.formatDateTime(firstDate, group.start);
                    const dtend = this.formatDateTime(firstDate, group.end);
                    const until = this.formatDate(endDate) + 'T235959Z';

                    ics.push('BEGIN:VEVENT');
                    ics.push(`DTSTART;TZID=America/New_York:${dtstart}`);
                    ics.push(`DTEND;TZID=America/New_York:${dtend}`);
                    ics.push(`RRULE:FREQ=WEEKLY;UNTIL=${until};BYDAY=${days.join(',')}`);
                    ics.push(`SUMMARY:${sec.code} - ${sec.title}`);
                    ics.push(`DESCRIPTION:Section ${sec.section} | ${(sec.instructor || sec.instr) || 'Staff'} | CRN: ${sec.crn}`);
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
            a.download = `schedule-${deps.currentTerm()}.ics`;
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
            const d = new Date(startDateStr + 'T00:00:00');
            const jsDay = d.getDay();
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
        },};

        return feature;
    }

    return { createExportFeature };
}));

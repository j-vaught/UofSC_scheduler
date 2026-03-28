/* ICS calendar export + plan management */
const Export = {
    DAY_MAP: { 0: 'MO', 1: 'TU', 2: 'WE', 3: 'TH', 4: 'FR', 5: 'SA', 6: 'SU' },

    init() {
        // ICS export buttons (main + quick)
        const btnExport = document.getElementById('btn-export');
        if (btnExport) btnExport.addEventListener('click', () => this.exportICS());
        const btnQuick = document.getElementById('btn-export-quick');
        if (btnQuick) btnQuick.addEventListener('click', () => this.exportICS());

        // Plan save/load/delete
        const btnSave = document.getElementById('btn-save-plan');
        if (btnSave) btnSave.addEventListener('click', () => this.savePlan());
        const btnLoad = document.getElementById('btn-load-plan');
        if (btnLoad) btnLoad.addEventListener('click', () => this.loadPlan());
        const btnDelete = document.getElementById('btn-delete-plan');
        if (btnDelete) btnDelete.addEventListener('click', () => this.deletePlan());

        // JSON export/import
        const btnExportJSON = document.getElementById('btn-export-json');
        if (btnExportJSON) btnExportJSON.addEventListener('click', () => this.exportJSON());
        const jsonImport = document.getElementById('json-import');
        if (jsonImport) jsonImport.addEventListener('change', (e) => this.importJSON(e));

        this.renderSavedPlans();
    },

    savePlan() {
        const nameInput = document.getElementById('plan-name-input');
        const name = (nameInput.value || '').trim() || 'Plan A';
        State.currentPlan = name;
        State.savePlan();
        this.renderSavedPlans();
    },

    loadPlan() {
        const nameInput = document.getElementById('plan-name-input');
        const name = (nameInput.value || '').trim();
        if (!name || !State.loadPlan(name)) {
            alert('No saved plan found with name: ' + name);
        } else {
            this.renderSavedPlans();
        }
    },

    deletePlan() {
        const nameInput = document.getElementById('plan-name-input');
        const name = (nameInput.value || '').trim();
        if (!name) return;
        if (confirm(`Delete plan "${name}"?`)) {
            State.deletePlan(name);
            this.renderSavedPlans();
        }
    },

    renderSavedPlans() {
        const container = document.getElementById('plans-container');
        if (!container) return;

        const plans = State.listPlans();
        if (plans.length === 0) {
            container.innerHTML = '<p class="hint">No saved plans yet.</p>';
            return;
        }

        let html = '';
        plans.forEach(name => {
            const plan = State.savedPlans[name];
            const courses = Object.keys(plan.sections || {}).length;
            const completed = (plan.completedCourses || []).length;
            html += `
                <div class="saved-plan-item">
                    <div class="saved-plan-name">${name}</div>
                    <div class="saved-plan-info">${courses} courses selected, ${completed} completed</div>
                    <button class="btn-small btn-garnet load-plan-btn" data-name="${name}">LOAD</button>
                </div>
            `;
        });
        container.innerHTML = html;

        container.querySelectorAll('.load-plan-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const name = btn.dataset.name;
                State.loadPlan(name);
                document.getElementById('plan-name-input').value = name;
            });
        });
    },

    exportJSON() {
        const json = State.exportToJSON();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `uosc-plan-${State.term}.json`;
        a.click();
        URL.revokeObjectURL(url);
    },

    importJSON(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            if (State.importFromJSON(ev.target.result)) {
                alert('Plan imported successfully.');
                this.renderSavedPlans();
            } else {
                alert('Failed to import plan. Invalid file format.');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
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
    },
};

/* Historical offering and enrollment display with per-term progress */
const History = {
    _loadId: 0,
    TERMS: [
        { code: '202308', label: 'Fall 2023' },
        { code: '202401', label: 'Spring 2024' },
        { code: '202405', label: 'Summer 2024' },
        { code: '202408', label: 'Fall 2024' },
        { code: '202501', label: 'Spring 2025' },
        { code: '202505', label: 'Summer 2025' },
        { code: '202508', label: 'Fall 2025' },
        { code: '202601', label: 'Spring 2026' },
        { code: '202605', label: 'Summer 2026' },
        { code: '202608', label: 'Fall 2026' },
        { code: '202701', label: 'Spring 2027' },
        { code: '202705', label: 'Summer 2027' },
        { code: '202708', label: 'Fall 2027' },
        { code: '202801', label: 'Spring 2028' },
        { code: '202805', label: 'Summer 2028' },
        { code: '202808', label: 'Fall 2028' },
        { code: '202901', label: 'Spring 2029' },
        { code: '202905', label: 'Summer 2029' },
        { code: '202908', label: 'Fall 2029' },
    ],

    _activeTerm(date = new Date()) {
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        if (month <= 5) return `${year}01`;
        if (month <= 7) return `${year}05`;
        return `${year}08`;
    },

    _historyBoundary() {
        const selected = (typeof State !== 'undefined' && State.term) || this._activeTerm();
        const active = this._activeTerm();
        return selected < active ? selected : active;
    },

    _number(value) {
        if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
        const number = Number(String(value).replaceAll(',', '').trim());
        return Number.isFinite(number) ? number : null;
    },

    _sumMetric(rows, names) {
        let found = false;
        let total = 0;
        rows.forEach(row => {
            for (const name of names) {
                const value = this._number(row[name]);
                if (value !== null) {
                    found = true;
                    total += value;
                    break;
                }
            }
        });
        return found ? total : null;
    },

    _enrollmentMetrics(rows) {
        let enrollment = this._sumMetric(rows, ['enrollment', 'enrolled', 'actualEnrollment', 'actual_enrollment']);
        const capacity = this._sumMetric(rows, ['capacity', 'maxEnrollment', 'maximumEnrollment', 'max_enrollment']);
        const available = this._sumMetric(rows, ['seatsAvailable', 'seats_available']);
        if (enrollment === null && capacity !== null && available !== null) {
            enrollment = Math.max(0, capacity - available);
        }
        return { enrollment, capacity };
    },

    async _sectionEnrollment(rows, term) {
        const existing = this._enrollmentMetrics(rows);
        if (existing.enrollment !== null && existing.capacity !== null) return existing;
        const details = await Promise.all(rows.map(row => (
            row.crn ? API.getDetails(row.crn, term).catch(() => null) : null
        )));
        let enrollment = 0;
        let capacity = 0;
        let found = false;
        details.forEach(detail => {
            const seats = detail?.seats || '';
            const maximum = seats.match(/seats_max[^>]*>(\d+)/);
            const available = seats.match(/seats_avail[^>]*>(\d+)/);
            if (maximum && available) {
                const sectionCapacity = Number(maximum[1]);
                capacity += sectionCapacity;
                enrollment += Math.max(0, sectionCapacity - Number(available[1]));
                found = true;
            }
        });
        return found ? { enrollment, capacity } : existing;
    },

    _escape(value) {
        const node = document.createElement('span');
        node.textContent = String(value ?? '');
        return node.innerHTML;
    },

    async loadForCourse(courseCode) {
        const container = document.getElementById('history-container');
        if (!container) return;

        const loadId = ++this._loadId;
        const subject = courseCode.split(' ')[0];
        const boundary = this._historyBoundary();
        const historyTerms = this.TERMS.filter(term => term.code < boundary);
        const total = historyTerms.length;

        if (total === 0) {
            this.render({ code: courseCode, terms: [] }, container);
            return;
        }

        container.innerHTML = `
            <h3>${this._escape(courseCode)} — Offering History</h3>
            <div id="history-progress">
                <div class="history-progress-bar">
                    <div class="history-progress-fill" id="history-fill" style="width:0%"></div>
                </div>
                <div id="history-status" class="history-status">Checking ${historyTerms[0].label}...</div>
            </div>
            <div id="history-results-live" class="history-results-live"></div>
        `;

        const statusEl = document.getElementById('history-status');
        const fillEl = document.getElementById('history-fill');
        const liveEl = document.getElementById('history-results-live');
        const results = [];

        for (let i = 0; i < total; i++) {
            if (loadId !== this._loadId) return;

            const term = historyTerms[i];
            const pct = Math.round(((i + 1) / total) * 100);
            statusEl.textContent = `Checking ${term.label}... (${i + 1}/${total})`;
            fillEl.style.width = pct + '%';

            try {
                const data = await API.searchCourses(term.code, [
                    { field: 'subject', value: subject }
                ]);
                const matches = (data.results || []).filter(
                    row => row.code === courseCode && !row.isCancelled
                );
                const rawTimes = matches.map(row => (row.meets || 'TBA').replace(/\s+/g, ' ').trim());
                const metrics = await this._sectionEnrollment(matches, term.code);
                const result = {
                    term: term.code,
                    label: term.label,
                    offered: matches.length > 0,
                    sections: matches.length,
                    instructors: [...new Set(matches.map(row => (row.instr || 'Staff').trim()))],
                    times: [...new Set(rawTimes)],
                    enrollment: metrics.enrollment,
                    capacity: metrics.capacity,
                };
                results.push(result);

                const row = document.createElement('div');
                row.className = 'history-live-row ' + (result.offered ? 'found' : 'not-found');
                if (result.offered) {
                    const enrollment = this._number(result.enrollment);
                    const capacity = this._number(result.capacity);
                    const enrollmentText = enrollment !== null
                        ? `${Math.round(enrollment)} enrolled${capacity > 0 ? ` of ${Math.round(capacity)}` : ''}`
                        : '';
                    row.innerHTML = `<span class="history-live-term">${this._escape(term.label)}</span>
                        <span class="offered">Yes</span>
                        <span>${result.sections} section${result.sections !== 1 ? 's' : ''}</span>
                        ${enrollmentText ? `<span>${this._escape(enrollmentText)}</span>` : ''}`;
                } else {
                    row.innerHTML = `<span class="history-live-term">${this._escape(term.label)}</span>
                        <span class="not-offered">Not offered</span>`;
                }
                liveEl.appendChild(row);
                liveEl.scrollTop = liveEl.scrollHeight;
            } catch (err) {
                results.push({
                    term: term.code,
                    label: term.label,
                    offered: false,
                    sections: 0,
                    instructors: [],
                    times: [],
                    error: true,
                });
            }
        }

        this.render({ code: courseCode, terms: results }, container);
    },

    render(data, container) {
        const code = data.code || '';
        const boundary = data.as_of_term || this._historyBoundary();
        const terms = (data.terms || []).filter(term => term.term < boundary && term.complete !== false && !term.future);
        const availableTerms = terms.filter(term => !term.error && term.available !== false);
        const offeredCount = availableTerms.filter(term => term.offered).length;
        const totalTerms = availableTerms.length;
        const pct = totalTerms ? Math.round((offeredCount / totalTerms) * 100) : 0;

        const fallCount = availableTerms.filter(term => term.term.endsWith('08') && term.offered).length;
        const springCount = availableTerms.filter(term => term.term.endsWith('01') && term.offered).length;
        const summerCount = availableTerms.filter(term => term.term.endsWith('05') && term.offered).length;
        const patternParts = [];
        if (fallCount >= 2) patternParts.push('Fall');
        if (springCount >= 2) patternParts.push('Spring');
        if (summerCount >= 1) patternParts.push('Summer');

        const enrollmentTerms = availableTerms.filter(term => this._number(term.enrollment) !== null);
        const capacityTerms = availableTerms.filter(term => (
            this._number(term.enrollment) !== null && this._number(term.capacity) > 0
        ));
        const averageEnrollment = enrollmentTerms.length
            ? enrollmentTerms.reduce((sum, term) => sum + this._number(term.enrollment), 0) / enrollmentTerms.length
            : null;
        const totalEnrollment = capacityTerms.reduce((sum, term) => sum + this._number(term.enrollment), 0);
        const totalCapacity = capacityTerms.reduce((sum, term) => sum + this._number(term.capacity), 0);
        const hasEnrollment = enrollmentTerms.length > 0 || availableTerms.some(term => this._number(term.capacity) !== null);

        const seasonSummary = patternParts.length ? patternParts.join(', ') : 'No recurring season yet';
        const fillRate = totalCapacity ? Math.round(totalEnrollment / totalCapacity * 100) : null;
        const timeline = terms.map(term => {
            const enrollment = this._number(term.enrollment);
            const capacity = this._number(term.capacity);
            const termFill = enrollment !== null && capacity > 0 ? Math.round(enrollment / capacity * 100) : null;
            const state = term.error || term.available === false ? 'unknown' : term.offered ? 'offered' : 'not-offered';
            return `
                <div class="history-term-card ${state}">
                    <span>${this._escape(term.label)}</span>
                    <strong>${state === 'unknown' ? 'Unavailable' : term.offered ? `${term.sections || 0} section${term.sections === 1 ? '' : 's'}` : 'Not offered'}</strong>
                    ${term.offered ? `<small>${enrollment !== null ? `${Math.round(enrollment)}${capacity > 0 ? ` of ${Math.round(capacity)}` : ''} enrolled` : 'Enrollment unavailable'}${termFill !== null ? ` · ${termFill}% filled` : ''}</small>` : '<small>&nbsp;</small>'}
                </div>
            `;
        }).join('');

        container.innerHTML = `
            <div class="history-detail-heading"><div><h2>Offering history</h2><p>Completed terms before the current planning term.</p></div></div>
            <div class="history-summary-grid">
                <div><strong>${pct}%</strong><span>of recent terms</span></div>
                <div><strong>${offeredCount} of ${totalTerms}</strong><span>terms offered</span></div>
                <div><strong>${this._escape(seasonSummary)}</strong><span>observed seasons</span></div>
                ${averageEnrollment !== null ? `<div><strong>${Math.round(averageEnrollment)}</strong><span>average enrollment${fillRate !== null ? ` · ${fillRate}% filled` : ''}</span></div>` : ''}
            </div>
            ${totalTerms ? `<div class="history-frequency-track"><i style="width:${pct}%"></i></div><div class="history-term-grid">${timeline}</div>` : '<p class="hint">No completed-term offering history is available.</p>'}
        `;
    },
};

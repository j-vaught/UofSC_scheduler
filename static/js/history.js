/* Historical offering and enrollment display */
const History = {
    _loadId: 0,

    _activeTerm(date = new Date()) {
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        if (month <= 5) return `${year}01`;
        if (month <= 7) return `${year}05`;
        return `${year}08`;
    },

    _historyBoundary(serverAsOfTerm = '') {
        const selected = (typeof State !== 'undefined' && State.term) || this._activeTerm();
        const active = this._activeTerm();
        const localBoundary = selected < active ? selected : active;
        const serverBoundary = String(serverAsOfTerm || '');
        if (/^\d{6}$/.test(serverBoundary) && serverBoundary < localBoundary) {
            return serverBoundary;
        }
        return localBoundary;
    },

    _number(value) {
        if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
        const number = Number(String(value).replaceAll(',', '').trim());
        return Number.isFinite(number) ? number : null;
    },

    _escape(value) {
        const node = document.createElement('span');
        node.textContent = String(value ?? '');
        return node.innerHTML;
    },

    renderLoading(courseCode, progress = {}, container = document.getElementById('history-container')) {
        if (!container) return;
        const total = Math.max(0, Number(progress.total) || 0);
        const completed = Math.min(total, Math.max(0, Number(progress.completed) || 0));
        const percent = total ? Math.round(completed / total * 100) : 0;
        const determinate = total > 0;
        const label = String(progress.label || '');
        const section = Math.max(0, Number(progress.section) || 0);
        const sectionTotal = Math.max(0, Number(progress.section_total) || 0);
        let detail = label ? `Checking ${label}` : 'Preparing completed terms';
        if (progress.phase === 'enrollment' && label) {
            detail = sectionTotal
                ? `Reading enrollment for ${label} · ${section} of ${sectionTotal} sections`
                : `Reading enrollment for ${label}`;
        }
        const countText = determinate
            ? `${completed} of ${total} terms checked`
            : 'Connecting to offering records';
        const progressText = determinate
            ? `${percent}%`
            : 'Starting';
        const ariaValue = determinate ? ` aria-valuenow="${percent}"` : '';
        const ariaText = determinate
            ? ` aria-valuetext="${this._escape(`${countText}. ${detail}`)}"`
            : ' aria-valuetext="Preparing offering history"';

        container.innerHTML = `
            <div class="history-detail-heading">
                <div><h2>Offering history</h2><p>${this._escape(courseCode)}</p></div>
            </div>
            <section class="history-loading-card" aria-busy="true">
                <div class="history-loading-heading"><strong>Loading offering history</strong><span>${progressText}</span></div>
                <div class="history-progress-bar ${determinate ? '' : 'indeterminate'}" role="progressbar" aria-label="Offering history loading progress" aria-valuemin="0" aria-valuemax="100"${ariaValue}${ariaText}>
                    <i class="history-progress-fill" style="width:${determinate ? percent : 28}%"></i>
                </div>
                <p class="history-status" role="status" aria-live="polite" aria-atomic="true"><strong>${countText}</strong><span>${this._escape(detail)}</span></p>
            </section>
        `;
    },

    async loadForCourse(courseCode) {
        const container = document.getElementById('history-container');
        if (!container) return;

        const loadId = ++this._loadId;
        this.renderLoading(courseCode, {}, container);

        try {
            const data = await API.getHistory(courseCode, progress => {
                if (loadId !== this._loadId) return;
                this.renderLoading(courseCode, progress, container);
            });
            if (loadId !== this._loadId) return;
            if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) {
                throw new Error('Offering history is unavailable');
            }
            this.render({ ...data, code: data.code || courseCode }, container);
        } catch (error) {
            if (loadId !== this._loadId) return;
            container.innerHTML = `
                <div class="history-detail-heading">
                    <div><h2>Offering history</h2><p>${this._escape(courseCode)}</p></div>
                </div>
                <p class="hint" role="alert">Offering history is temporarily unavailable. Try again later.</p>
            `;
        }
    },

    render(data, container) {
        const code = data.code || '';
        const boundary = this._historyBoundary(data.as_of_term);
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

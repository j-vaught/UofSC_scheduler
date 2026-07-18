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
        if (progress.phase === 'waiting') {
            detail = 'Joining the offering-history request already in progress';
        } else if (progress.phase === 'enrollment' && progress.mode === 'summary' && label) {
            detail = section > 0
                ? `Enrollment loaded for all ${sectionTotal} ${label} sections`
                : `Loading enrollment for all ${sectionTotal} ${label} sections together`;
        } else if (progress.phase === 'enrollment' && label) {
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
        const boundary = this._historyBoundary(data.as_of_term);
        const terms = (data.terms || []).filter(term => term.term < boundary && !term.future);
        const availableTerms = terms.filter(term => (
            term.complete !== false && !term.error && term.available !== false
        ));
        const offeredCount = availableTerms.filter(term => term.offered).length;
        const totalTerms = availableTerms.length;
        const pct = totalTerms ? Math.round((offeredCount / totalTerms) * 100) : 0;

        const metricCoverageComplete = (term, metric) => {
            const sections = Math.max(0, Number(term.sections) || 0);
            const measured = this._number(term[`${metric}_sections`]);
            return measured === null || measured >= sections;
        };

        const enrollmentTerms = availableTerms.filter(term => (
            term.offered
            && this._number(term.enrollment) !== null
            && metricCoverageComplete(term, 'enrollment')
        ));
        const capacityTerms = availableTerms.filter(term => (
            term.offered
            && this._number(term.enrollment) !== null
            && this._number(term.capacity) > 0
            && metricCoverageComplete(term, 'enrollment')
            && metricCoverageComplete(term, 'capacity')
        ));
        const averageEnrollment = enrollmentTerms.length
            ? enrollmentTerms.reduce((sum, term) => sum + this._number(term.enrollment), 0) / enrollmentTerms.length
            : null;
        const totalEnrollment = capacityTerms.reduce((sum, term) => sum + this._number(term.enrollment), 0);
        const totalCapacity = capacityTerms.reduce((sum, term) => sum + this._number(term.capacity), 0);
        const fillRate = totalCapacity ? Math.round(totalEnrollment / totalCapacity * 100) : null;
        const offeredTerms = availableTerms
            .filter(term => term.offered)
            .sort((left, right) => String(right.term).localeCompare(String(left.term)));
        const lastOffered = offeredTerms[0] || null;
        const seasons = [
            { code: '01', label: 'Spring' },
            { code: '05', label: 'Summer' },
            { code: '08', label: 'Fall' },
        ];
        const termByCode = new Map(terms.map(term => [String(term.term), term]));
        const years = [...new Set(terms
            .map(term => String(term.term))
            .filter(term => /^\d{6}$/.test(term))
            .map(term => term.slice(0, 4)))]
            .sort((left, right) => Number(right) - Number(left));

        const termCell = (year, season) => {
            const term = termByCode.get(`${year}${season.code}`);
            if (!term) {
                return `<div class="history-season-cell not-checked" aria-label="${season.label} ${year}, outside the available history"><span aria-hidden="true">—</span></div>`;
            }

            const enrollment = this._number(term.enrollment);
            const capacity = this._number(term.capacity);
            const enrollmentSections = this._number(term.enrollment_sections);
            const enrollmentComplete = metricCoverageComplete(term, 'enrollment');
            const capacityComplete = metricCoverageComplete(term, 'capacity');
            const termFill = enrollment !== null && capacity > 0
                && enrollmentComplete && capacityComplete
                ? Math.round(enrollment / capacity * 100)
                : null;
            const sections = Math.max(0, Number(term.sections) || 0);
            const state = term.complete === false || term.error || term.available === false
                ? 'unknown'
                : term.offered ? 'offered' : 'not-offered';
            const termLabel = term.label || `${season.label} ${year}`;

            if (state === 'not-offered') {
                return `<div class="history-season-cell not-offered" aria-label="${this._escape(`${termLabel}, not offered`)}"><span>Not offered</span></div>`;
            }

            const offeringText = state === 'unknown'
                ? 'Offering data unavailable'
                : `${sections} section${sections === 1 ? '' : 's'}`;
            let enrollmentText = '';
            if (state === 'offered') {
                if (enrollment !== null && enrollmentComplete) {
                    enrollmentText = `${Math.round(enrollment)}${capacity > 0 && capacityComplete ? ` of ${Math.round(capacity)}` : ''} enrolled${termFill !== null ? ` · ${termFill}% filled` : ''}`;
                } else if (enrollment !== null && enrollmentSections > 0) {
                    enrollmentText = `${Math.round(enrollment)} enrolled across ${Math.round(enrollmentSections)} of ${sections} sections`;
                }
            }
            const tooltipId = `history-term-${String(term.term).replace(/[^0-9a-z_-]/gi, '')}`;
            const accessibleDetails = [termLabel, offeringText, enrollmentText].filter(Boolean).join('. ');

            return `
                <div class="history-season-cell ${state}" tabindex="0" role="img" aria-label="${this._escape(accessibleDetails)}" aria-describedby="${tooltipId}">
                    ${state === 'offered'
                        ? `<strong>${sections}</strong><span>section${sections === 1 ? '' : 's'}</span>`
                        : '<span>Unavailable</span>'}
                    <span class="history-term-tooltip" id="${tooltipId}" role="tooltip">
                        <strong>${this._escape(termLabel)}</strong>
                        <span>${this._escape(offeringText)}</span>
                        ${enrollmentText ? `<span>${this._escape(enrollmentText)}</span>` : ''}
                    </span>
                </div>
            `;
        };

        const yearRows = years.map(year => `
            <div class="history-year-row">
                <div class="history-year-label">${year}</div>
                ${seasons.map(season => termCell(year, season)).join('')}
            </div>
        `).join('');

        const enrollmentSummary = averageEnrollment !== null
            ? `<strong>${Math.round(averageEnrollment)}</strong><span>average students per offered term${fillRate !== null ? ` · ${fillRate}% filled` : ''}</span>`
            : '<strong>—</strong><span>enrollment unavailable</span>';

        container.innerHTML = `
            <div class="history-detail-heading"><div><h2>Offering history</h2><p>Completed terms before the current planning term.</p></div></div>
            ${terms.length ? `
                <div class="history-overview" aria-label="Offering history summary">
                    <div class="history-overview-primary"><strong>${pct}%</strong><span>of completed terms</span></div>
                    <div class="history-overview-facts">
                        <div><strong>${offeredCount} of ${totalTerms}</strong><span>terms offered</span></div>
                        <div><strong>${this._escape(lastOffered?.label || 'None yet')}</strong><span>most recent offering</span></div>
                        <div>${enrollmentSummary}</div>
                    </div>
                </div>
                <section class="history-year-view" aria-labelledby="history-year-title">
                    <div class="history-year-heading">
                        <div><h3 id="history-year-title">Offerings by year</h3><p>Hover or focus a colored term for enrollment details.</p></div>
                        <div class="history-year-legend" aria-label="Offering status legend">
                            <span><i class="offered"></i>Offered</span>
                            <span><i class="not-offered"></i>Not offered</span>
                            <span><i class="unknown"></i>Unavailable</span>
                        </div>
                    </div>
                    <div class="history-year-matrix">
                        <div class="history-year-columns" aria-hidden="true"><span>Year</span>${seasons.map(season => `<span>${season.label}</span>`).join('')}</div>
                        ${yearRows}
                    </div>
                </section>
            ` : '<p class="hint">No completed-term offering history is available.</p>'}
        `;
    },
};

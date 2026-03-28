/* Historical offering frequency display with per-term progress */
const History = {
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
        { code: '202708', label: 'Fall 2027' },
        { code: '202801', label: 'Spring 2028' },
        { code: '202808', label: 'Fall 2028' },
        { code: '202901', label: 'Spring 2029' },
        { code: '202908', label: 'Fall 2029' },
    ],

    async loadForCourse(courseCode) {
        const container = document.getElementById('history-container');
        if (!container) return;

        const subject = courseCode.split(' ')[0];
        const total = this.TERMS.length;

        // Show initial progress UI
        container.innerHTML = `
            <h3>${courseCode} — Offering History</h3>
            <div id="history-progress">
                <div class="history-progress-bar">
                    <div class="history-progress-fill" id="history-fill" style="width:0%"></div>
                </div>
                <div id="history-status" class="history-status">Checking ${this.TERMS[0].label}...</div>
            </div>
            <div id="history-results-live" class="history-results-live"></div>
        `;

        const statusEl = document.getElementById('history-status');
        const fillEl = document.getElementById('history-fill');
        const liveEl = document.getElementById('history-results-live');
        const results = [];

        for (let i = 0; i < total; i++) {
            const term = this.TERMS[i];
            const pct = Math.round(((i + 1) / total) * 100);

            // Update progress
            statusEl.textContent = `Checking ${term.label}... (${i + 1}/${total})`;
            fillEl.style.width = pct + '%';

            try {
                const data = await API.searchCourses(term.code, [
                    { field: 'subject', value: subject }
                ]);
                const matches = (data.results || []).filter(
                    r => r.code === courseCode && (r.section || '').startsWith('0')
                );

                const result = {
                    term: term.code,
                    label: term.label,
                    offered: matches.length > 0,
                    sections: matches.length,
                    instructors: [...new Set(matches.map(m => m.instr || 'Staff'))],
                    times: [...new Set(matches.map(m => m.meets || 'TBA'))],
                };
                results.push(result);

                // Add live result row
                const row = document.createElement('div');
                row.className = 'history-live-row ' + (result.offered ? 'found' : 'not-found');
                if (result.offered) {
                    row.innerHTML = `<span class="history-live-term">${term.label}</span>
                        <span class="offered">Yes</span>
                        <span>${result.sections} section${result.sections !== 1 ? 's' : ''}</span>
                        <span>${result.instructors.join(', ')}</span>`;
                } else {
                    row.innerHTML = `<span class="history-live-term">${term.label}</span>
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

        // Done — render the full summary
        const offeredCount = results.filter(r => r.offered).length;
        this.render({
            code: courseCode,
            total_terms: total,
            offered_count: offeredCount,
            terms: results,
        }, container);
    },

    render(data, container) {
        const { code, total_terms, offered_count, terms } = data;
        const pct = Math.round((offered_count / total_terms) * 100);

        const fallCount = terms.filter(t => t.term.endsWith('08') && t.offered).length;
        const springCount = terms.filter(t => t.term.endsWith('01') && t.offered).length;
        const summerCount = terms.filter(t => t.term.endsWith('05') && t.offered).length;

        let pattern = '';
        const parts = [];
        if (fallCount >= 2) parts.push('Fall');
        if (springCount >= 2) parts.push('Spring');
        if (summerCount >= 1) parts.push('Summer');
        if (parts.length > 0) pattern = `Typically offered: ${parts.join(', ')}`;

        let html = `
            <h3>${code} — Offering History</h3>
            <p>Offered <strong>${offered_count}</strong> out of <strong>${total_terms}</strong> terms (${pct}%)</p>
            ${pattern ? `<p style="color:#466A9F;font-weight:600">${pattern}</p>` : ''}
            <table class="history-table" style="margin-top:10px">
                <thead>
                    <tr><th>Term</th><th>Offered</th><th>Sections</th><th>Instructor(s)</th><th>Times</th></tr>
                </thead>
                <tbody>
        `;

        terms.forEach(t => {
            if (t.offered) {
                html += `<tr>
                    <td>${t.label}</td>
                    <td class="offered">Yes</td>
                    <td>${t.sections || 0}</td>
                    <td>${(t.instructors || []).join(', ')}</td>
                    <td>${(t.times || []).join(', ')}</td>
                </tr>`;
            } else {
                html += `<tr>
                    <td>${t.label}</td>
                    <td class="not-offered">No</td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                </tr>`;
            }
        });

        html += '</tbody></table>';

        // Mini bar chart
        html += '<div style="margin-top:12px;display:flex;gap:3px;align-items:flex-end;height:60px">';
        terms.forEach(t => {
            const h = t.offered ? (30 + (t.sections || 1) * 10) : 4;
            const color = t.offered ? '#73000A' : '#e0e0e0';
            const shortLabel = t.label.replace('Spring ', 'Sp').replace('Summer ', 'Su').replace('Fall ', 'Fa');
            html += `<div style="display:flex;flex-direction:column;align-items:center;flex:1">
                <div style="width:100%;height:${h}px;background:${color}" title="${t.label}"></div>
                <div style="font-size:0.55rem;color:#666;margin-top:2px">${shortLabel}</div>
            </div>`;
        });
        html += '</div>';

        container.innerHTML = html;
    },
};

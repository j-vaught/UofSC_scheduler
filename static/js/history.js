/* Historical offering frequency display */
const History = {
    async loadForCourse(courseCode) {
        // Switch to history tab
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('[data-tab="history"]').classList.add('active');
        document.getElementById('tab-history').classList.add('active');

        const container = document.getElementById('history-container');
        container.innerHTML = `<p class="loading">Loading history for ${courseCode} (checking 10 terms)</p>`;

        try {
            const data = await API.getHistory(courseCode);
            this.render(data, container);
        } catch (err) {
            container.innerHTML = `<p class="hint">Error loading history: ${err.message}</p>`;
        }
    },

    render(data, container) {
        const { code, total_terms, offered_count, terms } = data;
        const pct = Math.round((offered_count / total_terms) * 100);

        // Determine pattern
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
            ${pattern ? `<p style="color:#73b7ff">${pattern}</p>` : ''}
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
                <div style="width:100%;height:${h}px;background:${color};border-radius:2px" title="${t.label}"></div>
                <div style="font-size:0.55rem;color:#666;margin-top:2px">${shortLabel}</div>
            </div>`;
        });
        html += '</div>';

        container.innerHTML = html;
    },
};

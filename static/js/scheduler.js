/* Solver frontend glue */
const Scheduler = {
    init() {
        document.getElementById('btn-solve').addEventListener('click', () => this.solve());
    },

    async solve() {
        // Gather courses that have been searched (from courseGroups)
        const courseGroups = State.courseGroups;
        if (!courseGroups || courseGroups.length === 0) {
            alert('Please search for courses first, then click Solve.');
            return;
        }

        // Switch to solver tab
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('[data-tab="solver"]').classList.add('active');
        document.getElementById('tab-solver').classList.add('active');

        const container = document.getElementById('solver-container');
        container.innerHTML = '<p class="loading">Generating optimal schedules</p>';

        // Build course list for solver
        const courses = courseGroups.map(g => ({
            code: g.code,
            sections: g.sections.filter(s => {
                // Only include sections with meeting times
                return s.meetingTimes && s.meets !== 'Does Not Meet';
            }),
        })).filter(c => c.sections.length > 0);

        if (courses.length === 0) {
            container.innerHTML = '<p class="hint">No courses with meeting times to schedule.</p>';
            return;
        }

        const preferences = State.getPreferences();

        try {
            const result = await API.solve(courses, preferences);
            State.solverResults = result.schedules || [];
            this.renderResults(result, container);
        } catch (err) {
            container.innerHTML = `<p class="hint">Solver error: ${err.message}</p>`;
        }
    },

    renderResults(result, container) {
        const { total_found, returned, schedules } = result;

        if (!schedules || schedules.length === 0) {
            container.innerHTML = '<p class="hint">No conflict-free schedules found. Try removing some courses or adjusting preferences.</p>';
            return;
        }

        let html = `<p style="font-size:0.8rem;color:#888;margin-bottom:8px">Found ${total_found} valid schedules, showing top ${returned}</p>`;

        schedules.forEach((sched, idx) => {
            const courses = Object.entries(sched.sections);
            const courseList = courses.map(([code, sec]) =>
                `${code} (${sec.section || '?'}) - ${sec.instr || 'Staff'} ${sec.meets || ''}`
            ).join('<br>');

            html += `
                <div class="schedule-card" data-idx="${idx}">
                    <div style="display:flex;justify-content:space-between;align-items:center">
                        <span class="score">Schedule #${idx + 1} &mdash; Score: ${sched.score}</span>
                        <button class="btn-apply" data-idx="${idx}" style="font-size:0.75rem">Apply</button>
                    </div>
                    <div class="sched-courses">${courseList}</div>
                </div>
            `;
        });

        container.innerHTML = html;

        // Bind apply buttons
        container.querySelectorAll('.btn-apply').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.idx);
                this.applySchedule(idx);
            });
        });

        // Bind card clicks for preview
        container.querySelectorAll('.schedule-card').forEach(card => {
            card.addEventListener('click', () => {
                const idx = parseInt(card.dataset.idx);
                this.previewSchedule(idx);

                container.querySelectorAll('.schedule-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
            });
        });
    },

    previewSchedule(idx) {
        const sched = State.solverResults[idx];
        if (!sched) return;
        State.applySolverSchedule(sched);
    },

    applySchedule(idx) {
        const sched = State.solverResults[idx];
        if (!sched) return;
        State.applySolverSchedule(sched);
    },
};

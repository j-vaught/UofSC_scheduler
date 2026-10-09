/* Main-semester planning prompt. Dates are the registrar's first and last class days. */
const TermPlanning = {
    semesters: [
        { term: '202608', label: 'Fall 2026', start: '2026-08-18', end: '2026-12-04', calendar: '2026-27' },
        { term: '202701', label: 'Spring 2027', start: '2027-01-11', end: '2027-04-26', calendar: '2026-27' },
        { term: '202708', label: 'Fall 2027', start: '2027-08-17', end: '2027-12-03', calendar: '2027-28' },
        { term: '202801', label: 'Spring 2028', start: '2028-01-10', end: '2028-04-24', calendar: '2027-28' },
        { term: '202808', label: 'Fall 2028', start: '2028-08-22', end: '2028-12-08', calendar: '2028-29' },
        { term: '202901', label: 'Spring 2029', start: '2029-01-08', end: '2029-04-23', calendar: '2028-29' },
        { term: '202908', label: 'Fall 2029', start: '2029-08-21', end: '2029-12-07', calendar: '2029-30' },
    ],

    today() {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date());
        const field = name => parts.find(part => part.type === name).value;
        return `${field('year')}-${field('month')}-${field('day')}`;
    },

    currentSemester(today = this.today()) {
        return [...this.semesters].reverse().find(semester => semester.start <= today)
            || this.semesters[0];
    },

    prepare() {
        const select = document.getElementById('term-select');
        const requested = new URL(location.href).searchParams.get('term');
        if (requested && [...select.options].some(option => option.value === requested)) State.term = requested;
        else if (!State.savedPlans[State.currentPlan]) State.term = this.currentSemester().term;
        if ([...select.options].some(option => option.value === State.term)) select.value = State.term;
    },

    init() {
        document.getElementById('term-select').addEventListener('change', () => this.check());
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.check();
        });
        window.addEventListener('popstate', () => queueMicrotask(() => this.check()));
        this.check();
    },

    check() {
        const semester = this.currentSemester();
        const next = this.semesters[this.semesters.indexOf(semester) + 1];
        if (!next || State.term !== semester.term || this._shown === semester.term) return;
        const start = Date.parse(`${semester.start}T00:00:00Z`);
        const end = Date.parse(`${semester.end}T00:00:00Z`);
        const today = Date.parse(`${this.today()}T00:00:00Z`);
        if (today < start + (end - start) / 3) return;
        const key = `scheduler-term-choice:${semester.term}`;
        try { if (localStorage.getItem(key)) return; } catch { /* Choice can remain session-only. */ }
        if (!document.getElementById('modal-overlay').classList.contains('hidden')) return;
        this._shown = semester.term;
        const remember = () => { try { localStorage.setItem(key, 'chosen'); } catch { /* Optional persistence. */ } };
        AppModal.open(`<section class="term-planning-prompt"><h2>Planning for ${next.label}?</h2><p>${semester.label} is more than one-third complete. Did you mean to search courses for ${next.label}?</p><div class="term-planning-actions"><button id="term-planning-keep" type="button" class="btn-header-secondary">Keep ${semester.label}</button><button id="term-planning-next" type="button" class="btn-garnet">Use ${next.label}</button></div><a href="https://sc.edu/about/offices_and_divisions/registrar/academic_calendars/${semester.calendar}_calendar.php" target="_blank" rel="noopener">Academic calendar</a></section>`, { label: `Planning for ${next.label}?` });
        document.getElementById('term-planning-keep').addEventListener('click', () => { remember(); AppModal.close(); });
        document.getElementById('term-planning-next').addEventListener('click', () => {
            remember();
            AppModal.close();
            const select = document.getElementById('term-select');
            select.value = next.term;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
    },
};

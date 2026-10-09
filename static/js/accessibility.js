/* Shared desktop accessibility. Device policy is independent of viewport size. */
const Accessibility = {
    mobileBlocked: navigator.userAgentData?.mobile === true
        || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    _timers: {},

    announce(message, channel = 'general') {
        const region = document.getElementById(`a11y-status-${channel}`);
        if (!region) return;
        clearTimeout(this._timers[channel]);
        region.textContent = '';
        this._timers[channel] = setTimeout(() => { region.textContent = message; }, 80);
    },

    init() {
        const gate = document.querySelector('.desktop-only-gate');
        gate.hidden = !this.mobileBlocked;
        if (this.mobileBlocked) {
            [...document.body.children].forEach(element => {
                if (element !== gate && element.tagName !== 'SCRIPT') element.inert = true;
            });
            document.getElementById('desktop-only-title').focus();
            return;
        }
        const descriptions = {
            'btn-solve': 'Generate schedule options from your courses and preferences.',
            'btn-schedule-preferences': 'Choose preferred times, days, and walking time between classes.',
            'btn-registration-info': 'View the course numbers and instructions needed to register.',
            'btn-export': 'Export this schedule as a calendar file to import into your calendar app.',
            'filter-toggle': 'Filter course results and choose whether search uses assisted matching.',
        };
        Object.entries(descriptions).forEach(([id, text]) => {
            const button = document.getElementById(id);
            if (!button) return;
            button.title = text;
            button.setAttribute('aria-description', text);
        });
        // Calendar previews contain actual schedule content, rather than text hover help.
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape'
                || document.querySelector('#modal-overlay:not(.hidden), #filter-panel:not(.hidden)')) return;
            if (this.dismissPreview?.()) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, true);
        document.querySelectorAll('[data-skip]').forEach(link => link.addEventListener('click', event => {
            event.preventDefault();
            const schedule = document.getElementById('tab-schedule').classList.contains('active');
            const id = link.dataset.skip === 'details'
                ? (schedule ? 'schedule-detail-panel' : 'semester-content')
                : (schedule ? 'solver-container' : 'search-results');
            let target = document.getElementById(id);
            if (!target || target.hidden || !target.getClientRects().length) target = document.getElementById(schedule ? 'btn-solve' : 'keyword-input');
            target.focus();
            target.scrollIntoView({ block: 'nearest' });
        }));
    },
};
document.documentElement.classList.toggle('mobile-unsupported', Accessibility.mobileBlocked);

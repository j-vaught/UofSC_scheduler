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
            if (button) button.dataset.help = text;
        });
        const tooltip = document.createElement('div');
        tooltip.id = 'control-help-tooltip';
        tooltip.className = 'control-help-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.hidden = true;
        document.body.appendChild(tooltip);
        let owner = null;
        let timer;
        let pointerType;
        const hide = () => {
            clearTimeout(timer);
            if (owner) {
                const ids = (owner.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tooltip.id);
                if (ids.length) owner.setAttribute('aria-describedby', ids.join(' '));
                else owner.removeAttribute('aria-describedby');
            }
            owner = null;
            tooltip.hidden = true;
        };
        const scheduleHide = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (!tooltip.matches(':hover') && !owner?.matches(':hover, :focus')) hide();
            }, 180);
        };
        const show = element => {
            if (!element || element.disabled || element.closest('[inert]')) return;
            if (owner !== element) hide();
            clearTimeout(timer);
            owner = element;
            if (element.hasAttribute('title')) {
                element.dataset.nativeTitle = element.getAttribute('title');
                if (!element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby')
                    && !element.textContent.trim()) element.setAttribute('aria-label', element.dataset.nativeTitle);
                element.removeAttribute('title');
            }
            tooltip.textContent = element.dataset.help || element.dataset.nativeTitle;
            tooltip.hidden = false;
            const ids = new Set((element.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
            ids.add(tooltip.id);
            element.setAttribute('aria-describedby', [...ids].join(' '));
            const box = element.getBoundingClientRect();
            const width = tooltip.offsetWidth;
            tooltip.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
            tooltip.style.top = `${box.bottom + tooltip.offsetHeight + 12 <= innerHeight ? box.bottom + 6 : Math.max(8, box.top - tooltip.offsetHeight - 6)}px`;
        };
        const trigger = target => target.closest?.('[data-help], button[title], a[title], input[title], [tabindex][title], [data-native-title]');
        document.addEventListener('pointerover', event => { const element = trigger(event.target); if (element && !element.contains(event.relatedTarget)) show(element); });
        document.addEventListener('pointerout', event => { if (owner && !owner.contains(event.relatedTarget)) scheduleHide(); });
        document.addEventListener('focusin', event => show(trigger(event.target)));
        document.addEventListener('focusout', scheduleHide);
        tooltip.addEventListener('pointerenter', () => clearTimeout(timer));
        tooltip.addEventListener('pointerleave', scheduleHide);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && document.querySelector('#modal-overlay:not(.hidden), #filter-panel:not(.hidden)')) {
                hide();
                return;
            }
            if (event.key === 'Escape' && (this.dismissGpa?.(true) || this.dismissPreview?.() || !tooltip.hidden)) {
                hide();
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, true);
        document.addEventListener('pointerdown', event => {
            pointerType = event.pointerType;
            if (!event.target.closest('.schedule-gpa-help')) this.dismissGpa?.(false);
            if (event.pointerType === 'touch') show(trigger(event.target));
            else if (!owner?.contains(event.target) && !tooltip.contains(event.target)) hide();
        });
        document.addEventListener('click', () => { if (pointerType !== 'touch') hide(); }, true);
        window.addEventListener('resize', hide);
        document.addEventListener('scroll', hide, true);
        document.addEventListener('tab-changed', hide);
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

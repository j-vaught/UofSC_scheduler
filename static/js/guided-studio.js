(function () {
    'use strict';

    const SELECTORS = {
        activeTab: '.main-tab-btn.active',
        activeDegreeStep: '.degree-wizard-step.active',
        browse: '#browse-workspace',
        scheduleLayout: '.schedule-layout',
    };

    function activeTabName() {
        return document.querySelector(SELECTORS.activeTab)?.dataset.tab || 'semester';
    }

    function updateDrawer(name) {
        const layout = document.querySelector(SELECTORS.scheduleLayout);
        if (!layout) return;
        const next = name === 'courses' || name === 'options' ? name : 'none';
        layout.classList.toggle('studio-course-tools-open', next === 'courses');
        layout.classList.toggle('studio-options-open', next === 'options');
        document.querySelectorAll('[data-studio-drawer]').forEach((button) => {
            const selected = button.dataset.studioDrawer === next && next !== 'none';
            button.setAttribute('aria-pressed', String(selected));
        });
        document.querySelectorAll('.studio-drawer-close').forEach((button) => {
            button.hidden = next === 'none';
        });
    }

    function degreeAction(direction) {
        const step = document.querySelector(SELECTORS.activeDegreeStep);
        if (!step) return;
        if (direction === 'back') {
            step.querySelector('[data-degree-back]')?.click();
            return;
        }
        const next = step.querySelector('[data-degree-next], #btn-generate-plan');
        if (next && !next.disabled) next.click();
    }

    function updateStudio() {
        const tab = activeTabName();
        const browse = document.querySelector(SELECTORS.browse);
        const detailOpen = Boolean(browse?.classList.contains('browse-detail'));
        const activeStep = document.querySelector(SELECTORS.activeDegreeStep)?.dataset.degreeStep || '1';
        const context = {
            semester: detailOpen
                ? ['Course details', 'Review sections, prerequisites, professors, grades, history, and resources.']
                : ['Course search', 'Find and compare courses before adding one to your semester.'],
            degree: [`Degree plan · Step ${activeStep}`, 'Move through program, coursework, strategy, and your final roadmap.'],
            schedule: ['Weekly schedule', 'Build around the calendar, then inspect options and walking routes.'],
        }[tab];
        const actionTitle = {
            semester: detailOpen ? 'Review this course' : 'Find the right course',
            degree: activeStep === '4' ? 'Review your roadmap' : `Complete degree step ${activeStep}`,
            schedule: 'Shape your week',
        }[tab];

        const contextTitle = document.getElementById('studio-context-title');
        const contextDetail = document.getElementById('studio-context-detail');
        const actionKicker = document.getElementById('studio-action-kicker');
        const actionHeading = document.getElementById('studio-action-title');
        if (contextTitle) contextTitle.textContent = context[0];
        if (contextDetail) contextDetail.textContent = context[1];
        if (actionKicker) actionKicker.textContent = tab === 'semester' ? 'SEARCH' : tab.toUpperCase();
        if (actionHeading) actionHeading.textContent = actionTitle;

        document.querySelectorAll('[data-studio-actions]').forEach((group) => {
            group.hidden = group.dataset.studioActions !== (tab === 'semester' ? 'search' : tab);
        });
        document.querySelectorAll('[data-studio-detail-action]').forEach((button) => {
            button.hidden = !detailOpen;
        });

        const degreeBack = document.querySelector('[data-studio-degree-action="back"]');
        const degreeNext = document.querySelector('[data-studio-degree-action="next"]');
        const sourceBack = document.querySelector(`${SELECTORS.activeDegreeStep} [data-degree-back]`);
        const sourceNext = document.querySelector(`${SELECTORS.activeDegreeStep} [data-degree-next], ${SELECTORS.activeDegreeStep} #btn-generate-plan`);
        if (degreeBack) degreeBack.disabled = !sourceBack;
        if (degreeNext) {
            degreeNext.disabled = !sourceNext || sourceNext.disabled;
            degreeNext.textContent = activeStep === '3' ? 'GENERATE PLAN' : activeStep === '4' ? 'PLAN COMPLETE' : 'CONTINUE';
        }

        const sourceRegistration = document.getElementById('btn-registration-info');
        const dockRegistration = document.querySelector('[data-studio-actions="schedule"] [data-studio-proxy="btn-registration-info"]');
        if (dockRegistration) dockRegistration.disabled = !sourceRegistration || sourceRegistration.disabled;
    }

    function handleClick(event) {
        const proxy = event.target.closest('[data-studio-proxy]');
        if (proxy) {
            const source = document.getElementById(proxy.dataset.studioProxy);
            if (source && !source.disabled) source.click();
            return;
        }
        const drawer = event.target.closest('[data-studio-drawer]');
        if (drawer) {
            const layout = document.querySelector(SELECTORS.scheduleLayout);
            const current = drawer.dataset.studioDrawer;
            const alreadyOpen = current === 'courses'
                ? layout?.classList.contains('studio-course-tools-open')
                : layout?.classList.contains('studio-options-open');
            updateDrawer(alreadyOpen ? 'none' : current);
            return;
        }
        const degree = event.target.closest('[data-studio-degree-action]');
        if (degree) degreeAction(degree.dataset.studioDegreeAction);
    }

    function init() {
        document.addEventListener('click', handleClick);
        const observer = new MutationObserver(updateStudio);
        const targets = [
            document.getElementById('main-tabs'),
            document.querySelector(SELECTORS.browse),
            document.querySelector('.degree-wizard'),
            document.getElementById('btn-registration-info'),
        ].filter(Boolean);
        targets.forEach((target) => observer.observe(target, {
            attributes: true,
            attributeFilter: ['class', 'hidden', 'disabled'],
            subtree: true,
        }));
        updateStudio();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
}());

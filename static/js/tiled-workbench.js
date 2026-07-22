'use strict';

/* Compact-window tile navigation for the Tiled Workbench experiment. */
const TiledWorkbench = (() => {
    function resolveTarget(button) {
        const selector = button.dataset.tileTarget;
        const scope = button.closest('.main-tab');
        if (!scope) return null;
        if (selector === 'active-degree-step') {
            return scope.querySelector('.degree-wizard-step:not([hidden])');
        }
        return scope.querySelector(selector);
    }

    function reveal(button) {
        const target = resolveTarget(button);
        if (!target || target.hidden || getComputedStyle(target).display === 'none') return;
        const switcher = button.closest('.tile-switcher');
        switcher.querySelectorAll('button').forEach(item => {
            item.classList.toggle('active', item === button);
        });
        target.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
        const focusTarget = target.querySelector('input, select, button, [tabindex="0"]');
        if (focusTarget) focusTarget.focus({ preventScroll: true });
    }

    function init() {
        document.querySelectorAll('.tile-switcher [data-tile-target]').forEach(button => {
            button.addEventListener('click', () => reveal(button));
        });
    }

    return { init };
})();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', TiledWorkbench.init, { once: true });
} else {
    TiledWorkbench.init();
}

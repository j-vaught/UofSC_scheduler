/*
 * Application boot.
 *
 * This used to be an inline <script> in index.html, which the site's own
 * Content-Security-Policy forbids: script-src is 'self' with no 'unsafe-inline'
 * and no nonce, so the browser refused to execute it and no init() ever ran.
 * Nothing visible failed and no error surfaced -- every control was simply
 * inert. It lives in an external file so the strict policy holds.
 *
 * Note the ordering contract: this is one sequential handler, so a throw in any
 * init() silently skips every module after it.
 */

function boot() {
    SiteNotices.init();
    Tabs.init();
    TranscriptImport.init();
    Profile.init();
    CustomMajorMap.init();
    Calendar.init();
    WalkingMap.init();
    Search.init();
    Preferences.init();
    Scheduler.init();
    Export.init();
    DegreePlan.init();
    DegreeWizard.init();

    State.on('courses-changed', () => ScheduleSidebar.render());
    State.on('sections-changed', () => ScheduleSidebar.render());
    State.on('section-locks-changed', () => ScheduleSidebar.render());
    ScheduleSidebar.render();

    // Term change
    document.getElementById('term-select').addEventListener('change', (e) => {
        State.term = e.target.value;
        if (Tabs.current() === 'semester') {
            if (Search._browseState === 'detail') Search.closeCourseDetail({ historyMode: 'none' });
            if (Search.activeSearchInput()?.value.trim()) Search.doSearch();
            else Search.writeSearchHistory('', { mode: 'replace' });
        } else {
            Tabs.writeTabHistory(Tabs.current(), 'replace');
        }
    });

    // Search landing: planning paths
    document.getElementById('search-degree-btn').addEventListener('click', () => {
        Tabs.switchTo('degree');
    });
    document.getElementById('search-schedule-btn').addEventListener('click', () => {
        Tabs.switchTo('schedule');
    });

    // Resizable search sidebar
    const resizeHandle = document.getElementById('search-resize-handle');
    if (resizeHandle) {
        const panel = document.getElementById('semester-search');
        let startX, startW;
        const setPanelWidth = requestedWidth => {
            const newWidth = Math.max(200, Math.min(requestedWidth, window.innerWidth * 0.7));
            panel.style.width = newWidth + 'px';
            resizeHandle.setAttribute('aria-valuemax', String(Math.round(window.innerWidth * 0.7)));
            resizeHandle.setAttribute('aria-valuenow', String(Math.round(newWidth)));
        };
        resizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startW = panel.offsetWidth;
            resizeHandle.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            const onMove = (e) => {
                const diff = e.clientX - startX;
                setPanelWidth(startW + diff);
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                resizeHandle.classList.remove('active');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        resizeHandle.addEventListener('keydown', event => {
            const step = event.shiftKey ? 48 : 16;
            const currentWidth = panel.getBoundingClientRect().width;
            if (event.key === 'ArrowLeft') setPanelWidth(currentWidth - step);
            else if (event.key === 'ArrowRight') setPanelWidth(currentWidth + step);
            else if (event.key === 'Home') setPanelWidth(200);
            else if (event.key === 'End') setPanelWidth(window.innerWidth * 0.7);
            else return;
            event.preventDefault();
        });
    }

    // Modal
    const modalOverlay = document.getElementById('modal-overlay');
    const modal = document.getElementById('modal');
    const modalContent = document.getElementById('modal-content');
    let modalPreviousFocus = null;
    const modalClasses = [
        'course-quick-modal',
        'registration-info-modal',
        'schedule-preferences-modal',
        'professor-profile-modal',
        'custom-major-map-modal',
        'carolina-core-picker-modal',
    ];
    const closeModal = () => {
        if (modalOverlay.classList.contains('hidden')) return;
        window.AppModal.version += 1;
        modalOverlay.classList.add('hidden');
        modal.classList.remove(...modalClasses);
        modal.removeAttribute('aria-label');
        modal.removeAttribute('aria-labelledby');
        modal.removeAttribute('aria-modal');
        modal.removeAttribute('role');
        document.body.classList.remove('app-modal-open');
        modalContent.replaceChildren();
        const restore = modalPreviousFocus;
        modalPreviousFocus = null;
        requestAnimationFrame(() => restore?.isConnected && restore.focus());
    };
    window.AppModal = {
        version: 0,
        open(markup, options = {}) {
            this.version += 1;
            modalPreviousFocus = document.activeElement;
            modal.classList.remove(...modalClasses);
            if (options.className) modal.classList.add(options.className);
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-label', options.label || 'Details');
            modalContent.innerHTML = markup;
            modalOverlay.classList.remove('hidden');
            document.body.classList.add('app-modal-open');
            requestAnimationFrame(() => document.getElementById('modal-close')?.focus());
        },
        update(markup, options = {}) {
            if (modalOverlay.classList.contains('hidden')) {
                this.open(markup, options);
                return;
            }
            modal.classList.remove(...modalClasses);
            if (options.className) modal.classList.add(options.className);
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-label', options.label || 'Details');
            modalContent.innerHTML = markup;
        },
        close: closeModal,
    };
    document.getElementById('modal-close').addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (event) => {
        if (event.target === modalOverlay) closeModal();
    });
    document.addEventListener('keydown', event => {
        if (modalOverlay.classList.contains('hidden')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModal();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...modal.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
            .filter(element => !element.hidden && element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
}

// Run now if the document is already parsed, otherwise wait. Guarding on
// readyState means the boot cannot be missed because of when this file runs.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

// The built static release has a rendered root worker. The local legacy
// runtime does not, so this probe keeps registration specific to static builds.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
        void fetch('/service-worker.js', { cache: 'no-store' })
            .then(async response => {
                if (!response.ok) return;
                const source = await response.clone().text();
                if (source.includes('__STATIC_BUILD_ID__')) return;
                await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
            })
            .catch(() => {});
    }, { once: true });
}

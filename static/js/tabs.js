/* Tab navigation system */
const Tabs = {
    _listeners: [],
    _current: 'semester',

    init() {
        const nav = document.getElementById('main-tabs');
        if (!nav) return;

        nav.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-tab]');
            if (!btn) return;
            if (btn.dataset.tab === 'semester') {
                document.dispatchEvent(new CustomEvent('search-tab-reset-requested'));
            }
            this.switchTo(btn.dataset.tab);
        });

        // Restore the URL tab first, then the last tab used on this device.
        const urlTab = this.tabFromUrl(new URL(window.location.href).searchParams.get('tab'));
        const saved = localStorage.getItem('uosc-active-tab');
        const initial = urlTab || this.tabFromUrl(saved) || 'semester';
        this.switchTo(initial, { historyMode: 'none' });
        if (!urlTab) {
            history.replaceState({ ...(history.state || {}), tab: initial }, '', window.location.href);
        }
        window.addEventListener('popstate', () => this.restoreFromLocation());
    },

    tabFromUrl(value) {
        if (value === 'search' || value === 'semester') return 'semester';
        if (value === 'home') return 'semester';
        if (value === 'profile') return 'degree';
        if (value === 'export') return 'schedule';
        return ['degree', 'schedule'].includes(value) ? value : '';
    },

    writeTabHistory(tabName, mode = 'push') {
        if (mode === 'none' || tabName === 'semester') return;
        const url = new URL(window.location.href);
        url.search = '';
        url.hash = '';
        url.searchParams.set('tab', tabName);
        if (globalThis.State?.term) url.searchParams.set('term', State.term);
        const next = `${url.pathname}${url.search}`;
        const current = `${window.location.pathname}${window.location.search}`;
        const state = { tab: tabName };
        if (mode === 'replace' || next === current) history.replaceState(state, '', next);
        else history.pushState(state, '', next);
    },

    restoreFromLocation() {
        const urlTab = this.tabFromUrl(new URL(window.location.href).searchParams.get('tab'));
        const stateTab = this.tabFromUrl(history.state?.tab);
        this.switchTo(urlTab || stateTab || 'semester', { historyMode: 'none' });
    },

    switchTo(tabName, { historyMode = 'push' } = {}) {
        // Hide all tabs
        document.querySelectorAll('.main-tab').forEach(el => {
            el.classList.remove('active');
        });

        // Deactivate all nav buttons
        document.querySelectorAll('#main-tabs [data-tab]').forEach(btn => {
            btn.classList.remove('active');
        });

        // Show target tab
        const target = document.getElementById('tab-' + tabName);
        if (target) {
            target.classList.add('active');
        }

        // Activate nav button
        const btn = document.querySelector(`#main-tabs [data-tab="${tabName}"]`);
        if (btn) {
            btn.classList.add('active');
        }

        this._current = tabName;
        localStorage.setItem('uosc-active-tab', tabName);
        this.writeTabHistory(tabName, historyMode);

        // Notify listeners
        this._listeners.forEach(fn => fn(tabName));

        // Dispatch custom event for modules that listen on document
        document.dispatchEvent(new CustomEvent('tab-changed', { detail: { tab: tabName } }));
    },

    onSwitch(callback) {
        this._listeners.push(callback);
    },

    current() {
        return this._current;
    }
};

/* Tab navigation system */
const Tabs = {
    _listeners: [],
    _current: 'home',

    init() {
        const nav = document.getElementById('main-tabs');
        if (!nav) return;

        nav.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-tab]');
            if (!btn) return;
            this.switchTo(btn.dataset.tab);
        });

        // Restore last tab or default to profile
        const saved = localStorage.getItem('uosc-active-tab');
        this.switchTo(saved || 'home');
    },

    switchTo(tabName) {
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

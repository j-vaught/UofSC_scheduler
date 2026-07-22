/* Variant shell behavior for the Command Center experiment. */
const CommandCenter = {
    init() {
        const taskCanvas = document.querySelector('.command-workspace > main');
        if (taskCanvas) {
            document.querySelectorAll('body > .main-tab').forEach(tab => taskCanvas.appendChild(tab));
        }

        const launch = document.getElementById('command-search-launch');
        const context = document.getElementById('command-context');
        if (!launch || !context) return;

        const labels = {
            semester: 'Course Search',
            degree: 'Degree Planning Board',
            schedule: 'Schedule Studio',
        };

        const updateContext = (tab) => {
            const label = context.querySelector('strong');
            if (label) label.textContent = labels[tab] || labels.semester;
        };

        const openSearch = () => {
            Tabs.switchTo('semester');
            window.requestAnimationFrame(() => {
                const input = document.getElementById('keyword-input');
                input?.focus();
                input?.select();
            });
        };

        launch.addEventListener('click', openSearch);
        document.addEventListener('tab-changed', event => updateContext(event.detail?.tab));
        updateContext(Tabs.current());
        document.addEventListener('keydown', event => {
            if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target;
            if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
            event.preventDefault();
            openSearch();
        });
    },
};

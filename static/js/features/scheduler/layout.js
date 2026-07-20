/*
 * Panel sizing, dividers, and sidebar resize behaviour.
 *
 * One part of the scheduler feature, which was a single module of over two
 * thousand lines. Each part is a factory returning plain methods; index.js
 * merges them onto one object, so `this` still reaches every method and no
 * call site changed.
 *
 * Cut at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly.
 */
(function initLayoutPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SchedulerParts) root.SchedulerParts = {};
    root.SchedulerParts.createLayoutPart = api.createLayoutPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createLayoutPart(deps) {
        return {
        clearResults() {
            deps.state.solverResults = [];
            const container = document.getElementById('solver-container');
            if (container) {
                container.innerHTML = '<p class="hint">Generate schedules to compare section combinations for these courses.</p>';
            }
        },

        fitCoursePanelSizes(resultsHeight, availableHeight) {
            const available = Math.max(0, Math.round(availableHeight));
            const minimumResults = Math.min(72, available);
            const minimumSelected = Math.min(190, Math.max(0, available - minimumResults));
            const maximumResults = Math.max(minimumResults, available - minimumSelected);
            const results = Math.max(minimumResults, Math.min(maximumResults, Math.round(resultsHeight)));
            return { results, selected: Math.max(0, available - results) };
        },

        initialCourseResultsHeight(stored, availableHeight) {
            const available = Math.max(0, Number(availableHeight) || 0);
            if (available <= 0) return 0;
            const midpoint = available / 2;
            const storedHeight = Number(stored?.resultsHeight);
            const storedRatio = Number(stored?.resultsRatio);
            if (Number(stored?.version) >= 2
                && Number.isFinite(storedRatio)
                && storedRatio > 0
                && storedRatio < 1) {
                return available * storedRatio;
            }
            if (!Number.isFinite(storedHeight) || storedHeight <= 0) return midpoint;
            const isLegacyDefault = Math.abs(storedHeight - 170) <= 1;
            const isStaleTinyValue = storedHeight < Math.min(140, available * 0.24);
            return isLegacyDefault || isStaleTinyValue ? midpoint : storedHeight;
        },

        setCoursePanelSizes(resultsHeight) {
            const sidebar = document.getElementById('schedule-sidebar');
            const search = sidebar?.querySelector('.schedule-search-section');
            const divider = document.getElementById('schedule-course-divider');
            if (!sidebar || !search || !divider) return;
            const available = sidebar.clientHeight
                - search.getBoundingClientRect().height
                - divider.getBoundingClientRect().height;
            if (available <= 0) {
                sidebar.style.setProperty('--schedule-results-height', `${Math.max(72, Math.round(resultsHeight))}px`);
                return;
            }
            const { results } = this.fitCoursePanelSizes(resultsHeight, available);
            sidebar.style.setProperty('--schedule-results-height', `${results}px`);
            divider.setAttribute('aria-valuemin', '72');
            divider.setAttribute('aria-valuemax', String(Math.max(72, Math.round(available - 190))));
            divider.setAttribute('aria-valuenow', String(results));
        },

        initCourseDivider() {
            const divider = document.getElementById('schedule-course-divider');
            const sidebar = document.getElementById('schedule-sidebar');
            const results = document.getElementById('schedule-search-results');
            const search = sidebar?.querySelector('.schedule-search-section');
            if (!divider || !sidebar || !results || !search) return;

            let stored = null;
            try {
                stored = JSON.parse(localStorage.getItem('uofsc-course-divider-v1') || 'null');
            } catch (error) {
                stored = null;
            }
            let initialSizeApplied = false;
            let preferredRatio = Number(stored?.version) >= 2
                && Number.isFinite(Number(stored?.resultsRatio))
                ? Number(stored.resultsRatio)
                : null;
            const availableHeight = () => sidebar.clientHeight
                - search.getBoundingClientRect().height
                - divider.getBoundingClientRect().height;
            const rememberRatio = () => {
                const available = availableHeight();
                const resultsHeight = results.getBoundingClientRect().height;
                preferredRatio = available > 0 ? resultsHeight / available : preferredRatio;
                return { available, resultsHeight };
            };
            const savePosition = () => {
                const { available, resultsHeight } = rememberRatio();
                try {
                    localStorage.setItem('uofsc-course-divider-v1', JSON.stringify({
                        version: 2,
                        resultsHeight,
                        resultsRatio: available > 0 ? resultsHeight / available : null,
                    }));
                } catch (error) {
                    // Resizing should remain usable when browser storage is unavailable.
                }
            };
            const applyInitialSize = () => {
                const available = availableHeight();
                if (available <= 0) {
                    sidebar.style.setProperty('--schedule-results-height', '50%');
                    return;
                }
                this.setCoursePanelSizes(this.initialCourseResultsHeight(stored, available));
                rememberRatio();
                initialSizeApplied = true;
            };
            applyInitialSize();

            let startY = 0;
            let startHeight = 0;
            const move = event => this.setCoursePanelSizes(startHeight + event.clientY - startY);
            const stop = () => {
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', stop);
                document.removeEventListener('pointercancel', stop);
                divider.classList.remove('active');
                document.body.classList.remove('resizing-course-divider');
                savePosition();
            };

            divider.addEventListener('pointerdown', event => {
                startY = event.clientY;
                startHeight = results.getBoundingClientRect().height;
                divider.classList.add('active');
                document.body.classList.add('resizing-course-divider');
                document.addEventListener('pointermove', move);
                document.addEventListener('pointerup', stop);
                document.addEventListener('pointercancel', stop);
                event.preventDefault();
            });
            divider.addEventListener('keydown', event => {
                if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                const delta = event.key === 'ArrowDown' ? 24 : -24;
                this.setCoursePanelSizes(results.getBoundingClientRect().height + delta);
                savePosition();
                event.preventDefault();
            });
            window.addEventListener('resize', () => {
                const available = availableHeight();
                if (available <= 0) return;
                const ratio = preferredRatio;
                this.setCoursePanelSizes(Number.isFinite(ratio)
                    ? available * ratio
                    : results.getBoundingClientRect().height);
            });
            document.addEventListener('tab-changed', event => {
                if (event.detail?.tab !== 'schedule') return;
                if (initialSizeApplied) {
                    const available = availableHeight();
                    this.setCoursePanelSizes(Number.isFinite(preferredRatio) && available > 0
                        ? available * preferredRatio
                        : results.getBoundingClientRect().height);
                }
                else applyInitialSize();
            });
        },

        setScheduleSidebarCollapsed(collapsed, persist = true) {
            const layout = document.querySelector('#tab-schedule .schedule-layout');
            const sidebar = document.getElementById('schedule-sidebar');
            const button = document.getElementById('btn-toggle-schedule-sidebar');
            const handle = document.getElementById('schedule-sidebar-resize-handle');
            if (!layout || !sidebar || !button) return;

            const isCollapsed = Boolean(collapsed);
            layout.classList.toggle('schedule-sidebar-collapsed', isCollapsed);
            sidebar.setAttribute('aria-hidden', String(isCollapsed));
            button.setAttribute('aria-expanded', String(!isCollapsed));
            button.setAttribute('aria-label', isCollapsed ? 'Show course tools' : 'Hide course tools');
            button.title = isCollapsed ? 'Show course tools' : 'Hide course tools';
            if (!isCollapsed && this._scheduleSidebarPreferredWidth) {
                this.setScheduleSidebarWidth(this._scheduleSidebarPreferredWidth, false);
            }
            if (handle) {
                const expandedWidth = Math.round(
                    sidebar.getBoundingClientRect().width
                    || this.scheduleSidebarWidthLimits(this._scheduleSidebarPreferredWidth).width
                    || 340,
                );
                handle.setAttribute('aria-valuenow', String(isCollapsed ? 0 : expandedWidth));
                handle.setAttribute('aria-valuetext', isCollapsed ? 'Collapsed' : `${expandedWidth} pixels`);
                handle.setAttribute('tabindex', isCollapsed ? '-1' : '0');
            }

            if (persist && typeof localStorage !== 'undefined') {
                try {
                    localStorage.setItem(
                        'uofsc-schedule-sidebar-collapsed-v1',
                        String(isCollapsed),
                    );
                } catch (error) {
                    // Device storage can be unavailable without affecting the layout control.
                }
            }

            const refreshLayout = () => {
                if (!isCollapsed) {
                    const results = document.getElementById('schedule-search-results');
                    if (results) this.setCoursePanelSizes(results.getBoundingClientRect().height);
                }
                if (deps.walkingMap && deps.walkingMap._map) {
                    deps.walkingMap._map.invalidateSize();
                }
            };
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refreshLayout);
            else refreshLayout();
        },

        initScheduleSidebarCollapse() {
            const button = document.getElementById('btn-toggle-schedule-sidebar');
            if (!button) return;

            let collapsed = false;
            if (typeof localStorage !== 'undefined') {
                try {
                    collapsed = localStorage.getItem('uofsc-schedule-sidebar-collapsed-v1') === 'true';
                } catch (error) {
                    collapsed = false;
                }
            }
            this.setScheduleSidebarCollapsed(collapsed, false);
            button.addEventListener('click', () => {
                if (button.dataset?.ignoreNextClick === 'true') {
                    delete button.dataset.ignoreNextClick;
                    return;
                }
                const expanded = button.getAttribute('aria-expanded') === 'true';
                this.setScheduleSidebarCollapsed(expanded);
            });
        },

        fitScheduleSidebarWidth(width, availableWidth) {
            const minimum = 200;
            const collapseAt = 160;
            const available = Number(availableWidth) > 0 ? Number(availableWidth) : 1024;
            const contentReserve = 420;
            const maximum = Math.max(
                minimum,
                Math.min(
                    560,
                    Math.round(available * 0.55),
                    Math.round(available - 10 - contentReserve),
                ),
            );
            const requested = Number(width);
            const safeWidth = Number.isFinite(requested) && requested > 0 ? requested : 340;
            return {
                collapseAt,
                maximum,
                minimum,
                width: Math.max(minimum, Math.min(maximum, Math.round(safeWidth))),
            };
        },

        scheduleSidebarWidthLimits(width = 340) {
            const layout = document.querySelector('#tab-schedule .schedule-layout');
            const available = layout?.getBoundingClientRect().width || window.innerWidth || 1024;
            return this.fitScheduleSidebarWidth(width, available);
        },

        setScheduleSidebarWidth(width, persist = true) {
            const sidebar = document.getElementById('schedule-sidebar');
            const handle = document.getElementById('schedule-sidebar-resize-handle');
            if (!sidebar) return 0;

            const { maximum, width: nextWidth } = this.scheduleSidebarWidthLimits(width);
            sidebar.style.setProperty('--schedule-sidebar-width', `${nextWidth}px`);
            if (handle) {
                handle.setAttribute('aria-valuemin', '0');
                handle.setAttribute('aria-valuemax', String(maximum));
                handle.setAttribute('aria-valuenow', String(nextWidth));
                handle.setAttribute('aria-valuetext', `${nextWidth} pixels`);
            }
            if (persist && typeof localStorage !== 'undefined') {
                try {
                    localStorage.setItem('uofsc-schedule-sidebar-width-v1', String(nextWidth));
                } catch (error) {
                    // Device storage can be unavailable without affecting sidebar resizing.
                }
            }
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    if (deps.walkingMap && deps.walkingMap._map) {
                        deps.walkingMap._map.invalidateSize();
                    }
                });
            }
            return nextWidth;
        },

        initScheduleSidebarResize() {
            const layout = document.querySelector('#tab-schedule .schedule-layout');
            const sidebar = document.getElementById('schedule-sidebar');
            const handle = document.getElementById('schedule-sidebar-resize-handle');
            const button = document.getElementById('btn-toggle-schedule-sidebar');
            if (!layout || !sidebar || !handle || !button) return;

            let preferredWidth = 340;
            if (typeof localStorage !== 'undefined') {
                try {
                    const savedWidth = Number(localStorage.getItem('uofsc-schedule-sidebar-width-v1'));
                    if (Number.isFinite(savedWidth) && savedWidth >= 200) preferredWidth = savedWidth;
                } catch (error) {
                    preferredWidth = 340;
                }
            }
            this._scheduleSidebarPreferredWidth = preferredWidth;
            this.setScheduleSidebarWidth(preferredWidth, false);

            let startX = 0;
            let startWidth = preferredWidth;
            let pendingCollapse = false;
            let pointerStartedOnButton = false;
            let pointerMoved = false;
            const move = event => {
                const delta = event.clientX - startX;
                if (pointerStartedOnButton && !pointerMoved && Math.abs(delta) < 4) return;
                pointerMoved = true;
                if (event.cancelable) event.preventDefault();
                const requestedWidth = startWidth + delta;
                const { collapseAt } = this.scheduleSidebarWidthLimits();
                pendingCollapse = requestedWidth < collapseAt;
                if (pendingCollapse) {
                    finish(true);
                    return;
                }
                const fitted = this.scheduleSidebarWidthLimits(requestedWidth);
                this.setScheduleSidebarWidth(requestedWidth, false);
                if (requestedWidth >= fitted.minimum) {
                    this._scheduleSidebarPreferredWidth = fitted.width;
                }
            };
            const finish = commit => {
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', stop);
                document.removeEventListener('pointercancel', cancel);
                handle.classList.remove('active');
                document.body.classList.remove('resizing-schedule-sidebar');
                if (commit && pointerStartedOnButton && pointerMoved) {
                    button.dataset.ignoreNextClick = 'true';
                    const clearIgnoredClick = () => {
                        const clear = () => {
                            if (button.dataset.ignoreNextClick === 'true') {
                                delete button.dataset.ignoreNextClick;
                            }
                        };
                        if (typeof window.setTimeout === 'function') window.setTimeout(clear, 0);
                        else clear();
                    };
                    if (pendingCollapse) {
                        const clearAfterRelease = () => {
                            document.removeEventListener('pointerup', clearAfterRelease);
                            document.removeEventListener('pointercancel', clearAfterRelease);
                            clearIgnoredClick();
                        };
                        document.addEventListener('pointerup', clearAfterRelease, { once: true });
                        document.addEventListener('pointercancel', clearAfterRelease, { once: true });
                    } else {
                        clearIgnoredClick();
                    }
                }
                if (!commit) {
                    pendingCollapse = false;
                    this.setScheduleSidebarWidth(this._scheduleSidebarPreferredWidth, false);
                    pointerStartedOnButton = false;
                    pointerMoved = false;
                    return;
                }
                if (pendingCollapse) {
                    this.setScheduleSidebarWidth(this._scheduleSidebarPreferredWidth, true);
                    this.setScheduleSidebarCollapsed(true);
                } else {
                    this.setScheduleSidebarWidth(this._scheduleSidebarPreferredWidth, true);
                }
                pendingCollapse = false;
                pointerStartedOnButton = false;
                pointerMoved = false;
            };
            const stop = () => finish(true);
            const cancel = () => finish(false);
            const begin = (event, fromButton) => {
                if (
                    window.innerWidth <= 760
                    || layout.classList.contains('schedule-sidebar-collapsed')
                ) return;
                startX = event.clientX;
                startWidth = sidebar.getBoundingClientRect().width;
                pendingCollapse = false;
                pointerStartedOnButton = fromButton;
                pointerMoved = false;
                handle.classList.add('active');
                document.body.classList.add('resizing-schedule-sidebar');
                document.addEventListener('pointermove', move);
                document.addEventListener('pointerup', stop);
                document.addEventListener('pointercancel', cancel);
                if (!fromButton) event.preventDefault();
            };

            handle.addEventListener('pointerdown', event => begin(event, false));
            button.addEventListener('pointerdown', event => begin(event, true));
            handle.addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || window.innerWidth <= 760) return;
                if (layout.classList.contains('schedule-sidebar-collapsed')) return;
                const currentWidth = sidebar.getBoundingClientRect().width;
                const limits = this.scheduleSidebarWidthLimits(currentWidth);
                if (event.key === 'ArrowLeft' && currentWidth <= limits.minimum) {
                    this.setScheduleSidebarCollapsed(true);
                    event.preventDefault();
                    return;
                }
                const requestedWidth = currentWidth + (event.key === 'ArrowRight' ? 24 : -24);
                if (requestedWidth < limits.collapseAt) {
                    this.setScheduleSidebarCollapsed(true);
                } else {
                    this._scheduleSidebarPreferredWidth = this.setScheduleSidebarWidth(requestedWidth, true);
                }
                event.preventDefault();
            });
            window.addEventListener('resize', () => {
                if (window.innerWidth <= 760 || layout.classList.contains('schedule-sidebar-collapsed')) return;
                this.setScheduleSidebarWidth(this._scheduleSidebarPreferredWidth, false);
            });
        },

        initVerticalResizer() {
            const handle = document.getElementById('schedule-vertical-resizer');
            const content = document.getElementById('schedule-content');
            const workspace = content?.querySelector('.schedule-workspace');
            if (!handle || !content || !workspace) return;

            let stored = null;
            try {
                stored = JSON.parse(localStorage.getItem('uofsc-schedule-split-v1') || 'null');
            } catch (error) {
                stored = null;
            }
            const availableAtInit = this.availablePanelHeight(content, handle);
            const storedRatio = Number(stored?.workspaceRatio);
            let storedWorkspace = stored?.workspace;
            if (Number(stored?.version) >= 2
                && Number.isFinite(storedRatio)
                && storedRatio >= 0
                && storedRatio <= 1
                && availableAtInit > 0) {
                storedWorkspace = availableAtInit * storedRatio;
            } else if (Number.isFinite(Number(storedWorkspace))
                && Number(storedWorkspace) > availableAtInit - 80
                && availableAtInit > 0) {
                // Migrate the old absolute-height preference without letting a
                // shorter window start with the route map accidentally hidden.
                storedWorkspace = availableAtInit * 0.62;
            }
            const initialWorkspaceHeight = this.initialPanelHeight(
                storedWorkspace,
                workspace.getBoundingClientRect().height,
            );
            this._preferredWorkspaceRatio = Number.isFinite(storedRatio)
                && storedRatio >= 0
                && storedRatio <= 1
                ? storedRatio
                : null;
            this._preferredWorkspaceHeight = this.preferredPanelHeight(
                availableAtInit,
                this._preferredWorkspaceRatio,
                initialWorkspaceHeight,
            );
            this.setVerticalSizes(this._preferredWorkspaceHeight);

            document.addEventListener('tab-changed', event => {
                if (event.detail?.tab === 'schedule') {
                    const available = this.availablePanelHeight(content, handle);
                    this.setVerticalSizes(this.preferredPanelHeight(
                        available,
                        this._preferredWorkspaceRatio,
                        this._preferredWorkspaceHeight,
                    ));
                }
            });

            let startY = 0;
            let startWorkspace = 0;
            const resize = clientY => {
                const delta = clientY - startY;
                this.setVerticalSizes(startWorkspace + delta);
            };
            const stop = () => {
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', stop);
                document.removeEventListener('pointercancel', stop);
                handle.classList.remove('active');
                document.body.classList.remove('resizing-schedule');
                this.saveVerticalSizes();
            };
            const move = event => resize(event.clientY);

            handle.addEventListener('pointerdown', event => {
                startY = event.clientY;
                startWorkspace = workspace.getBoundingClientRect().height;
                handle.classList.add('active');
                document.body.classList.add('resizing-schedule');
                document.addEventListener('pointermove', move);
                document.addEventListener('pointerup', stop);
                document.addEventListener('pointercancel', stop);
                event.preventDefault();
            });
            handle.addEventListener('keydown', event => {
                if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                const workspaceHeight = workspace.getBoundingClientRect().height;
                const availableHeight = this.availablePanelHeight(content, handle);
                const delta = event.key === 'ArrowDown' ? 30 : -30;
                let requestedHeight = workspaceHeight + delta;
                // A collapsed panel must be reachable with the keyboard as well as
                // the pointer. Move past the endpoint snap zone on the first keypress.
                if (event.key === 'ArrowDown' && workspaceHeight <= 0) requestedHeight = 90;
                if (event.key === 'ArrowUp' && workspaceHeight >= availableHeight) {
                    requestedHeight = Math.max(0, availableHeight - 90);
                }
                this.setVerticalSizes(requestedHeight);
                this.saveVerticalSizes();
                event.preventDefault();
            });
            this._verticalResizeHandler = () => {
                const available = this.availablePanelHeight(content, handle);
                this.setVerticalSizes(this.preferredPanelHeight(
                    available,
                    this._preferredWorkspaceRatio,
                    workspace.getBoundingClientRect().height,
                ));
            };
            window.addEventListener('resize', this._verticalResizeHandler);
        },

        fitPanelSizes(workspaceHeight, availableHeight) {
            const total = Math.max(0, Math.round(availableHeight));
            if (total === 0) return { workspace: 0, map: 0 };

            const requested = Number(workspaceHeight);
            const bounded = Math.max(
                0,
                Math.min(total, Math.round(Number.isFinite(requested) ? requested : total * 0.62)),
            );
            const endpointSnap = Math.min(48, Math.max(20, Math.round(total * 0.06)));
            const workspace = bounded <= endpointSnap
                ? 0
                : bounded >= total - endpointSnap
                    ? total
                    : bounded;
            return { workspace, map: Math.max(0, total - workspace) };
        },

        initialPanelHeight(storedHeight, measuredHeight) {
            const stored = Number(storedHeight);
            if (storedHeight !== null && storedHeight !== undefined
                && Number.isFinite(stored) && stored >= 0) return stored;
            const measured = Number(measuredHeight);
            if (Number.isFinite(measured) && measured > 0) return measured;
            return 620;
        },

        preferredPanelHeight(availableHeight, preferredRatio, fallbackHeight) {
            const available = Math.max(0, Number(availableHeight) || 0);
            if (preferredRatio !== null && preferredRatio !== undefined) {
                const ratio = Number(preferredRatio);
                if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) return available * ratio;
            }
            const fallback = Number(fallbackHeight);
            const requested = Number.isFinite(fallback) ? fallback : available * 0.62;
            if (available <= 0) return requested;
            const mapReserve = Math.min(240, Math.max(160, available * 0.3));
            return Math.min(requested, Math.max(0, available - mapReserve));
        },

        availablePanelHeight(content, handle) {
            const contentStyle = window.getComputedStyle(content);
            const handleStyle = window.getComputedStyle(handle);
            const padding = parseFloat(contentStyle.paddingTop) + parseFloat(contentStyle.paddingBottom);
            const gap = parseFloat(contentStyle.rowGap || contentStyle.gap) || 0;
            const handleHeight = handle.getBoundingClientRect().height
                + parseFloat(handleStyle.marginTop)
                + parseFloat(handleStyle.marginBottom);
            return Math.max(0, content.clientHeight - padding - (gap * 2) - handleHeight);
        },

        setVerticalSizes(workspaceHeight) {
            const content = document.getElementById('schedule-content');
            const handle = document.getElementById('schedule-vertical-resizer');
            if (!content || !handle) return;
            const available = this.availablePanelHeight(content, handle);
            if (available <= 0) return;
            const { workspace, map } = this.fitPanelSizes(workspaceHeight, available);
            this._preferredWorkspaceHeight = workspace;
            this._preferredWorkspaceRatio = available > 0 ? workspace / available : null;
            content.style.setProperty('--schedule-workspace-height', `${workspace}px`);
            content.classList.toggle('schedule-workspace-hidden', workspace === 0);
            content.classList.toggle('schedule-map-hidden', map === 0);
            handle.setAttribute('aria-valuemin', '0');
            handle.setAttribute('aria-valuemax', String(available));
            handle.setAttribute('aria-valuenow', String(workspace));
            handle.setAttribute(
                'aria-valuetext',
                workspace === 0
                    ? 'Map only'
                    : map === 0
                        ? 'Calendar and schedule options only'
                        : `${workspace} pixels for calendar and schedule options; ${map} pixels for map`,
            );
            if (deps.walkingMap && deps.walkingMap._map) {
                requestAnimationFrame(() => deps.walkingMap._map.invalidateSize());
            }
        },

        saveVerticalSizes() {
            const content = document.getElementById('schedule-content');
            const handle = document.getElementById('schedule-vertical-resizer');
            const workspace = Number(document.querySelector('.schedule-workspace')
                ?.getBoundingClientRect().height);
            if (!Number.isFinite(workspace)) return;
            const available = content && handle ? this.availablePanelHeight(content, handle) : 0;
            try {
                localStorage.setItem('uofsc-schedule-split-v1', JSON.stringify({
                    version: 2,
                    workspace,
                    workspaceRatio: Number.isFinite(Number(this._preferredWorkspaceRatio))
                        ? this._preferredWorkspaceRatio
                        : (available > 0 ? workspace / available : null),
                }));
            } catch (error) {
                // A denied or full storage area must not break schedule resizing.
            }
        },

        };
    }

    return { createLayoutPart };
}));

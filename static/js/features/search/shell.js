/*
 * Startup, browse state, URL history, the filter panel, and doSearch.
 *
 * One of five parts of the search feature, which was a single 4,248-line
 * module. Each part is a factory returning plain methods; index.js merges them
 * onto one object, so `this` still reaches every method regardless of which
 * file it lives in and no call site changed.
 *
 * The split is at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly -- asserted before anything was
 * written. Sorting or regrouping methods would not have that property.
 */
(function initShellPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SearchParts) root.SearchParts = {};
    root.SearchParts.createShellPart = api.createShellPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createShellPart(deps) {
        return {
        init() {
            // Load subject list for fuzzy matching
            this.loadSubjects();

            document.getElementById('btn-search').addEventListener('click', () => this.submitSearch());
            const keywordInput = document.getElementById('keyword-input');
            keywordInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.submitSearch();
            });
            keywordInput.addEventListener('input', () => { this._topicSearchMode = false; });

            // Clear button
            const clearBtn = document.getElementById('search-clear');
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    this.resetToCleanSearch({ historyMode: 'push' });
                });
            }

            // Filter toggle
            const filterToggle = document.getElementById('filter-toggle');
            const filterPanel = document.getElementById('filter-panel');
            const filterBackdrop = document.getElementById('filter-backdrop');
            const filterArrow = document.getElementById('filter-arrow');
            if (filterPanel && filterBackdrop && filterPanel.parentElement !== document.body) {
                document.body.append(filterBackdrop, filterPanel);
            }
            if (filterToggle && filterPanel) {
                filterToggle.addEventListener('click', event => {
                    event.stopPropagation();
                    const shouldOpen = filterPanel.classList.contains('hidden');
                    if (shouldOpen) {
                        this.openFilters();
                    } else {
                        this.closeFilters();
                    }
                });
                filterPanel.addEventListener('click', event => event.stopPropagation());
                document.addEventListener('click', () => this.closeFilters());
                document.addEventListener('keydown', event => {
                    if (filterPanel.classList.contains('hidden')) return;
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        this.closeFilters();
                        return;
                    }
                    if (event.key !== 'Tab') return;
                    const focusable = [...filterPanel.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
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

            filterBackdrop?.addEventListener('click', () => this.closeFilters());
            document.getElementById('btn-close-filters')?.addEventListener('click', () => this.closeFilters());
            document.getElementById('browse-close-details')?.addEventListener('click', () => this.closeCourseDetail());
            document.querySelectorAll('[data-course-tab]').forEach(button => {
                button.addEventListener('click', () => this.setCourseDetailTab(button.dataset.courseTab, true));
                button.addEventListener('keydown', event => this.handleCourseTabKeydown(event));
            });
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && this._browseState === 'detail'
                    && document.getElementById('modal-overlay')?.classList.contains('hidden')
                    && document.getElementById('filter-panel')?.classList.contains('hidden')) {
                    this.closeCourseDetail();
                }
            });

            document.querySelectorAll('[data-search-example]').forEach(button => {
                button.addEventListener('click', () => {
                    const input = this.activeSearchInput();
                    input.value = button.dataset.searchExample || '';
                    this.submitSearch();
                });
            });
            document.getElementById('search-syntax-open')?.addEventListener('click', event => {
                event.stopPropagation();
                const guide = document.getElementById('search-syntax-guide');
                if (guide) guide.open = true;
                this.openFilters({ focusId: 'search-syntax-guide' });
            });

            document.addEventListener('search-tab-reset-requested', () => {
                this.resetToCleanSearch({ historyMode: 'push' });
            });
            window.addEventListener('popstate', () => this.restoreFromLocation());

            const additionalToggle = document.getElementById('additional-filter-toggle');
            const additionalPanel = document.getElementById('additional-filter-panel');
            const additionalArrow = document.getElementById('additional-filter-arrow');
            if (additionalToggle && additionalPanel) {
                additionalToggle.addEventListener('click', () => {
                    const willExpand = additionalPanel.classList.contains('hidden');
                    additionalPanel.classList.toggle('hidden', !willExpand);
                    additionalArrow.classList.toggle('open', willExpand);
                    additionalToggle.setAttribute('aria-expanded', String(willExpand));
                });
            }

            document.getElementById('btn-apply-filters')?.addEventListener('click', () => {
                this.updateActiveFilterChips();
                if (this.activeSearchInput()?.value.trim() || this.hasCourseScopeInput()) this.doSearch();
                else this.closeFilters();
            });
            document.getElementById('btn-clear-filters')?.addEventListener('click', () => this.clearFilters());
            this.setBrowseState('empty');
            this.updateActiveFilterChips();
            const preload = () => {
                if (document.getElementById('filter-ai-search')?.checked) {
                    this.prepareSmartSearch({ background: true }).catch(() => {});
                }
            };
            preload();
            requestAnimationFrame(() => this.restoreFromLocation({ initial: true }));
        },

        activeSearchInput() {
            return document.getElementById('keyword-input');
        },

        hasCourseScopeInput() {
            return Boolean(
                document.getElementById('filter-scope-subjects')?.value.trim()
                || document.getElementById('filter-scope-numbers')?.value.trim(),
            );
        },

        setBrowseState(state) {
            const workspace = document.getElementById('browse-workspace');
            if (!workspace) return;
            this._browseState = state;
            workspace.classList.remove('browse-empty', 'browse-results', 'browse-detail');
            workspace.classList.add(`browse-${state}`);
        },

        // The read half of the browse-state seam. detail.js lives in another part
        // and used to compare the raw _browseState field; going through here keeps
        // that field owned by the two methods on either side of it, so a rename is
        // a local change rather than a hunt across parts.
        browseState() {
            return this._browseState;
        },

        submitSearch() {
            this.cancelLocationRestore();
            if (this._browseState === 'detail') this.leaveCourseDetail({ focus: false });
            this._mainSearchQuery = '';
            this._relatedSearchOrigin = '';
            this._topicSearchMode = false;
            return this.doSearch();
        },

        resetToCleanSearch({ historyMode = 'push' } = {}) {
            if (historyMode !== 'none') this.cancelLocationRestore();
            this._searchId += 1;
            this._detailToken = (this._detailToken || 0) + 1;
            if (this._browseState === 'detail') this.leaveCourseDetail({ focus: false });
            this._mainSearchQuery = '';
            this._relatedSearchOrigin = '';
            this._directSearchOnce = false;
            this._topicSearchMode = false;
            const input = this.activeSearchInput();
            if (input) input.value = '';
            this.clearSearchErrors();
            document.getElementById('search-results').innerHTML = '<p class="hint">Search a subject above to see available courses.</p>';
            this.setBrowseState('empty');
            if (historyMode !== 'none') this.writeSearchHistory('', { mode: historyMode });
            requestAnimationFrame(() => input?.focus());
        },

        searchUrl({
            query = '',
            direct = false,
            origin = '',
            scopeOnly = false,
            topic = false,
        } = {}) {
            const url = new URL(window.location.href);
            url.search = '';
            url.hash = '';
            url.searchParams.set('tab', 'search');
            url.searchParams.set('term', deps.state.term);
            if (query) url.searchParams.set('q', query);
            if (direct) url.searchParams.set('direct', '1');
            if (origin) url.searchParams.set('from', origin);
            if (scopeOnly) url.searchParams.set('scopeSearch', '1');
            if (topic) url.searchParams.set('topic', '1');

            const checkboxParams = [
                ['filter-show-all', 'all'],
                ['filter-open', 'open'],
                ['filter-eligible', 'eligible'],
            ];
            checkboxParams.forEach(([id, parameter]) => {
                if (document.getElementById(id)?.checked) url.searchParams.set(parameter, '1');
            });
            const selectParams = [
                ['filter-method', 'method'],
                ['filter-carolina-core', 'core'],
                ['filter-part-of-term', 'part'],
                ['filter-course-attribute', 'attribute'],
                ['filter-honors', 'honors'],
                ['filter-meeting-pattern', 'meetings'],
                ['filter-size-mode', 'sizeMode'],
                ['filter-size-value', 'size'],
                ['filter-avail-mode', 'seatMode'],
                ['filter-avail-value', 'seats'],
            ];
            selectParams.forEach(([id, parameter]) => {
                const value = document.getElementById(id)?.value;
                if (value) url.searchParams.set(parameter, value);
            });
            const textParams = [
                ['filter-scope-subjects', 'subjects'],
                ['filter-scope-numbers', 'numbers'],
            ];
            textParams.forEach(([id, parameter]) => {
                const value = document.getElementById(id)?.value.trim();
                if (value) url.searchParams.set(parameter, value);
            });
            return url;
        },

        canonicalSearchQuery(query) {
            const normalized = String(query || '')
                .trim()
                .replace(/[–—]/g, '-')
                .replace(/\s+/g, ' ');
            const subjectQuery = normalized.match(/^([A-Za-z]{3,4})\s*(.*)$/);
            if (subjectQuery) {
                const subject = subjectQuery[1].toUpperCase();
                const rest = subjectQuery[2].trim();
                if (!rest) return subject;
                if (/[\dXx*#_?%]/.test(rest)) {
                    return `${subject} ${rest.toUpperCase().replace(/\s*-\s*/g, '-')}`;
                }
            }
            return normalized.toLowerCase();
        },

        searchCacheKey({ query = '', direct = false, origin = '' } = {}) {
            const url = this.searchUrl({
                query: this.canonicalSearchQuery(query),
                direct,
                origin,
                topic: this._topicSearchMode,
            });
            const completedCourses = document.getElementById('filter-eligible')?.checked
                ? [...(deps.state.completedCourses || [])].map(code => String(code).toUpperCase()).sort()
                : [];
            const eligibilityState = completedCourses.length
                ? `|completed=${completedCourses.join(',')}`
                : '';
            return `${url.pathname}${url.search}${eligibilityState}`;
        },

        renderAndCacheSearch(cacheKey, results, count, prereqData, eligibleOnly, searchTerms = null) {
            const view = {
                results,
                count,
                prereqData,
                eligibleOnly,
                searchTerms,
                fallbackNotice: this._semanticFallbackNotice,
                mainSearchQuery: this._mainSearchQuery,
                relatedSearchOrigin: this._relatedSearchOrigin,
                storedAt: Date.now(),
            };
            if (cacheKey) {
                this._searchViewCache.delete(cacheKey);
                this._searchViewCache.set(cacheKey, view);
                while (this._searchViewCache.size > this._searchCacheMaxEntries) {
                    this._searchViewCache.delete(this._searchViewCache.keys().next().value);
                }
            }
            this.renderResults(results, count, prereqData, eligibleOnly, searchTerms);
        },

        restoreCachedSearch(cacheKey) {
            const view = this._searchViewCache.get(cacheKey);
            if (!view) return false;
            if (Date.now() - view.storedAt > this._searchCacheTtlMs) {
                this._searchViewCache.delete(cacheKey);
                return false;
            }
            this._searchViewCache.delete(cacheKey);
            this._searchViewCache.set(cacheKey, view);
            this._searchId += 1;
            this._mainSearchQuery = view.mainSearchQuery;
            this._relatedSearchOrigin = view.relatedSearchOrigin;
            this._semanticFallbackNotice = view.fallbackNotice || '';
            this.renderResults(
                view.results,
                view.count,
                view.prereqData,
                view.eligibleOnly,
                view.searchTerms,
            );
            return true;
        },

        writeSearchHistory(query, {
            mode = 'push',
            direct = false,
            origin = '',
            scopeOnly = false,
            topic = this._topicSearchMode,
        } = {}) {
            if (this._restoringHistory || mode === 'none') return;
            const url = this.searchUrl({ query, direct, origin, scopeOnly, topic });
            const next = `${url.pathname}${url.search}`;
            const current = `${window.location.pathname}${window.location.search}`;
            const state = { search: true, relatedSearch: Boolean(origin), query, origin, topic };
            if (mode === 'replace' || next === current) history.replaceState(state, '', next);
            else history.pushState(state, '', next);
        },

        normalizeCourseCode(value) {
            // Prefer the shared CourseCode util, injected as a collaborator so this
            // fenced module never reaches an app global. Its parse() is the strict
            // reading these call sites need -- a real code or '' -- and it accepts
            // 2-letter subjects, which the historical local regex below wrongly
            // rejects. The delegation is what fixes that bug when the util is present.
            if (deps.courseCode) return deps.courseCode.parse(value);
            // Fallback for the bare-sandbox tests ({} deps), where courseCode is
            // undefined. This is the original, stricter behaviour: 3-4 letters and
            // exactly three digits only. It is kept solely here, and only because
            // those tests construct without the collaborator.
            const match = String(value || '').trim().toUpperCase()
                .match(/^([A-Z]{3,4})\s*(\d{3}[A-Z]?)$/);
            return match ? `${match[1]} ${match[2]}` : '';
        },

        // The read half of the detail-route seam: what the URL/history bookkeeping
        // needs to know about the open course. detail.js owns these three fields;
        // shell.js and results.js reach them through here so a rename stays local.
        detailRouteState() {
            return {
                code: this._detailGroup?.code ?? null,
                crn: this._detailSectionCrn || '',
                tab: this._detailTab,
            };
        },

        writeCourseDetailHistory(options = {}) {
            const route = this.detailRouteState();
            const {
                mode = 'replace',
                course = route.code || '',
                crn = route.crn,
                panel = route.tab,
            } = options;
            if (this._restoringHistory || mode === 'none') return;
            const url = new URL(window.location.href);
            const normalizedCourse = this.normalizeCourseCode(course);
            const state = { ...(history.state || {}), search: true };
            if (normalizedCourse) {
                url.searchParams.set('tab', 'search');
                url.searchParams.set('term', deps.state.term);
                url.searchParams.set('course', normalizedCourse);
                if (crn) url.searchParams.set('crn', String(crn));
                else url.searchParams.delete('crn');
                if (panel && panel !== 'overview') url.searchParams.set('panel', panel);
                else url.searchParams.delete('panel');
                state.courseDetail = true;
                state.course = normalizedCourse;
                if (mode === 'push') {
                    state.detailFromRelatedSearch = Boolean(state.relatedSearch);
                    delete state.relatedSearch;
                    const parent = new URL(url.href);
                    parent.searchParams.delete('course');
                    parent.searchParams.delete('crn');
                    parent.searchParams.delete('panel');
                    state.detailParent = `${parent.pathname}${parent.search}`;
                }
            } else {
                url.searchParams.delete('course');
                url.searchParams.delete('crn');
                url.searchParams.delete('panel');
                delete state.courseDetail;
                delete state.course;
                delete state.detailParent;
                delete state.detailFromRelatedSearch;
            }
            const next = `${url.pathname}${url.search}`;
            const current = `${window.location.pathname}${window.location.search}`;
            if (mode === 'push' && next !== current) history.pushState(state, '', next);
            else history.replaceState(state, '', next);
        },

        async courseDetailGroup(courseCode, requestedCrn = '') {
            const normalized = this.normalizeCourseCode(courseCode);
            if (!normalized) return null;
            const existing = (deps.state.courseGroups || []).find(group => group.code === normalized);
            if (existing && (!requestedCrn || existing.sections.some(section => (
                String(section.crn) === String(requestedCrn)
            )))) return existing;

            const subject = normalized.split(' ')[0];
            const [liveResult, bulletinResult] = await Promise.allSettled([
                deps.api.searchCourses(deps.state.term, [{ field: 'subject', value: subject }]),
                deps.api.bulletinSearch(subject),
            ]);
            const sections = liveResult.status === 'fulfilled'
                ? (liveResult.value.results || []).filter(section => section.code === normalized)
                : [];
            const catalog = bulletinResult.status === 'fulfilled'
                ? (bulletinResult.value.results || []).find(course => course.code === normalized)
                : null;
            if (!sections.length && !catalog) return existing || null;
            return {
                code: normalized,
                title: sections[0]?.title || catalog?.title || normalized,
                sections: sections.length ? sections : [{
                    code: normalized,
                    title: catalog?.title || normalized,
                    key: catalog?.key,
                    _isCatalog: true,
                }],
            };
        },

        async restoreCourseDetail(params, restoreId) {
            const course = this.normalizeCourseCode(params.get('course'));
            if (!course) return false;
            const crn = String(params.get('crn') || '');
            const panel = params.get('panel') || 'overview';
            const group = await this.courseDetailGroup(course, crn);
            if (restoreId !== this._restoreId || !group) return false;
            this.showCourseDetail(group, {
                sectionCrn: crn,
                panel,
                historyMode: 'none',
            });
            return true;
        },

        cancelLocationRestore() {
            this._restoreId += 1;
            this._restoringHistory = false;
            deps.api.setForceRefreshLive?.(false);
        },

        applyFiltersFromLocation(params) {
            const checked = [
                ['filter-show-all', 'all'],
                ['filter-open', 'open'],
                ['filter-eligible', 'eligible'],
            ];
            checked.forEach(([id, parameter]) => {
                const element = document.getElementById(id);
                if (element) element.checked = params.get(parameter) === '1';
            });
            const values = [
                ['filter-method', 'method'],
                ['filter-carolina-core', 'core'],
                ['filter-part-of-term', 'part'],
                ['filter-course-attribute', 'attribute'],
                ['filter-honors', 'honors'],
                ['filter-meeting-pattern', 'meetings'],
                ['filter-size-mode', 'sizeMode'],
                ['filter-size-value', 'size'],
                ['filter-avail-mode', 'seatMode'],
                ['filter-avail-value', 'seats'],
            ];
            values.forEach(([id, parameter]) => {
                const element = document.getElementById(id);
                if (element) element.value = params.get(parameter) || '';
            });
            const textValues = [
                ['filter-scope-subjects', 'subjects'],
                ['filter-scope-numbers', 'numbers'],
            ];
            textValues.forEach(([id, parameter]) => {
                const element = document.getElementById(id);
                if (element) element.value = params.get(parameter) || '';
            });
            const aiToggle = document.getElementById('filter-ai-search');
            if (aiToggle) aiToggle.checked = !(params.get('direct') === '1' && !params.get('from'));
            this.updateActiveFilterChips();
        },

        async restoreFromLocation({ initial = false } = {}) {
            const params = new URL(window.location.href).searchParams;
            if (params.get('tab') !== 'search' && !params.has('q') && !params.has('course')) return;
            const restoreId = ++this._restoreId;
            const refreshLiveData = initial && deps.api.shouldRefreshAfterReload?.();
            if (refreshLiveData) deps.api.setForceRefreshLive(true);
            const requestedCourse = this.normalizeCourseCode(params.get('course'));
            const query = params.get('q') || requestedCourse;
            const hasScopeQuery = params.get('scopeSearch') === '1'
                && Boolean(params.get('subjects') || params.get('numbers'));
            this._restoringHistory = true;
            const term = params.get('term');
            const termSelect = document.getElementById('term-select');
            if (term && termSelect?.querySelector(`option[value="${term}"]`)) {
                deps.state.term = term;
                termSelect.value = term;
            }
            this.applyFiltersFromLocation(params);
            this._mainSearchQuery = '';
            this._relatedSearchOrigin = params.get('from') || '';
            this._topicSearchMode = params.get('topic') === '1';
            this._directSearchOnce = params.get('direct') === '1'
                || (!params.has('q') && Boolean(requestedCourse));
            const input = this.activeSearchInput();
            if (input) input.value = query;
            if (deps.tabs) deps.tabs.switchTo('semester');
            if (!query && !hasScopeQuery) {
                this.resetToCleanSearch({ historyMode: 'none' });
                if (refreshLiveData) deps.api.setForceRefreshLive(false);
                if (restoreId === this._restoreId) this._restoringHistory = false;
                return;
            }
            try {
                if (!requestedCourse && this._browseState === 'detail') {
                    this.closeCourseDetail({ historyMode: 'none' });
                }
                await this.doSearch({ historyMode: 'none' });
                if (restoreId !== this._restoreId) return;
                if (requestedCourse) await this.restoreCourseDetail(params, restoreId);
            } finally {
                if (refreshLiveData) deps.api.setForceRefreshLive(false);
                if (restoreId === this._restoreId) this._restoringHistory = false;
            }
        },


        openRegularSearch(term) {
            const regularInput = document.getElementById('keyword-input');
            if (!regularInput) return;
            const origin = this._mainSearchQuery || regularInput.value.trim();
            this._searchId += 1;
            regularInput.value = term;
            this._relatedSearchOrigin = origin;
            this._directSearchOnce = true;
            this._topicSearchMode = false;
            regularInput.focus();
            this.doSearch();
        },

        returnToMainSearch() {
            if (history.state?.detailFromRelatedSearch) {
                history.go(-2);
                return;
            }
            if (history.state?.relatedSearch) {
                history.back();
                return;
            }
            const origin = this._relatedSearchOrigin;
            if (!origin) return;
            this._relatedSearchOrigin = '';
            this._mainSearchQuery = '';
            const input = this.activeSearchInput();
            if (input) input.value = origin;
            this.doSearch({ historyMode: 'replace' });
        },

        async openCourseFromExternal(group, sectionCrn = '') {
            if (!group?.code) return;
            const input = this.activeSearchInput();
            if (input) input.value = group.code;
            this._mainSearchQuery = '';
            this._relatedSearchOrigin = '';
            this._directSearchOnce = true;
            await this.doSearch({ historyMode: 'push' });
            const searchGroup = (deps.state.courseGroups || []).find(item => item.code === group.code);
            const requestedSection = this.detailLiveSections(group).find(section => (
                String(section.crn) === String(sectionCrn)
            ));
            const sectionMissing = requestedSection && !(searchGroup?.sections || []).some(section => (
                String(section.crn) === String(sectionCrn)
            ));
            const detailGroup = searchGroup
                ? (sectionMissing ? {
                    ...searchGroup,
                    sections: [...(searchGroup.sections || []), requestedSection],
                } : searchGroup)
                : group;
            this.showCourseDetail(detailGroup, { sectionCrn, historyMode: 'push' });
        },

        setSmartModelLoading(active, stage = '') {
            const input = document.getElementById('keyword-input');
            const loading = document.getElementById('smart-model-loading');
            const label = document.getElementById('smart-model-loading-stage');
            const submit = document.getElementById('btn-search');
            const workspace = document.getElementById('browse-workspace');
            workspace?.classList.toggle('smart-search-busy', active);
            if (label && stage) label.textContent = stage;
            loading?.classList.toggle('hidden', !active);
            if (input) {
                input.disabled = active;
                input.setAttribute('aria-busy', String(active));
            }
            if (submit) submit.disabled = active;
            if (!active) {
                input?.focus();
            }
        },

        async prepareSmartSearch({ background = false } = {}) {
            if (this._extractor && this._phraseData) return true;
            if (this._smartModelPromise) return this._smartModelPromise;
            this._smartModelPromise = (async () => {
                if (!background) this.setSmartModelLoading(true, 'Preparing meaning-based search');
                await Promise.all([this._loadExtractor(), this._loadPhraseData()]);
                await this._embedQuery('course search');
                if (!background) this.setSmartModelLoading(false);
                return true;
            })().catch(error => {
                this._smartModelPromise = null;
                if (!background) this.setSmartModelLoading(false);
                throw error;
            });
            return this._smartModelPromise;
        },

        openFilters({ focusId = 'btn-close-filters' } = {}) {
            const panel = document.getElementById('filter-panel');
            const backdrop = document.getElementById('filter-backdrop');
            const toggle = document.getElementById('filter-toggle');
            const arrow = document.getElementById('filter-arrow');
            if (!panel) return;
            this._filterPreviousFocus = document.activeElement;
            panel.classList.remove('hidden');
            backdrop?.classList.remove('hidden');
            document.body?.classList.add('filter-modal-open');
            arrow?.classList.add('open');
            toggle?.setAttribute('aria-expanded', 'true');
            const target = document.getElementById(focusId);
            requestAnimationFrame(() => {
                if (target?.tagName === 'DETAILS') target.querySelector('summary')?.focus();
                else target?.focus();
            });
        },

        closeFilters() {
            const panel = document.getElementById('filter-panel');
            const backdrop = document.getElementById('filter-backdrop');
            const toggle = document.getElementById('filter-toggle');
            const arrow = document.getElementById('filter-arrow');
            const wasOpen = Boolean(panel && !panel.classList.contains('hidden'));
            panel?.classList.add('hidden');
            backdrop?.classList.add('hidden');
            document.body?.classList.remove('filter-modal-open');
            arrow?.classList.remove('open');
            toggle?.setAttribute('aria-expanded', 'false');
            if (wasOpen) {
                const restore = this._filterPreviousFocus;
                this._filterPreviousFocus = null;
                requestAnimationFrame(() => {
                    if (restore?.isConnected) restore.focus();
                    else toggle?.focus();
                });
            }
        },

        activeFilterEntries() {
            const entries = [];
            const checked = (id, label) => {
                if (document.getElementById(id)?.checked) entries.push({ ids: [id], label });
            };
            const selected = (id, prefix) => {
                const element = document.getElementById(id);
                if (!element?.value) return;
                const text = element.options?.[element.selectedIndex]?.text || element.value;
                entries.push({ ids: [id], label: `${prefix}: ${text}` });
            };
            checked('filter-show-all', 'All catalog courses');
            checked('filter-open', 'Open sections');
            checked('filter-eligible', 'Prerequisites met');
            if (document.getElementById('filter-ai-search')?.checked === false) {
                entries.push({ ids: ['filter-ai-search'], label: 'Direct search only', restore: true });
            }
            const subjectScope = document.getElementById('filter-scope-subjects')?.value.trim();
            const numberScope = document.getElementById('filter-scope-numbers')?.value.trim();
            if (subjectScope) {
                entries.push({ ids: ['filter-scope-subjects'], label: `Subjects: ${subjectScope}` });
            }
            if (numberScope) {
                entries.push({ ids: ['filter-scope-numbers'], label: `Course numbers: ${numberScope}` });
            }
            selected('filter-method', 'Method');
            selected('filter-carolina-core', 'Core');
            selected('filter-part-of-term', 'Term');
            selected('filter-course-attribute', 'Attribute');
            selected('filter-honors', 'Honors');
            selected('filter-meeting-pattern', 'Meetings');
            const sizeMode = document.getElementById('filter-size-mode');
            const sizeValue = document.getElementById('filter-size-value');
            if (sizeMode?.value && sizeValue?.value) {
                entries.push({ ids: ['filter-size-mode', 'filter-size-value'], label: `Class size: ${sizeMode.value} ${sizeValue.value}` });
            }
            const availabilityMode = document.getElementById('filter-avail-mode');
            const availabilityValue = document.getElementById('filter-avail-value');
            if (availabilityMode?.value && availabilityValue?.value !== '') {
                entries.push({ ids: ['filter-avail-mode', 'filter-avail-value'], label: `Seats: ${availabilityMode.value} ${availabilityValue.value}` });
            }
            return entries;
        },

        updateActiveFilterChips() {
            const container = document.getElementById('active-filter-chips');
            if (!container) return;
            const entries = this.activeFilterEntries();
            const filterToggle = document.getElementById('filter-toggle');
            filterToggle?.classList.toggle('has-active-filters', entries.length > 0);
            filterToggle?.setAttribute(
                'aria-label',
                entries.length ? `Filters, ${entries.length} active` : 'Filters',
            );
            container.innerHTML = '';
            entries.forEach(entry => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'active-filter-chip';
                button.appendChild(document.createTextNode(entry.label));
                const remove = document.createElement('span');
                remove.setAttribute('aria-hidden', 'true');
                remove.textContent = '×';
                button.appendChild(remove);
                button.setAttribute('aria-label', `Remove filter ${entry.label}`);
                button.addEventListener('click', () => {
                    entry.ids.forEach(id => {
                        const element = document.getElementById(id);
                        if (!element) return;
                        if (element.type === 'checkbox') element.checked = Boolean(entry.restore);
                        else element.value = '';
                    });
                    this.updateActiveFilterChips();
                    if (this.activeSearchInput()?.value.trim() || this.hasCourseScopeInput()) this.doSearch();
                    else this.resetToCleanSearch({ historyMode: 'push' });
                });
                container.appendChild(button);
            });
        },

        clearFilters() {
            document.querySelectorAll('#filter-panel input[type="checkbox"]').forEach(input => {
                input.checked = false;
            });
            const aiToggle = document.getElementById('filter-ai-search');
            if (aiToggle) aiToggle.checked = true;
            document.querySelectorAll('#filter-panel select').forEach(select => {
                select.selectedIndex = 0;
            });
            document.querySelectorAll('#filter-panel input[type="number"]').forEach(input => {
                input.value = '';
            });
            document.querySelectorAll('#filter-panel input[type="text"]').forEach(input => {
                input.value = '';
            });
            this.updateActiveFilterChips();
            this.closeFilters();
            if (this.activeSearchInput()?.value.trim()) this.doSearch();
            else this.resetToCleanSearch({ historyMode: 'push' });
        },

        // A search id is stale once a newer search (or restore, or reset) has bumped
        // _searchId past it. Every in-flight completion checks this before it renders,
        // so a slow response cannot overwrite a newer one. The comparison was spread
        // raw across shell and query; this is the one place that knows the rule.
        isStale(searchId) {
            return searchId !== this._searchId;
        },

        // The section-filter panel, read into the one shape applySectionFilters
        // consumes. Both search paths -- the semantic branch and the direct criteria
        // fetch -- call this, so a filter added here reaches both. It used to be an
        // object literal built twice, and a filter added to one copy silently skipped
        // the other.
        buildFilterCriteria() {
            const availRaw = document.getElementById('filter-avail-value').value.trim();
            return {
                openOnly: document.getElementById('filter-open').checked,
                instructionalMethod: document.getElementById('filter-method').value,
                carolinaCore: document.getElementById('filter-carolina-core').value,
                partOfTerm: document.getElementById('filter-part-of-term').value,
                courseAttribute: document.getElementById('filter-course-attribute').value,
                honors: document.getElementById('filter-honors').value,
                meetingPattern: document.getElementById('filter-meeting-pattern').value,
                sizeMode: document.getElementById('filter-size-mode').value,
                sizeValue: parseInt(document.getElementById('filter-size-value').value) || 0,
                availMode: document.getElementById('filter-avail-mode').value,
                availValue: availRaw === '' ? null : Number(availRaw),
            };
        },

        /*
         * The regex dispatch that turns a direct query into search criteria.
         *
         * Pulled out of doSearch so the classification can be unit-tested and so the
         * semantic-vs-direct decision reads a return value rather than a fall-through
         * off the end of a 140-line chain. It reaches _resolveSubject,
         * courseNumberRangeFilter and liveCourseRangeFilter through `this`, exactly
         * as the inline chain did.
         *
         * Returns { criteria, resultFilter, subject } for every query it can place,
         * a plain keyword included. Returns null when _resolveSubject could not
         * resolve the subject -- it has already shown a fuzzy-suggestion hint, so the
         * caller must stop rather than hint twice. Throws a user-facing Error for a
         * hard-invalid query (a 4-digit number, a sub-5-character keyword, a bad
         * range pattern); the caller turns that into a hint.
         */
        classifyQuery(directQuery, { treatAsTopic = false, courseScope } = {}) {
            const kw = String(directQuery || '').trim();
            const criteria = [];
            let subject = '';
            let resultFilter = null;   // function(code) → boolean for +, wildcards, partial

            // Wildcard characters that stand for "any digit"
            const WILDCARD = /[xX*#_?%]/;
            const hasWildcard = (s) => WILDCARD.test(s);

            // Normalising the box's text is a courtesy the inline chain did too;
            // guard it so the classifier still runs where there is no input element.
            const searchInput = this.activeSearchInput();

            // A scope without a topic lists all courses inside the selected bounds.
            if (!kw && courseScope?.active) {
                // Scope is applied to API results by the caller.

            // 3-4 letter subject code only (e.g. "CSCE", "MATH")
            } else if (!treatAsTopic && /^[A-Za-z]{3,4}$/i.test(kw)) {
                subject = this._resolveSubject(kw);
                if (!subject) return null;
                if (searchInput) searchInput.value = subject;
                criteria.push({ field: 'subject', value: subject });

            // Inclusive numeric range: "CSCE 140-150" or "CSCE 140 - 150"
            } else if (!treatAsTopic && /^[A-Za-z]{3,4}\s*\d{3}\s*(?:-|–|—|to)\s*\d{3}$/i.test(kw)) {
                const m = kw.match(/^([A-Za-z]{3,4})\s*(\d{3})\s*(?:-|–|—|to)\s*(\d{3})$/i);
                subject = this._resolveSubject(m[1]);
                if (!subject) return null;
                // courseNumberRangeFilter throws on an inverted range; the caller
                // turns that into a hint, exactly as the inline try/catch did.
                resultFilter = this.courseNumberRangeFilter(subject, m[2], m[3]);
                criteria.push({ field: 'subject', value: subject });

            // Range/wildcard course code: "CSCE 500+", "CSCE 5xx", "CSCE 5xxL", "CSCE x77"
            } else if (!treatAsTopic && /^[A-Za-z]{3,4}\s*[\dxX*#_?%]{1,3}\+?[A-Za-z]?$/i.test(kw) &&
                       (kw.includes('+') || hasWildcard(kw))) {
                const m = kw.match(/^([A-Za-z]{3,4})\s*([\dxX*#_?%]{1,3}\+?[A-Za-z]?)$/i);
                subject = this._resolveSubject(m[1]);
                if (!subject) return null;
                const numPart = m[2].toUpperCase();
                // The shared live range filter. Identical to the old local builder for
                // this already-upper-cased input, and the one place the pattern lives.
                resultFilter = this.liveCourseRangeFilter(numPart);
                if (!resultFilter) throw new Error('Invalid range pattern. Try CSCE 500+, CSCE 5xx, or CSCE 5xxL.');
                criteria.push({ field: 'subject', value: subject });

            // Partial course number: "CSCE 5" or "CSCE 55" → prefix match (implicit wildcards)
            } else if (!treatAsTopic && /^[A-Za-z]{3,4}\s*\d{1,2}$/i.test(kw)) {
                const m = kw.match(/^([A-Za-z]{3,4})\s*(\d{1,2})$/i);
                subject = this._resolveSubject(m[1]);
                if (!subject) return null;
                const partial = m[2];
                const padded = (partial + 'xx').slice(0, 3);
                const reStr = padded.replace(/x/g, '\\d');
                const numRe = new RegExp('^' + reStr + '$');
                resultFilter = (code) => {
                    const cm = code.match(/^[A-Z]+\s*(\d{3})/i);
                    return cm && numRe.test(cm[1]);
                };
                criteria.push({ field: 'subject', value: subject });

            // Full course code: "CSCE 145" or "CSCE145" or "csce 145"
            } else if (!treatAsTopic && /^[A-Za-z]{3,4}\s*\d{3}[A-Za-z]?$/i.test(kw)) {
                const m = kw.match(/^([A-Za-z]{3,4})\s*(\d{3}[A-Za-z]?)$/i);
                subject = this._resolveSubject(m[1]);
                if (!subject) return null;
                const num = m[2].toUpperCase();
                const normalized = subject + ' ' + num;
                if (searchInput) searchInput.value = normalized;
                criteria.push({ field: 'alias', value: normalized });

            // 5-digit CRN
            } else if (!treatAsTopic && /^\d{5}$/.test(kw)) {
                criteria.push({ field: 'crn', value: kw });

            // 4 digits — invalid
            } else if (!treatAsTopic && /^\d{4}$/.test(kw)) {
                throw new Error('4-digit numbers are not valid. Enter a 3-digit course number (e.g. CSCE 101) or a 5-digit CRN.');

            // 3 digits + optional letter — need subject prefix
            } else if (!treatAsTopic && /^\d{3}\s?[A-Za-z]?$/.test(kw)) {
                throw new Error('Include the subject code (e.g. CSCE 101, not just 101).');

            // 1-2 digits
            } else if (!treatAsTopic && /^\d{1,2}$/.test(kw)) {
                throw new Error('Enter a subject code (e.g. CSCE) or full course number (e.g. CSCE 101).');

            // Text keyword — require 5+ characters
            } else if (kw.length < 5 && !courseScope?.active) {
                throw new Error('Keywords must be at least 5 characters. For courses, enter a subject code (e.g. CSCE) or course number (e.g. CSCE 145).');

            // Plain keyword. Whether it fetches directly or via meaning-based matching
            // is the caller's decision; classification only names it a keyword.
            } else {
                criteria.push({ field: 'keyword', value: kw });
            }

            return { criteria, resultFilter, subject };
        },

        async doSearch({ historyMode = 'push', bypassCache = false } = {}) {
            if (historyMode !== 'none') this.cancelLocationRestore();
            const initialSearchId = ++this._searchId;
            await this.loadSubjects();
            if (this.isStale(initialSearchId)) return;
            if (this._browseState === 'detail') this.leaveCourseDetail({ focus: false });
            this.clearSearchErrors();
            const searchInput = this.activeSearchInput();
            const rawInput = searchInput.value.trim();
            const openOnly = document.getElementById('filter-open').checked;
            const eligibleOnly = document.getElementById('filter-eligible').checked;
            const currentTermOnly = !document.getElementById('filter-show-all').checked;
            let aiAssisted = document.getElementById('filter-ai-search')?.checked !== false;
            // The section filters (method, Carolina Core, part of term, attribute,
            // honors, meeting pattern, size, availability) are read once by
            // buildFilterCriteria, which both search paths pass to applySectionFilters.
            // openOnly is read here as well because the semantic call and the direct
            // stat criterion need it before that object is built.

            let compactQuery = null;
            let searchQuery = rawInput;
            let courseScope;
            try {
                compactQuery = this.parseCompactScopedQuery(rawInput);
                if (compactQuery) {
                    this._topicSearchMode = true;
                    const subjectInput = document.getElementById('filter-scope-subjects');
                    const numberInput = document.getElementById('filter-scope-numbers');
                    if (subjectInput) subjectInput.value = compactQuery.subjectText;
                    if (numberInput) numberInput.value = compactQuery.numberText;
                    const aiToggle = document.getElementById('filter-ai-search');
                    if (aiToggle) aiToggle.checked = true;
                    aiAssisted = true;
                    searchQuery = compactQuery.topic;
                    searchInput.value = searchQuery;
                } else {
                    const standaloneScope = this.parseStandaloneCourseScope(rawInput);
                    if (standaloneScope) {
                        this._topicSearchMode = false;
                        const subjectInput = document.getElementById('filter-scope-subjects');
                        const numberInput = document.getElementById('filter-scope-numbers');
                        if (subjectInput) subjectInput.value = standaloneScope.subjectText;
                        if (numberInput) numberInput.value = standaloneScope.numberText;
                        searchQuery = '';
                        searchInput.value = '';
                    }
                }
                courseScope = this.buildCourseScope(
                    document.getElementById('filter-scope-subjects')?.value,
                    document.getElementById('filter-scope-numbers')?.value,
                );
                const subjectInput = document.getElementById('filter-scope-subjects');
                const numberInput = document.getElementById('filter-scope-numbers');
                if (subjectInput) subjectInput.value = courseScope.subjectText;
                if (numberInput) numberInput.value = courseScope.numberText;
            } catch (error) {
                const scopePanelOpen = !document.getElementById('filter-panel')?.classList.contains('hidden');
                this.showSearchError(error.message, { scope: scopePanelOpen });
                return;
            }

            const useDirectSearch = !aiAssisted
                || Boolean(this._relatedSearchOrigin)
                || this._directSearchOnce
                || this._semanticFallbackOnce
                || !searchQuery;
            const historyDirect = !aiAssisted || Boolean(this._relatedSearchOrigin);
            this._directSearchOnce = false;

            if (!searchQuery && !courseScope.active) {
                this.showHint('Enter a subject code (CSCE), course number (CSCE 145), range (CSCE 140-199), or keyword.');
                return;
            }

            this.writeSearchHistory(searchQuery, {
                mode: historyMode,
                direct: historyDirect,
                origin: this._relatedSearchOrigin,
                scopeOnly: !searchQuery && courseScope.active,
                topic: this._topicSearchMode,
            });

            this.setBrowseState('results');
            this.updateActiveFilterChips();
            this.closeFilters();
            const searchCacheKey = this.searchCacheKey({
                query: searchQuery,
                direct: historyDirect,
                origin: this._relatedSearchOrigin,
            });
            if (!bypassCache && !this._semanticFallbackOnce
                && this.restoreCachedSearch(searchCacheKey)) return;

            const kw = searchQuery.trim();
            const normalizedShortTopic = kw.toUpperCase();
            const scopedShortTopic = courseScope.active
                && /^[A-Za-z]{2,4}$/i.test(kw)
                && !this._subjects.includes(normalizedShortTopic)
                && !courseScope.subjects.includes(normalizedShortTopic);
            const treatAsTopic = this._topicSearchMode || scopedShortTopic;
            let classification;
            try {
                classification = this.classifyQuery(searchQuery, { treatAsTopic, courseScope });
            } catch (error) {
                // classifyQuery throws for a hard-invalid query (a 4-digit number, a
                // short keyword, a bad range). Those used to call showHint inline;
                // the caller does it now so the classifier stays free of the DOM.
                this.showHint(error.message);
                return;
            }
            // A null classification means _resolveSubject already showed a fuzzy
            // suggestion hint for an unknown subject; stop here rather than hint twice.
            if (!classification) return;
            const { criteria, resultFilter, subject } = classification;

            // Only an unstructured keyword can go to meaning-based matching, and
            // only with AI assistance on. A structured code (subject, alias, CRN or
            // range) always fetches directly, even when the toggle is on, which is
            // why the decision reads the classification rather than re-parsing.
            const isKeywordQuery = criteria.some(item => item.field === 'keyword');

            // Meaning-based search via Transformers.js
            if (isKeywordQuery && !useDirectSearch) {
                this.showLoading('Preparing search plan');
                const searchId = ++this._searchId;
                try {
                    await this.prepareSmartSearch();
                    if (this.isStale(searchId)) return;
                    const semantic = await this._doSemanticSearch(
                        kw,
                        currentTermOnly,
                        openOnly,
                        searchId,
                        courseScope,
                        progress => this.showSearchProgress(progress),
                    );
                    if (!semantic || this.isStale(searchId)) return;

                    this.showSearchProgress({
                        phase: 'filtering',
                        completed: semantic.searches?.length || 0,
                        total: semantic.searches?.length || 0,
                        candidates: semantic.results.length,
                    });

                    if (semantic.results.length === 0) {
                        this._mainSearchQuery = kw;
                        this._relatedSearchOrigin = '';
                        this.renderAndCacheSearch(
                            semantic.hadRequestFailure ? null : searchCacheKey,
                            [],
                            0,
                            {},
                            eligibleOnly,
                            semantic.searches,
                        );
                        return;
                    }

                    let results = semantic.results;

                    // Cross-reference the local/catalog shortlist with a small,
                    // shared live-request budget. Current-term keyword results are
                    // already full section records, so reuse them before querying
                    // any whole subject.
                    const keywordLiveResults = currentTermOnly
                        ? (semantic.searchResults || []).flat()
                        : [];
                    const keywordLiveByCode = this.buildLiveCourseIndex(keywordLiveResults);
                    const unresolvedResults = results.filter(course => !keywordLiveByCode[course.code]);
                    const subjects = unresolvedResults.length
                        ? this._semanticSubjectPlan(unresolvedResults, courseScope)
                        : [];
                    const liveHydration = await this._fetchSemanticLiveSubjects(
                        subjects,
                        searchId,
                        semantic.requestBudget,
                    );
                    if (liveHydration.stale || this.isStale(searchId)) return;
                    const liveAll = [...keywordLiveResults, ...liveHydration.results];
                    const incompleteSearch = semantic.hadRequestFailure
                        || liveHydration.hadRequestFailure;
                    const liveByCode = this.buildLiveCourseIndex(liveAll);

                    if (currentTermOnly) {
                        // Only show courses offered this term
                        results = results.filter(c => liveByCode[c.code]);
                    }

                    results = this.filterByCourseScope(
                        this.mergeCatalogWithLiveSections(results, liveByCode),
                        courseScope,
                    );
                    const semanticFilters = this.buildFilterCriteria();
                    results = await this.applySectionFilters(results, semanticFilters);
                    results = this.filterByCourseScope(results, courseScope);

                    if (this.isStale(searchId)) return;
                    const eligibleOnly2 = eligibleOnly;
                    const relatedBatches = await Promise.all((semantic.searchResults || []).map(batch => {
                        const candidates = currentTermOnly
                            ? batch
                            : this.mergeCatalogWithLiveSections(batch, liveByCode);
                        return this.applySectionFilters(
                            this.filterByCourseScope(candidates, courseScope),
                            semanticFilters,
                        );
                    }));
                    if (this.isStale(searchId)) return;
                    const prereqData = eligibleOnly2
                        ? await this.loadPrereqsForResults([...results, ...relatedBatches.flat()])
                        : {};
                    if (this.isStale(searchId)) return;
                    const searchInfo = this.buildSemanticSearchInfo(
                        semantic,
                        relatedBatches,
                        results,
                        eligibleOnly2,
                        prereqData,
                    );
                    this._mainSearchQuery = searchQuery;
                    this._relatedSearchOrigin = '';
                    this.renderAndCacheSearch(
                        incompleteSearch ? null : searchCacheKey,
                        results,
                        results.length,
                        prereqData,
                        eligibleOnly2,
                        searchInfo,
                    );
                } catch (err) {
                    if (this.isStale(searchId)) return;
                    if (this.activeSearchInput()?.value.trim() !== kw) return;
                    console.error('[Semantic] Error:', err);
                    this._extractorLoading = null;
                    this._smartModelPromise = null;
                    this.setSmartModelLoading(false);
                    this._semanticFallbackNotice = 'Meaning-based matching is unavailable. Showing direct matches.';
                    this._semanticFallbackOnce = true;
                    await this.doSearch({ bypassCache: true });
                    this._semanticFallbackOnce = false;
                }
                return;
            }

            return this._runCriteriaSearch({
                criteria,
                subject,
                courseScope,
                courseRangeFilter: resultFilter,
                courseNumberFilter: null,
                currentTermOnly,
                eligibleOnly,
                searchCacheKey,
            });
        },

        /*
         * The direct/criteria fetch: everything after the semantic branch returns.
         *
         * Extracted from doSearch's tail so the classifier, the semantic branch and
         * this share nothing but the context passed in. It reads the section filters
         * once through buildFilterCriteria and bumps its own search id, exactly where
         * the inline code did, so a newer search still discards these results.
         */
        async _runCriteriaSearch({
            criteria,
            subject,
            courseScope,
            courseRangeFilter,
            courseNumberFilter,
            currentTermOnly,
            eligibleOnly,
            searchCacheKey,
        }) {
            const filterCriteria = this.buildFilterCriteria();
            const { openOnly, carolinaCore } = filterCriteria;

            // Level filter — removed from UI; range/wildcard search (e.g. CSCE 500+)
            // replaces it. Kept as a dead branch so the behaviour stays identical.
            const levelMode = '';
            const levelValue = 0;

            if (openOnly) criteria.push({ field: 'stat', value: 'A' });

            this.showLoading();
            const searchId = ++this._searchId;

            try {
                let results = [];
                let totalCount = 0;
                const scopedRequestSubjects = this.scopedSubjectsForQuery(subject, courseScope);
                const subjectScopeConflict = Boolean(
                    subject
                    && courseScope.subjects.length
                    && !scopedRequestSubjects.length,
                );

                /*
                 * Carolina Core is a search criterion, not a post-filter.
                 *
                 * Upstream matches course_attr against the exact display
                 * string, so asking for one outcome returns only the sections
                 * carrying it -- one request, instead of fetching everything
                 * and narrowing it here against a catalogue snapshot.
                 *
                 * filterByCarolinaCore deliberately stands down when this
                 * fires. Applying both would narrow twice, and the shard could
                 * then drop a course upstream was right to return: a newly
                 * designated one it has not been regenerated for.
                 *
                 * Added here rather than beside the other criteria because it
                 * has to reach both branches below -- the scoped multi-subject
                 * batch and the single request.
                 */
                const coreSearchValue = this.carolinaCoreSearchValue(carolinaCore);
                if (coreSearchValue) criteria.push({ field: 'course_attr', value: coreSearchValue });

                if (subjectScopeConflict) {
                    results = [];
                    totalCount = 0;
                } else if (currentTermOnly) {
                    // Search live class offerings for the selected term
                    if (courseScope.subjects.length) {
                        const batches = await Promise.all(scopedRequestSubjects.map(scopeSubject => (
                            deps.api.searchCourses(deps.state.term, [
                                ...criteria.filter(item => item.field !== 'subject'),
                                { field: 'subject', value: scopeSubject },
                            ])
                        )));
                        results = batches.flatMap(data => data.results || []);
                        totalCount = results.length;
                    } else {
                        const data = await deps.api.searchCourses(deps.state.term, criteria);
                        results = data.results || [];
                        totalCount = data.count || 0;
                    }
                } else {
                    // Search the bulletin catalog (all courses, not term-specific)
                    let bulletinCourses;
                    if (subject) {
                        const bulletinData = await deps.api.bulletinSearch(subject);
                        bulletinCourses = bulletinData.results || [];
                    } else if (courseScope.subjects.length) {
                        const batches = await Promise.all(courseScope.subjects.map(async scopeSubject => {
                            if (!criteria.length) {
                                const data = await deps.api.bulletinSearch(scopeSubject);
                                return data.results || [];
                            }
                            const data = await deps.api.post('/api/bulletin/search', {
                                other: { srcdb: '2026' },
                                criteria: [
                                    ...criteria.filter(item => item.field !== 'subject'),
                                    { field: 'subject', value: scopeSubject },
                                ],
                            });
                            return data.results || [];
                        }));
                        bulletinCourses = batches.flat();
                    } else {
                        const bulletinData = await deps.api.post('/api/bulletin/search', {
                            other: { srcdb: '2026' },
                            criteria,
                        });
                        bulletinCourses = bulletinData.results || [];
                    }
                    bulletinCourses = this.filterByCourseScope(bulletinCourses, courseScope);

                    // Also fetch live term data to cross-reference availability
                    const liveSubjects = subjectScopeConflict
                        ? []
                        : subject
                            ? scopedRequestSubjects
                        : courseScope.subjects.length
                            ? courseScope.subjects
                            : [...new Set(bulletinCourses
                                .map(course => String(course.code || '').split(' ')[0])
                                .filter(Boolean))];
                    const liveResults = courseScope.active && !courseScope.subjects.length
                        ? (await deps.api.searchCourses(deps.state.term, [])).results || []
                        : (await Promise.all(liveSubjects.map(code => deps.api.searchCourses(
                            deps.state.term,
                            [{ field: 'subject', value: code }],
                        ).then(data => data.results || [])))).flat();

                    // Build a set of course codes offered this term + their open status
                    const liveByCode = this.buildLiveCourseIndex(liveResults);

                    // Convert bulletin results, merging live availability info
                    results = this.mergeCatalogWithLiveSections(bulletinCourses, liveByCode);
                    totalCount = results.length;

                    // Apply keyword course number filter to catalog results
                    if (courseNumberFilter) {
                        results = results.filter(r => {
                            const codeNum = (r.code || '').replace(/^[A-Z]+\s*/i, '').toUpperCase();
                            return codeNum === courseNumberFilter;
                        });
                        courseNumberFilter = null; // already applied
                    }
                }

                // Client-side filters

                // Range/wildcard filter (from patterns like "500+", "5xx", "55x", "x77", "3xxL")
                if (courseRangeFilter) {
                    results = results.filter(r => courseRangeFilter(r.code || ''));
                }

                // Course number filter (from 3-digit input like "101" or "101L")
                if (courseNumberFilter) {
                    results = results.filter(r => {
                        const codeNum = (r.code || '').replace(/^[A-Z]+\s*/i, '').toUpperCase();
                        return codeNum === courseNumberFilter;
                    });
                }

                results = this.filterByCourseScope(results, courseScope);

                // Level filter
                if (levelMode && levelValue) {
                    results = results.filter(r => {
                        const num = parseInt((r.code || '').replace(/[A-Z\s]+/g, ''));
                        if (!num) return true;
                        const level = Math.floor(num / 100) * 100;
                        if (levelMode === 'exact') return level === levelValue;
                        if (levelMode === 'above') return num >= levelValue;
                        if (levelMode === 'below') return num < levelValue;
                        return true;
                    });
                }

                results = await this.applySectionFilters(results, filterCriteria);
                results = this.filterByCourseScope(results, courseScope);
                if (courseScope.active) totalCount = results.length;

                // If a newer search was started, discard these results
                if (this.isStale(searchId)) return;

                const prereqData = eligibleOnly
                    ? await this.loadPrereqsForResults(results)
                    : (this._prereqCache[subject] || {});

                if (this.isStale(searchId)) return;
                this.renderAndCacheSearch(
                    this._semanticFallbackOnce ? null : searchCacheKey,
                    results,
                    totalCount || results.length,
                    prereqData,
                    eligibleOnly,
                );
            } catch (err) {
                if (this.isStale(searchId)) return;
                this.showHint('Search failed. Try again.');
            }
        },

        };
    }

    return { createShellPart };
}));

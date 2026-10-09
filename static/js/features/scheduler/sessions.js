/* Resumable generation, stable ranking snapshots, and paged schedule cards. */
(function initSessionsPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.SchedulerParts ||= {};
    root.SchedulerParts.createSessionsPart = api.createSessionsPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';
    const sorts = ['best', 'days', 'walking', 'gaps', 'later', 'gpa', 'online'];
    const canonical = value => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

    function createSessionsPart(deps) {
        return {
            initSolverSessionControls() {
                document.getElementById('solver-stop')?.addEventListener('click', () => this.pauseSolverSession());
                document.getElementById('solver-continue')?.addEventListener('click', () => this.runSolverSession(false));
                document.getElementById('solver-update')?.addEventListener('click', () => this.publishSolverResults());
                document.getElementById('schedule-sort')?.addEventListener('change', event => {
                    this._solverSort = sorts.includes(event.target.value) ? event.target.value : 'best';
                    this.updateSolverSortHint();
                    try { localStorage.setItem(`scheduler-sort:${deps.state.term}`, this._solverSort); } catch { /* Optional preference. */ }
                    this.publishSolverResults();
                });
                window.addEventListener('pagehide', () => this._solverClient?.dispose());
            },

            updateSolverSortHint() {
                const select = document.getElementById('schedule-sort');
                if (select) select.title = `Sort schedules. Current order: ${select.selectedOptions[0]?.textContent || 'Best match'}.`;
            },

            invalidateSolverSession() {
                this._solverGeneration = (this._solverGeneration || 0) + 1;
                this._solverClient?.dispose();
                this._solverClient = null;
                this._solverStore?.close();
                this._solverStore = null;
                this._solverRunning = false;
                this._solverMetricWork = null;
                this._solverPageOffset = 0;
                this._solverPublishing = false;
                this._solverHasPage = false;
                this._solverError = '';
                const generate = document.getElementById('btn-solve');
                if (generate) generate.disabled = false;
                const controls = document.getElementById('solver-session-controls');
                if (controls) controls.hidden = true;
                const sort = document.getElementById('schedule-sort');
                if (sort) sort.disabled = false;
            },

            async prepareSolverParams() {
                const term = deps.state.term;
                const groups = Object.values(deps.state.selectedCourses || {}).sort((a, b) => a.code.localeCompare(b.code));
                if (!groups.length) throw new Error('Add at least one course before generating schedules.');
                const courses = groups.map(group => {
                    const locked = deps.state.sectionLocks?.[group.code];
                    return { code: group.code, sections: (group.sections || []).filter(section => this.isSchedulableSection(section)
                        && (locked ? String(section.crn) === String(locked) : this.isOpenSection(section)))
                        .map(section => ({ ...section, code: group.code })).sort((a, b) => String(a.crn).localeCompare(String(b.crn))) };
                });
                const empty = courses.filter(course => !course.sections.length);
                if (empty.length) throw new Error(`No eligible section is available for ${empty.map(course => course.code).join(', ')}. Check section locks and open sections.`);
                await this.addWalkingLocations(courses);
                const sections = courses.flatMap(course => course.sections);
                let cursor = 0;
                await Promise.all(Array.from({ length: Math.min(4, sections.length) }, async () => {
                    while (cursor < sections.length) {
                        const section = sections[cursor++];
                        const credits = await this.resolveScheduleSectionCredits(section, term);
                        if (credits !== null) section.hours = credits;
                    }
                }));
                const preferences = deps.state.getPreferences();
                const max = deps.state.profile?.customCredits?.max;
                preferences.max_credits = Number.isFinite(Number(max)) ? Number(max) : 18;
                let catalogRevision = 'live';
                try { catalogRevision = (await deps.api._getDataStore().getManifest()).release_id || 'live'; } catch { /* Live catalog input is fingerprinted below. */ }
                const params = { term, courses, preferences, sectionLocks: { ...deps.state.sectionLocks }, catalogRevision, solverVersion: SolverCore.VERSION || 2 };
                const bytes = new TextEncoder().encode(JSON.stringify(canonical(params)));
                const hash = await crypto.subtle.digest('SHA-256', bytes);
                params.input_revision = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
                return params;
            },

            async restoreSolverSession() {
                if (typeof SolverStore === 'undefined' || typeof SolverClient === 'undefined') return;
                const generation = this._solverGeneration = (this._solverGeneration || 0) + 1;
                const term = deps.state.term;
                try {
                    const params = await this.prepareSolverParams();
                    if (generation !== this._solverGeneration || term !== deps.state.term) return;
                    const store = await SolverStore.open({ term, inputRevision: params.input_revision, params });
                    if (generation !== this._solverGeneration || term !== deps.state.term) { store.close(); return; }
                    this.attachSolverSession(store, generation);
                    if (!store.meta.checkpoint) return;
                    if (store.meta.publishedCount) await this.renderSolverPage(0);
                    else if (store.meta.total_found) await this.publishSolverResults();
                    else document.getElementById('solver-container').innerHTML = `<p class="hint">${store.meta.state === 'complete' ? 'No schedule satisfies all selected courses and required preferences.' : 'No schedules found yet. Continue the saved search.'}</p>`;
                    this.refreshSolverStatus();
                    this.hydrateSolverMetrics();
                } catch { /* Startup remains usable when no plan or catalog is ready. Generate reports errors. */ }
            },

            attachSolverSession(store, generation) {
                this._solverStore = store;
                this._solverGeneration = generation;
                this._solverPageOffset = 0;
                try { this._solverSort = localStorage.getItem(`scheduler-sort:${deps.state.term}`) || 'best'; } catch { this._solverSort = 'best'; }
                if (!sorts.includes(this._solverSort)) this._solverSort = 'best';
                const select = document.getElementById('schedule-sort');
                if (select) select.value = this._solverSort;
                this.updateSolverSortHint();
                const params = { ...store.meta.params, session_id: store.meta.session_id, input_revision: store.meta.input_revision };
                this._solverClient = deps.api.createSolverSession(params, {
                    checkpoint: store.meta.checkpoint,
                    onBatch: async batch => {
                        if (generation !== this._solverGeneration) throw new Error('This search was replaced by new course choices.');
                        await store.commitBatch(batch);
                        if (generation !== this._solverGeneration) return;
                        if (!this._solverHasPage && store.meta.total_found) {
                            await store.publish(this._solverSort);
                            if (generation === this._solverGeneration) {
                                await this.renderSolverPage(0);
                                this._solverHasPage = true;
                            }
                        }
                        this.refreshSolverStatus();
                        this.hydrateSolverMetrics();
                    },
                    onProgress: progress => {
                        if (generation !== this._solverGeneration) return;
                        this._solverProgress = progress;
                        this.refreshSolverStatus();
                    },
                    onPageQuery: query => store.page(query?.offset || 0, query?.limit || 10),
                });
                this._solverHasPage = Boolean(store.meta.publishedCount);
            },

            async solve(maxResults = 10) {
                if (typeof SolverStore === 'undefined' || typeof SolverClient === 'undefined') return this.solveLegacy(maxResults);
                this.invalidateSolverSession();
                const generation = this._solverGeneration;
                const container = document.getElementById('solver-container');
                container.innerHTML = '<p class="loading">Preparing courses and section details…</p>';
                container.setAttribute('aria-busy', 'true');
                Accessibility.announce('Preparing courses for schedule generation.', 'schedule');
                try {
                    const params = await this.prepareSolverParams();
                    if (generation !== this._solverGeneration) return;
                    const store = await SolverStore.open({ term: params.term, inputRevision: params.input_revision, params });
                    if (generation !== this._solverGeneration) { store.close(); return; }
                    this.attachSolverSession(store, generation);
                    if (store.meta.publishedCount) await this.renderSolverPage(0);
                    if (store.meta.state === 'complete') {
                        await this.publishSolverResults();
                        this.refreshSolverStatus();
                        this.hydrateSolverMetrics();
                    } else await this.runSolverSession(!store.meta.checkpoint);
                } catch (error) {
                    if (generation === this._solverGeneration) {
                        container.innerHTML = `<p class="solver-error">${this.escapeHtml(error.message)}</p>`;
                        Accessibility.announce(error.message, 'schedule');
                    }
                } finally { if (generation === this._solverGeneration) container.setAttribute('aria-busy', 'false'); }
            },

            async runSolverSession(first = false) {
                if (!this._solverStore || this._solverRunning || this._solverStore.meta.state === 'complete') return;
                if (!this._solverClient) this.attachSolverSession(this._solverStore, this._solverGeneration);
                const generation = this._solverGeneration;
                const store = this._solverStore;
                this._solverRunning = true;
                this._solverError = '';
                this.refreshSolverStatus();
                Accessibility.announce('Searching for schedule options.', 'schedule');
                try {
                    const result = await (first ? this._solverClient.start() : this._solverClient.resume());
                    if (result?.error) throw new Error(result.error);
                } catch (error) {
                    if (generation === this._solverGeneration) {
                        this._solverError = error.message;
                        this._solverClient?.dispose();
                        this._solverClient = null;
                        // The durable checkpoint remains the only restart point after a failed batch.
                        await store.commitBatch({ results: [], checkpoint: store.meta.checkpoint, state: 'paused', stop_reason: 'error' }).catch(() => {});
                    }
                } finally {
                    if (generation === this._solverGeneration) {
                        this._solverRunning = false;
                        this.refreshSolverStatus();
                        const state = store.meta.state === 'complete' ? 'Search complete.' : 'Search paused.';
                        Accessibility.announce(`${state} Found ${store.meta.total_found} schedules.`, 'schedule');
                        if (!store.meta.total_found) document.getElementById('solver-container').innerHTML = `<p class="hint">${store.meta.state === 'complete' ? 'No schedule satisfies all selected courses and required preferences.' : 'No schedules found yet. Continue to search further.'}</p>`;
                    }
                }
            },

            async pauseSolverSession() {
                const generation = this._solverGeneration;
                await this._solverClient?.pause();
                if (generation !== this._solverGeneration) return;
                this._solverRunning = false;
                this.refreshSolverStatus();
                document.getElementById('solver-continue')?.focus();
            },

            refreshSolverStatus() {
                const store = this._solverStore;
                if (!store) return;
                const controls = document.getElementById('solver-session-controls');
                controls.hidden = false;
                const complete = store.meta.state === 'complete';
                const count = store.meta.total_found || 0;
                const state = this._solverRunning ? 'Searching…' : complete ? 'Search complete.' : 'Search paused.';
                const reason = !this._solverRunning && store.meta.stop_reason === 'time_budget' ? ' Continue for another 30 seconds.' : '';
                const status = document.getElementById('solver-session-status');
                const ready = store.meta.metrics_ready || 0;
                const metricStatus = count && ready < count ? ` Summary data ready for ${ready} of ${count}.` : '';
                const text = `${this._solverPublishing ? 'Updating results… ' : ''}${state} ${complete ? `${count} possible schedules.` : `Found ${count} schedules so far.`}${reason}${metricStatus}`;
                if (status.textContent !== text) status.textContent = text;
                document.getElementById('solver-stop').hidden = !this._solverRunning;
                const continuation = document.getElementById('solver-continue');
                continuation.hidden = complete || this._solverRunning;
                continuation.disabled = false;
                const update = document.getElementById('solver-update');
                update.hidden = !count || (store.meta.revision === store.meta.publishedRevision && document.activeElement !== update);
                update.disabled = Boolean(this._solverPublishing);
                const notice = document.getElementById('solver-storage-notice');
                notice.textContent = this._solverError || (!store.persistent ? 'Temporary browser storage. Refresh recovery is unavailable. If storage fills, the search pauses without discarding results.' : 'Progress is saved in this browser. Continue resumes the saved search.');
                notice.hidden = !this._solverError && store.persistent;
                document.getElementById('btn-solve').disabled = this._solverRunning;
                document.getElementById('schedule-sort').disabled = Boolean(this._solverPublishing);
                const pageSummary = document.querySelector('#solver-container .solver-summary');
                if (pageSummary && this._solverPage) pageSummary.textContent = this.solverPageLabel(this._solverPage);
            },

            solverPageLabel(page) {
                const shown = page.results.length;
                const range = shown ? `${page.offset + 1}–${page.offset + shown}` : '0';
                return this._solverStore.meta.state === 'complete'
                    ? `Showing ${range} of ${this._solverStore.meta.total_found} possible schedules.${page.total < this._solverStore.meta.total_found ? ` This view includes ${page.total}; update results to include the rest.` : ''}`
                    : `Showing ${range} of ${page.total} saved options. Found ${this._solverStore.meta.total_found} schedules so far.`;
            },

            expandSolverRecord(record) {
                const courses = this._solverStore.meta.params.courses;
                return { ...record, sections: Object.fromEntries(record.refs.map(([course, section]) => [courses[course].code, courses[course].sections[section]])) };
            },

            async publishSolverResults() {
                const store = this._solverStore;
                if (!store || this._solverPublishing) return;
                const generation = this._solverGeneration;
                const focusId = document.activeElement?.id;
                this._solverPublishing = true;
                this.refreshSolverStatus();
                try {
                    await store.publish(this._solverSort);
                    if (generation !== this._solverGeneration) return;
                    await this.renderSolverPage(0);
                    Accessibility.announce(`${document.getElementById('schedule-sort').selectedOptions[0].textContent}. ${store.meta.publishedCount} options ranked.`, 'schedule');
                    if (focusId) document.getElementById(focusId)?.focus();
                } catch (error) { if (generation === this._solverGeneration) this._solverError = error.message; }
                finally { if (generation === this._solverGeneration) { this._solverPublishing = false; this.refreshSolverStatus(); } }
            },

            async renderSolverPage(offset) {
                const store = this._solverStore;
                const generation = this._solverGeneration;
                const request = this._solverPageRequest = (this._solverPageRequest || 0) + 1;
                const page = await store.page(Math.max(0, offset), 10);
                if (generation !== this._solverGeneration || request !== this._solverPageRequest) return;
                this._solverPage = page;
                this._solverPageOffset = page.offset;
                const schedules = page.results.map(record => this.expandSolverRecord(record));
                deps.state.solverResults = schedules;
                const container = document.getElementById('solver-container');
                this.renderResults({ total_found: schedules.length, returned: schedules.length, schedules, search_complete: store.meta.state === 'complete', session_page: true }, container);
                const summary = container.querySelector('.solver-summary');
                if (summary) summary.textContent = this.solverPageLabel(page);
                schedules.forEach((schedule, index) => {
                    const pane = container.querySelector(`[data-summary-index="${index}"]`);
                    if (!pane) return;
                    pane.innerHTML = this.scheduleSummaryMarkup(this.scheduleSummarySections(schedule), schedule.metrics?.grade, schedule.metrics?.travel);
                    pane.removeAttribute('aria-busy');
                });
                if (page.total) {
                    const navigation = document.createElement('nav');
                    navigation.className = 'solver-pagination';
                    navigation.setAttribute('aria-label', 'Schedule option pages');
                    navigation.innerHTML = `<button type="button" data-page="previous"${offset <= 0 ? ' disabled' : ''}>Previous</button><span>Page ${Math.floor(page.offset / 10) + 1} of ${Math.ceil(page.total / 10)}</span><button type="button" data-page="next"${page.offset + 10 >= page.total ? ' disabled' : ''}>Next</button>`;
                    navigation.querySelectorAll('button').forEach(button => button.addEventListener('click', async () => {
                        const direction = button.dataset.page;
                        await this.renderSolverPage(page.offset + (direction === 'next' ? 10 : -10));
                        const next = container.querySelector(`[data-page="${direction}"]:not(:disabled)`) || container;
                        next.focus();
                        container.scrollTop = 0;
                        Accessibility.announce(this.solverPageLabel(this._solverPage), 'schedule');
                    }));
                    container.append(navigation);
                }
                this.refreshSolverStatus();
            },

            hydrateSolverMetrics() {
                const store = this._solverStore;
                const generation = this._solverGeneration;
                if (!store || this._solverMetricWork) { this._solverMetricsAgain = true; return; }
                this._solverMetricsAgain = false;
                const work = (async () => {
                    const enrich = async record => {
                        if (generation !== this._solverGeneration) return;
                        if (record.metrics?.ready) return;
                        const sections = this.scheduleSummarySections(this.expandSolverRecord(record));
                        const [grade, travel] = await Promise.all([this.scheduleGradeEstimate(sections), this.scheduleTravelEstimate(sections)]);
                        if (generation !== this._solverGeneration) return;
                        const metrics = {
                            grade, travel, ready: true,
                            gpa: { value: grade.value, completeness: grade.completeness },
                            walking: { value: travel.miles, completeness: travel.miles === null ? 'missing' : travel.incomplete ? 'partial' : 'complete' },
                            campusDays: travel.campusDays,
                            campusDaysCompleteness: travel.campusDays === null ? 'missing' : travel.issues.some(issue => /location|times unavailable/i.test(issue)) ? 'partial' : 'complete',
                        };
                        await store.updateMetrics(record.id, metrics);
                        this.refreshSolverStatus();
                    };
                    // Resolve the first visible options before enriching the rest of a large catalog.
                    for (const visible of this._solverPage?.results || []) {
                        if (generation !== this._solverGeneration) return;
                        const current = await store.getResult(visible.id);
                        if (current) await enrich(current);
                    }
                    await store.iterateResults(async records => {
                        for (const record of records) await enrich(record);
                    }, 250);
                })().catch(error => {
                    if (generation === this._solverGeneration) {
                        this._solverError = error.message;
                        this._solverClient?.pause();
                        this.refreshSolverStatus();
                    }
                }).finally(() => {
                    if (this._solverMetricWork === work) this._solverMetricWork = null;
                    if (generation === this._solverGeneration && this._solverMetricsAgain) this.hydrateSolverMetrics();
                });
                this._solverMetricWork = work;
            },
        };
    }
    return { createSessionsPart };
}));

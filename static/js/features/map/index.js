/*
 * Campus map and walking routes, fenced.
 *
 * The second extraction under phase 7a. Bigger than history -- 839 lines and
 * fourteen methods other modules call -- but the coupling that mattered turned
 * out to be narrow: one API method, three State properties, and a route cache.
 * Those are the declared dependencies.
 *
 * The DOM and Leaflet stay ambient, deliberately. A campus map needs a document
 * and a mapping library; injecting them would add ceremony without making the
 * module any more replaceable, and the fence that matters is the one around the
 * application's own state and data access. That boundary is what a test can
 * enforce and what a second instance needs in order to be independent.
 */
(function initMapFeature(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.Features) root.Features = {};
    root.Features.map = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createMapFeature(deps) {
        for (const name of ['getDetails', 'currentTerm', 'selectedSections', 'onStateChange', 'fetch']) {
            if (typeof deps?.[name] !== 'function') {
                throw new TypeError(`map feature needs a ${name}() dependency`);
            }
        }
        if (!deps.storage || typeof deps.storage.getItem !== 'function') {
            throw new TypeError('map feature needs a storage dependency');
        }

        const feature = {
    DAYS: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    LEAFLET_JS: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    LEAFLET_CSS: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    ROUTE_URL: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving',
    DEFAULT_CENTER: [33.9971, -81.0278],
    ROUTE_COLORS: ['#73000A', '#466A9F', '#65780B', '#A49137', '#1F414D', '#CC2E40', '#000000'],
    ROUTE_CACHE_KEY: 'uofsc-walking-routes-v2',
    ROUTE_CACHE_TTL_MS: 30 * 24 * 60 * 60 * 1000,
    ROUTE_CACHE_MAX_ENTRIES: 120,
    DETAIL_RETRY_BASE_MS: 60 * 1000,
    DETAIL_RETRY_MAX_MS: 15 * 60 * 1000,
    selectedDay: 'all',
    buildings: [],
    catalogRevision: 'unknown',
    sectionDetails: new Map(),
    sectionDetailRequests: new Map(),
    sectionDetailFailures: new Map(),
    sectionDetailPrefetchPauses: new Map(),
    routeCache: new Map(),
    _renderToken: 0,
    _map: null,
    _layer: null,
    _routeLayers: [],
    _lockedTransitionIndex: null,
    _previewTransitionIndex: null,
    _overviewView: null,

    async init(options = {}) {
        this.containerId = options.containerId || 'walking-map-container';
        this.container = document.getElementById(this.containerId);
        if (!this.container) return false;

        await this.loadBuildings();
        this.loadStoredRoutes();
        this.renderShell();

        if (deps.onStateChange) {
            deps.onStateChange('sections-changed', () => this.refresh());
        }
        await this.refresh();
        return true;
    },

    async loadBuildings() {
        try {
            const response = await deps.fetch('/static/data/campus_buildings.json');
            if (!response.ok) throw new Error(`Building catalog ${response.status}`);
            const catalog = await response.json();
            this.buildings = catalog.buildings || [];
            this.DEFAULT_CENTER = catalog.center || this.DEFAULT_CENTER;
            this.catalogRevision = this.buildingCatalogRevision(catalog);
        } catch (error) {
            console.warn('[WalkingMap] Building catalog unavailable.', error);
            this.buildings = [];
            this.catalogRevision = 'unavailable';
        }
    },

    buildingCatalogRevision(catalog) {
        const source = catalog?.source || {};
        return String(catalog?.revision || catalog?.updated_at || [
            source.map_id || 'map',
            source.official_building_count || 0,
            (catalog?.buildings || []).length,
        ].join('-'));
    },

    renderShell() {
        this.container.innerHTML = `
            <section class="walking-map-panel" aria-labelledby="walking-map-heading">
                <div class="walking-map-header">
                    <div>
                        <h3 id="walking-map-heading">Routes Between Classes</h3>
                    </div>
                </div>
                <div class="walking-map-layout">
                    <div class="walking-map-canvas-wrap">
                        <div class="walking-map-canvas" role="region" aria-label="Campus route map"></div>
                        <div class="walking-map-zoom-hint">Hold Ctrl, Command, or Shift while scrolling to zoom</div>
                    </div>
                    <div class="walking-map-side">
                        <div class="walking-map-days" role="tablist" aria-label="Class day"></div>
                        <div class="walking-map-list" aria-live="polite"></div>
                    </div>
                </div>
            </section>
        `;

        this.dayContainer = this.container.querySelector('.walking-map-days');
        this.mapElement = this.container.querySelector('.walking-map-canvas');
        this.mapElement.addEventListener('wheel', event => {
            if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return;
            if (!this._map) return;
            event.preventDefault();
            const direction = event.deltaY < 0 ? 1 : -1;
            const zoom = Math.max(this._map.getMinZoom(), Math.min(this._map.getMaxZoom(), this._map.getZoom() + direction));
            this._map.setZoom(zoom);
        }, { passive: false });
        this.listElement = this.container.querySelector('.walking-map-list');
        this.listElement.addEventListener('mouseleave', () => {
            if (this._previewTransitionIndex !== null) {
                this.clearTransitionPreview(this._previewTransitionIndex);
            }
        });
        const dayOptions = [
            { label: 'ALL', value: 'all' },
            ...this.DAYS.map((day, index) => ({ label: day.slice(0, 3).toUpperCase(), value: String(index) })),
        ];
        dayOptions.forEach(option => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'walking-map-day';
            button.id = `walking-map-day-${option.value}`;
            button.dataset.day = option.value;
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-controls', `${this.containerId}-day-panel`);
            button.setAttribute('aria-selected', String(option.value === String(this.selectedDay)));
            button.textContent = option.label;
            button.addEventListener('click', () => {
                this.selectedDay = option.value === 'all' ? 'all' : Number(option.value);
                this.updateDaySelection();
                this.refresh();
            });
            this.dayContainer.appendChild(button);
        });
        this.listElement.id = `${this.containerId}-day-panel`;
        this.listElement.setAttribute('role', 'tabpanel');
    },

    updateDaySelection() {
        this.dayContainer.querySelectorAll('[role="tab"]').forEach(button => {
            const selected = button.dataset.day === String(this.selectedDay);
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
        });
        this.listElement.setAttribute('aria-labelledby', `walking-map-day-${this.selectedDay}`);
    },

    updateDayVisibility(sections) {
        const hasWeekendMeeting = (sections || []).some(section => (
            this.parseMeetingTimes(section.meetingTimes).some(meeting => meeting.day >= 5)
        ));
        this.dayContainer.querySelectorAll('[role="tab"]').forEach(button => {
            const day = Number(button.dataset.day);
            button.hidden = Number.isFinite(day) && day >= 5 && !hasWeekendMeeting;
        });
        this.dayContainer.style.gridTemplateColumns = `repeat(${hasWeekendMeeting ? 8 : 6}, minmax(0, 1fr))`;
        if (!hasWeekendMeeting && Number(this.selectedDay) >= 5) this.selectedDay = 'all';
    },

    async refresh() {
        if (!this.container) return;
        const token = ++this._renderToken;
        const sections = Object.values(deps.selectedSections() || {});
        this.updateDayVisibility(sections);
        this.updateDaySelection();
        this.listElement.innerHTML = '<p class="walking-map-empty">Loading class locations and campus routes.</p>';

        await this.hydrateSectionDetails(sections, {
            background: true,
            concurrency: 1,
            maxConsecutiveFailures: 2,
        });
        if (token !== this._renderToken) return;

        let events = [];
        let transitions = [];
        if (this.selectedDay === 'all') {
            for (let day = 0; day < this.DAYS.length; day += 1) {
                const dayEvents = this.buildEvents(sections, day);
                const dayTransitions = await this.buildTransitions(dayEvents);
                events.push(...dayEvents);
                transitions.push(...dayTransitions);
                if (token !== this._renderToken) return;
            }
        } else {
            events = this.buildEvents(sections, this.selectedDay);
            transitions = await this.buildTransitions(events);
        }
        if (token !== this._renderToken) return;

        this.renderTransitions(events, transitions);
        await this.renderMap(events, transitions);
    },

    sectionDetailKey(section, term = deps.currentTerm()) {
        return `${term}:${section?.crn || ''}`;
    },

    async hydrateSectionDetail(section, term = deps.currentTerm(), { foreground = true } = {}) {
        if (!section?.crn) return { status: 'skipped' };
        const key = this.sectionDetailKey(section, term);
        if (this.sectionDetails.has(key)) return { status: 'cached' };
        if (this.sectionDetailRequests.has(key)) return this.sectionDetailRequests.get(key);
        const priorFailure = this.sectionDetailFailures.get(key);
        if (!foreground && priorFailure?.retryAfter > Date.now()) {
            return { status: 'backoff', retryAfter: priorFailure.retryAfter };
        }
        const request = deps.getDetails(section.crn, term)
            .then(detail => {
                this.sectionDetails.set(key, this.parseMeetingDetails(detail.meeting_html || ''));
                this.sectionDetailFailures.delete(key);
                if (foreground) this.sectionDetailPrefetchPauses.delete(term);
                return { status: 'loaded' };
            })
            .catch(() => {
                const failures = (priorFailure?.failures || 0) + 1;
                const backoff = Math.min(
                    this.DETAIL_RETRY_MAX_MS,
                    this.DETAIL_RETRY_BASE_MS * (2 ** Math.max(0, failures - 1)),
                );
                this.sectionDetailFailures.set(key, {
                    failures,
                    retryAfter: Date.now() + backoff,
                });
                return { status: 'failed' };
            })
            .finally(() => this.sectionDetailRequests.delete(key));
        this.sectionDetailRequests.set(key, request);
        return request;
    },

    sectionNeedsLocationDetail(section) {
        return section?.crn
            && !this.isOnline(section)
            && this.parseMeetingTimes(section.meetingTimes).length > 0;
    },

    async hydrateSectionDetails(sections, {
        background = false,
        concurrency = 8,
        delayMs = 0,
        foreground = !background,
        maxConsecutiveFailures = 2,
        signal = null,
    } = {}) {
        const summary = { attempted: 0, loaded: 0, failed: 0, skipped: 0, stopped: false };
        if (!deps.getDetails) return summary;
        const term = deps.currentTerm();
        const unique = [...new Map((sections || [])
            .filter(section => this.sectionNeedsLocationDetail(section))
            .map(section => [String(section.crn), section])).values()];
        const record = result => {
            const status = result?.status || 'skipped';
            if (status === 'loaded') summary.loaded += 1;
            else if (status === 'failed') summary.failed += 1;
            else if (status === 'backoff' || status === 'skipped') summary.skipped += 1;
        };
        if (background) {
            if ((this.sectionDetailPrefetchPauses.get(term) || 0) > Date.now()) {
                summary.skipped = unique.length;
                summary.stopped = unique.length > 0;
                return summary;
            }
            this.sectionDetailPrefetchPauses.delete(term);
            let consecutiveFailures = 0;
            for (let index = 0; index < unique.length; index += 1) {
                if (signal?.aborted) break;
                const section = unique[index];
                const key = this.sectionDetailKey(section, term);
                const alreadyLoaded = this.sectionDetails.has(key);
                const inBackoff = this.sectionDetailFailures.get(key)?.retryAfter > Date.now();
                if (!alreadyLoaded && !inBackoff) summary.attempted += 1;
                const result = await this.hydrateSectionDetail(section, term, { foreground: false });
                record(result);
                if (result?.status === 'failed') consecutiveFailures += 1;
                else if (result?.status === 'loaded' || result?.status === 'cached') consecutiveFailures = 0;
                if (consecutiveFailures >= Math.max(1, Number(maxConsecutiveFailures) || 1)) {
                    summary.stopped = true;
                    this.sectionDetailPrefetchPauses.set(term, Date.now() + this.DETAIL_RETRY_BASE_MS);
                    break;
                }
                if (delayMs > 0 && index < unique.length - 1 && !signal?.aborted) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
            return summary;
        }
        let cursor = 0;
        const worker = async () => {
            while (cursor < unique.length && !signal?.aborted) {
                const section = unique[cursor];
                cursor += 1;
                const key = this.sectionDetailKey(section, term);
                if (!this.sectionDetails.has(key)) summary.attempted += 1;
                const result = await this.hydrateSectionDetail(section, term, { foreground });
                record(result);
                if (delayMs > 0 && cursor < unique.length && !signal?.aborted) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        };
        const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, unique.length || 1));
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return summary;
    },

    parseMeetingDetails(meetingHtml) {
        if (!meetingHtml) return [];
        const documentNode = new DOMParser().parseFromString(meetingHtml, 'text/html');
        return [...documentNode.querySelectorAll('.meet')].map(block => {
            const label = [...block.childNodes]
                .filter(node => node.nodeType === Node.TEXT_NODE)
                .map(node => node.textContent)
                .join(' ')
                .trim();
            const rawLocation = block.querySelector('a')?.textContent?.trim() || '';
            const dayToken = label.split(/\s+/)[0] || '';
            const range = this.parseTimeRange(label);
            return {
                days: this.parseDays(dayToken),
                start: range.start,
                end: range.end,
                rawLocation,
                building: this.resolveBuilding(rawLocation),
            };
        });
    },

    parseDays(token) {
        const cleaned = String(token).replace(/[^A-Za-z]/g, '');
        const days = [];
        let index = 0;
        while (index < cleaned.length) {
            const pair = cleaned.slice(index, index + 2).toLowerCase();
            if (pair === 'th') {
                days.push(3);
                index += 2;
            } else if (pair === 'tu') {
                days.push(1);
                index += 2;
            } else if (pair === 'sa') {
                days.push(5);
                index += 2;
            } else if (pair === 'su') {
                days.push(6);
                index += 2;
            } else {
                const day = { m: 0, t: 1, w: 2, r: 3, f: 4 }[cleaned[index].toLowerCase()];
                if (day !== undefined) days.push(day);
                index += 1;
            }
        }
        return [...new Set(days)];
    },

    parseTimeRange(label) {
        const match = String(label).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (!match) return { start: null, end: null };
        const endMeridiem = match[6]?.toLowerCase() || null;
        const startMeridiem = match[3]?.toLowerCase() || endMeridiem;
        return {
            start: this.clockToMinutes(match[1], match[2], startMeridiem),
            end: this.clockToMinutes(match[4], match[5], endMeridiem || startMeridiem),
        };
    },

    clockToMinutes(hourValue, minuteValue, meridiem) {
        let hour = Number(hourValue);
        const minute = Number(minuteValue || 0);
        if (meridiem === 'pm' && hour !== 12) hour += 12;
        if (meridiem === 'am' && hour === 12) hour = 0;
        return hour * 60 + minute;
    },

    parseMeetingTimes(meetingTimes) {
        if (!meetingTimes) return [];
        try {
            const raw = typeof meetingTimes === 'string' ? JSON.parse(meetingTimes) : meetingTimes;
            return raw.map(meeting => ({
                day: Number(meeting.meet_day),
                start: this.hhmmToMinutes(meeting.start_time),
                end: this.hhmmToMinutes(meeting.end_time),
            }));
        } catch (error) {
            return [];
        }
    },

    hhmmToMinutes(value) {
        const time = Number(value);
        return Math.floor(time / 100) * 60 + time % 100;
    },

    buildEvents(sections, day) {
        const events = [];
        sections.forEach(section => {
            const online = this.isOnline(section);
            const detailMeetings = this.sectionDetails.get(this.sectionDetailKey(section)) || [];
            this.parseMeetingTimes(section.meetingTimes)
                .filter(meeting => meeting.day === day)
                .forEach(meeting => {
                    const exact = detailMeetings.find(detail =>
                        detail.days.includes(day) && detail.start !== null && Math.abs(detail.start - meeting.start) <= 5
                    );
                    const dayMatch = detailMeetings.find(detail => detail.days.includes(day));
                    const detail = exact || dayMatch || detailMeetings[0] || null;
                    events.push({
                        day,
                        code: section.code || 'Class',
                        crn: section.crn,
                        start: meeting.start,
                        end: meeting.end,
                        online,
                        rawLocation: detail?.rawLocation || section.location || section.building || '',
                        building: online ? { kind: 'online', name: 'Online' } : (detail?.building || this.resolveBuilding(section.location || section.building || '')),
                    });
                });
        });
        return events.sort((left, right) => left.start - right.start || left.end - right.end);
    },

    isOnline(section) {
        const method = `${(section.instructionalMethod || section.inst_mthd) || ''} ${section.meets || ''}`.toLowerCase();
        return /online|web|remote|asynchronous|does not meet/.test(method);
    },

    resolveBuilding(rawLocation) {
        const raw = String(rawLocation || '').trim();
        if (!raw || /\btba\b|to be announced/i.test(raw)) return { kind: 'unknown', name: raw || 'TBA' };
        if (/online|web|remote|virtual/i.test(raw)) return { kind: 'online', name: 'Online' };

        const normalized = this.normalizeLocation(raw);
        const candidates = this.buildings
            .flatMap(building => [building.code, building.name, ...(building.aliases || [])].map(alias => ({ building, alias })))
            .sort((left, right) => right.alias.length - left.alias.length);
        const match = candidates.find(candidate => {
            const alias = this.normalizeLocation(candidate.alias);
            return normalized === alias || normalized.startsWith(`${alias} `);
        });
        if (!match) return { kind: 'unknown', name: raw };
        return { kind: 'known', ...match.building };
    },

    normalizeLocation(value) {
        return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    },

    async buildTransitions(events) {
        const transitions = [];
        for (let index = 0; index < events.length - 1; index += 1) {
            const from = events[index];
            const to = events[index + 1];
            const available = to.start - from.end;
            if (available < 0) continue;
            const route = await this.routeBetween(from.building, to.building);
            transitions.push({ from, to, available, ...route });
        }
        return transitions;
    },

    async routeBetween(from, to) {
        if (from.kind === 'online' || to.kind === 'online') {
            return { kind: 'online', distance: null, walkMinutes: null, geometry: null };
        }
        if (from.kind !== 'known' || to.kind !== 'known') {
            return { kind: 'unknown', distance: null, walkMinutes: null, geometry: null };
        }
        if (from.code === to.code) {
            return { kind: 'same', distance: 0, walkMinutes: 0, geometry: null };
        }

        const key = this.routeCacheKey(from, to);
        const cached = this.getCachedRoute(key);
        if (cached) return cached;
        try {
            const coordinates = `${from.lon},${from.lat};${to.lon},${to.lat}`;
            const url = `${this.ROUTE_URL}/${coordinates}?overview=full&geometries=geojson&steps=false`;
            const response = await deps.fetch(url);
            if (!response.ok) throw new Error(`Route ${response.status}`);
            const data = await response.json();
            const first = data.routes?.[0];
            if (!first) throw new Error('No route returned');
            const route = {
                kind: 'routed',
                distance: Math.round(first.distance),
                walkMinutes: Math.max(1, Math.ceil(first.duration / 60)),
                geometry: first.geometry.coordinates.map(point => [point[1], point[0]]),
            };
            this.saveRoute(key, route);
            return route;
        } catch (error) {
            const distance = Math.round(this.haversineMeters(from, to) * 1.2);
            const route = {
                kind: 'estimated',
                distance,
                walkMinutes: Math.max(1, Math.ceil(distance / 80)),
                geometry: [[from.lat, from.lon], [to.lat, to.lon]],
            };
            this.saveRoute(key, route);
            return route;
        }
    },

    haversineMeters(from, to) {
        const radians = degrees => degrees * Math.PI / 180;
        const earthRadius = 6371000;
        const latDelta = radians(to.lat - from.lat);
        const lonDelta = radians(to.lon - from.lon);
        const value = Math.sin(latDelta / 2) ** 2 +
            Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(lonDelta / 2) ** 2;
        return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
    },

    routeCacheKey(from, to) {
        const point = building => [building.code, building.lat, building.lon]
            .map(value => typeof value === 'number' ? value.toFixed(6) : String(value || ''))
            .join('@');
        return `${this.catalogRevision}|${point(from)}>${point(to)}`;
    },

    getCachedRoute(key) {
        const entry = this.routeCache.get(key);
        if (!entry) return null;
        if (!entry.route || Number(entry.expiresAt) <= Date.now()) {
            this.routeCache.delete(key);
            this.persistRoutes();
            return null;
        }
        this.routeCache.delete(key);
        this.routeCache.set(key, entry);
        return entry.route;
    },

    transitionStatus(transition) {
        if (transition.kind === 'online') return { className: 'neutral', label: 'No campus travel' };
        if (transition.kind === 'same') return { className: 'neutral', label: 'Same building' };
        if (transition.kind === 'unknown') return { className: 'neutral', label: 'Location needed' };
        const buffer = transition.available - transition.walkMinutes;
        if (buffer < 0) return { className: 'late', label: `${Math.abs(buffer)} min short` };
        if (buffer < 5) return { className: 'tight', label: `${buffer} min buffer` };
        return { className: 'safe', label: `${buffer} min buffer` };
    },

    routeColor(transition) {
        if (this.selectedDay === 'all') {
            return this.ROUTE_COLORS[transition.from.day] || '#73000A';
        }
        return '#73000A';
    },

    renderTransitions(events, transitions) {
        this._lockedTransitionIndex = null;
        this._previewTransitionIndex = null;
        const showingWeek = this.selectedDay === 'all';
        const periodLabel = showingWeek ? 'this week' : this.DAYS[this.selectedDay];
        if (events.length === 0) {
            const selectedCount = !deps.selectedSections
                ? 0
                : Object.keys(deps.selectedSections() || {}).length;
            const message = selectedCount > 0
                ? (showingWeek
                    ? 'All selected classes were processed, but none has a scheduled campus meeting to map. There are no transitions to check.'
                    : `No selected class has a scheduled campus meeting on ${periodLabel}.`)
                : `No classes are selected ${showingWeek ? 'for this week' : `on ${periodLabel}`}.`;
            this.listElement.innerHTML = `<p class="walking-map-empty">${message}</p>`;
            return;
        }
        if (!showingWeek && events.length === 1) {
            this.listElement.innerHTML = `<p class="walking-map-empty">Only one scheduled class on ${periodLabel}. There is no between-class route to check.</p>`;
            return;
        }
        if (transitions.length === 0) {
            const message = showingWeek
                ? 'Class locations are shown on the map. No two selected classes meet consecutively on the same day, so there are no transitions to check.'
                : `The scheduled classes on ${periodLabel} do not create a between-class transition to check.`;
            this.listElement.innerHTML = `<p class="walking-map-empty">${message}</p>`;
            return;
        }

        const risky = transitions.filter(transition => this.transitionStatus(transition).className === 'late').length;
        const summary = risky > 0
            ? `${risky} transition${risky === 1 ? '' : 's'} may not leave enough travel time.`
            : `${transitions.length} transition${transitions.length === 1 ? '' : 's'} checked. No travel-time shortage found.`;
        this.listElement.innerHTML = `<div class="walking-map-summary">${summary}</div>`;

        transitions.forEach((transition, index) => {
            const status = this.transitionStatus(transition);
            const card = document.createElement(transition.geometry ? 'button' : 'div');
            if (card.tagName === 'BUTTON') card.type = 'button';
            card.className = `walking-transition status-${status.className}`;
            if (transition.geometry) {
                card.classList.add('has-route');
                card.style.setProperty('--transition-color', this.routeColor(transition));
            }
            const noRouteNeeded = transition.kind === 'online' || transition.kind === 'same';
            if (noRouteNeeded) card.classList.add('no-route-needed');
            const walkLabel = transition.walkMinutes === null
                ? (transition.kind === 'online' ? 'No route needed' : 'Route unavailable')
                : (transition.kind === 'same' ? 'No route needed' : `${transition.walkMinutes} min route`);
            const distanceLabel = transition.distance === null ? '' : ` · ${this.formatDistance(transition.distance)}`;
            const dayLabel = showingWeek ? `${this.DAYS[transition.from.day].slice(0, 3).toUpperCase()} · ` : '';
            card.innerHTML = `
                <div class="walking-transition-title">
                    <span>${dayLabel}${this.escapeHtml(transition.from.code)} → ${this.escapeHtml(transition.to.code)}</span>
                    <span class="walking-transition-time">${this.formatTime(transition.from.end)}–${this.formatTime(transition.to.start)}</span>
                </div>
                <div class="walking-transition-buildings">${this.escapeHtml(transition.from.building.name)} → ${this.escapeHtml(transition.to.building.name)}</div>
                <div class="walking-transition-metrics">
                    <span>${transition.available} min available · ${walkLabel}${distanceLabel}</span>
                    <span class="walking-transition-status">${status.label}</span>
                </div>
            `;
            if (transition.geometry) {
                card.dataset.transitionIndex = String(index);
                card.setAttribute('aria-label', `Show route from ${transition.from.code} to ${transition.to.code}`);
                card.setAttribute('aria-pressed', 'false');
                card.addEventListener('mouseenter', () => this.previewTransition(index));
                card.addEventListener('focus', () => this.previewTransition(index));
                card.addEventListener('blur', event => {
                    if (event.relatedTarget?.classList?.contains('walking-transition')) return;
                    this.clearTransitionPreview(index);
                });
                card.addEventListener('click', () => this.focusTransition(index));
            }
            this.listElement.appendChild(card);
        });
        this._currentTransitions = transitions;
    },

    async renderMap(events, transitions) {
        const knownEvents = events.filter(event => event.building.kind === 'known');
        try {
            await this.loadLeaflet();
        } catch (error) {
            this.mapElement.innerHTML = '<p class="walking-map-empty" style="padding:16px">The interactive map could not load. Route details are still available in the list.</p>';
            return;
        }

        if (!this._map) {
            this._map = L.map(this.mapElement, {
                zoomControl: true,
                scrollWheelZoom: false,
            }).setView(this.DEFAULT_CENTER, 15);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors',
            }).addTo(this._map);
            this._layer = L.layerGroup().addTo(this._map);
        }
        this._layer.clearLayers();
        this._routeLayers = [];
        setTimeout(() => this._map.invalidateSize(), 0);

        const bounds = [];
        const locations = new Map();
        knownEvents.forEach(event => {
            const key = event.building.code || `${event.building.lat},${event.building.lon}`;
            if (!locations.has(key)) locations.set(key, { building: event.building, events: [] });
            locations.get(key).events.push(event);
        });
        [...locations.values()].forEach((location, index) => {
            const position = [location.building.lat, location.building.lon];
            bounds.push(position);
            const marker = L.marker(position, {
                icon: L.divIcon({
                    className: '',
                    html: `<span class="walking-map-marker">${index + 1}</span>`,
                    iconSize: [24, 24],
                    iconAnchor: [12, 12],
                }),
            });
            const classList = location.events
                .sort((left, right) => left.day - right.day || left.start - right.start)
                .map(event => `${this.DAYS[event.day]?.slice(0, 3).toUpperCase() || ''} ${this.escapeHtml(event.code)} · ${this.formatTime(event.start)}`)
                .join('<br>');
            marker.bindPopup(`<strong>${this.escapeHtml(location.building.name)}</strong><br>${classList}`);
            marker.addTo(this._layer);
        });

        transitions.forEach((transition, index) => {
            if (!transition.geometry) return;
            transition.geometry.forEach(point => bounds.push(point));
            const baseStyle = {
                color: this.routeColor(transition),
                weight: 5,
                opacity: 0.9,
                dashArray: transition.kind === 'estimated' ? '8 6' : null,
            };
            const layer = L.polyline(transition.geometry, baseStyle).addTo(this._layer);
            this._routeLayers[index] = { layer, baseStyle };
        });

        if (bounds.length > 1) this._overviewView = { kind: 'bounds', value: bounds.map(point => [...point]) };
        else if (bounds.length === 1) this._overviewView = { kind: 'point', value: [...bounds[0]] };
        else this._overviewView = { kind: 'default', value: [...this.DEFAULT_CENTER] };
        this.restoreOverview();
    },

    resetRouteStyles() {
        this._routeLayers.forEach(route => {
            if (route) route.layer.setStyle(route.baseStyle);
        });
    },

    restoreOverview() {
        if (!this._map || !this._overviewView) return;
        if (this._overviewView.kind === 'bounds') {
            this._map.fitBounds(this._overviewView.value, { padding: [28, 28], maxZoom: 17 });
        } else if (this._overviewView.kind === 'point') {
            this._map.setView(this._overviewView.value, 17);
        } else {
            this._map.setView(this._overviewView.value, 15);
        }
    },

    showTransition(index, locked = false) {
        const transition = this._currentTransitions?.[index];
        if (!transition?.geometry || !this._map) return;
        this.listElement?.querySelectorAll('button.walking-transition').forEach(card => {
            const selected = Number(card.dataset.transitionIndex) === index;
            card.classList.toggle('is-selected', selected && locked);
            card.classList.toggle('is-previewed', selected && !locked);
            card.setAttribute('aria-pressed', String(selected && locked));
        });
        this.resetRouteStyles();
        const selectedRoute = this._routeLayers[index];
        if (selectedRoute) {
            selectedRoute.layer.setStyle({
                ...selectedRoute.baseStyle,
                opacity: 1,
                weight: 8,
            });
            selectedRoute.layer.bringToFront();
        }
        this._map.fitBounds(transition.geometry, { padding: [35, 35], maxZoom: 18 });
    },

    previewTransition(index) {
        if (this._lockedTransitionIndex === index) return;
        this._previewTransitionIndex = index;
        this.showTransition(index, false);
    },

    clearTransitionPreview(index) {
        if (this._previewTransitionIndex !== index) return;
        this._previewTransitionIndex = null;
        if (this._lockedTransitionIndex !== null) {
            this.showTransition(this._lockedTransitionIndex, true);
            return;
        }
        this.listElement?.querySelectorAll('button.walking-transition').forEach(card => {
            card.classList.toggle('is-previewed', false);
            card.classList.toggle('is-selected', false);
            card.setAttribute('aria-pressed', 'false');
        });
        this.resetRouteStyles();
        this.restoreOverview();
    },

    focusTransition(index) {
        this._lockedTransitionIndex = index;
        this._previewTransitionIndex = null;
        this.showTransition(index, true);
    },

    loadLeaflet() {
        if (window.L) return Promise.resolve();
        if (this._leafletPromise) return this._leafletPromise;
        this._leafletPromise = new Promise((resolve, reject) => {
            if (!document.querySelector(`link[href="${this.LEAFLET_CSS}"]`)) {
                const stylesheet = document.createElement('link');
                stylesheet.rel = 'stylesheet';
                stylesheet.href = this.LEAFLET_CSS;
                document.head.appendChild(stylesheet);
            }
            const script = document.createElement('script');
            script.src = this.LEAFLET_JS;
            script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
            script.crossOrigin = 'anonymous';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
        return this._leafletPromise;
    },

    loadStoredRoutes() {
        try {
            const stored = JSON.parse(deps.storage.getItem(this.ROUTE_CACHE_KEY) || '{}');
            const entries = Object.entries(stored.entries || {})
                .filter(([key, entry]) => (
                    key.startsWith(`${this.catalogRevision}|`)
                    && entry?.route
                    && Number(entry.expiresAt) > Date.now()
                ))
                .sort((left, right) => Number(left[1].storedAt || 0) - Number(right[1].storedAt || 0))
                .slice(-this.ROUTE_CACHE_MAX_ENTRIES);
            this.routeCache = new Map(entries);
        } catch (error) {
            this.routeCache.clear();
        }
    },

    saveRoute(key, route) {
        const storedAt = Date.now();
        this.routeCache.delete(key);
        this.routeCache.set(key, {
            route,
            storedAt,
            expiresAt: storedAt + this.ROUTE_CACHE_TTL_MS,
        });
        while (this.routeCache.size > this.ROUTE_CACHE_MAX_ENTRIES) {
            this.routeCache.delete(this.routeCache.keys().next().value);
        }
        this.persistRoutes();
    },

    persistRoutes() {
        try {
            deps.storage.setItem(this.ROUTE_CACHE_KEY, JSON.stringify({
                version: 2,
                entries: Object.fromEntries(this.routeCache),
            }));
        } catch (error) {
            // Route caching is optional.
        }
    },

    formatDistance(meters) {
        const feet = Math.round(meters * 3.28084 / 10) * 10;
        return feet >= 1000 ? `${(feet / 5280).toFixed(2)} mi` : `${feet} ft`;
    },

    formatTime(minutes) {
        const hour24 = Math.floor(minutes / 60);
        const minute = minutes % 60;
        const hour12 = hour24 % 12 || 12;
        return `${hour12}:${String(minute).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
    },

    escapeHtml(value) {
        const node = document.createElement('span');
        node.textContent = String(value ?? '');
        return node.innerHTML;
    },
        };

        return feature;
    }

    return { createMapFeature };
}));

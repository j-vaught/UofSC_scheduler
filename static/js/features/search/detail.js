/*
 * The course detail pane: sections, calendar, locations, resources.
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
(function initDetailPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SearchParts) root.SearchParts = {};
    root.SearchParts.createDetailPart = api.createDetailPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createDetailPart(deps) {
        return {
        stripHtml(value) {
            return this.decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' '))
                .replace(/\s+/g, ' ')
                .trim();
        },

        decodeHtmlEntities(value) {
            const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
            return String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
                if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
                const hexadecimal = entity[1]?.toLowerCase() === 'x';
                const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
                const isValidCodePoint = Number.isInteger(codePoint)
                    && codePoint >= 0
                    && codePoint <= 0x10FFFF
                    && !(codePoint >= 0xD800 && codePoint <= 0xDFFF);
                return isValidCodePoint ? String.fromCodePoint(codePoint) : match;
            });
        },

        detailLiveSections(group = this._detailGroup) {
            return (group?.sections || []).filter(section => section.crn && !section._isCatalog);
        },

        sortedDetailSections(group = this._detailGroup) {
            return [...this.detailLiveSections(group)].sort((left, right) => {
                const leftOpen = !left.stat || left.stat === 'A';
                const rightOpen = !right.stat || right.stat === 'A';
                if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
                const sectionOrder = String(left.section || '').localeCompare(
                    String(right.section || ''),
                    'en',
                    { numeric: true, sensitivity: 'base' },
                );
                if (sectionOrder) return sectionOrder;
                return String(left.crn || '').localeCompare(String(right.crn || ''), 'en', { numeric: true });
            });
        },

        preferredDetailSection(group) {
            const sections = this.sortedDetailSections(group);
            const locked = String(deps.state.sectionLocks?.[group.code] || '');
            const applied = String(deps.state.selectedSections?.[group.code]?.crn || '');
            return sections.find(section => String(section.crn) === locked)
                || sections.find(section => String(section.crn) === applied)
                || sections.find(section => section.stat === 'A')
                || sections[0]
                || null;
        },

        leaveCourseDetail({ focus = true } = {}) {
            this._detailToken = (this._detailToken || 0) + 1;
            this._sectionDetailToken = (this._sectionDetailToken || 0) + 1;
            this.destroyDetailMap();
            this.setBrowseState('results');
            document.querySelectorAll('#search-results .course-group').forEach(card => {
                card.classList.remove('active');
                card.removeAttribute('aria-current');
            });
            const trigger = this._lastDetailTrigger;
            if (!focus) return;
            requestAnimationFrame(() => {
                if (trigger?.isConnected) trigger.focus();
                else document.getElementById('keyword-input')?.focus();
            });
        },

        closeCourseDetail({ historyMode = 'auto' } = {}) {
            const url = new URL(window.location.href);
            url.searchParams.delete('course');
            url.searchParams.delete('crn');
            url.searchParams.delete('panel');
            const resultUrl = `${url.pathname}${url.search}`;
            const canReturnToParent = historyMode === 'auto'
                && history.state?.courseDetail
                && history.state?.detailParent === resultUrl;
            this.leaveCourseDetail();
            if (historyMode === 'none') return;
            if (canReturnToParent) {
                history.back();
                return;
            }
            this.writeCourseDetailHistory({
                mode: historyMode === 'auto' ? 'replace' : historyMode,
                course: '',
            });
        },

        handleCourseTabKeydown(event) {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const tabs = [...document.querySelectorAll('[data-course-tab]')];
            const index = tabs.indexOf(event.currentTarget);
            if (index < 0) return;
            event.preventDefault();
            const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            this.setCourseDetailTab(tabs[nextIndex].dataset.courseTab, true);
        },

        setCourseDetailTab(tab, focus = false, historyMode = 'replace') {
            const allowed = new Set(['overview', 'grades', 'history', 'resources']);
            const active = allowed.has(tab) ? tab : 'overview';
            const scrollContainer = document.getElementById('semester-content');
            const savedScrollTop = Number(scrollContainer?.scrollTop) || 0;
            const panelHost = document.querySelector?.('.course-detail-panels');
            if (scrollContainer && panelHost) {
                const viewportHeight = Math.max(0, Number(scrollContainer.clientHeight) || 0);
                const scrollRect = scrollContainer.getBoundingClientRect?.();
                const panelRect = panelHost.getBoundingClientRect?.();
                const panelTop = scrollRect && panelRect
                    ? savedScrollTop + panelRect.top - scrollRect.top
                    : Number(panelHost.offsetTop) || 0;
                const requiredHeight = Math.max(
                    viewportHeight,
                    savedScrollTop + viewportHeight - panelTop,
                );
                if (requiredHeight > 0) panelHost.style.minHeight = `${Math.ceil(requiredHeight)}px`;
            }
            this._detailTab = active;
            document.querySelectorAll('[data-course-tab]').forEach(button => {
                const selected = button.dataset.courseTab === active;
                button.setAttribute('aria-selected', String(selected));
                button.tabIndex = selected ? 0 : -1;
                if (selected && focus) button.focus({ preventScroll: true });
            });
            document.querySelectorAll('[data-course-panel]').forEach(panel => {
                panel.hidden = panel.dataset.coursePanel !== active;
            });
            this.loadCourseDetailTab(active);
            if (this._browseState === 'detail') {
                this.writeCourseDetailHistory({ mode: historyMode });
            }
            const restoreScroll = () => {
                if (!scrollContainer
                    || scrollContainer.isConnected === false
                    || this._detailTab !== active) return;
                scrollContainer.scrollTop = savedScrollTop;
            };
            restoreScroll();
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restoreScroll);
        },

        loadCourseDetailTab(tab) {
            const code = this._detailGroup?.code;
            if (!code) return;
            const loadKey = `${this._detailToken}:${tab}`;
            if (this._detailLoads[loadKey]) return;
            this._detailLoads[loadKey] = true;
            if (tab === 'grades' && deps.grades) deps.grades.loadForCourse(code);
            if (tab === 'history' && deps.history) deps.history.loadForCourse(code);
            if (tab === 'resources') this.renderCourseResources();
        },

        async hydrateFullDetailGroup(group, token, term) {
            const subject = String(group.code || '').split(' ')[0];
            if (!subject) return;
            try {
                const data = await deps.api.searchCourses(term, [{ field: 'subject', value: subject }]);
                if (token !== this._detailToken || term !== this._detailTerm) return;
                const sections = (data.results || []).filter(section => section.code === group.code);
                if (!sections.length) return;
                const viewedCrn = this._detailSectionCrn;
                this._detailGroup = { ...group, sections };
                if (!sections.some(section => String(section.crn) === viewedCrn)) {
                    this._detailSectionCrn = String(this.preferredDetailSection(this._detailGroup)?.crn || '');
                }
                if (this._detailTab === 'grades' && deps.grades) {
                    deps.grades.refreshCourseFaculty(group.code);
                }
                this.renderCourseDetailHeader(this._detailDetails);
                this.renderDetailSections();
                this.selectDetailSection(this._detailSectionCrn, false, 'replace');
            } catch (error) {
                // The filtered result sections remain usable if full-course hydration fails.
            }
        },

        showCourseDetail(group, {
            sectionCrn = '',
            panel = 'overview',
            historyMode = 'push',
        } = {}) {
            const detailsTab = document.getElementById('tab-details');
            if (!detailsTab || !group) return;
            if (historyMode !== 'none') this.cancelLocationRestore();
            this._detailToken = (this._detailToken || 0) + 1;
            this.destroyDetailMap();
            const token = this._detailToken;
            this._detailTerm = deps.state.term;
            this._detailGroup = group;
            this._detailDetails = null;
            this._detailFaculty = [];
            this._detailSectionData = {};
            this._detailLoads = {};
            const requestedSection = this.detailLiveSections(group).find(section => (
                String(section.crn) === String(sectionCrn)
            ));
            this._detailSectionCrn = String(
                requestedSection?.crn || this.preferredDetailSection(group)?.crn || '',
            );
            if (document.activeElement?.closest?.('.course-group')) {
                this._lastDetailTrigger = document.activeElement.closest('.course-group');
            }
            this.setBrowseState('detail');
            document.querySelectorAll('#search-results .course-group').forEach(card => {
                const selected = card.dataset.courseCode === group.code;
                card.classList.toggle('active', selected);
                if (selected) card.setAttribute('aria-current', 'true');
                else card.removeAttribute('aria-current');
            });

            this.renderCourseDetailHeader(null);
            this.renderDetailSections();
            this.selectDetailSection(this._detailSectionCrn, false, 'none');
            this.setCourseDetailTab(panel, false, 'none');
            const currentHasDetail = new URL(window.location.href).searchParams.has('course');
            this.writeCourseDetailHistory({
                mode: historyMode === 'push' && currentHasDetail ? 'replace' : historyMode,
            });
            if (deps.prereqs) deps.prereqs.loadForCourse(group.code);
            this.hydrateFullDetailGroup(group, token, this._detailTerm);
            this.fetchBulletinDetailsForCourse(group.code).then(details => {
                if (token !== this._detailToken) return;
                this._detailDetails = details || {};
                this.renderCourseDetailHeader(this._detailDetails);
                this.renderCourseOverview();
                this.renderCourseResources();
            }).catch(() => {
                if (token !== this._detailToken) return;
                this._detailDetails = {};
                this.renderCourseDetailHeader(this._detailDetails);
            });
        },

        renderCourseDetailHeader(details) {
            const header = document.getElementById('tab-details');
            const descriptionWrap = document.getElementById('course-detail-description-wrap');
            const group = this._detailGroup;
            if (!header || !group) return;
            const availability = this.courseAvailability(group);
            const selected = deps.state.isCourseSelected(group.code);
            const unschedulable = ['unavailable', 'unknown'].includes(availability.kind) && !selected;
            const unavailableLabel = availability.kind === 'unknown'
                ? 'LIVE SECTIONS UNAVAILABLE'
                : 'NOT OFFERED THIS TERM';
            const unavailableTitle = availability.kind === 'unknown'
                ? 'Live sections could not be checked from this browser'
                : 'This course has no sections in the selected term';
            const credits = deps.scheduler
                ? deps.scheduler.parseCreditHours(
                    details?.hours_html
                    || details?.hours
                    || group.credits
                    || group.sections?.[0]?.hours,
                )
                : null;
            const description = this.stripHtml(details?.description);
            const descriptionMarkup = description
                ? `<p class="course-detail-description">${this.escapeText(description)}</p>`
                : details === null
                    ? '<p class="course-detail-description loading">Loading course description</p>'
                    : '<p class="course-detail-description unavailable">Course description is unavailable.</p>';
            const selectedSection = this.currentDetailSection();
            const sectionContext = selectedSection
                ? `Section ${selectedSection.section || '—'} · CRN ${selectedSection.crn}`
                : 'No section selected';
            header.innerHTML = `
                <div class="course-detail-header-topline">
                    <div class="course-detail-kicker">Course details</div>
                    <div class="course-detail-header-controls">
                        <div class="course-detail-primary-actions">
                            <button id="btn-course-toggle" type="button" class="${selected ? 'btn-danger' : unschedulable ? 'btn-course-unavailable' : 'btn-green'}" title="${selected ? 'Remove this course from the semester scheduler' : unschedulable ? unavailableTitle : 'Add this course so the scheduler can choose a section'}"${unschedulable ? ' disabled' : ''}>${selected ? 'REMOVE COURSE' : unschedulable ? unavailableLabel : 'ADD COURSE'}</button>
                            <button id="btn-course-view-schedule" type="button" class="btn-header-secondary" title="Open the semester schedule builder">VIEW SCHEDULE</button>
                        </div>
                        <div class="course-detail-credit"><strong>${credits ?? '—'}</strong><span>${credits === 1 ? 'credit' : 'credits'}</span></div>
                    </div>
                </div>
                <div class="course-detail-title-row">
                    <div class="course-detail-title-copy">
                        <h1><span>${this.escapeText(group.code)}</span>${this.escapeText(details?.title || group.title || '')}</h1>
                        <div class="course-detail-header-meta">
                            <p class="course-detail-availability ${availability.kind}">${availability.text}</p>
                            <span>${this.escapeText(sectionContext)}</span>
                        </div>
                    </div>
                </div>
            `;
            if (descriptionWrap) descriptionWrap.innerHTML = descriptionMarkup;
            header.querySelector('#btn-course-toggle')?.addEventListener('click', async () => {
                if (deps.state.isCourseSelected(group.code)) deps.state.removeCourse(group.code);
                else await deps.scheduler.addCourseGroup(this._detailGroup);
                this.updateCourseSelectionStyles(group.code);
                this.renderCourseDetailHeader(this._detailDetails);
                const cached = this._detailSectionData?.[this._detailSectionCrn];
                this.renderSectionSummary(this.currentDetailSection(), cached?.details, cached?.faculty || []);
            });
            header.querySelector('#btn-course-view-schedule')?.addEventListener('click', () => {
                deps.tabs.switchTo('schedule');
            });
        },

        renderCourseOverview() {
            const container = document.getElementById('course-overview-content');
            if (!container || !this._detailGroup) return;
            const details = this._detailDetails || {};
            const sectionDetails = this._detailSectionData?.[this._detailSectionCrn]?.details || {};
            const attributes = [details.attributes, details.carolina_core, details.course_attributes]
                .map(value => this.stripHtml(value)).filter(Boolean);
            const requirements = [
                ['Corequisites', details.corequisite || details.corequisites || sectionDetails.course_coreqs],
                ['Prerequisite or corequisite', details.prerequisite_or_corequisite],
                ['Registration restrictions', details.registration_restrictions || details.restrictions],
            ].map(([label, value]) => [label, this.stripHtml(value)]).filter(([, value]) => value);
            container.innerHTML = `
                ${attributes.length ? `<section class="course-detail-card">
                    <div class="course-detail-card-heading"><h2>Course attributes</h2></div>
                    <p>${this.escapeText(attributes.join(' · '))}</p>
                </section>` : ''}
                ${requirements.length ? `<section class="course-detail-card">
                    <div class="course-detail-card-heading"><h2>Course requirements</h2></div>
                    <div class="course-requirement-list">${requirements.map(([label, value]) => `<p><strong>${this.escapeText(label)}</strong><span>${this.escapeText(value)}</span></p>`).join('')}</div>
                </section>` : ''}
            `;
        },

        currentDetailSection() {
            return this.detailLiveSections().find(section => String(section.crn) === String(this._detailSectionCrn)) || null;
        },

        renderDetailSections() {
            const group = this._detailGroup;
            if (!group) return;
            const sections = this.sortedDetailSections(group);
            const wrap = document.getElementById('course-section-picker-wrap');
            const picker = document.getElementById('course-section-picker');
            const count = document.getElementById('course-section-picker-count');
            if (!wrap || !picker) return;
            const availability = this.courseAvailability(group);
            wrap.hidden = false;
            if (count) count.textContent = availability.kind === 'unknown'
                ? 'Live availability unavailable'
                : `${sections.length} this term`;
            if (!sections.length) {
                picker.innerHTML = availability.kind === 'unknown'
                    ? '<div class="course-detail-empty-state"><strong>Live sections unavailable</strong><p>Catalog, offering history, and grade data are still available below.</p></div>'
                    : '<div class="course-detail-empty-state"><strong>Not offered this term</strong><p>This course remains available in catalog search and offering history.</p></div>';
                return;
            }
            picker.innerHTML = sections.map(section => {
                const selected = String(section.crn) === this._detailSectionCrn;
                return `
                <button type="button" class="course-section-option ${section.stat === 'A' ? 'open' : 'full'}" data-detail-crn="${this.escapeText(section.crn)}" aria-pressed="${selected}" tabindex="${selected ? '0' : '-1'}" title="View Section ${this.escapeText(section.section || '—')} details">
                    <span><i aria-hidden="true"></i>Section ${this.escapeText(section.section || '—')}<b>${section.stat === 'A' ? 'Open' : 'Full'}</b></span>
                    <small>${this.escapeText(section.meets || 'Time TBA')}</small>
                    <em>${this.escapeText((section.instructor || section.instr) && (section.instructor || section.instr) !== 'Staff' ? (section.instructor || section.instr) : 'Instructor TBA')} · CRN ${this.escapeText(section.crn)}</em>
                </button>
            `;
            }).join('');
            picker.querySelectorAll('[data-detail-crn]').forEach(button => {
                button.addEventListener('click', () => this.selectDetailSection(button.dataset.detailCrn));
                button.addEventListener('keydown', event => this.handleSectionPickerKeydown(event));
            });
        },

        handleSectionPickerKeydown(event) {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const buttons = [...document.querySelectorAll('#course-section-picker [data-detail-crn]')];
            const index = buttons.indexOf(event.currentTarget);
            if (index < 0) return;
            event.preventDefault();
            const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                    ? buttons.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
            this.selectDetailSection(buttons[nextIndex].dataset.detailCrn, true);
        },

        selectDetailSection(crn, focusPicker = true, historyMode = 'replace') {
            const section = this.detailLiveSections().find(item => String(item.crn) === String(crn))
                || this.preferredDetailSection(this._detailGroup);
            this._detailSectionCrn = String(section?.crn || '');
            this._detailFaculty = [];
            this.destroyDetailMap();
            if (this._browseState === 'detail') this.renderCourseDetailHeader(this._detailDetails);
            let selectedButton = null;
            document.querySelectorAll('[data-detail-crn]').forEach(button => {
                const selected = String(button.dataset.detailCrn) === this._detailSectionCrn;
                button.setAttribute('aria-pressed', String(selected));
                button.tabIndex = selected ? 0 : -1;
                button.classList.toggle('selected', selected);
                if (selected) selectedButton = button;
            });
            this.renderSectionSummary(section);
            this.renderCourseResources();
            this.refreshDetailGrades();
            if (this._browseState === 'detail') {
                this.writeCourseDetailHistory({ mode: historyMode });
            }
            requestAnimationFrame(() => {
                selectedButton?.scrollIntoView({ block: 'nearest', inline: 'center' });
                if (focusPicker) selectedButton?.focus();
            });
            if (!section) return;
            const request = (this._sectionDetailToken || 0) + 1;
            this._sectionDetailToken = request;
            const term = this._detailTerm;
            Promise.allSettled([
                deps.api.getDetails(section.crn, term),
                this.loadSectionFaculty(section, term),
            ]).then(([detailsResult, facultyResult]) => {
                if (request !== this._sectionDetailToken || String(section.crn) !== this._detailSectionCrn) return;
                const details = detailsResult.status === 'fulfilled' ? detailsResult.value : null;
                const faculty = facultyResult.status === 'fulfilled' ? facultyResult.value : [];
                this._detailSectionData[this._detailSectionCrn] = { details, faculty };
                this._detailFaculty = faculty;
                this.renderSectionSummary(section, details, faculty);
                this.renderCourseOverview();
                this.renderCourseResources(section, faculty);
                this.refreshDetailGrades();
            });
        },

        refreshDetailGrades() {
            if (this._detailTab !== 'grades' || !deps.grades) return;
            const code = this._detailGroup?.code;
            const data = deps.grades._courseCache?.[code];
            const container = document.getElementById('grades-container');
            if (data && container) deps.grades.renderCourse(container, data);
        },

        async loadSectionFaculty(section, term) {
            const key = `${term}:${section.crn}`;
            if (!this._facultyCache[key]) {
                this._facultyCache[key] = deps.api.getFaculty(term, [section.crn])
                    .then(data => data.faculty || []).catch(() => []);
            }
            return this._facultyCache[key];
        },

        detailMeetingEvents(section, details = null) {
            const canUseWalkingMap = deps.walkingMap;
            const detailMeetings = details?.meeting_html && canUseWalkingMap && deps.walkingMap.parseMeetingDetails
                ? deps.walkingMap.parseMeetingDetails(details.meeting_html)
                : [];
            const listedEvents = canUseWalkingMap && deps.walkingMap.parseMeetingTimes
                ? deps.walkingMap.parseMeetingTimes(section?.meetingTimes || '')
                : [];
            const fallbackLocation = section?.location || section?.building || '';
            const resolveBuilding = rawLocation => (
                canUseWalkingMap && deps.walkingMap.resolveBuilding
                    ? deps.walkingMap.resolveBuilding(rawLocation)
                    : null
            );
            let events = listedEvents.map(event => {
                const exact = detailMeetings.find(meeting => (
                    meeting.days?.includes(event.day)
                    && Number.isFinite(meeting.start)
                    && Math.abs(meeting.start - event.start) <= 5
                ));
                const sameDay = detailMeetings.find(meeting => meeting.days?.includes(event.day));
                const meeting = exact || sameDay || detailMeetings[0] || null;
                const rawLocation = meeting?.rawLocation || fallbackLocation;
                return {
                    ...event,
                    rawLocation,
                    building: meeting?.building || resolveBuilding(rawLocation),
                };
            });
            if (!events.length) {
                events = detailMeetings.flatMap(meeting => (meeting.days || []).map(day => ({
                    day,
                    start: meeting.start,
                    end: meeting.end,
                    rawLocation: meeting.rawLocation || fallbackLocation,
                    building: meeting.building || resolveBuilding(meeting.rawLocation || fallbackLocation),
                })));
            }
            return events.filter(event => Number.isFinite(event.day)
                && Number.isFinite(event.start)
                && Number.isFinite(event.end)
                && event.end > event.start);
        },

        sectionCalendarRange(events) {
            const earliestAllowed = 8 * 60;
            const latestAllowed = 21 * 60;
            const minimumSpan = 4 * 60;
            if (!events.length) return { start: earliestAllowed, end: earliestAllowed + minimumSpan };
            const earliest = Math.min(...events.map(event => event.start));
            const latest = Math.max(...events.map(event => event.end));
            let start = Math.max(earliestAllowed, earliest - 30);
            let end = Math.min(latestAllowed, latest + 30);
            if (end <= start) return { start: earliestAllowed, end: earliestAllowed + minimumSpan };
            if (end - start < minimumSpan) {
                end = start + minimumSpan;
                if (end > latestAllowed) {
                    end = latestAllowed;
                    start = Math.max(earliestAllowed, end - minimumSpan);
                }
            }
            return { start, end };
        },

        formatSectionTime(minutes) {
            if (deps.walkingMap && deps.walkingMap.formatTime) {
                return deps.walkingMap.formatTime(minutes);
            }
            const hour24 = Math.floor(minutes / 60);
            const minute = minutes % 60;
            const hour12 = hour24 % 12 || 12;
            return `${hour12}:${String(minute).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
        },

        sectionLocationStyle(index) {
            const palette = [
                { color: '#73000A', foreground: '#FFFFFF' },
                { color: '#466A9F', foreground: '#FFFFFF' },
                { color: '#1F414D', foreground: '#FFFFFF' },
                { color: '#65780B', foreground: '#FFFFFF' },
                { color: '#CC2E40', foreground: '#FFFFFF' },
                { color: '#000000', foreground: '#FFFFFF' },
            ];
            return palette[index % palette.length];
        },

        sectionTimeLocationData(section, details = null) {
            const locations = [];
            const locationIndexes = new Map();
            const events = this.detailMeetingEvents(section, details).map((event, eventIndex) => {
                const rawLocation = String(
                    event.rawLocation || section?.location || section?.building || '',
                ).trim();
                let building = event.building || null;
                if ((!building || building.kind === 'unknown')
                    && rawLocation
                    && deps.walkingMap
                    && deps.walkingMap.resolveBuilding) {
                    building = deps.walkingMap.resolveBuilding(rawLocation);
                }
                const isOnline = building?.kind === 'online'
                    || /\bonline\b|\bweb\b|\bremote\b|\bvirtual\b/i.test(rawLocation);
                let locationIndex = null;
                if (rawLocation && !isOnline) {
                    const normalized = deps.walkingMap && deps.walkingMap.normalizeLocation
                        ? deps.walkingMap.normalizeLocation(rawLocation)
                        : rawLocation.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                    const buildingKey = building?.kind === 'known'
                        ? building.code || building.id || `${building.lat}:${building.lon}`
                        : normalized;
                    const key = `${building?.kind === 'known' ? 'building' : 'location'}:${buildingKey}`;
                    if (!locationIndexes.has(key)) {
                        locationIndex = locations.length;
                        locationIndexes.set(key, locationIndex);
                        locations.push({
                            index: locationIndex,
                            number: locationIndex + 1,
                            label: rawLocation || building?.name || 'Campus location',
                            building,
                            ...this.sectionLocationStyle(locationIndex),
                        });
                    } else {
                        locationIndex = locationIndexes.get(key);
                    }
                }
                const style = Number.isInteger(locationIndex)
                    ? this.sectionLocationStyle(locationIndex)
                    : { color: '#5C5C5C', foreground: '#FFFFFF' };
                return {
                    ...event,
                    eventIndex,
                    rawLocation,
                    building,
                    locationIndex,
                    locationNumber: Number.isInteger(locationIndex) ? locationIndex + 1 : null,
                    ...style,
                };
            });
            const range = this.sectionCalendarRange(events);
            const dayCount = events.some(event => event.day > 4) ? 7 : 5;
            return {
                events,
                locations,
                range,
                dayCount,
                rangeLabel: `${this.formatSectionTime(range.start)}–${this.formatSectionTime(range.end)}`,
            };
        },

        renderSectionLocationKey(timeLocation) {
            if (!timeLocation.locations.length) {
                return '<li class="section-location-key-empty">No campus location is listed.</li>';
            }
            return timeLocation.locations.map(location => {
                const unavailable = location.building?.kind !== 'known';
                return `<li style="--location-color:${location.color};--location-foreground:${location.foreground}"><b>${location.number}</b><span>${this.escapeText(location.label)}</span>${unavailable ? '<em>Map location unavailable</em>' : ''}</li>`;
            }).join('');
        },

        renderSectionCalendar(section, details = null, timeLocation = null) {
            const view = timeLocation || this.sectionTimeLocationData(section, details);
            const { events, range, dayCount } = view;
            if (!events.length) {
                return '<div class="section-visual-empty">No scheduled meeting pattern is listed.</div>';
            }
            const dayNames = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].slice(0, dayCount);
            const dayLabels = dayNames.map((day, index) => `<strong style="grid-column:${index + 2};grid-row:1">${day}</strong>`).join('');
            const rowCount = Math.max(1, Math.ceil((range.end - range.start) / 5));
            const dayTracks = dayNames.map((day, index) => `<i class="section-calendar-track" aria-hidden="true" style="grid-column:${index + 2};grid-row:2 / span ${rowCount}"></i>`).join('');
            const halfHourLines = [];
            for (let minute = Math.ceil(range.start / 30) * 30; minute < range.end; minute += 30) {
                const hourClass = minute % 60 === 0 ? ' hour' : '';
                const row = 2 + Math.floor((minute - range.start) / 5);
                halfHourLines.push(`<i class="section-calendar-half-hour${hourClass}" aria-hidden="true" style="grid-column:2 / -1;grid-row:${row}"></i>`);
            }
            const timeLabels = [];
            const labelMinutes = [range.start];
            for (let minute = Math.ceil(range.start / 60) * 60; minute < range.end; minute += 60) {
                if (minute > range.start) labelMinutes.push(minute);
            }
            labelMinutes.forEach(minute => {
                const rowOffset = Math.floor((minute - range.start) / 5);
                const row = 2 + rowOffset;
                const span = Math.max(1, Math.min(6, rowCount - rowOffset));
                timeLabels.push(`<span class="section-calendar-time" style="grid-column:1;grid-row:${row} / span ${span}">${this.escapeText(this.formatSectionTime(minute))}</span>`);
            });
            const blocks = events.map(event => {
                const start = Math.max(range.start, event.start);
                const end = Math.min(range.end, event.end);
                if (end <= start || event.day < 0 || event.day >= dayCount) return '';
                const row = 2 + Math.floor((start - range.start) / 5);
                const span = Math.max(1, Math.ceil((end - start) / 5));
                const location = event.rawLocation ? ` · ${event.rawLocation}` : '';
                const title = `${dayNames[event.day]} ${this.formatSectionTime(event.start)}–${this.formatSectionTime(event.end)}${location}`;
                const locationAttribute = Number.isInteger(event.locationIndex)
                    ? ` data-location-index="${event.locationIndex}"`
                    : '';
                const locationNumber = event.locationNumber
                    ? `<b class="section-calendar-location-number" aria-hidden="true">${event.locationNumber}</b>`
                    : '';
                const focusable = event.locationNumber ? ' tabindex="0"' : '';
                return `<span${focusable} class="section-calendar-event"${locationAttribute} title="${this.escapeText(title)}" aria-label="${this.escapeText(title)}" style="--event-color:${event.color};--event-foreground:${event.foreground};grid-column:${event.day + 2};grid-row:${row} / span ${span}">${locationNumber}<span>${this.escapeText(this.formatSectionTime(event.start).replace(' ', ''))}</span></span>`;
            }).join('');
            const label = `Weekly meeting calendar from ${this.formatSectionTime(range.start)} to ${this.formatSectionTime(range.end)}`;
            return `<div class="section-mini-calendar-grid" role="group" aria-label="${this.escapeText(label)}" style="grid-template-columns:48px repeat(${dayCount}, minmax(0, 1fr));grid-template-rows:28px repeat(${rowCount}, minmax(2px, 1fr))">${dayLabels}${timeLabels.join('')}${dayTracks}${halfHourLines.join('')}${blocks}</div>`;
        },

        bindSectionTimeLocationInteractions(root) {
            root?.querySelectorAll?.('.section-calendar-event[data-location-index]').forEach(block => {
                const locationIndex = Number(block.dataset.locationIndex);
                block.addEventListener('mouseenter', () => this.setSectionLocationInteractionState(block, locationIndex, 'hover', true));
                block.addEventListener('mouseleave', () => this.setSectionLocationInteractionState(block, locationIndex, 'hover', false));
                block.addEventListener('focus', () => this.setSectionLocationInteractionState(block, locationIndex, 'focus', true));
                block.addEventListener('blur', () => this.setSectionLocationInteractionState(block, locationIndex, 'focus', false));
            });
        },

        setSectionLocationInteractionState(element, locationIndex, state, active) {
            if (!element) return;
            const property = state === 'focus' ? 'locationFocus' : 'locationHover';
            if (active) element.dataset[property] = 'true';
            else delete element.dataset[property];
            this.syncSectionLocationHighlight(locationIndex);
        },

        syncSectionLocationHighlight(locationIndex) {
            const root = document.getElementById('course-section-summary');
            const blocks = [...(root?.querySelectorAll?.(`.section-calendar-event[data-location-index="${locationIndex}"]`) || [])];
            const markerElement = this._detailLocationMarkers?.[locationIndex]?.getElement?.();
            const sources = markerElement ? [...blocks, markerElement] : blocks;
            const active = sources.some(element => (
                element.dataset.locationHover === 'true'
                || element.dataset.locationFocus === 'true'
            ));
            this.setSectionLocationHighlight(locationIndex, active);
        },

        setSectionLocationHighlight(locationIndex, active) {
            const root = document.getElementById('course-section-summary');
            root?.querySelectorAll?.(`.section-calendar-event[data-location-index="${locationIndex}"]`)
                .forEach(block => block.classList.toggle('is-location-highlighted', active));
            const marker = this._detailLocationMarkers?.[locationIndex];
            const markerElement = marker?.getElement?.();
            markerElement?.classList.toggle('is-location-highlighted', active);
            marker?.setZIndexOffset?.(active ? 1000 : 0);
        },

        detailTimeLocationExpanded() {
            try {
                if (typeof localStorage === 'undefined') return true;
                return localStorage.getItem(this._detailTimeLocationPreferenceKey) !== 'false';
            } catch (error) {
                return true;
            }
        },

        setDetailTimeLocationExpanded(expanded) {
            try {
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem(this._detailTimeLocationPreferenceKey, String(Boolean(expanded)));
                }
            } catch (error) {
                // A blocked preference store should not prevent the control from working.
            }
        },

        bindDetailTimeLocationPreference(root, { onExpand, onCollapse } = {}) {
            const disclosure = root?.querySelector?.('[data-time-location-toggle]');
            const content = root?.querySelector?.('[data-time-location-content]');
            const expanded = this.detailTimeLocationExpanded();
            if (!disclosure || !content) return expanded;
            const isDetails = String(disclosure.tagName || '').toUpperCase() === 'DETAILS';
            const control = isDetails ? disclosure.querySelector('summary') : disclosure;
            const reflect = value => {
                if (isDetails) disclosure.open = value;
                content.hidden = !value;
                control?.setAttribute('aria-expanded', String(value));
            };
            const changed = value => {
                content.hidden = !value;
                control?.setAttribute('aria-expanded', String(value));
                this.setDetailTimeLocationExpanded(value);
                if (value) onExpand?.();
                else onCollapse?.();
            };
            reflect(expanded);
            if (isDetails) {
                disclosure.addEventListener('toggle', () => changed(Boolean(disclosure.open)));
            } else {
                disclosure.addEventListener('click', () => {
                    const next = control?.getAttribute('aria-expanded') !== 'true';
                    reflect(next);
                    changed(next);
                });
            }
            return expanded;
        },

        detailTimeLocationVisible(container) {
            const content = container?.closest?.('[data-time-location-content]');
            if (!content) return true;
            if (content.hidden) return false;
            const details = content.closest?.('details[data-time-location-toggle]');
            return !details || details.open;
        },

        sectionRegistrationNotes(details = null) {
            if (!details) return '';
            const clean = value => this.stripHtml(value);
            const restrictions = deps.scheduler
                ? deps.scheduler.registrationRestrictionText(details.registration_restrictions)
                : clean(details.registration_restrictions);
            const rows = [
                ['Section corequisites', clean(details.section_coreqs)],
                ['Registration restrictions', restrictions],
                ['Class notes', clean(details.clssnotes)],
            ].filter(([, value]) => value && !/^none listed$/i.test(value));
            if (!rows.length) return '';
            return `<section class="course-section-registration"><div class="course-detail-card-heading"><h3>Registration notes for this section</h3></div><div>${rows.map(([label, value]) => {
                const attention = label === 'Class notes'
                    || label === 'Section corequisites'
                    || (label === 'Registration restrictions' && deps.scheduler && deps.scheduler.registrationRestrictionNeedsAttention(value));
                return `<p class="${attention ? 'attention' : ''}"><strong>${this.escapeText(label)}</strong><span>${this.escapeText(value)}</span></p>`;
            }).join('')}</div></section>`;
        },

        destroyDetailMap() {
            this._detailLocationMarkers = [];
            if (!this._detailMap) return;
            try { this._detailMap.remove(); } catch (error) { /* Map cleanup is best effort. */ }
            this._detailMap = null;
        },

        async renderSectionMap(section, details = null) {
            const container = document.getElementById('course-section-map');
            if (!container || !section || !deps.walkingMap) return;
            if (!this.detailTimeLocationVisible(container)) return;
            const request = this._sectionDetailToken;
            const crn = String(section.crn || '');
            if (!deps.walkingMap.buildings?.length && deps.walkingMap.loadBuildings) {
                await deps.walkingMap.loadBuildings();
                if (request !== this._sectionDetailToken
                    || crn !== this._detailSectionCrn
                    || !this.detailTimeLocationVisible(container)) return;
            }
            const timeLocation = this.sectionTimeLocationData(section, details);
            const timeLocationRoot = container.closest?.('.course-time-location');
            const calendarHost = timeLocationRoot?.querySelector?.('[data-section-calendar]');
            if (calendarHost) {
                calendarHost.innerHTML = this.renderSectionCalendar(section, details, timeLocation);
                const rangeLabel = timeLocationRoot.querySelector?.('[data-calendar-range]');
                if (rangeLabel) rangeLabel.textContent = timeLocation.rangeLabel;
                this.bindSectionTimeLocationInteractions(timeLocationRoot);
            }
            const locationKey = timeLocationRoot?.querySelector?.('[data-location-key]');
            if (locationKey) locationKey.innerHTML = this.renderSectionLocationKey(timeLocation);
            const locations = timeLocation.locations.filter(location => (
                location.building?.kind === 'known'
                && Number.isFinite(Number(location.building.lat))
                && Number.isFinite(Number(location.building.lon))
            ));
            this._detailLocationMarkers = [];
            if (!locations.length) {
                container.innerHTML = '<div class="section-visual-empty">No campus map location is available for this section.</div>';
                return;
            }
            try {
                await deps.walkingMap.loadLeaflet();
                if (request !== this._sectionDetailToken
                    || crn !== this._detailSectionCrn
                    || !container.isConnected
                    || !this.detailTimeLocationVisible(container)) return;
                this.destroyDetailMap();
                container.replaceChildren();
                this._detailMap = L.map(container, {
                    attributionControl: true,
                    dragging: true,
                    scrollWheelZoom: false,
                    zoomControl: true,
                });
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19,
                    attribution: '&copy; OpenStreetMap contributors',
                }).addTo(this._detailMap);
                const bounds = L.latLngBounds([]);
                locations.forEach(location => {
                    const { building } = location;
                    bounds.extend([building.lat, building.lon]);
                    const markerLabel = `Location ${location.number}: ${location.label || building.name}`;
                    const meetingLabels = [...new Set(timeLocation.events
                        .filter(event => event.locationIndex === location.index)
                        .map(event => {
                            const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][event.day] || '';
                            return `${day} ${this.formatSectionTime(event.start)}–${this.formatSectionTime(event.end)}`;
                        }))];
                    const marker = L.marker([building.lat, building.lon], {
                        alt: markerLabel,
                        title: markerLabel,
                        keyboard: true,
                        riseOnHover: true,
                        icon: L.divIcon({
                            className: '',
                            html: `<span class="course-section-map-pin" aria-hidden="true" style="--location-color:${location.color};--location-foreground:${location.foreground}">${location.number}</span>`,
                            iconSize: [30, 30],
                            iconAnchor: [15, 15],
                        }),
                    }).bindPopup(`<strong>${this.escapeText(markerLabel)}</strong>${meetingLabels.length ? `<span>${this.escapeText(meetingLabels.join(' · '))}</span>` : ''}`).addTo(this._detailMap);
                    this._detailLocationMarkers[location.index] = marker;
                    const markerElement = marker.getElement?.();
                    markerElement?.addEventListener('mouseenter', () => this.setSectionLocationInteractionState(markerElement, location.index, 'hover', true));
                    markerElement?.addEventListener('mouseleave', () => this.setSectionLocationInteractionState(markerElement, location.index, 'hover', false));
                    markerElement?.addEventListener('focus', () => this.setSectionLocationInteractionState(markerElement, location.index, 'focus', true));
                    markerElement?.addEventListener('blur', () => this.setSectionLocationInteractionState(markerElement, location.index, 'focus', false));
                });
                if (locations.length === 1) {
                    const building = locations[0].building;
                    this._detailMap.setView([building.lat, building.lon], 17);
                }
                else this._detailMap.fitBounds(bounds, { maxZoom: 17, padding: [32, 32] });
                setTimeout(() => this._detailMap?.invalidateSize(), 0);
            } catch (error) {
                if (container.isConnected) container.innerHTML = '<div class="section-visual-empty">The campus map could not load.</div>';
            }
        },

        renderSectionSummary(section, details = null, faculty = []) {
            const container = document.getElementById('course-section-summary');
            const group = this._detailGroup;
            if (!container || !group || !section) {
                if (container) container.innerHTML = '';
                return;
            }
            this.destroyDetailMap();
            const meeting = this.parseMeetingHtml(details?.meeting_html || '');
            const times = meeting.times.length ? meeting.times.join('; ') : (section.meets || 'TBA');
            const locations = meeting.locations.length ? meeting.locations.join('; ') : 'TBA';
            const seatsAvailable = String(details?.seats || '').match(/seats_avail[^>]*>(\d+)/)?.[1];
            const seatsMax = String(details?.seats || '').match(/seats_max[^>]*>(\d+)/)?.[1];
            const primaryFaculty = faculty.find(person => person.primary) || faculty[0];
            const instructorRawName = primaryFaculty?.name
                || ((section.instructor || section.instr) && (section.instructor || section.instr) !== 'Staff' ? (section.instructor || section.instr) : 'Instructor TBA');
            const instructorName = instructorRawName === 'Instructor TBA'
                ? instructorRawName
                : (deps.grades && deps.grades.displayProfessorName
                    ? deps.grades.displayProfessorName(instructorRawName)
                    : instructorRawName);
            const locked = String(deps.state.sectionLocks?.[group.code] || '') === String(section.crn);
            const sectionLabel = this.escapeText(section.section || '—');
            const actionLabel = locked
                ? 'LET SCHEDULER CHOOSE'
                : `ADD SECTION ${sectionLabel} TO SCHEDULE`;
            const actionTitle = locked
                ? 'Allow the scheduler to choose any eligible section'
                : `Use Section ${sectionLabel} in every generated schedule`;
            const seatKind = seatsAvailable !== undefined
                ? (Number(seatsAvailable) > 0 ? 'open' : 'full')
                : (section.stat === 'A' ? 'open' : 'full');
            const seatPrimary = seatsAvailable !== undefined
                ? (Number(seatsAvailable) > 0 ? `${seatsAvailable} seats available` : 'No seats available')
                : (section.stat === 'A' ? 'Seats available' : 'Section full');
            const seatSecondary = seatsMax ? `${seatsAvailable || 0} of ${seatsMax} seats` : (section.stat === 'A' ? 'Listed as open' : 'Listed as full');
            const fullNotice = seatKind === 'open' ? '' : '<p class="course-section-full-note">You can still use this full section for planning.</p>';
            const timeLocation = this.sectionTimeLocationData(section, details);
            container.innerHTML = `
                <div class="course-section-summary-heading">
                    <div><span>Viewing</span><strong>Section ${this.escapeText(section.section || '—')}</strong></div>
                    <div class="course-section-seat-count ${seatKind}"><strong>${this.escapeText(seatPrimary)}</strong><span>${this.escapeText(seatSecondary)}</span></div>
                </div>
                <div class="course-section-facts">
                    <div><span>Instructor</span>${instructorName === 'Instructor TBA'
                        ? `<strong>${instructorName}</strong>`
                        : `<button type="button" id="btn-section-professor" title="Open this instructor's profile">${this.escapeText(instructorName)}</button>${primaryFaculty?.email ? `<a href="mailto:${this.escapeText(primaryFaculty.email)}">${this.escapeText(primaryFaculty.email)}</a>` : ''}`}</div>
                    <div><span>Meeting</span><strong>${this.escapeText(times)}</strong></div>
                    <div><span>Location</span><strong>${this.escapeText(locations)}</strong></div>
                    <div><span>CRN</span><strong>${this.escapeText(section.crn)}</strong></div>
                    <div><span>Method</span><strong>${this.escapeText((details?.instructionalMethod || details?.inst_mthd) || (section.instructionalMethod || section.inst_mthd) || 'Not listed')}</strong></div>
                    <div><span>Course dates</span><strong>${this.escapeText(section.start_date && section.end_date ? `${section.start_date}–${section.end_date}` : 'Full-term dates')}</strong></div>
                </div>
                ${fullNotice}
                <div class="course-section-actions">
                    <button id="btn-use-detail-section" type="button" class="${locked ? 'btn-secondary' : 'btn-garnet'}" title="${actionTitle}">${actionLabel}</button>
                </div>
                ${this.sectionRegistrationNotes(details)}
                <details class="course-time-location" data-time-location-toggle open>
                    <summary id="course-time-location-toggle" class="course-time-location-toggle" aria-expanded="true" aria-controls="course-time-location-content">
                        <span><strong>Time &amp; location</strong><small>Weekly meeting pattern and campus map</small></span>
                        <i aria-hidden="true"></i>
                    </summary>
                    <div id="course-time-location-content" class="course-time-location-content" data-time-location-content>
                        <div class="course-section-visuals">
                            <section class="course-section-visual-card"><div class="course-section-visual-heading"><strong>Weekly meeting pattern</strong><span data-calendar-range>${this.escapeText(timeLocation.rangeLabel)}</span></div><div data-section-calendar>${this.renderSectionCalendar(section, details, timeLocation)}</div></section>
                            <section class="course-section-visual-card"><div class="course-section-visual-heading"><strong>Campus locations</strong><span>${this.escapeText(locations)}</span></div><div id="course-section-map" class="course-section-map" role="region" aria-label="All listed section campus locations"></div><ol class="course-section-location-key" data-location-key aria-label="Meeting location key">${this.renderSectionLocationKey(timeLocation)}</ol></section>
                        </div>
                    </div>
                </details>
            `;
            this.bindSectionTimeLocationInteractions(container);
            const initialTimeLocationExpanded = this.bindDetailTimeLocationPreference(container, {
                onExpand: () => requestAnimationFrame(() => this.renderSectionMap(section, details)),
                onCollapse: () => this.destroyDetailMap(),
            });
            if (initialTimeLocationExpanded) requestAnimationFrame(() => this.renderSectionMap(section, details));
            container.querySelector('#btn-use-detail-section')?.addEventListener('click', async () => {
                if (!deps.state.isCourseSelected(group.code)) await deps.scheduler.addCourseGroup(this._detailGroup);
                deps.state.setSectionLock(group.code, locked ? null : section.crn);
                this.updateCourseSelectionStyles(group.code);
                this.renderCourseDetailHeader(this._detailDetails);
                this.renderSectionSummary(section, details, faculty);
            });
            container.querySelector('#btn-section-professor')?.addEventListener('click', () => {
                if (!deps.grades) return;
                deps.grades.showProfessorForCourseName(
                    group.code,
                    instructorName,
                    primaryFaculty?.email || '',
                    primaryFaculty?.professor_id || '',
                );
            });
        },

        parseBookstoreOrder(html) {
            if (!html) return null;
            try {
                const documentNode = new DOMParser().parseFromString(html, 'text/html');
                const sourceForm = documentNode.querySelector('form');
                if (!sourceForm) return null;
                const action = new URL(sourceForm.getAttribute('action') || '', window.location.href);
                if (action.protocol !== 'https:'
                    || action.hostname !== 'sc.bncollege.com'
                    || action.port) return null;
                const allowed = ['catalogId', 'storeId', 'termMapping', 'courseXml'];
                const fields = {};
                allowed.forEach(name => {
                    const input = sourceForm.querySelector(`input[name="${name}"]`);
                    if (input?.value) fields[name] = input.value;
                });
                if (!fields.courseXml) return null;
                return { action: action.href, fields };
            } catch (error) {
                return null;
            }
        },

        submitBookstoreOrder(order) {
            if (!order?.action || !order.fields) return;
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = order.action;
            form.target = '_blank';
            form.rel = 'noopener noreferrer';
            Object.entries(order.fields).forEach(([name, value]) => {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = name;
                input.value = value;
                form.appendChild(input);
            });
            document.body.appendChild(form);
            form.submit();
            form.remove();
        },

        bulletinResourceUrl(courseCode) {
            const url = new URL('https://academicbulletins.sc.edu/search/');
            url.searchParams.set('P', String(courseCode || '').trim());
            return url.href;
        },

        syllabusResourceUrl(courseCode) {
            const match = String(courseCode || '').trim().match(/^([A-Z]{2,4})\s*(\d{3}[A-Z]?)/i);
            if (!match) return 'https://www.sc.edu/syllabusarchive/';
            const url = new URL('https://www.sc.edu/syllabusarchive/studentcourselist.php');
            url.searchParams.set('designator', match[1].toUpperCase());
            url.searchParams.set('courseNumber', match[2].toUpperCase());
            url.searchParams.set('instructor', '');
            url.searchParams.set('term', 'all');
            return url.href;
        },

        syllabusSignInUrl() {
            return 'https://www.sc.edu/syllabusarchive';
        },

        professorSearchName(value) {
            const raw = String(value || '').trim();
            const comma = raw.indexOf(',');
            if (comma < 0) return raw.replace(/\s+/g, ' ');
            const last = raw.slice(0, comma).trim();
            const first = raw.slice(comma + 1).trim();
            return `${first} ${last}`.replace(/\s+/g, ' ').trim();
        },

        rateMyProfessorsUrl(professorName) {
            const query = encodeURIComponent(this.professorSearchName(professorName)).replace(/%20/g, '+');
            return `https://www.ratemyprofessors.com/search/professors/1309?q=${query}`;
        },

        renderCourseResources(section = this.currentDetailSection(), faculty = this._detailFaculty || []) {
            const container = document.getElementById('course-resource-links');
            const group = this._detailGroup;
            if (!container || !group) return;
            const primaryFaculty = faculty.find(person => person.primary) || faculty[0];
            const professorRaw = primaryFaculty?.name || ((section?.instructor || section?.instr) && (section.instructor || section.instr) !== 'Staff' ? (section.instructor || section.instr) : '');
            const professor = this.professorSearchName(professorRaw);
            const query = encodeURIComponent(`${group.code} ${group.title || ''} University of South Carolina course review`);
            const professorReviewsUrl = this.rateMyProfessorsUrl(professorRaw);
            const sectionDetails = this._detailSectionData?.[String(section?.crn || '')]?.details || null;
            const bookstoreOrder = this.parseBookstoreOrder(sectionDetails?.bn_order_books_html);
            const hasSelectedSection = Boolean(section?.crn);
            const classDetailsUrl = section?.crn
                ? `https://classes.sc.edu/?details&srcdb=${encodeURIComponent(this._detailTerm || deps.state.term)}&crn=${encodeURIComponent(section.crn)}`
                : `https://classes.sc.edu/?details&srcdb=${encodeURIComponent(this._detailTerm || deps.state.term)}&code=${encodeURIComponent(group.code)}`;
            const bulletinUrl = this.bulletinResourceUrl(group.code);
            const syllabusUrl = this.syllabusResourceUrl(group.code);
            const syllabusSignInUrl = this.syllabusSignInUrl();
            const bookstoreCard = bookstoreOrder
                ? '<button id="btn-resource-bookstore" type="button" class="course-resource-link" title="Open official materials for the selected section in a new tab"><span><strong>Bookstore materials</strong><small>Required and recommended materials for this section</small></span><b aria-hidden="true">↗</b></button>'
                : hasSelectedSection
                    ? `<a class="course-resource-link" href="${classDetailsUrl}" target="_blank" rel="noopener noreferrer" title="Open official class details and use Order Books"><span><strong>Bookstore materials</strong><small>Open class details, then choose Order Books</small></span><b aria-hidden="true">↗</b></a>`
                    : `<a class="course-resource-link" href="${classDetailsUrl}" target="_blank" rel="noopener noreferrer" title="Find a current section before opening its books"><span><strong>Bookstore materials</strong><small>Choose a current section, then use Order Books</small></span><b aria-hidden="true">↗</b></a>`;
            container.innerHTML = `
                <div class="course-resource-layout">
                <section class="course-resource-section official">
                    <header><div><span>Official university</span><h2>Course resources</h2></div><small>${hasSelectedSection ? `Section ${this.escapeText(section.section || '—')}` : 'Course-wide'}</small></header>
                    <div class="course-resource-list">
                        <a class="course-resource-link" href="${classDetailsUrl}" target="_blank" rel="noopener noreferrer" title="Open the official class-search record for this section"><span><strong>Class details</strong><small>Meeting, registration, deadlines, and final-exam information</small></span><b aria-hidden="true">↗</b></a>
                        ${bookstoreCard}
                        <a class="course-resource-link" href="${bulletinUrl}" target="_blank" rel="noopener noreferrer" title="Open exact Academic Bulletin results for ${this.escapeText(group.code)}"><span><strong>Academic Bulletin</strong><small>Official catalog entry for ${this.escapeText(group.code)}</small></span><b aria-hidden="true">↗</b></a>
                        <div class="course-resource-syllabus" role="group" aria-labelledby="course-resource-syllabus-title">
                            <div class="course-resource-syllabus-heading"><span><strong id="course-resource-syllabus-title">Syllabus archive</strong><small>Sign in first, then open the course archive.</small></span></div>
                            <ol class="course-resource-syllabus-steps">
                                <li><a href="${syllabusSignInUrl}" target="_blank" rel="noopener noreferrer" title="Open the syllabus archive sign-in page"><b aria-hidden="true">1</b><span><strong>Sign in to the archive</strong><small>Complete your student login in the new tab.</small></span><i aria-hidden="true">↗</i></a></li>
                                <li><a href="${syllabusUrl}" target="_blank" rel="noopener noreferrer" title="Open archived syllabi for ${this.escapeText(group.code)} after signing in"><b aria-hidden="true">2</b><span><strong>View ${this.escapeText(group.code)} syllabi</strong><small>Return here after signing in and open the course list.</small></span><i aria-hidden="true">↗</i></a></li>
                            </ol>
                            <p>If the course page says you were logged out, finish step 1 and try step 2 again.</p>
                        </div>
                        ${professor ? `<a class="course-resource-link" href="https://sc.edu/about/directory/" target="_blank" rel="noopener noreferrer" title="Open the official faculty and staff directory"><span><strong>Faculty directory</strong><small>Find ${this.escapeText(professor)} in the university directory</small></span><b aria-hidden="true">↗</b></a>` : ''}
                    </div>
                </section>
                <section class="course-resource-section external">
                    <header><div><span>Independent sites</span><h2>Reviews</h2></div></header>
                    <div class="course-resource-list">
                        <a class="course-resource-link" href="https://www.google.com/search?q=${query}" target="_blank" rel="noopener noreferrer" title="Search the web for independent course feedback"><span><strong>Course reviews</strong><small>Search the web for feedback about ${this.escapeText(group.code)}</small></span><b aria-hidden="true">↗</b></a>
                        ${professor ? `<a class="course-resource-link" href="${professorReviewsUrl}" target="_blank" rel="noopener noreferrer" title="Search Rate My Professors for ${this.escapeText(professor)}"><span><strong>Professor reviews</strong><small>Search Rate My Professors for ${this.escapeText(professor)}</small></span><b aria-hidden="true">↗</b></a>` : ''}
                    </div>
                </section>
                </div>
            `;
            container.querySelector('#btn-resource-bookstore')?.addEventListener('click', () => this.submitBookstoreOrder(bookstoreOrder));
        },

        escapeText(value) {
            const element = document.createElement('span');
            element.textContent = String(value ?? '');
            return element.innerHTML;
        },

        };
    }

    return { createDetailPart };
}));

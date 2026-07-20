/*
 * Registration readiness, seat details, and the registration dialog.
 *
 * One part of the scheduler feature, which was a single module of over two
 * thousand lines. Each part is a factory returning plain methods; index.js
 * merges them onto one object, so `this` still reaches every method and no
 * call site changed.
 *
 * Cut at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly.
 */
(function initRegistrationPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SchedulerParts) root.SchedulerParts = {};
    root.SchedulerParts.createRegistrationPart = api.createRegistrationPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createRegistrationPart(deps) {
        return {
        init() {
            document.getElementById('btn-solve').addEventListener('click', () => this.solve());
            document.getElementById('btn-schedule-preferences').addEventListener('click', () => this.openSchedulePreferences());
            document.getElementById('btn-registration-info').addEventListener('click', () => this.openRegistrationInfo());
            document.getElementById('btn-search-schedule-courses').addEventListener('click', () => this.searchFromInput());
            document.getElementById('schedule-course-input').addEventListener('keydown', event => {
                if (event.key === 'Enter') this.searchFromInput();
            });
            deps.state.on('courses-changed', () => {
                this.clearResults();
                this.renderCourseSearchResults();
                this.scheduleLocationPrefetch();
            });
            deps.state.on('section-locks-changed', () => this.clearResults());
            deps.state.on('sections-changed', () => {
                this.refreshAppliedResultState();
                this.updateRegistrationButton();
            });
            deps.state.on('preferences-changed', () => this.clearResults());
            this.renderCourseSearchResults();
            this.initCourseDivider();
            this.initScheduleSidebarResize();
            this.initScheduleSidebarCollapse();
            this.initVerticalResizer();
            this.initScheduleScrollPreview();
            this.updateRegistrationButton();
            this.scheduleLocationPrefetch();
            document.getElementById('term-select')?.addEventListener('change', () => {
                Promise.resolve().then(() => {
                    this.scheduleLocationPrefetch();
                    if (deps.walkingMap) deps.walkingMap.refresh();
                });
            });
        },

        scheduleLocationPrefetch() {
            const generation = ++this._locationPrefetchGeneration;
            if (this._locationPrefetchTimer) clearTimeout(this._locationPrefetchTimer);
            this._locationPrefetchController?.abort();
            this._locationPrefetchController = null;
            const sections = this.locationPrefetchSections();
            if (sections.length === 0 || (typeof navigator !== 'undefined' && navigator.connection?.saveData)) return;
            const controller = new AbortController();
            this._locationPrefetchController = controller;
            const run = async () => {
                this._locationPrefetchTimer = null;
                if (generation !== this._locationPrefetchGeneration || controller.signal.aborted) return;
                try {
                    if (deps.walkingMap) {
                        await deps.walkingMap.hydrateSectionDetails(sections, {
                            background: true,
                            concurrency: 1,
                            delayMs: 400,
                            maxConsecutiveFailures: 2,
                            signal: controller.signal,
                        });
                    }
                } catch (error) {
                    // Background prefetch is optional. Generate retries unfinished details in the foreground.
                }
            };
            this._locationPrefetchTimer = setTimeout(run, 75);
        },

        hasScheduledCampusMeeting(section) {
            if (!section || !section.meetingTimes) return false;
            const method = [
                (section.instructionalMethod || section.inst_mthd),
                section.meets,
                section.instructionalMethod,
                section.instructional_method,
            ].filter(Boolean).join(' ').toLowerCase();
            if (/online|web|remote|asynchronous|does not meet|distance/.test(method)) return false;
            try {
                const meetings = typeof section.meetingTimes === 'string'
                    ? JSON.parse(section.meetingTimes)
                    : section.meetingTimes;
                return Array.isArray(meetings) && meetings.some(meeting => (
                    Number.isFinite(Number(meeting?.meet_day))
                    && Number.isFinite(Number(meeting?.start_time))
                    && Number.isFinite(Number(meeting?.end_time))
                ));
            } catch (error) {
                return false;
            }
        },

        locationPrefetchSections() {
            return Object.entries(deps.state.selectedCourses || {}).flatMap(([code, course]) => {
                const lockedCrn = String(deps.state.sectionLocks?.[code] || '');
                return (course.sections || []).filter(section => {
                    const locked = lockedCrn && String(section?.crn || '') === lockedCrn;
                    return section?.crn
                        && (lockedCrn ? locked : this.isOpenSection(section))
                        && this.hasScheduledCampusMeeting(section);
                });
            });
        },

        registrationSections() {
            return Object.entries(deps.state.selectedSections || {})
                .map(([code, section]) => ({ code, ...section, crn: String(section.crn || '').trim() }))
                .filter(section => section.crn);
        },

        updateRegistrationButton() {
            const button = document.getElementById('btn-registration-info');
            if (!button) return;
            button.disabled = this.registrationSections().length === 0;
        },

        async copyRegistrationCrn(section, button, status) {
            const text = section.crn;
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    const input = document.createElement('textarea');
                    input.value = text;
                    input.setAttribute('readonly', '');
                    input.style.position = 'fixed';
                    input.style.opacity = '0';
                    document.body.appendChild(input);
                    input.select();
                    document.execCommand('copy');
                    input.remove();
                }
                button.textContent = 'COPIED';
                status.textContent = `${section.code} CRN ${section.crn} copied to your clipboard.`;
            } catch (error) {
                button.textContent = 'COPY CRN';
                status.textContent = `Copying was blocked. Select CRN ${section.crn} and copy it manually.`;
            }
        },

        registrationSeatDetails(details, section) {
            const maximum = String(details.seats || '').match(/seats_max[^>]*>(\d+)/);
            const available = String(details.seats || '').match(/seats_avail[^>]*>(\d+)/);
            if (maximum && available) {
                const open = Number(available[1]);
                return {
                    text: open > 0 ? `${open} of ${maximum[1]} seats available` : `All ${maximum[1]} seats are full`,
                    kind: open > 0 ? 'open' : 'full',
                };
            }
            return {
                text: this.isOpenSection(section) ? 'Listed as open' : 'Listed as full',
                kind: this.isOpenSection(section) ? 'open' : 'full',
            };
        },

        registrationRequirementSatisfied(value, eligibleCourses) {
            const normalizeCode = code => String(code).toUpperCase()
                .replace(/\s+/g, '')
                .replace(/^([A-Z]{2,4})(\d)/, '$1 $2');
            const text = this.stripHtml(value || '').toUpperCase();
            if (deps.prereqs
                && deps.prereqs.parsePrereqGroups
                && deps.prereqs.evaluateGroups) {
                const groups = deps.prereqs.parsePrereqGroups(text);
                if (groups.length) return deps.prereqs.evaluateGroups(groups, eligibleCourses).satisfied;
            }
            const rawCodes = text.match(/\b[A-Z]{2,4}\s*\d{3}[A-Z]?\b/g) || [];
            if (rawCodes.length === 0) return false;
            const normalized = rawCodes.map(normalizeCode);
            const groups = text.split(/;|\bAND\b/).map(group => {
                const groupCodes = normalized.filter((code, index) => group.includes(rawCodes[index]));
                return groupCodes.length > 0 ? groupCodes : null;
            }).filter(Boolean);
            if (groups.length > 1) {
                return groups.every(group => group.some(code => eligibleCourses.has(code)));
            }
            return /\bOR\b/.test(text)
                ? normalized.some(code => eligibleCourses.has(code))
                : normalized.every(code => eligibleCourses.has(code));
        },

        registrationRestrictionNeedsAttention(value) {
            const restriction = this.stripHtml(value || '').toLowerCase();
            if (!restriction) return false;
            const major = String(deps.state.profile?.majorData?.major || '').trim().toLowerCase();
            if (!major) return true;
            return !restriction.includes(major);
        },

        registrationRestrictionText(value) {
            return this.stripHtml(value || '')
                .replace(/([.!?])(?=[A-Z])/g, '$1 ')
                .split(/(?<=[.!?])\s+/)
                .filter(sentence => !/columbia campus/i.test(sentence)
                    || /major|concentration|program|college|school|student level/i.test(sentence))
                .join(' ')
                .trim();
        },

        registrationRequirementRows(details, bulletin) {
            const combined = values => [...new Set(values
                .map(value => this.stripHtml(value || ''))
                .filter(Boolean))].join(' · ');
            const normalizeCode = code => String(code).toUpperCase()
                .replace(/\s+/g, '')
                .replace(/^([A-Z]{2,4})(\d)/, '$1 $2');
            const completed = new Set((deps.state.completedCourses || []).map(normalizeCode));
            const completedOrSelected = new Set([
                ...completed,
                ...Object.keys(deps.state.selectedCourses || {}).map(normalizeCode),
            ]);
            const rows = [
                { label: 'Prerequisites', value: combined([bulletin.prereq]), type: 'prerequisite' },
                { label: 'Prerequisite or corequisite', value: combined([bulletin.prerequisite_or_corequisite]), type: 'prerequisite' },
                { label: 'Corequisites or linked sections', value: combined([
                    bulletin.corequisite,
                    details.course_coreqs,
                    details.section_coreqs,
                ]), type: 'corequisite' },
                { label: 'Registration restrictions', value: this.registrationRestrictionText(details.registration_restrictions), type: 'restriction' },
                { label: 'Class notes', value: combined([details.clssnotes]), type: 'note' },
            ];
            const attentionLabels = [];
            const html = rows.map(({ label, value, type }) => {
                if (!value) return '';
                const attention = Boolean(value) && (
                    (type === 'prerequisite' && !this.registrationRequirementSatisfied(value, completed))
                    || (type === 'corequisite' && !this.registrationRequirementSatisfied(value, completedOrSelected))
                    || (type === 'restriction' && this.registrationRestrictionNeedsAttention(value))
                    || type === 'note'
                );
                if (attention) attentionLabels.push(label);
                const shortened = value.length > 240 ? `${value.slice(0, 237)}…` : value;
                return `<p class="${attention ? 'attention' : ''}"><strong>${label}</strong><span>${this.escapeHtml(shortened)}</span></p>`;
            }).filter(Boolean).join('');
            return { html, attentionLabels };
        },

        async hydrateRegistrationCourse(section) {
            const card = document.getElementById(`registration-course-${section.crn}`);
            if (!card || !deps.api.getDetails) return;
            try {
                const [details, bulletin] = await Promise.all([
                    deps.api.getDetails(section.crn, deps.state.term),
                    deps.search && deps.search.fetchBulletinDetailsForCourse
                        ? deps.search.fetchBulletinDetailsForCourse(section.code)
                        : Promise.resolve({}),
                ]);
                if (!document.body.contains(card)) return;
                const seats = this.registrationSeatDetails(details, section);
                const credits = this.parseCreditHours(details.hours_html || bulletin.hours_html || section.hours);
                const requirements = this.registrationRequirementRows(details, bulletin || {});
                card.querySelector('[data-registration-seats]').textContent = seats.text;
                card.querySelector('[data-registration-seats]').className = `registration-value registration-seats ${seats.kind}`;
                card.querySelector('[data-registration-seat-row]').classList.toggle('attention', seats.kind === 'full');
                card.querySelector('[data-registration-credits]').textContent = credits === null ? 'Credits unavailable' : `${credits} credit${credits === 1 ? '' : 's'}`;
                card.querySelector('[data-registration-dates]').textContent = section.start_date && section.end_date
                    ? `${section.start_date} through ${section.end_date}`
                    : 'Course dates unavailable';
                const requirementList = card.querySelector('[data-registration-requirements]');
                requirementList.innerHTML = requirements.html;
                requirementList.closest('.registration-requirements').hidden = !requirements.html;
                const attention = seats.kind === 'full'
                    ? ['Full section', ...requirements.attentionLabels]
                    : requirements.attentionLabels;
                const indicator = card.querySelector('[data-registration-indicator]');
                const hasAttention = attention.length > 0;
                indicator.classList.toggle('registration-warning-icon', hasAttention);
                indicator.classList.toggle('registration-success-icon', !hasAttention);
                indicator.textContent = hasAttention ? '!' : '✓';
                indicator.hidden = false;
                indicator.title = hasAttention ? attention.join(' · ') : 'No registration warnings found';
                indicator.setAttribute('aria-label', hasAttention
                    ? `Registration warning. ${attention.join('. ')}`
                    : 'No registration warnings found');
                card.classList.toggle('has-registration-warning', attention.length > 0);
            } catch (error) {
                if (!document.body.contains(card)) return;
                card.querySelector('[data-registration-seats]').textContent = this.isOpenSection(section) ? 'Listed as open' : 'Listed as full';
            }
        },

        openRegistrationInfo() {
            const sections = this.registrationSections();
            if (sections.length === 0) return;

            const overlay = document.getElementById('modal-overlay');
            const modal = document.getElementById('modal');
            const content = document.getElementById('modal-content');
            if (!overlay || !modal || !content) return;
            modal.classList.remove('course-quick-modal', 'schedule-preferences-modal');
            modal.classList.add('registration-info-modal');

            const rows = sections.map(section => {
                const open = this.isOpenSection(section);
                const credits = this.parseCreditHours(section.hours);
                return `
                <article id="registration-course-${this.escapeHtml(section.crn)}" class="registration-course-card">
                    <header class="registration-course-header">
                        <div class="registration-course-copy">
                            <strong>${this.escapeHtml(section.code)}</strong>
                            <span>${this.escapeHtml(section.title || 'Course title unavailable')}</span>
                        </div>
                        <button class="registration-copy-crn btn-green" type="button" data-registration-copy="${this.escapeHtml(section.crn)}">COPY CRN</button>
                        <button class="registration-expand" type="button" data-registration-expand="${this.escapeHtml(section.crn)}" aria-expanded="false" aria-controls="registration-details-${this.escapeHtml(section.crn)}" aria-label="Show registration details for ${this.escapeHtml(section.code)}">
                            <span class="registration-status-icon ${open ? 'registration-success-icon' : 'registration-warning-icon'}" data-registration-indicator${open ? ' hidden' : ''} title="${open ? '' : 'Full section'}" aria-label="${open ? '' : 'Registration warning. Full section'}">${open ? '✓' : '!'}</span>
                            <span class="registration-chevron" aria-hidden="true">▼</span>
                        </button>
                    </header>
                    <div id="registration-details-${this.escapeHtml(section.crn)}" class="registration-course-details" data-registration-details hidden>
                        <div class="registration-identifiers">
                            <span>Section <strong>${this.escapeHtml(section.section || '—')}</strong></span>
                            <span>CRN <strong>${this.escapeHtml(section.crn)}</strong></span>
                            <span data-registration-credits>${credits === null ? 'Checking credits' : `${credits} credit${credits === 1 ? '' : 's'}`}</span>
                        </div>
                        <div class="registration-detail-grid">
                            <div data-registration-seat-row${open ? '' : ' class="attention"'}>
                                <span class="registration-label">LIVE SEAT STATUS</span>
                                <span class="registration-value registration-seats ${open ? 'open' : 'full'}" data-registration-seats>${open ? 'Checking available seats' : 'Listed as full — planning only'}</span>
                            </div>
                            <div class="registration-detail-wide">
                                <span class="registration-label">COURSE DATES</span>
                                <span class="registration-value" data-registration-dates>${section.start_date && section.end_date ? `${this.escapeHtml(section.start_date)} through ${this.escapeHtml(section.end_date)}` : 'Checking dates'}</span>
                            </div>
                        </div>
                        <section class="registration-requirements">
                            <h3>Registration checks</h3>
                            <div data-registration-requirements>
                                <p><strong>Requirements</strong><span>Checking prerequisites, corequisites, and restrictions</span></p>
                            </div>
                        </section>
                    </div>
                </article>
            `;
            }).join('');

            content.innerHTML = `
                <section class="registration-dialog" aria-labelledby="registration-dialog-title">
                    <header class="registration-dialog-header">
                        <h2 id="registration-dialog-title">Registration Info</h2>
                    </header>
                    <div class="registration-instructions">
                        Review highlighted items, then copy each CRN into OneCarolina.
                    </div>
                    <div class="registration-course-list">${rows}</div>
                    <p id="registration-copy-status" class="registration-copy-status" aria-live="polite"></p>
                    <div class="registration-dialog-actions">
                        <a class="registration-onecarolina-link" href="https://banner.onecarolina.sc.edu/StudentRegistrationSsb/ssb/classRegistration/classRegistration#" target="_blank" rel="noopener noreferrer">OPEN CRN SHOPPING CART</a>
                    </div>
                </section>
            `;
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'registration-dialog-title');
            if (window.AppModal) {
                AppModal.open(content.innerHTML, { className: 'registration-info-modal', label: 'Registration information' });
            } else {
                overlay.classList.remove('hidden');
            }

            const copyStatus = document.getElementById('registration-copy-status');
            content.querySelectorAll('[data-registration-copy]').forEach(button => {
                button.addEventListener('click', () => {
                    const section = sections.find(item => item.crn === button.dataset.registrationCopy);
                    if (section) this.copyRegistrationCrn(section, button, copyStatus);
                });
            });
            content.querySelectorAll('[data-registration-expand]').forEach(button => {
                button.addEventListener('click', () => {
                    const details = document.getElementById(`registration-details-${button.dataset.registrationExpand}`);
                    if (!details) return;
                    const expanded = button.getAttribute('aria-expanded') === 'true';
                    content.querySelectorAll('[data-registration-expand][aria-expanded="true"]').forEach(otherButton => {
                        if (otherButton === button) return;
                        const otherDetails = document.getElementById(`registration-details-${otherButton.dataset.registrationExpand}`);
                        otherButton.setAttribute('aria-expanded', 'false');
                        otherButton.setAttribute('aria-label', `Show registration details for ${otherButton.closest('.registration-course-card').querySelector('.registration-course-copy strong').textContent}`);
                        if (otherDetails) otherDetails.hidden = true;
                        otherButton.closest('.registration-course-card').classList.remove('expanded');
                    });
                    button.setAttribute('aria-expanded', String(!expanded));
                    button.setAttribute('aria-label', `${expanded ? 'Show' : 'Hide'} registration details for ${button.closest('.registration-course-card').querySelector('.registration-course-copy strong').textContent}`);
                    details.hidden = expanded;
                    button.closest('.registration-course-card').classList.toggle('expanded', !expanded);
                });
            });
            content.querySelector('[data-registration-copy]')?.focus();
            sections.forEach(section => this.hydrateRegistrationCourse(section));
        },

        };
    }

    return { createRegistrationPart };
}));

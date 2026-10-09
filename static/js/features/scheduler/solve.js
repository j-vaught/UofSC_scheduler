/*
 * Running the solver and rendering, previewing and applying schedules.
 *
 * One part of the scheduler feature, which was a single module of over two
 * thousand lines. Each part is a factory returning plain methods; index.js
 * merges them onto one object, so `this` still reaches every method and no
 * call site changed.
 *
 * Cut at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly.
 */
(function initSolvePart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SchedulerParts) root.SchedulerParts = {};
    root.SchedulerParts.createSolvePart = api.createSolvePart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createSolvePart(deps) {
        return {
        isSchedulableSection(section) {
            if (section.meetingTimes) return true;
            const description = [
                section.meets,
                (section.instructionalMethod || section.inst_mthd),
                section.instructionalMethod,
                section.instructional_method,
            ].filter(Boolean).join(' ').toLowerCase();
            return ['asynchronous', 'does not meet', 'online', 'distance', 'web', 'dweb', 'b3web']
                .some(marker => description.includes(marker));
        },

        isOpenSection(section) {
            return !section.stat || section.stat === 'A';
        },

        async addWalkingLocations(courses) {
            if (!deps.walkingMap) return;

            const sections = courses.flatMap(course => course.sections || []);
            await deps.walkingMap.hydrateSectionDetails(sections, { concurrency: 4, foreground: true });
            sections.forEach(section => {
                const details = deps.walkingMap.sectionDetails.get(deps.walkingMap.sectionDetailKey(section)) || [];
                section._walking_locations = deps.walkingMap.parseMeetingTimes(section.meetingTimes)
                    .map(meeting => {
                        const detail = details.find(item => item.days.includes(meeting.day)
                            && item.start !== null && Math.abs(item.start - meeting.start) <= 5)
                            || details.find(item => item.days.includes(meeting.day));
                        if (!detail || detail.building?.kind !== 'known') return null;
                        return {
                            day: meeting.day,
                            start: meeting.start,
                            latitude: Number(detail.building.lat),
                            longitude: Number(detail.building.lon),
                        };
                    })
                    .filter(Boolean);
            });
        },

        async solveLegacy(maxResults = 10) {
            const courseGroups = Object.values(deps.state.selectedCourses || {});
            if (courseGroups.length === 0) {
                // Rendered in place rather than through alert(). A modal dialog for an
                // empty state stops the page, has to be dismissed before anything else
                // can happen, and says nothing the panel cannot say in place.
                const container = document.getElementById('solver-container');
                if (container) {
                    container.innerHTML = '<p class="hint">Add at least one course from the '
                        + 'sidebar, then generate schedules.</p>';
                }
                Accessibility.announce('Add at least one course before generating schedules.', 'schedule');
                return;
            }

            if (deps.tabs) deps.tabs.switchTo('schedule');

            const container = document.getElementById('solver-container');
            container.innerHTML = '<p class="loading">Generating schedule options</p>';
            container.setAttribute('aria-busy', 'true');
            Accessibility.announce('Generating schedule options.', 'schedule');

            const courses = courseGroups.map(group => {
                const lockedCrn = deps.state.sectionLocks?.[group.code];
                return {
                    code: group.code,
                    sections: (group.sections || []).filter(section => {
                        const locked = lockedCrn && String(section.crn) === String(lockedCrn);
                        return this.isSchedulableSection(section)
                            && (lockedCrn ? locked : this.isOpenSection(section));
                    }),
                };
            });

            const unschedulable = courses.filter(course => course.sections.length === 0);
            if (unschedulable.length > 0) {
                const codes = unschedulable.map(course => course.code).join(', ');
                const locked = unschedulable.filter(course => deps.state.sectionLocks?.[course.code]).map(course => course.code);
                container.innerHTML = locked.length > 0
                    ? `<p class="solver-error">The locked section for ${locked.join(', ')} is not available for scheduling. Choose another section or allow all open sections.</p>`
                    : `<p class="hint">No open scheduled or asynchronous sections were found for ${codes} in this term.</p>`;
                container.setAttribute('aria-busy', 'false');
                Accessibility.announce(container.textContent, 'schedule');
                return;
            }

            const preferences = deps.state.getPreferences();
            const configuredMax = deps.state.profile?.customCredits?.max;
            preferences.max_credits = Number.isFinite(Number(configuredMax)) ? Number(configuredMax) : 18;

            try {
                this._locationPrefetchController?.abort();
                await this.addWalkingLocations(courses);
                const resultLimit = Math.max(10, Number(maxResults) || 10);
                const result = await deps.api.solve(courses, preferences, resultLimit);
                deps.state.solverResults = result.schedules || [];
                this.renderResults(result, container);
            } catch (error) {
                container.innerHTML = `<p class="hint">Solver error: ${error.message}</p>`;
                Accessibility.announce(`Schedule generation failed. ${error.message}`, 'schedule');
            } finally {
                container.setAttribute('aria-busy', 'false');
            }
        },

        renderResults(result, container) {
            container.setAttribute('aria-busy', 'false');
            const { total_found, returned, schedules, search_complete } = result;
            if (!schedules || schedules.length === 0) {
                const hasLocks = Object.keys(deps.state.sectionLocks || {}).length > 0;
                const hasRequirements = deps.state.timePreferencesRequired
                    || deps.state.walkingBufferRequired
                    || deps.state.avoidedDaysRequired;
                if (hasLocks) {
                    container.innerHTML = '<p class="solver-error">No conflict-free schedule works with the locked sections. Change a section preference or remove a course.</p>';
                } else if (hasRequirements) {
                    container.innerHTML = '<p class="solver-error">No schedule meets every required preference. Switch a requirement to Prefer or adjust its choices.</p>';
                } else {
                    container.innerHTML = '<p class="hint">No conflict-free schedules found. Remove a course or adjust your preferences.</p>';
                }
                Accessibility.announce(container.textContent, 'schedule');
                return;
            }

            let html = `<p class="solver-summary">Showing ${returned} of ${search_complete ? '' : 'at least '}${total_found} possible schedules.</p>`;
            schedules.forEach((schedule, index) => {
                const applied = this.isAppliedSchedule(schedule);
                const courseList = Object.entries(schedule.sections).map(([code, section]) =>
                    `<button type="button" class="sched-course" data-schedule-index="${index}" data-course-code="${this.escapeHtml(code)}" title="View ${this.escapeHtml(code)} Section ${this.escapeHtml(section.section || '')} details"><strong>${this.escapeHtml(code)} ${this.escapeHtml(section.section || '')}</strong></button>`,
                ).join('');
                html += `
                    <article class="schedule-card${applied ? ' applied' : ''}" data-idx="${index}" data-schedule-id="${this.escapeHtml(schedule.id || '')}">
                        <div class="schedule-card-header">
                            <span class="score">Option ${schedule.ordinal || index + 1}</span>
                            <button class="btn-apply" data-idx="${index}"${applied ? ' disabled' : ''}>${applied ? 'APPLIED' : 'APPLY'}</button>
                        </div>
                        <button type="button" class="schedule-mini-calendar" data-schedule-index="${index}" aria-label="Apply schedule ${schedule.ordinal || index + 1} and open details">${this.scheduleCalendarMarkup(schedule)}</button>
                        <div class="schedule-option-summary" data-summary-index="${index}" role="group" aria-label="Summary for schedule ${index + 1}" aria-busy="true">${this.scheduleSummaryMarkup(this.scheduleSummarySections(schedule))}</div>
                        <div class="sched-courses">${courseList}</div>
                    </article>
                `;
            });
            if (total_found > returned) {
                html += `<button class="btn-show-more" type="button" data-next-limit="${returned + 10}">SHOW 10 MORE</button>`;
            }
            this.hideScheduleCalendarPopup();
            container.innerHTML = html;
            if (!result.session_page) Accessibility.announce(`Showing ${returned} of ${search_complete ? '' : 'at least '}${total_found} possible schedules.`, 'schedule');

            container.querySelectorAll('.schedule-option-summary').forEach(summary => {
                summary.addEventListener('click', event => {
                    event.stopPropagation();
                    this.hideScheduleCalendarPopup();
                    this.applySchedule(Number(summary.dataset.summaryIndex));
                });
            });
            if (!result.session_page) this.hydrateScheduleSummaries(schedules, container);
            container.querySelectorAll('.btn-apply').forEach(button => {
                button.addEventListener('click', event => {
                    event.stopPropagation();
                    this.applySchedule(Number(button.dataset.idx));
                });
            });
            container.querySelectorAll('.sched-course').forEach(button => {
                button.addEventListener('click', event => {
                    event.stopPropagation();
                    const schedule = deps.state.solverResults[Number(button.dataset.scheduleIndex)];
                    const section = schedule?.sections?.[button.dataset.courseCode];
                    if (section) this.openSectionQuickView(section);
                });
            });
            container.querySelectorAll('.schedule-mini-calendar').forEach(button => {
                button.addEventListener('click', event => { event.stopPropagation(); this.hideScheduleCalendarPopup(); this.applySchedule(Number(button.dataset.scheduleIndex)); });
                button.addEventListener('mouseenter', () => this.showScheduleCalendarPopup(button));
                button.addEventListener('mouseleave', () => this.deferScheduleCalendarPopupHide());
                button.addEventListener('focus', () => this.showScheduleCalendarPopup(button));
                button.addEventListener('blur', () => this.deferScheduleCalendarPopupHide());
                button.addEventListener('keydown', event => { if (event.key === 'Escape') this.hideScheduleCalendarPopup(); });
            });
            container.querySelectorAll('.schedule-card').forEach(card => {
                this.bindScheduleCardPreview(card, container);
            });
            const showMore = container.querySelector('.btn-show-more');
            if (showMore) {
                showMore.addEventListener('click', () => {
                    this.solve(Number(showMore.dataset.nextLimit));
                });
            }
        },

        scheduleCalendarMarkup(schedule, expanded = false) {
            const meetings = Object.entries(schedule.sections).flatMap(([code, section]) => deps.calendar.parseMeetingTimes(section.meetingTimes).map(meeting => ({
                ...meeting, code, section: section.section, start: deps.calendar.timeToMinutes(meeting.start), end: deps.calendar.timeToMinutes(meeting.end),
            }))).filter(meeting => meeting.day >= 0 && meeting.day <= 6 && meeting.end > meeting.start);
            const days = meetings.some(meeting => meeting.day >= 5) ? 7 : 5;
            const start = meetings.length ? Math.floor(Math.min(...meetings.map(meeting => meeting.start)) / 60) * 60 : 8 * 60;
            const end = meetings.length ? Math.max(start + 120, Math.ceil(Math.max(...meetings.map(meeting => meeting.end)) / 60) * 60) : 18 * 60;
            const timeLabel = minute => `${Math.floor(minute / 60) % 12 || 12}${minute % 60 ? ':' + String(minute % 60).padStart(2, '0') : ''}${minute >= 720 ? 'p' : 'a'}`;
            const rows = [];
            for (let minute = start; minute <= end; minute += 60) rows.push(`<span class="mini-hour" style="top:${(minute - start) / (end - start) * 100}%">${expanded ? timeLabel(minute) : ''}</span>`);
            return `<span class="mini-days" style="grid-template-columns:repeat(${days},1fr)">${deps.calendar.DAY_LABELS.slice(0, days).map(day => `<span>${day[0]}</span>`).join('')}</span><span class="mini-grid" style="--mini-days:${days}">${rows.join('')}${meetings.map(meeting => `<span class="mini-event" style="left:${meeting.day / days * 100}%;width:${100 / days}%;top:${(meeting.start - start) / (end - start) * 100}%;height:${(meeting.end - meeting.start) / (end - start) * 100}%;background:${deps.calendar.getColor(meeting.code)}">${expanded ? `<b>${this.escapeHtml(meeting.code)} ${this.escapeHtml(meeting.section || '')}</b><span>${timeLabel(meeting.start)}–${timeLabel(meeting.end)}</span>` : ''}</span>`).join('')}${meetings.length ? '' : '<span class="mini-async">No timed meetings</span>'}</span>`;
        },

        showScheduleCalendarPopup(button) {
            clearTimeout(this._calendarPopupTimer);
            const schedule = deps.state.solverResults[Number(button.dataset.scheduleIndex)];
            if (!schedule) return;
            let popup = document.getElementById('schedule-calendar-popup');
            if (!popup) {
                popup = document.createElement('div');
                popup.id = 'schedule-calendar-popup';
                popup.className = 'schedule-calendar-popup';
                popup.setAttribute('role', 'tooltip');
                popup.addEventListener('mouseenter', () => clearTimeout(this._calendarPopupTimer));
                popup.addEventListener('mouseleave', () => this.deferScheduleCalendarPopupHide());
                document.body.appendChild(popup);
            }
            this._calendarPopupOwner?.removeAttribute('aria-describedby');
            this._calendarPopupOwner = button;
            button.setAttribute('aria-describedby', popup.id);
            Accessibility.dismissPreview = () => {
                if (popup.hidden) return false;
                this._calendarPopupOwner?.focus();
                this.hideScheduleCalendarPopup();
                return true;
            };
            popup.innerHTML = `<strong>Schedule preview</strong>${this.scheduleCalendarMarkup(schedule, true)}`;
            popup.hidden = false;
            const box = button.getBoundingClientRect();
            const width = Math.min(460, window.innerWidth - 24);
            popup.style.width = `${width}px`;
            popup.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, box.right + 8))}px`;
            popup.style.top = `${Math.max(12, Math.min(window.innerHeight - popup.offsetHeight - 12, box.top))}px`;
        },

        hideScheduleCalendarPopup() {
            clearTimeout(this._calendarPopupTimer);
            this._calendarPopupOwner?.removeAttribute('aria-describedby');
            const popup = document.getElementById('schedule-calendar-popup');
            if (popup) popup.hidden = true;
        },

        deferScheduleCalendarPopupHide() {
            clearTimeout(this._calendarPopupTimer);
            this._calendarPopupTimer = setTimeout(() => {
                const popup = document.getElementById('schedule-calendar-popup');
                if (!popup?.matches(':hover') && !this._calendarPopupOwner?.matches(':hover, :focus')) this.hideScheduleCalendarPopup();
            }, 180);
        },

        bindScheduleCardPreview(card, container) {
            const preview = () => {
                if (this.isAppliedSchedule(deps.state.solverResults[Number(card.dataset.idx)])) return;
                this.previewSchedule(Number(card.dataset.idx));
                container.querySelectorAll('.schedule-card').forEach(item => item.classList.remove('selected'));
                card.classList.add('selected');
            };
            const clearPreview = () => {
                this.clearSchedulePreview();
                card.classList.remove('selected');
            };
            const apply = () => {
                if (this.isAppliedSchedule(deps.state.solverResults[Number(card.dataset.idx)])) {
                    this.showScheduleDetail();
                    return;
                }
                card.classList.remove('selected');
                this.applySchedule(Number(card.dataset.idx));
            };
            card.addEventListener('mouseenter', preview);
            card.addEventListener('mouseleave', clearPreview);
            card.addEventListener('focusin', preview);
            card.addEventListener('focusout', clearPreview);
            card.addEventListener('click', apply);
        },

        initScheduleScrollPreview() {
            const container = document.getElementById('solver-container');
            if (!container || container.dataset.scrollPreviewBound === 'true') return;
            container.dataset.scrollPreviewBound = 'true';

            let pointer = null;
            let previewFrame = null;
            const rememberPointer = event => {
                pointer = { x: event.clientX, y: event.clientY };
            };
            container.addEventListener('pointerenter', rememberPointer);
            container.addEventListener('pointermove', rememberPointer);
            container.addEventListener('pointerleave', () => {
                pointer = null;
                container.querySelectorAll('.schedule-card').forEach(card => card.classList.remove('selected'));
                this.clearSchedulePreview();
            });
            container.addEventListener('scroll', () => {
                if (!pointer || previewFrame !== null) return;
                previewFrame = requestAnimationFrame(() => {
                    previewFrame = null;
                    this.previewScheduleAtPoint(container, pointer.x, pointer.y);
                });
            }, { passive: true });
        },

        previewScheduleAtPoint(container, clientX, clientY) {
            const target = document.elementFromPoint(clientX, clientY);
            const card = target?.closest?.('.schedule-card');
            if (!card || !container.contains(card)) return null;
            const index = Number(card.dataset.idx);
            if (!Number.isInteger(index) || this.isAppliedSchedule(deps.state.solverResults[index])) return null;
            container.querySelectorAll('.schedule-card').forEach(item => item.classList.remove('selected'));
            card.classList.add('selected');
            this.previewSchedule(index);
            return index;
        },

        previewSchedule(index) {
            const schedule = deps.state.solverResults[index];
            if (!schedule || !deps.calendar || typeof deps.calendar.render !== 'function') return;
            const selectedSections = deps.state.selectedSections;
            deps.state.selectedSections = { ...schedule.sections };
            deps.calendar.render({ preview: true });
            deps.state.selectedSections = selectedSections;
        },

        clearSchedulePreview() {
            if (!deps.calendar || typeof deps.calendar.render !== 'function') return;
            deps.calendar.render();
        },

        applySchedule(index) {
            const schedule = deps.state.solverResults[index];
            if (!schedule) return;
            if (schedule.id) this._appliedSolverIdentity = schedule.id;
            deps.state.applySolverSchedule(schedule);
            this.refreshAppliedResultState();
            this.showScheduleDetail();
            Accessibility.announce(`Schedule option ${schedule.ordinal || index + 1} applied. Details are open.`, 'schedule');
        },

        isAppliedSchedule(schedule) {
            const entries = Object.entries(schedule?.sections || {});
            const applied = deps.state.selectedSections || {};
            if (entries.length === 0 || entries.length !== Object.keys(applied).length) return false;
            return entries.every(([code, section]) => String(applied[code]?.crn) === String(section.crn));
        },

        refreshAppliedResultState() {
            const container = document.getElementById('solver-container');
            if (!container || !deps.state.solverResults?.length) return;
            container.querySelectorAll('.schedule-card').forEach(card => {
                const applied = this.isAppliedSchedule(deps.state.solverResults[Number(card.dataset.idx)]);
                card.classList.toggle('applied', applied);
                card.removeAttribute('aria-disabled');
                card.removeAttribute('tabindex');
                const button = card.querySelector('.btn-apply');
                if (button) {
                    button.disabled = applied;
                    button.textContent = applied ? 'APPLIED' : 'APPLY';
                }
            });
        },
        };
    }

    return { createSolvePart };
}));

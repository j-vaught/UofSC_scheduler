/* Shared option-card and viewer metrics. Network work stays outside the solver. */
(function initSummaryPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SchedulerParts) root.SchedulerParts = {};
    root.SchedulerParts.createSummaryPart = api.createSummaryPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createSummaryPart(deps) {
        return {
            scheduleSummarySections(schedule) {
                return Object.entries(schedule.sections || {}).map(([code, section]) => ({ ...section, code }));
            },

            scheduleSummaryKey(sections) {
                return JSON.stringify([deps.state.term, sections.map(section => [
                    section.code, String(section.crn), section.section, section.meetingTimes,
                    section.instructionalMethod || section.inst_mthd,
                    deps.state.selectedCourses[section.code]?.credits ?? section.hours,
                    section.start_date || section.startDate, section.end_date || section.endDate,
                    section.location || section.building,
                    deps.walkingMap?.sectionDetails.get(deps.walkingMap.sectionDetailKey(section)),
                ]).sort((left, right) => left[0].localeCompare(right[0]))]);
            },

            summarySectionIsOnline(section) {
                return /^J/i.test(String(section.section || '').trim())
                    || deps.walkingMap?.isOnline(section)
                    || /online|web|remote|distance|asynchronous/i.test(String(section.instructional_method || ''));
            },

            scheduleGradeEstimate(sections) {
                this._scheduleGradeEstimates ||= new Map();
                const key = this.scheduleSummaryKey(sections);
                if (!this._scheduleGradeEstimates.has(key)) {
                    const creditValues = sections.map(section => this.parseCreditHours(deps.state.selectedCourses[section.code]?.credits ?? section.hours));
                    const term = deps.state.term;
                    this._scheduleGradeEstimates.set(key, (async () => {
                        const historical = [];
                        // A small pool limits faculty requests even for large course lists.
                        let cursor = 0;
                        const worker = async () => {
                            while (cursor < sections.length) {
                                const index = cursor++;
                                const section = sections[index];
                                const { grades, faculty } = await this.scheduleSectionData(section, term);
                                const instructors = this.currentInstructorSummaries({ sections: [section] }, grades, faculty);
                                const valid = grade => grade && grade.average_gpa != null
                                    && Number.isFinite(Number(grade.average_gpa)) && Number(grade.graded_students) > 0;
                                const records = instructors.map(item => item.grade).filter(valid);
                                let gpa = null;
                                let reason = '';
                                if (instructors.length && records.length === instructors.length) {
                                    const students = records.reduce((sum, grade) => sum + Number(grade.graded_students), 0);
                                    gpa = records.reduce((sum, grade) => sum + Number(grade.average_gpa) * Number(grade.graded_students), 0) / students;
                                } else if (valid(grades)) {
                                    gpa = Number(grades.average_gpa);
                                    reason = 'Instructor history missing. Using course-wide grades.';
                                } else reason = 'No historical course grades. Excluded from estimate.';
                                if (creditValues[index] === null) reason = 'Credit hours unavailable. Excluded from estimate.';
                                historical[index] = { code: section.code, credits: creditValues[index] || 0, gpa, reason };
                            }
                        };
                        await Promise.all(Array.from({ length: Math.min(3, sections.length) }, worker));
                        const matched = historical.filter(item => item.gpa !== null && item.credits > 0);
                        const covered = matched.reduce((sum, item) => sum + item.credits, 0);
                        return {
                            estimate: covered ? (matched.reduce((sum, item) => sum + item.gpa * item.credits, 0) / covered).toFixed(2) : 'Unavailable',
                            missing: historical.filter(item => item.reason),
                        };
                    })());
                    if (this._scheduleGradeEstimates.size > 120) this._scheduleGradeEstimates.delete(this._scheduleGradeEstimates.keys().next().value);
                }
                return this._scheduleGradeEstimates.get(key);
            },

            scheduleTravelEstimate(sections) {
                this._scheduleTravelEstimates ||= new Map();
                const key = this.scheduleSummaryKey(sections);
                if (!this._scheduleTravelEstimates.has(key)) {
                    this._scheduleTravelEstimates.set(key, this.calculateScheduleTravel(sections));
                    if (this._scheduleTravelEstimates.size > 120) this._scheduleTravelEstimates.delete(this._scheduleTravelEstimates.keys().next().value);
                }
                return this._scheduleTravelEstimates.get(key);
            },

            async calculateScheduleTravel(sections) {
                const map = deps.walkingMap;
                if (!map) return { miles: null, minutes: null, campusDays: null, issues: ['Campus locations unavailable.'] };
                const normalized = sections.map(section => this.summarySectionIsOnline(section)
                    ? { ...section, instructionalMethod: 'Online' } : section);
                const issues = new Set();
                let campusDays = 0;
                let meters = 0;
                let minutes = 0;
                let known = 0;
                let unknown = 0;
                let transitions = 0;
                for (const section of normalized) {
                    if (!this.summarySectionIsOnline(section) && !map.parseMeetingTimes(section.meetingTimes).length) {
                        issues.add(`${section.code}. Meeting times unavailable.`);
                        unknown++;
                    }
                }
                for (let day = 0; day < 7; day++) {
                    // Online meetings do not remove the journey between the surrounding campus classes.
                    // Unknown locations stay in sequence so an unknown journey cannot silently become zero.
                    const events = map.buildEvents(normalized, day).filter(event => !event.online && event.building.kind !== 'online');
                    if (events.length) campusDays++;
                    for (const event of events) {
                        if (event.building.kind !== 'known') issues.add(`${event.code}. Campus location unavailable.`);
                    }
                    for (let index = 0; index + 1 < events.length; index++) {
                        transitions++;
                        const from = events[index].building;
                        const to = events[index + 1].building;
                        const routeKey = map.routeCacheKey(from, to);
                        this._summaryRoutes ||= new Map();
                        if (!this._summaryRoutes.has(routeKey)) {
                            const pending = map.routeBetween(from, to, { signal: AbortSignal.timeout(8000) });
                            this._summaryRoutes.set(routeKey, pending);
                            pending.then(() => this._summaryRoutes.delete(routeKey), () => this._summaryRoutes.delete(routeKey));
                        }
                        const route = await this._summaryRoutes.get(routeKey);
                        if (route.distance == null || route.walkMinutes == null) {
                            unknown++;
                            issues.add(`${events[index].code} to ${events[index + 1].code}. Route unavailable.`);
                        } else {
                            known++;
                            meters += route.distance;
                            minutes += route.walkMinutes;
                            if (route.kind === 'estimated') issues.add('Includes estimated routes.');
                        }
                    }
                }
                // Distinct date ranges can change the week. Do not present their combined pattern as exact.
                const datePatterns = new Set(normalized.filter(section => !this.summarySectionIsOnline(section))
                    .map(section => [section.start_date || section.startDate || '', section.end_date || section.endDate || ''].join('|')).filter(value => value !== '|'));
                if (datePatterns.size > 1) issues.add('Class date ranges differ. Total uses the recurring weekly meeting pattern.');
                return {
                    miles: unknown && !known ? null : meters / 1609.344,
                    minutes: unknown && !known ? null : minutes,
                    campusDays, incomplete: unknown > 0, issues: [...issues], transitions,
                };
            },

            summaryMetricMarkup(label, value, help, warning = false) {
                return `<button type="button" class="schedule-summary-metric" data-help="${this.escapeHtml(help)}" aria-label="${this.escapeHtml(`${label}. ${value}${warning ? '. Data issues. ' + help : ''}`)}"><span>${this.escapeHtml(label)}</span><strong>${this.escapeHtml(value)}${warning ? '<span class="summary-caution" aria-hidden="true"> ⚠</span>' : ''}</strong></button>`;
            },

            scheduleSummaryMarkup(sections, grade = null, travel = null) {
                const gradeHelp = grade?.missing.length ? grade.missing.map(item => `${item.code}. ${item.reason}`).join(' ')
                    : 'Credit-weighted past grades using instructor history, with course-wide history when needed. This is not a prediction of your grade.';
                const miles = travel?.miles == null ? (travel ? 'Unavailable' : 'Loading…') : `${travel.incomplete ? '≥ ' : ''}${travel.miles.toFixed(2)} mi/week`;
                const travelHelp = travel ? [
                    'Travel between classes across the full recurring week. Excludes commuting to and from campus.',
                    travel.minutes != null ? `${travel.incomplete ? 'At least ' : ''}${travel.minutes} walking minutes per week.` : '',
                    ...travel.issues,
                ].filter(Boolean).join(' ') : 'Loading campus routes across the full week.';
                const online = sections.filter(section => this.summarySectionIsOnline(section)).length;
                return `<span class="schedule-summary-heading">Summary</span>${this.summaryMetricMarkup('Estimated GPA', grade?.estimate || 'Loading…', gradeHelp, Boolean(grade?.missing.length))}${this.summaryMetricMarkup('Weekly walking', miles, travelHelp, Boolean(travel?.issues.length))}${this.summaryMetricMarkup('Campus days', travel?.campusDays == null ? (travel ? 'Unavailable' : 'Loading…') : String(travel.campusDays), 'Days with a scheduled campus meeting. Online-only days are excluded.')}${online ? this.summaryMetricMarkup('Online classes', String(online), 'Selected sections beginning with J, or labelled online, web, remote, distance, or asynchronous.') : ''}`;
            },

            updateScheduleSummaryPane(summary, markup) {
                // Retain the metric buttons so background data never removes keyboard focus.
                const template = document.createElement('template');
                template.innerHTML = markup;
                const replacements = template.content.querySelectorAll('.schedule-summary-metric');
                summary.querySelectorAll('.schedule-summary-metric').forEach((button, index) => {
                    const replacement = replacements[index];
                    if (!replacement) return;
                    button.dataset.help = replacement.dataset.help;
                    button.setAttribute('aria-label', replacement.getAttribute('aria-label'));
                    button.querySelector('strong').innerHTML = replacement.querySelector('strong').innerHTML;
                });
            },

            async hydrateScheduleSummaries(schedules, container) {
                const generation = this._scheduleSummaryGeneration = (this._scheduleSummaryGeneration || 0) + 1;
                const term = deps.state.term;
                let cursor = 0;
                const worker = async () => {
                    while (cursor < schedules.length && generation === this._scheduleSummaryGeneration && term === deps.state.term) {
                        const index = cursor++;
                        const sections = this.scheduleSummarySections(schedules[index]);
                        const summary = container.querySelector(`[data-summary-index="${index}"]`);
                        const current = () => generation === this._scheduleSummaryGeneration && term === deps.state.term && summary?.isConnected;
                        try {
                            const grade = await this.scheduleGradeEstimate(sections);
                            if (!current()) return;
                            this.updateScheduleSummaryPane(summary, this.scheduleSummaryMarkup(sections, grade));
                            const travel = await this.scheduleTravelEstimate(sections);
                            if (!current()) return;
                            this.updateScheduleSummaryPane(summary, this.scheduleSummaryMarkup(sections, grade, travel));
                        } catch (error) {
                            if (current()) this.updateScheduleSummaryPane(summary, this.scheduleSummaryMarkup(sections, { estimate: 'Unavailable', missing: [{ code: 'Summary', reason: 'Data could not be loaded.' }] }, { miles: null, minutes: null, campusDays: null, issues: ['Travel data unavailable.'] }));
                        }
                        if (current()) summary.removeAttribute('aria-busy');
                    }
                };
                await Promise.all(Array.from({ length: Math.min(2, schedules.length) }, worker));
            },
        };
    }
    return { createSummaryPart };
}));

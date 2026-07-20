/*
 * Scheduling preferences: times, days, and walking buffer.
 *
 * One part of the scheduler feature, which was a single module of over two
 * thousand lines. Each part is a factory returning plain methods; index.js
 * merges them onto one object, so `this` still reaches every method and no
 * call site changed.
 *
 * Cut at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly.
 */
(function initPreferencesPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SchedulerParts) root.SchedulerParts = {};
    root.SchedulerParts.createPreferencesPart = api.createPreferencesPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createPreferencesPart(deps) {
        return {
        formatPreferenceTime(value) {
            const numeric = Number(value);
            const hours = Math.floor(numeric / 100);
            const minutes = numeric % 100;
            return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        },

        parsePreferenceTime(value) {
            const [hours, minutes] = String(value || '').split(':').map(Number);
            return hours * 100 + minutes;
        },

        openSchedulePreferences() {
            const overlay = document.getElementById('modal-overlay');
            const modal = document.getElementById('modal');
            const content = document.getElementById('modal-content');
            if (!overlay || !modal || !content) return;
            modal.classList.remove('course-quick-modal', 'registration-info-modal');
            modal.classList.add('schedule-preferences-modal');

            const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
            const avoidedDays = new Set((deps.state.avoidedDays || []).map(Number));
            const modeControl = (id, label, required) => `
                <label class="schedule-preference-mode" for="${id}">
                    <input id="${id}" type="checkbox"${required ? ' checked' : ''} aria-label="${label}">
                    <span class="schedule-preference-mode-track" aria-hidden="true">
                        <span class="prefer">PREFER</span><span class="require">REQUIRE</span>
                    </span>
                </label>
            `;
            const dayOptions = dayNames.map((name, day) => `
                <label>
                    <input type="checkbox" name="schedule-avoid-day" value="${day}"${avoidedDays.has(day) ? ' checked' : ''}>
                    ${name.slice(0, 3).toUpperCase()}
                </label>
            `).join('');

            content.innerHTML = `
                <section class="schedule-preferences-dialog" aria-labelledby="schedule-preferences-title">
                    <h2 id="schedule-preferences-title">Schedule Preferences</h2>
                    <div class="schedule-preference-grid">
                        <fieldset class="schedule-preference-times">
                            <legend>Class times to avoid</legend>
                            ${modeControl('schedule-time-mode-required', 'Require all class-time choices', deps.state.timePreferencesRequired)}
                            <div class="schedule-time-options">
                                <label for="schedule-preferred-start">
                                    <span>Before</span>
                                    <input id="schedule-preferred-start" type="time" value="${this.formatPreferenceTime(deps.state.preferredStart)}">
                                </label>
                                <label for="schedule-preferred-end">
                                    <span>Ending after</span>
                                    <input id="schedule-preferred-end" type="time" value="${this.formatPreferenceTime(deps.state.preferredEnd)}">
                                </label>
                            </div>
                            <button id="btn-advanced-time-avoidance" class="btn-panel-secondary schedule-advanced-toggle" type="button" aria-expanded="false" aria-controls="schedule-advanced-time-panel">ADVANCED TIME BLOCKS</button>
                            <div id="schedule-advanced-time-panel" class="schedule-advanced-time-panel hidden">
                                <div class="schedule-advanced-heading">
                                    <span>Draw over times you would rather avoid.</span>
                                    <button id="btn-clear-advanced-times" type="button">CLEAR</button>
                                </div>
                                <div class="schedule-advanced-calendar-wrap">
                                    <div id="schedule-advanced-calendar" class="schedule-advanced-calendar" aria-label="Weekly times to avoid"></div>
                                </div>
                            </div>
                        </fieldset>
                        <fieldset class="schedule-preference-walking">
                            <legend>Minimum time between classes</legend>
                            ${modeControl('schedule-walking-mode-required', 'Require the minimum time between classes', deps.state.walkingBufferRequired)}
                            <label for="schedule-minimum-walking-buffer">
                                <span>Extra time after walking between classes</span>
                                <input id="schedule-minimum-walking-buffer" type="number" min="1" max="120" step="1" value="${Math.max(1, Number(deps.state.minimumWalkingBuffer) || 1)}">
                            </label>
                            <small>Choose 10 to arrive at least ten minutes early.</small>
                        </fieldset>
                        <fieldset class="schedule-preference-days">
                            <legend>Days to avoid</legend>
                            ${modeControl('schedule-days-mode-required', 'Require classes to avoid the selected days', deps.state.avoidedDaysRequired)}
                            <div class="schedule-day-options">${dayOptions}</div>
                        </fieldset>
                    </div>
                    <p id="schedule-preferences-error" class="schedule-preferences-error" role="alert"></p>
                    <div class="schedule-preference-actions">
                        <button id="btn-save-schedule-preferences" type="button" class="btn-garnet">SAVE PREFERENCES</button>
                    </div>
                </section>
            `;
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'schedule-preferences-title');
            if (window.AppModal) {
                AppModal.open(content.innerHTML, { className: 'schedule-preferences-modal', label: 'Schedule preferences' });
            } else {
                overlay.classList.remove('hidden');
            }

            const saveButton = document.getElementById('btn-save-schedule-preferences');
            saveButton.addEventListener('click', () => this.saveSchedulePreferences());
            const advancedToggle = document.getElementById('btn-advanced-time-avoidance');
            advancedToggle.addEventListener('click', () => {
                const panel = document.getElementById('schedule-advanced-time-panel');
                const expanded = advancedToggle.getAttribute('aria-expanded') === 'true';
                advancedToggle.setAttribute('aria-expanded', String(!expanded));
                advancedToggle.textContent = expanded ? 'ADVANCED TIME BLOCKS' : 'HIDE ADVANCED';
                panel.classList.toggle('hidden', expanded);
            });
            document.getElementById('btn-clear-advanced-times').addEventListener('click', () => {
                document.querySelectorAll('#schedule-advanced-calendar .schedule-advanced-cell.selected')
                    .forEach(cell => {
                        cell.classList.remove('selected');
                        cell.setAttribute('aria-pressed', 'false');
                    });
            });
            this.buildAdvancedTimeAvoidance();
            saveButton.focus();
        },

        buildAdvancedTimeAvoidance() {
            const calendar = document.getElementById('schedule-advanced-calendar');
            if (!calendar) return;
            const selected = new Set((deps.state.avoidedTimeBlocks || [])
                .map(block => `${Number(block.day)}-${Number(block.start)}-${Number(block.end)}`));
            const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
            calendar.innerHTML = `<div class="schedule-advanced-corner"></div>${days
                .map(day => `<div class="schedule-advanced-day">${day}</div>`).join('')}`;

            for (let hour = 8; hour < 22; hour++) {
                for (let half = 0; half < 2; half++) {
                    const start = hour * 100 + half * 30;
                    const end = half === 0 ? hour * 100 + 30 : (hour + 1) * 100;
                    const displayHour = hour > 12 ? hour - 12 : hour;
                    calendar.insertAdjacentHTML('beforeend', `<div class="schedule-advanced-time">${half === 0 ? `${displayHour}${hour >= 12 ? 'p' : 'a'}` : ''}</div>`);
                    days.forEach((day, dayIndex) => {
                        const key = `${dayIndex}-${start}-${end}`;
                        calendar.insertAdjacentHTML('beforeend', `
                            <button type="button" class="schedule-advanced-cell${selected.has(key) ? ' selected' : ''}" data-day="${dayIndex}" data-start="${start}" data-end="${end}" aria-label="${day} ${this.formatPreferenceTime(start)} to ${this.formatPreferenceTime(end)}" aria-pressed="${selected.has(key)}"></button>
                        `);
                    });
                }
            }

            const setCell = (cell, value) => {
                if (!cell?.classList.contains('schedule-advanced-cell')) return;
                cell.classList.toggle('selected', value);
                cell.setAttribute('aria-pressed', String(value));
            };
            calendar.querySelectorAll('.schedule-advanced-cell').forEach(cell => {
                cell.addEventListener('pointerdown', event => {
                    event.preventDefault();
                    const paint = !cell.classList.contains('selected');
                    setCell(cell, paint);
                    const move = moveEvent => {
                        const target = document.elementFromPoint?.(moveEvent.clientX, moveEvent.clientY);
                        setCell(target?.closest?.('.schedule-advanced-cell'), paint);
                    };
                    const finish = () => {
                        document.removeEventListener('pointermove', move);
                        document.removeEventListener('pointerup', finish);
                        document.removeEventListener('pointercancel', finish);
                    };
                    document.addEventListener('pointermove', move);
                    document.addEventListener('pointerup', finish);
                    document.addEventListener('pointercancel', finish);
                });
                cell.addEventListener('keydown', event => {
                    if (!['Enter', ' '].includes(event.key)) return;
                    event.preventDefault();
                    setCell(cell, !cell.classList.contains('selected'));
                });
            });
        },

        saveSchedulePreferences() {
            const start = this.parsePreferenceTime(document.getElementById('schedule-preferred-start').value);
            const end = this.parsePreferenceTime(document.getElementById('schedule-preferred-end').value);
            const error = document.getElementById('schedule-preferences-error');
            if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
                error.textContent = 'The preferred end time must be later than the preferred start time.';
                return false;
            }

            const minimumWalkingBuffer = Number(document.getElementById('schedule-minimum-walking-buffer').value);
            deps.state.minimumWalkingBuffer = Math.max(1, Math.min(120, Number.isFinite(minimumWalkingBuffer) ? Math.round(minimumWalkingBuffer) : 1));
            deps.state.preferredStart = start;
            deps.state.preferredEnd = end;
            deps.state.avoidedDays = Array.from(document.querySelectorAll('input[name="schedule-avoid-day"]:checked'))
                .map(input => Number(input.value));
            deps.state.avoidedTimeBlocks = Array.from(document.querySelectorAll('#schedule-advanced-calendar .schedule-advanced-cell.selected'))
                .map(cell => ({
                    day: Number(cell.dataset.day),
                    start: Number(cell.dataset.start),
                    end: Number(cell.dataset.end),
                }));
            deps.state.timePreferencesRequired = document.getElementById('schedule-time-mode-required').checked;
            deps.state.walkingBufferRequired = document.getElementById('schedule-walking-mode-required').checked;
            deps.state.avoidedDaysRequired = document.getElementById('schedule-days-mode-required').checked;
            if (typeof window !== 'undefined' && window.AppModal) window.AppModal.close();
            deps.state.emit('preferences-changed');
            return true;
        },

        };
    }

    return { createPreferencesPart };
}));

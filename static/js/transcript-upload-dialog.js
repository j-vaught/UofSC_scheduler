/* Reusable advising-transcript upload and review dialog.
 *
 * Parser integration contract.
 * TranscriptUploadDialog.setProcessor(async ({ file, level, source, onProgress }) => result)
 * TranscriptUploadDialog.setApplyHandler(async ({ result, mode, level, source }) => {})
 *
 * Alternative integrations may cancel transcript-import:selected or
 * transcript-import:confirmed and use the callbacks supplied in event.detail.
 */
const TranscriptUploadDialog = {
    MAX_FILE_BYTES: 25 * 1024 * 1024,
    DIRECT_TRANSCRIPT_URL: 'https://banner.onecarolina.sc.edu/StudentSelfService/ssb/academicTranscript?mepCode=COL#!/maintenance',
    PORTAL_URL: 'https://my.sc.edu',
    _initialized: false,
    _processor: null,
    _applyHandler: null,
    _file: null,
    _result: null,
    _source: 'unknown',
    _previousFocus: null,
    _requestId: 0,
    _undoHandler: null,

    init(options = {}) {
        if (options.processor) this.setProcessor(options.processor);
        if (options.applyHandler) this.setApplyHandler(options.applyHandler);
        if (this._initialized || typeof document === 'undefined') return this;

        document.body.insertAdjacentHTML('beforeend', this.shellMarkup());
        this.renderLaunchers();
        this.bindDialog();
        this._initialized = true;
        return this;
    },

    setProcessor(processor) {
        if (processor !== null && typeof processor !== 'function') {
            throw new TypeError('Transcript processor must be a function or null.');
        }
        this._processor = processor;
        return this;
    },

    setApplyHandler(handler) {
        if (handler !== null && typeof handler !== 'function') {
            throw new TypeError('Transcript apply handler must be a function or null.');
        }
        this._applyHandler = handler;
        return this;
    },

    renderLaunchers(root = document) {
        root.querySelectorAll('[data-transcript-upload-launch]').forEach(container => {
            if (container.querySelector('[data-open-transcript-upload]')) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'transcript-upload-launch btn-black';
            button.dataset.openTranscriptUpload = container.dataset.transcriptUploadLaunch || 'unknown';
            button.textContent = 'IMPORT ADVISING TRANSCRIPT';
            button.addEventListener('click', () => this.open({ source: button.dataset.openTranscriptUpload }));
            container.appendChild(button);
        });
    },

    shellMarkup() {
        return `
            <div id="transcript-upload-overlay" class="transcript-upload-overlay" hidden>
                <section id="transcript-upload-dialog" class="transcript-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="transcript-upload-title" aria-describedby="transcript-upload-description">
                    <header class="transcript-upload-header">
                        <div>
                            <span class="transcript-upload-kicker">UOFSC ADVISING TRANSCRIPT</span>
                            <h2 id="transcript-upload-title">Import completed coursework</h2>
                        </div>
                        <button type="button" class="transcript-upload-close" data-transcript-close aria-label="Close transcript import">&times;</button>
                    </header>

                    <div class="transcript-upload-body">
                        <p id="transcript-upload-description" class="transcript-upload-intro">Download an advising transcript from UofSC, then choose the PDF here. You will review every course before anything changes.</p>

                        <div class="transcript-upload-workspace">
                            <section class="transcript-upload-guide" aria-labelledby="transcript-guide-title">
                                <h3 id="transcript-guide-title">Download your transcript</h3>
                                <ol>
                                    <li><a href="${this.DIRECT_TRANSCRIPT_URL}" target="_blank" rel="noopener noreferrer">Open UofSC Advising Transcript</a> and sign in. Choose Columbia if prompted.</li>
                                    <li>Select <strong>Undergraduate</strong> or <strong>Graduate</strong>, choose <strong>Advising</strong>, then select <strong>Submit</strong>.</li>
                                    <li>Review the transcript, select <strong>Print</strong>, then use <strong>Download</strong> or <strong>Save as PDF</strong>.</li>
                                </ol>
                                <p class="transcript-upload-fallback">Direct link not working? Start at <a href="${this.PORTAL_URL}" target="_blank" rel="noopener noreferrer">my.sc.edu</a>, then choose Student, Grades, and Advising Transcript.</p>
                            </section>

                            <section class="transcript-upload-picker" aria-labelledby="transcript-picker-title">
                                <h3 id="transcript-picker-title">Choose the saved PDF</h3>
                                <fieldset class="transcript-level-options">
                                    <legend>Transcript level</legend>
                                    <label><input type="radio" name="transcript-level" value="UG" checked> Undergraduate</label>
                                    <label><input type="radio" name="transcript-level" value="GR"> Graduate</label>
                                </fieldset>

                                <label id="transcript-drop-zone" class="transcript-drop-zone" for="transcript-pdf-input" tabindex="0">
                                    <span class="transcript-drop-zone-title">Drop advising transcript PDF here</span>
                                    <span class="transcript-drop-zone-copy">or select a PDF from this computer</span>
                                    <span class="transcript-drop-zone-action">CHOOSE PDF</span>
                                    <input type="file" id="transcript-pdf-input" accept="application/pdf,.pdf">
                                </label>
                                <p id="transcript-file-name" class="transcript-file-name" aria-live="polite">No PDF selected.</p>
                                <p class="transcript-privacy"><strong>Processed on this device.</strong> The PDF is not uploaded or saved. Student names and identifiers are not added to your profile.</p>
                            </section>
                        </div>

                        <div id="transcript-import-status" class="transcript-import-status" aria-live="polite" aria-atomic="true">
                            <section id="transcript-processing-state" class="transcript-state" hidden>
                                <div class="transcript-progress-heading">
                                    <strong id="transcript-progress-label">Reading transcript</strong>
                                    <span id="transcript-progress-value">0%</span>
                                </div>
                                <div class="transcript-progress-track" role="progressbar" aria-label="Transcript processing progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                                    <div id="transcript-progress-fill"></div>
                                </div>
                            </section>

                            <section id="transcript-error-state" class="transcript-state transcript-error-state" role="alert" hidden>
                                <strong>Could not read this transcript</strong>
                                <p id="transcript-error-message"></p>
                            </section>

                            <section id="transcript-review-state" class="transcript-state transcript-review-state" aria-labelledby="transcript-review-title" hidden>
                                <div class="transcript-review-heading">
                                    <div>
                                        <span class="transcript-review-kicker">READY TO REVIEW</span>
                                        <h3 id="transcript-review-title">Check the extracted coursework</h3>
                                    </div>
                                    <strong id="transcript-review-total"></strong>
                                </div>
                                <div id="transcript-review-summary" class="transcript-review-summary"></div>
                                <div id="transcript-review-preview" class="transcript-review-preview"></div>
                                <fieldset class="transcript-import-mode">
                                    <legend>How should this import be applied?</legend>
                                    <label>
                                        <input type="radio" name="transcript-import-mode" value="merge" checked>
                                        <span><strong>Merge with my profile</strong><small>Keep existing entries and add new transcript records.</small></span>
                                    </label>
                                    <label>
                                        <input type="radio" name="transcript-import-mode" value="replace">
                                        <span><strong>Replace entered coursework</strong><small>Remove coursework currently entered in the profile after confirmation.</small></span>
                                    </label>
                                </fieldset>
                            </section>

                            <section id="transcript-complete-state" class="transcript-state transcript-complete-state" hidden>
                                <strong>Transcript added to your profile</strong>
                                <p id="transcript-complete-message">Your confirmed coursework is ready for degree planning.</p>
                            </section>
                        </div>
                    </div>

                    <footer class="transcript-upload-footer">
                        <button type="button" class="btn-black" data-transcript-close>CANCEL</button>
                        <button type="button" class="btn-black" id="transcript-undo" hidden>UNDO IMPORT</button>
                        <button type="button" class="btn-black" id="transcript-import-another" hidden>IMPORT ANOTHER LEVEL</button>
                        <button type="button" class="btn-garnet" id="transcript-analyze" disabled>ANALYZE PDF</button>
                        <button type="button" class="btn-garnet" id="transcript-confirm" hidden>CONFIRM IMPORT</button>
                        <button type="button" class="btn-garnet" id="transcript-done" hidden>DONE</button>
                    </footer>
                </section>
            </div>`;
    },

    bindDialog() {
        this.overlay = document.getElementById('transcript-upload-overlay');
        this.dialog = document.getElementById('transcript-upload-dialog');
        this.fileInput = document.getElementById('transcript-pdf-input');
        this.dropZone = document.getElementById('transcript-drop-zone');

        this.dialog.querySelectorAll('[data-transcript-close]').forEach(button => {
            button.addEventListener('click', () => this.close());
        });
        document.getElementById('transcript-done').addEventListener('click', () => this.close());
        document.getElementById('transcript-analyze').addEventListener('click', () => this.analyze());
        document.getElementById('transcript-confirm').addEventListener('click', () => this.confirm());
        document.getElementById('transcript-undo').addEventListener('click', () => this.undo());
        document.getElementById('transcript-import-another').addEventListener('click', () => this.importAnotherLevel());

        this.fileInput.addEventListener('change', event => this.acceptFile(event.target.files?.[0]));
        this.dropZone.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            this.fileInput.click();
        });
        ['dragenter', 'dragover'].forEach(type => this.dropZone.addEventListener(type, event => {
            event.preventDefault();
            this.dropZone.classList.add('drag-active');
        }));
        ['dragleave', 'dragend'].forEach(type => this.dropZone.addEventListener(type, event => {
            event.preventDefault();
            this.dropZone.classList.remove('drag-active');
        }));
        this.dropZone.addEventListener('drop', event => {
            event.preventDefault();
            this.dropZone.classList.remove('drag-active');
            this.acceptFile(event.dataTransfer?.files?.[0]);
        });

        this.overlay.addEventListener('click', event => {
            if (event.target === this.overlay) this.close();
        });
        document.addEventListener('keydown', event => {
            if (this.overlay.hidden) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                this.close();
            } else if (event.key === 'Tab') {
                this.trapFocus(event);
            }
        });
    },

    open({ source = 'unknown', level = null } = {}) {
        if (!this._initialized) this.init();
        this._source = source;
        this._previousFocus = document.activeElement;
        this.reset({ preserveLevel: true });
        if (level) {
            const selected = this.dialog.querySelector(`input[name="transcript-level"][value="${level}"]`);
            if (selected) selected.checked = true;
        }
        this.overlay.hidden = false;
        document.body.classList.add('transcript-dialog-open');
        requestAnimationFrame(() => this.dialog.querySelector('[data-transcript-close]')?.focus());
        this.emit('transcript-import:opened', { source });
    },

    close() {
        if (!this.overlay || this.overlay.hidden) return;
        this._requestId += 1;
        this.overlay.hidden = true;
        document.body.classList.remove('transcript-dialog-open');
        const restore = this._previousFocus;
        this._previousFocus = null;
        requestAnimationFrame(() => restore?.isConnected && restore.focus());
        this.emit('transcript-import:closed', { source: this._source });
    },

    reset({ preserveLevel = false } = {}) {
        const currentLevel = preserveLevel ? this.level() : 'UG';
        this._file = null;
        this._result = null;
        this._undoHandler = null;
        if (this.fileInput) this.fileInput.value = '';
        if (this.dialog) {
            this.dialog.querySelectorAll('input[name="transcript-level"]').forEach(input => {
                input.checked = input.value === currentLevel;
            });
            this.dialog.querySelectorAll('input[name="transcript-import-mode"]').forEach(input => {
                input.checked = input.value === 'merge';
            });
        }
        this.hideStates();
        const completeState = document.getElementById('transcript-complete-state');
        if (completeState) {
            completeState.querySelector('strong').textContent = 'Transcript added to your profile';
            document.getElementById('transcript-complete-message').textContent = 'Your confirmed coursework is ready for degree planning.';
        }
        this.setFileLabel('No PDF selected.');
        this.toggleButton('transcript-analyze', true, { disabled: true });
        this.toggleButton('transcript-confirm', false);
        this.toggleButton('transcript-undo', false);
        this.toggleButton('transcript-import-another', false);
        this.toggleButton('transcript-done', false);
    },

    level() {
        return this.dialog?.querySelector('input[name="transcript-level"]:checked')?.value || 'UG';
    },

    importMode() {
        return this.dialog?.querySelector('input[name="transcript-import-mode"]:checked')?.value || 'merge';
    },

    validPdf(file) {
        if (!file || typeof file.name !== 'string') return false;
        const extensionMatches = file.name.toLowerCase().endsWith('.pdf');
        const typeMatches = !file.type || String(file.type).toLowerCase() === 'application/pdf';
        return extensionMatches && typeMatches && Number(file.size || 0) <= this.MAX_FILE_BYTES;
    },

    acceptFile(file) {
        this.hideStates();
        if (!file) return;
        if (!this.validPdf(file)) {
            this._file = null;
            this.setFileLabel('No PDF selected.');
            this.toggleButton('transcript-analyze', true, { disabled: true });
            const tooLarge = Number(file.size || 0) > this.MAX_FILE_BYTES;
            this.setError(tooLarge ? 'Choose a PDF smaller than 25 MB.' : 'Choose the advising transcript as a PDF file.');
            return;
        }
        this._file = file;
        this._result = null;
        this.setFileLabel(`${file.name} · ${this.formatBytes(file.size)}`);
        this.toggleButton('transcript-analyze', true, { disabled: false });
        this.toggleButton('transcript-confirm', false);
        this.toggleButton('transcript-import-another', false);
        this.toggleButton('transcript-done', false);
        this.emit('transcript-import:file-selected', {
            file,
            fileName: file.name,
            level: this.level(),
            source: this._source,
        });
    },

    async analyze() {
        if (!this._file) return;
        const requestId = ++this._requestId;
        const input = {
            file: this._file,
            level: this.level(),
            source: this._source,
            requestId,
            onProgress: progress => this.setProgress(progress),
            onReview: result => this.setReview(result),
            onError: error => this.setError(error?.message || error),
        };

        this.setProgress({ percent: 0, message: 'Reading transcript' });
        this.toggleButton('transcript-analyze', true, { disabled: true });
        const event = new CustomEvent('transcript-import:selected', {
            cancelable: true,
            detail: input,
        });
        const eventUnhandled = document.dispatchEvent(event);

        if (!this._processor) {
            if (eventUnhandled) {
                this.setError('Transcript extraction is not connected yet. Please try again after the page finishes loading.');
            }
            return;
        }

        try {
            const result = await this._processor(input);
            if (requestId !== this._requestId) return;
            this.setReview(result);
        } catch (error) {
            if (requestId !== this._requestId) return;
            this.setError(error?.message || 'The PDF could not be processed.');
        }
    },

    setProgress(progress) {
        const value = typeof progress === 'number' ? progress : progress?.percent;
        const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
        const message = typeof progress === 'object' && progress?.message
            ? String(progress.message)
            : 'Reading transcript';
        this.hideStates();
        document.getElementById('transcript-processing-state').hidden = false;
        document.getElementById('transcript-progress-label').textContent = message;
        document.getElementById('transcript-progress-value').textContent = `${percent}%`;
        document.getElementById('transcript-progress-fill').style.width = `${percent}%`;
        const track = this.dialog.querySelector('.transcript-progress-track');
        track.setAttribute('aria-valuenow', String(percent));
        this.emit('transcript-import:progress', { percent, message, source: this._source });
    },

    setReview(result) {
        if (!result || typeof result !== 'object') {
            this.setError('No coursework could be read from this PDF.');
            return;
        }
        this._result = result;
        this.hideStates();
        document.getElementById('transcript-review-state').hidden = false;
        this.renderReview(result);
        this.toggleButton('transcript-analyze', false);
        this.toggleButton('transcript-confirm', true, { disabled: false });
        this.emit('transcript-import:review', {
            result,
            summary: this.summarizeResult(result),
            level: this.level(),
            source: this._source,
        });
    },

    setError(message) {
        this.hideStates();
        document.getElementById('transcript-error-state').hidden = false;
        document.getElementById('transcript-error-message').textContent = String(message || 'The PDF could not be processed.');
        this.toggleButton('transcript-analyze', true, { disabled: !this._file });
        this.toggleButton('transcript-confirm', false);
        this.emit('transcript-import:error', { message: String(message || ''), source: this._source });
    },

    async confirm() {
        if (!this._result) return;
        const detail = {
            result: this._result,
            mode: this.importMode(),
            level: this.level(),
            source: this._source,
            fileName: this._file?.name || '',
        };
        const event = new CustomEvent('transcript-import:confirmed', { cancelable: true, detail });
        const eventUnhandled = document.dispatchEvent(event);
        this.toggleButton('transcript-confirm', true, { disabled: true });

        try {
            let applied = null;
            if (this._applyHandler) {
                applied = await this._applyHandler(detail);
            } else if (eventUnhandled) {
                throw new Error('Transcript import is not connected yet.');
            }
            this._undoHandler = typeof applied?.undo === 'function' ? applied.undo : null;
            this.hideStates();
            document.getElementById('transcript-complete-state').hidden = false;
            if (applied?.message) {
                document.getElementById('transcript-complete-message').textContent = applied.message;
            }
            this.toggleButton('transcript-confirm', false);
            this.toggleButton('transcript-undo', Boolean(this._undoHandler));
            this.toggleButton('transcript-import-another', true);
            this.toggleButton('transcript-done', true);
            this.emit('transcript-import:applied', detail);
            this._file = null;
            this._result = null;
            this.fileInput.value = '';
        } catch (error) {
            this.setError(error?.message || 'The reviewed coursework could not be added.');
        }
    },

    async undo() {
        if (!this._undoHandler) return;
        const undo = this._undoHandler;
        this.toggleButton('transcript-undo', true, { disabled: true });
        try {
            await undo();
            this._undoHandler = null;
            document.getElementById('transcript-complete-state').hidden = false;
            document.getElementById('transcript-complete-state').querySelector('strong').textContent = 'Transcript import undone';
            document.getElementById('transcript-complete-message').textContent = 'Your previous coursework has been restored.';
            this.toggleButton('transcript-undo', false);
            this.emit('transcript-import:undone', { source: this._source });
        } catch (error) {
            this.setError(error?.message || 'The transcript import could not be undone.');
        }
    },

    importAnotherLevel() {
        const nextLevel = this.level() === 'UG' ? 'GR' : 'UG';
        this.reset();
        const radio = this.dialog.querySelector(`input[name="transcript-level"][value="${nextLevel}"]`);
        if (radio) radio.checked = true;
        this.fileInput.focus();
    },

    summarizeResult(result) {
        const courses = Array.isArray(result?.attempts)
            ? result.attempts
            : Array.isArray(result?.courses)
                ? result.courses
                : Array.isArray(result?.records) ? result.records : [];
        const summary = { completed: 0, inProgress: 0, transfer: 0, needsReview: 0, total: courses.length };
        courses.forEach(course => {
            const status = String(course.status || '').toLowerCase().replace(/[_-]/g, ' ');
            const source = String(course.source || '').toLowerCase();
            if (source === 'transfer' || status === 'transfer') {
                summary.transfer += 1;
            } else if (course.needs_review || (Number.isFinite(course.confidence) && course.confidence < 0.8)) {
                summary.needsReview += 1;
            } else if (status === 'in progress' || status === 'current') {
                summary.inProgress += 1;
            } else if (course.counts_as_completed === true || status === 'completed') {
                summary.completed += 1;
            } else {
                summary.needsReview += 1;
            }
        });
        return summary;
    },

    renderReview(result) {
        const summary = this.summarizeResult(result);
        document.getElementById('transcript-review-total').textContent = `${summary.total} ${summary.total === 1 ? 'course record' : 'course records'} found`;
        const groups = [
            ['Completed', summary.completed, 'completed'],
            ['In progress', summary.inProgress, 'progress'],
            ['Transfer credit', summary.transfer, 'transfer'],
            ['Other / review', summary.needsReview, 'review'],
        ];
        const summaryNode = document.getElementById('transcript-review-summary');
        summaryNode.replaceChildren(...groups.map(([label, count, kind]) => {
            const card = document.createElement('div');
            card.className = `transcript-review-count ${kind}`;
            const value = document.createElement('strong');
            value.textContent = String(count || 0);
            const name = document.createElement('span');
            name.textContent = label;
            card.append(value, name);
            return card;
        }));

        const courses = Array.isArray(result.attempts)
            ? result.attempts
            : Array.isArray(result.courses)
                ? result.courses
                : Array.isArray(result.records) ? result.records : [];
        const preview = document.getElementById('transcript-review-preview');
        preview.replaceChildren();
        if (!courses.length) {
            const empty = document.createElement('p');
            empty.textContent = 'No course records were returned for review.';
            preview.appendChild(empty);
            return;
        }
        const heading = document.createElement('strong');
        heading.textContent = 'Sample of extracted records';
        const list = document.createElement('ul');
        courses.slice(0, 8).forEach(course => {
            const item = document.createElement('li');
            const code = course.code || course.course || [course.subject, course.number].filter(Boolean).join(' ');
            const term = course.term || course.semester || '';
            const grade = course.grade || (String(course.status || '').toLowerCase().includes('progress') ? 'In progress' : '');
            item.textContent = [code || 'Course needs review', term, grade].filter(Boolean).join(' · ');
            list.appendChild(item);
        });
        preview.append(heading, list);
        if (courses.length > 8) {
            const remaining = document.createElement('p');
            remaining.textContent = `${courses.length - 8} more records will be included in the full review.`;
            preview.appendChild(remaining);
        }
    },

    hideStates() {
        if (!this.dialog) return;
        ['transcript-processing-state', 'transcript-error-state', 'transcript-review-state', 'transcript-complete-state']
            .forEach(id => { document.getElementById(id).hidden = true; });
    },

    toggleButton(id, visible, { disabled = false } = {}) {
        const button = document.getElementById(id);
        if (!button) return;
        button.hidden = !visible;
        button.disabled = disabled;
    },

    setFileLabel(message) {
        const element = document.getElementById('transcript-file-name');
        if (element) element.textContent = message;
    },

    formatBytes(bytes) {
        const size = Number(bytes || 0);
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    },

    trapFocus(event) {
        const focusable = [...this.dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
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
    },

    emit(name, detail) {
        if (typeof document === 'undefined') return;
        document.dispatchEvent(new CustomEvent(name, { detail }));
    },
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = TranscriptUploadDialog;
}

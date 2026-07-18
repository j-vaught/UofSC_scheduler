(function initAdvisingTranscriptPdf(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.AdvisingTranscriptPdf = api;
}(typeof globalThis === 'object' ? globalThis : self, root => {
    'use strict';

    const PDFJS_VERSION = '6.1.200';
    const PDFJS_MODULE_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
    const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
    const MAX_PDF_BYTES = 25 * 1024 * 1024;
    let pdfJsPromise = null;

    class TranscriptPdfError extends Error {
        constructor(message, code, cause = null) {
            super(message);
            this.name = 'TranscriptPdfError';
            this.code = code;
            this.cause = cause;
        }
    }

    function getParser(options = {}) {
        const parser = options.parser || root.TranscriptParserRuntime;
        if (!parser?.parseAdvisingTranscriptItems) {
            throw new TranscriptPdfError(
                'The advising-transcript parser is unavailable.',
                'PARSER_UNAVAILABLE',
            );
        }
        return parser;
    }

    async function loadPdfJs(options = {}) {
        if (options.pdfjsLib?.getDocument) return options.pdfjsLib;
        if (root.pdfjsLib?.getDocument) return root.pdfjsLib;
        if (!pdfJsPromise) {
            const moduleUrl = options.moduleUrl || PDFJS_MODULE_URL;
            pdfJsPromise = import(moduleUrl).catch(error => {
                pdfJsPromise = null;
                throw new TranscriptPdfError(
                    'The PDF reader could not be loaded. Check your connection and try again.',
                    'PDF_READER_LOAD_FAILED',
                    error,
                );
            });
        }
        return pdfJsPromise;
    }

    async function readArrayBuffer(input) {
        if (input instanceof ArrayBuffer) return input.slice(0);
        if (ArrayBuffer.isView(input)) {
            return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
        }
        if (input && typeof input.arrayBuffer === 'function') return input.arrayBuffer();
        throw new TranscriptPdfError('Choose a PDF file to import.', 'INVALID_PDF_INPUT');
    }

    function validateFile(input, arrayBuffer) {
        const size = Number(input?.size ?? arrayBuffer.byteLength);
        if (!Number.isFinite(size) || size <= 0) {
            throw new TranscriptPdfError('The selected PDF is empty.', 'EMPTY_PDF');
        }
        if (size > MAX_PDF_BYTES) {
            throw new TranscriptPdfError(
                'The selected PDF is larger than 25 MB.',
                'PDF_TOO_LARGE',
            );
        }
        const type = String(input?.type || '').toLowerCase();
        const name = String(input?.name || '').toLowerCase();
        if (type && type !== 'application/pdf' && !name.endsWith('.pdf')) {
            throw new TranscriptPdfError('Choose a PDF file.', 'NOT_A_PDF');
        }
        const signature = new Uint8Array(arrayBuffer, 0, Math.min(5, arrayBuffer.byteLength));
        const header = String.fromCharCode(...signature);
        if (header !== '%PDF-') {
            throw new TranscriptPdfError('The selected file is not a valid PDF.', 'NOT_A_PDF');
        }
    }

    function notify(onProgress, phase, completed, total) {
        if (typeof onProgress !== 'function') return;
        onProgress({
            phase,
            completed,
            total,
            percent: total > 0 ? Math.round((completed / total) * 100) : 0,
        });
    }

    async function extractTextItems(input, options = {}) {
        const arrayBuffer = await readArrayBuffer(input);
        validateFile(input, arrayBuffer);
        const pdfjsLib = await loadPdfJs(options);
        if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = options.workerUrl || PDFJS_WORKER_URL;
        }

        let loadingTask;
        let document;
        try {
            notify(options.onProgress, 'opening', 0, 1);
            loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(arrayBuffer),
                isEvalSupported: false,
                useSystemFonts: true,
                password: options.password,
            });
            document = await loadingTask.promise;
            notify(options.onProgress, 'opening', 1, 1);

            const pages = [];
            for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
                const page = await document.getPage(pageNumber);
                const content = await page.getTextContent({
                    disableNormalization: false,
                    includeMarkedContent: false,
                });
                pages.push({
                    page: pageNumber,
                    items: (content.items || [])
                        .filter(item => typeof item?.str === 'string')
                        .map(item => ({
                            str: item.str,
                            transform: Array.isArray(item.transform) ? item.transform.slice(0, 6) : null,
                            width: Number(item.width || 0),
                            height: Number(item.height || 0),
                            hasEOL: Boolean(item.hasEOL),
                        })),
                });
                if (typeof page.cleanup === 'function') page.cleanup();
                notify(options.onProgress, 'extracting', pageNumber, document.numPages);
            }
            return { pages, pageCount: document.numPages };
        } catch (error) {
            if (error instanceof TranscriptPdfError) throw error;
            if (error?.name === 'PasswordException') {
                throw new TranscriptPdfError(
                    'This PDF is password protected. Download an unlocked advising transcript and try again.',
                    'PASSWORD_PROTECTED_PDF',
                    error,
                );
            }
            if (error?.name === 'InvalidPDFException' || error?.name === 'MissingPDFException') {
                throw new TranscriptPdfError(
                    'The selected PDF could not be read.',
                    'INVALID_PDF',
                    error,
                );
            }
            throw new TranscriptPdfError(
                'The advising transcript could not be read.',
                'PDF_EXTRACTION_FAILED',
                error,
            );
        } finally {
            if (document && typeof document.destroy === 'function') await document.destroy();
            else if (loadingTask && typeof loadingTask.destroy === 'function') await loadingTask.destroy();
        }
    }

    async function parse(input, options = {}) {
        const parser = getParser(options);
        const extracted = await extractTextItems(input, options);
        notify(options.onProgress, 'parsing', 0, 1);
        const result = parser.parseAdvisingTranscriptItems(extracted.pages, {
            pageCount: extracted.pageCount,
            level: options.level,
        });
        notify(options.onProgress, 'parsing', 1, 1);
        return result;
    }

    return Object.freeze({
        PDFJS_VERSION,
        PDFJS_MODULE_URL,
        PDFJS_WORKER_URL,
        MAX_PDF_BYTES,
        TranscriptPdfError,
        loadPdfJs,
        extractTextItems,
        parse,
    });
}));

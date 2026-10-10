/** Lazy historical decode workers with two logical cores reserved for the UI. */
function createHistoryTaskProcessor(task, dependencies) {
    if (!(task?.bytes instanceof Uint8Array)) throw new TypeError('History task bytes must be a Uint8Array');
    if (task.kind === 'hex-assemble') {
        if (!Array.isArray(task.parts) || task.parts.some(part => !(part instanceof Uint8Array)))
            throw new TypeError('Historical Hex parts must be Uint8Arrays');
        const length = task.parts.reduce((total, part) => total + part.length, 0);
        if (!Number.isSafeInteger(length)) throw new RangeError('Historical Hex batch is too large');
        const bytes = new Uint8Array(length);
        let partIndex = 0, partOffset = 0, offset = 0;
        return {
            step(byteBudget) {
                let remaining = Math.max(1, byteBudget);
                while (partIndex < task.parts.length) {
                    const part = task.parts[partIndex];
                    const end = Math.min(part.length, partOffset + remaining);
                    bytes.set(part.subarray(partOffset, end), offset);
                    const count = end - partOffset;
                    offset += count; remaining -= count; partOffset = end;
                    if (partOffset === part.length) { partIndex++; partOffset = 0; }
                    if (remaining <= 0) break;
                }
                return partIndex === task.parts.length;
            },
            result() { return bytes; }
        };
    }
    if (task.kind === 'numeric') {
        const { frameLength, headerLength, channels, type } = task;
        const width = Object.hasOwn(dependencies.TYPE_LENGTH, type) ? dependencies.TYPE_LENGTH[type] : 0;
        if (!width || !Number.isSafeInteger(frameLength) || frameLength < 1 ||
            !Number.isSafeInteger(headerLength) || headerLength < 0 ||
            !Number.isSafeInteger(channels) || channels < 1 ||
            headerLength + channels * width > frameLength || task.bytes.length % frameLength !== 0)
            throw new RangeError('Invalid historical numeric frame layout');
        const frameCount = task.bytes.length / frameLength;
        const values = new Float64Array(frameCount * channels);
        let frame = 0;
        return {
            step(byteBudget) {
                const end = Math.min(frameCount, frame + Math.max(1, Math.floor(byteBudget / frameLength)));
                for (; frame < end; frame++) {
                    const view = new DataView(task.bytes.buffer,
                        task.bytes.byteOffset + frame * frameLength + headerLength, channels * width);
                    dependencies.decodeNumericPayload(view, type, task.littleEndian, channels, values, frame * channels);
                }
                return frame === frameCount;
            },
            result() { return values; }
        };
    }
    if (task.kind === 'text-prepare') {
        const before = task.before ?? [], following = task.streamEnded ? [] : task.following ?? [];
        if (!Number.isSafeInteger(task.frame) || task.frame < 0 ||
            !Number.isSafeInteger(task.columns) || task.columns < 1 ||
            !Array.isArray(before) || !Array.isArray(following) ||
            [...before, ...following].some(part => !(part?.bytes instanceof Uint8Array) ||
                !Number.isSafeInteger(part.frame) || part.frame < 0 ||
                !Number.isSafeInteger(part.start) || part.start < 0))
            throw new RangeError('Invalid historical text preparation context');
        const decoder = new dependencies.MappedTextDecoder(task.encoding, { byteOffset: task.byteOffset ?? 0 });
        const data = { chunks: [], length: 0, width: 0, initialLines: [0], layouts: new Map(),
            columns: task.columns, byteLength: task.bytes.length, byteOffset: task.rawByteOffset,
            nextOrders: [...(task.nextOrders ?? [])], streamEnded: task.streamEnded === true,
            displayOptions: task.displayOptions };
        const parts = [...before, { frame: task.frame, bytes: task.bytes, start: 0 }, ...following];
        const current = before.length;
        const consume = tokens => dependencies.appendCompactTokens(data,
            tokens.filter(token => token.startFrame === task.frame));
        let partIndex = 0, offset = 0, complete = false;
        return {
            step(byteBudget) {
                if (complete) return true;
                let remaining = byteBudget === Infinity ? Infinity : Math.max(1, Math.floor(byteBudget) || 1);
                while (partIndex < parts.length) {
                    const part = parts[partIndex];
                    if (offset === part.bytes.length) {
                        if (partIndex === current)
                            data.needsFollowing = decoder.pending.some(entry => entry.frame === task.frame);
                        partIndex++;
                        offset = 0;
                        continue;
                    }
                    if (remaining <= 0) return false;
                    if (partIndex === current && offset === 0)
                        data.initialPending = decoder.pending.map(entry => ({ ...entry }));
                    const end = Math.min(part.bytes.length, offset + Math.min(2048, remaining));
                    const tokens = decoder.write(part.bytes.subarray(offset, end), part.frame, part.start + offset);
                    if (partIndex >= current) consume(tokens);
                    remaining -= end - offset;
                    offset = end;
                }
                consume(decoder.flush());
                data.layouts.set(data.columns, Uint32Array.from(data.initialLines));
                delete data.initialLines;
                complete = true;
                return true;
            },
            result() { return data; }
        };
    }
    if (task.kind !== 'text-count') throw new RangeError('Unsupported history task');
    const counter = new dependencies.TextCharacterCounter(task.encoding, { byteOffset: task.byteOffset ?? 0 });
    if (task.pending != null) counter.decoder.pending = task.pending.map(entry => ({ ...entry }));
    if (typeof task.orphanByte === 'boolean') counter.decoder.orphanByte = task.orphanByte;
    let offset = 0;
    return {
        step(byteBudget) {
            const end = Math.min(task.bytes.length, offset + byteBudget);
            counter.write(task.bytes.subarray(offset, end), offset);
            offset = end;
            if (offset < task.bytes.length) return false;
            if (task.flush) counter.flush();
            return true;
        },
        result() {
            return { total: counter.total, failed: counter.failed,
                pending: counter.decoder.pending.map(entry => ({ ...entry })),
                orphanByte: counter.decoder.orphanByte };
        }
    };
}

function historyWorkerDependencies() {
    const codec = typeof module !== 'undefined' ? require('./textCodec') : globalThis.SerialPlotter.TextCodec;
    const numeric = typeof module !== 'undefined' ? require('./numericCodec') : globalThis.SerialPlotter.NumericCodec;
    const parser = typeof module !== 'undefined' ? require('./dataParser').DataParser : globalThis.SerialPlotter.DataParser;
    const layout = typeof module !== 'undefined' ? require('./monitorView').MonitorTextLayout
        : globalThis.SerialPlotter.MonitorTextLayout;
    return { ...codec, ...numeric, ...layout, TYPE_LENGTH: parser.TYPE_LENGTH };
}

/** Self-contained classic worker source; no network requests are needed for file:// use. */
function buildHistoryWorkerSource(dependencies = historyWorkerDependencies()) {
    const functions = ['normalizeTextEncoding', 'isFailedTextCharacter', 'visibleText', 'escapedText',
        'MappedTextDecoder', 'TextCharacterCounter', 'textCells', 'appendCompactTokens'];
    const display = typeof module !== 'undefined' ? require('./monitorDisplay') : globalThis.SerialPlotter.MonitorDisplay;
    return `'use strict';\nconst TEXT_CHARSETS = ${JSON.stringify(dependencies.CHARSETS)};\n` +
        `const monitorDisplayUtils = { textTokenDisplay: ${display.textTokenDisplay.toString()} };\n` +
        `const HISTORY_TYPE_LENGTH = ${JSON.stringify(dependencies.TYPE_LENGTH)};\n` +
        dependencies.decodeNumericPayload.toString() + '\n' +
        functions.map(name => dependencies[name].toString()).join('\n') + '\n' +
        createHistoryTaskProcessor.toString() + `\nself.onmessage = ({ data }) => {
            try {
                const processor = createHistoryTaskProcessor(data.task,
                    { TextCharacterCounter, MappedTextDecoder, textCells, appendCompactTokens,
                        TYPE_LENGTH: HISTORY_TYPE_LENGTH, decodeNumericPayload });
                processor.step(Infinity);
                const result = processor.result();
                const transfer = ArrayBuffer.isView(result) ? [result.buffer] : [];
                if (result.chunks) {
                    for (const chunk of result.chunks) {
                        for (const key of ['offsets', 'cells', 'starts', 'ends', 'crosses', 'failed', 'breaks'])
                            transfer.push(chunk[key].buffer);
                    }
                    for (const lines of result.layouts.values()) transfer.push(lines.buffer);
                }
                self.postMessage({ id: data.id, result }, transfer);
            } catch (error) {
                self.postMessage({ id: data.id, error: { name: error.name, message: error.message } });
            }
        };\n`;
}

function historyAbortError() {
    const error = new Error('History worker pool disposed');
    error.name = 'AbortError';
    return error;
}

class HistoryWorkerPool {
    constructor(options = {}) {
        const cores = Object.hasOwn(options, 'hardwareConcurrency')
            ? options.hardwareConcurrency : globalThis.navigator?.hardwareConcurrency;
        this.maxWorkers = Number.isFinite(cores) && cores > 0 ? Math.max(0, Math.floor(cores) - 2) : 0;
        this.WorkerClass = Object.hasOwn(options, 'WorkerClass') ? options.WorkerClass : globalThis.Worker;
        this.workerFactory = options.workerFactory;
        this.available = this.maxWorkers > 0 && (typeof this.workerFactory === 'function' ||
            typeof this.WorkerClass === 'function' && typeof globalThis.Blob === 'function' &&
            typeof globalThis.URL?.createObjectURL === 'function');
        this.workers = [];
        this.peakWorkers = 0;
        this.queue = [];
        this.jobs = new Set();
        this.nextId = 1;
        this.disposed = false;
        this.fallbackJob = null;
        this.schedule = options.schedule ?? (callback => setTimeout(callback, 0));
        this.cancelSchedule = options.cancelSchedule ?? (handle => clearTimeout(handle));
        this.fallbackTimer = null;
        this.sliceBytes = Number.isSafeInteger(options.sliceBytes) && options.sliceBytes > 0
            ? options.sliceBytes : 2048;
        this.workerSource = null;
        this.workerURL = null;
        this.pumping = false;
    }

    get workerCount() { return this.workers.length; }

    runTask(task) {
        if (this.disposed) return Promise.reject(historyAbortError());
        if (!(task?.bytes instanceof Uint8Array))
            return Promise.reject(new TypeError('History task bytes must be a Uint8Array'));
        if (task.kind === 'hex-assemble' && (!Array.isArray(task.parts) ||
            task.parts.some(part => !(part instanceof Uint8Array))))
            return Promise.reject(new TypeError('Historical Hex parts must be Uint8Arrays'));
        if (task.kind === 'text-prepare' && [task.before, task.following].some(parts => parts != null &&
            (!Array.isArray(parts) || parts.some(part => !(part?.bytes instanceof Uint8Array)))))
            return Promise.reject(new TypeError('History text context bytes must be Uint8Arrays'));
        return new Promise((resolve, reject) => {
            const job = { id: this.nextId++, task, resolve, reject, settled: false };
            this.jobs.add(job);
            this.queue.push(job);
            this._pump();
        });
    }

    _settle(job, error, result) {
        if (job.settled) return;
        job.settled = true;
        this.jobs.delete(job);
        job.task = null;
        if (error) job.reject(error);
        else job.resolve(result);
    }

    _pump() {
        if (this.disposed || this.pumping) return;
        this.pumping = true;
        try {
            while (this.queue.length && !this.disposed) {
                if (!this.available) {
                    if (!this.fallbackJob) this._startFallback(this.queue.shift());
                    break;
                }
                let slot = this.workers.find(worker => !worker.job);
                if (!slot && this.workers.length < this.maxWorkers) {
                    try { slot = this._createWorker(); }
                    catch { this._failWorkers(); continue; }
                }
                if (!slot) break;
                const job = this.queue.shift();
                slot.job = job;
                try {
                    const bytes = new Uint8Array(job.task.bytes);
                    const task = { ...job.task, bytes }, transfer = [bytes.buffer];
                    if (task.kind === 'hex-assemble') {
                        task.parts = task.parts.map(part => {
                            const copy = new Uint8Array(part);
                            transfer.push(copy.buffer);
                            return copy;
                        });
                    }
                    if (task.kind === 'text-prepare') {
                        for (const key of ['before', 'following']) {
                            task[key] = (task[key] ?? []).map(part => {
                                const copy = new Uint8Array(part.bytes);
                                transfer.push(copy.buffer);
                                return { ...part, bytes: copy };
                            });
                        }
                    }
                    slot.worker.postMessage({ id: job.id, task }, transfer);
                } catch { this._failWorkers(); }
            }
        } finally { this.pumping = false; }
    }

    _createWorker() {
        this.workerSource ??= buildHistoryWorkerSource();
        let worker;
        if (this.workerFactory) worker = this.workerFactory(this.workerSource);
        else {
            this.workerURL ??= URL.createObjectURL(new Blob([this.workerSource], { type: 'text/javascript' }));
            worker = new this.WorkerClass(this.workerURL);
        }
        const slot = { worker, job: null, closed: false };
        worker.onmessage = event => {
            if (slot.closed || this.disposed) return;
            const data = event.data;
            const job = slot.job;
            if (!job || data?.id !== job.id) return;
            if (!Object.hasOwn(data, 'error') && !Object.hasOwn(data, 'result')) {
                this._failWorkers();
                return;
            }
            slot.job = null;
            if (data.error) {
                const error = new Error(data.error.message);
                error.name = data.error.name || 'Error';
                this._settle(job, error);
            } else this._settle(job, null, data.result);
            this._pump();
        };
        worker.onerror = event => {
            event?.preventDefault?.();
            if (!slot.closed && !this.disposed) this._failWorkers();
        };
        worker.onmessageerror = () => {
            if (!slot.closed && !this.disposed) this._failWorkers();
        };
        this.workers.push(slot);
        this.peakWorkers = Math.max(this.peakWorkers, this.workers.length);
        return slot;
    }

    _closeWorkers() {
        for (const slot of this.workers) {
            slot.closed = true;
            slot.worker.onmessage = null;
            slot.worker.onerror = null;
            slot.worker.onmessageerror = null;
            try {
                const completion = slot.worker.terminate();
                completion?.catch?.(() => {});
            } catch { /* Cleanup must continue even if one worker already exited. */ }
        }
        this.workers.length = 0;
        if (this.workerURL) URL.revokeObjectURL(this.workerURL);
        this.workerURL = null;
        this.workerSource = null;
    }

    _failWorkers() {
        this.available = false;
        const active = this.workers.map(slot => slot.job).filter(job => job && !job.settled);
        this.queue = active.concat(this.queue).sort((left, right) => left.id - right.id);
        this._closeWorkers();
        this._pump();
    }

    _startFallback(job) {
        this.fallbackJob = job;
        let processor;
        const advance = () => {
            this.fallbackTimer = null;
            if (this.disposed || job.settled) return;
            try {
                processor ??= createHistoryTaskProcessor(job.task, historyWorkerDependencies());
                if (!processor.step(this.sliceBytes)) {
                    this.fallbackTimer = this.schedule(advance);
                    return;
                }
                this._settle(job, null, processor.result());
            } catch (error) {
                this._settle(job, error);
            }
            this.fallbackJob = null;
            this._pump();
        };
        this.fallbackTimer = this.schedule(advance);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.available = false;
        if (this.fallbackTimer != null) {
            try { this.cancelSchedule(this.fallbackTimer); }
            catch { /* Worker and promise cleanup must finish if a custom scheduler fails. */ }
        }
        this.fallbackTimer = null;
        for (const job of this.jobs) this._settle(job, historyAbortError());
        this.queue.length = 0;
        this.fallbackJob = null;
        this._closeWorkers();
    }
}

if (typeof module !== 'undefined') module.exports = {
    HistoryWorkerPool, createHistoryTaskProcessor, buildHistoryWorkerSource
};
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.HistoryWorkerPool = HistoryWorkerPool;

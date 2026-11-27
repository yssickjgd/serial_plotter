/** Lazy historical decode workers with two logical cores reserved for the UI.
 * protocol-decode tasks take {schema,records:[{bytes}|Uint8Array],maxDecodedFields?}
 * and return decoded records in input order, retaining exact64 BigInts and spans.
 * Batches are bounded to 256 frames, 4 MiB input and 65536 output fields (a lower
 * maxDecodedFields is allowed). protocol-batch-limit errors permit split retries;
 * protocol-record-limit identifies one frame exceeding the caller's field budget.
 */
const protocolStreamProgressBytes = 16384;
const waveletCopySliceBytes = 4 * 1048576;
const waveletParallelBatchBytes = 32 * 1048576;
const waveletExpandedFftScratchBytes = 32 * 1048576;
const waveletRowArrays = ['frequencies', 'magnitude', 'phase', 'sign', 'reference', 'blockMin', 'blockMax'];

function* waveletRowBatches(grid, lanes, maxRows, inverseStride) {
    const { rows, frequencyScale, minHz, maxHz, octaves } = grid;
    if (inverseStride < 8 || rows > lanes * maxRows) {
        const batchRows = Math.min(Math.ceil(rows / lanes), maxRows);
        for (let rowStart = 0; rowStart < rows; rowStart += batchRows)
            yield { rowStart, rowEnd: Math.min(rows, rowStart + batchRows) };
        return;
    }
    // With the inverse FFT folded, the wider filters at high frequencies take a larger share of each row's work.
    const lowest = minHz / maxHz, filterCost = Math.log2(inverseStride);
    const costs = Float64Array.from({ length: rows }, (_, i) => {
        const fraction = i / (rows - 1);
        const frequency = frequencyScale === 'linear' ? lowest + fraction * (1 - lowest) : lowest * 2 ** (fraction * octaves);
        return 1 + filterCost * frequency;
    });
    let rowStart = 0, remainingCost = costs.reduce((total, cost) => total + cost, 0);
    for (let remaining = lanes; remaining > 1; remaining--) {
        const minimum = Math.max(rowStart + 1, rows - (remaining - 1) * maxRows);
        const maximum = Math.min(rowStart + maxRows, rows - remaining + 1);
        const target = remainingCost / remaining;
        let rowEnd = rowStart, cost = 0;
        while (rowEnd < maximum && (rowEnd < minimum || cost < target)) cost += costs[rowEnd++];
        yield { rowStart, rowEnd };
        remainingCost -= cost;
        rowStart = rowEnd;
    }
    yield { rowStart, rowEnd: rows };
}

function validateProtocolHistoryTask(task) {
    if (!task.schema || typeof task.schema !== 'object' || Array.isArray(task.schema))
        throw new TypeError('Protocol history task requires a schema');
    if (!Array.isArray(task.records) || task.records.length > 256)
        throw new RangeError('Protocol decode batch must contain at most 256 records');
    if (task.maxDecodedFields !== undefined && (!Number.isInteger(task.maxDecodedFields) ||
        task.maxDecodedFields < 1 || task.maxDecodedFields > 65536))
        throw new RangeError('Protocol decoded field budget must be between 1 and 65536');
    let byteLength = 0;
    for (const record of task.records) {
        const bytes = record instanceof Uint8Array ? record : record?.bytes;
        if (!(bytes instanceof Uint8Array)) throw new TypeError('Protocol history record bytes must be a Uint8Array');
        byteLength += bytes.length;
        if (byteLength > 4194304) throw new RangeError('Protocol decode batch exceeds the 4 MiB byte limit');
    }
}
function createHistoryTaskProcessor(task, dependencies) {
    if (task?.kind === 'monitor-search') return dependencies.createMonitorSearchProcessor(task, dependencies.Protocol);
    if (task?.kind === 'hex-export' || task?.kind === 'csv-export') {
        const csv = task.kind === 'csv-export', lines = [];
        const length = csv ? task.rows : task.records.length;
        const width = task.channelSettings?.length;
        let position = 0;
        return {
            step(budget) {
                let remaining = budget;
                while (position < length && remaining > 0) {
                    const row = position++;
                    if (csv) {
                        lines.push(dependencies.formatCsvExportRow(task.start + row, task.times?.[row], task.channelSettings,
                            channel => task.values[row * width + channel]));
                        remaining -= width * 8;
                    } else {
                        const { bytes, prefix } = task.records[row];
                        lines.push(dependencies.formatHexExportRecord(bytes, prefix));
                        remaining -= Math.max(1, bytes.length);
                    }
                }
                return position === length;
            },
            result() { return lines.join(''); }
        };
    }
    if (task?.kind === 'time-scan') {
        const { values, target, start } = task;
        const scan = { minimum: Infinity, maximum: -Infinity, distance: Infinity, nearest: -1 };
        let offset = 0;
        return {
            step(budget) {
                const end = Math.min(values.length, offset + Math.max(1, Math.floor(budget / 8)));
                dependencies.scanTimestampRange(index => values[index - start], target, start + offset, start + end, scan);
                offset = end;
                return offset === values.length;
            },
            result() { return scan; }
        };
    }
    if (task?.kind === 'protocol-stream-check') {
        if (!task.schema || typeof task.schema !== 'object' || Array.isArray(task.schema) ||
            !(task.bytes instanceof Uint8Array) || task.bytes.length > 1048576)
            throw new TypeError('Protocol stream checks require a schema and at most 1 MiB of bytes');
        const chunkSize = task.chunkSize ?? 2048;
        if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 16384)
            throw new RangeError('Protocol stream chunk size must be between 1 and 16384');
        const parser = new dependencies.Protocol.StreamParser(task.schema);
        let offset = 0, frames = 0, errors = 0, invalidFrames = 0;
        parser.onFrameParsed = record => { frames++; if (record.valid === false) { errors++; invalidFrames++; } };
        parser.onFrameError = () => { errors++; };
        return {
            get processedBytes() { return offset; },
            step(byteBudget) {
                let remaining = byteBudget === Infinity ? Infinity : Math.max(1, Math.floor(byteBudget) || 1);
                while (offset < task.bytes.length && remaining > 0) {
                    const end = Math.min(task.bytes.length, offset + Math.min(chunkSize, remaining));
                    parser.appendData(task.bytes.subarray(offset, end), { byteOffset: offset, timestamp: 0 });
                    remaining -= end - offset; offset = end;
                }
                return offset === task.bytes.length;
            },
            result() { return { frames, errors, invalidFrames, pending: parser.length }; }
        };
    }
    if (task?.kind === 'protocol-decode') {
        validateProtocolHistoryTask(task);
        const compiled = dependencies.Protocol.compile(task.schema), records = [];
        let index = 0, decodedFields = 0;
        const fieldBudget = task.maxDecodedFields ?? 65536;
        const limitError = (code, message) => { const error = new RangeError(message); error.code = code; return error; };
        return {
            step(byteBudget) {
                let remaining = byteBudget === Infinity ? Infinity : Math.max(1, Math.floor(byteBudget) || 1);
                while (index < task.records.length) {
                    const source = task.records[index], bytes = source instanceof Uint8Array ? source : source.bytes;
                    let record;
                    try { record = dependencies.Protocol.decode(bytes, compiled, { maxFields: Math.min(fieldBudget, 32768) }); }
                    catch (error) {
                        if (error.code === 'field-limit') throw limitError('protocol-record-limit', 'Protocol record exceeds its decoded field budget');
                        throw error;
                    }
                    decodedFields += record.flatFields.length;
                    if (decodedFields > fieldBudget) throw limitError('protocol-batch-limit', 'Protocol batch exceeds its decoded field budget; split this batch');
                    records.push(record); index++; remaining -= Math.max(1, bytes.length);
                    if (remaining <= 0) break;
                }
                return index === task.records.length;
            },
            result() { return records; }
        };
    }
    if (task?.kind === 'fft') {
        if (!(task.values instanceof Float64Array))
            throw new TypeError('FFT values must be a Float64Array');
        let result;
        return {
            step() {
                const spectrum = dependencies.prepareFrequencySeries(task.values,
                    task.removeDc === true, task.windowType);
                result = { ...spectrum, mags: Float64Array.from(spectrum.mags),
                    phases: Float64Array.from(spectrum.phases ?? []),
                    logMags: Float64Array.from(spectrum.mags,
                        value => value > 0 && Number.isFinite(value) ? Math.log10(value) : NaN),
                    unwrappedPhases: Float64Array.from(dependencies.unwrapPhaseDegrees(spectrum.phases ?? [])) };
                return true;
            },
            result() { return result; }
        };
    }
    if (task?.kind === 'wavelet') return dependencies.createWaveletProcessor(task, task.waveletRows);
    if (task?.kind === 'pairSpectrum') {
        let result;
        return {
            step() {
                result = dependencies.pairSpectrum(task.segments, task.options);
                return true;
            },
            result() { return result; }
        };
    }
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
    const spectrum = typeof module !== 'undefined' ? require('./spectrum') : globalThis.SerialPlotter;
    const pairs = typeof module !== 'undefined' ? require('./pairSpectrum') : globalThis.SerialPlotter;
    const wavelet = typeof module !== 'undefined' ? require('./wavelet') : globalThis.SerialPlotter;
    const phase = typeof module !== 'undefined' ? require('./systemResponse') : globalThis.SerialPlotter;
    const Protocol = typeof module !== 'undefined' ? require('./protocolEngine').Protocol : globalThis.SerialPlotter.Protocol;
    const search = typeof module !== 'undefined' ? require('./monitorSearch') : globalThis.SerialPlotter.MonitorSearch;
    const records = typeof module !== 'undefined' ? require('./protocolRecords') : globalThis.SerialPlotter;
    const channels = typeof module !== 'undefined' ? require('./channelTransform') : globalThis.SerialPlotter;
    const csv = typeof module !== 'undefined' ? require('./csvExport') : globalThis.SerialPlotter;
    const hex = typeof module !== 'undefined' ? require('./captureExport') : globalThis.SerialPlotter;
    const bytes = typeof module !== 'undefined' ? require('./byteUtils') : globalThis.SerialPlotter;
    const { formatDisplayNumber } = typeof module !== 'undefined' ? require('./plotMath') : globalThis.SerialPlotter;
    return { ...codec, ...numeric, ...layout, ...spectrum, unwrapPhaseDegrees: phase.unwrapPhaseDegrees,
        pairSpectrum: pairs.pairSpectrum, createPairSpectrumSource: pairs.createPairSpectrumSource,
        createWaveletProcessor: wavelet.createWaveletProcessor, createWaveletSource: wavelet.createWaveletSource,
        formatCsvExportRow: csv.formatCsvExportRow, formatHexExportRecord: hex.formatHexExportRecord, ByteUtils: bytes.ByteUtils,
        TYPE_LENGTH: parser.TYPE_LENGTH, Protocol, search, records, formatDisplayNumber, searchTransform: channels.transformChannelValue,
        createMonitorSearchProcessor: search.createMonitorSearchProcessor, scanTimestampRange: search.scanTimestampRange };
}

/** Self-contained classic worker source; no network requests are needed for file:// use. */
function buildHistoryWorkerSource(dependencies = historyWorkerDependencies()) {
    const functions = ['normalizeTextEncoding', 'isFailedTextCharacter', 'visibleText', 'escapedText',
        'MappedTextDecoder', 'TextCharacterCounter', 'textCells', 'appendCompactTokens'];
    const display = typeof module !== 'undefined' ? require('./monitorDisplay') : globalThis.SerialPlotter.MonitorDisplay;
    return `'use strict';\nconst TEXT_CHARSETS = ${JSON.stringify(dependencies.CHARSETS)};\n` +
        `const monitorDisplayUtils = { textTokenDisplay: ${display.textTokenDisplay.toString()} };\n` +
        `const HISTORY_TYPE_LENGTH = ${JSON.stringify(dependencies.TYPE_LENGTH)};\n` +
        `const FFT_WINDOWS = ${JSON.stringify(dependencies.FFT_WINDOWS)};\n` +
        ['nextPow2', 'fftInPlace', 'windowCoefficient', 'prepareFrequencySeries', 'unwrapPhaseDegrees']
            .map(name => dependencies[name].toString()).join('\n') + '\n' +
        `const pairSpectrum = ${dependencies.createPairSpectrumSource()};\n` +
        `const createWaveletProcessor = ${dependencies.createWaveletSource()};\n` +
        dependencies.decodeNumericPayload.toString() + '\n' +
        functions.map(name => dependencies[name].toString()).join('\n') + '\n' +
        `const Protocol = (${dependencies.Protocol.createFactorySource()})(globalThis,
            { normalizeTextEncoding, MappedTextDecoder, CHARSETS: TEXT_CHARSETS });\n` +
        'const searchTextUtils = { normalizeTextEncoding, MappedTextDecoder };\n' +
        'const searchTransform = ' + dependencies.searchTransform.toString() + ';\n' +
        'const transformForExport = searchTransform;\n' +
        'const captureExportBytes = {' + dependencies.ByteUtils.bytesToHex.toString() + '};\n' +
        dependencies.formatCsvExportRow.toString() + '\n' + dependencies.formatHexExportRecord.toString() + '\n' +
        'const protocolDisplayNumber = ' + dependencies.formatDisplayNumber.toString() + ';\n' +
        ['unwrapProtocolRecord', 'protocolJsonValue', 'protocolValueText', 'protocolDisplayValueText', 'protocolPathContains', 'protocolVisibleFields']
            .map(name => dependencies.records[name].toString()).join('\n') + '\n' +
        'const searchProtocolUtils = { unwrapProtocolRecord, protocolValueText, protocolDisplayValueText, protocolVisibleFields };\n' +
        ['parseMonitorSearch', 'parseProtocolFieldSearch', 'MonitorSearchSession', 'ProtocolFieldSearchSession', 'createMonitorSearchProcessor', 'scanTimestampRange']
            .map(name => dependencies.search[name].toString()).join('\n') + '\n' +
        validateProtocolHistoryTask.toString() + '\n' +
        createHistoryTaskProcessor.toString() + `\nself.onmessage = ({ data }) => {
            try {
                const processor = createHistoryTaskProcessor(data.task,
                    { TextCharacterCounter, MappedTextDecoder, textCells, appendCompactTokens,
                        TYPE_LENGTH: HISTORY_TYPE_LENGTH, decodeNumericPayload, prepareFrequencySeries, unwrapPhaseDegrees,
                        pairSpectrum, createWaveletProcessor,
                        Protocol, createMonitorSearchProcessor, scanTimestampRange, formatCsvExportRow, formatHexExportRecord });
                if (data.reportProgress) {
                    while (!processor.step(${protocolStreamProgressBytes}))
                        self.postMessage({ id: data.id, processedBytes: processor.processedBytes });
                } else processor.step(Infinity);
                const result = processor.result();
                const transfer = ArrayBuffer.isView(result) ? [result.buffer] : [];
                if (data.task.kind === 'fft') transfer.push(result.mags.buffer, result.phases.buffer,
                    result.logMags.buffer, result.unwrappedPhases.buffer);
                if (data.task.kind === 'pairSpectrum') {
                    transfer.push(result.phase.buffer, result.coherence.buffer);
                    if (result.gain) transfer.push(result.gain.buffer);
                }
                if (data.task.kind === 'wavelet') {
                    transfer.push(result.frequencies.buffer, result.magnitude.buffer, result.reference.buffer);
                    if (result.positions) transfer.push(result.positions.buffer);
                    if (result.phase) transfer.push(result.phase.buffer);
                    if (result.sign) transfer.push(result.sign.buffer);
                    if (result.blockMin) transfer.push(result.blockMin.buffer, result.blockMax.buffer);
                }
                if (data.task.kind === 'protocol-decode') {
                    const buffers = new Set(), seen = new Set();
                    const visit = value => {
                        if (!value || typeof value !== 'object' || seen.has(value)) return;
                        seen.add(value);
                        if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
                        else for (const item of Object.values(value)) visit(item);
                    };
                    visit(result); transfer.push(...buffers);
                }
                if (result.chunks) {
                    for (const chunk of result.chunks) {
                        for (const key of ['offsets', 'cells', 'starts', 'ends', 'crosses', 'failed', 'breaks'])
                            transfer.push(chunk[key].buffer);
                    }
                    for (const lines of result.layouts.values()) transfer.push(lines.buffer);
                }
                self.postMessage({ id: data.id, result }, transfer);
            } catch (error) {
                self.postMessage({ id: data.id, error: { name: error.name, message: error.message, code: error.code } });
            }
        };\n`;
}

function historyAbortError() {
    const error = new Error('History worker pool disposed');
    error.name = 'AbortError';
    return error;
}

function isLiveSpectrumTask(task) {
    return task.kind === 'fft' || task.kind === 'pairSpectrum' || task.kind === 'wavelet';
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
        this.fftSources = new WeakMap();
        this.fftCacheEntries = new Map(); this.fftCacheBytes = 0; this.fftCacheLimitBytes = 64 * 1048576;
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
        this.idleSchedule = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
        this.idleCancel = options.clearTimeout ?? (timer => clearTimeout(timer));
    }

    get workerCount() { return this.workers.length; }
    clearFftCache() {
        this.fftSources = new WeakMap(); this.fftCacheEntries.clear(); this.fftCacheBytes = 0;
    }
    _forgetFft(promise) {
        const entry = this.fftCacheEntries.get(promise);
        if (!entry) return;
        if (entry.cache.entries.get(entry.key) === promise) entry.cache.entries.delete(entry.key);
        this.fftCacheBytes -= entry.bytes; this.fftCacheEntries.delete(promise);
    }
    setFftCacheLimit(bytes) {
        this.fftCacheLimitBytes = bytes;
        for (const [promise, entry] of this.fftCacheEntries) {
            if (this.fftCacheBytes <= bytes) break;
            if (entry.bytes) this._forgetFft(promise);
        }
    }
    setWorkerLimit(limit) {
        this.workerLimit = Math.max(1, Math.min(this.maxWorkers, Math.floor(limit)));
        for (const slot of [...this.workers].reverse()) if (!slot.job && this.workers.length > this.workerLimit) {
            this._closeWorker(slot);
            this.workers = this.workers.filter(item => item !== slot);
        }
    }

    /** Share identical input snapshots before reading samples or dispatching workers. */
    requestFft(source, options, readValues) {
        if (this.disposed) return Promise.reject(historyAbortError());
        let cache = this.fftSources.get(source);
        if (!cache || cache.version !== source.version) {
            if (cache) for (const promise of cache.entries.values()) this._forgetFft(promise);
            cache = { version: source.version, entries: new Map() };
            this.fftSources.set(source, cache);
        }
        const key = JSON.stringify([options.channel, options.start, options.end,
            options.removeDc, options.windowType, options.gain, options.offset]);
        if (cache.entries.has(key)) return cache.entries.get(key);
        let promise;
        try {
            promise = this.runTask({ kind: 'fft', values: readValues(),
                removeDc: options.removeDc, windowType: options.windowType });
        } catch (error) { return Promise.reject(error); }
        cache.entries.set(key, promise);
        this.fftCacheEntries.set(promise, { cache, key, bytes: 0 });
        while (cache.entries.size > Math.max(32, source.channelCount * 4))
            this._forgetFft(cache.entries.values().next().value);
        promise.then(result => {
            const entry = this.fftCacheEntries.get(promise);
            if (!entry) return;
            for (const value of Object.values(result)) {
                if (ArrayBuffer.isView(value)) entry.bytes += value.byteLength;
                else if (Array.isArray(value)) entry.bytes += value.length * 8;
            }
            this.fftCacheBytes += entry.bytes; this.setFftCacheLimit(this.fftCacheLimitBytes);
        }, () => this._forgetFft(promise));
        return promise;
    }

    /** Consumer-visible results follow input order even when independent jobs finish out of order. */
    async *runOrderedTasks(tasks, { check = () => {} } = {}) {
        const jobs = [], abort = new AbortController();
        const limit = Math.max(1, this.workerLimit ?? this.maxWorkers);
        let started = performance.now();
        const take = async () => {
            const result = await jobs.shift();
            check();
            if (result.error) throw result.error;
            return result;
        };
        try {
            for (const task of tasks) {
                check();
                jobs.push(this.runTask(task, { signal: abort.signal }).then(result => ({ task, result }), error => ({ error })));
                if (jobs.length >= limit) yield await take();
                if (performance.now() - started >= 8) {
                    await new Promise(resolve => this.schedule(resolve));
                    started = performance.now();
                }
            }
            while (jobs.length) yield await take();
        } finally { abort.abort(); }
    }

    /** Stream checks can report intermediate byte offsets. The result means the full input was checked. */
    runTask(task, { onProgress, signal } = {}) {
        if (this.disposed || signal?.aborted) return Promise.reject(historyAbortError());
        if (['fft', 'time-scan', 'csv-export', 'wavelet'].includes(task?.kind) && !(task.values instanceof Float64Array))
            return Promise.reject(new TypeError(task.kind === 'fft' ? 'FFT values must be a Float64Array' : '历史采样必须是双精度浮点数数组'));
        if (task?.kind === 'pairSpectrum' && (!Array.isArray(task.segments) || task.segments.some(segment =>
            !(segment?.x instanceof Float64Array) || !(segment.y instanceof Float64Array) || segment.x.length !== segment.y.length)))
            return Promise.reject(new TypeError('双通道频谱的每个分段需要两个等长的双精度浮点数组'));
        if (task?.kind === 'protocol-decode') {
            try { validateProtocolHistoryTask(task); }
            catch (error) { return Promise.reject(error); }
        }
        if (!['fft', 'pairSpectrum', 'time-scan', 'csv-export', 'hex-export', 'protocol-decode', 'monitor-search', 'wavelet'].includes(task?.kind) &&
            !(task?.bytes instanceof Uint8Array))
            return Promise.reject(new TypeError('History task bytes must be a Uint8Array'));
        if (task.kind === 'hex-assemble' && (!Array.isArray(task.parts) ||
            task.parts.some(part => !(part instanceof Uint8Array))))
            return Promise.reject(new TypeError('Historical Hex parts must be Uint8Arrays'));
        if (task.kind === 'text-prepare' && [task.before, task.following].some(parts => parts != null &&
            (!Array.isArray(parts) || parts.some(part => !(part?.bytes instanceof Uint8Array)))))
            return Promise.reject(new TypeError('History text context bytes must be Uint8Arrays'));
        const options = { onProgress, signal };
        const parallel = task.kind === 'wavelet' && this._tryParallelWavelet(task, signal);
        return parallel || this._queueTask(task, options);
    }

    _tryParallelWavelet(task, signal) {
        if (!this.available || this.parallelWavelet) return;
        const active = this.workers.reduce((total, slot) => total + Number(Boolean(slot.job)), 0);
        const free = (this.workerLimit ?? this.maxWorkers) - active - this.queue.length;
        if (free < 2) return;
        const { waveletResolutionGrid, waveletContextSamples, maxWaveletGridBytes, maxWaveletWindowPoints } = typeof module !== 'undefined'
            ? require('./wavelet') : globalThis.SerialPlotter;
        if (task.values.length > 2 * maxWaveletWindowPoints) return;
        const { visibleLength = task.values.length } = task;
        let grid;
        try { grid = waveletResolutionGrid({ ...task, visibleLength }); }
        catch { return; } // The existing processor reports input errors through the task promise.
        const { rows, columns, bytes } = grid;
        // Irregular column spacing requires a full inverse FFT per row, even for a modest output grid.
        const inverseStride = Number.isInteger(grid.hop) && grid.fullColumns > 1 ? grid.hop & -grid.hop : 1;
        const inverseSamples = rows * task.values.length / inverseStride;
        if (rows < 64 || !columns || bytes > maxWaveletGridBytes ||
            (rows * columns < 262144 && inverseSamples < 262144 && rows * task.values.length < 2097152)) return;
        const denseGrid = bytes > 128 * 1048576;
        const largeInverse = rows >= 256 && inverseSamples >= 1500000;
        let lanes = Math.min(free, 4);
        if (denseGrid || largeInverse) {
            const { nextPow2 } = typeof module !== 'undefined' ? require('./spectrum') : globalThis.SerialPlotter;
            // Bound one worker's FFT workspace using the largest possible reflected run and fold alignment.
            const reflection = Math.min(task.values.length - 1, waveletContextSamples(visibleLength) + 1);
            const fftSize = nextPow2(2 * (task.values.length + 2 * reflection + inverseStride - 1));
            const scratch = 2 * Float64Array.BYTES_PER_ELEMENT * (fftSize + fftSize / inverseStride);
            // Keep capacity for incoming work when expanding the parallel transform.
            const expanded = Math.min(denseGrid ? 8 : 6, Math.max(2, free - 1),
                Math.floor(waveletExpandedFftScratchBytes / scratch));
            lanes = denseGrid ? expanded : Math.max(lanes, expanded);
            if (lanes < 2) return;
        }
        // Only the current batches duplicate coefficient storage.
        const rowBytes = (bytes - (grid.positions?.byteLength ?? 0)) / rows + Float64Array.BYTES_PER_ELEMENT;
        const maxRows = Math.max(1, Math.floor(waveletParallelBatchBytes / lanes / rowBytes));
        return this._runParallelWavelet(task, rows, lanes, waveletRowBatches(grid, lanes, maxRows, inverseStride), signal);
    }

    async _runParallelWavelet(task, rows, lanes, batches, signal) {
        this.parallelWavelet = true;
        const controller = new AbortController();
        const abort = () => controller.abort();
        const check = () => {
            if (this.disposed || controller.signal.aborted) throw historyAbortError();
        };
        signal?.addEventListener('abort', abort, { once: true });
        let output;
        const append = async (part, rowStart) => {
            const partRows = part.frequencies.length;
            if (!output) {
                output = { ...part, rowStart: 0 };
                for (const key of waveletRowArrays) {
                    const source = part[key];
                    if (source) output[key] = new source.constructor(rows * (source.length / partRows));
                }
            }
            output.peak = Math.max(output.peak, part.peak);
            output.minMagnitude = Math.min(output.minMagnitude, part.minMagnitude);
            let copiedBytes = 0;
            for (const key of waveletRowArrays) {
                const source = part[key];
                if (!source) continue;
                const destination = rowStart * (source.length / partRows);
                const slice = waveletCopySliceBytes / source.BYTES_PER_ELEMENT;
                for (let i = 0; i < source.length; i += slice) {
                    const piece = source.subarray(i, Math.min(source.length, i + slice));
                    if (copiedBytes + piece.byteLength > waveletCopySliceBytes) {
                        await new Promise(resolve => this.schedule(resolve));
                        check();
                        copiedBytes = 0;
                    }
                    output[key].set(piece, destination + i);
                    copiedBytes += piece.byteLength;
                }
            }
        };
        const work = async () => {
            for (const waveletRows of batches) {
                check();
                const part = await this._queueTask({ ...task, waveletRows }, { signal: controller.signal });
                check();
                await append(part, waveletRows.rowStart);
            }
        };
        const tasks = Array.from({ length: lanes }, work);
        try {
            await Promise.all(tasks);
            check();
            return output;
        } catch (error) {
            abort();
            await Promise.allSettled(tasks);
            throw error;
        } finally {
            signal?.removeEventListener('abort', abort);
            this.parallelWavelet = false;
        }
    }

    _queueTask(task, { onProgress, signal }) {
        if (this.disposed || signal?.aborted) return Promise.reject(historyAbortError());
        return new Promise((resolve, reject) => {
            const reportProgress = task.kind === 'protocol-stream-check' && typeof onProgress === 'function';
            const job = { id: this.nextId++, task, resolve, reject, settled: false,
                onProgress: reportProgress ? onProgress : null, reportedBytes: 0 };
            if (signal) {
                const cancel = () => {
                    this.queue = this.queue.filter(queued => queued !== job);
                    // A dense transform runs synchronously inside its worker. Release its grid before starting another.
                    if (task.kind === 'wavelet' && (task.waveletRows || task.frequencyRows || task.timeColumns || task.timeStride)) {
                        const index = this.workers.findIndex(worker => worker.job === job);
                        if (index >= 0) {
                            this._closeWorker(this.workers[index]);
                            this.workers.splice(index, 1);
                        }
                    }
                    if (this.fallbackJob === job) {
                        this.cancelSchedule(this.fallbackTimer);
                        this.fallbackJob = this.fallbackTimer = null;
                    }
                    this._settle(job, historyAbortError());
                    this._pump();
                };
                signal.addEventListener('abort', cancel, { once: true });
                job.removeAbortListener = () => signal.removeEventListener('abort', cancel);
            }
            this.jobs.add(job);
            if (isLiveSpectrumTask(task)) {
                const firstOther = this.queue.findIndex(queued => !isLiveSpectrumTask(queued.task));
                this.queue.splice(firstOther < 0 ? this.queue.length : firstOther, 0, job);
            } else this.queue.push(job);
            this._pump();
        });
    }

    _reportProgress(job, processedBytes) {
        if (!job.onProgress || !Number.isSafeInteger(processedBytes) ||
            processedBytes < job.reportedBytes + protocolStreamProgressBytes || processedBytes >= job.task.bytes.length) return;
        job.reportedBytes = processedBytes;
        try { job.onProgress(processedBytes); }
        catch { /* A progress observer must not interrupt the job. */ }
    }

    _settle(job, error, result) {
        if (job.settled) return;
        job.settled = true;
        this.jobs.delete(job);
        job.removeAbortListener?.();
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
                const limit = this.workerLimit ?? this.maxWorkers;
                if (this.workers.filter(worker => worker.job).length >= limit) break;
                let slot = this.workers.find(worker => !worker.job);
                if (!slot && this.workers.length < limit) {
                    try { slot = this._createWorker(); }
                    catch { this._failWorkers(); continue; }
                }
                if (!slot) break;
                if (slot.idleTimer != null) this.idleCancel(slot.idleTimer);
                slot.idleTimer = null;
                const job = this.queue.shift();
                slot.job = job;
                try {
                    const kind = job.task.kind, samples = ['fft', 'time-scan', 'csv-export', 'wavelet'].includes(kind);
                    const protocol = kind === 'protocol-decode', search = kind === 'monitor-search', hex = kind === 'hex-export';
                    const pair = kind === 'pairSpectrum';
                    const data = samples ? new Float64Array(job.task.values)
                        : protocol || search || hex || pair ? null : new Uint8Array(job.task.bytes);
                    const task = samples ? { ...job.task, values: data } : data ? { ...job.task, bytes: data } : { ...job.task };
                    const transfer = data ? [data.buffer] : [];
                    if (pair) {
                        // One packed buffer preserves subview boundaries and leaves the source usable for fallback.
                        const values = new Float64Array(task.segments.reduce((total, { x, y }) => total + x.length + y.length, 0));
                        let offset = 0;
                        task.segments = task.segments.map(({ x, y }) => {
                            const yStart = offset + x.length, end = yStart + y.length;
                            values.set(x, offset);
                            values.set(y, yStart);
                            const copy = { x: values.subarray(offset, yStart), y: values.subarray(yStart, end) };
                            offset = end;
                            return copy;
                        });
                        transfer.push(values.buffer);
                    }
                    if (protocol) task.records = task.records.map(record => {
                        const bytes = new Uint8Array(record instanceof Uint8Array ? record : record.bytes);
                        transfer.push(bytes.buffer); return { bytes };
                    });
                    if (search) {
                        task.orders = job.task.orders.slice(); transfer.push(task.orders.buffer);
                        if (task.values) { task.values = task.values.slice(); transfer.push(task.values.buffer); }
                    }
                    if (task.times) { task.times = task.times.slice(); transfer.push(task.times.buffer); }
                    if (search || hex) {
                        task.records = job.task.records.map(record => {
                            const bytes = new Uint8Array(record.bytes); transfer.push(bytes.buffer);
                            return { ...record, bytes };
                        });
                    }
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
                    slot.worker.postMessage({ id: job.id, task, reportProgress: Boolean(job.onProgress) }, transfer);
                } catch { this._failWorkers(); }
            }
        } finally {
            this.pumping = false;
            for (const slot of this.workers) if (!slot.job && slot.idleTimer == null) {
                slot.idleTimer = this.idleSchedule(() => {
                    slot.idleTimer = null;
                    if (slot.job || slot.closed) return;
                    this._closeWorker(slot);
                    this.workers = this.workers.filter(item => item !== slot);
                }, 10000);
                slot.idleTimer?.unref?.();
            }
        }
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
            if (Object.hasOwn(data, 'processedBytes')) {
                this._reportProgress(job, data.processedBytes);
                return;
            }
            if (!Object.hasOwn(data, 'error') && !Object.hasOwn(data, 'result')) {
                this._failWorkers();
                return;
            }
            slot.job = null;
            if (data.error) {
                const error = new Error(data.error.message);
                error.name = data.error.name || 'Error';
                if (data.error.code) error.code = data.error.code;
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

    _closeWorker(slot) {
        slot.closed = true;
        if (slot.idleTimer != null) this.idleCancel(slot.idleTimer);
        slot.idleTimer = null;
        slot.worker.onmessage = null;
        slot.worker.onerror = null;
        slot.worker.onmessageerror = null;
        try {
            const completion = slot.worker.terminate();
            completion?.catch?.(() => {});
        } catch { /* Cleanup must continue even if one worker already exited. */ }
    }

    _closeWorkers() {
        for (const slot of this.workers) this._closeWorker(slot);
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
                const wavelet = job.task.kind === 'wavelet';
                const deadline = wavelet ? performance.now() + 6 : 0;
                processor ??= createHistoryTaskProcessor(job.task, historyWorkerDependencies());
                let complete = processor.step(wavelet ? 1 : this.sliceBytes);
                while (!complete && wavelet && performance.now() < deadline) complete = processor.step(1);
                if (!complete) {
                    this._reportProgress(job, processor.processedBytes);
                    if (!this.disposed) this.fallbackTimer = this.schedule(advance);
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
        this.clearFftCache();
        this._closeWorkers();
    }
}

if (typeof module !== 'undefined') module.exports = {
    HistoryWorkerPool, createHistoryTaskProcessor, buildHistoryWorkerSource
};
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.HistoryWorkerPool = HistoryWorkerPool;

/** Shared numeric read view. Extra columns never duplicate original bytes or samples. */
const computedChannelApi = typeof module !== 'undefined' ? require('./channelOperations') : globalThis.SerialPlotter;
const COMPUTED_CHUNK_SIZE = 4096;

class ComputedFrames {
    constructor(raw, definitions = [], options = {}) {
        this.raw = raw; this.definitions = definitions.map(value => ({ ...value }));
        this.engine = new computedChannelApi.ChannelOperations(raw.channelCount, definitions);
        this.columns = new Map(); this.revision = 0; this.serial = raw.length; this.generation = 0;
        this.rebuilding = false; this.progress = null; this.pendingAffected = new Set(); this.storageRevision = 0;
        this.yieldTimers = new Map();
        this.yieldControl = options.yieldControl ?? (() => new Promise(resolve => {
            const id = setTimeout(() => { this.yieldTimers.delete(id); resolve(); }, 0);
            this.yieldTimers.set(id, resolve);
        }));
        this.onProgress = options.onProgress ?? (() => {}); this.onChange = options.onChange ?? (() => {});
        this._values = raw.values;
        return new Proxy(this, {
            get: (target, key) => {
                if (key in target) { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
                const value = raw[key]; return typeof value === 'function' ? value.bind(raw) : value;
            }
        });
    }
    get channelCount() { return this.engine.channelCount; }
    get rawChannelCount() { return this.raw.channelCount; }
    get version() { return this.raw.version + this.revision; }
    get values() { return this._values; }
    get length() { return this.raw.length; }
    get capacity() { return this.raw.capacity; }
    _cancelYields() {
        for (const [id, resolve] of this.yieldTimers) { clearTimeout(id); resolve(); }
        this.yieldTimers.clear();
    }
    _slot(index) { return (this.raw.head + index) % this.raw.storageCapacity; }
    _write(columns, number, slot, value) {
        let chunks = columns.get(number);
        if (!chunks) { chunks = []; columns.set(number, chunks); }
        const chunk = Math.floor(slot / COMPUTED_CHUNK_SIZE);
        chunks[chunk] ??= new Float64Array(COMPUTED_CHUNK_SIZE).fill(NaN);
        chunks[chunk][slot % COMPUTED_CHUNK_SIZE] = value;
    }
    getValue(channel, index) {
        if (index < 0 || index >= this.raw.length || channel < 0 || channel >= this.channelCount) return NaN;
        if (channel < this.raw.channelCount) return this.raw.getValue(channel, index);
        const slot = this._slot(index);
        return this.columns.get(channel + 1)?.[Math.floor(slot / COMPUTED_CHUNK_SIZE)]?.[slot % COMPUTED_CHUNK_SIZE] ?? NaN;
    }
    channelSlice(channel, start = 0, end = this.length) {
        const values = [];
        for (let i = Math.max(0, start); i < Math.min(end, this.length); i++) values.push(this.getValue(channel, i));
        return values;
    }
    isSignal(channel) { return channel < this.raw.channelCount || this.engine.entries.get(channel + 1)?.definition.type === 'formula'; }
    append(samples, ...metadata) {
        this.raw.append(samples, ...metadata); this.serial++;
        if (!this.definitions.some(definition => definition.type === 'formula')) return;
        const values = this.engine.push(samples), slot = this._slot(this.length - 1);
        for (const definition of this.definitions) if (definition.type === 'formula')
            this._write(this.columns, definition.number, slot, values[definition.number - 1]);
    }
    _affected(next) {
        const changed = new Set(), previous = new Map(this.definitions.map(value => [value.number, value]));
        for (const entry of next.definitions) {
            const old = previous.get(entry.number);
            if (!old || entry.type !== old.type || entry.expression !== old.expression || entry.initial !== old.initial)
                changed.add(entry.number);
        }
        for (const number of previous.keys()) if (!next.entries.has(number)) changed.add(number);
        let expanded;
        do {
            expanded = false;
            for (const [number, entry] of next.entries) if (!changed.has(number) && [...entry.dependencies].some(value => changed.has(value))) {
                changed.add(number); expanded = true;
            }
        } while (expanded);
        return changed;
    }
    updateDefinitions(definitions, { rebuild = true, all = false, reapply = [], numberMap = null } = {}) {
        const next = new computedChannelApi.ChannelOperations(this.raw.channelCount, definitions);
        if (numberMap) {
            next.adoptRenumbered(this.engine, numberMap);
            this.columns = new Map([...this.columns].filter(([number]) => numberMap.has(number))
                .map(([number, column]) => [numberMap.get(number), column]));
            this.pendingAffected = new Set([...this.pendingAffected].filter(number => numberMap.has(number))
                .map(number => numberMap.get(number)));
            rebuild = this.rebuilding;
            reapply = [...this.pendingAffected];
            this.engine = next; this.definitions = next.definitions;
        }
        const affected = all ? new Set([...next.entries.keys()]) : this._affected(next);
        // Applying an unchanged expression can explicitly rebuild future-only edits in retained history.
        if (rebuild) for (const number of reapply) if (next.entries.has(number)) affected.add(number);
        if (rebuild && this.rebuilding) for (const number of this.pendingAffected) affected.add(number);
        let expanded;
        do {
            expanded = false;
            for (const [number, entry] of next.entries) if (!affected.has(number) && [...entry.dependencies].some(value => affected.has(value))) {
                affected.add(number); expanded = true;
            }
        } while (expanded);
        next.adoptUnchanged(this.engine, affected);
        // Explicit lookbacks refer to retained samples even when a new expression is introduced.
        for (const [number, history] of next.history) if (history !== this.engine.history.get(number)) {
            for (let index = Math.max(0, this.length - history.size); index < this.length; index++)
                history.push(this.getValue(number - 1, index));
        }
        this.engine = next; this.definitions = next.definitions;
        for (const number of this.columns.keys()) if (!next.entries.has(number)) this.columns.delete(number);
        const generation = ++this.generation;
        this._cancelYields();
        this.revision++; this._values = [...this.raw.values, this.columns];
        this.rebuilding = rebuild && affected.size > 0 && this.length > 0;
        this.pendingAffected = this.rebuilding ? affected : new Set();
        this.progress = this.rebuilding ? { processedBytes: 0, totalBytes: this.length } : null;
        this.onChange(); this.onProgress();
        if (!this.rebuilding) return Promise.resolve();
        const cancelled = () => generation !== this.generation;
        return (async () => {
            let worker = new computedChannelApi.ChannelOperations(this.raw.channelCount, definitions);
            let columns = new Map(), cursor = this.serial - this.length, storageRevision = this.storageRevision;
            const unchanged = [...worker.entries].filter(([number, entry]) => entry.ast && !affected.has(number)).map(([number]) => number);
            const overrides = new Map();
            await this.yieldControl();
            while (!cancelled() && cursor < this.serial) {
                const first = this.serial - this.length;
                if (cursor < first || storageRevision !== this.storageRevision) {
                    worker = new computedChannelApi.ChannelOperations(this.raw.channelCount, definitions);
                    columns = new Map(); cursor = first; storageRevision = this.storageRevision;
                }
                const stop = Math.min(this.serial, cursor + 512);
                const deadline = performance.now() + 8;
                for (; cursor < stop; cursor++) {
                    const index = cursor - (this.serial - this.length);
                    const samples = Array.from({ length: this.raw.channelCount }, (_, c) => this.raw.getValue(c, index));
                    for (const number of unchanged) overrides.set(number, this.getValue(number - 1, index));
                    const values = worker.push(samples, overrides), slot = this._slot(index);
                    for (const number of affected) if (worker.entries.get(number)?.ast)
                        this._write(columns, number, slot, values[number - 1]);
                    if (performance.now() >= deadline) { cursor++; break; }
                }
                this.progress = { processedBytes: Math.min(this.length, worker.sample), totalBytes: this.length };
                this.onProgress();
                if (cursor < this.serial) await this.yieldControl();
            }
            if (cancelled()) return;
            worker.adoptUnchanged(this.engine, affected);
            this.engine = worker;
            for (const number of affected) if (worker.entries.has(number)) {
                if (columns.has(number)) this.columns.set(number, columns.get(number));
                else this.columns.delete(number);
            }
            this.rebuilding = false; this.progress = null; this.pendingAffected.clear(); this.revision++;
            this._values = [...this.raw.values, this.columns]; this.onChange(); this.onProgress();
        })().catch(error => {
            if (!cancelled()) {
                this.rebuilding = false; this.progress = null; this.pendingAffected.clear();
                this.onChange(); this.onProgress();
            }
            throw error;
        });
    }
    resize(capacity) {
        if (capacity === this.raw.capacity) return;
        this.storageRevision++;
        if (capacity <= this.raw.storageCapacity && capacity >= this.raw.storageCapacity / 4) this.raw.resize(capacity);
        else {
            const count = Math.min(this.length, capacity), first = this.length - count, columns = new Map();
            for (const number of this.columns.keys()) for (let index = 0; index < count; index++)
                this._write(columns, number, index, this.getValue(number - 1, first + index));
            this.raw.resize(capacity); this.columns = columns;
        }
        this._values = [...this.raw.values, this.columns]; this.revision++;
        this.onProgress();
    }
    clear() {
        this._cancelYields();
        this.generation++; this.rebuilding = false; this.progress = null; this.raw.clear(); this.columns.clear();
        this.engine = new computedChannelApi.ChannelOperations(this.raw.channelCount, this.definitions);
        this.serial = 0; this._values = [...this.raw.values, this.columns]; this.revision++; this.onProgress();
    }
    setChannelCount(count) {
        // Validate global channel numbering before changing any stored raw data.
        new computedChannelApi.ChannelOperations(count, this.definitions);
        this.raw.setChannelCount(count); this.clear();
    }
    resetFormat(count, definitions) {
        const engine = new computedChannelApi.ChannelOperations(count, definitions);
        this.generation++; this._cancelYields(); this.raw.clear(); this.raw.setChannelCount(count);
        this.engine = engine; this.definitions = engine.definitions; this.columns.clear(); this.serial = 0;
        this.rebuilding = false; this.progress = null; this.revision++; this._values = [...this.raw.values, this.columns];
    }
    replaceFrom(other) {
        this.generation++; this._cancelYields(); this.raw.replaceFrom(other.raw ?? other); this.serial = this.length; this.columns.clear();
        this.engine = new computedChannelApi.ChannelOperations(this.raw.channelCount, this.definitions);
        this._values = [...this.raw.values, this.columns]; this.revision++;
        return this.updateDefinitions(this.definitions, { rebuild: true, all: true });
    }
    dispose() { this.generation++; this._cancelYields(); this.rebuilding = false; this.columns.clear(); }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.ComputedFrames = ComputedFrames;
if (typeof module !== 'undefined') module.exports = { ComputedFrames };

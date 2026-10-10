/** Read-only, per-widget system view. No received samples, byte positions or timestamps are invented. */
const responseFrameApi = typeof module !== 'undefined' ? require('./systemResponse') : globalThis.SerialPlotter;
class SystemResponseFrames {
    constructor() {
        this.responseMode = true; this.rawMode = false; this.version = 0; this.channelCount = 0;
        this.length = 0; this.capacity = 0; this.count = 1000; this.entries = new Map(); this.cache = new Map();
    }
    configure(source, count, frequencyCount = count) {
        const entries = new Map([...source.engine.entries].filter(([, entry]) => entry.kernel || entry.system));
        const key = JSON.stringify([count, frequencyCount, source.channelCount, [...entries].map(([number, entry]) =>
            [number, entry.definition.type, entry.definition.expression])]);
        if (key === this.key) return;
        this.key = key; this.version++; this.count = count; this.channelCount = source.channelCount; this.entries = entries;
        this.gridSize = Math.max(frequencyCount, ...[...entries.values()].map(entry => entry.kernel?.length ??
            Math.max(entry.system.inputSize + 1, entry.system.outputSize + 1)));
        this.length = entries.size ? Math.max(count, ...[...entries.values()].map(entry => entry.kernel?.length ?? count)) : 0;
        this.capacity = this.length;
        for (const [number, cached] of this.cache) {
            if (!entries.has(number) || cached.key !== this._key(entries.get(number))) this.cache.delete(number);
        }
    }
    _key(entry) { return JSON.stringify([entry.definition.type, entry.definition.expression, this.count, this.gridSize]); }
    frequencyForChannel(channel) {
        const number = channel + 1, entry = this.entries.get(number);
        if (!entry) return { samples: [], mags: [], phases: [], fftSize: 0, error: '' };
        let cached = this.cache.get(number);
        if (!cached) {
            cached = { key: this._key(entry), response: responseFrameApi.prepareSystemResponse(entry, this.count, this.gridSize) };
            this.cache.set(number, cached);
        }
        return cached.response;
    }
    channelSlice(channel, start = 0, end = this.length) {
        const samples = this.frequencyForChannel(channel).samples;
        if (!samples.length) return [];
        const missing = this.entries.get(channel + 1)?.kernel ? 0 : NaN;
        return Array.from({ length: Math.max(0, end - start) }, (_, index) => samples[index] ?? missing);
    }
    getValue(channel, index) {
        const missing = this.entries.get(channel + 1)?.kernel ? 0 : NaN;
        return index >= 0 && index < this.length ? this.frequencyForChannel(channel).samples[index] ?? missing : NaN;
    }
    isSignal(channel) { return this.entries.has(channel + 1); }
    orderAt(index) { return index >= 0 && index < this.length ? index : NaN; }
    indexAtOrAfterOrder(order) { return Math.max(0, Math.min(this.length, Math.ceil(order))); }
    timestampAt() { return NaN; }
    rawByteOffsetAt() { return undefined; }
    rawBytesAt() { return new Uint8Array(); }
    dispose() { this.cache.clear(); this.entries.clear(); }
}
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.SystemResponseFrames = SystemResponseFrames;
if (typeof module !== 'undefined') module.exports = { SystemResponseFrames };

/** Bounded, synchronized sample and raw-frame storage. Indices are oldest first. */
const frameLimits = typeof module !== 'undefined'
    ? require('./projectLimits').PROJECT_LIMITS : globalThis.SerialPlotter.Limits;

class FrameBuffer {
    constructor(channelCount = 1, capacity = 1000) {
        if (!Number.isSafeInteger(channelCount) || channelCount < frameLimits.minChannels ||
            channelCount > frameLimits.maxChannels)
            throw new RangeError(`通道数需为 ${frameLimits.minChannels}–${frameLimits.maxChannels}`);
        if (!Number.isSafeInteger(capacity) || capacity < frameLimits.minPoints ||
            capacity > frameLimits.maxPoints)
            throw new RangeError(`最大采样点数需为 ${frameLimits.minPoints}–${frameLimits.maxPoints}`);
        this.channelCount = channelCount;
        this.capacity = capacity;
        this.values = Array.from({ length: channelCount }, () => new Float64Array(capacity));
        this.frames = new Array(capacity);
        this.head = 0;
        this.length = 0;
        this.version = 0;
    }

    append(samples, bytes = new Uint8Array(0), time = '', order = 0) {
        if (samples.length !== this.channelCount) throw new RangeError('通道数与帧数据不匹配');
        const slot = (this.head + this.length) % this.capacity;
        for (let c = 0; c < this.channelCount; c++) this.values[c][slot] = samples[c];
        this.frames[slot] = { bytes: Uint8Array.from(bytes), time, order, kind: 'rx' };
        if (this.length === this.capacity) this.head = (this.head + 1) % this.capacity;
        else this.length++;
        this.version++;
    }

    getValue(channel, index) {
        if (index < 0 || index >= this.length || channel < 0 || channel >= this.channelCount) return undefined;
        return this.values[channel][(this.head + index) % this.capacity];
    }

    frameAt(index) {
        if (index < 0 || index >= this.length) return null;
        return this.frames[(this.head + index) % this.capacity];
    }

    channelSlice(channel, start = 0, end = this.length) {
        const out = [];
        for (let i = Math.max(0, start); i < Math.min(end, this.length); i++) out.push(this.getValue(channel, i));
        return out;
    }

    resize(capacity) {
        if (!Number.isSafeInteger(capacity) || capacity < frameLimits.minPoints || capacity > frameLimits.maxPoints)
            throw new RangeError(`最大采样点数需为 ${frameLimits.minPoints}–${frameLimits.maxPoints}`);
        if (capacity === this.capacity) return;
        const count = Math.min(this.length, capacity);
        const first = this.length - count;
        const values = Array.from({ length: this.channelCount }, (_, c) => {
            const next = new Float64Array(capacity);
            for (let i = 0; i < count; i++) next[i] = this.getValue(c, first + i);
            return next;
        });
        const frames = new Array(capacity);
        for (let i = 0; i < count; i++) frames[i] = this.frameAt(first + i);
        this.capacity = capacity;
        this.values = values;
        this.frames = frames;
        this.head = 0;
        this.length = count;
        this.version++;
    }

    setChannelCount(count) {
        if (!Number.isSafeInteger(count) || count < frameLimits.minChannels || count > frameLimits.maxChannels)
            throw new RangeError(`通道数需为 ${frameLimits.minChannels}–${frameLimits.maxChannels}`);
        if (count === this.channelCount) return;
        this.channelCount = count;
        this.values = Array.from({ length: count }, () => new Float64Array(this.capacity));
        this.clear();
    }

    clear() {
        this.frames = new Array(this.capacity);
        this.head = 0;
        this.length = 0;
        this.version++;
    }
}

if (typeof module !== 'undefined') module.exports = { FrameBuffer };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.FrameBuffer = FrameBuffer;

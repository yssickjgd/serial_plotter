/** Bounded, synchronized sample and raw-frame storage. Indices are oldest first. */
const frameLimits = typeof module !== 'undefined'
    ? require('./projectLimits').PROJECT_LIMITS : globalThis.SerialPlotter.Limits;
const FRAME_CHUNK_SIZE = 4096;

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
        this.storageCapacity = capacity;
        this.values = Array.from({ length: channelCount }, () => []);
        this.frames = [];
        this.head = 0;
        this.length = 0;
        this.version = 0;
        this.timestampsMonotonic = true;
    }

    _frameChunk(chunkIndex, byteLength) {
        let chunk = this.frames[chunkIndex];
        if (!chunk) {
            chunk = {
                stride: 0,
                raw: new Uint8Array(0),
                lengths: new Uint32Array(FRAME_CHUNK_SIZE),
                times: new Array(FRAME_CHUNK_SIZE),
                orders: new Float64Array(FRAME_CHUNK_SIZE),
                timestamps: new Float64Array(FRAME_CHUNK_SIZE)
            };
            this.frames[chunkIndex] = chunk;
        }
        if (byteLength > chunk.stride) {
            const stride = Math.max(byteLength, Math.ceil(chunk.stride * 1.5));
            const raw = new Uint8Array(FRAME_CHUNK_SIZE * stride);
            for (let i = 0; i < FRAME_CHUNK_SIZE; i++) {
                const length = chunk.lengths[i];
                if (length) raw.set(chunk.raw.subarray(i * chunk.stride, i * chunk.stride + length), i * stride);
            }
            chunk.stride = stride;
            chunk.raw = raw;
        }
        return chunk;
    }

    append(samples, bytes = new Uint8Array(0), time = '', order = 0, timestamp = NaN) {
        if (samples.length !== this.channelCount) throw new RangeError('通道数与帧数据不匹配');
        if (this.length) {
            const lastTimestamp = this.timestampAt(this.length - 1);
            if (!Number.isFinite(timestamp) || !Number.isFinite(lastTimestamp) ||
                timestamp < lastTimestamp) this.timestampsMonotonic = false;
        }
        const slot = (this.head + this.length) % this.storageCapacity;
        const chunkIndex = Math.floor(slot / FRAME_CHUNK_SIZE);
        const offset = slot % FRAME_CHUNK_SIZE;
        for (let c = 0; c < this.channelCount; c++) {
            const chunks = this.values[c];
            if (!chunks[chunkIndex]) chunks[chunkIndex] = new Float64Array(FRAME_CHUNK_SIZE);
            chunks[chunkIndex][offset] = samples[c];
        }
        const chunk = this._frameChunk(chunkIndex, bytes.length);
        chunk.raw.set(bytes, offset * chunk.stride);
        chunk.lengths[offset] = bytes.length;
        chunk.times[offset] = time;
        chunk.orders[offset] = order;
        chunk.timestamps[offset] = timestamp;
        if (this.length === this.capacity) this.head = (this.head + 1) % this.storageCapacity;
        else this.length++;
        this.version++;
    }

    getValue(channel, index) {
        if (index < 0 || index >= this.length || channel < 0 || channel >= this.channelCount) return undefined;
        const slot = (this.head + index) % this.storageCapacity;
        return this.values[channel][Math.floor(slot / FRAME_CHUNK_SIZE)][slot % FRAME_CHUNK_SIZE];
    }

    frameAt(index) {
        if (index < 0 || index >= this.length) return null;
        const slot = (this.head + index) % this.storageCapacity;
        const chunk = this.frames[Math.floor(slot / FRAME_CHUNK_SIZE)];
        const offset = slot % FRAME_CHUNK_SIZE;
        const byteStart = offset * chunk.stride;
        return {
            bytes: chunk.raw.slice(byteStart, byteStart + chunk.lengths[offset]),
            time: chunk.times[offset],
            order: chunk.orders[offset],
            timestamp: chunk.timestamps[offset],
            kind: 'rx'
        };
    }

    timestampAt(index) {
        if (index < 0 || index >= this.length) return NaN;
        const slot = (this.head + index) % this.storageCapacity;
        return this.frames[Math.floor(slot / FRAME_CHUNK_SIZE)].timestamps[slot % FRAME_CHUNK_SIZE];
    }

    get originTimestamp() { return this.timestampAt(0); }

    orderAt(index) {
        if (index < 0 || index >= this.length) return NaN;
        const slot = (this.head + index) % this.storageCapacity;
        return this.frames[Math.floor(slot / FRAME_CHUNK_SIZE)].orders[slot % FRAME_CHUNK_SIZE];
    }

    indexAtOrAfterOrder(order) {
        let low = 0, high = this.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (this.orderAt(mid) < order) low = mid + 1;
            else high = mid;
        }
        return Math.min(low, this.length - 1);
    }

    rawBytesAt(index) {
        if (index < 0 || index >= this.length) return null;
        const slot = (this.head + index) % this.storageCapacity;
        const chunk = this.frames[Math.floor(slot / FRAME_CHUNK_SIZE)];
        const offset = slot % FRAME_CHUNK_SIZE;
        const start = offset * chunk.stride;
        return chunk.raw.subarray(start, start + chunk.lengths[offset]);
    }

    nearestTimestampIndex(timestamp) {
        if (!this.length || !Number.isFinite(timestamp)) return -1;
        if (!this.timestampsMonotonic) {
            let best = -1, distance = Infinity;
            for (let i = 0; i < this.length; i++) {
                const difference = Math.abs(this.timestampAt(i) - timestamp);
                if (difference < distance) { best = i; distance = difference; }
            }
            return best;
        }
        let low = 0, high = this.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (this.timestampAt(mid) < timestamp) low = mid + 1;
            else high = mid;
        }
        if (low === 0) return 0;
        if (low === this.length) return this.length - 1;
        return timestamp - this.timestampAt(low - 1) <= this.timestampAt(low) - timestamp
            ? low - 1 : low;
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
        if (capacity <= this.storageCapacity && capacity >= this.storageCapacity / 4) {
            if (this.length > capacity) {
                this.head = (this.head + this.length - capacity) % this.storageCapacity;
                this.length = capacity;
            }
            this.capacity = capacity;
            this.version++;
            return;
        }
        const count = Math.min(this.length, capacity);
        const first = this.length - count;
        const replacement = new FrameBuffer(this.channelCount, capacity);
        for (let i = 0; i < count; i++) {
            const frame = this.frameAt(first + i);
            const samples = Array.from({ length: this.channelCount }, (_, c) => this.getValue(c, first + i));
            replacement.append(samples, frame.bytes, frame.time, frame.order, frame.timestamp);
        }
        this.capacity = capacity;
        this.storageCapacity = replacement.storageCapacity;
        this.values = replacement.values;
        this.frames = replacement.frames;
        this.timestampsMonotonic = replacement.timestampsMonotonic;
        this.head = 0;
        this.length = count;
        this.version++;
    }

    setChannelCount(count) {
        if (!Number.isSafeInteger(count) || count < frameLimits.minChannels || count > frameLimits.maxChannels)
            throw new RangeError(`通道数需为 ${frameLimits.minChannels}–${frameLimits.maxChannels}`);
        if (count === this.channelCount) return;
        this.channelCount = count;
        this.clear();
    }

    clear() {
        this.values = Array.from({ length: this.channelCount }, () => []);
        this.frames = [];
        this.timestampsMonotonic = true;
        this.head = 0;
        this.length = 0;
        this.version++;
    }
}

if (typeof module !== 'undefined') module.exports = { FrameBuffer };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.FrameBuffer = FrameBuffer;

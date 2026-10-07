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
        this.rawMode = false;
        this.rawBytesWritten = 0;
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
                timestamps: new Float64Array(FRAME_CHUNK_SIZE),
                byteOffsets: new Float64Array(FRAME_CHUNK_SIZE),
                endBytes: new Float64Array(FRAME_CHUNK_SIZE)
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

    append(samples, bytes = new Uint8Array(0), time = '', order = 0, timestamp = NaN, metadata = {}) {
        if (samples.length !== this.channelCount) throw new RangeError('通道数与帧数据不匹配');
        this.setRawMode(false);
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
        chunk.byteOffsets[offset] = metadata.byteOffset ?? this.rawBytesWritten;
        chunk.endBytes[offset] = metadata.endByte ?? chunk.byteOffsets[offset] + bytes.length;
        this.rawBytesWritten = chunk.endBytes[offset];
        if (this.length === this.capacity) this.head = (this.head + 1) % this.storageCapacity;
        else this.length++;
        this.version++;
    }

    /** Mode changes require an empty window; channelCount remains numeric-format metadata. */
    setRawMode(rawMode) {
        const next = rawMode === true;
        if (this.rawMode === next) return;
        if (this.length) throw new Error('不能在同一缓冲区混合原始和通道数值模式');
        this.rawMode = next;
        this.frames = [];
        this.values = Array.from({ length: this.channelCount }, () => []);
        this.version++;
    }

    appendRaw(bytes, time = '', order = 0, timestamp = NaN,
        { incomplete = false, byteOffset, endByte, streamEnded = false, streamStartByte = 0 } = {}) {
        this.setRawMode(true);
        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
        if (this.length) {
            const lastTimestamp = this.timestampAt(this.length - 1);
            if (!Number.isFinite(timestamp) || !Number.isFinite(lastTimestamp) || timestamp < lastTimestamp)
                this.timestampsMonotonic = false;
        }
        const slot = (this.head + this.length) % this.storageCapacity;
        const chunkIndex = Math.floor(slot / FRAME_CHUNK_SIZE);
        const offset = slot % FRAME_CHUNK_SIZE;
        let chunk = this.frames[chunkIndex];
        if (!chunk) {
            chunk = { rawRecords: new Array(FRAME_CHUNK_SIZE), times: new Array(FRAME_CHUNK_SIZE),
                orders: new Float64Array(FRAME_CHUNK_SIZE), timestamps: new Float64Array(FRAME_CHUNK_SIZE),
                incomplete: new Uint8Array(FRAME_CHUNK_SIZE), byteOffsets: new Float64Array(FRAME_CHUNK_SIZE),
                streamEnded: new Uint8Array(FRAME_CHUNK_SIZE), streamStartBytes: new Float64Array(FRAME_CHUNK_SIZE) };
            this.frames[chunkIndex] = chunk;
        }
        if (this.length === this.capacity) this._releaseRawSlot(this.head);
        chunk.rawRecords[offset] = bytes.slice();
        chunk.times[offset] = time;
        chunk.orders[offset] = order;
        chunk.timestamps[offset] = timestamp;
        chunk.incomplete[offset] = incomplete === true ? 1 : 0;
        chunk.streamEnded[offset] = streamEnded === true ? 1 : 0;
        chunk.streamStartBytes[offset] = streamStartByte;
        chunk.byteOffsets[offset] = byteOffset ?? this.rawBytesWritten;
        this.rawBytesWritten = endByte ?? chunk.byteOffsets[offset] + bytes.length;
        if (this.length === this.capacity) this.head = (this.head + 1) % this.storageCapacity;
        else this.length++;
        this.version++;
    }

    _releaseRawSlot(slot) {
        const chunk = this.frames[Math.floor(slot / FRAME_CHUNK_SIZE)];
        const offset = slot % FRAME_CHUNK_SIZE;
        chunk.rawRecords[offset] = undefined;
        chunk.times[offset] = undefined;
    }

    getValue(channel, index) {
        if (index < 0 || index >= this.length || channel < 0 || channel >= this.channelCount) return undefined;
        if (this.rawMode) return undefined;
        const slot = (this.head + index) % this.storageCapacity;
        return this.values[channel][Math.floor(slot / FRAME_CHUNK_SIZE)][slot % FRAME_CHUNK_SIZE];
    }

    frameAt(index) {
        if (index < 0 || index >= this.length) return null;
        const slot = (this.head + index) % this.storageCapacity;
        const chunk = this.frames[Math.floor(slot / FRAME_CHUNK_SIZE)];
        const offset = slot % FRAME_CHUNK_SIZE;
        if (this.rawMode) return {
            bytes: chunk.rawRecords[offset].slice(), time: chunk.times[offset], order: chunk.orders[offset],
            timestamp: chunk.timestamps[offset], kind: 'rx', incomplete: chunk.incomplete[offset] === 1,
            byteOffset: chunk.byteOffsets[offset], endByte: chunk.byteOffsets[offset] + chunk.rawRecords[offset].length,
            streamEnded: chunk.streamEnded[offset] === 1, streamStartByte: chunk.streamStartBytes[offset]
        };
        const byteStart = offset * chunk.stride;
        return {
            bytes: chunk.raw.slice(byteStart, byteStart + chunk.lengths[offset]),
            time: chunk.times[offset],
            order: chunk.orders[offset],
            timestamp: chunk.timestamps[offset],
            kind: 'rx', byteOffset: chunk.byteOffsets[offset], endByte: chunk.endBytes[offset]
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
        if (this.rawMode) return chunk.rawRecords[offset];
        const start = offset * chunk.stride;
        return chunk.raw.subarray(start, start + chunk.lengths[offset]);
    }

    rawByteOffsetAt(index) {
        if (index < 0 || index >= this.length) return undefined;
        const slot = (this.head + index) % this.storageCapacity;
        return this.frames[Math.floor(slot / FRAME_CHUNK_SIZE)].byteOffsets[slot % FRAME_CHUNK_SIZE];
    }

    streamEndedAt(index) {
        if (!this.rawMode || index < 0 || index >= this.length) return false;
        const slot = (this.head + index) % this.storageCapacity;
        return this.frames[Math.floor(slot / FRAME_CHUNK_SIZE)].streamEnded[slot % FRAME_CHUNK_SIZE] === 1;
    }

    markStreamEnded(index = this.length - 1) {
        if (!this.rawMode || index < 0 || index >= this.length || this.streamEndedAt(index)) return false;
        const slot = (this.head + index) % this.storageCapacity;
        this.frames[Math.floor(slot / FRAME_CHUNK_SIZE)].streamEnded[slot % FRAME_CHUNK_SIZE] = 1;
        this.version++;
        return true;
    }

    streamStartByteAt(index) {
        if (!this.rawMode || index < 0 || index >= this.length) return undefined;
        const slot = (this.head + index) % this.storageCapacity;
        return this.frames[Math.floor(slot / FRAME_CHUNK_SIZE)].streamStartBytes[slot % FRAME_CHUNK_SIZE];
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
                if (this.rawMode) for (let i = 0; i < this.length - capacity; i++)
                    this._releaseRawSlot((this.head + i) % this.storageCapacity);
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
        replacement.setRawMode(this.rawMode);
        for (let i = 0; i < count; i++) {
            const frame = this.frameAt(first + i);
            if (this.rawMode) {
                replacement.rawBytesWritten = frame.byteOffset;
                replacement.appendRaw(frame.bytes, frame.time, frame.order, frame.timestamp, frame);
            }
            else {
                const samples = Array.from({ length: this.channelCount }, (_, c) => this.getValue(c, first + i));
                replacement.append(samples, frame.bytes, frame.time, frame.order, frame.timestamp, frame);
            }
        }
        this.capacity = capacity;
        this.storageCapacity = replacement.storageCapacity;
        this.values = replacement.values;
        this.frames = replacement.frames;
        this.rawBytesWritten = replacement.rawBytesWritten;
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

    /** Move a completed rebuild into the object held by all existing consumers. */
    replaceFrom(other) {
        if (!(other instanceof FrameBuffer)) throw new TypeError('Expected a FrameBuffer');
        if (other === this) return;
        const nextVersion = this.version + 1;
        for (const key of ['channelCount', 'capacity', 'storageCapacity', 'values', 'frames',
            'head', 'length', 'timestampsMonotonic', 'rawMode', 'rawBytesWritten']) this[key] = other[key];
        this.version = nextVersion;
        other.clear();
    }

    clear() {
        this.rawBytesWritten = 0;
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

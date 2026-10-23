/** One byte budget covers all retained interpretations, the receive archive and TX. */
class CaptureMemoryBudget {
    constructor(service, limitBytes = 4096 * 1048576) {
        this.service = service;
        this.setLimit(limitBytes, false);
        this.reset();
    }

    reset() {
        this.cached = null; this.debt = 0; this.checkedAt = -Infinity;
        this.evictedFrames = 0; this.evictions = 0;
        this.blockedReason = '';
    }

    setLimit(bytes, trim = true) {
        if (!Number.isSafeInteger(bytes) || bytes < 1) throw new RangeError('内存预算必须为正整数字节数');
        this.limitBytes = bytes;
        this.blockedReason = '';
        this.service.workerPool.setWorkerLimit?.(Math.max(1, Math.floor(bytes / (32 * 1048576))));
        this.service.workerPool.setFftCacheLimit?.(Math.min(64 * 1048576, Math.floor(bytes / 8)));
        if (this.service.dataEngine?.recordsSource) this.service.dataEngine.recordsSource.parser.maxDecodedFields =
            Math.max(1, Math.min(32768, Math.floor(bytes / 2048)));
        if (trim) this.enforce();
    }

    _buffers() {
        const buffers = new Set([this.service.txFrames]);
        for (const source of this.service.sources) {
            buffers.add(source.frames);
            if (source.replayStorage) buffers.add(source.replayStorage.frames);
        }
        return buffers;
    }

    measure() {
        const service = this.service;
        let usedBytes = service.history.estimatedMemoryBytes;
        for (const frames of this._buffers()) usedBytes += frames.estimatedMemoryBytes;
        for (const source of service.sources) {
            usedBytes += (source.parser.estimatedMemoryBytes ?? source.parser.buffer?.byteLength ?? 0) + (source.errorBytes ?? 0) + source.errors.length * 256;
            // Replay errors and worker input/output coexist with the original retained buffers.
            if (source.replayStorage) usedBytes += source.replayStorage.errorMemoryBytes;
        }
        usedBytes += (service.workerPool.workerCount ?? 0) * 4 * 1048576;
        usedBytes += service.workerPool.fftCacheBytes ?? 0;
        usedBytes += service.dataEngine?.estimatedMemoryBytes ?? 0;
        for (const job of service.workerPool.jobs ?? []) {
            const task = job.task;
            usedBytes += (task?.values?.byteLength ?? task?.bytes?.byteLength ?? 0) * 4;
            for (const part of task?.parts ?? []) usedBytes += part.byteLength * 2;
            for (const record of task?.records ?? []) usedBytes += (record.bytes?.byteLength ?? record.byteLength ?? 0) * 4;
        }
        return { usedBytes, limitBytes: this.limitBytes, evictedFrames: this.evictedFrames, evictions: this.evictions,
            blockedReason: this.blockedReason };
    }

    beforeReceive(byteLength) {
        let extra = byteLength + 256;
        for (const source of this.service.sources) {
            if (source.rebuilding) continue;
            if (source.engineManaged || this.service.dataEngine && !this.service.dataEngine.shouldFeed(source)) continue;
            const parser = source.parser, numeric = source.kind === 'numeric';
            const frameLength = numeric ? parser.channelsCount * parser.getTypeLength() +
                (parser.enableHeader ? parser.headerBytes.length : 0) +
                (parser.enableFooter ? parser.footerBytes.length : 0) + (parser.enableChecksum ? 1 : 0) : 0;
            const pending = numeric ? parser.writeOffset - parser.readOffset : parser.length;
            const count = numeric ? Math.ceil((pending + byteLength) / frameLength) :
                parser.boundary === 'idle' ? Math.ceil((pending + byteLength) / parser.maxFrameBytes) + 1 :
                    Math.ceil(byteLength / parser.delimiter.length) + 1;
            extra += source.frames.estimateAppendMemory(count, byteLength, frameLength, numeric ? parser.channelsCount : 0) + byteLength * 2;
        }
        extra += this.service.dataEngine?.estimateReceiveMemory(byteLength) ?? 0;
        if (extra > this.limitBytes) return false;
        const now = this.service.now();
        if (this.cached && now - this.checkedAt < 250 && this.debt + extra < 1048576 &&
            this.cached.usedBytes + this.debt + extra < this.limitBytes) {
            this.debt += extra;
            return true;
        }
        const evictions = this.evictions, fits = this.enforce(extra);
        // Eviction may have freed chunks the incoming write was going to reuse.
        return fits && (evictions === this.evictions || this.beforeReceive(byteLength));
    }

    check() {
        if (this.cached && this.service.now() - this.checkedAt < 250 &&
            this.cached.usedBytes + this.debt < this.limitBytes) return true;
        return this.enforce();
    }

    _countThrough(frames, order) {
        let low = 0, high = frames.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (frames.orderAt(mid) <= order) low = mid + 1; else high = mid;
        }
        return low;
    }

    _trimThrough(order) {
        const service = this.service;
        let removed = 0;
        for (const frames of this._buffers()) removed += frames.discardOldest(this._countThrough(frames, order));
        for (const source of service.sources) {
            removed += source.replayStorage?.discardErrorsThrough(order) ?? 0;
            let count = 0;
            while (count < source.errors.length && source.errors[count].order <= order)
                source.errorBytes -= source.errors[count++].bytes?.length ?? 0;
            if (count) { source.errors.splice(0, count); removed += count; }
        }
        // Budget eviction supersedes a replay pin. Replay notices the archive gap and restarts
        // at the new retained origin rather than keeping an unlimited old byte prefix alive.
        let earliest = service.history.endByte;
        for (const source of service.sources) {
            if (source.frames.length) earliest = Math.min(earliest, source.frames.rawByteOffsetAt(0));
            const parser = source.parser;
            if (source.kind === 'raw' && parser.length) earliest = Math.min(earliest, parser.frameMetadata.byteOffset);
            if (source.kind === 'numeric' && parser.writeOffset > parser.readOffset)
                earliest = Math.min(earliest, parser.bufferBaseByte + parser.readOffset);
        }
        for (const source of service.sources) if (source.pin !== null) source.pin = Math.max(source.pin, earliest);
        for (const [key, entry] of service.textStats) if (entry.pin !== null && entry.pin < earliest)
            service.textStats.delete(key);
        service._prune();
        return removed;
    }

    enforce(extra = 0) {
        if (this.trimming) return true;
        this.trimming = true;
        try {
            let state = this.measure(), removed = 0;
            if (state.usedBytes + extra > this.limitBytes && this.service.workerPool.fftCacheBytes) {
                this.service.workerPool.clearFftCache(); state = this.measure();
            }
            if (state.usedBytes + extra > this.limitBytes && this.service.dataEngine?.cache.size) {
                this.service.dataEngine.clearDecodeCache(); state = this.measure();
            }
            const target = state.usedBytes + extra > this.limitBytes ? Math.max(0, this.limitBytes * .8 - extra) : Infinity;
            while (state.usedBytes > target) {
                let first = Infinity, cutoff = null;
                for (const frames of this._buffers()) if (frames.length && frames.orderAt(0) < first) {
                    first = frames.orderAt(0);
                    cutoff = frames.orderAt(Math.max(0, Math.min(frames.length - 2, Math.max(4095, Math.ceil(frames.length * .1)))));
                }
                for (const source of this.service.sources) if (source.errors.length && source.errors[0].order < first) {
                    first = source.errors[0].order;
                    cutoff = source.errors[Math.min(source.errors.length - 1, 4095)].order;
                }
                for (const source of this.service.sources) {
                    const error = source.replayStorage?.firstError;
                    if (error && error.order < first) { first = error.order; cutoff = source.replayStorage.errorCutoffOrder; }
                }
                if (cutoff === null) break;
                const count = this._trimThrough(cutoff);
                removed += count;
                if (!count) break;
                state = this.measure();
            }
            if (removed) {
                this.evictions++; this.evictedFrames += removed;
                this.service.workerPool.clearFftCache?.();
                this.service._safeNotify(this.service.onChange, null);
                state = this.measure();
                this.service._safeNotify(this.service.onMemoryPressure, state);
            }
            this.cached = state; this.debt = extra; this.checkedAt = this.service.now();
            return state.usedBytes + extra <= this.limitBytes;
        } finally { this.trimming = false; }
    }
}

if (typeof module !== 'undefined') module.exports = { CaptureMemoryBudget };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.CaptureMemoryBudget = CaptureMemoryBudget;

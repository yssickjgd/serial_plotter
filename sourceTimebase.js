/** Map each source's numeric frames onto a common millisecond timeline. */
(() => {
    const units = new Map([['s', 1000000000], ['ms', 1000000], ['us', 1000], ['ns', 1]]);
    const sharedHighTimes = new WeakMap();
    const batchContinuityGapMs = 50;
    const catchUpPerFrame = .5;

    function normalizeSourceTimebase(input) {
        input ??= {};
        if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('时间基准配置无效');
        const { mode = 'receive', sampleRate = 1000, sequenceChannelId = null, sequenceWrap = null,
            timestampChannelId = null, timestampUnit = 'ms', deviceClock = 'anchored', timestampWrap = null,
            resyncEnabled = true, resyncDelayMs = 5, resyncBatches = 3, resyncConfirmationMs = 100 } = input;
        if (!['receive', 'fixed', 'device'].includes(mode)) throw new RangeError('时间基准模式无效');
        if (!Number.isFinite(sampleRate) || sampleRate < .001 || sampleRate > 1000000)
            throw new RangeError('固定采样率必须在 0.001 至 1000000 Hz 之间');
        for (const id of [sequenceChannelId, timestampChannelId]) {
            if (id !== null && (typeof id !== 'string' || !id.trim())) throw new TypeError('时间基准通道无效');
        }
        if (mode === 'device' && timestampChannelId === null) throw new RangeError('请选择设备时间戳通道');
        if (!units.has(timestampUnit)) throw new RangeError('时间戳单位无效');
        if (!['anchored', 'shared'].includes(deviceClock)) throw new RangeError('设备时钟模式无效');
        if (sequenceWrap !== null && (!Number.isInteger(sequenceWrap) || sequenceWrap <= 0))
            throw new RangeError('帧序号回绕模数必须为正整数');
        if (timestampWrap !== null && (!Number.isFinite(timestampWrap) || timestampWrap <= 0))
            throw new RangeError('时间戳回绕模数必须为正数');
        if (typeof resyncEnabled !== 'boolean') throw new TypeError('自动重新同步开关无效');
        if (!Number.isFinite(resyncDelayMs) || resyncDelayMs < 0 || resyncDelayMs > 60000)
            throw new RangeError('延迟阈值必须在 0 至 60000 ms 之间');
        if (!Number.isInteger(resyncBatches) || resyncBatches < 1 || resyncBatches > 1000)
            throw new RangeError('连续批次数必须为 1 至 1000 的整数');
        if (!Number.isFinite(resyncConfirmationMs) || resyncConfirmationMs < 0 || resyncConfirmationMs > 60000)
            throw new RangeError('确认时间必须在 0 至 60000 ms 之间');
        return { mode, sampleRate, sequenceChannelId, sequenceWrap, timestampChannelId, timestampUnit, deviceClock, timestampWrap,
            resyncEnabled, resyncDelayMs, resyncBatches, resyncConfirmationMs };
    }

    function isCounter(value) {
        return (typeof value === 'bigint' || Number.isSafeInteger(value)) && value >= 0;
    }

    function isTimestamp(value) {
        return typeof value === 'bigint' || Number.isFinite(value);
    }

    // Compare integral parts as integers so nearby uint64 timestamps keep their low bits.
    function difference(value, origin, valueScale = 1, originScale = valueScale) {
        if (typeof value === 'number' && typeof origin === 'number' && valueScale === originScale)
            return (value - origin) * valueScale;
        const valueWhole = typeof value === 'bigint' ? value : Math.trunc(value);
        const originWhole = typeof origin === 'bigint' ? origin : Math.trunc(origin);
        const valueFraction = typeof value === 'bigint' ? 0 : value - valueWhole;
        const originFraction = typeof origin === 'bigint' ? 0 : origin - originWhole;
        return Number(BigInt(valueWhole) * BigInt(valueScale) - BigInt(originWhole) * BigInt(originScale)) +
            (valueFraction * valueScale - originFraction * originScale);
    }

    function isRollover(previous, marker, modulus) {
        // A drop within the counter's middle range is treated as a device reset.
        return modulus !== null && previous >= modulus * .75 && marker <= modulus * .25;
    }

    function checkpointIndex({ entries, head }, order) {
        let low = head;
        let high = entries.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (entries[middle].order <= order) low = middle + 1;
            else high = middle;
        }
        return low - 1;
    }

    function cloneSourceTimebaseAnchors(anchors) {
        // Checkpoint records are snapshots. Replay appends to its own lists.
        return new Map(Array.from(anchors, ([streamKey, { entries, head }]) =>
            [streamKey, { entries: entries.slice(head), head: 0 }]));
    }

    class SourceTimebase {
        constructor(config, { offsetMs = 0, sharedAnchor = {}, anchors = new Map(), estimateLoss = false } = {}) {
            this.config = normalizeSourceTimebase(config);
            if (!Number.isSafeInteger(offsetMs)) throw new RangeError('时间偏移必须为整数毫秒');
            this.offsetMs = offsetMs;
            this.estimateLoss = estimateLoss && this.config.resyncEnabled;
            this.sharedAnchor = sharedAnchor;
            this.anchors = anchors;
            this.fixed = this.config.mode === 'fixed';
            this.shared = this.config.mode === 'device' && this.config.deviceClock === 'shared';
            this.sequence = this.fixed && this.config.sequenceChannelId !== null;
            this.modulus = this.fixed ? this.sequence ? this.config.sequenceWrap : null : this.config.timestampWrap;
            this.scale = this.fixed ? 1000 / this.config.sampleRate : units.get(this.config.timestampUnit) / 1000000;
            this.seenStream = false;
            this.breakPending = false;
            this.lastTime = -Infinity;
        }

        #selectStream(streamKey, order, joinPause) {
            if (this.seenStream && Object.is(this.streamKey, streamKey)) return;
            this.breakPending ||= this.seenStream && !joinPause;
            this.pendingCorrection = null;
            this.lastBatchStamp = null;
            this.seenStream = true;
            this.streamKey = streamKey;
            this.checkpoints = this.anchors.get(streamKey) ?? { entries: [], head: 0 };
            const checkpoint = isTimestamp(order) ? this.checkpoints.entries[checkpointIndex(this.checkpoints, order)] : null;
            this.origin = checkpoint?.origin ?? null;
            this.lowestBatchLag = checkpoint?.lowestBatchLag ?? Infinity;
            this.correction = checkpoint?.correction ?? null;
            this.recoverAt = checkpoint?.recoverAt ?? null;
            this.minimumTime = Math.max(this.lastTime, checkpoint?.minimumTime ?? -Infinity);
            this.previous = null;
        }

        #saveCheckpoint(order) {
            const { entries } = this.checkpoints;
            if (!isTimestamp(order) || entries.length && order <= entries.at(-1).order) return;
            if (!entries.length) this.anchors.set(this.streamKey, this.checkpoints);
            entries.push({ order, origin: this.origin, recoverAt: this.recoverAt, minimumTime: this.minimumTime,
                lowestBatchLag: this.lowestBatchLag, correction: this.correction });
        }

        pruneBefore(streamKey, order) {
            const checkpoints = this.anchors.get(streamKey);
            if (!checkpoints || !isTimestamp(order)) return;
            const keep = checkpointIndex(checkpoints, order);
            const { entries, head } = checkpoints;
            if (keep <= head) return;
            // Release old records immediately and compact the list in batches.
            if (keep >= 1024 && keep * 2 >= entries.length) {
                entries.splice(0, keep);
                checkpoints.head = 0;
            } else {
                entries.fill(undefined, head, keep);
                checkpoints.head = keep;
            }
        }

        #sharedTime(marker, receiveTime) {
            const anchor = this.sharedAnchor;
            const unit = this.config.timestampUnit;
            if (anchor.deviceTime === undefined) {
                Object.assign(anchor, { deviceTime: marker, unit, receiveTime });
                sharedHighTimes.delete(anchor);
                return receiveTime;
            }
            const elapsed = difference(marker, anchor.deviceTime, units.get(unit), units.get(anchor.unit)) / 1000000;
            const time = anchor.receiveTime + elapsed;
            const period = this.modulus * this.scale;
            if (!(period > 0) || !Number.isFinite(period)) return time;
            const reference = sharedHighTimes.get(anchor) ?? anchor.receiveTime;
            // New streams can join either side of the most recently observed rollover.
            const phase = Number(marker) * this.scale;
            const referenceElapsed = reference - time + phase;
            let cycle = Math.max(0, Math.floor(referenceElapsed / period));
            const referencePhase = referenceElapsed - cycle * period;
            if (isRollover(referencePhase, phase, period)) cycle++;
            else if (cycle && isRollover(phase, referencePhase, period)) cycle--;
            return time + cycle * period;
        }

        #reject() {
            this.breakPending = true;
            return null;
        }

        #result(time, gapStart) {
            const aligned = time + this.offsetMs;
            if (!(Math.abs(aligned) <= 8.64e15)) return this.#reject();
            const result = { time: aligned, breakBefore: this.breakPending || gapStart !== undefined };
            this.breakPending = false;
            if (gapStart !== undefined) result.gapStart = gapStart + this.offsetMs;
            return result;
        }

        #appliedCorrection(frameIndex) {
            const correction = this.correction;
            if (!correction) return 0;
            return Math.max(correction.target, correction.initial - (frameIndex - correction.frameIndex) * catchUpPerFrame);
        }

        #observeBatch(receiveTime, nominalTail, frameIndex) {
            if (receiveTime === this.lastBatchStamp) return 0;
            if (this.lastBatchStamp !== null && receiveTime - this.lastBatchStamp > Math.max(batchContinuityGapMs, 2 * this.scale))
                this.pendingCorrection = null;
            this.lastBatchStamp = receiveTime;

            // Measure against the original cadence. Moving the plot must never lower the observed baseline.
            const lag = receiveTime - nominalTail;
            this.lowestBatchLag = Math.min(this.lowestBatchLag, lag);
            const excess = lag - this.lowestBatchLag;
            const target = this.correction?.target ?? 0;
            const drift = excess - target * this.scale;
            const threshold = Math.max(this.config.resyncDelayMs, 2 * this.scale);
            if (Math.abs(drift) <= threshold) { this.pendingCorrection = null; return 0; }

            const direction = Math.sign(drift);
            const slots = Math.round(excess / this.scale);
            if (this.pendingCorrection?.direction !== direction) {
                this.pendingCorrection = { direction, since: receiveTime, count: 0, slots };
            }
            const pending = this.pendingCorrection;
            pending.count++;
            pending.slots = direction > 0 ? Math.min(pending.slots, slots) : Math.max(pending.slots, slots);
            if (pending.count < this.config.resyncBatches ||
                receiveTime - pending.since < this.config.resyncConfirmationMs) return 0;

            const applied = this.#appliedCorrection(frameIndex);
            // If delayed batches later catch up, take back the estimate without moving a plotted sample backwards.
            this.correction = { initial: Math.max(pending.slots, applied), target: pending.slots, frameIndex };
            this.pendingCorrection = null;
            return Math.max(0, Math.round(pending.slots - applied));
        }

        /** Capture order locates replay checkpoints. Frame index counts parsed samples within the source. */
        sample({ receiveTime, order, frameIndex = order, batchTail = frameIndex, marker, streamKey, joinPause = false }) {
            this.#selectStream(streamKey, order, joinPause);
            if (!Number.isFinite(receiveTime)) return this.#reject();
            if (this.config.mode === 'receive') return this.#result(receiveTime);
            if (this.fixed && !this.sequence) marker = frameIndex;
            if (!(this.fixed ? isCounter(marker) : isTimestamp(marker)) ||
                this.modulus !== null && (marker < 0 || marker >= this.modulus)) return this.#reject();

            let newSegment = false;
            if (this.recoverAt !== null) {
                if (marker < this.recoverAt) return this.#reject();
                this.recoverAt = null;
                newSegment = true;
            }
            let gapStart;
            const previous = this.previous;
            if (!this.origin) {
                this.origin = { marker, time: this.shared ? this.#sharedTime(marker, receiveTime) : Math.max(receiveTime, this.lastTime) };
                newSegment = true;
            } else if (previous) {
                let step = difference(marker, previous.marker);
                if (this.fixed && step === 0) return this.#reject();
                if (step < 0) {
                    if (isRollover(previous.marker, marker, this.modulus)) {
                        step = difference(this.modulus, previous.marker) + Number(marker);
                        this.origin = { marker, time: previous.time + step * this.scale };
                    } else if (this.shared) {
                        this.recoverAt = previous.marker;
                        this.#saveCheckpoint(order);
                        return this.#reject();
                    } else {
                        this.origin = { marker, time: Math.max(receiveTime, this.lastTime) };
                        this.breakPending = true;
                    }
                    newSegment = true;
                }
                if (this.sequence && step > 1) gapStart = previous.time + this.scale;
            }

            let time = this.origin.time + difference(marker, this.origin.marker) * this.scale;
            let missingBefore = 0;
            if (this.estimateLoss && this.fixed && !this.sequence) {
                const before = this.correction;
                missingBefore = this.#observeBatch(receiveTime, time + (batchTail - frameIndex) * this.scale, frameIndex);
                time += this.#appliedCorrection(frameIndex) * this.scale;
                newSegment ||= before !== this.correction;
            }
            if (this.shared && time < Math.max(this.minimumTime, this.lastTime)) {
                if (newSegment) this.#saveCheckpoint(order);
                return this.#reject();
            }
            if (time < this.lastTime) {
                time = this.lastTime;
                this.origin = { marker, time };
                newSegment = this.breakPending = true;
            }
            if (gapStart === undefined && this.breakPending && Number.isFinite(this.lastTime)) {
                const step = this.fixed ? this.scale : .001;
                const boundary = this.lastTime + Math.max(step, Math.abs(this.lastTime) * Number.EPSILON);
                if (boundary < time) gapStart = boundary;
            }
            const result = this.#result(time, gapStart);
            if (!result) return null;
            if (missingBefore) { result.missingBefore = missingBefore; result.period = this.scale; }
            this.lastTime = time;
            this.previous = { marker, time };
            if (newSegment) this.#saveCheckpoint(order);
            if (this.shared && this.modulus !== null)
                sharedHighTimes.set(this.sharedAnchor, Math.max(sharedHighTimes.get(this.sharedAnchor) ?? -Infinity, time));
            return result;
        }
    }

    // A single-source wave can preserve its seconds axis without copying retained samples.
    class SourcePlotTimeline {
        constructor(source, timing) {
            this.source = source;
            this.frames = source.frames;
            this.generation = source.generation;
            const rate = timing.mode === 'fixed' ? timing.sampleRate : 0;
            this.sections = [{ from: 0, rate, start: 0, offset: -this.frames.originTimestamp }];
        }

        get valid() { return this.source.frames === this.frames && this.source.generation === this.generation; }

        timestampAt(index) {
            const ordinal = this.frames.frameOrdinalAt(index);
            let low = 1, high = this.sections.length;
            while (low < high) {
                const mid = (low + high) >>> 1;
                if (this.sections[mid].from <= ordinal) low = mid + 1; else high = mid;
            }
            const { from, rate, start, offset } = this.sections[low - 1];
            return rate ? start + (ordinal - from) * 1000 / rate : this.frames.timestampAt(index) + offset;
        }

        change(timing) {
            const last = this.frames.length - 1;
            const ordinal = this.frames.frameOrdinalAt(last);
            const secondsAxis = this.timestampAt(last);
            if (!Number.isFinite(secondsAxis)) return;
            const rate = timing.mode === 'fixed' ? timing.sampleRate : 0, from = ordinal + 1;
            const start = rate ? secondsAxis + 1000 / rate : secondsAxis;
            const offset = secondsAxis - this.frames.timestampAt(last);
            if (this.sections.at(-1).from === from) this.sections.pop();
            this.sections.push({ from, rate, start, offset });
            const first = this.frames.frameOrdinalAt(0);
            while (this.sections.length > 1 && this.sections[1].from <= first) this.sections.shift();
        }
    }

    const api = { normalizeSourceTimebase, SourceTimebase, cloneSourceTimebaseAnchors, SourcePlotTimeline };
    if (typeof module !== 'undefined') module.exports = api;
    globalThis.SerialPlotter ??= {};
    Object.assign(globalThis.SerialPlotter, api);
})();

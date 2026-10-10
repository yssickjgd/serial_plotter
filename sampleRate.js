/** Estimate the sample clock from received packets, independently of UI timer cadence. */
class SampleRateEstimator {
    constructor() { this.reset(); }

    reset({ keepRate = false } = {}) {
        this.rate = keepRate ? this.rate ?? 0 : 0;
        this.points = [];
        this.head = 0;
        this.lastCount = null;
        this.lastMeasuredAt = null;
        this.pending = null;
    }

    observe(count, arrival) {
        if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(arrival)) return;
        if (this.lastCount !== null && count < this.lastCount) this.reset();
        if (count === 0) return;
        const last = this.points.at(-1);
        if ((last && arrival < last.arrival) || count === this.lastCount) return;
        this.lastCount = count;
        if (last?.arrival === arrival) last.count = count;
        else this.points.push({ count, arrival });
        while (this.head + 1 < this.points.length && this.points[this.head + 1].arrival <= arrival - 10000) this.head++;
        if (this.head > 1024) { this.points = this.points.slice(this.head); this.head = 0; }
        const first = this.points[this.head];
        this.lastMeasuredAt ??= arrival;
        if (arrival - first.arrival < 2000 || arrival - this.lastMeasuredAt < 1000) return;
        this.lastMeasuredAt = arrival;
        const measured = (count - first.count) * 1000 / (arrival - first.arrival);
        if (!(measured > 0)) return;
        if (!this.rate) { this.rate = Number(measured.toPrecision(6)); return; }
        // Changes below 0.2% are within packet-arrival uncertainty. Larger changes
        // must persist for three seconds before replacing the displayed clock.
        const difference = measured - this.rate;
        if (Math.abs(difference) <= this.rate * .002) { this.pending = null; return; }
        const direction = Math.sign(difference);
        if (this.pending?.direction !== direction) this.pending = { direction, since: arrival };
        if (arrival - this.pending.since >= 3000) {
            this.rate = Number(measured.toPrecision(6));
            this.pending = null;
        }
    }
}

if (typeof module !== 'undefined') module.exports = { SampleRateEstimator };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.SampleRateEstimator = SampleRateEstimator;

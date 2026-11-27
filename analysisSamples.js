/** Read native packet sequences alongside synchronized analysis tables. */
(function (root) {
    const S = root.SerialPlotter ??= {};
    const eventTime = event => event.traceTime ?? event.timestamp;
    function nativeChannelEvents(frames, channel) {
        return frames.events instanceof Map && channel < frames.rawChannelCount ? frames.events.get(channel) ?? [] : null;
    }
    function nativeEventEnd(events, time) {
        let lo = 0, hi = events.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (eventTime(events[mid]) <= time) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    function nativeEventRate(first, last, count) {
        if (last?.origin?.sampleRate > 0) return last.origin.sampleRate;
        if (!first || !last) return 0;
        const span = (last.origin?.captureTime ?? eventTime(last)) - (first.origin?.captureTime ?? eventTime(first));
        return span > 0 && count > 1 ? (count - 1) * 1000 / span : 0;
    }
    const methods = { nativeChannelEvents, nativeEventEnd, nativeEventRate };
    S.AnalysisSamples = methods;
    if (typeof module !== 'undefined') module.exports = methods;
})(globalThis);

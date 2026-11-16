/** Silence is a recovery boundary for pending bytes, never a substitute for frame parsing. */
(function(root) {
    function configureFrameIdleTimeout(parser, { timeoutMs = 0, ...clock } = {}) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
            throw new RangeError('空闲超时必须为 0–2147483647 毫秒');
        if (parser.idleTimeout) throw new Error('解析器空闲超时已配置');
        let timer = null, version = 0, deadline = NaN;
        const originalReset = parser.reset, originalAppend = parser.appendData;
        const pending = () => parser.length ?? parser.writeOffset - parser.readOffset;
        const state = {
            now: () => performance.now(), setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
            clearTimeout: handle => globalThis.clearTimeout(handle), ...clock,
            setClock(next) { for (const key of ['now','setTimeout','clearTimeout']) if (next[key]) state[key] = next[key]; },
            expireAt(arrival) {
                if (timeoutMs && pending() && arrival >= deadline) parser.flushPending('timeout');
            },
            cancel() { version++; if (timer !== null) state.clearTimeout(timer); timer = null; }
        };
        const schedule = () => {
            state.cancel();
            if (!timeoutMs || parser.suspendTimers || !pending() || !Number.isFinite(deadline)) return;
            const revision = version;
            timer = state.setTimeout(() => {
                if (revision !== version) return;
                timer = null;
                if (!pending()) return;
                if (state.now() < deadline) schedule();
                else parser.flushPending('timeout');
            }, Math.max(0, deadline - state.now()));
            timer?.unref?.();
        };
        parser.idleTimeout = state;
        parser.reset = function(...args) { state.cancel(); deadline = NaN; return originalReset.apply(this, args); };
        parser.appendData = function(data, metadata = {}) {
            if (!data?.length && !data?.byteLength) return originalAppend.call(this, data, metadata);
            const arrival = Number.isFinite(metadata.arrival) ? metadata.arrival : state.now();
            state.expireAt(arrival);
            const result = originalAppend.call(this, data, metadata);
            deadline = pending() ? arrival + timeoutMs : NaN;
            schedule();
            return result;
        };
        parser.resumeTimers = function() { this.suspendTimers = false; schedule(); };
        return parser;
    }
    root.SerialPlotter ??= {}; root.SerialPlotter.configureFrameIdleTimeout = configureFrameIdleTimeout;
    if (typeof module !== 'undefined') module.exports = { configureFrameIdleTimeout };
})(globalThis);

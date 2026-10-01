/** Apply a channel's optional linear display calibration without changing stored samples. */
function transformChannelValue(value, channel = {}) {
    if (!Number.isFinite(value)) return NaN;
    const gain = channel.gainEnabled ? Number(channel.gain) : 1;
    const offset = channel.offsetEnabled ? Number(channel.offset) : 0;
    const transformed = value * gain + offset;
    return Number.isFinite(transformed) ? transformed : NaN;
}

if (typeof module !== 'undefined') module.exports = { transformChannelValue };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.transformChannelValue = transformChannelValue;

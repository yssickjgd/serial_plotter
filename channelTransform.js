/** Channel indices are zero based in views; references and registry numbers are one based. */
function formatChannelId(index) {
    return `CH${String(index + 1).padStart(5, '0')}`;
}

function formatChannelNumber(number) { return formatChannelId(number - 1); }

function parseChannelId(text) {
    const match = typeof text === 'string' && text.match(/^CH(\d+)$/);
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : null;
}

/** Apply a channel's optional linear display calibration without changing stored samples. */
function transformChannelValue(value, channel = {}) {
    if (!Number.isFinite(value)) return NaN;
    const gain = channel.gainEnabled ? Number(channel.gain) : 1;
    const offset = channel.offsetEnabled ? Number(channel.offset) : 0;
    const transformed = value * gain + offset;
    return Number.isFinite(transformed) ? transformed : NaN;
}

if (typeof module !== 'undefined') module.exports = { transformChannelValue, formatChannelId, formatChannelNumber, parseChannelId };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { transformChannelValue, formatChannelId, formatChannelNumber, parseChannelId });

/** Return chronological extrema for each horizontal pixel bucket. */
function bucketExtrema(values, pixels, first = 0, limit = values.length) {
    const size = Math.max(1, Math.ceil((limit - first) / Math.max(1, Math.floor(pixels))));
    const result = [];
    for (let start = first; start < limit; start += size) {
        const end = Math.min(limit, start + size);
        let minIndex = -1, maxIndex = -1;
        for (let i = start; i < end; i++) {
            if (!Number.isFinite(values[i])) continue;
            if (minIndex === -1 || values[i] < values[minIndex]) minIndex = i;
            if (maxIndex === -1 || values[i] > values[maxIndex]) maxIndex = i;
        }
        if (minIndex === -1) continue;
        if (minIndex <= maxIndex) {
            result.push({ index: minIndex, value: values[minIndex] });
            if (maxIndex !== minIndex) result.push({ index: maxIndex, value: values[maxIndex] });
        } else {
            result.push({ index: maxIndex, value: values[maxIndex] });
            result.push({ index: minIndex, value: values[minIndex] });
        }
    }
    if (limit > first && Number.isFinite(values[first]) && result[0]?.index !== first)
        result.unshift({ index: first, value: values[first] });
    if (limit > first && Number.isFinite(values[limit - 1]) && result.at(-1)?.index !== limit - 1)
        result.push({ index: limit - 1, value: values[limit - 1] });
    return result;
}

/** Keep extrema and gap endpoints in buckets anchored to the source coordinates. */
function bucketTraceExtrema(values, pixels, { firstIndex = 0, times, timeSpan } = {}) {
    const points = [];
    const count = Math.max(1, Math.floor(pixels));
    // Power-of-two time intervals keep the bucket grid steady through small changes in span.
    const size = times ? (timeSpan > 0 ? 2 ** Math.ceil(Math.log2(timeSpan / count)) : Infinity)
        : Math.max(1, Math.ceil(values.length / count));
    let bucket, minIndex, maxIndex, previous = -1;
    const append = (index, gap = false) => {
        if (points.at(-1)?.index !== index) {
            const point = { index, value: values[index] };
            if (gap) point.break = true;
            points.push(point);
        }
    };
    const flush = () => {
        append(Math.min(minIndex, maxIndex));
        append(Math.max(minIndex, maxIndex));
    };
    for (let i = 0; i < values.length; i++) {
        const value = values[i], x = times ? times[i] : firstIndex + i;
        if (!Number.isFinite(value) || !Number.isFinite(x)) {
            if (previous >= 0) {
                flush();
                append(previous);
                previous = -1;
            }
            continue;
        }
        const nextBucket = Math.floor(x / size);
        if (previous < 0 || nextBucket !== bucket) {
            if (previous < 0) append(i, i > 0);
            else flush();
            bucket = nextBucket;
            minIndex = maxIndex = i;
        } else {
            if (value < values[minIndex]) minIndex = i;
            if (value > values[maxIndex]) maxIndex = i;
        }
        previous = i;
    }
    if (previous >= 0) {
        flush();
        append(previous);
    }
    return points;
}

/** Keep ordered pixel extrema and split the trace at gaps or jumps above maxStep. */
function bucketAxisExtrema(values, xPositions, maxStep = Infinity, pixelScale = 1) {
    const result = [];
    const splitOnJump = Number.isFinite(maxStep);
    let pixel = -1, minIndex = -1, maxIndex = -1;
    let broken = false;
    const flush = () => {
        if (minIndex < 0) return;
        const first = Math.min(minIndex, maxIndex);
        const last = Math.max(minIndex, maxIndex);
        result.push({ index: first, value: values[first], ...(broken ? { break: true } : {}) });
        broken = false;
        if (last !== first) result.push({ index: last, value: values[last] });
    };
    for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i]) || !Number.isFinite(xPositions[i])) {
            flush(); minIndex = maxIndex = pixel = -1; broken = true; continue;
        }
        const nextPixel = Math.floor(xPositions[i] * pixelScale);
        const jump = splitOnJump && Math.abs(values[i] - values[i - 1]) > maxStep;
        if (nextPixel !== pixel || jump) {
            flush();
            if (jump) broken = true;
            pixel = nextPixel;
            minIndex = maxIndex = i;
        } else {
            if (values[i] < values[minIndex]) minIndex = i;
            if (values[i] > values[maxIndex]) maxIndex = i;
        }
    }
    flush();
    const firstValid = values.findIndex(Number.isFinite);
    if (firstValid >= 0 && result[0]?.index !== firstValid)
        result.unshift({ index: firstValid, value: values[firstValid] });
    let lastValid = values.length - 1;
    while (lastValid >= 0 && !Number.isFinite(values[lastValid])) lastValid--;
    if (lastValid >= 0 && result.at(-1)?.index !== lastValid)
        result.push({ index: lastValid, value: values[lastValid] });
    return result;
}

/** Format a zero-based channel index for labels, default names, and exports. */
function formatChannelId(index) {
    return `CH${String(index + 1).padStart(5, '0')}`;
}

function csvField(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A zero-inclusive log scale with an exactly linear region below 1% of the visible peak. */
function adaptiveLogScale(peak, max) {
    const extent = Number.isFinite(peak) && peak > 0 ? Math.min(peak, max) : max;
    return { type: 'log-linear',
        linearThreshold: peak > 0 ? Math.max(Number.MIN_VALUE, extent * 0.01) : max };
}

function positiveLogBounds(minPositive, maxPositive, maxDynamicRatio = 1e6) {
    if (!(maxPositive > 0)) return [1e-6, 1];
    const floor = Math.max(minPositive, maxPositive / maxDynamicRatio);
    const span = Math.log(maxPositive) - Math.log(floor);
    const factor = Math.exp(span > 1e-9 ? Math.min(Math.log(1.3), span * 0.08) : Math.log(1.1));
    const min = Math.max(Number.MIN_VALUE, floor / factor);
    const max = Math.min(Number.MAX_VALUE, maxPositive * factor);
    return [min, max > min ? max : Math.min(Number.MAX_VALUE, min * 2)];
}

function axisToDomain(value, scale = 'linear') {
    if (scale === 'log') return value > 0 ? Math.log(value) : NaN;
    if (scale?.type === 'log-linear') {
        const threshold = scale.linearThreshold;
        const magnitude = Math.abs(value);
        return Math.sign(value) * (magnitude <= threshold ? magnitude / threshold
            : 1 + Math.log(magnitude) - Math.log(threshold));
    }
    return value;
}

function axisFromDomain(value, scale = 'linear') {
    if (scale === 'log') return Math.exp(value);
    if (scale?.type === 'log-linear') {
        const magnitude = Math.abs(value);
        return Math.sign(value) * (magnitude <= 1 ? magnitude * scale.linearThreshold
            : Math.exp(Math.log(scale.linearThreshold) + magnitude - 1));
    }
    return value;
}

/** Map original values to axis positions; tick labels retain the original amplitude. */
function axisFraction(value, min, max, scale = 'linear') {
    if (!(max > min)) return NaN;
    if (scale !== 'linear') {
        const start = axisToDomain(min, scale);
        return (axisToDomain(value, scale) - start) / (axisToDomain(max, scale) - start);
    }
    const span = max - min;
    return Number.isFinite(span) ? (value - min) / span : (value / 2 - min / 2) / (max / 2 - min / 2);
}

function axisValueAtFraction(fraction, min, max, scale = 'linear') {
    if (!(max > min)) return NaN;
    if (scale !== 'linear') {
        const start = axisToDomain(min, scale);
        const end = axisToDomain(max, scale);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return NaN;
        if (fraction === 0) return min;
        if (fraction === 1) return max;
        return axisFromDomain(start + (end - start) * fraction, scale);
    }
    if (fraction === 0) return min;
    if (fraction === 1) return max;
    const span = max - min;
    return Number.isFinite(span) ? min + span * fraction : min * (1 - fraction) + max * fraction;
}

/** Fractions increase rightward in X and upward in Y, independently of axis scale. */
function plotSelectionFractions(x0, y0, x1, y1, { left = 0, right, top = 0, bottom }) {
    const width = right - left, height = bottom - top;
    const xMin = Math.max(left, Math.min(x0, x1)), xMax = Math.min(right, Math.max(x0, x1));
    const yMin = Math.max(top, Math.min(y0, y1)), yMax = Math.min(bottom, Math.max(y0, y1));
    if (!(xMax - xMin >= 6 && yMax - yMin >= 6)) return null;
    return [(xMin - left) / width, (xMax - left) / width, 1 - (yMax - top) / height, 1 - (yMin - top) / height];
}

/** Convert a dragged plot rectangle into an inclusive sample window and Y range. */
function zoomRectToBounds({ x0, y0, x1, y1, plotWidth, plotHeight,
    startIndex, visibleCount, min, max, xScale = 'linear', yScale = 'linear', indexAtFraction }) {
    if (plotWidth <= 0 || plotHeight <= 0 || visibleCount < 2 || max <= min) return null;
    const fractions = plotSelectionFractions(x0, y0, x1, y1, { right: plotWidth, bottom: plotHeight });
    if (!fractions) return null;
    const [left, right, low, high] = fractions;
    const endIndex = startIndex + visibleCount - 1;
    const indexAt = indexAtFraction ?? (ratio => axisValueAtFraction(ratio, startIndex, endIndex, xScale));
    const first = Math.ceil(indexAt(left, false));
    const last = Math.floor(indexAt(right, true));
    if (last <= first) return null;
    return {
        scrollOffset: first,
        displayCount: last - first + 1,
        yMin: axisValueAtFraction(low, min, max, yScale),
        yMax: axisValueAtFraction(high, min, max, yScale)
    };
}

/** The plot and the horizontal tick band zoom X. The right tick band zooms Y. */
function plotWheelAxis(x, y, { left = 0, top = 0, right, width, height }) {
    if (!(x >= left && x <= width && y >= top && y <= height)) return null;
    return x > right ? 'y' : 'x';
}

function layoutAxisTickLabels(ticks, width) {
    const candidates = [];
    for (const { text, x, pixels } of ticks) {
        if (!text || pixels > width || text === candidates.at(-1)?.text) continue;
        const left = Math.max(0, Math.min(width - pixels, x - pixels / 2));
        candidates.push({ text, left, pixels });
    }
    const visible = [], gap = 8, last = candidates.at(-1);
    let boundary = -Infinity;
    for (const tick of candidates) {
        if (tick.left < boundary || (tick !== last && visible.length && tick.left + tick.pixels + gap > last.left)) continue;
        visible.push(tick);
        boundary = tick.left + tick.pixels + gap;
    }
    return visible;
}

function zoomAxisBounds(min, max, anchorRatio, delta, limits, scale = 'linear') {
    if (scale !== 'linear') {
        const domain = limits?.map(value => axisToDomain(value, scale));
        const bounds = zoomAxisBounds(axisToDomain(min, scale), axisToDomain(max, scale), anchorRatio, delta, domain);
        if (!bounds) return null;
        if (domain && bounds[0] === domain[0] && bounds[1] === domain[1]) return [...limits];
        const next = bounds.map(value => axisFromDomain(value, scale));
        return next.every(Number.isFinite) && next[1] > next[0] ? next : null;
    }
    const factor = delta < 0 ? .8 : 1.25;
    const span = max - min;
    if (!(span > 0)) return null;
    if (!limits) {
        const anchor = min * (1 - anchorRatio) + max * anchorRatio;
        const next = [anchor * (1 - factor) + min * factor, anchor * (1 - factor) + max * factor];
        return next.every(Number.isFinite) && next[1] > next[0] ? next : null;
    }
    const [lower, upper] = limits, available = upper - lower;
    const nextSpan = Math.min(available, span * factor);
    if (!(nextSpan > 0)) return null;
    if (nextSpan >= available * (1 - 1e-12)) return [...limits];
    const anchor = min + anchorRatio * span;
    const first = Math.max(lower, Math.min(upper - nextSpan, anchor - anchorRatio * nextSpan));
    const next = [first, first + nextSpan];
    return next.every(Number.isFinite) && next[1] > next[0] ? next : null;
}

/** Round the displayed decimal without converting it back to a binary float. */
function formatDisplayNumber(value, digits = 6) {
    if (!Number.isFinite(value)) return String(value);
    return trimDecimalZeros(value.toPrecision(digits));
}

function trimDecimalZeros(text) {
    return text.replace(/(\.\d*?[1-9])0+(?=e|$)|\.0+(?=e|$)/g, '$1');
}

function expandExponential(text) {
    const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(text);
    if (!match) return text;
    const [, sign, whole, decimals = '', exponent] = match;
    const digits = whole + decimals, point = whole.length + Number(exponent);
    if (point <= 0) return sign + '0.' + '0'.repeat(-point) + digits;
    if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
    return sign + digits.slice(0, point) + '.' + digits.slice(point);
}

const maxAxisSignificantDigits = 15;
const axisNumberDefaults = Object.freeze({ mode: 'significant', significantDigits: 0, decimalPlaces: 6, notation: 'auto' });
const axisNumberFieldNames = ['PrecisionMode', 'SignificantDigits', 'DecimalPlaces', 'NumberNotation'];

function readAxisNumberFormat(settings, axis, defaults = axisNumberDefaults) {
    const get = (key, fallback) => settings[axis + key] === undefined ? fallback : settings[axis + key];
    return { mode: get('PrecisionMode', defaults.mode), significantDigits: get('SignificantDigits', defaults.significantDigits),
        decimalPlaces: get('DecimalPlaces', defaults.decimalPlaces), notation: get('NumberNotation', defaults.notation) };
}

function normalizeAxisNumberSettings(settings) {
    const result = {};
    const integer = (value, name) => {
        const text = String(value).trim(), digits = Number(text);
        if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(text) || digits > maxAxisSignificantDigits)
            throw new RangeError(name + '须为 0 至 ' + maxAxisSignificantDigits + ' 的整数');
        return digits;
    };
    for (const [axis, label] of [['x', '横轴'], ['y', '纵轴']]) {
        const { mode, significantDigits, decimalPlaces, notation } = readAxisNumberFormat(settings, axis);
        if (!['significant', 'decimal'].includes(mode)) throw new Error(label + '精度方式无效');
        if (!['auto', 'plain', 'scientific'].includes(notation)) throw new Error(label + '计数法无效');
        result[axis + 'PrecisionMode'] = mode;
        result[axis + 'SignificantDigits'] = integer(significantDigits, label + '有效数字位数');
        result[axis + 'DecimalPlaces'] = integer(decimalPlaces, label + '小数位数');
        result[axis + 'NumberNotation'] = notation;
    }
    return result;
}

function customAxisNumberFormat(format) {
    return format.mode === 'decimal' || format.significantDigits > 0 || format.notation !== 'auto';
}

function formatAxisValue(value, format = axisNumberDefaults, autoDigits = 6) {
    if (!Number.isFinite(value)) return String(value);
    if (format.mode === 'decimal') {
        const places = format.decimalPlaces;
        if (format.notation === 'scientific' || format.notation === 'auto' && Math.abs(value) >= 1e21)
            return value.toExponential(places);
        if (Math.abs(value) >= 1e21) return expandExponential(String(value)) + (places ? '.' + '0'.repeat(places) : '');
        const text = value.toFixed(places);
        return text.startsWith('-') && Number(text) === 0 ? text.slice(1) : text;
    }
    const digits = format.significantDigits || autoDigits;
    if (format.notation === 'scientific') return trimDecimalZeros(value.toExponential(digits - 1));
    const text = formatDisplayNumber(value, digits);
    return format.notation === 'plain' ? expandExponential(text) : text;
}

function formatPlotAxisCoordinate(value, format) {
    if (customAxisNumberFormat(format)) return formatAxisValue(value, format);
    return Number(value && Math.abs(value) < .001 ? value.toPrecision(4) : value.toFixed(3));
}

if (typeof module !== 'undefined') module.exports = {
    adaptiveLogScale, positiveLogBounds, axisFromDomain, axisToDomain, axisFraction, axisValueAtFraction,
    bucketAxisExtrema, bucketExtrema, bucketTraceExtrema, csvField, formatChannelId, zoomRectToBounds,
    formatDisplayNumber, maxAxisSignificantDigits, axisNumberFieldNames, readAxisNumberFormat, normalizeAxisNumberSettings,
    customAxisNumberFormat, formatAxisValue, formatPlotAxisCoordinate, plotWheelAxis, layoutAxisTickLabels, zoomAxisBounds, plotSelectionFractions
};
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, {
    adaptiveLogScale, positiveLogBounds, axisFromDomain, axisToDomain, axisFraction, axisValueAtFraction,
    bucketAxisExtrema, bucketExtrema, bucketTraceExtrema, csvField, formatChannelId, zoomRectToBounds,
    formatDisplayNumber, maxAxisSignificantDigits, axisNumberFieldNames, readAxisNumberFormat, normalizeAxisNumberSettings,
    customAxisNumberFormat, formatAxisValue, formatPlotAxisCoordinate, plotWheelAxis, layoutAxisTickLabels, zoomAxisBounds, plotSelectionFractions
});

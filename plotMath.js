/** Return chronological extrema for each horizontal pixel bucket. */
function bucketExtrema(values, pixels) {
    const size = Math.max(1, Math.ceil(values.length / Math.max(1, Math.floor(pixels))));
    const result = [];
    for (let start = 0; start < values.length; start += size) {
        const end = Math.min(values.length, start + size);
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
    if (values.length && Number.isFinite(values[0]) && result[0].index !== 0)
        result.unshift({ index: 0, value: values[0] });
    if (values.length && Number.isFinite(values[values.length - 1]) && result[result.length - 1].index !== values.length - 1)
        result.push({ index: values.length - 1, value: values[values.length - 1] });
    return result;
}

/** Keep chronological extrema for samples sharing the same horizontal pixel. */
function bucketAxisExtrema(values, xPositions) {
    const result = [];
    let pixel = -1, minIndex = -1, maxIndex = -1;
    const flush = () => {
        if (minIndex < 0) return;
        const first = Math.min(minIndex, maxIndex);
        const last = Math.max(minIndex, maxIndex);
        result.push({ index: first, value: values[first] });
        if (last !== first) result.push({ index: last, value: values[last] });
    };
    for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i]) || !Number.isFinite(xPositions[i])) continue;
        const nextPixel = Math.floor(xPositions[i]);
        if (nextPixel !== pixel) {
            flush();
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
    return `CH${String(index + 1).padStart(2, '0')}`;
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
    return (value - min) / (max - min);
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
    return min + (max - min) * fraction;
}

/** Convert a dragged plot rectangle into an inclusive sample window and Y range. */
function zoomRectToBounds({ x0, y0, x1, y1, plotWidth, plotHeight,
    startIndex, visibleCount, min, max, xScale = 'linear', yScale = 'linear' }) {
    if (plotWidth <= 0 || plotHeight <= 0 || visibleCount < 2 || max <= min) return null;
    const left = Math.max(0, Math.min(plotWidth, Math.min(x0, x1)));
    const right = Math.max(0, Math.min(plotWidth, Math.max(x0, x1)));
    const top = Math.max(0, Math.min(plotHeight, Math.min(y0, y1)));
    const bottom = Math.max(0, Math.min(plotHeight, Math.max(y0, y1)));
    if (right - left < 6 || bottom - top < 6) return null;
    const endIndex = startIndex + visibleCount - 1;
    const first = Math.ceil(axisValueAtFraction(left / plotWidth, startIndex, endIndex, xScale));
    const last = Math.floor(axisValueAtFraction(right / plotWidth, startIndex, endIndex, xScale));
    if (last <= first) return null;
    return {
        scrollOffset: first,
        displayCount: last - first + 1,
        yMin: axisValueAtFraction(1 - bottom / plotHeight, min, max, yScale),
        yMax: axisValueAtFraction(1 - top / plotHeight, min, max, yScale)
    };
}

if (typeof module !== 'undefined') module.exports = {
    adaptiveLogScale, axisFromDomain, axisToDomain, axisFraction, axisValueAtFraction,
    bucketAxisExtrema, bucketExtrema, csvField, formatChannelId, zoomRectToBounds
};
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, {
    adaptiveLogScale, axisFromDomain, axisToDomain, axisFraction, axisValueAtFraction,
    bucketAxisExtrema, bucketExtrema, csvField, formatChannelId, zoomRectToBounds
});

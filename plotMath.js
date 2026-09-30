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

function csvField(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Convert a dragged plot rectangle into an inclusive sample window and Y range. */
function zoomRectToBounds({ x0, y0, x1, y1, plotWidth, plotHeight,
    startIndex, visibleCount, min, max }) {
    if (plotWidth <= 0 || plotHeight <= 0 || visibleCount < 2 || max <= min) return null;
    const left = Math.max(0, Math.min(plotWidth, Math.min(x0, x1)));
    const right = Math.max(0, Math.min(plotWidth, Math.max(x0, x1)));
    const top = Math.max(0, Math.min(plotHeight, Math.min(y0, y1)));
    const bottom = Math.max(0, Math.min(plotHeight, Math.max(y0, y1)));
    if (right - left < 6 || bottom - top < 6) return null;
    const first = startIndex + Math.ceil(left / plotWidth * (visibleCount - 1));
    const last = startIndex + Math.floor(right / plotWidth * (visibleCount - 1));
    if (last <= first) return null;
    return {
        scrollOffset: first,
        displayCount: last - first + 1,
        yMin: max - bottom / plotHeight * (max - min),
        yMax: max - top / plotHeight * (max - min)
    };
}

if (typeof module !== 'undefined') module.exports = { bucketExtrema, csvField, zoomRectToBounds };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { bucketExtrema, csvField, zoomRectToBounds });

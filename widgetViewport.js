/** Portable per-widget viewport settings. Source coordinates are computed only at restore. */
function viewportObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function viewportBounds(value) {
    if (!viewportObject(value) || !Number.isFinite(value.min) ||
        !Number.isFinite(value.max) || value.max <= value.min)
        throw new TypeError('Viewport Y bounds must be finite and ordered');
    return { min: value.min, max: value.max };
}

function viewportYScale(value) {
    if (value === 'linear' || value === 'log') return value;
    if (viewportObject(value) && value.type === 'log-linear' &&
        Number.isFinite(value.linearThreshold) && value.linearThreshold > 0)
        return { type: 'log-linear', linearThreshold: value.linearThreshold };
    throw new TypeError('Viewport Y scale is invalid');
}

function normalizeViewportYZoom(value) {
    if (value === undefined || value === null) return null;
    const result = viewportBounds(value);
    if (value.base !== undefined) {
        result.base = viewportBounds(value.base);
        result.base.yScale = viewportYScale(value.base.yScale);
        if (result.base.yScale === 'log' && (result.base.min <= 0 || result.min <= 0))
            throw new TypeError('Logarithmic viewport bounds must be positive');
    }
    return result;
}

function normalizeWidgetViewport(input) {
    if (!viewportObject(input)) throw new TypeError('Widget viewport must be an object');
    const result = {};
    for (const mode of ['time', 'frequency', ...(input.phase ? ['phase'] : [])]) {
        const view = input[mode];
        if (!viewportObject(view) || !Number.isFinite(view.displayCount) || view.displayCount <= 0 ||
            typeof view.autoFollow !== 'boolean' || !Number.isFinite(view.startFraction) ||
            view.startFraction < 0 || view.startFraction > 1)
            throw new TypeError('Widget viewport range is invalid');
        result[mode] = { displayCount: view.displayCount, autoFollow: view.autoFollow,
            startFraction: view.startFraction, yZoom: normalizeViewportYZoom(view.yZoom) };
    }
    return result;
}

/** Derive FFT bins from the input window without calculating or replacing spectra. */
function widgetFrequencyTotal(plotter) {
    if (plotter.frames.responseMode) return Math.max(0, ...[...plotter.frames.entries.keys()]
        .map(number => plotter.frames.frequencyForChannel(number - 1).mags.length));
    const total = plotter.frames.rawMode ? 0 : plotter.frames.length;
    let count = Math.min(total, plotter.plotWindowPoints);
    if (plotter.isPaused) {
        const view = plotter.vp.time;
        const span = Math.max(2, Math.floor(view.displayCount));
        let start = Math.max(0, Math.floor(view.scrollOffset));
        if (start >= total) start = Math.max(0, total - span);
        if (plotter._timeCenterOrder !== null && plotter._timeCenterOrder !== undefined) {
            const center = plotter.frames.indexAtOrAfterOrder(plotter._timeCenterOrder);
            if (plotter.frames.orderAt(center) === plotter._timeCenterOrder) {
                const centeredStart = center - Math.floor(span / 2);
                count = Math.min(total, centeredStart + span) - Math.max(0, centeredStart);
            } else count = Math.min(span, total - start);
        } else count = Math.min(span, total - start);
    }
    return count >= 2 ? 2 ** Math.ceil(Math.log2(count)) / 2 + 1 : 0;
}

function captureWidgetViewport(plotter) {
    const result = {};
    for (const mode of ['time', 'frequency', ...(plotter.vp.phase ? ['phase'] : [])]) {
        const view = plotter.vp[mode];
        const total = mode === 'time' ? (plotter.frames.rawMode ? 0 : plotter.frames.length)
            : widgetFrequencyTotal(plotter);
        const travel = Math.max(0, total - view.displayCount);
        const zoom = plotter._boxZoomY?.[mode];
        const base = plotter._zoomBaseY?.[mode];
        result[mode] = { displayCount: view.displayCount, autoFollow: view.autoFollow,
            startFraction: travel > 0 ? Math.max(0, Math.min(1, view.scrollOffset / travel)) : 0,
            yZoom: zoom ? { ...viewportBounds(zoom), ...(base ? { base: {
                ...viewportBounds(base), yScale: viewportYScale(base.yScale) } } : {}) } : null };
    }
    return normalizeWidgetViewport(result);
}

function restoreWidgetViewport(plotter, input) {
    const state = normalizeWidgetViewport(input);
    if (!plotter.frames.length || plotter.frames.rawMode) return false;
    for (const mode of ['time', 'frequency', ...(plotter.vp.phase ? ['phase'] : [])]) {
        const saved = state[mode] ?? state.frequency, view = plotter.vp[mode];
        view.displayCount = saved.displayCount;
        view.autoFollow = saved.autoFollow;
        const total = mode === 'time' ? plotter.frames.length : widgetFrequencyTotal(plotter);
        const travel = Math.max(0, total - view.displayCount);
        view.scrollOffset = saved.autoFollow ? travel : Math.round(saved.startFraction * travel);
        const zoom = saved.yZoom;
        plotter._boxZoomY[mode] = zoom ? { min: zoom.min, max: zoom.max } : null;
        if (!zoom) plotter._zoomBaseY[mode] = null;
        else if (zoom.base) plotter._zoomBaseY[mode] = zoom.base;
        else {
            const bounds = plotter.yBounds[mode];
            plotter._zoomBaseY[mode] = {
                min: Math.min(bounds.min, zoom.min), max: Math.max(bounds.max, zoom.max),
                yScale: mode === 'frequency' && plotter.magnitudeUnit !== 'db' ? plotter.freqYScale : 'linear'
            };
        }
        if (mode === 'time') {
            const center = Math.min(plotter.frames.length - 1,
                view.scrollOffset + Math.floor(Math.max(2, Math.floor(view.displayCount)) / 2));
            plotter._timeCenterOrder = saved.autoFollow ? null : plotter.frames.orderAt(center);
            plotter._timeWindowStartOrder = plotter.frames.orderAt(Math.floor(view.scrollOffset));
        } else plotter._cachedScrollTotal = total;
    }
    plotter._scrollbarDirty = true;
    plotter._markViewDirty();
    plotter._updateScrollbar();
    plotter._updateYScrollbar();
    return true;
}

const WidgetViewport = { captureWidgetViewport, normalizeWidgetViewport, restoreWidgetViewport };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.WidgetViewport = WidgetViewport;
if (typeof module !== 'undefined') module.exports = WidgetViewport;

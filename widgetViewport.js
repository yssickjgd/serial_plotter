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
        if (mode === 'time' && view.followLag != null) {
            if (!Number.isFinite(view.followLag) || view.followLag < 0)
                throw new TypeError('时域跟随滞后点数无效');
            result.time.followLag = view.followLag;
        }
        if (mode === 'time' && view.followTime != null) {
            const { lag, span } = view.followTime;
            if (!Number.isFinite(lag) || lag < 0 || !Number.isFinite(span) || span <= 0)
                throw new TypeError('时域跟随的滞后或跨度无效');
            result.time.followTime = { lag, span };
        }
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
        const range = plotter._frequencyInputRange();
        count = range.end - range.start;
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
        if (mode === 'time') {
            result.time.followLag = view.followLag;
            result.time.followTime = view.followTime;
            if (!view.autoFollow && view.followTime) {
                const extent = plotter._timeExtent(), bounds = extent && plotter._timeZoomBounds();
                if (bounds) {
                    const travelMs = extent.last - extent.first - view.followTime.span;
                    result.time.startFraction = travelMs > 0
                        ? Math.max(0, Math.min(1, (bounds.first - extent.first) / travelMs)) : 0;
                    result.time.followTime = { lag: Math.max(0, extent.last - bounds.last), span: view.followTime.span };
                }
            }
        }
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
        const start = saved.startFraction * travel;
        view.scrollOffset = saved.autoFollow
            ? Math.max(0, travel - (saved.followLag ?? 0))
            : mode === 'time' ? Math.round(start) : start;
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
            view.followLag = saved.followLag;
            view.followTime = saved.followTime;
            plotter._frozenTimeEnd = null;
            if (!saved.autoFollow && saved.followTime) {
                const extent = plotter._timeExtent();
                if (extent) {
                    const { span } = saved.followTime;
                    const first = extent.first + saved.startFraction * Math.max(0, extent.last - extent.first - span);
                    plotter._frozenTimeEnd = first + span;
                    view.scrollOffset = Math.min(plotter.frames.length - 1, plotter._timeBoundaryIndex(first, false));
                }
            }
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

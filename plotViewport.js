/** Viewport gestures and scrollbars shared by the Canvas and SVG plots. */
(function (root) {
    const S = root.SerialPlotter ??= {};
    const { axisToDomain, axisFromDomain, plotWheelAxis, zoomAxisBounds } = typeof module !== 'undefined' ? require('./plotMath') : S;
    const unit = value => Math.max(0, Math.min(1, value));

    function axisWindow(base, view, scale, reverse) {
        if (!base || !view) return null;
        const [min, max] = base.map(value => axisToDomain(value, scale));
        const [first, last] = view.map(value => axisToDomain(value, scale));
        const span = last - first, total = max - min, travel = total - span;
        if (!(span > 0) || !(total > 0) || travel <= total * 1e-12) return null;
        const position = reverse ? max - last : first - min;
        return { min, max, span, total, travel, fraction: unit(position / travel) };
    }

    function panPlotAxis(base, view, fraction, scale = 'linear', reverse = false) {
        const window = axisWindow(base, view, scale, reverse);
        if (!window || !Number.isFinite(fraction)) return null;
        const position = reverse ? 1 - unit(fraction) : unit(fraction);
        const { min, max, span, travel } = window;
        const first = position === 1 ? max - span : min + position * travel;
        return [position === 0 ? base[0] : axisFromDomain(first, scale),
            position === 1 ? base[1] : axisFromDomain(first + span, scale)];
    }

    // The renderer supplies logical plot bounds and applies the resulting gesture
    // to its own data, e.g. discrete frame indices or a continuous frequency range.
    class PlotViewport {
        constructor(element, { listen, layout, enabled = () => true, getAxis, onZoom, onReset, onHistory,
            onStart, onMove, onEnd, onCancel, onLeave }) {
            this.element = element;
            this.layout = layout;
            let pointer = null;
            listen('wheel', event => {
                if (!enabled() || event.ctrlKey || event.metaKey || !event.deltaY) return;
                // Some browsers round wheel coordinates but preserve fractional pointer coordinates.
                const samePixel = pointer && Math.abs(pointer.clientX - event.clientX) < 1 &&
                    Math.abs(pointer.clientY - event.clientY) < 1;
                const point = this.point(samePixel ? pointer : event);
                if (!point) return;
                if (event.shiftKey) {
                    if (!point.inside || !onHistory?.(event)) return;
                } else {
                    const { width, height, area } = layout();
                    const axis = plotWheelAxis(point.rawX, point.rawY, { ...area, width, height });
                    if (!axis) return;
                    const ratio = axis === 'x' ? (point.x - area.left) / (area.right - area.left)
                        : (area.bottom - point.y) / (area.bottom - area.top);
                    const state = getAxis(axis);
                    if (!state) return;
                    if (state.zoomSamples) state.zoomSamples(unit(ratio), event.deltaY);
                    else {
                        const { view, base, scale } = state;
                        const bounds = zoomAxisBounds(view[0], view[1], unit(ratio), event.deltaY, base, scale);
                        if (bounds) onZoom(axis, bounds, base && bounds[0] === base[0] && bounds[1] === base[1]);
                    }
                }
                event.preventDefault();
                event.stopPropagation?.();
            }, { passive: false });
            listen('pointerdown', event => {
                if (!enabled() || this.activePointer != null || event.button !== 0 || event.ctrlKey || event.metaKey) return;
                const point = this.point(event);
                if (!point?.inside || onStart(event, point) === false) return;
                this.activePointer = event.pointerId;
                element.setPointerCapture?.(event.pointerId);
                event.preventDefault();
            });
            listen('pointermove', event => {
                if (this.activePointer != null && this.activePointer !== event.pointerId) return;
                pointer = { clientX: event.clientX, clientY: event.clientY };
                onMove(event);
            });
            const finish = (event, callback) => {
                if (this.activePointer == null || this.activePointer !== event.pointerId) return;
                this.activePointer = null;
                callback(event);
                if (element.releasePointerCapture && (!element.hasPointerCapture || element.hasPointerCapture(event.pointerId)))
                    element.releasePointerCapture(event.pointerId);
            };
            listen('pointerup', event => finish(event, onEnd));
            listen('pointercancel', event => finish(event, onCancel));
            listen('lostpointercapture', event => finish(event, onCancel));
            listen('pointerleave', () => { pointer = null; onLeave(); });
            listen('contextmenu', event => { event.preventDefault(); this.cancel(); onReset(); });
        }

        point(event) {
            const { width, height, area } = this.layout();
            const rect = this.element.getBoundingClientRect();
            if (!area || !rect.width || !rect.height) return null;
            const rawX = (event.clientX - rect.left) * width / rect.width;
            const rawY = (event.clientY - rect.top) * height / rect.height;
            return { x: Math.max(area.left, Math.min(area.right, rawX)), y: Math.max(area.top, Math.min(area.bottom, rawY)),
                rawX, rawY, inside: rawX >= area.left && rawX <= area.right && rawY >= area.top && rawY <= area.bottom };
        }

        verticalTrack(displayScale) {
            const { height, area } = this.layout();
            if (!area || !(height > 0)) return;
            const rect = this.element.getBoundingClientRect(), parent = this.element.parentElement.getBoundingClientRect();
            const factor = rect.height / height;
            return { top: (rect.top - parent.top + area.top * factor) / displayScale,
                height: (area.bottom - area.top) * factor / displayScale };
        }

        cancel() {
            const id = this.activePointer;
            this.activePointer = null;
            if (id != null && this.element.hasPointerCapture?.(id)) this.element.releasePointerCapture(id);
        }
    }

    class PlotScrollbar {
        constructor({ track, thumb, listen, document, viewport, onPan, reverse = false,
            displayScale = () => 1, enabled = () => true, showFull = !reverse }) {
            Object.assign(this, { track, thumb, viewport, reverse, showFull });
            if (!track || !thumb) return;
            track.hidden = !showFull;
            const client = reverse ? 'clientY' : 'clientX';
            const position = reverse ? 'top' : 'left';
            const trackSize = () => reverse ? parseFloat(track.style.height) : track.clientWidth;
            const thumbSize = () => reverse ? parseFloat(thumb.style.height) : thumb.offsetWidth;
            const usable = () => Math.max(1, trackSize() - thumbSize());
            let drag = null;
            listen(thumb, 'mousedown', e => {
                if (!enabled() || track.hidden || e.button > 0) return;
                const { base, view, scale } = viewport();
                drag = { client: e[client], fraction: axisWindow(base, view, scale, reverse)?.fraction ?? 0 };
                e.preventDefault();
            });
            listen(document, 'mousemove', e => {
                if (!enabled() || e.buttons === 0) drag = null;
                if (drag && Number.isFinite(e[client]))
                    onPan(unit(drag.fraction + (e[client] - drag.client) / displayScale() / usable()));
            });
            listen(document, 'mouseup', () => { drag = null; });
            listen(track, 'click', e => {
                if (!enabled() || track.hidden || e.target === thumb) return;
                const rect = track.getBoundingClientRect(), distance = e[client] - rect[position];
                onPan(unit(reverse ? (distance / displayScale() - thumbSize() / 2) / usable() : distance / rect.width));
            });
        }

        update({ top, height } = {}) {
            const { track, thumb, reverse, showFull } = this;
            if (!track || !thumb) return;
            const { base, view, scale } = this.viewport();
            const window = axisWindow(base, view, scale, reverse);
            if (!window || reverse && !(height > 0)) {
                track.hidden = !showFull;
                if (showFull) { thumb.style.left = '0'; thumb.style.width = '100%'; }
                return;
            }
            if (reverse) {
                track.style.top = top + 'px';
                track.style.height = height + 'px';
            }
            track.hidden = false;
            const pixels = reverse ? height : track.clientWidth;
            const desired = pixels * window.span / window.total;
            const size = Math.min(pixels, Math.max(reverse ? 20 : 24, reverse ? desired : Math.round(desired)));
            const offset = window.fraction * (pixels - size);
            thumb.style[reverse ? 'height' : 'width'] = size + 'px';
            thumb.style[reverse ? 'top' : 'left'] = (reverse ? offset : Math.round(offset)) + 'px';
        }
    }

    Object.assign(S, { PlotViewport, PlotScrollbar, panPlotAxis });
    if (typeof module !== 'undefined') module.exports = { PlotViewport, PlotScrollbar, panPlotAxis };
})(globalThis);

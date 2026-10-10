/** An extensible, scrollable workspace whose widgets own their views independently. */
(function(root) {
    'use strict';

    const { moveWorkspaceRect, resizeWorkspaceRect } = typeof module !== 'undefined' && module.exports
        ? require('./monitorWorkspace') : root.SerialPlotter;
    const STEPS = [10, 20, 40];
    const validZoom = zoom => Number.isFinite(zoom) && zoom >= 0.25 && zoom <= 5;
    const round = (value, step) => Math.round(value / step) * step;
    const ceil = (value, step) => Math.ceil(value / step) * step;
    const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;
    const validRect = rect => rect && ['x', 'y', 'width', 'height'].every(key =>
        Number.isFinite(rect[key]) && rect[key] >= 0 && rect[key] <= 1e7) && rect.width > 0 && rect.height > 0;
    const interactive = event => event.target?.closest?.('button,input,select,textarea,a,[contenteditable="true"]');
    const editing = event => event.target?.isContentEditable || event.target?.closest?.(
        'input,select,textarea,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]');

    class WidgetWorkspace {
        constructor({ viewport, surface, step = 10, zoom = 1, onActivate = () => {}, onResize = () => {}, onZoomChange = () => {},
            onLayoutChange = () => {}, onDelete = () => {}, onDrop = () => {},
            document = root.document, window = root.window }) {
            if (!STEPS.includes(step)) throw new RangeError('Workspace step must be 10, 20 or 40');
            if (!validZoom(zoom)) throw new RangeError('Workspace zoom must be between 0.25 and 5');
            Object.assign(this, { viewport, surface, step, zoom, onActivate, onResize, onZoomChange, onLayoutChange,
                onDelete, onDrop, document, window });
            this.entries = new Map();
            this.activeId = null;
            this.selectedIds = new Set();
            this.origin = { x: 0, y: 0 };
            this.centerPoint = null;
            this.focusState = null;
            this.fitted = false;
            this.contextFitNext = false;
            this.activationSequence = 0;
            this.gesture = null;
            this.cleanups = [];
            this.disposed = false;
            viewport.style.overflow = 'auto';
            this.scaleLayer = document.createElement('div');
            this.scaleLayer.className = 'workspace-scale-layer';
            Object.assign(this.scaleLayer.style, { position: 'relative', overflow: 'clip' });
            viewport.appendChild(this.scaleLayer);
            this.scaleLayer.appendChild(surface);
            Object.assign(surface.style, { position: 'absolute', left: '0', top: '0' });
            const clearSelection = event => {
                // Activation can replace a log row before this event finishes bubbling.
                if (event.button !== 0 || this.gesture || this._fromWidget(event) || interactive(event)) return;
                this.activate(null);
                this._select([]);
                const preview = this.document.createElement('div');
                preview.className = 'workspace-selection-box';
                this.surface.appendChild(preview);
                this._start({ marquee: true, preview, handle: surface, start: this._point(event) }, event);
            };
            this._listen(surface, 'pointerdown', clearSelection);
            this._listen(viewport, 'pointerdown', clearSelection);
            this._listen(viewport, 'pointerenter', () => { this.pointerInside = true; });
            this._listen(viewport, 'pointerleave', () => { this.pointerInside = false; });
            this._listen(viewport, 'wheel', event => this._horizontalWheel(event), this.cleanups, { capture: true, passive: false });
            this._listen(viewport, 'contextmenu', event => {
                if (this._fromWidget(event) || interactive(event)) return;
                event.preventDefault();
                this.focusState = null;
                if (this.contextFitNext) {
                    const area = viewport.getBoundingClientRect();
                    this.fitAll({ x: event.clientX - area.left, y: event.clientY - area.top });
                } else {
                    const point = this._point(event);
                    this.setZoom(1);
                    this._centerAt(point);
                }
                this.contextFitNext = !this.contextFitNext;
            });
            this._listen(document, 'pointermove', event => this._pointerMove(event));
            this._listen(document, 'pointerup', event => this._pointerUp(event));
            this._listen(document, 'pointercancel', event => {
                if (event.pointerId === this.gesture?.pointerId) this._finish(true);
            });
            this._listen(document, 'keydown', event => {
                if (event.isComposing || event.target?.closest?.('dialog[open]')) return;
                if (!editing(event) && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Delete') {
                    if (this.activeId && !event.repeat) {
                        event.preventDefault(); event.stopPropagation?.();
                        this._finish(true);
                        this.onDelete(this.activeId);
                    }
                    return;
                }
                const workspaceContext = this.pointerInside || this._fromWidget(event) ||
                    this.document.activeElement === viewport || this.document.activeElement?.closest?.('.workspace-widget');
                if (workspaceContext && !editing(event) && event.ctrlKey && !event.metaKey && !event.altKey && event.key?.toLowerCase() === 'a') {
                    event.preventDefault(); event.stopPropagation?.();
                    this._finish(true);
                    this._select(this.entries.keys());
                    if (!this.activeId && this.entries.size) this.activate(this.entries.keys().next().value);
                    return;
                }
                if (this.pointerInside && event.ctrlKey && !event.metaKey && !event.altKey) {
                    const direction = ['=', '+'].includes(event.key) || event.code === 'NumpadAdd' ? 1
                        : event.key === '-' || event.code === 'NumpadSubtract' ? -1 : 0;
                    if (direction) {
                        event.preventDefault(); event.stopPropagation?.();
                        this._stepZoom(direction);
                        return;
                    }
                }
                if (event.key === 'Escape' && this.gesture) { event.preventDefault(); this._finish(true); }
            }, this.cleanups, { capture: true });
            this._listen(window, 'blur', () => { this.pointerInside = false; this._finish(true); });
            this._listen(window, 'resize', () => this.refresh());
            const Observer = window?.ResizeObserver ?? root.ResizeObserver;
            if (Observer) {
                this.observer = new Observer(() => { if (!this.gesture) this.refresh(); });
                this.observer.observe(viewport);
            }
            this._surfaceSize();
            this.onZoomChange(this.zoom);
        }

        _listen(target, name, callback, cleanups = this.cleanups, options) {
            target?.addEventListener(name, callback, options);
            cleanups.push(() => target?.removeEventListener(name, callback, options));
        }

        _viewportWidth() { return Math.max(this.step, Math.floor(this.viewport.clientWidth / this.zoom / this.step) * this.step); }
        _fromWidget(event) {
            return event.composedPath?.().some(node => node.classList?.contains('workspace-widget')) ||
                event.target?.closest?.('.workspace-widget');
        }
        _point(event) {
            const area = this.viewport.getBoundingClientRect();
            return { x: (event.clientX - area.left + this.viewport.scrollLeft - this.origin.x) / this.zoom,
                y: (event.clientY - area.top + this.viewport.scrollTop - this.origin.y) / this.zoom };
        }
        _select(ids) {
            this.selectedIds = new Set(ids);
            for (const entry of this.entries.values())
                entry.element.classList[this.selectedIds.has(entry.id) ? 'add' : 'remove']('workspace-panel-selected');
        }
        _contentBounds() {
            const rects = this._obstacles();
            if (!rects.length) return null;
            const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
            return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x,
                height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
        }
        fitZoom(bounds = this._contentBounds()) {
            return bounds ? Math.max(0.25, Math.min(5, Math.floor(100 * Math.min(
                this.viewport.clientWidth / (bounds.width + 20), this.viewport.clientHeight / (bounds.height + 20)) + 1e-9) / 100)) : 1;
        }
        fitAll(fallbackAnchor) {
            this.focusState = null;
            this._fitBounds(this._contentBounds(), fallbackAnchor);
        }
        _fitBounds(bounds, fallbackAnchor) {
            let zoom = this.fitZoom(bounds);
            this.setZoom(zoom, fallbackAnchor);
            // Zooming may make other widgets introduce scrollbars and shrink the viewport.
            const corrected = this.fitZoom(bounds);
            if (corrected < zoom) {
                zoom = corrected;
                this.setZoom(zoom, fallbackAnchor);
            }
            const fits = bounds && (bounds.width + 20) * zoom <= this.viewport.clientWidth &&
                (bounds.height + 20) * zoom <= this.viewport.clientHeight;
            if (!fits) return false;
            this.fitted = true;
            // Only the requested bleed may extend beyond logical zero. Centering a
            // short row of widgets must not expose a large negative workspace.
            this.origin = { x: Math.max(0, (10 - bounds.x) * zoom),
                y: Math.max(0, (10 - bounds.y) * zoom) };
            this._centerAt({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
            return true;
        }
        fitWidget(id) {
            const entry = this.entries.get(id);
            if (!entry || this.disposed) return false;
            this._finish(true);
            this._select([id]); this.activate(id);
            if (this.focusState?.id === id) {
                const view = this.focusState.view;
                this.focusState = null;
                this._restoreView(view);
                return true;
            }
            const view = { zoom: this.zoom, origin: { ...this.origin },
                centerPoint: this.centerPoint ? { ...this.centerPoint } : null,
                fitted: this.fitted, contextFitNext: this.contextFitNext,
                scrollLeft: this.viewport.scrollLeft, scrollTop: this.viewport.scrollTop };
            const bounds = entry.rect;
            if (!this._fitBounds(bounds))
                this._centerAt({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
            this.focusState = { id, view };
            return true;
        }
        _restoreView(view) {
            this.zoom = view.zoom;
            this.origin = { ...view.origin };
            this.centerPoint = view.centerPoint ? { ...view.centerPoint } : null;
            this.fitted = view.fitted;
            this.contextFitNext = view.contextFitNext;
            this._surfaceSize();
            // The window or widget list may have changed since focus began.
            this.viewport.scrollLeft = Math.max(0, Math.min(view.scrollLeft,
                parseFloat(this.scaleLayer.style.width) - this.viewport.clientWidth));
            this.viewport.scrollTop = Math.max(0, Math.min(view.scrollTop,
                parseFloat(this.scaleLayer.style.height) - this.viewport.clientHeight));
            this.onZoomChange(this.zoom);
            this.onLayoutChange(this.serialize());
        }
        _centerAt(point) {
            // Near logical zero, alignment to the legal edge takes priority over centering.
            this.centerPoint = { x: Math.max(0, point.x), y: Math.max(0, point.y) };
            this._surfaceSize();
            this.viewport.scrollLeft = Math.max(0, this.origin.x + this.centerPoint.x * this.zoom - this.viewport.clientWidth / 2);
            this.viewport.scrollTop = Math.max(0, this.origin.y + this.centerPoint.y * this.zoom - this.viewport.clientHeight / 2);
        }
        _stepZoom(direction, anchor) {
            const target = Math.max(0.25, Math.min(5, Math.round((this.zoom + direction * 0.1) * 100) / 100));
            const fit = this.fitZoom();
            if (this.entries.size && fit !== this.zoom && (fit - this.zoom) * direction > 0 && (target - fit) * direction >= 0)
                this.fitAll(anchor);
            else this.setZoom(target, anchor);
        }
        _width() { return Math.max(this._viewportWidth(), ceil(Math.max(0,
            ...this._obstacles().map(rect => rect.x + rect.width)), this.step)); }
        _horizontalWheel(event) {
            if (event.ctrlKey && !event.metaKey) {
                event.preventDefault(); event.stopPropagation?.();
                const delta = event.deltaY || event.deltaX || 0;
                if (delta) {
                    const area = this.viewport.getBoundingClientRect();
                    this._stepZoom(-Math.sign(delta),
                        { x: event.clientX - area.left, y: event.clientY - area.top });
                }
                return;
            }
            if (event.ctrlKey || event.metaKey || event.target?.closest?.('select,input,textarea,[contenteditable="true"]')) return;
            if (!event.shiftKey && !(Math.abs(event.deltaX) > Math.abs(event.deltaY || 0))) return;
            const delta = event.deltaX || event.deltaY || 0;
            if (!delta) return;
            const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientWidth : 1;
            const max = Math.max(0, parseFloat(this.scaleLayer.style.width) - this.viewport.clientWidth);
            this.viewport.scrollLeft = Math.max(0, Math.min(max, this.viewport.scrollLeft + delta * scale));
            event.preventDefault();
            event.stopPropagation?.();
        }
        setZoom(value, anchor = { x: this.viewport.clientWidth / 2, y: this.viewport.clientHeight / 2 }) {
            if (this.disposed) return;
            if (!Number.isFinite(value)) throw new RangeError('Workspace zoom must be finite');
            const zoom = Math.max(0.25, Math.min(5, Math.round((value + Number.EPSILON) * 100) / 100));
            if (zoom === this.zoom && !this.fitted && this.origin.x === 0 && this.origin.y === 0) return;
            this._finish(true);
            const x = (this.viewport.scrollLeft + anchor.x - this.origin.x) / this.zoom;
            const y = (this.viewport.scrollTop + anchor.y - this.origin.y) / this.zoom;
            this.origin = { x: 0, y: 0 };
            this.centerPoint = null;
            this.fitted = false;
            this.zoom = zoom;
            this._surfaceSize();
            this.viewport.scrollLeft = Math.max(0, Math.min(parseFloat(this.scaleLayer.style.width) - this.viewport.clientWidth,
                x * zoom - anchor.x));
            this.viewport.scrollTop = Math.max(0, Math.min(parseFloat(this.scaleLayer.style.height) - this.viewport.clientHeight,
                y * zoom - anchor.y));
            this.onZoomChange(zoom);
            this.onLayoutChange(this.serialize());
        }
        _obstacles(exclude) { return [...this.entries.values()].filter(entry => entry.id !== exclude).map(entry => entry.rect); }
        _sizeReference(type) {
            let reference = null;
            for (const entry of this.entries.values()) {
                if (entry.type === type && (!reference || entry.lastActivated >= reference.lastActivated)) reference = entry;
            }
            return reference;
        }
        _minimum(entry) {
            return { width: Math.min(this._viewportWidth(), ceil(entry.minWidth, this.step)),
                height: ceil(entry.minHeight, this.step) };
        }
        _normalize(rect, minimum = { width: 280, height: 180 }, fitViewport = false) {
            const width = Math.max(ceil(minimum.width, this.step), round(rect.width, this.step));
            return { x: Math.max(0, round(rect.x || 0, this.step)),
                y: Math.max(0, round(rect.y || 0, this.step)), width: fitViewport ? Math.min(this._viewportWidth(), width) : width,
                height: Math.max(ceil(minimum.height, this.step), round(rect.height, this.step)) };
        }

        _place(size, obstacles, availableWidth = this._width()) {
            const xs = [...new Set([0, ...obstacles.map(rect => rect.x + rect.width + this.step)])].sort((a, b) => a - b);
            const ys = [...new Set([0, ...obstacles.flatMap(rect => [rect.y, rect.y + rect.height + this.step])])].sort((a, b) => a - b);
            for (const y of ys) for (const x of xs) {
                const rect = { x, y, width: size.width, height: size.height };
                if (x + rect.width <= availableWidth && !obstacles.some(peer => overlaps(rect, peer))) return rect;
            }
            return { x: 0, y: ceil(Math.max(0, ...obstacles.map(rect => rect.y + rect.height)) + this.step, this.step),
                width: size.width, height: size.height };
        }

        findPlacement(size = {}) {
            return this._place(this._normalize({ x: 0, y: 0, width: size.width ?? 640,
                height: size.height ?? 300 }, { width: size.minWidth ?? 280, height: size.minHeight ?? 180 }, true), this._obstacles());
        }

        _surfaceSize(extraBottom = 0, extraRight = 0) {
            const centeredRight = this.centerPoint ? this.centerPoint.x + (this.viewport.clientWidth / 2 - this.origin.x) / this.zoom : 0;
            const centeredBottom = this.centerPoint ? this.centerPoint.y + (this.viewport.clientHeight / 2 - this.origin.y) / this.zoom : 0;
            const right = Math.max(0, extraRight, centeredRight, ...this._obstacles().map(rect => rect.x + rect.width));
            const bottom = Math.max(0, extraBottom, centeredBottom, ...this._obstacles().map(rect => rect.y + rect.height));
            // Keep room to pan around the anchor when zooming in; do not round the empty viewport into scrollbars.
            const minimumScale = Math.min(1, this.zoom);
            this.surface.style.width = Math.max(this.viewport.clientWidth / minimumScale,
                ceil(Math.max(this._width(), right), this.step)) + 'px';
            this.surface.style.height = Math.max((this.viewport.clientHeight || 0) / minimumScale,
                ceil(bottom, this.step)) + 'px';
            this.surface.style.setProperty?.('--workspace-step', this.step + 'px');
            this.surface.dataset.workspaceZoom = String(this.zoom);
            // Native layout zoom rerasterizes text instead of stretching a composited layer.
            this.surface.style.zoom = String(this.zoom);
            // CSS zoom also scales positioning; origin is measured in screen pixels.
            this.surface.style.left = this.origin.x / this.zoom + 'px';
            this.surface.style.top = this.origin.y / this.zoom + 'px';
            const extent = this.fitted ? { width: Math.max(this.viewport.clientWidth,
                this.origin.x + (right + 10) * this.zoom),
                height: Math.max(this.viewport.clientHeight, this.origin.y + (bottom + 10) * this.zoom) }
                : { width: this.origin.x + parseFloat(this.surface.style.width) * this.zoom,
                    height: this.origin.y + parseFloat(this.surface.style.height) * this.zoom };
            this.scaleLayer.style.width = extent.width + 'px';
            this.scaleLayer.style.height = extent.height + 'px';
        }

        _apply(entry, rect) {
            const changedSize = !entry.rect || entry.rect.width !== rect.width || entry.rect.height !== rect.height;
            entry.rect = { ...rect };
            Object.assign(entry.element.style, { position: 'absolute', left: rect.x + 'px', top: rect.y + 'px',
                width: rect.width + 'px', height: rect.height + 'px' });
            if (changedSize) this.onResize(entry.id, { ...rect });
        }

        add({ id, type, title = type, element, handle, minWidth = 280, minHeight = 180, rect }) {
            if (this.disposed) throw new Error('Workspace is disposed');
            if (typeof id !== 'string' || !id || this.entries.has(id)) throw new Error('Widget ID must be unique');
            if (!element || !handle || typeof type !== 'string' || !type) throw new TypeError('Widget view and type are required');
            if (![minWidth, minHeight].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Invalid widget minimum');
            const entry = { id, type, title, element, handle, minWidth, minHeight, cleanups: [], resizeHandles: [], lastActivated: 0 };
            const reference = this._sizeReference(type);
            const initial = validRect(rect) ? rect : { x: 0, y: 0,
                width: reference?.rect.width ?? 640, height: reference?.rect.height ?? 300 };
            const size = this._normalize(initial, this._minimum(entry), !validRect(rect) && !reference);
            const placed = validRect(rect) && !this._obstacles().some(peer => overlaps(size, peer))
                ? size : this._place(size, this._obstacles());
            this.entries.set(id, entry);
            element.dataset.widgetId = id;
            element.dataset.widgetType = type;
            element.classList.add('workspace-widget');
            if (element.parentNode !== this.surface) this.surface.appendChild(element);
            this._bind(entry);
            this._apply(entry, placed);
            this._surfaceSize();
            this.onLayoutChange(this.serialize());
            return entry;
        }

        _bind(entry) {
            const { element, handle, cleanups } = entry;
            const focus = () => { if (!this.selectedIds.has(entry.id)) this._select([entry.id]); this.activate(entry.id); };
            this._listen(element, 'pointerdown', event => {
                if (event.button === 0 && event.ctrlKey && !interactive(event)) {
                    event.preventDefault(); event.stopPropagation?.();
                    const selected = new Set(this.selectedIds);
                    if (selected.has(entry.id)) selected.delete(entry.id);
                    else selected.add(entry.id);
                    this._select([...selected]);
                    if (selected.has(entry.id)) this.activate(entry.id);
                    else if (this.activeId === entry.id) this.activate([...selected].at(-1) ?? null);
                    return;
                }
                focus();
            }, cleanups, { capture: true });
            this._listen(element, 'focusin', focus, cleanups);
            handle.classList.add('workspace-drag-handle');
            handle.dataset.widgetHandle = entry.id;
            handle.tabIndex = 0;
            handle.style.touchAction = 'none';
            handle.setAttribute('aria-label', `${entry.title}: arrow keys move, Shift + arrows resize, Delete removes`);
            const bind = (target, direction) => {
                this._listen(target, 'pointerdown', event => {
                    if (event.button !== 0 || this.gesture || interactive(event)) return;
                    focus();
                    if (direction !== 'move') this._select([entry.id]);
                    const group = direction === 'move' && this.selectedIds.size > 1 ?
                        [...this.selectedIds].map(id => ({ entry: this.entries.get(id), rect: { ...this.entries.get(id).rect } })) : null;
                    this._start({ entry, direction, group, handle: target, rect: { ...entry.rect } }, event);
                    try { target.setPointerCapture?.(event.pointerId); } catch { /* Document listeners still complete the gesture. */ }
                }, cleanups);
                this._listen(target, 'lostpointercapture', event => {
                    if (event.pointerId === this.gesture?.pointerId) this._finish(true);
                }, cleanups);
            };
            bind(handle, 'move');
            this._listen(handle, 'dblclick', event => {
                if (interactive(event)) return;
                event.preventDefault(); event.stopPropagation?.();
                this.fitWidget(entry.id);
            }, cleanups);
            for (const direction of ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']) {
                const edge = this.document.createElement('div');
                edge.className = 'workspace-resize-handle workspace-resize-' + direction;
                edge.dataset.direction = direction;
                edge.dataset.widgetId = entry.id;
                edge.style.touchAction = 'none';
                edge.setAttribute('aria-hidden', 'true');
                element.appendChild(edge);
                entry.resizeHandles.push(edge);
                bind(edge, direction);
            }
            this._listen(handle, 'keydown', event => {
                if (interactive(event) || event.ctrlKey || event.metaKey || event.altKey) return;
                if (event.key === 'Backspace') {
                    event.preventDefault(); this.onDelete(entry.id); return;
                }
                const offset = { ArrowLeft: [-this.step, 0], ArrowRight: [this.step, 0],
                    ArrowUp: [0, -this.step], ArrowDown: [0, this.step] }[event.key];
                if (!offset) return;
                focus();
                this._change(entry, entry.rect, event.shiftKey ? 'se' : 'move', ...offset);
                this.onLayoutChange(this.serialize());
                event.preventDefault();
            }, cleanups);
        }

        _start(details, event) {
            const bodyStyle = this.document.body.style;
            this.gesture = { ...details, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
                scrollLeft: this.viewport.scrollLeft, scrollTop: this.viewport.scrollTop,
                cursor: bodyStyle.cursor, userSelect: bodyStyle.userSelect };
            bodyStyle.cursor = details.marquee ? 'crosshair' : details.direction === 'move' || details.library ? 'grabbing' : details.direction + '-resize';
            bodyStyle.userSelect = 'none';
            event.preventDefault();
        }

        _change(entry, start, direction, dx, dy) {
            const bounds = { width: ceil(Math.max(this._width(), start.x + start.width + Math.max(0, dx)), this.step),
                height: ceil(Math.max(parseFloat(this.surface.style.height),
                start.y + start.height + Math.max(0, dy)), this.step) };
            const options = { step: this.step, obstacles: this._obstacles(entry.id) };
            const rect = direction === 'move' ? moveWorkspaceRect(start, dx, dy, bounds, this._minimum(entry), options)
                : resizeWorkspaceRect(start, direction, dx, dy, bounds, this._minimum(entry), options);
            this._apply(entry, rect);
            this._surfaceSize();
        }

        _pointerMove(event) {
            const area = this.viewport.getBoundingClientRect();
            this.pointerInside = event.clientX >= area.left && event.clientX < area.right &&
                event.clientY >= area.top && event.clientY < area.bottom;
            const g = this.gesture;
            if (!g || g.pointerId !== event.pointerId) return;
            if (g.library) { this._libraryPreview(event); return; }
            if (g.marquee) {
                const point = this._point(event);
                const rect = { x: Math.min(g.start.x, point.x), y: Math.min(g.start.y, point.y),
                    width: Math.abs(point.x - g.start.x), height: Math.abs(point.y - g.start.y) };
                Object.assign(g.preview.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
                this._select([...this.entries.values()].filter(entry => overlaps(rect, entry.rect)).map(entry => entry.id));
                return;
            }
            g.dx = (event.clientX - g.x + this.viewport.scrollLeft - g.scrollLeft) / this.zoom;
            g.dy = (event.clientY - g.y + this.viewport.scrollTop - g.scrollTop) / this.zoom;
            if (g.group) this._moveGroup(g.group, g.dx, g.dy);
            else this._change(g.entry, g.rect, g.direction, g.dx, g.dy);
        }

        _moveGroup(group, dx, dy) {
            dx = Math.max(-Math.min(...group.map(item => item.rect.x)), round(dx, this.step));
            dy = Math.max(-Math.min(...group.map(item => item.rect.y)), round(dy, this.step));
            const ids = new Set(group.map(item => item.entry.id));
            const peers = [...this.entries.values()].filter(entry => !ids.has(entry.id)).map(entry => entry.rect);
            const valid = (x, y) => group.every(({ rect }) => rect.x + x >= 0 && rect.y + y >= 0 &&
                !peers.some(peer => overlaps({ ...rect, x: rect.x + x, y: rect.y + y }, peer)));
            if (valid(dx, dy)) {
                for (const { entry, rect } of group) this._apply(entry, { ...rect, x: rect.x + dx, y: rect.y + dy });
                this._surfaceSize(); return;
            }
            let best = { x: 0, y: 0 }, distance = Infinity;
            const xs = new Set([0, dx]), ys = new Set([0, dy]);
            for (const { rect } of group) for (const peer of peers) {
                xs.add(Math.floor((peer.x - rect.x - rect.width) / this.step) * this.step);
                xs.add(ceil(peer.x + peer.width - rect.x, this.step));
                ys.add(Math.floor((peer.y - rect.y - rect.height) / this.step) * this.step);
                ys.add(ceil(peer.y + peer.height - rect.y, this.step));
            }
            for (const x of xs) for (const y of ys) {
                const score = (x - dx) ** 2 + (y - dy) ** 2;
                if (score < distance && valid(x, y)) { best = { x, y }; distance = score; }
            }
            for (const { entry, rect } of group) this._apply(entry, { ...rect, x: rect.x + best.x, y: rect.y + best.y });
            this._surfaceSize();
        }

        _pointerUp(event) {
            if (event.pointerId !== this.gesture?.pointerId) return;
            if (this.gesture.library) this._libraryPreview(event);
            this._finish(false);
        }

        _finish(cancelled) {
            const g = this.gesture;
            if (!g) return;
            this.gesture = null;
            Object.assign(this.document.body.style, { cursor: g.cursor, userSelect: g.userSelect });
            if (g.marquee) {
                g.preview.remove();
                if (cancelled) this._select([]);
                else if (this.selectedIds.size) this.activate(this.selectedIds.values().next().value);
            } else if (g.library) {
                g.preview.remove();
                this._surfaceSize();
                if (!cancelled && g.dropRect) this.onDrop({ type: g.type, rect: { ...g.dropRect } });
            } else {
                if (cancelled) for (const { entry, rect } of g.group ?? [{ entry: g.entry, rect: g.rect }]) this._apply(entry, rect);
                this._surfaceSize();
                try { g.handle.releasePointerCapture?.(g.pointerId); } catch { /* Capture may already be released. */ }
                if (!cancelled) this.refresh();
            }
        }

        beginLibraryDrag(type, event, size = {}) {
            if (this.disposed || this.gesture || event.button !== 0) return false;
            const reference = this._sizeReference(type);
            size = { width: reference?.rect.width ?? 640, height: reference?.rect.height ?? 300, ...size };
            const preview = this.document.createElement('div');
            preview.className = 'widget-drop-preview';
            preview.hidden = true;
            preview.setAttribute('aria-hidden', 'true');
            Object.assign(preview.style, { position: 'absolute', pointerEvents: 'none' });
            this.surface.appendChild(preview);
            this._start({ library: true, type, size, preview, fitViewport: !reference }, event);
            this._libraryPreview(event);
            return true;
        }

        _libraryPreview(event) {
            const g = this.gesture;
            const area = this.viewport.getBoundingClientRect();
            const inside = event.clientX >= area.left && event.clientX < area.right &&
                event.clientY >= area.top && event.clientY < area.bottom;
            g.preview.hidden = !inside;
            g.dropRect = null;
            if (!inside) { this._surfaceSize(); return; }
            const desired = this._normalize({ ...this._point(event),
                width: g.size.width, height: g.size.height }, undefined, g.fitViewport);
            const obstacles = this._obstacles();
            g.dropRect = obstacles.some(rect => overlaps(desired, rect)) ? this._place(desired, obstacles) : desired;
            Object.assign(g.preview.style, { left: g.dropRect.x + 'px', top: g.dropRect.y + 'px',
                width: g.dropRect.width + 'px', height: g.dropRect.height + 'px' });
            this._surfaceSize(g.dropRect.y + g.dropRect.height, g.dropRect.x + g.dropRect.width);
        }

        activate(id) {
            if (id !== null && !this.entries.has(id)) return false;
            if (id === this.activeId) return true;
            for (const entry of this.entries.values()) {
                entry.element.classList[entry.id === id ? 'add' : 'remove']('workspace-panel-active');
            }
            this.activeId = id;
            if (id !== null) this.entries.get(id).lastActivated = ++this.activationSequence;
            if (!this.disposed) this.onActivate(id);
            return true;
        }

        remove(id) {
            const entry = this.entries.get(id);
            if (!entry) return false;
            if (this.focusState?.id === id) this.focusState = null;
            if (this.gesture?.entry === entry || this.gesture?.group?.some(item => item.entry === entry) || this.gesture?.library || this.gesture?.marquee) this._finish(true);
            for (const cleanup of entry.cleanups) cleanup();
            for (const handle of entry.resizeHandles) handle.remove();
            entry.element.remove();
            this.entries.delete(id);
            this.selectedIds.delete(id);
            if (this.activeId === id) this.activate(this.entries.keys().next().value ?? null);
            this._surfaceSize();
            if (!this.disposed) this.onLayoutChange(this.serialize());
            return true;
        }

        getRect(id) { const rect = this.entries.get(id)?.rect; return rect ? { ...rect } : null; }
        serialize() { return { step: this.step, zoom: this.zoom,
            rects: Object.fromEntries([...this.entries].map(([id, entry]) => [id, { ...entry.rect }])) }; }

        restore(layout) {
            if (!layout || !STEPS.includes(layout.step) || !layout.rects || typeof layout.rects !== 'object' || Array.isArray(layout.rects)) return false;
            const zoom = layout.zoom === undefined ? 1 : layout.zoom;
            if (!validZoom(zoom)) return false;
            const ids = [...this.entries.keys()], rects = ids.map(id => layout.rects[id]);
            if (Object.keys(layout.rects).length !== ids.length || !ids.every(id => Object.hasOwn(layout.rects, id)) || !rects.every(validRect)) return false;
            for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
                if (overlaps(rects[i], rects[j])) return false;
            }
            this._finish(true);
            this.step = layout.step;
            this.zoom = Math.round(zoom * 100) / 100;
            this.origin = { x: 0, y: 0 };
            this.centerPoint = null;
            this.focusState = null;
            this.fitted = false;
            this._select([]);
            for (const [id, entry] of this.entries) entry.rect = { ...layout.rects[id] };
            this.refresh({ notifyResize: true });
            this.onZoomChange(zoom);
            return true;
        }

        refresh({ notifyResize = false } = {}) {
            if (this.disposed) return;
            const g = this.gesture;
            if (g) {
                // Wrapped widget chrome can change its minimum size mid-drag.
                // Reapply the pointer delta using that limit, without cancelling or moving the opposite edge.
                if (g.group) this._moveGroup(g.group, g.dx ?? 0, g.dy ?? 0);
                else if (!g.library && !g.marquee) this._change(g.entry, g.rect, g.direction, g.dx ?? 0, g.dy ?? 0);
                return;
            }
            const obstacles = [];
            for (const entry of this.entries.values()) {
                const desired = this._normalize(entry.rect, this._minimum(entry));
                const rect = obstacles.some(peer => overlaps(desired, peer)) ? this._place(desired, obstacles) : desired;
                this._apply(entry, rect);
                if (notifyResize) this.onResize(entry.id, { ...rect });
                obstacles.push(rect);
            }
            this._surfaceSize();
            this.onLayoutChange(this.serialize());
        }

        setStep(step) {
            if (!STEPS.includes(step)) throw new RangeError('Workspace step must be 10, 20 or 40');
            this._finish(true);
            this.step = step;
            this.refresh();
        }

        reset() {
            this._finish(true);
            this.focusState = null;
            const obstacles = [];
            for (const entry of this.entries.values()) {
                const rect = this._place(this._normalize({ x: 0, y: 0, width: 640, height: 300 }, this._minimum(entry), true),
                    obstacles, this._viewportWidth());
                this._apply(entry, rect);
                obstacles.push(rect);
            }
            this._surfaceSize();
            this.onLayoutChange(this.serialize());
        }

        dispose() {
            if (this.disposed) return;
            this._finish(true);
            this.disposed = true;
            this.observer?.disconnect();
            for (const cleanup of this.cleanups) cleanup();
            for (const id of [...this.entries.keys()]) this.remove(id);
        }
    }

    root.SerialPlotter ??= {};
    root.SerialPlotter.WidgetWorkspace = WidgetWorkspace;
    if (typeof module !== 'undefined' && module.exports) module.exports = { WidgetWorkspace };
})(typeof globalThis !== 'undefined' ? globalThis : this);

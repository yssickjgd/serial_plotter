/** Movable monitor panels aligned to a shared grid with collision constraints. */
(function(root) {
    'use strict';

    const STORAGE_KEY = 'serialplot_v3_workspace';
    const STEPS = [10, 20, 40];
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const snap = (value, step) => Math.round(value / step) * step;
    const floor = (value, step) => Math.floor(value / step) * step;
    const ceil = (value, step) => Math.ceil(value / step) * step;
    const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;

    function fitWorkspaceRect(rect, bounds, minimum, { step = 10 } = {}) {
        const maxWidth = Math.max(step, floor(bounds.width, step));
        const maxHeight = Math.max(step, floor(bounds.height, step));
        const width = clamp(snap(rect.width, step), Math.min(maxWidth, ceil(minimum.width, step)), maxWidth);
        const height = clamp(snap(rect.height, step), Math.min(maxHeight, ceil(minimum.height, step)), maxHeight);
        return { x: clamp(snap(rect.x, step), 0, maxWidth - width),
            y: clamp(snap(rect.y, step), 0, maxHeight - height), width, height };
    }

    function clearRect(rect, bounds, obstacles) {
        return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= bounds.width &&
            rect.y + rect.height <= bounds.height && !obstacles.some(peer => overlaps(rect, peer));
    }

    function moveWorkspaceRect(start, dx, dy, bounds, minimum, options = {}) {
        const { obstacles = [] } = options;
        const rect = fitWorkspaceRect({ ...start, x: start.x + dx, y: start.y + dy }, bounds, minimum, options);
        if (clearRect(rect, bounds, obstacles)) return rect;
        const candidates = [start];
        for (const peer of obstacles) candidates.push(
            { ...rect, x: peer.x - rect.width }, { ...rect, x: peer.x + peer.width },
            { ...rect, y: peer.y - rect.height }, { ...rect, y: peer.y + peer.height });
        return candidates.filter(candidate => clearRect(candidate, bounds, obstacles))
            .sort((a, b) => (a.x - rect.x) ** 2 + (a.y - rect.y) ** 2 -
                ((b.x - rect.x) ** 2 + (b.y - rect.y) ** 2))[0] ?? start;
    }

    function resizeWorkspaceRect(start, direction, dx, dy, bounds, minimum, options = {}) {
        const { step = 10, obstacles = [] } = options;
        const minWidth = ceil(minimum.width, step), minHeight = ceil(minimum.height, step);
        let left = start.x, right = start.x + start.width;
        let top = start.y, bottom = start.y + start.height;
        if (direction.includes('w')) left = clamp(snap(left + dx, step),
            0, right - minWidth);
        if (direction.includes('e')) right = clamp(snap(right + dx, step),
            left + minWidth, floor(bounds.width, step));
        if (direction.includes('n')) top = clamp(snap(top + dy, step),
            0, bottom - minHeight);
        if (direction.includes('s')) bottom = clamp(snap(bottom + dy, step),
            top + minHeight, floor(bounds.height, step));
        const rect = { x: left, y: top, width: right - left, height: bottom - top };
        if (clearRect(rect, bounds, obstacles)) return rect;
        const candidates = [start];
        for (const peer of obstacles) {
            if (direction.includes('e')) candidates.push({ ...rect, width: peer.x - left });
            if (direction.includes('w')) candidates.push({ ...rect, x: peer.x + peer.width,
                width: right - peer.x - peer.width });
            if (direction.includes('s')) candidates.push({ ...rect, height: peer.y - top });
            if (direction.includes('n')) candidates.push({ ...rect, y: peer.y + peer.height,
                height: bottom - peer.y - peer.height });
        }
        const distance = candidate => (candidate.x - rect.x) ** 2 + (candidate.y - rect.y) ** 2 +
            (candidate.width - rect.width) ** 2 + (candidate.height - rect.height) ** 2;
        return candidates.filter(candidate => candidate.width >= minWidth && candidate.height >= minHeight &&
            clearRect(candidate, bounds, obstacles)).sort((a, b) => distance(a) - distance(b))[0] ?? start;
    }

    function defaultWorkspaceRects(bounds, minima, waveformVisible, step = 10) {
        if (!waveformVisible) return { byte: { x: 0, y: 0, width: bounds.width, height: bounds.height } };
        const waveHeight = clamp(snap(bounds.height * 0.6, step), ceil(minima.wave.height, step),
            bounds.height - ceil(minima.byte.height, step) - step);
        return { wave: { x: 0, y: 0, width: bounds.width, height: waveHeight },
            byte: { x: 0, y: waveHeight + step, width: bounds.width, height: bounds.height - waveHeight - step } };
    }

    function validLayout(layout, ids) {
        const finiteSize = value => Number.isFinite(value) && value > 0 && value <= 1e7;
        return layout && finiteSize(layout.width) && finiteSize(layout.height) && ids.every(id => {
            const rect = layout.rects?.[id];
            return rect && finiteSize(rect.width) && finiteSize(rect.height) &&
                Number.isFinite(rect.x) && rect.x >= 0 && Number.isFinite(rect.y) && rect.y >= 0 &&
                rect.x + rect.width <= layout.width && rect.y + rect.height <= layout.height;
        }) && (ids.length < 2 || !overlaps(layout.rects[ids[0]], layout.rects[ids[1]]));
    }

    class MonitorWorkspace {
        constructor({ viewport, surface, panels, storage, onResize = () => {}, onActivate = () => {},
            document = root.document, window = root.window }) {
            this.viewport = viewport;
            this.surface = surface;
            this.panels = panels;
            this.storage = storage;
            this.onResize = onResize;
            this.onActivate = onActivate;
            this.activePanel = null;
            this.document = document;
            this.window = window;
            this.step = 10;
            this.waveformVisible = true;
            this.layouts = {};
            this.gesture = null;
            this.pendingResize = false;
            try {
                const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
                if (saved?.version === 1) {
                    if (STEPS.includes(saved.step)) this.step = saved.step;
                    for (const [profile, ids] of [['both', ['wave', 'byte']], ['single', ['byte']]])
                        if (validLayout(saved.layouts?.[profile], ids)) this.layouts[profile] = saved.layouts[profile];
                }
            } catch { /* Storage may be unavailable or contain an obsolete layout. */ }
            for (const panel of panels) this._bindPanel(panel);
            window?.addEventListener('blur', () => this._finish(true));
            window?.addEventListener('resize', () => this.refresh());
            if (typeof ResizeObserver !== 'undefined') {
                this.observer = new ResizeObserver(() => this.refresh());
                this.observer.observe(viewport);
            }
            this.refresh();
        }

        get profile() { return this.waveformVisible ? 'both' : 'single'; }

        _minimums() {
            return Object.fromEntries(this.panels.map(panel => [panel.id, panel.minimum()]));
        }

        refresh({ contentChanged = false } = {}) {
            let minima = this._minimums();
            const minWidth = Math.max(minima.byte.width, this.waveformVisible ? minima.wave.width : 0);
            const width = Math.max(floor(this.viewport.clientWidth, this.step), ceil(minWidth, this.step));
            const saved = this.layouts[this.profile];
            let widthChanged = false;
            // Establish the intended widths before measuring wrapped headers and send controls.
            for (const panel of this.panels) {
                if (panel.id === 'wave' && !this.waveformVisible) continue;
                const targetWidth = clamp(snap(saved ? saved.rects[panel.id].width * width / saved.width : width,
                    this.step), ceil(minima[panel.id].width, this.step), width) + 'px';
                if (panel.element.style.width !== targetWidth) {
                    panel.element.style.width = targetWidth;
                    widthChanged = true;
                }
            }
            minima = this._minimums();
            const minHeight = ceil(minima.byte.height, this.step) +
                (this.waveformVisible ? ceil(minima.wave.height, this.step) + this.step : 0);
            const bounds = { width, height: Math.max(floor(this.viewport.clientHeight, this.step), minHeight) };
            let rects = defaultWorkspaceRects(bounds, minima, this.waveformVisible, this.step);
            if (saved) {
                for (const id of Object.keys(rects)) {
                    const old = saved.rects[id];
                    rects[id] = fitWorkspaceRect({ x: old.x * bounds.width / saved.width,
                        y: old.y * bounds.height / saved.height, width: old.width * bounds.width / saved.width,
                        height: old.height * bounds.height / saved.height }, bounds, minima[id], { step: this.step });
                }
                if (this.waveformVisible && overlaps(rects.wave, rects.byte)) {
                    const candidate = moveWorkspaceRect(rects.byte, 0, 0, bounds, minima.byte,
                        { step: this.step, obstacles: [rects.wave] });
                    rects = overlaps(rects.wave, candidate) ? defaultWorkspaceRects(bounds, minima, true, this.step)
                        : { wave: rects.wave, byte: candidate };
                }
            }
            this.current = { ...bounds, rects };
            if (saved) this.layouts[this.profile] = this.current;
            this.surface.style.width = bounds.width + 'px';
            this.surface.style.height = bounds.height + 'px';
            this.surface.style.setProperty?.('--workspace-step', this.step + 'px');
            for (const panel of this.panels) {
                panel.element.hidden = panel.id === 'wave' && !this.waveformVisible;
                if (rects[panel.id]) this._apply(panel.id, rects[panel.id]);
            }
            if (widthChanged || contentChanged) this._notifyResize();
        }

        _notifyResize() {
            if (this.pendingResize) return;
            if (typeof this.window?.requestAnimationFrame !== 'function') { this.onResize(); return; }
            this.pendingResize = true;
            this.window.requestAnimationFrame(() => { this.pendingResize = false; this.onResize(); });
        }

        _apply(id, rect) {
            const element = this.panels.find(panel => panel.id === id).element;
            const sizeChanged = element.style.width !== rect.width + 'px' || element.style.height !== rect.height + 'px';
            Object.assign(element.style, { left: rect.x + 'px', top: rect.y + 'px',
                width: rect.width + 'px', height: rect.height + 'px' });
            this.current.rects[id] = rect;
            if (sizeChanged) this._notifyResize();
        }

        _save() {
            try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, step: this.step, layouts: this.layouts })); }
            catch { /* Layout remains usable when browser storage is disabled or full. */ }
        }

        activate(id) {
            if (id === this.activePanel || (id === 'wave' && !this.waveformVisible)) return;
            const panel = this.panels.find(item => item.id === id);
            if (!panel) return;
            for (const item of this.panels) item.element.classList.remove('workspace-panel-active');
            panel.element.classList.add('workspace-panel-active');
            this.activePanel = id;
            this.onActivate(id);
        }

        _bindPanel(panel) {
            const focus = () => this.activate(panel.id);
            panel.element.addEventListener('pointerdown', focus);
            panel.handle.classList.add('workspace-drag-handle');
            panel.handle.tabIndex = 0;
            panel.handle.setAttribute?.('aria-label', `${panel.label}：拖动或方向键移动，Shift 加方向键调整大小`);
            const bind = (handle, direction) => {
                handle.addEventListener('pointerdown', event => {
                    if (event.button !== 0 || this.gesture ||
                        event.target?.closest?.('button,input,select,textarea,a')) return;
                    focus();
                    const before = this.layouts[this.profile] ? JSON.parse(JSON.stringify(this.layouts[this.profile])) : null;
                    this.layouts[this.profile] = this.current;
                    this.gesture = { panel, direction, handle, pointerId: event.pointerId,
                        x: event.clientX, y: event.clientY, rect: { ...this.current.rects[panel.id] }, before,
                        cursor: this.document.body.style.cursor, userSelect: this.document.body.style.userSelect };
                    handle.setPointerCapture?.(event.pointerId);
                    this.document.body.style.cursor = direction === 'move' ? 'grabbing' : direction + '-resize';
                    this.document.body.style.userSelect = 'none';
                    event.preventDefault();
                });
                handle.addEventListener('pointermove', event => {
                    const gesture = this.gesture;
                    if (!gesture || gesture.pointerId !== event.pointerId) return;
                    this._change(gesture.panel, gesture.rect, direction,
                        event.clientX - gesture.x, event.clientY - gesture.y);
                });
                handle.addEventListener('pointerup', () => this._finish(false));
                handle.addEventListener('pointercancel', () => this._finish(true));
                handle.addEventListener('lostpointercapture', () => this._finish(true));
            };
            bind(panel.handle, 'move');
            for (const direction of ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']) {
                const handle = this.document.createElement('div');
                handle.className = 'workspace-resize-handle workspace-resize-' + direction;
                handle.dataset ??= {};
                handle.dataset.direction = direction;
                handle.setAttribute?.('aria-hidden', 'true');
                bind(handle, direction);
                panel.element.appendChild(handle);
            }
            panel.handle.addEventListener('keydown', event => {
                const offset = { ArrowLeft: [-this.step, 0], ArrowRight: [this.step, 0],
                    ArrowUp: [0, -this.step], ArrowDown: [0, this.step] }[event.key];
                if (!offset || event.ctrlKey || event.metaKey || event.altKey) return;
                focus();
                this.layouts[this.profile] = this.current;
                this._change(panel, this.current.rects[panel.id], event.shiftKey ? 'se' : 'move', ...offset);
                this._save();
                event.preventDefault();
            });
        }

        _change(panel, start, direction, dx, dy) {
            const obstacles = Object.entries(this.current.rects).filter(([id]) => id !== panel.id).map(([, rect]) => rect);
            const options = { step: this.step, obstacles };
            const rect = direction === 'move' ? moveWorkspaceRect(start, dx, dy, this.current, panel.minimum(), options)
                : resizeWorkspaceRect(start, direction, dx, dy, this.current, panel.minimum(), options);
            this._apply(panel.id, rect);
        }

        _finish(cancelled) {
            const gesture = this.gesture;
            if (!gesture) return;
            this.gesture = null;
            this.document.body.style.cursor = gesture.cursor;
            this.document.body.style.userSelect = gesture.userSelect;
            if (cancelled) {
                if (gesture.before) this.layouts[this.profile] = gesture.before;
                else delete this.layouts[this.profile];
                this.refresh();
            } else this._save();
            if (gesture.handle.hasPointerCapture?.(gesture.pointerId)) gesture.handle.releasePointerCapture(gesture.pointerId);
        }

        setWaveformVisible(visible) {
            if (visible === this.waveformVisible) return;
            this._finish(true);
            this.waveformVisible = visible;
            this.refresh();
            if (!visible && this.activePanel === 'wave') this.activate('byte');
        }

        setStep(step) {
            if (!STEPS.includes(step)) throw new RangeError('工作区步进需为 10、20 或 40 px');
            this._finish(true);
            this.step = step;
            this.refresh();
            this._save();
        }

        reset() {
            this._finish(true);
            this.layouts = {};
            this.refresh();
            this._save();
        }
    }

    const api = { MonitorWorkspace, fitWorkspaceRect, moveWorkspaceRect, resizeWorkspaceRect, defaultWorkspaceRects };
    root.SerialPlotter ??= {};
    Object.assign(root.SerialPlotter, api);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

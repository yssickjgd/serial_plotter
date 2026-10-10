/** Read-only pose view with bounded rendering, history targeting and camera interaction. */
(function (root) {
    const C = typeof module !== 'undefined' ? require('./poseConfig').PoseConfig : root.SerialPlotter.PoseConfig;
    const D = typeof module !== 'undefined' ? require('./poseData').PoseData : root.SerialPlotter.PoseData;
    const R = typeof module !== 'undefined' ? require('./poseRenderer').PoseRenderer : root.SerialPlotter.PoseRenderer;
    const timeText = timestamp => {
        if (!Number.isFinite(timestamp)) return '无时间';
        const d = new Date(timestamp), pad = (n, width = 2) => String(n).padStart(width, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    };
    class PoseView {
        constructor(canvas, frames, options = {}) {
            this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.frames = frames;
            this.settings = C.normalize(options.settings); this.statusElement = options.statusElement;
            this.now = options.now ?? (() => performance.now());
            this.raf = options.requestAnimationFrame ?? root.requestAnimationFrame.bind(root);
            this.cancelRaf = options.cancelAnimationFrame ?? root.cancelAnimationFrame.bind(root);
            this.cleanups = []; this.visible = true; this.followTail = true; this.targetOrder = null;
            this.isPaused = false; this.disposed = false; this.completedDraws = 0; this.lastDrawAt = -Infinity;
            this.revision = 0; this.renderedKey = null; this.lastValid = null; this.target = null;
            this.navigationMarkers = { timeOrder: null, matches: [], currentMatch: -1 };
            this.onCameraChange = options.onCameraChange ?? (() => {});
            this.getRebuilding = options.getRebuilding ?? (() => this.frames?.rebuilding);
            this.getGeneration = options.getGeneration ?? (() => 0); this.generation = this.getGeneration();
            this._bind(); this.resize();
        }
        _listen(target, type, fn, options) {
            if (!target?.addEventListener) return;
            target.addEventListener(type, fn, options); this.cleanups.push(() => target.removeEventListener(type, fn, options));
        }
        _bind() {
            this._listen(this.canvas, 'pointerdown', event => {
                if (event.button !== 0 || event.ctrlKey) return;
                event.preventDefault(); this.drag = { x: event.clientX, y: event.clientY, id: event.pointerId };
                this.canvas.setPointerCapture?.(event.pointerId);
            });
            this._listen(this.canvas, 'pointermove', event => {
                if (!this.drag || this.drag.id !== event.pointerId) return;
                const rect = this.canvas.getBoundingClientRect(), zoom = rect.width / this.width || 1;
                const camera = this.settings.camera;
                camera.azimuth -= (event.clientX - this.drag.x) / zoom * 0.01;
                camera.elevation = Math.max(-89 * Math.PI / 180, Math.min(89 * Math.PI / 180,
                    camera.elevation + (event.clientY - this.drag.y) / zoom * 0.01));
                this.drag.x = event.clientX; this.drag.y = event.clientY;
                this.revision++; this.requestRender();
            });
            const end = () => { if (this.drag) { this.drag = null; this.onCameraChange({ ...this.settings.camera }); } };
            for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) this._listen(this.canvas, name, end);
            this._listen(this.canvas, 'wheel', event => {
                if (event.ctrlKey) return;
                event.preventDefault(); event.stopPropagation?.();
                this.settings.camera.scale = Math.max(0.25, Math.min(4, this.settings.camera.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
                this.revision++; this.requestRender(); this.onCameraChange({ ...this.settings.camera });
            }, { passive: false });
            this._listen(this.canvas, 'contextmenu', event => {
                event.preventDefault(); this.settings.camera = C.defaults().camera;
                this.revision++; this.followLatest(); this.onCameraChange({ ...this.settings.camera });
            });
            this._listen(root.window, 'resize', () => this.resize());
            if (typeof root.ResizeObserver === 'function') {
                this.observer = new root.ResizeObserver(() => this.resize()); this.observer.observe(this.canvas);
            }
        }
        setFrames(frames) {
            if (frames === this.frames) return;
            this.frames = frames; this.clear();
        }
        setSettings(settings) {
            const next = C.normalize(settings);
            if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
            this.settings = next; this.revision++; this.lastValid = null; this.requestRender();
        }
        setPaused(paused) { this.isPaused = paused; this.requestRender(); }
        setVisible(visible) {
            this.visible = visible;
            if (visible) this.requestRender(); else if (this.pending) { this.cancelRaf(this.pending); this.pending = null; }
        }
        resize() {
            if (this.disposed) return;
            const rect = this.canvas.getBoundingClientRect();
            this.width = Math.max(1, this.canvas.clientWidth || rect.width); this.height = Math.max(1, this.canvas.clientHeight || rect.height);
            this.density = (rect.width / this.width || 1) * (root.window?.devicePixelRatio ?? root.devicePixelRatio ?? 1);
            const width = Math.max(1, Math.round(this.width * this.density)), height = Math.max(1, Math.round(this.height * this.density));
            if (this.canvas.width !== width || this.canvas.height !== height) {
                this.canvas.width = width; this.canvas.height = height; this.renderedKey = null;
            }
            this.requestRender();
        }
        invalidateData() {
            if (this.generation !== this.getGeneration()) { this.generation = this.getGeneration(); this.clear(); }
            this.requestRender();
        }
        clear() {
            this.lastValid = null; this.target = null; this.renderedKey = null; this.expired = false;
            this.followLatest();
        }
        requestRender() {
            if (this.disposed || !this.visible || this.pending) return;
            this.pending = this.raf(() => { this.pending = null; this._render(); });
        }
        _index() {
            const frames = this.frames;
            if (!frames?.length) return -1;
            if (this.followTail) return frames.length - 1;
            const index = frames.indexAtOrAfterOrder(this.targetOrder);
            if (index >= frames.length || frames.orderAt(index) !== this.targetOrder) {
                this.followTail = true; this.targetOrder = null; this.expired = true; return frames.length - 1;
            }
            return index;
        }
        _render() {
            if (this.disposed || !this.visible) return;
            const rebuilding = Boolean(this.getRebuilding());
            const index = this._index(), key = [this.frames?.version, this.frames?.orderAt(index), this.revision, this.width, this.height, this.density, rebuilding].join(':');
            if (key === this.renderedKey) return;
            if (this.now() - this.lastDrawAt < 1000 / 30) { this.requestRender(); return; }
            this.target = D.read(this.frames, index, this.settings);
            if (index < 0) this.lastValid = null;
            if (this.target.valid) this.lastValid = this.target;
            const stale = !this.target.valid && this.lastValid;
            this.ctx.setTransform(this.density, 0, 0, this.density, 0, 0);
            this.ctx.save(); this.ctx.globalAlpha = stale ? 0.35 : 1;
            R.draw(this.ctx, R.buildScene(this.settings, this.target.valid ? this.target : this.lastValid), this.settings.camera, this.width, this.height);
            this.ctx.restore();
            let status = this.target.valid ? `${timeText(this.target.timestamp)} · 有效位姿` : `${timeText(this.target.timestamp)} · ${this.target.reason}`;
            if (rebuilding) status = '重建中 · ' + status;
            if (stale) status += `；上一有效位姿 ${timeText(this.lastValid.timestamp)}`;
            if (this.expired) { status += '；历史帧已淘汰，恢复最新跟随'; this.expired = false; }
            if (this.navigationMarkers.timeOrder === this.target.order) status += ' · 时间定位';
            const { matches, currentMatch } = this.navigationMarkers;
            if (matches.some(match => this.target.order >= match.startOrder && this.target.order <= match.endOrder))
                status += matches[currentMatch] && this.target.order >= matches[currentMatch].startOrder && this.target.order <= matches[currentMatch].endOrder ? ' · 当前搜索命中' : ' · 搜索命中';
            if (this.statusElement) { this.statusElement.textContent = status; this.statusElement.dataset.valid = String(this.target.valid); }
            this.completedDraws++; this.lastDrawAt = this.now(); this.renderedKey = key;
        }
        jumpToFrame(index) {
            if (!Number.isInteger(index) || index < 0 || index >= this.frames.length) return false;
            this.followTail = false; this.targetOrder = this.frames.orderAt(index); this.requestRender(); return true;
        }
        jumpToByteOffset(offset) {
            if (!Number.isFinite(offset)) return false;
            let low = 0, high = this.frames.length;
            while (low < high) { const mid = Math.floor((low + high) / 2); if (this.frames.rawByteOffsetAt(mid) <= offset) low = mid + 1; else high = mid; }
            const index = low - 1;
            if (index < 0 || offset >= (this.frames.rawEndByteAt?.(index) ?? this.frames.rawByteOffsetAt(index) + this.frames.rawBytesAt(index).length)) return false;
            return this.jumpToFrame(index);
        }
        getReferenceByteOffset() { const index = this._index(); return index < 0 ? null : this.frames.rawByteOffsetAt(index); }
        followLatest() { this.followTail = true; this.targetOrder = null; this.navigationMarkers = { timeOrder: null, matches: [], currentMatch: -1 }; this.revision++; this.requestRender(); }
        setNavigationMarkers(markers) { this.navigationMarkers = { timeOrder: null, matches: [], currentMatch: -1, ...markers }; this.revision++; this.requestRender(); }
        setSearchResults(matches, currentMatch = -1) { this.setNavigationMarkers({ ...this.navigationMarkers, matches, currentMatch }); }
        dispose() {
            if (this.disposed) return; this.disposed = true;
            if (this.pending) this.cancelRaf(this.pending); this.pending = null;
            this.cleanups.splice(0).forEach(fn => fn()); this.observer?.disconnect(); this.drag = null; this.lastValid = null;
        }
    }
    root.SerialPlotter ??= {}; root.SerialPlotter.PoseView = PoseView;
    if (typeof module !== 'undefined') module.exports = { PoseView };
})(globalThis);

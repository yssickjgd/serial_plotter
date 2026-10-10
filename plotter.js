/* ═══════════════════════════════════════════════════════════════
 *  plotter.js — 波形绘图引擎
 *
 *  职责：Canvas 绘制、通道管理、视口缩放/平移、频谱展示、
 *        十字光标交互、滚动条与统计信息汇总。
 *
 *  代码结构：
 *    1. 构造函数（画布初始化、事件绑定、滚动条初始化）
 *    2. Resize（画布尺寸自适应）
 *    3. 通道管理（增删、颜色、可见性、名称）
 *    4. 数据与视口（addFrame、clear、pause、maxPoints）
 *    5. 频谱缓存与统计分析（FFT 实现在 spectrum.js）
 *    6. 交互事件（滚轮缩放、矩形框选、十字光标、滚动条拖拽）
 *    7. 渲染（renderLoop、draw、_drawCrosshair）
 * ═══════════════════════════════════════════════════════════════ */

const FFT_REFRESH_INTERVAL_MS = 100;
const plotterLimits = typeof module !== 'undefined'
    ? require('./projectLimits').PROJECT_LIMITS : globalThis.SerialPlotter.Limits;

class Plotter {
    /** 初始化画布、通道数组、视口状态、事件监听与滚动条 */
    constructor(canvasId, frames, options = {}) {
        this.canvas = typeof canvasId === 'string' ? document.getElementById(canvasId) : canvasId;
        this.document = this.canvas.ownerDocument ?? document;
        this.window = this.document.defaultView ?? window;
        this.viewOnly = options.viewOnly === true;
        this._listeners = [];
        this._raf = null;
        this._disposed = false;
        this._inViewport = true;
        this._sourceFirstOrder = frames.orderAt(0);
        this._timeWindowStartOrder = null;
        this.ctx    = this.canvas.getContext('2d');
        // 画布文本与 DOM 共用同一字体策略：英文/数字等宽，中文回退黑体
        this.fontFamily = typeof getComputedStyle === 'function'
            ? getComputedStyle(this.canvas).fontFamily : 'Consolas, monospace';

        this.channels = []; // display metadata; samples live in FrameBuffer
        this.frames = frames;
        this._fftCache = new Map();
        this._fftVersion = -1;
        this._fftInputRange = null;
        this._fftSourceMode = null;
        this._fftRevision = 0;
        this._fftAt = 0;
        this._lastDraw = 0;
        this._dirty = true;
        this._viewDirty = true;
        this.completedDraws = 0;
        this.completedSpectrumDraws = 0;
        this.defaultColors = [
            '#00FF7F','#FF4DC4','#00CFFF','#FFE040',
            '#FF6B35','#4FC3F7','#CE93D8','#A5D6A7',
            '#FFAB40','#EF9A9A','#80DEEA','#B0BEC5'
        ];

        this.isPaused     = false;
        this.isVisible    = true;
        this.maxPoints    = 1000;
        this.plotWindowPoints = 1000;
        this.pX           = 90;  // right margin for Y axis (needs room for 6 decimal places)
        this.pY           = 22;  // bottom margin for X axis
        this.displayMode  = 'time';
        this.sampleRateHz = 0;
        this.timeXUnit = 'samples';
        this.freqXUnit = 'hz';
        this.freqXScale = 'linear';
        this.freqYScale = 'linear';
        this.magnitudeUnit = 'amplitude'; this.dbFactor = 20; this.phaseUnwrap = false; this.responseSampleRate = 0;
        this.phaseUnit = 'degrees';
        this.yScaleModes = { time: 'auto', frequency: 'auto', phase: 'auto' };
        this.removeDcForFft = false;
        this.fftWindow = 'hann';
        this.onStatsUpdate = null;
        this._drawState = null;
        this._selection = null;
        this._timeCenterOrder = null;
        this.navigationMarkers = { timeOrder: null, matches: [], currentMatch: -1 };
        this.navigationColors = { match: '#745a00', current: '#ff8c00' };
        this._scrollbarDirty = false;
        this._boxZoomY = { time: null, frequency: null, phase: null };
        this._zoomBaseY = { time: null, frequency: null, phase: null };

        // 视口状态（时域/频域独立，通过 _vp getter 访问当前模式）
        this.vp = {
            time:      { scrollOffset: 0, displayCount: 1000, autoFollow: true },
            frequency: { scrollOffset: 0, displayCount: 1000, autoFollow: true },
            phase: { scrollOffset: 0, displayCount: 1000, autoFollow: true }
        };

        // Y 轴范围（时域/频域独立，通过 _yBounds getter 访问当前模式）
        this.yBounds = {
            time:      { min: -1, max: 1 },
            frequency: { min: 0.001, max: 1 },
            phase: { min: -180, max: 180 }
        };

        // 频域模式下 FFT bins 总数（由 draw() 更新，供 _clampScroll 使用）
        this._cachedScrollTotal = 0;

        // Crosshair
        this.mousePos = null; // {x, y} in logical drawing coordinates

        // Scrollbar DOM
        const elements = options.elements ?? (typeof canvasId === 'string' ? null : {});
        const element = (name, id) => elements ? elements[name] ?? null : this.document.getElementById(id);
        this.scrollbarWrap = element('scrollWrap', 'plot-scrollbar-wrap');
        this.scrollbarThumb = element('scrollThumb', 'plot-scrollbar-thumb');
        this.yScrollbarWrap = element('yScrollWrap', 'plot-y-scrollbar-wrap');
        this.yScrollbarThumb = element('yScrollThumb', 'plot-y-scrollbar-thumb');
        this.plotHeader = element('header', 'plot-header');
        this.plotInfoRow = element('infoRow', 'plot-info-row');
        this._initScrollbar();
        this._initYScrollbar();

        // Canvas events
        this._listen(this.canvas, 'wheel',       (e) => this._onWheel(e), { passive: false });
        this._listen(this.canvas, 'pointerdown', e => this._onPointerDown(e));
        this._listen(this.canvas, 'pointermove', e => this._onPointerMove(e));
        this._listen(this.canvas, 'pointerup', e => this._onPointerUp(e));
        this._listen(this.canvas, 'pointercancel', e => this._onPointerCancel(e));
        this._listen(this.canvas, 'lostpointercapture', e => this._onPointerCancel(e));
        this._listen(this.canvas, 'pointerleave', () => this._onMouseLeave());
        this._listen(this.canvas, 'contextmenu', e => {
            e.preventDefault(); this.followLatest();
        });

        this.resize();
        this._listen(this.window, 'resize', () => this.resize());
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.resize());
            this.resizeObserver.observe(this.canvas.parentElement);
        }
        if (typeof IntersectionObserver !== 'undefined') {
            this.intersectionObserver = new IntersectionObserver(entries => {
                this._inViewport = entries.at(-1)?.isIntersecting !== false;
                if (this._inViewport) this._scheduleRender();
                else this._cancelRender();
            });
            this.intersectionObserver.observe(this.canvas);
        }
        this._scheduleRender();
    }

    /** 返回当前显示模式对应的视口状态对象 */
    get _vp() { return this.vp[this.displayMode]; }
    get _logY() { return this.displayMode === 'frequency' && this.magnitudeUnit !== 'db' && this.freqYScale === 'log'; }

    /** 返回当前显示模式对应的 Y 轴范围对象 */
    get _yBounds() { return this.yBounds[this.displayMode]; }
    get yScaleMode() { return this.yScaleModes[this.displayMode]; }
    set yScaleMode(value) { this.yScaleModes[this.displayMode] = value; }

    _clearYZoom(mode) {
        this._boxZoomY[mode] = null;
        this._zoomBaseY[mode] = null;
    }

    _listen(target, name, listener, options) {
        if (!target?.addEventListener) return;
        target.addEventListener(name, listener, options);
        this._listeners.push(() => target.removeEventListener?.(name, listener, options));
    }

    _cancelRender() {
        if (this._raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
        this._raf = null;
    }

    _scheduleRender() {
        if (this._disposed || !this.isVisible || !this._inViewport || this._raf !== null ||
            !(this._dirty || this._scrollbarDirty) || (this.isPaused && !this._viewDirty)) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = null;
            this.renderLoop();
        });
    }

    _markViewDirty() {
        this._dirty = true;
        this._viewDirty = true;
        this._scheduleRender();
    }

    setVisible(visible) {
        if (this._disposed) return;
        this.isVisible = !!visible;
        if (this.isVisible) this._markViewDirty();
        else this._cancelRender();
    }

    setFrames(frames) {
        if (this._disposed || this.frames === frames) return;
        this.frames = frames;
        this._sourceFirstOrder = frames.orderAt(0);
        this._timeWindowStartOrder = null;
        this._fftCache.clear();
        this._fftVersion = -1;
        this._fftInputRange = null;
        this._drawState = null;
        this._timeCenterOrder = null;
        this._cachedScrollTotal = 0;
        this.setChannelCount(frames.channelCount);
        this.invalidateData();
    }

    invalidateData() {
        if (this._disposed) return;
        const view = this.vp.time;
        if (view.autoFollow) view.scrollOffset = Math.max(0, this.frames.length - view.displayCount);
        else if (Number.isFinite(this._timeWindowStartOrder) &&
            this.frames.orderAt(0) !== this._sourceFirstOrder)
            view.scrollOffset = Math.max(0, this.frames.indexAtOrAfterOrder(this._timeWindowStartOrder));
        this._sourceFirstOrder = this.frames.orderAt(0);
        this._timeWindowStartOrder = this.frames.orderAt(Math.floor(view.scrollOffset));
        this._dirty = true;
        this._scrollbarDirty = true;
        this._scheduleRender();
    }

    onDataChanged() { this.invalidateData(); }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._cancelRender();
        for (const remove of this._listeners.splice(0)) remove();
        this.resizeObserver?.disconnect();
        this.intersectionObserver?.disconnect();
        if (this._selection && this.canvas.hasPointerCapture?.(this._selection.pointerId))
            this.canvas.releasePointerCapture?.(this._selection.pointerId);
        this._selection = null;
        this.onStatsUpdate = null;
        this.onViewportChange = null;
        this.onStatusUpdate = null;
    }

    /** Retain shared time/search markers; only visible matches are drawn. */
    followLatest() {
        const previousViewport = this._viewportState();
        this._selection = null; this._timeCenterOrder = null;
        this._markViewDirty();
        this._vp.displayCount = this.displayMode === 'time'
            ? this.plotWindowPoints : this.frames.responseMode ? this._scrollTotal() : this.maxPoints;
        this._vp.autoFollow = true;
        this._clampScroll();
        this.vp.time.displayCount = this.plotWindowPoints;
        this.vp.time.autoFollow = true;
        this.vp.time.scrollOffset = Math.max(0, this.frames.length - this.plotWindowPoints);
        this._timeWindowStartOrder = this.frames.orderAt(this.vp.time.scrollOffset);
        if (this.displayMode !== 'time') this._clearYZoom('time');
        this._clearYZoom(this.displayMode);
        if (this.isPaused) this.draw();
        this._notifyViewportChange(previousViewport);
    }

    setNavigationMarkers({ timeOrder = null, matches = [], currentMatch = -1 }, redraw = true) {
        this.navigationMarkers = { timeOrder, matches, currentMatch };
        this._markViewDirty();
        if (redraw && this.isPaused && this.isVisible) this.draw();
    }

    setNavigationColors(colors = {}) {
        const next = { match: '#745a00', current: '#ff8c00', ...this.navigationColors, ...colors };
        for (const key of ['match', 'current']) {
            if (typeof next[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(next[key]))
                throw new TypeError('搜索标记颜色必须为六位 Hex 颜色');
        }
        this.navigationColors = next;
        this._markViewDirty();
        if (this.isPaused && this.isVisible) this.draw();
    }

    /* ── Resize ── */
    _displayScale() { return Number(this.canvas.closest?.('.workspace-surface')?.dataset.workspaceZoom) || 1; }

    /** 根据父容器尺寸重置画布宽高，并刷新滚动条 */
    resize() {
        if (this._disposed) return;
        if (this._selection)
            this.vp[this._selection.mode].autoFollow = this._selection.autoFollow;
        this._selection = null;
        this._markViewDirty();
        const rect = this.canvas.parentElement.getBoundingClientRect();
        const css = typeof getComputedStyle === 'function' ? getComputedStyle(this.canvas.parentElement) : null;
        const inset = names => names.reduce((sum, name) => sum + (parseFloat(css?.[name]) || 0), 0);
        const insetX = inset(['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']);
        const insetY = inset(['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']);
        const sbH  = this.scrollbarWrap ? this.scrollbarWrap.offsetHeight : 12;
        const headH = this.plotHeader ? this.plotHeader.offsetHeight : 0;
        const displayScale = this._displayScale();
        this.width = Math.max(100, Math.floor(rect.width / displayScale - insetX));
        this.height = Math.max(60, Math.floor(rect.height / displayScale - sbH - headH - insetY));
        const deviceRatio = Number(this.window.devicePixelRatio);
        const density = Math.max(1, displayScale *
            (Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1));
        // Drawing and pointer coordinates stay logical; only the backing bitmap grows.
        const pixelWidth = Math.ceil(this.width * density);
        const pixelHeight = Math.ceil(this.height * density);
        if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
        if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
        this._updateScrollbar();
        if (this.isPaused) this.draw();
    }

    /* ── 通道管理 ── */
    /** 调整通道数量，不足时按默认色板补全，超出时裁剪 */
    setChannelCount(count) {
        if (!this.viewOnly) this.frames.setChannelCount(count);
        this._cachedScrollTotal = 0;
        while (this.channels.length < count) {
            const idx = this.channels.length;
            this.channels.push({
                color:   this.defaultColors[idx % this.defaultColors.length],
                visible: false,
                name:    globalThis.SerialPlotter.formatChannelId(idx),
                gainEnabled: false, gain: 1,
                offsetEnabled: false, offset: 0
            });
        }
        while (this.channels.length > count) this.channels.pop();
        this._clampScroll();
        this._markViewDirty();
        this._updateScrollbar();
        if (this.isPaused) this.draw();
    }

    /** Return channel display metadata and calibration settings for UI and CSV. */
    getChannelMeta() {
        return this.channels.map((ch, i) => ({
            index: i, name: ch.name, color: ch.color, visible: ch.visible,
            ...(this.frames.isSignal ? { signal: this.frames.isSignal(i) } : {}),
            gainEnabled: ch.gainEnabled, gain: ch.gain,
            offsetEnabled: ch.offsetEnabled, offset: ch.offset
        }));
    }

    /** 设置指定通道的绘制颜色 */
    setChannelColor(index, color)     { if (this.channels[index]) { this.channels[index].color = color; this._markViewDirty(); } }
    /** 设置指定通道的可见性，隐藏时跳过绘制 */
    setChannelVisible(index, visible) {
        if (this.channels[index]) {
            this.channels[index].visible = visible;
            this._fftVersion = -1;
            this._markViewDirty();
            this._clampScroll();
            this._updateScrollbar();
            this.draw();
        }
    }
    /** 设置指定通道的显示名称 */
    setChannelName(index, name) {
        if (!this.channels[index]) return;
        this.channels[index].name = !name || name === `CH${index + 1}`
            ? globalThis.SerialPlotter.formatChannelId(index) : name;
        this._markViewDirty();
    }
    /** Update one channel's linear calibration and invalidate dependent spectra. */
    setChannelTransform(index, settings) {
        const channel = this.channels[index];
        if (!channel) return;
        const gain = Number(settings.gain);
        const offset = Number(settings.offset);
        if (!Number.isFinite(gain) || !Number.isFinite(offset))
            throw new RangeError('通道变换参数必须为有限数值');
        Object.assign(channel, {
            gainEnabled: settings.gainEnabled === true, gain,
            offsetEnabled: settings.offsetEnabled === true, offset
        });
        this._fftVersion = -1;
        this._markViewDirty();
        if (this.isPaused) this.draw();
    }
    /** 批量设置所有通道的可见性 */
    setAllChannelsVisible(visible) {
        this.channels.forEach(ch => { ch.visible = visible; });
        this._fftVersion = -1;
        this._markViewDirty();
        this._clampScroll();
        this._updateScrollbar();
        this.draw();
    }

    /** Apply imported channel settings with one cache reset and one draw. */
    setChannelSettings(settings) {
        settings.forEach((setting, index) => {
            const channel = this.channels[index];
            if (!channel) return;
            if (setting.color !== undefined) channel.color = setting.color;
            channel.visible = setting.visible !== false;
            channel.name = !setting.name || setting.name === `CH${index + 1}`
                ? globalThis.SerialPlotter.formatChannelId(index) : setting.name;
            channel.gainEnabled = setting.gainEnabled === true;
            channel.gain = setting.gain === undefined ? 1 : Number(setting.gain);
            channel.offsetEnabled = setting.offsetEnabled === true;
            channel.offset = setting.offset === undefined ? 0 : Number(setting.offset);
        });
        this._fftVersion = -1;
        this._markViewDirty();
        this._clampScroll();
        this._updateScrollbar();
        this.draw();
    }
    /** 应用绘图显示选项（时域/频域、Y 轴策略、去直流、Y 轴范围等） */
    setDisplayOptions(opts = {}) {
        const oldMode = this.displayMode;
        const oldDc = this.removeDcForFft;
        const oldWindow = this.fftWindow;
        const oldUnit = this.magnitudeUnit, oldFactor = this.dbFactor, oldUnwrap = this.phaseUnwrap;
        const oldScales = { ...this.yScaleModes };
        const oldFreqYScale = this.freqYScale;
        const oldBounds = {
            time: { ...this.yBounds.time },
            frequency: { ...this.yBounds.frequency }, phase: { ...this.yBounds.phase }
        };
        if (opts.displayMode || opts.viewMode) this.displayMode = opts.displayMode || opts.viewMode;
        if (opts.yScaleMode) this.yScaleMode = opts.yScaleMode;
        if (opts.yScaleModeTime) this.yScaleModes.time = opts.yScaleModeTime;
        if (opts.yScaleModeFreq) this.yScaleModes.frequency = opts.yScaleModeFreq;
        if (opts.timeXUnit) this.timeXUnit = opts.timeXUnit;
        if (opts.freqXUnit) this.freqXUnit = opts.freqXUnit;
        if (opts.freqXScale) this.freqXScale = opts.freqXScale;
        if (opts.freqYScale) this.freqYScale = opts.freqYScale;
        if (opts.magnitudeUnit) this.magnitudeUnit = opts.magnitudeUnit;
        if (opts.dbFactor !== undefined) this.dbFactor = Number(opts.dbFactor);
        if (opts.phaseUnwrap !== undefined) this.phaseUnwrap = opts.phaseUnwrap;
        if (opts.phaseUnit && opts.phaseUnit !== this.phaseUnit) {
            const factor = opts.phaseUnit === 'radians' ? Math.PI / 180 : 180 / Math.PI;
            this.phaseUnit = opts.phaseUnit;
            // Bounds and interactive zooms use display units; FFT caches always keep degrees.
            for (const bounds of [this.yBounds.phase, oldBounds.phase,
                this._boxZoomY.phase, this._zoomBaseY.phase]) {
                if (bounds) { bounds.min *= factor; bounds.max *= factor; }
            }
        }
        if (opts.responseSampleRate !== undefined) this.responseSampleRate = Number(opts.responseSampleRate);
        if (opts.yScaleModePhase) this.yScaleModes.phase = opts.yScaleModePhase;
        if (opts.yMinPhase !== undefined) this.yBounds.phase.min = Number(opts.yMinPhase);
        if (opts.yMaxPhase !== undefined) this.yBounds.phase.max = Number(opts.yMaxPhase);
        if (opts.removeDcForFft !== undefined) this.removeDcForFft = !!opts.removeDcForFft;
        if (opts.fftWindow) this.fftWindow = opts.fftWindow;
        if (opts.yMinTime !== undefined && opts.yMinTime !== '') this.yBounds.time.min = parseFloat(opts.yMinTime);
        if (opts.yMaxTime !== undefined && opts.yMaxTime !== '') this.yBounds.time.max = parseFloat(opts.yMaxTime);
        if (opts.yMinFreq !== undefined && opts.yMinFreq !== '') this.yBounds.frequency.min = parseFloat(opts.yMinFreq);
        if (opts.yMaxFreq !== undefined && opts.yMaxFreq !== '') this.yBounds.frequency.max = parseFloat(opts.yMaxFreq);
        if (oldMode !== this.displayMode && this._selection) {
            this.vp[this._selection.mode].autoFollow = this._selection.autoFollow;
            this._selection = null;
        }
        if (opts.resetYZoom) this._clearYZoom(this.displayMode);
        if (oldFreqYScale !== this.freqYScale) this._clearYZoom('frequency');
        if (oldUnit !== this.magnitudeUnit || oldFactor !== this.dbFactor) this._clearYZoom('frequency');
        if (oldUnwrap !== this.phaseUnwrap) this._clearYZoom('phase');
        for (const mode of ['time', 'frequency', 'phase']) {
            if (oldScales[mode] !== this.yScaleModes[mode] ||
                oldBounds[mode].min !== this.yBounds[mode].min ||
                oldBounds[mode].max !== this.yBounds[mode].max)
                this._clearYZoom(mode);
        }
        if (oldMode !== this.displayMode || oldDc !== this.removeDcForFft ||
            oldWindow !== this.fftWindow) this._fftVersion = -1;
        this._markViewDirty();
        if (this.isPaused) this.draw();
    }

    /** 追加一帧数据到各通道缓冲区，超出 maxPoints 时自动丢弃最早数据 */
    addFrame(valuesArray, frameBytes, timeStr, order, timestamp, metadata) {
        if (this._disposed || this.viewOnly) return;
        if (this.isPaused && !metadata?.capturedBeforePause) return;
        const timeView = this.vp.time;
        const previousLength = this.frames.length;
        const previousOffset = timeView.scrollOffset;
        const evictsOldest = previousLength === this.frames.capacity;
        this.frames.append(valuesArray, frameBytes, timeStr, order, timestamp, metadata);
        if (timeView.autoFollow)
            timeView.scrollOffset = Math.max(0, this.frames.length - timeView.displayCount);
        else {
            if (evictsOldest) timeView.scrollOffset = Math.max(0, previousOffset - 1);
            this._scrollbarDirty = true;
        }
        if (this.displayMode !== 'time' && this._vp.autoFollow)
            this._vp.scrollOffset = Math.max(0, this._scrollTotal() - this._vp.displayCount);
        if (this.displayMode !== 'time' || timeView.autoFollow ||
            previousLength < previousOffset + timeView.displayCount ||
            (evictsOldest && previousOffset === 0)) this._dirty = true;
        this._sourceFirstOrder = this.frames.orderAt(0);
        this._scheduleRender();
    }

    /** 清空所有通道数据，重置时域/频域视口到跟随模式 */
    clear() {
        this._selection = null;
        this._timeCenterOrder = null;
        this.navigationMarkers = { timeOrder: null, matches: [], currentMatch: -1 };
        this._clearYZoom('time');
        this._clearYZoom('frequency');
        if (!this.viewOnly) this.frames.clear();
        this.sampleRateHz = 0;
        this._fftVersion = -1;
        this._cachedScrollTotal = 0;
        for (const mode of ['time', 'frequency', 'phase']) {
            this.vp[mode].scrollOffset = 0;
            this.vp[mode].autoFollow = true;
        }
        this._updateScrollbar(); this.draw();
    }

    /** 切换暂停状态，返回当前是否暂停 */
    togglePause() {
        this.isPaused = !this.isPaused;
        this._markViewDirty();
        return this.isPaused;
    }

    /** 使用共享数据源的稳定采样率换算坐标，暂停时保留该值。 */
    setSampleRateHz(rate) {
        if (!Number.isFinite(rate) || rate <= 0) return;
        if (rate !== this.sampleRateHz) {
            this.sampleRateHz = rate;
            this._markViewDirty();
        }
    }

    _formatFrequencyBin(bin, fftSize, unit = this.freqXUnit) {
        if (this.frames.responseMode && unit !== 'bins') {
            if (!(fftSize > 0)) return '-- cycles/sample';
            return this.responseSampleRate > 0 ? `${this._formatAxisNumber(bin * this.responseSampleRate / fftSize)} Hz`
                : `${this._formatAxisNumber(bin / fftSize)} cycles/sample`;
        }
        if (unit === 'bins') return String(Math.round(bin));
        if (!(this.sampleRateHz > 0) || !(fftSize > 0)) return '-- Hz';
        return `${this._formatAxisNumber(bin * this.sampleRateHz / fftSize)} Hz`;
    }

    _formatAxisNumber(value) {
        return Number(value > 0 && value < 0.001 ? value.toPrecision(4) : value.toFixed(3));
    }

    _formatTimeIndex(index, unit = this.timeXUnit) {
        if (unit !== 's') return String(index);
        if (!(this.sampleRateHz > 0)) return '-- s';
        return `${this._formatAxisNumber(index / this.sampleRateHz)} s`;
    }

    /** 设置每个通道的最大采样点数 */
    setMaxPoints(size) {
        const fullFrequencyView = this.vp.frequency.autoFollow &&
            this.vp.frequency.displayCount === this.maxPoints;
        if (!this.viewOnly) this.frames.resize(size);
        this._cachedScrollTotal = 0;
        this.maxPoints = size;
        const windowShrank = this.plotWindowPoints > size;
        this.plotWindowPoints = Math.min(this.plotWindowPoints, size);
        this.vp.time.displayCount = Math.min(this.vp.time.displayCount, this.plotWindowPoints);
        if (windowShrank) {
            this.vp.time.displayCount = this.plotWindowPoints;
            this.vp.time.autoFollow = true;
            this.vp.time.scrollOffset = Math.max(0, this.frames.length - this.plotWindowPoints);
            this._clearYZoom('time');
        }
        this.vp.frequency.displayCount = fullFrequencyView ? size
            : Math.min(this.vp.frequency.displayCount, size);
        this._clampScroll();
        this._markViewDirty();
    }

    setPlotWindowPoints(size) {
        if (!Number.isSafeInteger(size) || size < plotterLimits.minPoints ||
            size > Math.min(this.maxPoints, plotterLimits.maxPlotWindowPoints))
            throw new RangeError(`波形监视台内采样点数需为 ${plotterLimits.minPoints}–${Math.min(
                this.maxPoints, plotterLimits.maxPlotWindowPoints)}`);
        if (size === this.plotWindowPoints) return;
        this._timeCenterOrder = null;
        this.plotWindowPoints = size;
        this.vp.time.displayCount = size;
        this.vp.time.scrollOffset = Math.max(0, this.frames.length - size);
        this.vp.time.autoFollow = true;
        this._clearYZoom('time');
        this._markViewDirty();
        if (this.displayMode === 'time') this._updateScrollbar();
        if (this.isPaused) this.draw();
    }

    jumpToFrame(index) {
        if (this.frames.responseMode) return false;
        if (!this.frames.length) return false;
        const target = Math.max(0, Math.min(this.frames.length - 1, Math.round(index)));
        const view = this.vp.time;
        const count = Math.max(2, Math.min(this.plotWindowPoints, view.displayCount));
        view.displayCount = count;
        view.autoFollow = false;
        this._timeCenterOrder = this.frames.orderAt(target);
        view.scrollOffset = this._timeViewportRange().start;
        this._timeWindowStartOrder = this.frames.orderAt(view.scrollOffset);
        this._markViewDirty();
        if (this.displayMode === 'time') this._updateScrollbar();
        if (this.isPaused && this.isVisible) this.draw();
        return true;
    }

    /** Search reference index; an even-sized viewport can be centered between samples. */
    currentFrameIndex() { return this.currentTimeFrameIndex(); }

    getReferenceByteOffset() {
        if (this.frames.responseMode) return null;
        const index = Math.round(this.currentTimeFrameIndex());
        return index < 0 ? null : this.frames.rawByteOffsetAt(index) ?? null;
    }

    jumpToByteOffset(offset) {
        if (!Number.isFinite(offset) || !this.frames.length) return false;
        let low = 0, high = this.frames.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (this.frames.rawByteOffsetAt(mid) <= offset) low = mid + 1;
            else high = mid;
        }
        const index = low - 1;
        if (index < 0 || offset >= this.frames.rawByteOffsetAt(index) + this.frames.rawBytesAt(index).length)
            return false;
        return this.jumpToFrame(index);
    }

    currentTimeFrameIndex() {
        if (this.frames.responseMode) return -1;
        if (!this.frames.length) return -1;
        if (this.vp.time.autoFollow && this._timeCenterOrder === null) return this.frames.length - 1;
        if (this._timeCenterOrder !== null) {
            const range = this._timeViewportRange();
            if (this._timeCenterOrder !== null)
                return range.start + Math.floor((range.end - range.start) / 2);
        }
        const range = this._timeViewportRange();
        const center = range.start + (range.end - range.start - 1) / 2;
        return Math.max(0, Math.min(this.frames.length - 1, center));
    }

    /* ── FFT & 统计分析 ── */

    /**
     * 汇总单通道的统计信息，多通道返回 null。
     * 基本统计在时域使用当前视口，在频域使用 FFT 输入范围；
     * 主频/主周期与频谱使用同一输入范围：实时为全量，暂停为时域视口。
     */
    _buildSummary(visibleSeries, viewMode) {
        if (this.frames.responseMode) return null;
        if (visibleSeries.length !== 1) {
            return null;
        }
        const series = visibleSeries[0];
        const range = viewMode !== 'time' ? this._frequencyInputRange() : null;
        const values = range
            ? this._transformedChannelSlice(series.channelIndex, range.start, range.end)
            : series.rawValues;
        if (!values || values.length === 0) return null;

        // 基本统计：基于视口窗口数据
        let min = Infinity, max = -Infinity;
        let sum = 0;
        let sumSq = 0;
        let validCount = 0;
        for (const v of values) {
            if (!Number.isFinite(v)) continue;
            min = Math.min(min, v);
            max = Math.max(max, v);
            sum += v;
            sumSq += v * v;
            validCount++;
        }
        if (!validCount) return null;
        const pp = max - min;
        const mean = sum / validCount;
        const variance = Math.max(0, sumSq / validCount - mean * mean);
        const stdDev = Math.sqrt(variance);

        // 主频/主周期：与当前 FFT 输入一致，不随频域视口滚动而变化。
        const freqSeries = this._frequencyForChannel(series.channelIndex);
        const freq = freqSeries.dominantBin && freqSeries.fftSize ? freqSeries.dominantBin / freqSeries.fftSize : 0;
        const period = freqSeries.dominantBin ? (freqSeries.fftSize / freqSeries.dominantBin) : 0;
        return {
            channelLabel: series.ch.name || globalThis.SerialPlotter.formatChannelId(series.channelIndex),
            max,
            min,
            pp,
            mean,
            stdDev,
            freq,
            dominantBin: freqSeries.fftSize ? freqSeries.dominantBin : null,
            period: period || null
        };
    }

    /** 通过 onStatsUpdate 回调向 app.js 推送统计信息 */
    _emitStats(stats) {
        if (this.onStatsUpdate) this.onStatsUpdate(stats || null);
    }

    _transformedChannelSlice(index, start = 0, end = this.frames.length) {
        const values = this.frames.channelSlice(index, start, end);
        const channel = this.channels[index];
        if (!channel.gainEnabled && !channel.offsetEnabled) return values;
        for (let i = 0; i < values.length; i++)
            values[i] = globalThis.SerialPlotter.transformChannelValue(values[i], channel);
        return values;
    }

    /** Center where possible, but never extend a time window past retained samples. */
    _timeViewportRange() {
        const total = this.frames.length;
        const count = Math.min(total, Math.max(2, Math.floor(this.vp.time.displayCount)));
        let start = Math.floor(this.vp.time.scrollOffset);
        if (this._timeCenterOrder !== null) {
            const center = this.frames.indexAtOrAfterOrder(this._timeCenterOrder);
            if (this.frames.orderAt(center) === this._timeCenterOrder) start = center - Math.floor(count / 2);
            else this._timeCenterOrder = null;
        }
        start = Math.max(0, Math.min(start, total - count));
        return { start, end: start + count };
    }

    /** 实时取最新全局窗口；暂停取实际显示的时域样本范围。 */
    _frequencyInputRange() {
        const total = this.frames.length;
        return this.isPaused ? this._timeViewportRange()
            : { start: Math.max(0, total - this.plotWindowPoints), end: total };
    }

    /** 对所有可见通道的当前输入范围执行 FFT，结果缓存在 Map 中供 draw 复用。 */
    _computeFftForVisibleChannels() {
        if (this.frames.rawMode) { this._fftCache.clear(); return this._fftCache; }
        const now = performance.now();
        const range = this.frames.responseMode ? { start: 0, end: this.frames.count } : this._frequencyInputRange();
        const sourceMode = this.frames.responseMode ? 'static' : this.isPaused ? 'paused' : 'live';
        const sameRange = this._fftInputRange &&
            this._fftInputRange.start === range.start && this._fftInputRange.end === range.end;
        if ((this._fftVersion === this.frames.version && sameRange) ||
            (this._fftVersion >= 0 && sourceMode === 'live' &&
                this._fftSourceMode === 'live' &&
                now - this._fftAt < FFT_REFRESH_INTERVAL_MS)) return this._fftCache;
        const results = new Map();
        for (let idx = 0; idx < this.channels.length; idx++) {
            const ch = this.channels[idx];
            if (!ch.visible || this.frames.length === 0) continue;
            results.set(idx, this.frames.responseMode ? this.frames.frequencyForChannel(idx) : globalThis.SerialPlotter.prepareFrequencySeries(
                this._transformedChannelSlice(idx, range.start, range.end),
                this.removeDcForFft, this.fftWindow));
        }
        this._fftCache = results;
        this._fftVersion = this.frames.version;
        this._fftInputRange = range;
        this._fftSourceMode = sourceMode;
        this._fftAt = now;
        if (results.size > 0) this._fftRevision++;
        return results;
    }

    _frequencyForChannel(index) {
        const results = this._computeFftForVisibleChannels();
        return results.get(index) || { mags: [], dominantBin: 0, fftSize: 0 };
    }

    /**
     * 收集可见通道的数据：
     *   - 时域模式：取视口范围 [startIdx, actualEnd) 内的数据
     *   - 频域模式：取预计算的 FFT 结果中 [startIdx, actualEnd) 范围的频谱 bins
     */
    _collectWindowSeries(startIdx, actualEnd, fftResults) {
        const series = [];
        for (let idx = 0; idx < this.channels.length; idx++) {
            const ch = this.channels[idx];
            if (!ch.visible || this.frames.length === 0) continue;
            if (this.displayMode !== 'time') {
                const freq = fftResults.get(idx);
                if (!freq || freq.mags.length === 0) continue;
                // 取视口范围内的频谱 bins
                let values = freq.mags;
                if (this.displayMode === 'phase') {
                    values = this.phaseUnwrap
                        ? globalThis.SerialPlotter.unwrapPhaseDegrees(freq.phases ?? []) : freq.phases ?? [];
                    if (this.phaseUnit === 'radians') values = values.map(value => value * Math.PI / 180);
                }
                else if (this.magnitudeUnit === 'db') values = freq.mags.map(value => globalThis.SerialPlotter.decibelMagnitude(value, this.dbFactor));
                const mags = values.slice(startIdx, actualEnd);
                if (mags.length === 0) continue;
                series.push({
                    channelIndex: idx, ch,
                    mags,
                    dominantBin: freq.dominantBin,
                    fftSize: freq.fftSize
                });
            } else {
                const rawValues = this._transformedChannelSlice(idx, startIdx, actualEnd);
                if (rawValues.length === 0) continue;
                series.push({ channelIndex: idx, ch, rawValues, mags: rawValues, dominantBin: 0, fftSize: rawValues.length });
            }
        }
        return series;
    }

    /* ── 交互事件 ── */

    _viewportState() {
        return this.onViewportChange ? JSON.stringify([this.vp, this._boxZoomY, this._zoomBaseY, this._timeCenterOrder]) : null;
    }

    _notifyViewportChange(previous) {
        if (!this._disposed && this.onViewportChange && previous !== this._viewportState()) this.onViewportChange();
    }

    /** 绘图区和 X 轴刻度带缩放 X；Y 轴刻度带缩放 Y。 */
    _onWheel(e) {
        e.preventDefault();
        const point = this._pointFromPointer(e);
        const plotW = this.width - this.pX;
        const plotH = this.height - this.pY;
        if (point.x > plotW && point.x <= this.width &&
            point.y >= 0 && point.y <= this.height) {
            this._zoomYAt(point.y, e.deltaY);
        } else if (point.x >= 0 && point.x <= plotW &&
            point.y >= 0 && point.y <= this.height) {
            this._zoomXAt(point.x, e.deltaY);
        }
    }

    _zoomXAt(mouseX, deltaY) {
        const previousViewport = this._viewportState();
        this._markViewDirty();
        const total = this._scrollTotal();
        if (total < 2) return;
        const plotW  = this.width - this.pX;
        const ratio  = Math.max(0, Math.min(1, mouseX / plotW));
        const factor = deltaY < 0 ? 0.8 : 1.25;
        const currentCount = Math.min(this._vp.displayCount, total);
        const limit = this.frames.responseMode ? total : this.displayMode === 'time' ? this.plotWindowPoints : this.maxPoints;
        const nextCount = Math.round(Math.max(2, Math.min(limit, total, currentCount * factor)));
        if (this.displayMode !== 'time' && this.freqXScale === 'log') {
            const first = Math.max(1, this._vp.scrollOffset);
            const last = Math.min(total - 1, first + this._vp.displayCount - 1);
            const anchor = globalThis.SerialPlotter.axisValueAtFraction(ratio, first, last, 'log');
            let low = 1, high = Math.max(1, total - nextCount);
            for (let i = 0; i < 24; i++) {
                const candidate = (low + high) / 2;
                const end = Math.min(total - 1, candidate + nextCount - 1);
                if (globalThis.SerialPlotter.axisValueAtFraction(ratio, candidate, end, 'log') < anchor)
                    low = candidate;
                else high = candidate;
            }
            this._vp.scrollOffset = Math.round((low + high) / 2);
        } else {
            const anchorIdx = this.displayMode === 'time' && this._timeCenterOrder !== null
                ? this._drawState.startIdx + ratio * currentCount
                : this._vp.scrollOffset + ratio * currentCount;
            this._vp.scrollOffset = Math.round(anchorIdx - ratio * nextCount);
        }
        if (this.displayMode === 'time') this._timeCenterOrder = null;
        this._vp.displayCount = nextCount;
        this._vp.autoFollow   = false;
        this._clampScroll();
        this._updateScrollbar();
        if (this.isPaused) this.draw();
        this._notifyViewportChange(previousViewport);
    }

    _zoomYAt(mouseY, deltaY) {
        const previousViewport = this._viewportState();
        const state = this._drawState;
        if (!state || !(state.max > state.min)) return;
        const mode = this.displayMode;
        const scale = state.yScale;
        const toDomain = value => globalThis.SerialPlotter.axisToDomain(value, scale);
        const fromDomain = value => globalThis.SerialPlotter.axisFromDomain(value, scale);
        const base = this._zoomBaseY[mode] || { min: state.min, max: state.max, yScale: scale };
        const baseMin = toDomain(base.min), baseMax = toDomain(base.max);
        const currentMin = toDomain(state.min), currentMax = toDomain(state.max);
        const baseSpan = baseMax - baseMin;
        const currentSpan = currentMax - currentMin;
        if (!(baseSpan > 0) || !(currentSpan > 0)) return;
        const anchorRatio = 1 - Math.max(0, Math.min(1, mouseY / state.plotH));
        const factor = deltaY < 0 ? 0.8 : 1.25;
        const nextSpan = Math.min(baseSpan, currentSpan * factor);
        if (nextSpan >= baseSpan * (1 - 1e-12)) {
            this._clearYZoom(mode);
        } else {
            const anchor = currentMin + anchorRatio * currentSpan;
            const nextMin = Math.max(baseMin,
                Math.min(baseMax - nextSpan, anchor - anchorRatio * nextSpan));
            this._zoomBaseY[mode] = base;
            this._boxZoomY[mode] = {
                min: fromDomain(nextMin), max: fromDomain(nextMin + nextSpan)
            };
        }
        this._markViewDirty();
        this._updateYScrollbar();
        if (this.isPaused) this.draw();
        this._notifyViewportChange(previousViewport);
    }

    _onMouseLeave() {
        this._markViewDirty();
        this.mousePos = null;
        if (this.isPaused) this.draw();
    }

    _pointFromPointer(event) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * this.width / rect.width,
            y: (event.clientY - rect.top) * this.height / rect.height
        };
    }

    _onPointerDown(event) {
        if (event.button !== 0 || !this._drawState) return;
        const point = this._pointFromPointer(event);
        const { plotW, plotH } = this._drawState;
        if (point.x < 0 || point.x > plotW || point.y < 0 || point.y > plotH) return;
        event.preventDefault();
        this._selection = {
            pointerId: event.pointerId, mode: this.displayMode,
            autoFollow: this._vp.autoFollow,
            x0: point.x, y0: point.y, x1: point.x, y1: point.y
        };
        this._vp.autoFollow = false;
        this.mousePos = null;
        if (this.canvas.setPointerCapture) this.canvas.setPointerCapture(event.pointerId);
        this._markViewDirty();
        if (this.isPaused) this.draw();
    }

    _onPointerMove(event) {
        const point = this._pointFromPointer(event);
        if (this._selection) {
            if (event.pointerId !== this._selection.pointerId) return;
            const { plotW, plotH } = this._drawState;
            this._selection.x1 = Math.max(0, Math.min(plotW, point.x));
            this._selection.y1 = Math.max(0, Math.min(plotH, point.y));
            this.mousePos = null;
        } else {
            this.mousePos = point;
        }
        this._markViewDirty();
        if (this.isPaused) this.draw();
    }

    _onPointerUp(event) {
        const previousViewport = this._viewportState();
        const selection = this._selection;
        if (!selection || event.pointerId !== selection.pointerId) return;
        this._onPointerMove(event);
        this._selection = null;
        if (this.canvas.releasePointerCapture &&
            (!this.canvas.hasPointerCapture || this.canvas.hasPointerCapture(event.pointerId)))
            this.canvas.releasePointerCapture(event.pointerId);
        const state = this._drawState;
        const zoom = state && selection.mode === this.displayMode
            ? globalThis.SerialPlotter.zoomRectToBounds({
                ...selection, plotWidth: state.plotW, plotHeight: state.plotH,
                startIndex: state.startIdx, visibleCount: state.visibleCnt,
                min: state.min, max: state.max,
                xScale: state.xScale, yScale: state.yScale
            }) : null;
        if (zoom) {
            if (this.displayMode === 'time') this._timeCenterOrder = null;
            this._vp.scrollOffset = zoom.scrollOffset;
            this._vp.displayCount = zoom.displayCount;
            this._clampScroll();
            this._vp.autoFollow = false;
            if (!this._zoomBaseY[this.displayMode])
                this._zoomBaseY[this.displayMode] = { min: state.min, max: state.max, yScale: state.yScale };
            this._boxZoomY[this.displayMode] = { min: zoom.yMin, max: zoom.yMax };
        } else if (selection.mode === this.displayMode) {
            this._vp.autoFollow = selection.autoFollow;
        }
        this._markViewDirty();
        this.draw();
        if (zoom) this._notifyViewportChange(previousViewport);
    }

    _onPointerCancel(event) {
        if (!this._selection || event.pointerId !== this._selection.pointerId) return;
        if (this._selection.mode === this.displayMode)
            this._vp.autoFollow = this._selection.autoFollow;
        this._selection = null;
        this._markViewDirty();
        if (this.isPaused) this.draw();
    }

    /* ── 滚动条 ── */

    /** 返回所有通道中的最大数据长度 */
    _total() { return this.frames.rawMode ? 0 : this.frames.length; }

    /** 返回当前模式下可滚动的总范围（频域含 Nyquist，时域为数据长度） */
    _scrollTotal() {
        if (this.frames.rawMode) return 0;
        if (this.displayMode !== 'time' && this._cachedScrollTotal > 0) return this._cachedScrollTotal;
        return this._total();
    }

    /** 约束当前模式的 scrollOffset 在合法范围内，到达末尾时自动切换为跟随模式 */
    _clampScroll() {
        const total = this._scrollTotal();
        this._vp.scrollOffset = Math.max(0, Math.min(this._vp.scrollOffset, total - this._vp.displayCount));
        if (this._vp.scrollOffset + this._vp.displayCount >= total) this._vp.autoFollow = true;
    }

    /** 初始化滚动条拖拽和点击跳转事件 */
    _initScrollbar() {
        if (!this.scrollbarWrap || !this.scrollbarThumb) return;
        let dragging = false, dragStartX = 0, dragStartOff = 0;

        this._listen(this.scrollbarThumb, 'mousedown', (e) => {
            if (this.displayMode === 'time') this._timeCenterOrder = null;
            dragging = true; dragStartX = e.clientX; dragStartOff = this._vp.scrollOffset;
            e.preventDefault();
        });
        this._listen(this.document, 'mousemove', (e) => {
            if (!dragging) return;
            const previousViewport = this._viewportState();
            this._markViewDirty();
            const wrapW  = this.scrollbarWrap.clientWidth;
            const thumbW = this.scrollbarThumb.offsetWidth;
            const dx     = (e.clientX - dragStartX) / this._displayScale();
            const range  = Math.max(1, this._scrollTotal() - this._vp.displayCount);
            this._vp.scrollOffset = Math.round(dragStartOff + (dx / (wrapW - thumbW)) * range);
            this._vp.autoFollow = false;
            this._clampScroll(); this._updateScrollbar();
            if (this.isPaused) this.draw();
            this._notifyViewportChange(previousViewport);
        });
        this._listen(this.document, 'mouseup', () => { dragging = false; });

        this._listen(this.scrollbarWrap, 'click', (e) => {
            if (e.target === this.scrollbarThumb) return;
            const previousViewport = this._viewportState();
            if (this.displayMode === 'time') this._timeCenterOrder = null;
            this._markViewDirty();
            const rect  = this.scrollbarWrap.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            const total = this._scrollTotal();
            this._vp.scrollOffset = Math.round(ratio * Math.max(1, total - this._vp.displayCount));
            this._vp.autoFollow = false;
            this._clampScroll(); this._updateScrollbar();
            if (this.isPaused) this.draw();
            this._notifyViewportChange(previousViewport);
        });
    }

    _initYScrollbar() {
        if (!this.yScrollbarWrap || !this.yScrollbarThumb) return;
        this.yScrollbarWrap.hidden = true;
        let dragging = false, dragStartY = 0, dragStartTop = 0;
        this._listen(this.yScrollbarThumb, 'mousedown', e => {
            dragging = true;
            dragStartY = e.clientY;
            dragStartTop = parseFloat(this.yScrollbarThumb.style.top) || 0;
            e.preventDefault();
        });
        this._listen(this.document, 'mousemove', e => {
            if (!dragging) return;
            const height = parseFloat(this.yScrollbarWrap.style.height) || 1;
            const thumbHeight = parseFloat(this.yScrollbarThumb.style.height) || height;
            this._panYToFraction((dragStartTop + (e.clientY - dragStartY) / this._displayScale()) /
                Math.max(1, height - thumbHeight));
        });
        this._listen(this.document, 'mouseup', () => { dragging = false; });
        this._listen(this.yScrollbarWrap, 'click', e => {
            if (e.target === this.yScrollbarThumb) return;
            const rect = this.yScrollbarWrap.getBoundingClientRect();
            const height = parseFloat(this.yScrollbarWrap.style.height) || 1;
            const thumbHeight = parseFloat(this.yScrollbarThumb.style.height) || height;
            this._panYToFraction(((e.clientY - rect.top) / this._displayScale() - thumbHeight / 2) /
                Math.max(1, height - thumbHeight));
        });
    }

    _panYToFraction(fraction) {
        const previousViewport = this._viewportState();
        const base = this._zoomBaseY[this.displayMode];
        const zoom = this._boxZoomY[this.displayMode];
        if (!base || !zoom) return;
        const scale = base.yScale ?? this._drawState?.yScale ?? 'linear';
        const toDomain = value => globalThis.SerialPlotter.axisToDomain(value, scale);
        const fromDomain = value => globalThis.SerialPlotter.axisFromDomain(value, scale);
        const baseMin = toDomain(base.min), baseMax = toDomain(base.max);
        const span = toDomain(zoom.max) - toDomain(zoom.min);
        const travel = baseMax - baseMin - span;
        if (!(travel > 0)) return;
        const nextMin = Math.max(baseMin,
            baseMax - Math.max(0, Math.min(1, fraction)) * travel - span);
        this._boxZoomY[this.displayMode] = {
            min: fromDomain(nextMin), max: fromDomain(nextMin + span)
        };
        this._markViewDirty();
        this._updateYScrollbar();
        if (this.isPaused) this.draw();
        this._notifyViewportChange(previousViewport);
    }

    /** 根据当前模式的视口位置和可滚动范围更新滚动条 thumb 的宽度和位置 */
    _updateScrollbar() {
        if (!this.scrollbarWrap || !this.scrollbarThumb) return;
        const total = this._scrollTotal();
        if (total === 0 || this._vp.displayCount >= total) {
            this.scrollbarThumb.style.left = '0'; this.scrollbarThumb.style.width = '100%'; return;
        }
        const wrapW  = this.scrollbarWrap.clientWidth;
        const thumbW = Math.max(24, Math.round(wrapW * this._vp.displayCount / total));
        const left   = Math.round((this._vp.scrollOffset / Math.max(1, total - this._vp.displayCount)) * (wrapW - thumbW));
        this.scrollbarThumb.style.width = thumbW + 'px';
        this.scrollbarThumb.style.left  = left  + 'px';
    }

    _updateYScrollbar() {
        if (!this.yScrollbarWrap || !this.yScrollbarThumb) return;
        const base = this._zoomBaseY[this.displayMode];
        const zoom = this._boxZoomY[this.displayMode];
        const state = this._drawState;
        if (!base || !zoom || !state) { this.yScrollbarWrap.hidden = true; return; }
        const scale = base.yScale ?? state.yScale;
        const toDomain = value => globalThis.SerialPlotter.axisToDomain(value, scale);
        const baseMin = toDomain(base.min), baseMax = toDomain(base.max);
        const zoomMin = toDomain(zoom.min), zoomMax = toDomain(zoom.max);
        const baseSpan = baseMax - baseMin, zoomSpan = zoomMax - zoomMin;
        if (!(baseSpan > 0) || !(zoomSpan > 0) || zoomSpan >= baseSpan * (1 - 1e-12)) {
            this.yScrollbarWrap.hidden = true;
            return;
        }
        const canvasRect = this.canvas.getBoundingClientRect();
        const parentRect = this.canvas.parentElement.getBoundingClientRect();
        const height = state.plotH * canvasRect.height / this.height / this._displayScale();
        const thumbHeight = Math.min(height, Math.max(20, height * zoomSpan / baseSpan));
        const topFraction = Math.max(0, Math.min(1,
            (baseMax - zoomMax) / (baseSpan - zoomSpan)));
        this.yScrollbarWrap.style.top = `${(canvasRect.top - parentRect.top) / this._displayScale()}px`;
        this.yScrollbarWrap.style.height = `${height}px`;
        this.yScrollbarThumb.style.height = `${thumbHeight}px`;
        this.yScrollbarThumb.style.top = `${topFraction * (height - thumbHeight)}px`;
        this.yScrollbarWrap.hidden = false;
    }

    /* ── 渲染 ── */

    /** Process dirty visible work, with a 30 FPS ceiling and no idle animation loop. */
    renderLoop() {
        if (this._disposed || !this.isVisible || !this._inViewport) return;
        const now = performance.now();
        if (this._scrollbarDirty && this.displayMode === 'time') {
            this._updateScrollbar();
            this._scrollbarDirty = false;
        }
        const spectrumDue = this._fftVersion < 0 ||
            (this._fftVersion !== this.frames.version && now - this._fftAt >= FFT_REFRESH_INTERVAL_MS);
        if ((!this.isPaused || this._viewDirty) && this._dirty && now - this._lastDraw >= 1000 / 30 &&
            (this.displayMode === 'time' || this._viewDirty || spectrumDue)) {
            this.draw();
        }
        this._scheduleRender();
    }

    /** Count only completed Canvas redraws, including explicit redraws while paused. */
    draw() {
        if (this._disposed || !this.isVisible || !this._inViewport) return;
        const spectrumRevision = this._fftRevision;
        this._renderFrame();
        this._updateYScrollbar();
        this.completedDraws++;
        if (this.displayMode !== 'time' && this._fftRevision !== spectrumRevision)
            this.completedSpectrumDraws++;
        this._lastDraw = performance.now();
        this._sourceFirstOrder = this.frames.orderAt(0);
        this._timeWindowStartOrder = this.frames.orderAt(Math.floor(this.vp.time.scrollOffset));
        this._dirty = this.displayMode !== 'time' && this.frames.length > 0 &&
            !this.frames.rawMode && this._fftVersion !== this.frames.version;
        this._viewDirty = false;
        if (this._dirty) this._scheduleRender();
        else this._cancelRender();
    }

    /** 主绘制方法：背景 → 网格 → 坐标轴 → 波形 → 十字光标 */
    _renderFrame() {
        if (this.onStatusUpdate) this.onStatusUpdate(this.frames.responseMode && this.displayMode !== 'time' ? this.channels
            .flatMap((channel, index) => {
                const error = channel.visible ? this.frames.frequencyForChannel(index).error : '';
                return error ? [`${globalThis.SerialPlotter.formatChannelId(index)}: ${error}`] : [];
            }).join('；') : '');
        this._drawState = null;
        this._updateScrollbar();
        const W = this.width, H = this.height;
        this.ctx.setTransform(this.canvas.width / W, 0, 0, this.canvas.height / H, 0, 0);
        const plotW = W - this.pX, plotH = H - this.pY;

        // —— 背景与网格 ——
        this.ctx.fillStyle = '#111111';
        this.ctx.fillRect(0, 0, W, H);

        // Grid
        this.ctx.lineWidth = 1;
        this.ctx.strokeStyle = '#1e1e1e';
        this.ctx.beginPath();
        for (let x = 0; x <= plotW; x += 20) { this.ctx.moveTo(x,0); this.ctx.lineTo(x,plotH); }
        for (let y = 0; y <= plotH; y += 20) { this.ctx.moveTo(0,y); this.ctx.lineTo(plotW,y); }
        this.ctx.stroke();
        this.ctx.strokeStyle = '#2e2e2e';
        this.ctx.beginPath();
        for (let x = 0; x <= plotW; x += 100) { this.ctx.moveTo(x,0); this.ctx.lineTo(x,plotH); }
        for (let y = 0; y <= plotH; y += 100) { this.ctx.moveTo(0,y); this.ctx.lineTo(plotW,y); }
        this.ctx.stroke();

        const total = this._total();
        if (total < 1) { this._emitStats(''); return; }

        // 频域模式：预先计算全量 FFT，包含 Nyquist 频点
        let fftResults = null;
        let scrollTotal = total;
        if (this.displayMode !== 'time') {
            fftResults = this._computeFftForVisibleChannels();
            const maxFftBins = Array.from(fftResults.values())
                .reduce((m, r) => Math.max(m, r.mags.length), 0);
            if (maxFftBins > 1) scrollTotal = maxFftBins;
            this._cachedScrollTotal = scrollTotal;
            this._updateScrollbar();
        }

        let startIdx    = Math.max(0, Math.floor(this._vp.scrollOffset));
        if (this.displayMode !== 'time' && this.freqXScale === 'log')
            startIdx = Math.max(1, startIdx);
        const dispCnt   = Math.max(2, Math.floor(this._vp.displayCount));
        let actualEnd   = Math.min(startIdx + dispCnt, scrollTotal);
        let visibleCnt  = actualEnd - startIdx;
        if (this.displayMode === 'time') {
            const range = this._timeViewportRange();
            startIdx = range.start;
            actualEnd = range.end;
            visibleCnt = actualEnd - startIdx;
        }
        if (visibleCnt <= 0) {
            this._vp.scrollOffset = Math.max(0, scrollTotal - dispCnt);
            startIdx   = Math.max(0, Math.floor(this._vp.scrollOffset));
            if (this.displayMode !== 'time' && this.freqXScale === 'log')
                startIdx = Math.max(1, startIdx);
            actualEnd  = Math.min(startIdx + dispCnt, scrollTotal);
            visibleCnt = actualEnd - startIdx;
        }
        const dataStart = Math.max(0, startIdx);
        const dataEnd = Math.min(scrollTotal, actualEnd);
        const series = this._collectWindowSeries(dataStart, dataEnd, fftResults);
        if (series.length === 0) {
            this._emitStats('');
            this._drawNavigationMarkers(plotW, plotH, startIdx, visibleCnt);
            return;
        }

        const summaryText = this._buildSummary(series, this.displayMode);
        this._emitStats(summaryText);

        let min, max, bounded;
        const logY = this._logY;
        const zoomY = this._boxZoomY[this.displayMode];
        if (zoomY) {
            min = zoomY.min;
            max = zoomY.max;
        } else if (this.yScaleMode === 'manual' && Number.isFinite(this._yBounds.min) &&
            Number.isFinite(this._yBounds.max) && this._yBounds.max !== this._yBounds.min &&
            (!logY || (this._yBounds.min >= 0 && this._yBounds.max > this._yBounds.min))) {
            min = Math.min(this._yBounds.min, this._yBounds.max);
            max = Math.max(this._yBounds.min, this._yBounds.max);
        } else if (logY) {
            let minPositive = Infinity, maxPositive = 0;
            for (const item of series) for (const value of item.mags) {
                if (value > 0 && Number.isFinite(value)) {
                    minPositive = Math.min(minPositive, value);
                    maxPositive = Math.max(maxPositive, value);
                }
            }
            min = maxPositive > 0 ? Math.max(maxPositive / 1e6, minPositive / 1.3) : 1e-6;
            max = maxPositive > 0 ? Math.max(maxPositive * 1.1, min * 1.1) : 1;
        } else {
            min = Infinity;
            max = -Infinity;
            for (const item of series) for (const value of item.mags) {
                if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
            }
            if (this.displayMode === 'phase' && !this.phaseUnwrap) {
                max = this.phaseUnit === 'radians' ? Math.PI : 180;
                min = -max;
            } else if (this.displayMode === 'frequency' && this.magnitudeUnit !== 'db') {
                min = 0;
                max = Number.isFinite(max) && max > 0 ? max * 1.08 : 1;
            } else {
                if (!Number.isFinite(min) || !Number.isFinite(max)) { min = -1; max = 1; }
                if (max === min) { max += 1; min -= 1; }
                const pad = (max - min) * 0.08;
                min -= pad; max += pad;
            }
        }
        bounded = max - min;
        const xScale = this.displayMode !== 'time' ? this.freqXScale : 'linear';
        let yScale = logY ? 'log' : 'linear';
        if (zoomY && this._zoomBaseY[this.displayMode]?.yScale) {
            yScale = this._zoomBaseY[this.displayMode].yScale;
        } else if (logY && min === 0) {
            let peak = 0;
            for (const item of series) for (const value of item.mags)
                if (Number.isFinite(value) && value > peak) peak = value;
            yScale = globalThis.SerialPlotter.adaptiveLogScale(peak, max);
        }
        this._drawState = { plotW, plotH, startIdx, visibleCnt, min, max, xScale, yScale };

        // —— Y 轴标签（刻度线向绘图区内绘制，避免与负号混淆）——
        this.ctx.fillStyle = '#aaaaaa'; this.ctx.font = `10px ${this.fontFamily}`;
        this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
        for (let i = 0; i <= 8; i++) {
            const py = plotH - (i/8) * plotH;
            const v = globalThis.SerialPlotter.axisValueAtFraction(i / 8, min, max, yScale);
            const label = logY ? Number(v.toPrecision(3)).toString() : v.toFixed(6);
            this.ctx.fillText(label + this._phaseSuffix(), plotW + 6, py);
            // Tick: draw leftward into the plot area, not rightward into the label area
            this.ctx.beginPath(); this.ctx.moveTo(plotW, py); this.ctx.lineTo(plotW - 4, py);
            this.ctx.strokeStyle = '#888'; this.ctx.lineWidth = 1; this.ctx.stroke();
        }

        // —— X 轴标签 ——
        this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'top';
        const tickSpacing = this.frames.responseMode && this.freqXUnit === 'hz' && !this.responseSampleRate ? 220 : 110;
        const xTicks = this.displayMode !== 'time'
            ? Math.max(1, Math.min(5, Math.floor(plotW / tickSpacing))) : Math.min(10, Math.max(1, visibleCnt - 1));
        for (let i = 0; i <= xTicks; i++) {
            const px  = (i/xTicks) * plotW;
            const idx = xScale === 'log' && visibleCnt > 1
                ? Math.round(globalThis.SerialPlotter.axisValueAtFraction(
                    i / xTicks, startIdx, actualEnd - 1, 'log'))
                : startIdx + Math.round((i/xTicks) * Math.max(0, visibleCnt - 1));
            this.ctx.fillStyle = '#aaaaaa';
            if (this.displayMode !== 'time')
                this.ctx.textAlign = i === 0 ? 'left' : i === xTicks ? 'right' : 'center';
            const label = this.displayMode !== 'time'
                ? this._formatFrequencyBin(idx, series[0].fftSize)
                : this.frames.responseMode ? `[${Math.max(0, idx - startIdx)}]`
                    : idx >= 0 && idx < total ? this._formatTimeIndex(idx) : '';
            this.ctx.fillText(label, px, plotH + 3);
        }

        // —— 波形绘制（频域曲线 / 时域折线+散点）——
        if (this.displayMode !== 'time') {
            const xPositions = new Float64Array(visibleCnt);
            for (let i = 0; i < visibleCnt; i++) {
                const ratio = visibleCnt > 1
                    ? globalThis.SerialPlotter.axisFraction(startIdx + i, startIdx, actualEnd - 1, xScale) : 0;
                xPositions[i] = ratio * plotW;
            }
            for (const item of series) {
                const mags = item.mags;
                if (!mags || mags.length === 0) continue;
                this.ctx.strokeStyle = item.ch.color; this.ctx.lineWidth = 1.2;
                this.ctx.beginPath();
                const points = globalThis.SerialPlotter.bucketAxisExtrema(mags, xPositions);
                for (let i = 0; i < points.length; i++) {
                    const x = xPositions[points[i].index];
                    const yRatio = globalThis.SerialPlotter.axisFraction(
                        logY ? Math.max(points[i].value, min) : points[i].value, min, max, yScale);
                    const y = plotH - yRatio * plotH;
                    if (i === 0 || points[i].break) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
                }
                this.ctx.stroke();
                if (points.length === 1) {
                    const x = xPositions[points[0].index];
                    const ratio = globalThis.SerialPlotter.axisFraction(
                        logY ? Math.max(points[0].value, min) : points[0].value,
                        min, max, yScale);
                    this.ctx.fillStyle = item.ch.color;
                    this.ctx.fillRect(x - 1.5, plotH - ratio * plotH - 1.5, 3, 3);
                }
            }
        } else {
            const stepX = plotW / Math.max(1, visibleCnt - 1);
            for (const item of series) {
                const vals = item.rawValues;
                if (!vals || vals.length === 0) continue;
                this.ctx.strokeStyle = item.ch.color; this.ctx.lineWidth = 1.2;
                this.ctx.beginPath();
                const points = globalThis.SerialPlotter.bucketTraceExtrema(vals, plotW);
                for (let i = 0; i < points.length; i++) {
                    const x = (points[i].index + dataStart - startIdx) * stepX;
                    const y = plotH - ((points[i].value - min) / bounded) * plotH;
                    if (i === 0 || points[i].break) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
                }
                this.ctx.stroke();
                if (vals.length <= plotW) {
                    this.ctx.fillStyle = item.ch.color;
                    for (let i = 0; i < vals.length; i++) {
                        if (!Number.isFinite(vals[i])) continue;
                        const x = (i + dataStart - startIdx) * stepX;
                        const y = plotH - ((vals[i] - min) / bounded) * plotH;
                        this.ctx.fillRect(x-1.5, y-1.5, 3, 3);
                    }
                }
            }
        }

        // —— 十字光标 ——
        this._drawNavigationMarkers(plotW, plotH, startIdx, visibleCnt);
        if (this._selection) {
            this._drawSelection(plotW, plotH);
        } else if (this.mousePos) {
            this._drawCrosshair(plotW, plotH, min, max, startIdx, visibleCnt, total, series);
        }
    }

    _drawNavigationMarkers(plotW, plotH, startIdx, visibleCnt) {
        if (this.frames.responseMode) return;
        if (this.displayMode !== 'time' || visibleCnt < 2 || !this.frames.length) return;
        const first = Math.max(0, Math.ceil(startIdx));
        const last = Math.min(this.frames.length - 1, Math.floor(startIdx + visibleCnt - 1));
        if (first > last) return;
        const { timeOrder, matches, currentMatch } = this.navigationMarkers;
        const firstOrder = this.frames.orderAt(first);
        const lastOrder = this.frames.orderAt(last);
        const pixelAtOrder = order => {
            if (order == null || order < firstOrder || order > lastOrder) return null;
            const index = this.frames.indexAtOrAfterOrder(order);
            if (this.frames.orderAt(index) !== order) return null;
            return Math.max(0.5, Math.min(plotW - 0.5,
                Math.round((index - startIdx) * plotW / (visibleCnt - 1)) + 0.5));
        };
        const ctx = this.ctx;
        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = this.navigationColors?.match ?? '#745a00';
        ctx.beginPath();
        let low = 0, high = matches.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (matches[mid].startOrder < firstOrder) low = mid + 1;
            else high = mid;
        }
        let painted = 0;
        for (let i = low; i < matches.length && matches[i].startOrder <= lastOrder;) {
            const x = pixelAtOrder(matches[i].startOrder);
            if (x === null) { i++; continue; }
            if (i !== currentMatch) {
                ctx.moveTo(x, 0);
                ctx.lineTo(x, plotH);
                painted++;
            }
            // Search results can be much denser than pixels; skip the whole pixel bucket.
            let next = i + 1, end = matches.length;
            while (next < end) {
                const mid = Math.floor((next + end) / 2);
                const order = matches[mid].startOrder;
                if (order <= lastOrder && pixelAtOrder(order) <= x) next = mid + 1;
                else end = mid;
            }
            i = next;
        }
        if (painted) ctx.stroke();
        const drawSingle = (order, color) => {
            const x = pixelAtOrder(order);
            if (x === null) return;
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, plotH);
            ctx.stroke();
        };
        drawSingle(timeOrder, '#5c90be');
        if (currentMatch >= 0 && currentMatch < matches.length)
            drawSingle(matches[currentMatch].startOrder, this.navigationColors?.current ?? '#ff8c00');
        ctx.restore();
    }

    _drawSelection(plotW, plotH) {
        const { x0, y0, x1, y1 } = this._selection;
        const left = Math.max(0, Math.min(plotW, Math.min(x0, x1)));
        const top = Math.max(0, Math.min(plotH, Math.min(y0, y1)));
        const width = Math.max(0, Math.min(plotW, Math.max(x0, x1)) - left);
        const height = Math.max(0, Math.min(plotH, Math.max(y0, y1)) - top);
        this.ctx.save();
        this.ctx.fillStyle = 'rgba(77, 163, 255, 0.18)';
        this.ctx.strokeStyle = '#8ac4ff';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([5, 3]);
        this.ctx.fillRect(left, top, width, height);
        this.ctx.strokeRect(left, top, width, height);
        this.ctx.restore();
    }

    _phaseSuffix() {
        return this.displayMode === 'phase' ? (this.phaseUnit === 'radians' ? ' rad' : '°') : '';
    }

    _drawCrosshair(plotW, plotH, min, max, startIdx, visibleCnt, total, series) {
        const mx = this.mousePos.x, my = this.mousePos.y;
        if (mx < 0 || mx > plotW || my < 0 || my > plotH) return;
        const ctx = this.ctx;

        // Crosshair lines
        ctx.save();
        ctx.setLineDash([4,4]);
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth   = 1;
        ctx.beginPath(); ctx.moveTo(mx, 0);     ctx.lineTo(mx, plotH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0,  my);    ctx.lineTo(plotW, my); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Data coordinates
        const xScale = this.displayMode !== 'time' ? this.freqXScale : 'linear';
        const yScale = this._drawState.yScale;
        const logY = this._logY;
        const fIdx = visibleCnt > 1
            ? globalThis.SerialPlotter.axisValueAtFraction(mx / Math.max(1, plotW),
                startIdx, startIdx + visibleCnt - 1, xScale) - startIdx : 0;
        const xIdx = Math.max(0, Math.min(visibleCnt - 1, Math.round(fIdx)));
        const yVal = globalThis.SerialPlotter.axisValueAtFraction(1 - my / plotH, min, max, yScale);

        // Hover always pairs physical units with the discrete position, independently of axis units.
        const sampleIndex = startIdx + xIdx;
        const validSample = sampleIndex >= 0 && sampleIndex < total;
        const tipLines = this.displayMode !== 'time'
            ? [`Freq: ${this._formatFrequencyBin(sampleIndex, series[0].fftSize, 'hz')} (Bin ${sampleIndex})`,
                `${this.displayMode === 'phase' ? 'Phase' : 'Mag'}: ${logY ? Number(yVal.toPrecision(4)) : yVal.toFixed(6)}${this.displayMode === 'phase' ? this._phaseSuffix() : this.magnitudeUnit === 'db' ? ' dB' : ''}`]
            : [this.frames.responseMode ? `Sample: [${Math.max(0, xIdx)}]`
                : `Time: ${validSample ? this._formatTimeIndex(sampleIndex, 's') : '-- s'} (Sample ${validSample ? sampleIndex : '--'})`,
                `Value: ${yVal.toFixed(6)}`];
        ctx.font = `12px ${this.fontFamily}`;
        const lineH = 16, tipPad = 6;
        const tw = Math.max(120, ...tipLines.map(l => ctx.measureText(l).width + tipPad*2));
        const th = tipLines.length * lineH + tipPad;
        let tx = mx + 16, ty = my - th - 10;
        if (tx + tw > plotW) tx = mx - tw - 10;
        if (ty < 2)          ty = my + 10;
        if (ty + th > plotH) ty = plotH - th - 2;
        ctx.fillStyle = 'rgba(20,20,20,0.88)';
        ctx.fillRect(tx, ty, tw, th);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 0.8;
        ctx.strokeRect(tx, ty, tw, th);
        ctx.fillStyle = '#e0e0e0'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        tipLines.forEach((line, i) => ctx.fillText(line, tx + tipPad, ty + tipPad/2 + i * lineH));

        // Per-channel intersections
        const labels = [];
        // 构建 channelIndex → series item 的查找表
        const seriesMap = new Map(series.map(s => [s.channelIndex, s]));
        for (const ch of this.channels) {
            if (!ch.visible || this.frames.length === 0) continue;
            const idx = this.channels.indexOf(ch);
            let val = 0;
            if (this.displayMode !== 'time') {
                const s = seriesMap.get(idx);
                val = (s && s.mags.length > 0) ? s.mags[Math.min(s.mags.length - 1, xIdx)] : 0;
            } else {
                const iLow  = startIdx + Math.floor(fIdx);
                const iHigh = startIdx + Math.ceil(fIdx);
                const t     = fIdx - Math.floor(fIdx);
                const staticValues = this.frames.responseMode ? seriesMap.get(idx)?.rawValues : null;
                const vLow = staticValues ? staticValues[Math.floor(fIdx)] : globalThis.SerialPlotter.transformChannelValue(
                    this.frames.getValue(idx, iLow), ch);
                const vHigh = staticValues ? staticValues[Math.ceil(fIdx)] : globalThis.SerialPlotter.transformChannelValue(
                    this.frames.getValue(idx, iHigh), ch);
                val = vLow + t * (vHigh - vLow);
            }
            if (!Number.isFinite(val)) continue;
            const ratio = globalThis.SerialPlotter.axisFraction(
                logY ? Math.max(val, min) : val, min, max, yScale);
            const origY = plotH - ratio * plotH;
            labels.push({ ch, val, origY, labelY: origY });
        }

        // Sort by Y ascending, then push down overlapping labels (min 18px spacing)
        labels.sort((a, b) => a.labelY - b.labelY);
        const LBL_H = 18;
        for (let i = 1; i < labels.length; i++) {
            if (labels[i].labelY - labels[i-1].labelY < LBL_H)
                labels[i].labelY = labels[i-1].labelY + LBL_H;
        }
        // Clamp labels so they never fall below the plot bottom
        for (let i = labels.length - 1; i >= 0; i--) {
            const maxY = plotH - LBL_H * (labels.length - 1 - i) - 2;
            if (labels[i].labelY > maxY) labels[i].labelY = maxY;
        }
        // Also clamp top
        for (let i = 0; i < labels.length; i++) {
            const minY = LBL_H * i;
            if (labels[i].labelY < minY) labels[i].labelY = minY;
        }

        // Determine label column: right of crosshair, or left if near right edge
        ctx.font = `11px ${this.fontFamily}`;
        const sampleLbl = labels.length > 0 ? `${labels[0].ch.name}: ${labels[0].val.toFixed(6)}` : '';
        const LW = ctx.measureText(sampleLbl).width + 16;
        const labelX = (mx + 8 + LW < plotW) ? mx + 8 : mx - LW - 8;

        for (const item of labels) {
            // Dot on waveform at cursor X (at true origY, not the spaced labelY)
            ctx.fillStyle = item.ch.color;
            ctx.beginPath(); ctx.arc(mx, item.origY, 4, 0, Math.PI*2); ctx.fill();
            ctx.strokeStyle = '#111'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(mx, item.origY, 4, 0, Math.PI*2); ctx.stroke();

            // Value label box
            const lbl = `${item.ch.name}: ${logY
                ? Number(item.val.toPrecision(4)) : item.val.toFixed(6)}${this._phaseSuffix()}`;
            ctx.font   = `11px ${this.fontFamily}`;
            const lw   = ctx.measureText(lbl).width + 10;
            const lh   = 16;
            const lx   = labelX;
            const ly   = item.labelY - lh / 2;
            ctx.fillStyle = 'rgba(15,15,15,0.85)';
            ctx.fillRect(lx, ly, lw, lh);
            ctx.strokeStyle = item.ch.color; ctx.lineWidth = 1;
            ctx.strokeRect(lx, ly, lw, lh);
            ctx.fillStyle = item.ch.color;
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText(lbl, lx + 5, ly + lh / 2);
        }
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.Plotter = Plotter;

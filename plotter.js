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

class Plotter {
    /** 初始化画布、通道数组、视口状态、事件监听与滚动条 */
    constructor(canvasId, frames) {
        this.canvas = document.getElementById(canvasId);
        this.ctx    = this.canvas.getContext('2d');
        // 画布文本与 DOM 共用同一字体策略：英文/数字等宽，中文回退黑体
        this.fontFamily = typeof getComputedStyle === 'function'
            ? getComputedStyle(this.canvas).fontFamily : 'Consolas, monospace';

        this.channels = []; // display metadata; samples live in FrameBuffer
        this.frames = frames;
        this._fftCache = new Map();
        this._fftVersion = -1;
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
        this.maxPoints    = 1000;
        this.pX           = 90;  // right margin for Y axis (needs room for 6 decimal places)
        this.pY           = 22;  // bottom margin for X axis
        this.displayMode  = 'time';
        this.sampleRateHz = 0;
        this.timeXUnit = 'samples';
        this.freqXUnit = 'hz';
        this.freqXScale = 'linear';
        this.freqYScale = 'linear';
        this.yScaleMode   = 'auto';
        this.removeDcForFft = false;
        this.fftWindow = 'hann';
        this.onStatsUpdate = null;
        this._drawState = null;
        this._selection = null;
        this._boxZoomY = { time: null, frequency: null };

        // 视口状态（时域/频域独立，通过 _vp getter 访问当前模式）
        this.vp = {
            time:      { scrollOffset: 0, displayCount: 1000, autoFollow: true },
            frequency: { scrollOffset: 0, displayCount: 1000, autoFollow: true }
        };

        // Y 轴范围（时域/频域独立，通过 _yBounds getter 访问当前模式）
        this.yBounds = {
            time:      { min: -1, max: 1 },
            frequency: { min: -1, max: 1 }
        };

        // 频域模式下 FFT bins 总数（由 draw() 更新，供 _clampScroll 使用）
        this._cachedScrollTotal = 0;

        // Crosshair
        this.mousePos = null; // {x, y} in canvas pixel coords

        // Scrollbar DOM
        this.scrollbarWrap  = document.getElementById('plot-scrollbar-wrap');
        this.scrollbarThumb = document.getElementById('plot-scrollbar-thumb');
        this.plotHeader     = document.getElementById('plot-header');
        this.plotInfoRow    = document.getElementById('plot-info-row');
        this._initScrollbar();

        // Canvas events
        this.canvas.addEventListener('wheel',       (e) => this._onWheel(e), { passive: false });
        this.canvas.addEventListener('pointerdown', e => this._onPointerDown(e));
        this.canvas.addEventListener('pointermove', e => this._onPointerMove(e));
        this.canvas.addEventListener('pointerup', e => this._onPointerUp(e));
        this.canvas.addEventListener('pointercancel', e => this._onPointerCancel(e));
        this.canvas.addEventListener('lostpointercapture', e => this._onPointerCancel(e));
        this.canvas.addEventListener('pointerleave', () => this._onMouseLeave());
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._selection = null;
            this._markViewDirty();
            this._vp.displayCount = this.maxPoints;
            this._vp.autoFollow   = true;
            this._clampScroll();
            this._boxZoomY[this.displayMode] = null;
            if (this.isPaused) this.draw();
        });

        this.resize();
        window.addEventListener('resize', () => this.resize());
        this.renderLoop();
    }

    /** 返回当前显示模式对应的视口状态对象 */
    get _vp() { return this.vp[this.displayMode]; }

    /** 返回当前显示模式对应的 Y 轴范围对象 */
    get _yBounds() { return this.yBounds[this.displayMode]; }

    _markViewDirty() {
        this._dirty = true;
        this._viewDirty = true;
    }

    /* ── Resize ── */
    /** 根据父容器尺寸重置画布宽高，并刷新滚动条 */
    resize() {
        if (this._selection)
            this.vp[this._selection.mode].autoFollow = this._selection.autoFollow;
        this._selection = null;
        this._markViewDirty();
        const rect = this.canvas.parentElement.getBoundingClientRect();
        const sbH  = this.scrollbarWrap ? this.scrollbarWrap.offsetHeight : 12;
        const headH = this.plotHeader ? this.plotHeader.offsetHeight : 0;
        this.canvas.width  = Math.max(100, Math.floor(rect.width));
        this.canvas.height = Math.max(60,  Math.floor(rect.height - sbH - headH));
        this._updateScrollbar();
        if (this.isPaused) this.draw();
    }

    /* ── 通道管理 ── */
    /** 调整通道数量，不足时按默认色板补全，超出时裁剪 */
    setChannelCount(count) {
        this.frames.setChannelCount(count);
        this._cachedScrollTotal = 0;
        while (this.channels.length < count) {
            const idx = this.channels.length;
            this.channels.push({
                color:   this.defaultColors[idx % this.defaultColors.length],
                visible: false,
                name:    `CH${idx + 1}`,
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
    setChannelName(index, name)       { if (this.channels[index]) { this.channels[index].name = name; this._markViewDirty(); } }
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
            channel.name = setting.name || `CH${index + 1}`;
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
        const oldScale = this.yScaleMode;
        const oldFreqYScale = this.freqYScale;
        const oldBounds = {
            time: { ...this.yBounds.time },
            frequency: { ...this.yBounds.frequency }
        };
        if (opts.displayMode || opts.viewMode) this.displayMode = opts.displayMode || opts.viewMode;
        if (opts.yScaleMode) this.yScaleMode = opts.yScaleMode;
        if (opts.timeXUnit) this.timeXUnit = opts.timeXUnit;
        if (opts.freqXUnit) this.freqXUnit = opts.freqXUnit;
        if (opts.freqXScale) this.freqXScale = opts.freqXScale;
        if (opts.freqYScale) this.freqYScale = opts.freqYScale;
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
        if (oldScale !== this.yScaleMode) {
            this._boxZoomY.time = null;
            this._boxZoomY.frequency = null;
        }
        if (oldFreqYScale !== this.freqYScale) this._boxZoomY.frequency = null;
        for (const mode of ['time', 'frequency']) {
            if (oldBounds[mode].min !== this.yBounds[mode].min ||
                oldBounds[mode].max !== this.yBounds[mode].max)
                this._boxZoomY[mode] = null;
        }
        if (oldMode !== this.displayMode || oldDc !== this.removeDcForFft ||
            oldWindow !== this.fftWindow) this._fftVersion = -1;
        this._markViewDirty();
        if (this.isPaused) this.draw();
    }

    /** 追加一帧数据到各通道缓冲区，超出 maxPoints 时自动丢弃最早数据 */
    addFrame(valuesArray, frameBytes, timeStr, order) {
        if (this.isPaused) return;
        this.frames.append(valuesArray, frameBytes, timeStr, order);
        if (this._vp.autoFollow) {
            const total = this._scrollTotal();
            this._vp.scrollOffset = Math.max(0, total - this._vp.displayCount);
        }
        this._dirty = true;
    }

    /** 清空所有通道数据，重置时域/频域视口到跟随模式 */
    clear() {
        this._selection = null;
        this._boxZoomY.time = null;
        this._boxZoomY.frequency = null;
        this.frames.clear();
        this.sampleRateHz = 0;
        this._fftVersion = -1;
        this._cachedScrollTotal = 0;
        for (const mode of ['time', 'frequency']) {
            this.vp[mode].scrollOffset = 0;
            this.vp[mode].autoFollow = true;
        }
        this._updateScrollbar(); this.draw();
    }

    /** 切换暂停状态，返回当前是否暂停 */
    togglePause()          { this.isPaused = !this.isPaused; return this.isPaused; }

    /** 使用最近一次有效的接收帧率换算频谱横轴，暂停时保留该值。 */
    setSampleRateHz(rate) {
        if (!Number.isFinite(rate) || rate <= 0) return;
        if (rate !== this.sampleRateHz) {
            this.sampleRateHz = rate;
            this._markViewDirty();
        }
    }

    _formatFrequencyBin(bin, fftSize) {
        if (this.freqXUnit === 'bins') return String(Math.round(bin));
        if (!(this.sampleRateHz > 0) || !(fftSize > 0)) return '-- Hz';
        return `${this._formatAxisNumber(bin * this.sampleRateHz / fftSize)} Hz`;
    }

    _formatAxisNumber(value) {
        return Number(value > 0 && value < 0.001 ? value.toPrecision(4) : value.toFixed(3));
    }

    _formatTimeIndex(index) {
        if (this.timeXUnit !== 's') return String(index);
        if (!(this.sampleRateHz > 0)) return '-- s';
        return `${this._formatAxisNumber(index / this.sampleRateHz)} s`;
    }

    /** 设置每个通道的最大采样点数 */
    setMaxPoints(size) {
        const fullFrequencyView = this.vp.frequency.autoFollow &&
            this.vp.frequency.displayCount === this.maxPoints;
        this.frames.resize(size);
        this._cachedScrollTotal = 0;
        this.maxPoints = size;
        this.vp.time.displayCount = Math.min(this.vp.time.displayCount, size);
        this.vp.frequency.displayCount = fullFrequencyView ? size
            : Math.min(this.vp.frequency.displayCount, size);
        this._clampScroll();
        this._markViewDirty();
    }

    /* ── FFT & 统计分析 ── */

    /**
     * 汇总单通道的统计信息，多通道返回 null。
     * 基本统计（max/min/pp/mean/stdDev）基于视口窗口数据，
     * 主频/主周期始终基于全量数据（保证滚动时数值稳定）。
     */
    _buildSummary(visibleSeries, viewMode) {
        if (visibleSeries.length !== 1) {
            return null;
        }
        const series = visibleSeries[0];
        const values = viewMode === 'frequency'
            ? this._transformedChannelSlice(series.channelIndex) : series.rawValues;
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

        // 主频/主周期：始终基于全量数据（FFT 输入不随视口滚动而变化）
        const freqSeries = this._frequencyForChannel(series.channelIndex);
        const freq = freqSeries.dominantBin && freqSeries.fftSize ? freqSeries.dominantBin / freqSeries.fftSize : 0;
        const period = freqSeries.dominantBin ? (freqSeries.fftSize / freqSeries.dominantBin) : 0;
        return {
            channelLabel: series.ch.name || `CH${series.channelIndex + 1}`,
            max,
            min,
            pp,
            mean,
            stdDev,
            freq,
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

    /** 对所有可见通道的全量数据执行 FFT（结果缓存在 Map 中供 draw 复用） */
    _computeFftForVisibleChannels() {
        const now = performance.now();
        if (this._fftVersion === this.frames.version ||
            (this._fftVersion >= 0 && !this.isPaused &&
                now - this._fftAt < FFT_REFRESH_INTERVAL_MS)) return this._fftCache;
        const results = new Map();
        for (let idx = 0; idx < this.channels.length; idx++) {
            const ch = this.channels[idx];
            if (!ch.visible || this.frames.length === 0) continue;
            results.set(idx, globalThis.SerialPlotter.prepareFrequencySeries(
                this._transformedChannelSlice(idx), this.removeDcForFft, this.fftWindow));
        }
        this._fftCache = results;
        this._fftVersion = this.frames.version;
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
            if (this.displayMode === 'frequency') {
                const freq = fftResults.get(idx);
                if (!freq || freq.mags.length === 0) continue;
                // 取视口范围内的频谱 bins
                const mags = freq.mags.slice(startIdx, actualEnd);
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

    /** 鼠标滚轮缩放：以鼠标位置为锚点缩放当前模式的视口，factor 0.8/1.25 */
    _onWheel(e) {
        e.preventDefault();
        this._markViewDirty();
        const total = this._scrollTotal();
        if (total < 2) return;

        const rect   = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const plotW  = this.canvas.width - this.pX;
        const ratio  = Math.max(0, Math.min(1, mouseX / plotW));
        const factor = e.deltaY < 0 ? 0.8 : 1.25;
        const nextCount = Math.round(Math.max(2, Math.min(this.maxPoints, this._vp.displayCount * factor)));
        if (this.displayMode === 'frequency' && this.freqXScale === 'log') {
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
            const anchorIdx = this._vp.scrollOffset + ratio * this._vp.displayCount;
            this._vp.scrollOffset = Math.round(anchorIdx - ratio * nextCount);
        }
        this._vp.displayCount = nextCount;
        this._vp.autoFollow   = false;
        this._clampScroll();
        this._updateScrollbar();
        if (this.isPaused) this.draw();
    }

    _onMouseLeave() {
        this._markViewDirty();
        this.mousePos = null;
        if (this.isPaused) this.draw();
    }

    _pointFromPointer(event) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * this.canvas.width / rect.width,
            y: (event.clientY - rect.top) * this.canvas.height / rect.height
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
            this._vp.scrollOffset = zoom.scrollOffset;
            this._vp.displayCount = zoom.displayCount;
            this._clampScroll();
            this._vp.autoFollow = false;
            this._boxZoomY[this.displayMode] = { min: zoom.yMin, max: zoom.yMax };
        } else if (selection.mode === this.displayMode) {
            this._vp.autoFollow = selection.autoFollow;
        }
        this._markViewDirty();
        this.draw();
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
    _total() { return this.frames.length; }

    /** 返回当前模式下可滚动的总范围（频域含 Nyquist，时域为数据长度） */
    _scrollTotal() {
        if (this.displayMode === 'frequency' && this._cachedScrollTotal > 0) return this._cachedScrollTotal;
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

        this.scrollbarThumb.addEventListener('mousedown', (e) => {
            dragging = true; dragStartX = e.clientX; dragStartOff = this._vp.scrollOffset;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            this._markViewDirty();
            const wrapW  = this.scrollbarWrap.clientWidth;
            const thumbW = this.scrollbarThumb.offsetWidth;
            const dx     = e.clientX - dragStartX;
            const range  = Math.max(1, this._scrollTotal() - this._vp.displayCount);
            this._vp.scrollOffset = Math.round(dragStartOff + (dx / (wrapW - thumbW)) * range);
            this._vp.autoFollow = false;
            this._clampScroll(); this._updateScrollbar();
            if (this.isPaused) this.draw();
        });
        document.addEventListener('mouseup', () => { dragging = false; });

        this.scrollbarWrap.addEventListener('click', (e) => {
            if (e.target === this.scrollbarThumb) return;
            this._markViewDirty();
            const rect  = this.scrollbarWrap.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            const total = this._scrollTotal();
            this._vp.scrollOffset = Math.round(ratio * Math.max(1, total - this._vp.displayCount));
            this._vp.autoFollow = false;
            this._clampScroll(); this._updateScrollbar();
            if (this.isPaused) this.draw();
        });
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

    /* ── 渲染 ── */

    /** requestAnimationFrame 循环，非暂停状态下持续重绘 */
    renderLoop() {
        const now = performance.now();
        const spectrumDue = this._fftVersion < 0 ||
            (this._fftVersion !== this.frames.version && now - this._fftAt >= FFT_REFRESH_INTERVAL_MS);
        if (!this.isPaused && this._dirty && now - this._lastDraw >= 1000 / 30 &&
            (this.displayMode !== 'frequency' || this._viewDirty || spectrumDue)) {
            this.draw();
        }
        requestAnimationFrame(() => this.renderLoop());
    }

    /** Count only completed Canvas redraws, including explicit redraws while paused. */
    draw() {
        const spectrumRevision = this._fftRevision;
        this._renderFrame();
        this.completedDraws++;
        if (this.displayMode === 'frequency' && this._fftRevision !== spectrumRevision)
            this.completedSpectrumDraws++;
        this._lastDraw = performance.now();
        this._dirty = false;
        this._viewDirty = false;
    }

    /** 主绘制方法：背景 → 网格 → 坐标轴 → 波形 → 十字光标 */
    _renderFrame() {
        this._drawState = null;
        this._updateScrollbar();
        const W = this.canvas.width, H = this.canvas.height;
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
        if (this.displayMode === 'frequency') {
            fftResults = this._computeFftForVisibleChannels();
            const maxFftBins = Array.from(fftResults.values())
                .reduce((m, r) => Math.max(m, r.mags.length), 0);
            if (maxFftBins > 1) scrollTotal = maxFftBins;
            this._cachedScrollTotal = scrollTotal;
            this._updateScrollbar();
        }

        let startIdx    = Math.max(0, Math.floor(this._vp.scrollOffset));
        if (this.displayMode === 'frequency' && this.freqXScale === 'log')
            startIdx = Math.max(1, startIdx);
        const dispCnt   = Math.max(2, Math.floor(this._vp.displayCount));
        let actualEnd   = Math.min(startIdx + dispCnt, scrollTotal);
        let visibleCnt  = actualEnd - startIdx;
        if (visibleCnt <= 0) {
            this._vp.scrollOffset = Math.max(0, scrollTotal - dispCnt);
            startIdx   = Math.max(0, Math.floor(this._vp.scrollOffset));
            if (this.displayMode === 'frequency' && this.freqXScale === 'log')
                startIdx = Math.max(1, startIdx);
            actualEnd  = Math.min(startIdx + dispCnt, scrollTotal);
            visibleCnt = actualEnd - startIdx;
        }
        const series = this._collectWindowSeries(startIdx, actualEnd, fftResults);
        if (series.length === 0) { this._emitStats(''); return; }

        const summaryText = this._buildSummary(series, this.displayMode);
        this._emitStats(summaryText);

        let min, max, bounded;
        const logY = this.displayMode === 'frequency' && this.freqYScale === 'log';
        const zoomY = this._boxZoomY[this.displayMode];
        if (zoomY) {
            min = zoomY.min;
            max = zoomY.max;
        } else if (this.yScaleMode === 'manual' && Number.isFinite(this._yBounds.min) &&
            Number.isFinite(this._yBounds.max) && this._yBounds.max !== this._yBounds.min &&
            (!logY || (this._yBounds.min > 0 && this._yBounds.max > 0))) {
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
            if (this.displayMode === 'frequency') {
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
        const xScale = this.displayMode === 'frequency' ? this.freqXScale : 'linear';
        const yScale = logY ? 'log' : 'linear';
        this._drawState = { plotW, plotH, startIdx, visibleCnt, min, max, xScale, yScale };

        // —— Y 轴标签（刻度线向绘图区内绘制，避免与负号混淆）——
        this.ctx.fillStyle = '#aaaaaa'; this.ctx.font = `10px ${this.fontFamily}`;
        this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
        for (let i = 0; i <= 8; i++) {
            const py = plotH - (i/8) * plotH;
            const v = globalThis.SerialPlotter.axisValueAtFraction(i / 8, min, max, yScale);
            this.ctx.fillText(logY ? Number(v.toPrecision(3)).toString() : v.toFixed(6), plotW + 6, py);
            // Tick: draw leftward into the plot area, not rightward into the label area
            this.ctx.beginPath(); this.ctx.moveTo(plotW, py); this.ctx.lineTo(plotW - 4, py);
            this.ctx.strokeStyle = '#888'; this.ctx.lineWidth = 1; this.ctx.stroke();
        }

        // —— X 轴标签 ——
        this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'top';
        const xTicks = this.displayMode === 'frequency'
            ? Math.max(1, Math.min(5, Math.floor(plotW / 110))) : 10;
        for (let i = 0; i <= xTicks; i++) {
            const px  = (i/xTicks) * plotW;
            const idx = xScale === 'log' && visibleCnt > 1
                ? Math.round(globalThis.SerialPlotter.axisValueAtFraction(
                    i / xTicks, startIdx, actualEnd - 1, 'log'))
                : startIdx + Math.floor((i/xTicks) * Math.max(0, visibleCnt - 1));
            this.ctx.fillStyle = '#aaaaaa';
            if (this.displayMode === 'frequency')
                this.ctx.textAlign = i === 0 ? 'left' : i === xTicks ? 'right' : 'center';
            const label = this.displayMode === 'frequency'
                ? this._formatFrequencyBin(idx, series[0].fftSize) : this._formatTimeIndex(idx);
            this.ctx.fillText(label, px, plotH + 3);
        }

        // —— 波形绘制（频域曲线 / 时域折线+散点）——
        if (this.displayMode === 'frequency') {
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
                    if (i === 0) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
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
                const points = globalThis.SerialPlotter.bucketExtrema(vals, plotW);
                for (let i = 0; i < points.length; i++) {
                    const x = points[i].index * stepX;
                    const y = plotH - ((points[i].value - min) / bounded) * plotH;
                    if (i === 0) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
                }
                this.ctx.stroke();
                if (vals.length <= plotW) {
                    this.ctx.fillStyle = item.ch.color;
                    for (let i = 0; i < vals.length; i++) {
                        if (!Number.isFinite(vals[i])) continue;
                        const x = i * stepX;
                        const y = plotH - ((vals[i] - min) / bounded) * plotH;
                        this.ctx.fillRect(x-1.5, y-1.5, 3, 3);
                    }
                }
            }
        }

        // —— 十字光标 ——
        if (this._selection) {
            this._drawSelection(plotW, plotH);
        } else if (this.mousePos) {
            this._drawCrosshair(plotW, plotH, min, max, startIdx, visibleCnt, total, series);
        }
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
        const xScale = this.displayMode === 'frequency' ? this.freqXScale : 'linear';
        const yScale = this.displayMode === 'frequency' ? this.freqYScale : 'linear';
        const fIdx = visibleCnt > 1
            ? globalThis.SerialPlotter.axisValueAtFraction(mx / Math.max(1, plotW),
                startIdx, startIdx + visibleCnt - 1, xScale) - startIdx : 0;
        const xIdx = Math.max(0, Math.min(visibleCnt - 1, Math.round(fIdx)));
        const yVal = globalThis.SerialPlotter.axisValueAtFraction(1 - my / plotH, min, max, yScale);

        // Main tooltip (cursor position label)
        const tipLines = this.displayMode === 'frequency'
            ? [`Freq: ${this._formatFrequencyBin(startIdx + xIdx, series[0].fftSize)} (Bin ${startIdx + xIdx})`,
                `Mag: ${yScale === 'log' ? Number(yVal.toPrecision(4)) : yVal.toFixed(6)}`]
            : [`X: ${this._formatTimeIndex(Math.min(total - 1, startIdx + xIdx))}`,
                `Y: ${yVal.toFixed(6)}`];
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
            if (this.displayMode === 'frequency') {
                const s = seriesMap.get(idx);
                val = (s && s.mags.length > 0) ? s.mags[Math.min(s.mags.length - 1, xIdx)] : 0;
            } else {
                const iLow  = startIdx + Math.floor(fIdx);
                const iHigh = startIdx + Math.ceil(fIdx);
                const t     = fIdx - Math.floor(fIdx);
                const vLow = globalThis.SerialPlotter.transformChannelValue(
                    this.frames.getValue(idx, iLow), ch);
                const vHigh = globalThis.SerialPlotter.transformChannelValue(
                    this.frames.getValue(idx, iHigh), ch);
                val = vLow + t * (vHigh - vLow);
            }
            if (!Number.isFinite(val)) continue;
            const ratio = globalThis.SerialPlotter.axisFraction(
                yScale === 'log' ? Math.max(val, min) : val, min, max, yScale);
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
            const lbl = `${item.ch.name}: ${yScale === 'log'
                ? Number(item.val.toPrecision(4)) : item.val.toFixed(6)}`;
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

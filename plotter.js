/* ═══════════════════════════════════════════════════════════════
 *  plotter.js — 波形绘图引擎
 *
 *  职责：Canvas 绘制、通道管理、视口缩放/平移、FFT 频谱分析、
 *        十字光标交互、滚动条、统计信息汇总与 CSV 导出。
 *
 *  代码结构：
 *    1. 构造函数（画布初始化、事件绑定、滚动条初始化）
 *    2. Resize（画布尺寸自适应）
 *    3. 通道管理（增删、颜色、可见性、名称）
 *    4. 数据与视口（addFrame、clear、pause、maxPoints）
 *    5. FFT & 统计分析（_nextPow2、_fftInPlace、_prepareFrequencySeries、_buildSummary）
 *    6. 交互事件（滚轮缩放、十字光标、滚动条拖拽）
 *    7. 渲染（renderLoop、draw、_drawCrosshair）
 * ═══════════════════════════════════════════════════════════════ */

class Plotter {
    /** 初始化画布、通道数组、视口状态、事件监听与滚动条 */
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx    = this.canvas.getContext('2d');

        this.channels = []; // { data[], color, visible, name }
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
        this.yScaleMode   = 'auto';
        this.removeDcForFft = false;
        this.onStatsUpdate = null;

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
        this.canvas.addEventListener('mousemove',   (e) => this._onMouseMove(e));
        this.canvas.addEventListener('mouseleave',  ()  => this._onMouseLeave());
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._vp.displayCount = this.maxPoints;
            this._vp.autoFollow   = true;
            this._clampScroll();
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

    /* ── Resize ── */
    /** 根据父容器尺寸重置画布宽高，并刷新滚动条 */
    resize() {
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
        while (this.channels.length < count) {
            const idx = this.channels.length;
            this.channels.push({
                data:    [],
                color:   this.defaultColors[idx % this.defaultColors.length],
                visible: false,
                name:    `CH${idx + 1}`
            });
        }
        while (this.channels.length > count) this.channels.pop();
        this._clampScroll();
        this._updateScrollbar();
        if (this.isPaused) this.draw();
    }

    /** 返回所有通道的元数据（index, name, color, visible）供 UI 使用 */
    getChannelMeta() {
        return this.channels.map((ch, i) => ({
            index: i, name: ch.name, color: ch.color, visible: ch.visible
        }));
    }

    /** 设置指定通道的绘制颜色 */
    setChannelColor(index, color)     { if (this.channels[index]) this.channels[index].color   = color; }
    /** 设置指定通道的可见性，隐藏时跳过绘制 */
    setChannelVisible(index, visible) {
        if (this.channels[index]) {
            this.channels[index].visible = visible;
            this._clampScroll();
            this._updateScrollbar();
            this.draw();
        }
    }
    /** 设置指定通道的显示名称 */
    setChannelName(index, name)       { if (this.channels[index]) this.channels[index].name    = name; }
    /** 批量设置所有通道的可见性 */
    setAllChannelsVisible(visible) {
        this.channels.forEach(ch => { ch.visible = visible; });
        this._clampScroll();
        this._updateScrollbar();
        this.draw();
    }
    /** 应用绘图显示选项（时域/频域、Y 轴策略、去直流、Y 轴范围等） */
    setDisplayOptions(opts = {}) {
        if (opts.displayMode || opts.viewMode) this.displayMode = opts.displayMode || opts.viewMode;
        if (opts.yScaleMode) this.yScaleMode = opts.yScaleMode;
        if (opts.removeDcForFft !== undefined) this.removeDcForFft = !!opts.removeDcForFft;
        if (opts.yMinTime !== undefined && opts.yMinTime !== '') this.yBounds.time.min = parseFloat(opts.yMinTime);
        if (opts.yMaxTime !== undefined && opts.yMaxTime !== '') this.yBounds.time.max = parseFloat(opts.yMaxTime);
        if (opts.yMinFreq !== undefined && opts.yMinFreq !== '') this.yBounds.frequency.min = parseFloat(opts.yMinFreq);
        if (opts.yMaxFreq !== undefined && opts.yMaxFreq !== '') this.yBounds.frequency.max = parseFloat(opts.yMaxFreq);
        if (this.isPaused) this.draw();
    }

    /** 追加一帧数据到各通道缓冲区，超出 maxPoints 时自动丢弃最早数据 */
    addFrame(valuesArray) {
        if (this.isPaused) return;
        for (let i = 0; i < valuesArray.length; i++) {
            if (this.channels[i]) {
                this.channels[i].data.push(valuesArray[i]);
                if (this.channels[i].data.length > this.maxPoints)
                    this.channels[i].data.shift();
            }
        }
        if (this._vp.autoFollow) {
            const total = this._scrollTotal();
            this._vp.scrollOffset = Math.max(0, total - this._vp.displayCount);
        }
        this._updateScrollbar();
    }

    /** 清空所有通道数据，重置时域/频域视口到跟随模式 */
    clear() {
        for (const ch of this.channels) ch.data = [];
        for (const mode of ['time', 'frequency']) {
            this.vp[mode].scrollOffset = 0;
            this.vp[mode].autoFollow = true;
        }
        this._updateScrollbar(); this.draw();
    }

    /** 切换暂停状态，返回当前是否暂停 */
    togglePause()          { this.isPaused = !this.isPaused; return this.isPaused; }

    /** 设置每个通道的最大采样点数 */
    setMaxPoints(size) {
        this.maxPoints = size;
        for (const mode of ['time', 'frequency']) {
            this.vp[mode].displayCount = Math.min(this.vp[mode].displayCount, size);
        }
    }

    /* ── FFT & 统计分析 ── */

    /** 返回不小于 n 的最小 2 的幂（FFT 要求输入长度为 2 的幂） */
    _nextPow2(n) {
        let p = 1;
        while (p < n) p <<= 1;
        return p;
    }

    /** 原地 Cooley-Tukey FFT（蝶形运算），re/im 为实部/虚部数组，长度须为 2 的幂 */
    _fftInPlace(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len;
            const wLenRe = Math.cos(ang);
            const wLenIm = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let wRe = 1, wIm = 0;
                for (let j = 0; j < len / 2; j++) {
                    const uRe = re[i + j], uIm = im[i + j];
                    const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
                    const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
                    re[i + j] = uRe + vRe;
                    im[i + j] = uIm + vIm;
                    re[i + j + len / 2] = uRe - vRe;
                    im[i + j + len / 2] = uIm - vIm;
                    const nextWRe = wRe * wLenRe - wIm * wLenIm;
                    wIm = wRe * wLenIm + wIm * wLenRe;
                    wRe = nextWRe;
                }
            }
        }
    }

    /** Hann 窗加窗后执行 FFT，返回幅度谱 { mags, dominantBin, fftSize } */
    _prepareFrequencySeries(values) {
        if (values.length < 2) return { mags: [], dominantBin: 0, fftSize: 0 };
        const fftSize = this._nextPow2(values.length);
        const re = new Array(fftSize).fill(0);
        const im = new Array(fftSize).fill(0);
        let mean = 0;
        if (this.removeDcForFft) {
            for (let i = 0; i < values.length; i++) mean += values[i];
            mean /= values.length;
        }
        for (let i = 0; i < values.length; i++) {
            const window = values.length > 1 ? (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (values.length - 1))) : 1;
            re[i] = ((this.removeDcForFft ? (values[i] - mean) : values[i])) * window;
        }
        this._fftInPlace(re, im);
        const half = Math.max(1, fftSize >> 1);
        const mags = [];
        let dominantBin = 1;
        let dominantMag = -Infinity;
        for (let i = 0; i <= half; i++) {
            const mag = Math.hypot(re[i], im[i]) / fftSize;
            mags.push(mag);
            if (i > 0 && mag > dominantMag) {
                dominantMag = mag;
                dominantBin = i;
            }
        }
        return { mags, dominantBin, fftSize };
    }

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
        const values = series.rawValues;
        if (!values || values.length === 0) return null;

        // 基本统计：基于视口窗口数据
        const min = Math.min(...values);
        const max = Math.max(...values);
        const pp = max - min;
        let sum = 0;
        let sumSq = 0;
        for (const v of values) {
            sum += v;
            sumSq += v * v;
        }
        const mean = sum / values.length;
        const variance = Math.max(0, sumSq / values.length - mean * mean);
        const stdDev = Math.sqrt(variance);

        // 主频/主周期：始终基于全量数据（FFT 输入不随视口滚动而变化）
        const fullData = series.ch.data;
        const freqSeries = this._prepareFrequencySeries(fullData);
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

    /** 对所有可见通道的全量数据执行 FFT（结果缓存在 Map 中供 draw 复用） */
    _computeFftForVisibleChannels() {
        const results = new Map();
        for (let idx = 0; idx < this.channels.length; idx++) {
            const ch = this.channels[idx];
            if (!ch.visible || ch.data.length === 0) continue;
            results.set(idx, this._prepareFrequencySeries(ch.data));
        }
        return results;
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
            if (!ch.visible || ch.data.length === 0) continue;
            if (this.displayMode === 'frequency') {
                const freq = fftResults.get(idx);
                if (!freq || freq.mags.length === 0) continue;
                // 取视口范围内的频谱 bins
                const mags = freq.mags.slice(startIdx, actualEnd);
                if (mags.length === 0) continue;
                series.push({
                    channelIndex: idx, ch,
                    rawValues: ch.data,
                    mags,
                    dominantBin: freq.dominantBin,
                    fftSize: freq.fftSize
                });
            } else {
                const rawValues = ch.data.slice(startIdx, actualEnd);
                if (rawValues.length === 0) continue;
                series.push({ channelIndex: idx, ch, rawValues, mags: rawValues, dominantBin: 0, fftSize: rawValues.length });
            }
        }
        return series;
    }

    /** 将所有通道数据导出为 CSV 字符串（含表头），无数据时返回 null */
    exportCSV() {
        if (!this.channels.length || !this.channels[0].data.length) return null;
        let csv = ['Index', ...this.channels.map(ch => ch.name)].join(',') + '\r\n';
        const rows = this.channels[0].data.length;
        for (let r = 0; r < rows; r++) {
            const row = [r, ...this.channels.map(ch => ch.data[r] !== undefined ? ch.data[r] : '')];
            csv += row.join(',') + '\r\n';
        }
        return csv;
    }

    /* ── 交互事件 ── */

    /** 鼠标滚轮缩放：以鼠标位置为锚点缩放当前模式的视口，factor 0.8/1.25 */
    _onWheel(e) {
        e.preventDefault();
        const total = this._scrollTotal();
        if (total < 2) return;

        const rect   = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const plotW  = this.canvas.width - this.pX;
        const ratio  = Math.max(0, Math.min(1, mouseX / plotW));
        const anchorIdx = this._vp.scrollOffset + ratio * this._vp.displayCount;

        const factor = e.deltaY < 0 ? 0.8 : 1.25;
        this._vp.displayCount = Math.round(Math.max(2, Math.min(this.maxPoints, this._vp.displayCount * factor)));

        this._vp.scrollOffset = Math.round(anchorIdx - ratio * this._vp.displayCount);
        this._vp.autoFollow   = false;
        this._clampScroll();
        this._updateScrollbar();
        if (this.isPaused) this.draw();
    }

    /** 记录鼠标位置用于十字光标绘制 */
    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        this.mousePos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        if (this.isPaused) this.draw();
    }

    _onMouseLeave() {
        this.mousePos = null;
        if (this.isPaused) this.draw();
    }

    /* ── 滚动条 ── */

    /** 返回所有通道中的最大数据长度 */
    _total() { return this.channels.reduce((m, ch) => Math.max(m, ch.data.length), 0); }

    /** 返回当前模式下可滚动的总范围（频域模式为 fftSize/2，时域模式为数据长度） */
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
        if (!this.isPaused) this.draw();
        requestAnimationFrame(() => this.renderLoop());
    }

    /** 主绘制方法：背景 → 网格 → 坐标轴 → 波形 → 十字光标 */
    draw() {
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

        // 频域模式：预先计算全量 FFT，用 fftSize/2 作为可滚动范围
        let fftResults = null;
        let scrollTotal = total;
        if (this.displayMode === 'frequency') {
            fftResults = this._computeFftForVisibleChannels();
            const maxFftBins = Array.from(fftResults.values())
                .reduce((m, r) => Math.max(m, Math.floor((r.fftSize || 2) / 2)), 0);
            if (maxFftBins > 1) scrollTotal = maxFftBins;
            this._cachedScrollTotal = scrollTotal;
        }

        let startIdx    = Math.max(0, Math.floor(this._vp.scrollOffset));
        const dispCnt   = Math.max(2, Math.floor(this._vp.displayCount));
        let actualEnd   = Math.min(startIdx + dispCnt, scrollTotal);
        let visibleCnt  = actualEnd - startIdx;
        if (visibleCnt <= 0) {
            this._vp.scrollOffset = Math.max(0, scrollTotal - dispCnt);
            startIdx   = Math.max(0, Math.floor(this._vp.scrollOffset));
            actualEnd  = Math.min(startIdx + dispCnt, scrollTotal);
            visibleCnt = actualEnd - startIdx;
        }
        const series = this._collectWindowSeries(startIdx, actualEnd, fftResults);
        if (series.length === 0) { this._emitStats(''); return; }

        const summaryText = this._buildSummary(series, this.displayMode);
        this._emitStats(summaryText);

        let min, max, bounded;
        if (this.yScaleMode === 'manual' && Number.isFinite(this._yBounds.min) && Number.isFinite(this._yBounds.max) && this._yBounds.max !== this._yBounds.min) {
            min = Math.min(this._yBounds.min, this._yBounds.max);
            max = Math.max(this._yBounds.min, this._yBounds.max);
        } else {
            const allVals = [];
            for (const item of series) allVals.push(...item.mags);
            min = Math.min(...allVals);
            max = Math.max(...allVals);
            if (max === min) { max += 1; min -= 1; }
            const pad = (max - min) * 0.08;
            min -= pad; max += pad;
        }
        bounded = max - min;
        const axisMaxIndex = Math.max(1, visibleCnt);

        // —— Y 轴标签（刻度线向绘图区内绘制，避免与负号混淆）——
        this.ctx.fillStyle = '#aaaaaa'; this.ctx.font = '10px Consolas,monospace';
        this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
        for (let i = 0; i <= 8; i++) {
            const py = plotH - (i/8) * plotH;
            const v  = min + (i/8) * bounded;
            this.ctx.fillText(v.toFixed(6), plotW + 6, py);
            // Tick: draw leftward into the plot area, not rightward into the label area
            this.ctx.beginPath(); this.ctx.moveTo(plotW, py); this.ctx.lineTo(plotW - 4, py);
            this.ctx.strokeStyle = '#888'; this.ctx.lineWidth = 1; this.ctx.stroke();
        }

        // —— X 轴标签 ——
        this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'top';
        for (let i = 0; i <= 10; i++) {
            const px  = (i/10) * plotW;
            const idx = startIdx + Math.floor((i/10) * Math.max(0, visibleCnt - 1));
            this.ctx.fillStyle = '#aaaaaa';
            this.ctx.fillText(idx, px, plotH + 3);
        }

        // —— 波形绘制（频域柱状图 / 时域折线+散点）——
        if (this.displayMode === 'frequency') {
            const stepX = plotW / Math.max(1, axisMaxIndex - 1);
            for (const item of series) {
                const mags = item.mags;
                if (!mags || mags.length === 0) continue;
                this.ctx.strokeStyle = item.ch.color; this.ctx.lineWidth = 1.2;
                this.ctx.beginPath();
                for (let i = 0; i < mags.length; i++) {
                    const x = i * stepX;
                    const y = plotH - ((mags[i] - min) / bounded) * plotH;
                    if (i === 0) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
                }
                this.ctx.stroke();
            }
        } else {
            const stepX = plotW / Math.max(1, visibleCnt - 1);
            for (const item of series) {
                const vals = item.rawValues;
                if (!vals || vals.length === 0) continue;
                this.ctx.strokeStyle = item.ch.color; this.ctx.lineWidth = 1.2;
                this.ctx.beginPath();
                for (let i = 0; i < vals.length; i++) {
                    const x = i * stepX;
                    const y = plotH - ((vals[i] - min) / bounded) * plotH;
                    if (i === 0) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
                }
                this.ctx.stroke();
                this.ctx.fillStyle = item.ch.color;
                for (let i = 0; i < vals.length; i++) {
                    const x = i * stepX;
                    const y = plotH - ((vals[i] - min) / bounded) * plotH;
                    this.ctx.fillRect(x-1.5, y-1.5, 3, 3);
                }
            }
        }

        // —— 十字光标 ——
        if (this.mousePos) {
            this._drawCrosshair(plotW, plotH, min, bounded, startIdx, visibleCnt, axisMaxIndex, total, series);
        }
    }

    _drawCrosshair(plotW, plotH, min, bounded, startIdx, visibleCnt, axisMaxIndex, total, series) {
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
        const xSpan = this.displayMode === 'frequency'
            ? Math.max(1, axisMaxIndex - 1)
            : Math.max(1, visibleCnt - 1);
        const fIdx = (mx / Math.max(1, plotW)) * xSpan;
        const xIdx = Math.max(0, Math.round(fIdx));
        const yVal = min + (1 - my / plotH) * bounded;

        // Main tooltip (cursor position label)
        const tipLines = this.displayMode === 'frequency'
            ? [`Bin: ${startIdx + xIdx}`, `Mag: ${yVal.toFixed(6)}`]
            : [`X: ${Math.min(total - 1, startIdx + xIdx)}`, `Y: ${yVal.toFixed(6)}`];
        ctx.font = '12px Consolas,monospace';
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
            if (!ch.visible || ch.data.length === 0) continue;
            const idx = this.channels.indexOf(ch);
            let val = 0;
            if (this.displayMode === 'frequency') {
                const s = seriesMap.get(idx);
                val = (s && s.mags.length > 0) ? s.mags[Math.min(s.mags.length - 1, xIdx)] : 0;
            } else {
                const iLow  = startIdx + Math.floor(fIdx);
                const iHigh = startIdx + Math.ceil(fIdx);
                const t     = fIdx - Math.floor(fIdx);
                const vLow  = ch.data[iLow]  !== undefined ? ch.data[iLow]  : 0;
                const vHigh = ch.data[iHigh] !== undefined ? ch.data[iHigh] : vLow;
                val = vLow + t * (vHigh - vLow);
            }
            const origY = plotH - ((val - min) / bounded) * plotH;
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
        ctx.font = '11px Consolas,monospace';
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
            const lbl = `${item.ch.name}: ${item.val.toFixed(6)}`;
            ctx.font   = '11px Consolas,monospace';
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

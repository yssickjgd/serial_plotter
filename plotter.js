class Plotter {
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
        this.yMin         = -1;
        this.yMax         = 1;
        this.onStatsUpdate = null;

        // Viewport
        this.scrollOffset = 0;
        this.displayCount = 1000;
        this.autoFollow   = true;

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
            this.displayCount = this.maxPoints;
            this.autoFollow   = true;
            this._clampScroll();
            if (this.isPaused) this.draw();
        });

        this.resize();
        window.addEventListener('resize', () => this.resize());
        this.renderLoop();
    }

    /* ── Resize ── */
    resize() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        const sbH  = this.scrollbarWrap ? this.scrollbarWrap.offsetHeight : 12;
        const headH = this.plotHeader ? this.plotHeader.offsetHeight : 0;
        this.canvas.width  = Math.max(100, Math.floor(rect.width));
        this.canvas.height = Math.max(60,  Math.floor(rect.height - sbH - headH));
        this._updateScrollbar();
        if (this.isPaused) this.draw();
    }

    /* ── Channel Management ── */
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

    getChannelMeta() {
        return this.channels.map((ch, i) => ({
            index: i, name: ch.name, color: ch.color, visible: ch.visible
        }));
    }

    setChannelColor(index, color)     { if (this.channels[index]) this.channels[index].color   = color; }
    setChannelVisible(index, visible) {
        if (this.channels[index]) {
            this.channels[index].visible = visible;
            this._clampScroll();
            this._updateScrollbar();
            this.draw();
        }
    }
    setChannelName(index, name)       { if (this.channels[index]) this.channels[index].name    = name; }
    setAllChannelsVisible(visible) {
        this.channels.forEach(ch => { ch.visible = visible; });
        this._clampScroll();
        this._updateScrollbar();
        this.draw();
    }
    setDisplayOptions(opts = {}) {
        if (opts.displayMode || opts.viewMode) this.displayMode = opts.displayMode || opts.viewMode;
        if (opts.yScaleMode) this.yScaleMode = opts.yScaleMode;
        if (opts.removeDcForFft !== undefined) this.removeDcForFft = !!opts.removeDcForFft;
        if (opts.yMin !== undefined && opts.yMin !== '') this.yMin = parseFloat(opts.yMin);
        if (opts.yMax !== undefined && opts.yMax !== '') this.yMax = parseFloat(opts.yMax);
        if (this.isPaused) this.draw();
    }

    addFrame(valuesArray) {
        if (this.isPaused) return;
        for (let i = 0; i < valuesArray.length; i++) {
            if (this.channels[i]) {
                this.channels[i].data.push(valuesArray[i]);
                if (this.channels[i].data.length > this.maxPoints)
                    this.channels[i].data.shift();
            }
        }
        if (this.autoFollow) {
            const total = this._total();
            this.scrollOffset = Math.max(0, total - this.displayCount);
        }
        this._updateScrollbar();
    }

    clear() {
        for (const ch of this.channels) ch.data = [];
        this.scrollOffset = 0; this.autoFollow = true;
        this._updateScrollbar(); this.draw();
    }

    togglePause()          { this.isPaused = !this.isPaused; return this.isPaused; }
    setMaxPoints(size)     { this.maxPoints = size; this.displayCount = Math.min(this.displayCount, size); }

    _nextPow2(n) {
        let p = 1;
        while (p < n) p <<= 1;
        return p;
    }

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

    _buildSummary(visibleSeries, viewMode) {
        if (visibleSeries.length === 0) {
            return null;
        }
        const series = visibleSeries[0];
        const values = series.rawValues;
        if (!values || values.length === 0) return null;
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
        const freqSeries = this._prepareFrequencySeries(values);
        const freq = freqSeries.dominantBin && freqSeries.fftSize ? freqSeries.dominantBin / freqSeries.fftSize : 0;
        const period = freqSeries.dominantBin ? (freqSeries.fftSize / freqSeries.dominantBin) : 0;
        return {
            channelLabel: visibleSeries.length > 1
                ? `多通道 (${visibleSeries.length})`
                : (series.ch.name || `CH${series.channelIndex + 1}`),
            max,
            min,
            pp,
            mean,
            stdDev,
            freq,
            period: period || null
        };
    }

    _emitStats(stats) {
        if (this.onStatsUpdate) this.onStatsUpdate(stats || null);
    }

    _collectWindowSeries(startIdx, actualEnd) {
        const series = [];
        for (let idx = 0; idx < this.channels.length; idx++) {
            const ch = this.channels[idx];
            if (!ch.visible || ch.data.length === 0) continue;
            const rawValues = ch.data.slice(startIdx, actualEnd);
            if (rawValues.length === 0) continue;
            if (this.displayMode === 'frequency') {
                const freq = this._prepareFrequencySeries(rawValues);
                series.push({ channelIndex: idx, ch, rawValues, ...freq });
            } else {
                series.push({ channelIndex: idx, ch, rawValues, mags: rawValues, dominantBin: 0, fftSize: rawValues.length });
            }
        }
        return series;
    }

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

    /* ── Wheel Zoom (mouse-centered) ── */
    _onWheel(e) {
        e.preventDefault();
        const total = this._total();
        if (total < 2) return;

        const rect   = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const plotW  = this.canvas.width - this.pX;
        const ratio  = Math.max(0, Math.min(1, mouseX / plotW));
        const anchorIdx = this.scrollOffset + ratio * this.displayCount;

        const factor = e.deltaY < 0 ? 0.8 : 1.25;
        this.displayCount = Math.round(Math.max(2, Math.min(this.maxPoints, this.displayCount * factor)));

        this.scrollOffset = Math.round(anchorIdx - ratio * this.displayCount);
        this.autoFollow   = false;
        this._clampScroll();
        this._updateScrollbar();
        if (this.isPaused) this.draw();
    }

    /* ── Crosshair Mouse Tracking ── */
    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        this.mousePos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        if (this.isPaused) this.draw();
    }

    _onMouseLeave() {
        this.mousePos = null;
        if (this.isPaused) this.draw();
    }

    /* ── Scrollbar ── */
    _total() { return this.channels.reduce((m, ch) => Math.max(m, ch.data.length), 0); }

    _clampScroll() {
        const total = this._total();
        this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, total - this.displayCount));
        if (this.scrollOffset + this.displayCount >= total) this.autoFollow = true;
    }

    _initScrollbar() {
        if (!this.scrollbarWrap || !this.scrollbarThumb) return;
        let dragging = false, dragStartX = 0, dragStartOff = 0;

        this.scrollbarThumb.addEventListener('mousedown', (e) => {
            dragging = true; dragStartX = e.clientX; dragStartOff = this.scrollOffset;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const wrapW  = this.scrollbarWrap.clientWidth;
            const thumbW = this.scrollbarThumb.offsetWidth;
            const dx     = e.clientX - dragStartX;
            const range  = Math.max(1, this._total() - this.displayCount);
            this.scrollOffset = Math.round(dragStartOff + (dx / (wrapW - thumbW)) * range);
            this.autoFollow = false;
            this._clampScroll(); this._updateScrollbar();
            if (this.isPaused) this.draw();
        });
        document.addEventListener('mouseup', () => { dragging = false; });

        this.scrollbarWrap.addEventListener('click', (e) => {
            if (e.target === this.scrollbarThumb) return;
            const rect  = this.scrollbarWrap.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            const total = this._total();
            this.scrollOffset = Math.round(ratio * Math.max(1, total - this.displayCount));
            this.autoFollow = false;
            this._clampScroll(); this._updateScrollbar();
            if (this.isPaused) this.draw();
        });
    }

    _updateScrollbar() {
        if (!this.scrollbarWrap || !this.scrollbarThumb) return;
        const total = this._total();
        if (total === 0 || this.displayCount >= total) {
            this.scrollbarThumb.style.left = '0'; this.scrollbarThumb.style.width = '100%'; return;
        }
        const wrapW  = this.scrollbarWrap.clientWidth;
        const thumbW = Math.max(24, Math.round(wrapW * this.displayCount / total));
        const left   = Math.round((this.scrollOffset / Math.max(1, total - this.displayCount)) * (wrapW - thumbW));
        this.scrollbarThumb.style.width = thumbW + 'px';
        this.scrollbarThumb.style.left  = left  + 'px';
    }

    /* ── Render ── */
    renderLoop() {
        if (!this.isPaused) this.draw();
        requestAnimationFrame(() => this.renderLoop());
    }

    draw() {
        const W = this.canvas.width, H = this.canvas.height;
        const plotW = W - this.pX, plotH = H - this.pY;

        // Background
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

        let startIdx    = Math.max(0, Math.floor(this.scrollOffset));
        const dispCnt   = Math.max(2, Math.floor(this.displayCount));
        let actualEnd   = Math.min(startIdx + dispCnt, total);
        let visibleCnt  = actualEnd - startIdx;
        if (visibleCnt <= 0) {
            this.scrollOffset = Math.max(0, total - dispCnt);
            startIdx   = Math.max(0, Math.floor(this.scrollOffset));
            actualEnd  = Math.min(startIdx + dispCnt, total);
            visibleCnt = actualEnd - startIdx;
        }
        const series = this._collectWindowSeries(startIdx, actualEnd);
        if (series.length === 0) { this._emitStats(''); return; }

        const summaryText = this._buildSummary(series, this.displayMode);
        this._emitStats(summaryText);

        let min, max, bounded, axisMaxIndex;
        if (this.yScaleMode === 'manual' && Number.isFinite(this.yMin) && Number.isFinite(this.yMax) && this.yMax !== this.yMin) {
            min = Math.min(this.yMin, this.yMax);
            max = Math.max(this.yMin, this.yMax);
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
        axisMaxIndex = this.displayMode === 'frequency'
            ? Math.max(...series.map(s => Math.max(1, Math.floor((s.fftSize || 2) / 2))))
            : Math.max(1, visibleCnt);

        // Y axis labels — tick marks drawn INTO the plot (left), so they don't resemble minus signs
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

        // X axis labels
        this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'top';
        for (let i = 0; i <= 10; i++) {
            const px  = (i/10) * plotW;
            const idx = this.displayMode === 'frequency'
                ? Math.floor((i / 10) * axisMaxIndex)
                : startIdx + Math.floor((i/10) * Math.max(0, visibleCnt - 1));
            this.ctx.fillStyle = '#aaaaaa';
            this.ctx.fillText(idx, px, plotH + 3);
        }

        // Waveforms
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

        // Crosshair
        if (this.mousePos) {
            this._drawCrosshair(plotW, plotH, min, bounded, startIdx, visibleCnt, axisMaxIndex, total);
        }
    }

    _drawCrosshair(plotW, plotH, min, bounded, startIdx, visibleCnt, axisMaxIndex, total) {
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
            ? [`Bin: ${xIdx}`, `Mag: ${yVal.toFixed(6)}`]
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
        for (const ch of this.channels) {
            if (!ch.visible || ch.data.length === 0) continue;
            const source = this.displayMode === 'frequency' ? this._prepareFrequencySeries(ch.data.slice(startIdx, Math.min(ch.data.length, startIdx + visibleCnt))) : null;
            const val = this.displayMode === 'frequency'
                ? (source && source.mags.length > 0 ? source.mags[Math.min(source.mags.length - 1, xIdx)] : 0)
                : (() => {
                    const iLow  = startIdx + Math.floor(fIdx);
                    const iHigh = startIdx + Math.ceil(fIdx);
                    const t     = fIdx - Math.floor(fIdx);
                    const vLow  = ch.data[iLow]  !== undefined ? ch.data[iLow]  : 0;
                    const vHigh = ch.data[iHigh] !== undefined ? ch.data[iHigh] : vLow;
                    return vLow + t * (vHigh - vLow);
                })();
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

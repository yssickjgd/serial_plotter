/* ═══════════════════════════════════════════════════════════════
 *  app.js — 应用主控制器
 *
 *  职责：装配通信、解析、数据缓冲和视图，处理页面交互。
 *
 *  代码结构：
 *    1. 工具函数（纯函数，无副作用）
 *    2. 模块实例化 & 全局状态
 *    3. DOM 引用（按 UI 区域分组）
 *    4. 统计面板（RX/TX 速率、帧率、校验失败率）
 *    5. Tab 切换
 *    6. 可拖拽分隔条
 *    7. 连接类型切换
 *    8. 帧格式配置
 *    9. 通道配置 UI
 *   10. 配置控制器的装配及 JSON 文件导入导出
 *   11. 数据路由 & 解析器回调
 *   12. 连接管理（串口 / 网络）
 *   13. 工具栏（暂停、清空、导出 CSV）
 *   14. 字节流日志与发送控制器
 *   15. 初始化
 * ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
    const { Limits, FrameBuffer, Plotter, SerialEngine, NetEngine, DataParser, RawFrameParser, bindAllSelectWheels,
        MonitorView, MonitorDisplay, MonitorDisplayView, MonitorSearch, SendController, ConfigStore, exportFrameCsv, writeFrameCsv,
        captureExportChunks, writeCaptureExport, CaptureHistory, replayCaptureHistory, TextCharacterCounter,
        HistoryWorkerPool, countCaptureText,
        collectConfigFromView, applyConfigToView, updatePlotOptionVisibility, CaptureDefaults,
        parseIntInRange, parsePort, validateConfig, yRangeError, normalizeYConfig, formatChannelId } = globalThis.SerialPlotter;

    /* ─────────────────────────────────────────────────────────
     *  1. 工具函数（纯函数，无副作用）
     * ───────────────────────────────────────────────────────── */

    /** 格式化字节数为人类可读字符串（B / KB / MB） */
    const formatBytes = (n) => {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    };

    /** 安全地格式化数值：非有限数返回 '--'，否则 toFixed + 右对齐 */
    const fmtFixed = (value, digits, width) => {
        if (!Number.isFinite(value)) return '--'.padStart(width, ' ');
        return value.toFixed(digits).padStart(width, ' ');
    };

    /** 返回当前时间的 "HH:MM:SS.mmm" 格式字符串 */
    const formatMonitorTime = () => {
        const now = new Date();
        return [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map(n => n.toString().padStart(2, '0')).join(':')
            + '.' + now.getMilliseconds().toString().padStart(3, '0');
    };

    /* ─────────────────────────────────────────────────────────
     *  2. 模块实例化 & 全局状态
     * ───────────────────────────────────────────────────────── */

    const serialAdapter = new SerialEngine();   // 串口通信适配器
    const netAdapter = new NetEngine();      // 网络通信适配器（通过 bridge.js）
    let parser = new DataParser();     // 二进制帧解析器
    let rawParser = new RawFrameParser();
    const captureHistory = new CaptureHistory();
    let rebuildingHistory = false;
    let drainingCapture = false;
    let historyGeneration = 0;
    let historyWorkerPool = null;
    let textCounter = new TextCharacterCounter();
    let pendingChannelSettings = null;
    let appliedFormat = null;
    let committedFormat = null;
    const captureMode = () => appliedFormat?.captureMode ?? 'number';
    const activeParser = () => captureMode() === 'number' ? parser : rawParser;
    const frames = new FrameBuffer(1, 1000);
    const txFrames = new FrameBuffer(1, 1000);
    txFrames.setRawMode(true);
    const plotter = new Plotter('waveform-canvas', frames);  // 波形绘图引擎

    let activeEngine = null;    // 当前激活的通信引擎（serialAdapter 或 netAdapter）
    let connecting = false;
    let capturePaused = false;   // 是否暂停数据采集


    /* ─────────────────────────────────────────────────────────
     *  3. DOM 引用（按 UI 区域分组）
     * ───────────────────────────────────────────────────────── */

    // —— 通讯 Tab ——
    const connTypeSelect = document.getElementById('conn-type');
    const serialConfigDiv = document.getElementById('config-serial');
    const netConfigDiv = document.getElementById('config-net');
    const localPortWrap = document.getElementById('wrap-local-port');
    const connectBtn = document.getElementById('btn-connect');
    const statusIndicator = document.getElementById('connection-indicator');
    const statusText = document.getElementById('connection-status');

    // —— 帧格式 Tab ——
    const headerChk = document.getElementById('chk-header');
    const headerConfigDiv = document.getElementById('header-config');
    const headerInput = document.getElementById('frame-header');
    const footerChk = document.getElementById('chk-footer');
    const footerConfigDiv = document.getElementById('footer-config');
    const footerInput = document.getElementById('frame-footer');
    const checksumChk = document.getElementById('chk-checksum');
    const dataTypeSelect = document.getElementById('data-type');
    const endiannessSelect = document.getElementById('endianness');
    const channelsInput = document.getElementById('channels-count');
    const maxPointsInput = document.getElementById('max-points');
    const plotWindowPointsInput = document.getElementById('plot-window-points');
    const captureModeSelect = document.getElementById('capture-mode');
    const rebuildHistoryChk = document.getElementById('rebuild-history');
    const textEncoding = document.getElementById('text-encoding');
    const textBoundary = document.getElementById('text-boundary');
    const idleGapSeconds = document.getElementById('idle-gap-seconds');
    const formatApplyStatus = document.getElementById('format-apply-status');

    // —— 通道 Tab ——
    const channelListDiv = document.getElementById('channel-config-list');
    const channelsAllOnBtn = document.getElementById('btn-channels-all-on');
    const channelsAllOffBtn = document.getElementById('btn-channels-all-off');
    const plotViewMode = document.getElementById('plot-view-mode');
    const plotYScaleMode = document.getElementById('plot-y-scale-mode');
    const plotTimeXUnit = document.getElementById('plot-time-x-unit');
    const plotFreqXUnit = document.getElementById('plot-freq-x-unit');
    const plotFreqXScale = document.getElementById('plot-freq-x-scale');
    const plotFreqYScale = document.getElementById('plot-freq-y-scale');
    const plotFftWindow = document.getElementById('plot-fft-window');
    const wrapPlotTimeAxis = document.getElementById('wrap-plot-time-axis');
    const wrapPlotFreqAxis = document.getElementById('wrap-plot-frequency-axis');
    const plotFftRemoveDc = document.getElementById('plot-fft-remove-dc');
    const wrapFftRemoveDc = document.getElementById('wrap-fft-remove-dc');
    const wrapPlotYBounds = document.getElementById('wrap-plot-y-bounds');
    const plotYMin = document.getElementById('plot-y-min');
    const plotYMax = document.getElementById('plot-y-max');
    const plotYRangeStatus = document.getElementById('plot-y-range-status');
    const plotChannelStats = document.getElementById('plot-channel-stats');
    const plotInfoRow = document.getElementById('plot-info-row');
    const plotFpsLabel = document.getElementById('stat-plot-fps');

    bindAllSelectWheels(document);

    // 时域/频域独立的 Y 轴范围（字符串值，与 UI 输入框同步）
    let plotYBounds = {
        time:      { min: '-1', max: '1', scaleMode: 'auto' },
        frequency: { min: '0.001', max: '1', scaleMode: 'auto' }
    };

    // —— 工具栏 ——
    const pauseBtn = document.getElementById('btn-pause');
    const clearBtn = document.getElementById('btn-clear');
    const exportBtn = document.getElementById('btn-export');
    const exportFormat = document.getElementById('export-format');
    const exportDirection = document.getElementById('export-direction');
    const exportTimestamps = document.getElementById('export-timestamps');
    const exportMarkers = document.getElementById('export-markers');
    const exportFormats = { number: 'csv', hex: 'hex-text', text: 'text' };
    let exporting = false;

    // —— 配置导入导出 ——
    const exportCfgBtn = document.getElementById('btn-export-cfg');
    const importCfgBtn = document.getElementById('btn-import-cfg');
    const cfgFileInput = document.getElementById('cfg-file-input');
    const cfgStatusText = document.getElementById('cfg-save-status');

    // —— 字节流监视台 ——
    const logContent = document.getElementById('data-log');
    const monitor = new MonitorView(logContent, frames);
    const syncMonitorDisplay = options => {
        monitor.setDisplayOptions(options);
        plotter.setNavigationColors({ match: options.searchMatchColor, current: options.searchCurrentColor });
    };
    const monitorDisplayView = new MonitorDisplayView(document, {
        onChange: options => { syncMonitorDisplay(options); saveConfig(); }
    });
    let monitorOrder = 0;
    const monitorSearchQuery = document.getElementById('monitor-search-query');
    const monitorSearchTolerance = document.getElementById('monitor-search-tolerance');
    const monitorSearchChannel = document.getElementById('monitor-search-channel');
    const monitorSearchChannelToggle = document.getElementById('monitor-search-channel-toggle');
    const monitorSearchChannelOptions = document.getElementById('monitor-search-channel-options');
    const monitorSearchStatus = document.getElementById('monitor-search-status');
    const monitorSearchCase = document.getElementById('monitor-search-case-sensitive');
    monitorSearchCase.checked = true;
    const searchOriginSelect = document.getElementById('monitor-search-origin');
    let numericSearchOrigin = searchOriginSelect.value;

    // —— 发送面板 ——
    const sendModeSelect = document.getElementById('send-mode');
    const sendIntervalInput = document.getElementById('send-interval');
    const sendIntervalUnit = document.getElementById('send-interval-unit');
    const sendInput = document.getElementById('send-input');
    const sendBtn = document.getElementById('btn-send');
    const loadFileBtn = document.getElementById('btn-load-file');
    const sendFileInput = document.getElementById('send-file-input');

    // —— 布局分隔条 ——
    const sidebar = document.getElementById('sidebar');
    const mainDisplay = document.getElementById('main-display');
    const hResizer = document.getElementById('h-resizer');
    const rightResizer = document.getElementById('right-resizer');
    const channelSidebar = document.getElementById('channel-sidebar');
    const canvasWrapper = document.getElementById('canvas-wrapper');
    const plotHeader = document.getElementById('plot-header');
    const vResizer = document.getElementById('v-resizer');
    const navigationPanel = document.getElementById('navigation-panel');
    const navTimeTools = document.getElementById('nav-time-tools');
    const navSearchTools = document.getElementById('nav-search-tools');
    const monitorPanel = document.getElementById('monitor-panel');
    const monitorHeader = document.getElementById('monitor-header');
    const monitorStats = document.getElementById('monitor-stats');
    const sendPanel = document.getElementById('send-panel');


    /* ─────────────────────────────────────────────────────────
     *  4. 统计面板（RX/TX 速率、帧率、校验失败率）
     *
     *  每秒计算一次，暂停时只更新基准值，不刷新显示。
     * ───────────────────────────────────────────────────────── */

    const stats = {
        rxBytes: 0, txBytes: 0,           // 累计收发字节数
        _rxLast: 0, _txLast: 0,           // 上次计算时的快照
        _framesLast: 0, _failsLast: 0,    // 上次计算时的帧数/失败数快照
        _period: 1000,                     // 计算周期（ms）
        framesPerSec: 0                    // 最新帧率
    };

    /* 定时刷新字节流监视台统计面板。 */
    const rxValue = document.getElementById('stat-rx-value');
    const txValue = document.getElementById('stat-tx-value');
    const frameRateValue = document.getElementById('stat-fps-value');
    const failureValue = document.getElementById('stat-fail-value');
    const failureLabel = document.getElementById('stat-fail-label');
    const renderTextStatistics = () => {
        if (captureMode() !== 'text') {
            failureLabel.textContent = '校验失败:';
            return;
        }
        failureLabel.textContent = '失败字符 / 总字符:';
        const ratio = textCounter.total ? textCounter.failed / textCounter.total * 100 : 0;
        failureValue.textContent = `${textCounter.failed} / ${textCounter.total} (${ratio.toFixed(1)}%)`;
    };
    const plotFrameCount = () => plotter.displayMode === 'frequency'
        ? plotter.completedSpectrumDraws : plotter.completedDraws;
    let plotFpsLastMode = plotter.displayMode;
    let plotFpsLastDraws = plotFrameCount();
    let plotFpsLastAt = performance.now();

    setInterval(() => {
        const now = performance.now();
        const elapsed = Math.max(1, now - plotFpsLastAt);
        const mode = plotter.displayMode;
        const currentDraws = plotFrameCount();
        const drawCount = mode === plotFpsLastMode ? currentDraws - plotFpsLastDraws : 0;
        plotFpsLabel.textContent = `绘图帧率: ${(drawCount * 1000 / elapsed).toFixed(1)} FPS`;
        plotFpsLabel.title = mode === 'frequency'
            ? '频域统计实际更新并绘制的新频谱，不计重复绘制的缓存频谱。'
            : '时域统计已完成的画布绘制。';
        plotFpsLastDraws = currentDraws;
        plotFpsLastMode = mode;
        plotFpsLastAt = now;
        renderTextStatistics();
        if (capturePaused || rebuildingHistory) {
            // 暂停期间只同步基准值，避免恢复后出现瞬时峰值
            stats._rxLast = stats.rxBytes;
            stats._txLast = stats.txBytes;
            stats._framesLast = activeParser().frameCount;
            stats._failsLast = activeParser().failCount;
            return;
        }

        const rxBps = stats.rxBytes - stats._rxLast;
        const txBps = stats.txBytes - stats._txLast;
        const receivingParser = activeParser();
        const frames = (receivingParser.frameCount - stats._framesLast) / (stats._period / 1000);
        const fails = receivingParser.failCount - stats._failsLast;
        const total = frames + fails;
        const failPct = total > 0 ? ((fails / total) * 100).toFixed(1) : '0.0';

        rxValue.textContent = `${formatBytes(rxBps)}/s`;
        txValue.textContent = `${formatBytes(txBps)}/s`;
        frameRateValue.textContent = `${frames} f/s`;
        if (captureMode() !== 'text') failureValue.textContent = `${failPct}%`;

        stats._rxLast = stats.rxBytes;
        stats._txLast = stats.txBytes;
        stats._framesLast = receivingParser.frameCount;
        stats._failsLast = receivingParser.failCount;
        stats.framesPerSec = frames;
        plotter.setSampleRateHz(frames);
    }, stats._period);

    /** 渲染波形统计信息到绘图区标题栏（单通道时显示） */
    const renderPlotStats = (statsData) => {
        if (!statsData) {
            if (!plotInfoRow.hidden) plotInfoRow.hidden = true;
            return;
        }
        // 主频跟随频域单位；主周期跟随时域单位，两者都使用同一 FFT 结果。
        const frequencyUnit = plotter.freqXUnit === 'bins' ? 'Bin' : 'Hz';
        const periodUnit = plotter.timeXUnit === 's' ? 's' : 'Sample';
        const frequencyValue = frequencyUnit === 'Bin' ? statsData.dominantBin
            : statsData.freq != null && plotter.sampleRateHz > 0
                ? statsData.freq * plotter.sampleRateHz : null;
        const periodValue = periodUnit === 'Sample' ? statsData.period
            : statsData.period != null && plotter.sampleRateHz > 0
                ? statsData.period / plotter.sampleRateHz : null;
        const frequencyText = frequencyValue == null ? '--'
            : fmtFixed(frequencyValue, frequencyUnit === 'Bin' ? 0 : 6, 15);
        const periodText = periodValue == null ? '--'
            : fmtFixed(periodValue, periodUnit === 'Sample' ? 0 : 6, 15);

        const segments = [
            ['通道:', statsData.channelLabel],
            ['最大值:', fmtFixed(statsData.max, 6, 15)],
            ['最小值:', fmtFixed(statsData.min, 6, 15)],
            ['峰峰值:', fmtFixed(statsData.pp, 6, 15)],
            ['均值:', fmtFixed(statsData.mean, 6, 15)],
            ['标准差:', fmtFixed(statsData.stdDev, 6, 15)],
            ['主频:', `${frequencyText} ${frequencyUnit}`],
            ['主周期:', `${periodText} ${periodUnit}`]
        ];
        if (!plotChannelStats.children.length) {
            const cells = segments.map(([label]) => {
                const cell = document.createElement('span');
                cell.className = 'plot-info-segment monitor-stat-item';
                const name = document.createElement('span');
                name.className = 'monitor-stat-label';
                name.textContent = label;
                const value = document.createElement('span');
                value.className = 'monitor-stat-value';
                cell.append(name, value);
                return cell;
            });
            plotChannelStats.replaceChildren(...cells);
        }
        segments.forEach(([, value], index) => {
            plotChannelStats.children[index].children[1].textContent = index === 0
                ? value : String(value).trim();
        });
        if (plotInfoRow.hidden) plotInfoRow.hidden = false;
    };

    plotter.onStatsUpdate = renderPlotStats;
    /* ─────────────────────────────────────────────────────────
     *  5. 左右侧栏独立切换栏目
     * ───────────────────────────────────────────────────────── */

    document.querySelectorAll('.tab-group').forEach(group => {
        group.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                group.querySelectorAll('.tab-btn').forEach(button => button.classList.remove('active'));
                group.querySelectorAll('.tab-content').forEach(panel => panel.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(btn.dataset.tab).classList.add('active');
            });
        });
    });

    const syncSidebarTabs = () => {
        monitorDisplayView.setMode(captureMode());
        for (const id of ['tab-monitor-config', 'tab-monitor-config-button', 'tab-export', 'tab-export-button'])
            document.getElementById(id).hidden = false;
        const wave = document.getElementById('tab-waveform-config');
        const waveButton = document.getElementById('tab-waveform-config-button');
        wave.hidden = waveButton.hidden = captureMode() !== 'number';
        if (wave.hidden && wave.classList.contains('active')) {
            wave.classList.remove('active');
            waveButton.classList.remove('active');
            document.getElementById('tab-monitor-config').classList.add('active');
            document.getElementById('tab-monitor-config-button').classList.add('active');
        }
    };


    /* ─────────────────────────────────────────────────────────
     *  6. 可拖拽分隔条
     *
     *  水平分隔条：调整侧栏宽度（180~500px）
     *  垂直分隔条：调整波形区 / 监视台高度比例
     * ───────────────────────────────────────────────────────── */

    // —— 水平分隔条（左侧设置 ↔ 主区域 ↔ 右侧通道）——
    let hDragging = false, hStartX = 0, hStartW = 0;
    let rightDragging = false, rightStartX = 0, rightStartW = 0;
    const appContainer = document.querySelector('.app-container');
    const minPlotWidth = 320;
    const dividerWidth = () => hResizer.offsetWidth + rightResizer.offsetWidth;

    /** 应用侧栏宽度并触发波形重绘，与 applyVerticalHeights 对应 */
    const applySidebarWidth = (newW) => {
        const available = appContainer.clientWidth - channelSidebar.offsetWidth -
            dividerWidth() - minPlotWidth;
        const w = Math.max(180, Math.min(500, available, newW));
        sidebar.style.width = sidebar.style.minWidth = sidebar.style.maxWidth = w + 'px';
        plotter.resize();
    };

    const applyRightWidth = newW => {
        const available = appContainer.clientWidth - sidebar.offsetWidth -
            dividerWidth() - minPlotWidth;
        const width = Math.max(240, Math.min(520, available, newW));
        channelSidebar.style.width = channelSidebar.style.minWidth =
            channelSidebar.style.maxWidth = width + 'px';
        plotter.resize();
    };

    /* 窗口缩小时约束侧栏宽度不超出可用空间 */
    window.addEventListener('resize', () => {
        if (!channelSidebar.hidden) applyRightWidth(channelSidebar.offsetWidth);
        applySidebarWidth(sidebar.offsetWidth);
    });

    hResizer.addEventListener('mousedown', (e) => {
        hDragging = true;
        hStartX = e.clientX;
        hStartW = sidebar.offsetWidth;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    rightResizer.addEventListener('mousedown', e => {
        rightDragging = true;
        rightStartX = e.clientX;
        rightStartW = channelSidebar.offsetWidth;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!hDragging) return;
        applySidebarWidth(hStartW + (e.clientX - hStartX));
    });

    document.addEventListener('mousemove', e => {
        if (!rightDragging) return;
        applyRightWidth(rightStartW - (e.clientX - rightStartX));
    });

    document.addEventListener('mouseup', () => {
        if (!hDragging) return;
        hDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });

    document.addEventListener('mouseup', () => {
        if (!rightDragging) return;
        rightDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
    applyRightWidth(channelSidebar.offsetWidth);
    applySidebarWidth(sidebar.offsetWidth);

    // —— 垂直分隔条（波形区 ↔ 监视台）——
    let vDragging = false, vStartY = 0, vStartH = 0;
    let canvasH = null;
    let canvasRatio = 0.62;
    let manualVerticalSplit = false;
    let waveformVisible = true;
    const minLogHeight = 92; // 四条 20px 记录行和上下各 6px 内边距
    const navigationPanelGap = 6; // 对应 .navigation-panel 的上边距
    const mainDisplayVerticalPadding = 16; // 对应 .main-display 的上下各 8px

    const minimumMonitorHeight = () => monitorHeader.offsetHeight + monitorStats.offsetHeight +
        sendPanel.offsetHeight + minLogHeight + 8;
    const minimumCanvasHeight = () => Math.max(60, plotHeader.offsetHeight + 24);
    const verticalUsableHeight = () => Math.max(140, mainDisplay.clientHeight -
        mainDisplayVerticalPadding - navigationPanel.offsetHeight - navigationPanelGap - vResizer.offsetHeight -
        (rebuildingHistory ? document.getElementById('history-rebuild-progress').offsetHeight : 0));

    /** 根据 canvasH 重新分配波形区和监视台的高度，与 applySidebarWidth 对应 */
    const applyVerticalHeights = () => {
        if (!waveformVisible) {
            canvasWrapper.hidden = true;
            vResizer.hidden = true;
            monitorPanel.style.flex = '1';
            monitorPanel.style.height = '';
            return;
        }
        canvasWrapper.hidden = false;
        vResizer.hidden = false;
        const usable = verticalUsableHeight();
        const minMonitorH = Math.max(minimumMonitorHeight(), manualVerticalSplit ? 0
            : Math.min(320, Math.max(180, usable * 0.42)));
        canvasH = Math.max(minimumCanvasHeight(), Math.min(usable - minMonitorH,
            Math.round(usable * canvasRatio)));
        const monH = Math.max(minMonitorH, usable - canvasH);
        canvasWrapper.style.flex = 'none';
        canvasWrapper.style.height = canvasH + 'px';
        monitorPanel.style.flex = 'none';
        monitorPanel.style.height = monH + 'px';
        plotter.resize();
    };

    applyVerticalHeights();
    window.addEventListener('resize', applyVerticalHeights);
    if (typeof ResizeObserver !== 'undefined') {
        const toolsResizeObserver = new ResizeObserver(() => applyVerticalHeights());
        for (const section of [plotHeader, navigationPanel, monitorHeader, monitorStats,
            sendPanel]) toolsResizeObserver.observe(section);
    }

    const focusFrameInBothMonitors = index => {
        if (captureMode() === 'number' && plotViewMode.value !== 'time') {
            plotViewMode.value = 'time';
            plotViewMode.dispatchEvent(new Event('change'));
        }
        if (captureMode() === 'number') plotter.jumpToFrame(index);
        monitor.jumpToFrame(index);
    };

    const bindTimeJump = () => {
        const mode = document.getElementById('nav-jump-mode');
        const absolute = document.getElementById('nav-jump-absolute');
        const relative = document.getElementById('nav-jump-relative');
        const relativeUnit = document.getElementById('nav-jump-relative-unit');
        const status = document.getElementById('nav-jump-status');
        mode.addEventListener('change', () => {
            absolute.hidden = mode.value !== 'absolute';
            relative.hidden = mode.value !== 'relative';
            relativeUnit.hidden = mode.value !== 'relative';
            applyVerticalHeights();
        });
        document.getElementById('nav-jump-button').addEventListener('click', () => {
            if (!capturePaused) return;
            if (!frames.length || !Number.isFinite(frames.originTimestamp)) {
                status.textContent = '尚无带时间戳的采样帧';
                return;
            }
            const seconds = Number(relative.value);
            const target = mode.value === 'absolute' ? new Date(absolute.value).getTime()
                : relative.value.trim() !== '' && Number.isFinite(seconds) && seconds >= 0
                    ? frames.originTimestamp + seconds * 1000 : NaN;
            if (!Number.isFinite(target)) {
                status.textContent = '请输入有效时间';
                return;
            }
            const index = frames.nearestTimestampIndex(target);
            const order = frames.orderAt(index);
            monitor.cursorOrder = order;
            plotter.setNavigationMarkers({ timeOrder: order,
                matches: searchMatches, currentMatch: selectedMatch }, false);
            focusFrameInBothMonitors(index);
            status.textContent = `已定位第 ${index + 1} 帧，共 ${frames.length} 帧`;
        });
    };
    bindTimeJump();

    const defaultJumpDateTime = () => {
        const latestTimestamp = frames.timestampAt(frames.length - 1);
        const hasFrameTime = Number.isFinite(latestTimestamp);
        const date = hasFrameTime ? new Date(latestTimestamp) : new Date();
        const pad = (value, width = 2) => String(value).padStart(width, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
            `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
            pad(date.getMilliseconds(), 3);
    };
    let channelCheckboxes = [];
    const toolPanels = [navTimeTools, navSearchTools];
    const toolControlIds = [
        'nav-jump-mode',
        'nav-jump-absolute', 'nav-jump-relative', 'nav-jump-button',
        'monitor-search-query', 'monitor-search-tolerance', 'monitor-search-channel-toggle',
        'monitor-search-nearest', 'monitor-search-prev', 'monitor-search-next',
        'monitor-search-origin', 'monitor-search-case-sensitive'
    ];
    const syncTimeTools = () => {
        const busy = rebuildingHistory || drainingCapture;
        const enabled = capturePaused && !busy;
        maxPointsInput.disabled = plotWindowPointsInput.disabled = busy;
        for (const tools of toolPanels)
            tools.classList[enabled ? 'remove' : 'add']('tools-disabled');
        for (const id of toolControlIds)
            document.getElementById(id).disabled = !enabled;
        for (const { input } of channelCheckboxes) input.disabled = !enabled;
        searchOriginSelect.disabled = !enabled || captureMode() !== 'number';
        if (!capturePaused) {
            monitorSearchChannelOptions.hidden = true;
            monitorSearchChannelToggle.ariaExpanded = 'false';
        }
        if (capturePaused) {
            const value = defaultJumpDateTime();
            document.getElementById('nav-jump-absolute').value = value;
        }
    };
    syncTimeTools();

    let selectedSearchChannels = null; // null means all channels
    const selectedChannelFilter = () => selectedSearchChannels === null
        ? -1 : [...selectedSearchChannels].sort((left, right) => left - right);
    const searchChannelLabel = channel => {
        const number = formatChannelId(channel);
        const name = plotter.channels[channel]?.name;
        return name && name !== number ? `${number} · ${name}` : number;
    };
    const syncSearchChannelSelection = () => {
        const all = selectedSearchChannels === null;
        for (const { input, channel, label, text } of channelCheckboxes) {
            input.checked = channel < 0 ? all : !all && selectedSearchChannels.has(channel);
            text.textContent = channel < 0 ? '全部通道' : searchChannelLabel(channel);
            label.title = text.textContent;
        }
        const names = all ? [] : [...selectedSearchChannels]
            .sort((left, right) => left - right).map(searchChannelLabel);
        monitorSearchChannelToggle.textContent = all ? '全部通道' :
            names.length <= 2 ? names.join('、') : `已选 ${names.length} 通道`;
        monitorSearchChannelToggle.title = all ? '搜索全部通道' : names.join('、');
    };
    const populateSearchChannels = () => {
        if (selectedSearchChannels !== null) {
            selectedSearchChannels = new Set([...selectedSearchChannels]
                .filter(channel => channel < frames.channelCount));
            if (!selectedSearchChannels.size) selectedSearchChannels = null;
        }
        channelCheckboxes = [];
        monitorSearchChannelOptions.replaceChildren();
        for (let channel = -1; channel < frames.channelCount; channel++) {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = String(channel);
            input.disabled = !capturePaused;
            const text = document.createElement('span');
            text.className = 'search-channel-name';
            label.append(input, text);
            input.addEventListener('change', () => {
                if (channel < 0) selectedSearchChannels = null;
                else {
                    if (selectedSearchChannels === null) selectedSearchChannels = new Set();
                    if (input.checked) selectedSearchChannels.add(channel);
                    else selectedSearchChannels.delete(channel);
                    if (!selectedSearchChannels.size) selectedSearchChannels = null;
                }
                syncSearchChannelSelection();
                invalidateSearch();
            });
            channelCheckboxes.push({ input, channel, label, text });
            monitorSearchChannelOptions.appendChild(label);
        }
        syncSearchChannelSelection();
    };
    monitorSearchChannelToggle.addEventListener('click', () => {
        monitorSearchChannelOptions.hidden = !monitorSearchChannelOptions.hidden;
        monitorSearchChannelToggle.ariaExpanded = String(!monitorSearchChannelOptions.hidden);
    });
    document.addEventListener('click', event => {
        if (monitorSearchChannelOptions.hidden || monitorSearchChannel.contains(event.target)) return;
        monitorSearchChannelOptions.hidden = true;
        monitorSearchChannelToggle.ariaExpanded = 'false';
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        monitorSearchChannelOptions.hidden = true;
        monitorSearchChannelToggle.ariaExpanded = 'false';
    });
    populateSearchChannels();
    let searchSession = null;
    let searchGeneration = 0;
    let searchMatches = [];
    let selectedMatch = -1;
    let searchKey = null;
    let searchReady = false;
    let pendingSearchAction = null;
    const syncSearchFields = () => {
        const numeric = captureMode() === 'number';
        document.getElementById('monitor-search-case-wrap').hidden = captureMode() !== 'text';
        monitorSearchTolerance.hidden = !numeric;
        monitorSearchChannel.hidden = !numeric;
        if (!numeric) {
            monitorSearchChannelOptions.hidden = true;
            monitorSearchChannelToggle.ariaExpanded = 'false';
        }
        monitorSearchQuery.placeholder = numeric ? '目标数值' :
            captureMode() === 'text' ? '文本搜索' : '十六进制字节';
        if (numeric) populateSearchChannels();
        applyVerticalHeights();
    };
    const invalidateSearch = () => {
        searchGeneration++;
        searchSession = null;
        searchMatches = [];
        selectedMatch = -1;
        searchKey = null;
        searchReady = false;
        pendingSearchAction = null;
        monitor.setSearchResults([]);
        plotter.setNavigationMarkers({ timeOrder: plotter.navigationMarkers.timeOrder,
            matches: [], currentMatch: -1 });
        monitorSearchStatus.textContent = '';
    };
    for (const input of [monitorSearchQuery, monitorSearchTolerance])
        input.addEventListener('input', invalidateSearch);
    monitorSearchCase.addEventListener('change', invalidateSearch);
    syncSearchFields();
    const showSearchMatch = index => {
        if (!capturePaused) return;
        if (!searchMatches.length) {
            monitorSearchStatus.textContent = '无匹配结果';
            return;
        }
        selectedMatch = (index + searchMatches.length) % searchMatches.length;
        const match = searchMatches[selectedMatch];
        const frame = frames.indexAtOrAfterOrder(match.startOrder);
        if (frames.orderAt(frame) !== match.startOrder) {
            monitorSearchStatus.textContent = '该结果已被缓冲区覆盖，请重新搜索';
            return;
        }
        monitor.selectSearchMatch(selectedMatch);
        plotter.setNavigationMarkers({ timeOrder: plotter.navigationMarkers.timeOrder,
            matches: searchMatches, currentMatch: selectedMatch }, false);
        focusFrameInBothMonitors(frame);
        monitorSearchStatus.textContent = `${selectedMatch + 1} / ${searchMatches.length}`;
    };
    const searchInsertionIndex = frame => {
        let low = 0, high = searchMatches.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (searchMatches[mid].startFrame < frame) low = mid + 1;
            else high = mid;
        }
        return low;
    };
    const nearestSearchIndex = frame => {
        const next = searchInsertionIndex(frame);
        let candidate = next;
        if (next >= searchMatches.length) candidate = searchMatches.length - 1;
        else if (next > 0 && frame - searchMatches[next - 1].startFrame <=
            searchMatches[next].startFrame - frame) candidate = next - 1;
        // Select the first result in a frame, including multiple channels or byte matches.
        return searchInsertionIndex(searchMatches[candidate].startFrame);
    };
    const navigateSearch = ({ action, frame }) => {
        if (!searchMatches.length) {
            monitorSearchStatus.textContent = '无匹配结果';
            return;
        }
        if (action !== 'nearest' && selectedMatch >= 0) {
            showSearchMatch(selectedMatch + (action === 'next' ? 1 : -1));
            return;
        }
        const nearest = nearestSearchIndex(frame);
        const offset = action === 'prev' ? 1 : action === 'next' ? -1 : 0;
        showSearchMatch(nearest + offset);
    };
    const requestSearch = action => {
        if (!capturePaused) return;
        try {
            const options = MonitorSearch.parseMonitorSearch(captureMode(),
                monitorSearchQuery.value, monitorSearchTolerance.value,
                selectedChannelFilter(), appliedFormat?.textEncoding ?? 'utf-8', monitorSearchCase.checked);
            const key = JSON.stringify([captureMode(), appliedFormat?.textEncoding, monitorSearchQuery.value,
                monitorSearchTolerance.value, selectedChannelFilter(),
                captureMode() === 'text' ? monitorSearchCase.checked : null, frames.version]);
            const request = { action, frame: captureMode() === 'number' && searchOriginSelect.value === 'wave'
                ? plotter.currentFrameIndex() : monitor.currentFrameIndex() };
            if (key === searchKey) {
                if (searchReady) navigateSearch(request);
                else if (searchSession) pendingSearchAction = request;
                return;
            }
            const session = new MonitorSearch.MonitorSearchSession(frames, options);
            searchKey = key;
            searchReady = false;
            pendingSearchAction = request;
            searchSession = session;
            searchMatches = [];
            selectedMatch = -1;
            monitor.setSearchResults([]);
            plotter.setNavigationMarkers({ timeOrder: plotter.navigationMarkers.timeOrder,
                matches: [], currentMatch: -1 });
            const generation = ++searchGeneration;
            const scan = () => {
                if (generation !== searchGeneration || !capturePaused) return;
                try {
                    let done = false;
                    for (let batch = 0; batch < 8 && !done; batch++) done = session.step(512);
                    if (done) {
                        searchMatches = session.matches;
                        searchSession = null;
                        searchReady = true;
                        monitor.setSearchResults(searchMatches);
                        navigateSearch(pendingSearchAction);
                        pendingSearchAction = null;
                    } else {
                        monitorSearchStatus.textContent = `搜索中 ${session.position} / ${session.length}`;
                        setTimeout(scan, 0);
                    }
                } catch (error) {
                    searchSession = null;
                    searchKey = null;
                    searchReady = false;
                    pendingSearchAction = null;
                    monitorSearchStatus.textContent = error.message;
                }
            };
            scan();
        } catch (error) { monitorSearchStatus.textContent = error.message; }
    };
    for (const action of ['nearest', 'prev', 'next'])
        document.getElementById(`monitor-search-${action}`).addEventListener('click', () =>
            requestSearch(action));

    vResizer.addEventListener('mousedown', (e) => {
        vDragging = true;
        vStartY = e.clientY;
        vStartH = canvasWrapper.offsetHeight;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!vDragging) return;
        const usable = verticalUsableHeight();
        const minMonitorH = minimumMonitorHeight();
        canvasH = Math.max(minimumCanvasHeight(), Math.min(usable - minMonitorH,
            vStartH + (e.clientY - vStartY)));
        canvasRatio = canvasH / usable;
        manualVerticalSplit = true;
        applyVerticalHeights();
    });

    document.addEventListener('mouseup', () => {
        if (!vDragging) return;
        vDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });


    /* ─────────────────────────────────────────────────────────
     *  7. 连接类型切换（Serial ↔ TCP/UDP）
     *
     *  切换时显示/隐藏对应的配置面板，并保存配置。
     * ───────────────────────────────────────────────────────── */

    const updateConnectionModeUI = () => {
        const v = connTypeSelect.value;
        serialConfigDiv.style.display = v === 'serial' ? '' : 'none';
        netConfigDiv.style.display = v !== 'serial' ? '' : 'none';
        // UDP 和 TCP Server 需要额外配置本地端口
        localPortWrap.style.display = (v === 'udp' || v === 'tcp-server') ? 'flex' : 'none';
    };
    connTypeSelect.addEventListener('change', () => {
        updateConnectionModeUI();
        saveConfig();
    });


    /* ─────────────────────────────────────────────────────────
     *  8. 帧格式配置
     *
     *  包括：帧头/帧尾启用切换、校验位、数据类型、端序、通道数。
     *  点击"应用"后将配置同步给 DataParser 和 Plotter。
     * ───────────────────────────────────────────────────────── */

    /** 未启用的帧头/帧尾输入不占用配置面板空间。 */
    const toggleConfigSection = (checkbox, container) => {
        container.hidden = !checkbox.checked;
    };

    headerChk.addEventListener('change', () => { toggleConfigSection(headerChk, headerConfigDiv); });
    footerChk.addEventListener('change', () => { toggleConfigSection(footerChk, footerConfigDiv); });

    // 初始化时根据 checkbox 状态设置样式
    toggleConfigSection(headerChk, headerConfigDiv);
    toggleConfigSection(footerChk, footerConfigDiv);

    const readCaptureFormat = () => ({
        captureMode: captureModeSelect.value, textEncoding: textEncoding.value,
        textBoundary: textBoundary.value, idleGapSeconds: idleGapSeconds.value,
        enableHeader: headerChk.checked, headerHex: headerInput.value,
        enableFooter: footerChk.checked, footerHex: footerInput.value,
        enableChecksum: checksumChk.checked, dataType: dataTypeSelect.value,
        endianness: endiannessSelect.value, channelsCount: channelsInput.value
    });
    const syncCaptureFields = () => {
        const mode = captureModeSelect.value;
        const numeric = mode === 'number';
        for (const id of ['frame-numeric-settings', 'frame-header-settings',
            'frame-footer-settings', 'frame-checksum-settings'])
            document.getElementById(id).hidden = !numeric;
        document.getElementById('frame-raw-settings').hidden = numeric;
        document.getElementById('frame-text-settings').hidden = mode !== 'text';
        document.getElementById('frame-idle-settings').hidden = numeric ||
            (mode === 'text' && textBoundary.value !== 'idle');
        const applied = appliedFormat && JSON.stringify(readCaptureFormat()) === JSON.stringify(appliedFormat);
        formatApplyStatus.textContent = '';
        formatApplyStatus.hidden = true;
        formatApplyStatus.dataset.state = applied ? 'applied' : 'editing';
    };
    const autoApplyFormat = () => {
        syncCaptureFields();
        try { updateParserSettings(); saveConfig(); }
        catch (error) {
            formatApplyStatus.textContent = `${error.message}；继续使用上一次有效配置。`;
            formatApplyStatus.dataset.state = 'invalid';
            formatApplyStatus.hidden = false;
        }
    };
    for (const input of [captureModeSelect, textEncoding, textBoundary, idleGapSeconds,
        headerChk, headerInput, footerChk, footerInput, checksumChk,
        dataTypeSelect, endiannessSelect, channelsInput]) {
        input.addEventListener('change', autoApplyFormat);
        if (input.tagName !== 'SELECT' && input.type !== 'checkbox') {
            input.addEventListener('input', syncCaptureFields);
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') autoApplyFormat();
            });
        }
    }

    const syncExportControls = () => {
        const mode = captureMode();
        const allowed = mode === 'number' ? ['csv'] : mode === 'hex' ? ['binary', 'hex-text'] : ['text'];
        for (const option of exportFormat.options) option.disabled = option.hidden = !allowed.includes(option.value);
        if (!allowed.includes(exportFormat.value)) exportFormat.value = exportFormats[mode];
        document.getElementById('wrap-export-direction').hidden = mode === 'number';
        document.getElementById('export-text-metadata').hidden = exportFormat.value === 'binary';
        document.getElementById('wrap-export-markers').hidden = mode === 'number';
        document.getElementById('export-binary-hint').hidden = exportFormat.value !== 'binary';
        document.getElementById('export-retention-hint').hidden = mode === 'number';
        exportBtn.disabled = exporting || rebuildingHistory || drainingCapture;
    };
    exportFormat.addEventListener('change', () => {
        exportFormats[captureMode()] = exportFormat.value;
        syncExportControls();
    });

    /** Feed archived arrivals into the installed parser without waiting for a silent stream. */
    const drainCaptureHistory = async (result, generation, next, maxPoints) => {
        drainingCapture = true;
        syncTimeTools(); syncExportControls();
        const progress = document.getElementById('history-rebuild-progress');
        progress.textContent = '历史解析已完成，正在处理新到达的数据';
        try {
            do {
                result = await replayCaptureHistory(captureHistory,
                    { ...next, channelsCount: Number(next.channelsCount), isLittleEndian: next.endianness === 'little' },
                    maxPoints, {
                        previousResult: { ...result, frames }, preserveCallbacks: true,
                        stopByte: captureHistory.endByte, maxSliceBytes: 4096,
                        flushPending: () => capturePaused || !activeEngine,
                        isCancelled: () => generation !== historyGeneration,
                        onBoundary: () => { if (next.captureMode === 'text') textCounter.flush(); },
                        onGap: ({ byteOffset }) => {
                            textCounter.reset(next.textEncoding,
                                { byteOffset: byteOffset - captureHistory.streamStartByte });
                        }
                    });
                if (result.cancelled || generation !== historyGeneration) return;
                monitor.schedule();
                if (capturePaused) plotter.draw();
            } while (result.endByte < captureHistory.endByte || result.revision !== captureHistory.revision);
        } catch (error) {
            if (generation !== historyGeneration) return;
            statusText.textContent = `处理接收数据失败: ${error.message}`;
            setCapturePaused(true);
        } finally {
            if (generation === historyGeneration) {
                drainingCapture = false;
                if (next.captureMode !== 'number') rawParser.resumeTimers();
                renderTextStatistics(); monitor.render();
                syncTimeTools(); syncExportControls();
            }
        }
    };

    const startHistoryRebuild = async (next, ch, maxPoints, plotWindowPoints) => {
        const generation = ++historyGeneration;
        historyWorkerPool?.dispose();
        historyWorkerPool = null;
        const previousFormat = committedFormat;
        let installed = false;
        // Seed captures made through the parser API as well as the normal transport entry.
        if (!captureHistory.byteLength && frames.length) {
            for (let i = 0; i < frames.length; i++) {
                const frame = frames.frameAt(i);
                captureHistory.append(frame.bytes, { timestamp: frame.timestamp,
                    arrival: Number.isFinite(frame.timestamp) ? frame.timestamp : i,
                    order: frame.order });
            }
        }
        parser.reset(); rawParser.reset();
        drainingCapture = false;
        rebuildingHistory = true;
        if (next.captureMode !== 'number' && previousFormat?.captureMode === 'number')
            numericSearchOrigin = searchOriginSelect.value;
        appliedFormat = next;
        invalidateSearch();
        syncTimeTools(); syncExportControls();
        const progress = document.getElementById('history-rebuild-progress');
        progress.hidden = false;
        progress.textContent = '正在重新解析历史数据 0%';
        applyVerticalHeights();
        const snapshotStart = captureHistory.startByte, snapshotEnd = captureHistory.endByte;
        const workerPool = snapshotEnd - snapshotStart >= 524288 && next.captureMode !== 'hex'
            ? new HistoryWorkerPool() : null;
        historyWorkerPool = workerPool;
        const useWorkers = workerPool?.available === true;
        const workerLabel = useWorkers ? `（最多 ${workerPool.maxWorkers} 个后台线程）` : '';
        let counter = new TextCharacterCounter(next.textEncoding,
            { byteOffset: captureHistory.startByte - captureHistory.streamStartByte });
        try {
            const replayFormat = { ...next, channelsCount: ch, isLittleEndian: next.endianness === 'little' };
            const replayOptions = {
                stopByte: snapshotEnd,
                maxSliceBytes: useWorkers ? 65536 : 4096,
                flushPending: () => capturePaused || !activeEngine,
                isCancelled: () => generation !== historyGeneration,
                onBytes: bytes => { if (next.captureMode === 'text' && !useWorkers) counter.write(bytes); },
                onBoundary: () => { if (next.captureMode === 'text' && !useWorkers) counter.flush(); },
                onGap: ({ byteOffset }) => counter.reset(next.textEncoding,
                    { byteOffset: byteOffset - captureHistory.streamStartByte }),
                onProgress: ({ processedBytes, totalBytes }) => {
                    if (generation === historyGeneration)
                        progress.textContent = `正在重新解析历史数据 ${totalBytes ? Math.floor(processedBytes / totalBytes * 100) : 100}%${workerLabel}`;
                }
            };
            if (useWorkers && next.captureMode === 'number') {
                const headerLength = next.enableHeader ? DataParser.hexToBytes(next.headerHex).length : 0;
                replayOptions.maxPendingDecodes = workerPool.maxWorkers;
                replayOptions.decodeBatch = records => {
                    const frameLength = records[0].bytes.length;
                    const bytes = new Uint8Array(frameLength * records.length);
                    for (let i = 0; i < records.length; i++) bytes.set(records[i].bytes, frameLength * i);
                    return workerPool.runTask({ kind: 'numeric', bytes, frameLength, headerLength,
                        type: next.dataType, littleEndian: replayFormat.isLittleEndian, channels: ch });
                };
            }
            const result = await replayCaptureHistory(captureHistory, replayFormat, maxPoints, replayOptions);
            if (!result.cancelled && generation === historyGeneration && useWorkers && next.captureMode === 'text') {
                counter = await countCaptureText(captureHistory, next, workerPool, {
                    startByte: snapshotStart, endByte: result.endByte,
                    isCancelled: () => generation !== historyGeneration,
                    flushPending: () => (capturePaused || !activeEngine) && result.endByte >= captureHistory.endByte,
                    onProgress: ({ processedBytes, totalBytes }) => {
                        if (generation === historyGeneration)
                            progress.textContent = `正在解码历史文本 ${totalBytes ? Math.floor(processedBytes / totalBytes * 100) : 100}%${workerLabel}`;
                    }
                });
                if (!counter || generation !== historyGeneration) return;
            }
            let preparedText = null;
            if (!result.cancelled && generation === historyGeneration && next.captureMode === 'text') {
                preparedText = await monitor.prepareText(result.frames, next.textEncoding, {
                    isCancelled: () => generation !== historyGeneration,
                    prepareRecord: useWorkers ? task => workerPool.runTask(task) : null,
                    onProgress: fraction => {
                        if (generation === historyGeneration)
                            progress.textContent = `正在准备文本显示 ${Math.floor(fraction * 100)}%${workerLabel}`;
                    }
                });
            }
            if (result.cancelled || generation !== historyGeneration) return;
            const txEntries = monitor.extras.filter(entry => entry.kind === 'tx' || entry.kind === 'tx-error');
            const previousSampleRate = plotter.sampleRateHz;
            plotter.clear();
            frames.replaceFrom(result.frames);
            installed = true;
            committedFormat = next;
            if (next.captureMode === 'number') parser = result.parser;
            else rawParser = result.parser;
            bindParserCallbacks();
            textCounter = counter;
            monitor.clear({ deferRender: true });
            for (const entry of txEntries) monitor.appendExtra(entry);
            for (const entry of result.errors.slice(-120)) monitor.appendExtra({ ...entry,
                reason: frameErrorLabels[entry.type] || '解析错误' });
            rebuildingHistory = false;
            if (next.captureMode === 'number' && previousFormat?.captureMode !== 'number')
                searchOriginSelect.value = numericSearchOrigin;
            applyCaptureView(next, ch, maxPoints, plotWindowPoints, false, true);
            if (preparedText) monitor.installPreparedText(preparedText);
            if (next.captureMode === 'number') {
                const span = frames.length > 1 ? frames.timestampAt(frames.length - 1) - frames.timestampAt(0) : 0;
                plotter.setSampleRateHz(span > 0 ? (frames.length - 1) * 1000 / span : previousSampleRate);
            }
            monitor.render();
            plotter.draw();
            if (result.endByte < captureHistory.endByte || result.revision !== captureHistory.revision)
                await drainCaptureHistory(result, generation, next, maxPoints);
            else if (next.captureMode !== 'number') rawParser.resumeTimers();
        } catch (error) {
            if (generation !== historyGeneration) return;
            rebuildingHistory = false;
            appliedFormat = installed ? next : previousFormat;
            if (installed) {
                // A presentation failure must not restore a parser format different from the installed data.
                monitor.mode = next.captureMode;
                monitor.encoding = next.textEncoding;
                try { applyCaptureView(next, ch, maxPoints, plotWindowPoints, false); } catch (_) { }
            }
            formatApplyStatus.hidden = false;
            formatApplyStatus.textContent = `历史重新解析失败：${error.message}；原始字节仍已保留。`;
            setCapturePaused(true);
            syncExportControls();
        } finally {
            workerPool?.dispose();
            if (historyWorkerPool === workerPool) historyWorkerPool = null;
            if (generation === historyGeneration) { progress.hidden = true; applyVerticalHeights(); }
        }
    };

    const applyCaptureView = (next, ch, maxPoints, plotWindowPoints, configure, deferRender = false) => {
        const capacityShrank = maxPoints < plotter.maxPoints;
        if (next.captureMode !== 'number') {
            if (appliedFormat?.captureMode === 'number') numericSearchOrigin = searchOriginSelect.value;
            searchOriginSelect.value = 'byte';
        } else if (appliedFormat && appliedFormat.captureMode !== 'number') {
            searchOriginSelect.value = numericSearchOrigin;
        }
        appliedFormat = next;
        if (next.captureMode === 'number') {
            if (configure) parser.setFormat({ ...next, isLittleEndian: next.endianness === 'little', channelsCount: ch });
        } else if (configure) {
            rawParser.setFormat({ boundary: next.captureMode === 'hex' ? 'idle' : next.textBoundary,
                idleGapSeconds: Number(next.idleGapSeconds),
                encoding: next.captureMode === 'hex' ? 'utf-8' : next.textEncoding });
            rawParser.resumeTimers();
        }
        plotter.setChannelCount(ch);
        frames.setRawMode(next.captureMode !== 'number');
        if (pendingChannelSettings) {
            plotter.setChannelSettings(pendingChannelSettings);
            pendingChannelSettings = null;
        }
        populateSearchChannels();
        plotter.setMaxPoints(maxPoints);
        if (capacityShrank && frames.length) captureHistory.pruneBefore(frames.rawByteOffsetAt(0));
        txFrames.resize(maxPoints);
        plotter.setPlotWindowPoints(Math.min(plotWindowPoints, maxPoints));
        plotWindowPointsInput.value = String(plotter.plotWindowPoints);
        plotWindowPointsInput.max = String(Math.min(maxPoints, Limits.maxPlotWindowPoints));
        rebuildChannelList();
        monitor.setEncoding(next.textEncoding, { deferRender });
        monitor.setMode(next.captureMode, { deferRender });
        waveformVisible = next.captureMode === 'number';
        plotter.isVisible = waveformVisible;
        channelSidebar.hidden = rightResizer.hidden = false;
        syncSidebarTabs();
        document.getElementById('channels-display-panel').hidden = !waveformVisible;
        document.getElementById('channels-list-panel').hidden = !waveformVisible;
        document.getElementById('plot-window-control').hidden = !waveformVisible;
        document.getElementById('max-points-label').textContent = waveformVisible ? '最大采样点数' : '最大帧数量';
        exportFormat.value = exportFormats[captureMode()];
        syncExportControls();
        stats._framesLast = activeParser().frameCount;
        stats._failsLast = activeParser().failCount;
        syncCaptureFields(); syncSearchFields(); syncTimeTools(); applyVerticalHeights();
        syncPlotDisplaySettings();
        renderTextStatistics();
        if (next.captureMode !== 'text') failureValue.textContent = '0.0%';
        committedFormat = next;
    };

    /** 输入完成且合法时自动应用，失败时继续使用原有解析器。 */
    const updateParserSettings = () => {
        const next = readCaptureFormat();
        validateConfig(next);
        const ch = parseIntInRange(channelsInput.value, Limits.minChannels, Limits.maxChannels, '通道数');
        const maxPoints = parseIntInRange(maxPointsInput.value, Limits.minPoints, Limits.maxPoints, '采样点数');
        const plotWindowPoints = parseIntInRange(plotWindowPointsInput.value,
            Limits.minPoints, Limits.maxPlotWindowPoints, '波形监视台内采样点数');
        const signature = format => format.captureMode === 'number'
            ? ['number', format.dataType, format.endianness, format.channelsCount,
                format.enableHeader, format.headerHex, format.enableFooter, format.footerHex, format.enableChecksum]
            : ['raw', format.captureMode === 'text' ? format.textEncoding : 'utf-8',
                format.captureMode === 'text' ? format.textBoundary : 'idle',
                Number(format.idleGapSeconds)];
        const changed = !appliedFormat || next.captureMode !== appliedFormat.captureMode ||
            JSON.stringify(signature(next)) !== JSON.stringify(signature(appliedFormat));
        if (appliedFormat && next.captureMode !== appliedFormat.captureMode) invalidateSearch();
        if ((changed || rebuildingHistory) && (captureHistory.byteLength || frames.length || txFrames.length) && !rebuildHistoryChk.checked) {
            clearBtn.click();
            textCounter.reset(next.textEncoding);
            applyCaptureView(next, ch, maxPoints, plotWindowPoints, true);
            return;
        }
        if ((changed || rebuildingHistory) && (captureHistory.byteLength || frames.length)) {
            startHistoryRebuild(next, ch, maxPoints, plotWindowPoints);
            return;
        }
        if (changed) { parser.reset(); rawParser.reset(); }
        if (changed) textCounter.reset(next.textEncoding);
        applyCaptureView(next, ch, maxPoints, plotWindowPoints, changed);
    };

    maxPointsInput.addEventListener('change', () => {
        try {
            plotter.setMaxPoints(parseIntInRange(maxPointsInput.value, Limits.minPoints, Limits.maxPoints, '采样点数'));
            txFrames.resize(plotter.maxPoints);
            if (frames.length) captureHistory.pruneBefore(frames.rawByteOffsetAt(0));
            plotWindowPointsInput.value = String(plotter.plotWindowPoints);
            plotWindowPointsInput.max = String(Math.min(plotter.maxPoints, Limits.maxPlotWindowPoints));
            monitor.render();
            saveConfig();
        } catch (error) {
            maxPointsInput.value = plotter.maxPoints;
            alert(error.message);
        }
    });

    plotWindowPointsInput.addEventListener('change', () => {
        try {
            plotter.setPlotWindowPoints(parseIntInRange(plotWindowPointsInput.value,
                Limits.minPoints, Math.min(plotter.maxPoints, Limits.maxPlotWindowPoints),
                '波形监视台内采样点数'));
            saveConfig();
        } catch (error) {
            plotWindowPointsInput.value = String(plotter.plotWindowPoints);
            alert(error.message);
        }
    });


    /* ─────────────────────────────────────────────────────────
     *  9. 通道配置 UI
     *
     *  根据 plotter 中的通道数据动态生成配置行：
     *    - 颜色选择器
     *    - 名称输入框
     *    - 可见性复选框
     * ───────────────────────────────────────────────────────── */

    /** 将绘图显示选项同步给 plotter（时域/频域、Y 轴策略、Y 轴范围等） */
    const syncPlotDisplaySettings = ({ resetYZoom = false } = {}) => {
        const errors = {};
        for (const mode of ['time', 'frequency']) {
            const bounds = plotYBounds[mode];
            errors[mode] = bounds.scaleMode === 'manual'
                ? yRangeError(bounds.min, bounds.max, mode === 'frequency' && plotFreqYScale.value === 'log') : '';
        }
        const mode = plotViewMode.value === 'frequency' ? 'frequency' : 'time';
        plotYRangeStatus.textContent = errors[mode] ? `${errors[mode]}，当前范围未应用，暂用自动范围。` : '';
        plotYRangeStatus.hidden = !errors[mode];
        plotter.setDisplayOptions({
            displayMode: plotViewMode.value,
            yScaleModeTime: errors.time ? 'auto' : plotYBounds.time.scaleMode,
            yScaleModeFreq: errors.frequency ? 'auto' : plotYBounds.frequency.scaleMode,
            resetYZoom,
            timeXUnit: plotTimeXUnit.value,
            freqXUnit: plotFreqXUnit.value,
            freqXScale: plotFreqXScale.value,
            freqYScale: plotFreqYScale.value,
            removeDcForFft: plotFftRemoveDc.checked,
            fftWindow: plotFftWindow.value,
            yMinTime: plotYBounds.time.min, yMaxTime: plotYBounds.time.max,
            yMinFreq: plotYBounds.frequency.min, yMaxFreq: plotYBounds.frequency.max
        });
    };

    /** 重建通道配置列表 UI（在通道数变化或应用帧格式时调用） */
    const expandedChannelIndices = new Set();
    const rebuildChannelList = () => {
        channelListDiv.innerHTML = '';
        const metas = plotter.getChannelMeta();
        for (const index of expandedChannelIndices)
            if (index >= metas.length) expandedChannelIndices.delete(index);

        if (metas.length === 0) {
            const p = document.createElement('p');
            p.className = 'hint-text';
            p.textContent = '请先在帧格式页设置通道数。';
            channelListDiv.appendChild(p);
            return;
        }

        metas.forEach(meta => {
            const row = document.createElement('div');
            row.className = 'channel-row';
            const channelId = formatChannelId(meta.index);

            // CH 按钮展开该通道的放大与偏移设置。
            const channelToggle = document.createElement('button');
            channelToggle.type = 'button';
            channelToggle.className = 'channel-row-label channel-expand-toggle';
            channelToggle.textContent = channelId;
            channelToggle.ariaExpanded = String(expandedChannelIndices.has(meta.index));
            channelToggle.style.opacity = meta.visible ? '1' : '0.4';

            // 颜色选择器
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.className = 'channel-color-swatch';
            colorInput.value = meta.color;
            colorInput.title = '点击更改颜色';
            colorInput.addEventListener('input', () => {
                plotter.setChannelColor(meta.index, colorInput.value);
                saveConfig();
            });

            // 名称输入框
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'channel-name-input';
            nameInput.value = meta.name;
            nameInput.placeholder = channelId;
            nameInput.addEventListener('change', () => {
                plotter.setChannelName(meta.index, nameInput.value || channelId);
                nameInput.value = plotter.getChannelMeta()[meta.index].name;
                syncSearchChannelSelection();
                saveConfig();
            });

            // 可见性复选框
            const visChk = document.createElement('input');
            visChk.type = 'checkbox';
            visChk.className = 'channel-vis-chk';
            visChk.checked = meta.visible;
            visChk.title = '显示/隐藏';
            visChk.addEventListener('change', () => {
                plotter.setChannelVisible(meta.index, visChk.checked);
                channelToggle.style.opacity = visChk.checked ? '1' : '0.4';
                saveConfig();
                syncPlotDisplaySettings();
            });

            const main = document.createElement('div');
            main.className = 'channel-row-main';
            main.append(channelToggle, colorInput, nameInput, visChk);

            const transformOptions = document.createElement('div');
            transformOptions.className = 'channel-transform-options';
            transformOptions.id = `channel-transform-${meta.index + 1}`;
            transformOptions.hidden = !expandedChannelIndices.has(meta.index);
            channelToggle.ariaControls = transformOptions.id;
            channelToggle.addEventListener('click', () => {
                if (transformOptions.hidden) expandedChannelIndices.add(meta.index);
                else expandedChannelIndices.delete(meta.index);
                transformOptions.hidden = !transformOptions.hidden;
                channelToggle.ariaExpanded = String(!transformOptions.hidden);
            });
            const makeTransform = (key, text, enabled, value) => {
                const option = document.createElement('div');
                option.className = 'channel-transform-option';
                const checkLabel = document.createElement('label');
                checkLabel.className = 'chk-label';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = enabled;
                checkLabel.append(checkbox, text);
                const input = document.createElement('input');
                input.type = 'number';
                input.step = 'any';
                input.value = String(value);
                input.ariaLabel = `${channelId} ${text}`;
                input.style.display = enabled ? '' : 'none';
                option.append(checkLabel, input);
                const update = () => {
                    const gainInput = transformOptions.querySelector('[data-transform="gain"]');
                    const offsetInput = transformOptions.querySelector('[data-transform="offset"]');
                    const current = plotter.getChannelMeta()[meta.index];
                    const readNumber = (field, fallback) => {
                        const number = field.value.trim() === '' ? NaN : Number(field.value);
                        if (Number.isFinite(number)) return number;
                        field.setCustomValidity('请输入有限数值');
                        field.reportValidity();
                        field.setCustomValidity('');
                        field.value = String(fallback);
                        return fallback;
                    };
                    const gain = readNumber(gainInput, current.gain);
                    const offset = readNumber(offsetInput, current.offset);
                    plotter.setChannelTransform(meta.index, {
                        gainEnabled: transformOptions.querySelector('[data-enable="gain"]').checked,
                        gain, offsetEnabled: transformOptions.querySelector('[data-enable="offset"]').checked,
                        offset
                    });
                    saveConfig();
                };
                checkbox.dataset.enable = key;
                input.dataset.transform = key;
                checkbox.addEventListener('change', () => {
                    input.style.display = checkbox.checked ? '' : 'none';
                    update();
                });
                input.addEventListener('change', update);
                return option;
            };
            transformOptions.append(
                makeTransform('gain', '放大系数', meta.gainEnabled, meta.gain),
                makeTransform('offset', '偏移量', meta.offsetEnabled, meta.offset)
            );
            row.append(main, transformOptions);
            channelListDiv.appendChild(row);
        });
    };

    // 将当前 UI 的 Y 轴值写入对应模式的 bounds
    const updateYBounds = () => {
        const mode = plotViewMode.value === 'frequency' ? 'frequency' : 'time';
        plotYBounds[mode].min = plotYMin.value;
        plotYBounds[mode].max = plotYMax.value;
    };

    // 波形模式切换时恢复对应模式的 Y 轴值到 UI，并切换"频域去直流"可见性
    plotViewMode.addEventListener('change', () => {
        const mode = plotViewMode.value === 'frequency' ? 'frequency' : 'time';
        plotYMin.value = plotYBounds[mode].min;
        plotYMax.value = plotYBounds[mode].max;
        plotYScaleMode.value = plotYBounds[mode].scaleMode;
        syncPlotDisplaySettings(); saveConfig();
        updatePlotOptionVisibility(configElements);
    });

    // 其他绘图选项变化时同步
    [plotYScaleMode, plotFftRemoveDc, plotTimeXUnit,
        plotFreqXUnit, plotFreqXScale, plotFreqYScale, plotFftWindow]
        .filter(Boolean)
        .forEach(el => el.addEventListener('change', () => {
            if (el === plotYScaleMode) {
                const mode = plotViewMode.value === 'frequency' ? 'frequency' : 'time';
                plotYBounds[mode].scaleMode = plotYScaleMode.value;
            }
            syncPlotDisplaySettings({ resetYZoom: el === plotYScaleMode });
            updatePlotOptionVisibility(configElements);
            saveConfig();
        }));

    // Y 轴范围变化时更新当前模式的 bounds 再同步
    [plotYMin, plotYMax]
        .filter(Boolean)
        .forEach(el => el.addEventListener('change', () => {
            updateYBounds(); syncPlotDisplaySettings({ resetYZoom: true }); saveConfig();
        }));

    // 全部打开 / 全部关闭
    channelsAllOnBtn.addEventListener('click', () => {
        plotter.setAllChannelsVisible(true);
        rebuildChannelList();
        syncPlotDisplaySettings();
        saveConfig();
    });
    channelsAllOffBtn.addEventListener('click', () => {
        plotter.setAllChannelsVisible(false);
        rebuildChannelList();
        syncPlotDisplaySettings();
        saveConfig();
    });


    /* ─────────────────────────────────────────────────────────
     *  10. 配置持久化
     *
     *  - localStorage 自动保存（key: serialplot_v3_config）
     *  - 支持 JSON 文件导入 / 导出
     * ───────────────────────────────────────────────────────── */

    const CONFIG_KEY = 'serialplot_v3_config';

    const configElements = {
        monitorDisplay: monitorDisplayView.elements,
        captureMode: captureModeSelect, textEncoding, textBoundary, idleGapSeconds,
        connType: connTypeSelect,
        serialBaud: document.getElementById('serial-baud'),
        serialData: document.getElementById('serial-data'),
        serialStop: document.getElementById('serial-stop'),
        serialParity: document.getElementById('serial-parity'),
        netHost: document.getElementById('net-host'),
        netPort: document.getElementById('net-port'),
        netLocalPort: document.getElementById('net-local'),
        enableHeader: headerChk, headerHex: headerInput,
        enableFooter: footerChk, footerHex: footerInput,
        enableChecksum: checksumChk, dataType: dataTypeSelect, rebuildHistory: rebuildHistoryChk,
        endianness: endiannessSelect, channelsCount: channelsInput,
        maxPoints: maxPointsInput, plotWindowPoints: plotWindowPointsInput,
        sendInterval: sendIntervalInput, sendIntervalUnit,
        plotViewMode, plotYScaleMode, plotFftRemoveDc,
        plotTimeXUnit, plotFreqXUnit, plotFreqXScale, plotFreqYScale, plotFftWindow,
        plotYMin, plotYMax, wrapFftRemoveDc, wrapPlotTimeAxis, wrapPlotFreqAxis,
        wrapPlotYBounds
    };

    /** 从当前 UI 状态收集完整配置对象 */
    const getConfig = () => ({ ...collectConfigFromView({ ...configElements, monitorDisplay: undefined },
        plotYBounds, pendingChannelSettings || plotter.getChannelMeta()), ...appliedFormat,
        monitorDisplay: { ...monitor.displayOptions } });

    /** 将配置对象应用到 UI，并同步到 parser / plotter */
    const applyConfig = (cfg) => {
        if (!cfg) return;
        if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('配置必须是 JSON 对象');
        const candidate = { ...getConfig(), ...CaptureDefaults, ...cfg };
        candidate.monitorDisplay = cfg.monitorDisplay === undefined ? MonitorDisplay.DEFAULTS : cfg.monitorDisplay;
        candidate.connType = cfg.connType || 'serial';
        candidate.plotFftWindow = cfg.plotFftWindow ?? 'hann';
        if (cfg.plotWindowPoints === undefined)
            candidate.plotWindowPoints = String(Math.min(1000, Number(candidate.maxPoints) || 1000));
        Object.assign(candidate, normalizeYConfig(cfg, candidate));
        validateConfig(candidate);
        applyConfigToView(candidate, {
            elements: configElements, bounds: plotYBounds, updateConnectionModeUI,
            updateMonitorDisplay: () => {
                monitorDisplayView.apply(candidate.monitorDisplay);
                syncMonitorDisplay(monitorDisplayView.read());
            },
            updateFrameFormat: () => {
                toggleConfigSection(headerChk, headerConfigDiv);
                toggleConfigSection(footerChk, footerConfigDiv);
                updateParserSettings();
            },
            updateChannels: channels => {
                if (!channels) return;
                if (rebuildingHistory) { pendingChannelSettings = channels; return; }
                plotter.setChannelSettings(channels);
                syncSearchChannelSelection();
                rebuildChannelList();
            },
            updatePlot: syncPlotDisplaySettings
        });
    };

    const configStore = new ConfigStore({
        storage: localStorage, key: CONFIG_KEY, validate: validateConfig,
        read: getConfig, apply: applyConfig
    });

    /** 保存当前配置到 localStorage */
    const saveConfig = () => {
        try {
            if (configStore.save()) cfgStatusText.textContent = '配置已自动保存。';
        } catch (e) {
            cfgStatusText.textContent = '保存失败: ' + e.message;
        }
    };

    /** 从 localStorage 加载配置；无配置时使用默认值初始化 parser */
    const loadConfig = () => {
        try {
            if (configStore.load()) {
                cfgStatusText.textContent = '已从本地存储载入配置。';
            } else {
                updateParserSettings();
            }
        } catch (e) {
            console.warn('配置加载失败:', e);
            updateParserSettings();
        }
    };

    // 导出配置为 JSON 文件
    exportCfgBtn.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(getConfig(), null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `serialplot_config_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // 导入配置文件
    importCfgBtn.addEventListener('click', () => cfgFileInput.click());
    cfgFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                applyConfig(JSON.parse(ev.target.result));
                saveConfig();
                cfgStatusText.textContent = '配置已导入。';
            } catch (err) {
                alert('配置文件格式错误: ' + err.message);
            }
        };
        reader.readAsText(file);
        e.target.value = '';  // 清空 input 以便重复选择同一文件
    });

    // 其余配置字段变化时自动保存；绘图控件已在上方同步并保存。
    sendIntervalUnit.addEventListener('change', saveConfig);
    rebuildHistoryChk.addEventListener('change', saveConfig);


    /* ─────────────────────────────────────────────────────────
     *  11. 数据路由 & 解析器回调
     *
     *  数据流：串口/网络 → parser.appendData()
     *         parser 回调 → plotter.addFrame() + 监视台日志
     * ───────────────────────────────────────────────────────── */

    // 所有数据源统一送入 parser
    const globalDataHandler = data => {
        if (capturePaused) return;
        try {
            const metadata = captureHistory.append(data, { timestamp: Date.now(),
                arrival: performance.now(), order: ++monitorOrder });
            if (rebuildingHistory || drainingCapture) { stats.rxBytes += data.length; return; }
            activeParser().appendData(data, metadata);
        }
        catch (error) { setCapturePaused(true); }
    };
    serialAdapter.onData(globalDataHandler);
    netAdapter.onData(globalDataHandler);

    // 原始数据到达 → 更新 RX 字节统计
    const frameErrorLabels = {
        checksum: '校验失败', footer: '帧尾不匹配', incomplete: '帧未完整'
    };
    const bindParserCallbacks = () => {
        parser.onRawData = bytes => {
            if (!drainingCapture) stats.rxBytes += bytes.length;
            if (captureMode() === 'text') textCounter.write(bytes);
        };
        rawParser.onRawData = parser.onRawData;
        const pruneEvictedHistory = wasFull => {
            if (wasFull && frames.length) captureHistory.pruneBefore(frames.rawByteOffsetAt(0));
        };
        parser.onFrameParsed = (valuesArr, timeStr, frameBytes, timestamp, metadata) => {
            const wasFull = frames.length === frames.capacity;
            plotter.addFrame(valuesArr, frameBytes, timeStr, metadata?.order || ++monitorOrder, timestamp,
                drainingCapture ? { ...metadata, capturedBeforePause: true } : metadata);
            pruneEvictedHistory(wasFull);
            monitor.appendFrame();
        };
        rawParser.onFrameParsed = (frameBytes, timeStr, timestamp, metadata) => {
            const wasFull = frames.length === frames.capacity;
            frames.appendRaw(frameBytes, timeStr, metadata?.order || ++monitorOrder, timestamp, metadata);
            pruneEvictedHistory(wasFull);
            monitor.appendFrame();
        };
        parser.onFrameError = (type, timeStr, frameBytes, metadata) => {
            const label = frameErrorLabels[type] || '解析错误';
            monitor.appendExtra({ kind: 'error', time: timeStr, reason: label,
                bytes: frameBytes, order: metadata?.order || ++monitorOrder });
        };
        parser.onCallbackError = error => {
            console.error('采集数据处理失败:', error);
            statusText.textContent = `采集已暂停: ${error.message}`;
        };
        rawParser.onCallbackError = error => {
            parser.onCallbackError(error);
            rawParser.reset();
            setCapturePaused(true);
        };
    };
    bindParserCallbacks();


    /* ─────────────────────────────────────────────────────────
     *  12. 连接管理
     *
     *  统一处理串口 / 网络的连接状态变化，
     *  更新 UI 指示器和按钮样式。
     * ───────────────────────────────────────────────────────── */

    /** 连接状态变化回调（串口和网络共用） */
    const onConnectionStatusChange = (connected, error) => {
        if (connected) {
            connectBtn.textContent = '主动断开连接';
            connectBtn.classList.replace('btn-primary', 'btn-danger');
            statusIndicator.className = 'status-dot connected';
            connTypeSelect.disabled = true;
        } else {
            captureHistory.markBoundary();
            if (!rebuildingHistory && !drainingCapture) {
                activeParser().flushPending();
                if (frames.rawMode) frames.markStreamEnded();
                if (captureMode() === 'text') { textCounter.flush(); renderTextStatistics(); }
            }
            sendController.stop();
            connectBtn.textContent = '请求建立连接';
            connectBtn.classList.replace('btn-danger', 'btn-primary');
            statusIndicator.className = 'status-dot disconnected';
            statusText.textContent = error
                ? `连接中断: ${error.message}` : '设备处于离线断开状态。';
            activeEngine = null;
            connTypeSelect.disabled = false;
        }
    };

    serialAdapter.onStatusChange(onConnectionStatusChange);
    netAdapter.onStatusChange(onConnectionStatusChange);

    /** 安全断开当前活跃引擎 */
    const disconnectActiveEngine = async () => {
        if (!activeEngine) return;
        try {
            if (typeof activeEngine.forceDisconnect === 'function') {
                await activeEngine.forceDisconnect();
            } else if (typeof activeEngine.disconnect === 'function') {
                await activeEngine.disconnect();
            }
        } catch (e) {
            console.warn('断开连接失败，执行最小清理:', e);
            try {
                if (typeof activeEngine.forceDisconnect === 'function') {
                    await activeEngine.forceDisconnect();
                }
            } catch (_) { }
        }
    };

    // 连接按钮：已连接时断开，未连接时建立连接
    connectBtn.addEventListener('click', async () => {
        if (connecting) return;
        // 已连接 → 断开
        if (activeEngine) {
            await disconnectActiveEngine();
            return;
        }

        // 未连接 → 根据模式建立连接
        const mode = connTypeSelect.value;
        connecting = true;
        connectBtn.disabled = true;
        statusText.textContent = '正在处理连接要求...';

        try {
            if (mode === 'serial') {
                const config = {
                    baudRate: parseIntInRange(document.getElementById('serial-baud').value,
                        1, Number.MAX_SAFE_INTEGER, '波特率'),
                    dataBits: parseInt(document.getElementById('serial-data').value),
                    stopBits: parseInt(document.getElementById('serial-stop').value),
                    parity: document.getElementById('serial-parity').value
                };
                statusText.textContent = '请于弹出框选择对应的串口通道...';
                await serialAdapter.connect(config);
                if (!serialAdapter.port || !serialAdapter.keepReading) throw new Error('串口连接已断开');
                activeEngine = serialAdapter;
                statusText.textContent = `串口就位: ${config.baudRate} bps`;
            } else {
                const port = parsePort(document.getElementById('net-port').value);
                const localText = document.getElementById('net-local').value.trim();
                const config = {
                    mode,
                    host: document.getElementById('net-host').value,
                    port,
                    localPort: localText ? parsePort(localText) : port
                };
                await netAdapter.connect(config);
                if (!netAdapter.ws || !netAdapter.keepReading) throw new Error('Bridge 连接已断开');
                activeEngine = netAdapter;
                statusText.textContent = 'TCP/UDP Bridge 已连通。';
            }
        } catch (e) {
            console.error('连接调度中断', e);
            statusText.textContent = `连接失败: ${e.message}`;
            activeEngine = null;
        } finally {
            connecting = false;
            connectBtn.disabled = false;
        }
    });


    /* ─────────────────────────────────────────────────────────
     *  13. 工具栏（暂停、清空、导出 CSV）
     * ───────────────────────────────────────────────────────── */

    const setCapturePaused = paused => {
        if (plotter.isPaused !== paused) plotter.togglePause();
        capturePaused = paused;
        if (!paused) {
            searchGeneration++;
            searchSession = null;
            searchMatches = [];
            selectedMatch = -1;
            searchKey = null;
            searchReady = false;
            pendingSearchAction = null;
            monitor.setSearchResults([]);
            monitor.cursorOrder = null;
            plotter.setNavigationMarkers({ timeOrder: null, matches: [], currentMatch: -1 });
            monitorSearchStatus.textContent = '';
        }
        if (paused && !rebuildingHistory && !drainingCapture) {
            captureHistory.markBoundary();
            activeParser().flushPending();
            if (frames.rawMode) frames.markStreamEnded();
            if (captureMode() === 'text') { textCounter.flush(); renderTextStatistics(); }
            monitor.render(); plotter.draw();
        }
        if (paused && (rebuildingHistory || drainingCapture)) captureHistory.markBoundary();
        syncTimeTools();
        pauseBtn.textContent = paused ? '恢复捕获队列' : '暂停捕捉';
        pauseBtn.className = paused ? 'btn btn-success' : 'btn btn-secondary';
    };
    pauseBtn.addEventListener('click', () => setCapturePaused(!capturePaused));

    clearBtn.addEventListener('click', () => {
        historyGeneration++;
        historyWorkerPool?.dispose();
        historyWorkerPool = null;
        rebuildingHistory = false;
        drainingCapture = false;
        captureHistory.clear();
        textCounter.reset(appliedFormat.textEncoding);
        document.getElementById('history-rebuild-progress').hidden = true;
        searchGeneration++;
        searchSession = null;
        searchMatches = [];
        selectedMatch = -1;
        searchKey = null;
        searchReady = false;
        pendingSearchAction = null;
        monitorSearchStatus.textContent = '';
        plotter.setNavigationMarkers({ timeOrder: null, matches: [], currentMatch: -1 });
        plotter.clear();
        txFrames.clear();
        monitor.clear();
        parser.reset();
        rawParser.reset();
        parser.frameCount = 0;
        parser.failCount = 0;
        rawParser.frameCount = 0;
        rawParser.failCount = 0;
        stats.rxBytes = 0;
        stats.txBytes = 0;
        stats._rxLast = 0;
        stats._txLast = 0;
        stats._framesLast = 0;
        stats._failsLast = 0;
        stats.framesPerSec = 0;
        applyCaptureView(appliedFormat, Number(appliedFormat.channelsCount), plotter.maxPoints,
            plotter.plotWindowPoints, true);
        renderTextStatistics();
        syncTimeTools(); syncExportControls();
    });

    exportBtn.addEventListener('click', async () => {
        if (exporting || rebuildingHistory || drainingCapture) return;
        const mode = captureMode();
        const options = { format: exportFormat.value, direction: exportDirection.value,
            encoding: appliedFormat.textEncoding, timestamps: exportTimestamps.checked, markers: exportMarkers.checked };
        const sources = mode === 'number' ? [frames] : options.direction === 'rx' ? [frames]
            : options.direction === 'tx' ? [txFrames] : [frames, txFrames];
        const count = sources.reduce((total, buffer) => total + buffer.length, 0);
        if (!count) { alert('当前导出范围内没有已保存的数据。'); return; }
        const firstOrder = buffer => buffer.length ? buffer.orderAt(0) : null;
        const firstOrders = sources.map(firstOrder);
        const channels = plotter.getChannelMeta();
        const extension = mode === 'number' ? 'csv' : options.format === 'binary' ? 'bin' : 'txt';
        const filename = `Scientific_Plot_Export_${Date.now()}.${extension}`;
        let large = count > 50000;
        if (!large && mode !== 'number') {
            let bytes = 0;
            for (const buffer of sources) {
                for (let i = 0; i < buffer.length && bytes <= 32 * 1024 * 1024; i++) bytes += buffer.rawBytesAt(i).length;
                if (bytes > 32 * 1024 * 1024) { large = true; break; }
            }
        }
        exporting = true;
        syncExportControls();
        let writable;
        try {
            if (large) {
                if (typeof window.showSaveFilePicker !== 'function')
                    throw new Error('大容量导出需要支持文件系统保存的 Chrome 或 Edge');
                const handle = await window.showSaveFilePicker({ suggestedName: filename });
                if (captureMode() !== mode || sources.some((buffer, i) => firstOrder(buffer) !== firstOrders[i]))
                    throw new Error('选择文件期间采集格式或保留窗口已变化，请重新导出');
                writable = await handle.createWritable();
                const progress = done => { exportBtn.textContent = `正在导出 ${Math.min(100, Math.round(done / count * 100))}%`; };
                if (mode === 'number') await writeFrameCsv(frames, channels, writable, progress, options);
                else await writeCaptureExport(frames, txFrames, options, writable, progress);
                await writable.close();
                writable = null;
            } else {
                const parts = mode === 'number' ? ['\uFEFF' + exportFrameCsv(frames, channels, options)]
                    : [...captureExportChunks(frames, txFrames, options)];
                const blob = new Blob(parts, { type: extension === 'bin' ? 'application/octet-stream'
                    : extension === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
                const anchor = document.createElement('a');
                anchor.href = URL.createObjectURL(blob);
                anchor.download = filename;
                anchor.click();
                URL.revokeObjectURL(anchor.href);
            }
        } catch (error) {
            if (writable) {
                try { await writable.abort(); } catch (_) { }
            }
            if (error.name !== 'AbortError') alert(`导出失败: ${error.message}`);
        } finally {
            exporting = false;
            exportBtn.textContent = '导出数据';
            syncExportControls();
        }
    });


    /* ─────────────────────────────────────────────────────────
     *  14. 非 RX 帧事件日志（RX 原始帧由 MonitorView 从 FrameBuffer 读取）
     *  颜色由 CSS class 控制：
     *    log-rx-ok    → 蓝色（接收成功）
     *    log-rx-error → 黄色（接收错误）
     *    log-tx-ok    → 绿色（发送成功）
     *    log-tx-error → 红色（发送失败）
     * ───────────────────────────────────────────────────────── */

    /** 追加一条带时间戳的监视台日志行 */
    const appendMonitorLine = (kind, timeStr, reason, bytes) => {
        const order = ++monitorOrder;
        const timestamp = Date.now();
        if (kind === 'tx') txFrames.appendRaw(bytes, timeStr, order, timestamp);
        monitor.appendExtra({ kind,
            time: timeStr, reason, bytes: Uint8Array.from(bytes), order, timestamp });
    };

    const sendController = new SendController({
        mode: sendModeSelect, input: sendInput, fileInput: sendFileInput,
        interval: sendIntervalInput, intervalUnit: sendIntervalUnit,
        button: sendBtn, loadButton: loadFileBtn,
        getEngine: () => activeEngine,
        onSent: bytes => {
            stats.txBytes += bytes.length;
            appendMonitorLine('tx', formatMonitorTime(), '', bytes);
        },
        onInputError: error => appendMonitorLine('tx-error',
            formatMonitorTime(), error.message, new Uint8Array(0)),
        onSendError: (error, bytes) => {
            appendMonitorLine('tx-error', formatMonitorTime(),
                error.message || '发送失败', bytes);
            void disconnectActiveEngine();
        }
    });


    /* ─────────────────────────────────────────────────────────
     *  15. 初始化
     *
     *  加载保存的配置，并在下一帧同步绘图显示设置。
     * ───────────────────────────────────────────────────────── */

    loadConfig();
    requestAnimationFrame(() => {
        syncPlotDisplaySettings();
    });

});  // end DOMContentLoaded

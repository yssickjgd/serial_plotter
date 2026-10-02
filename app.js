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
    const { Limits, FrameBuffer, Plotter, SerialEngine, NetEngine, DataParser,
        MonitorView, MonitorSearch, SendController, ConfigStore, exportFrameCsv, writeFrameCsv,
        collectConfigFromView, applyConfigToView, updatePlotOptionVisibility,
        parseIntInRange, parsePort, validateConfig } = globalThis.SerialPlotter;

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
    const parser = new DataParser();     // 二进制帧解析器
    const frames = new FrameBuffer(1, 1000);
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
    const applyBtn = document.getElementById('btn-apply-format');

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
    const plotChannelStats = document.getElementById('plot-channel-stats');
    const plotFpsLabel = document.getElementById('stat-plot-fps');

    const plotChoiceGroups = [...document.querySelectorAll('[data-plot-choice]')];
    const syncPlotChoices = () => {
        for (const group of plotChoiceGroups) {
            const value = document.getElementById(group.dataset.plotChoice).value;
            group.querySelectorAll('input[type="radio"]').forEach(radio => {
                radio.checked = radio.value === value;
            });
        }
    };
    for (const group of plotChoiceGroups) group.addEventListener('change', event => {
        if (!event.target.checked) return;
        const control = document.getElementById(group.dataset.plotChoice);
        control.value = event.target.value;
        control.dispatchEvent(new Event('change'));
    });

    // 时域/频域独立的 Y 轴范围（字符串值，与 UI 输入框同步）
    let plotYBounds = {
        time:      { min: '-1', max: '1' },
        frequency: { min: '-1', max: '1' }
    };

    // —— 工具栏 ——
    const pauseBtn = document.getElementById('btn-pause');
    const clearBtn = document.getElementById('btn-clear');
    const exportBtn = document.getElementById('btn-export');

    // —— 配置导入导出 ——
    const exportCfgBtn = document.getElementById('btn-export-cfg');
    const importCfgBtn = document.getElementById('btn-import-cfg');
    const cfgFileInput = document.getElementById('cfg-file-input');
    const cfgStatusText = document.getElementById('cfg-save-status');

    // —— 字节流监视台 ——
    const logContent = document.getElementById('data-log');
    const monitor = new MonitorView(logContent, frames);
    let monitorOrder = 0;
    const waveformToggle = document.getElementById('show-waveform');
    const monitorDisplayMode = document.getElementById('monitor-display-mode');
    const monitorSearchMode = document.getElementById('monitor-search-mode');
    const monitorSearchQuery = document.getElementById('monitor-search-query');
    const monitorSearchTolerance = document.getElementById('monitor-search-tolerance');
    const monitorSearchChannel = document.getElementById('monitor-search-channel');
    const monitorSearchStatus = document.getElementById('monitor-search-status');

    const bindVisibleChoice = (fieldId, values) => {
        const field = document.getElementById(fieldId);
        const choices = values.map(value => document.getElementById(`${fieldId}-${value}`));
        const sync = () => choices.forEach((choice, index) => {
            choice.checked = field.value === values[index];
        });
        choices.forEach((choice, index) => choice.addEventListener('change', () => {
            if (!choice.checked) return;
            field.value = values[index];
            field.dispatchEvent(new Event('change'));
        }));
        field.addEventListener('change', sync);
        sync();
        return sync;
    };
    bindVisibleChoice('monitor-display-mode', ['hex', 'ascii', 'number']);
    bindVisibleChoice('monitor-search-mode', ['hex', 'ascii', 'number']);
    bindVisibleChoice('send-mode', ['hex', 'text']);
    const syncSendIntervalUnit = bindVisibleChoice('send-interval-unit', ['ms', 's', 'hz']);

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
    const monitorPanel = document.getElementById('monitor-panel');
    const monitorHeader = document.getElementById('monitor-header');
    const monitorStats = document.getElementById('monitor-stats');
    const byteTools = document.getElementById('byte-tools');
    const byteSearchTools = document.getElementById('byte-search-tools');
    const waveTools = document.getElementById('wave-tools');
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
    const statsBarRow = document.querySelector('.stats-bar-row');
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
        if (capturePaused) {
            // 暂停期间只同步基准值，避免恢复后出现瞬时峰值
            stats._rxLast = stats.rxBytes;
            stats._txLast = stats.txBytes;
            stats._framesLast = parser.frameCount;
            stats._failsLast = parser.failCount;
            return;
        }

        const rxBps = stats.rxBytes - stats._rxLast;
        const txBps = stats.txBytes - stats._txLast;
        const frames = (parser.frameCount - stats._framesLast) / (stats._period / 1000);
        const fails = parser.failCount - stats._failsLast;
        const total = frames + fails;
        const failPct = total > 0 ? ((fails / total) * 100).toFixed(1) : '0.0';

        // 这些值只由计数器生成，不含用户输入。
        statsBarRow.innerHTML = [
            ['RX:', `${formatBytes(rxBps)}/s`],
            ['TX:', `${formatBytes(txBps)}/s`],
            ['帧率:', `${frames} f/s`],
            ['校验失败:', `${failPct}%`]
        ].map(([label, value]) => `<span>${label} ${value}</span>`).join('');

        stats._rxLast = stats.rxBytes;
        stats._txLast = stats.txBytes;
        stats._framesLast = parser.frameCount;
        stats._failsLast = parser.failCount;
        stats.framesPerSec = frames;
        plotter.setSampleRateHz(frames);
    }, stats._period);

    /** 渲染波形统计信息到绘图区标题栏（单通道时显示） */
    const renderPlotStats = (statsData) => {
        if (!statsData) {
            plotChannelStats.replaceChildren();
            return;
        }
        // 主频 = dominantBin / fftSize * 帧率（Hz）
        const freqHz = statsData.freq === null || plotter.sampleRateHz <= 0
            ? '--'
            : fmtFixed(statsData.freq * plotter.sampleRateHz, 6, 15);
        const periodText = statsData.period === null
            ? '--'
            : fmtFixed(statsData.period, 0, 15);

        const segments = [
            ['通道: ', statsData.channelLabel],
            ['最大值: ', fmtFixed(statsData.max, 6, 15)],
            ['最小值: ', fmtFixed(statsData.min, 6, 15)],
            ['峰峰值: ', fmtFixed(statsData.pp, 6, 15)],
            ['均值: ', fmtFixed(statsData.mean, 6, 15)],
            ['标准差: ', fmtFixed(statsData.stdDev, 6, 15)],
            ['主频: ', `${freqHz} Hz`],
            ['主周期: ', `${periodText} sample`]
        ].map(([label, value]) => {
            const span = document.createElement('span');
            span.className = 'plot-info-segment';
            span.textContent = `${label} ${value}`;
            return span;
        });
        plotChannelStats.replaceChildren(...segments);
    };

    plotter.onStatsUpdate = renderPlotStats;
    /* ─────────────────────────────────────────────────────────
     *  5. Tab 切换（通讯 / 帧格式 / 通道）
     * ───────────────────────────────────────────────────────── */

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
        });
    });


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
        applyRightWidth(channelSidebar.offsetWidth);
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
    const mainDisplayVerticalPadding = 16; // 对应 .main-display 的上下各 8px

    const minimumMonitorHeight = () => monitorHeader.offsetHeight + monitorStats.offsetHeight +
        byteTools.offsetHeight + byteSearchTools.offsetHeight + sendPanel.offsetHeight + minLogHeight + 8;
    const minimumCanvasHeight = () => Math.max(60, plotHeader.offsetHeight + 24);
    const verticalUsableHeight = () => Math.max(140, mainDisplay.clientHeight -
        mainDisplayVerticalPadding - vResizer.offsetHeight);

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
        toolsResizeObserver.observe(byteTools);
        toolsResizeObserver.observe(byteSearchTools);
    }

    waveformToggle.addEventListener('change', () => {
        waveformVisible = waveformToggle.checked;
        plotter.isVisible = waveformVisible;
        applyVerticalHeights();
        if (waveformVisible) plotter.resize();
    });

    const bindTimeJump = (prefix, jump) => {
        const mode = document.getElementById(`${prefix}-jump-mode`);
        const absolute = document.getElementById(`${prefix}-jump-absolute`);
        const relative = document.getElementById(`${prefix}-jump-relative`);
        const status = document.getElementById(`${prefix}-jump-status`);
        for (const value of ['absolute', 'relative']) {
            const choice = document.getElementById(`${prefix}-jump-mode-${value}`);
            choice.addEventListener('change', () => {
                if (!choice.checked) return;
                mode.value = value;
                mode.dispatchEvent(new Event('change'));
            });
        }
        mode.addEventListener('change', () => {
            for (const value of ['absolute', 'relative'])
                document.getElementById(`${prefix}-jump-mode-${value}`).checked = mode.value === value;
            absolute.hidden = mode.value !== 'absolute';
            relative.hidden = mode.value !== 'relative';
            if (prefix === 'byte') applyVerticalHeights();
        });
        document.getElementById(`${prefix}-jump-button`).addEventListener('click', () => {
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
            jump(index);
            status.textContent = `已定位第 ${index + 1} 帧，共 ${frames.length} 帧`;
        });
    };
    bindTimeJump('wave', index => {
        if (plotViewMode.value !== 'time') {
            plotViewMode.value = 'time';
            plotViewMode.dispatchEvent(new Event('change'));
        }
        if (!waveformVisible) {
            waveformToggle.checked = true;
            waveformToggle.dispatchEvent(new Event('change'));
        }
        plotter.jumpToFrame(index);
    });
    bindTimeJump('byte', index => monitor.jumpToFrame(index));

    const defaultJumpDateTime = () => {
        const latestTimestamp = frames.timestampAt(frames.length - 1);
        const hasFrameTime = Number.isFinite(latestTimestamp);
        const date = hasFrameTime ? new Date(latestTimestamp) : new Date();
        const pad = (value, width = 2) => String(value).padStart(width, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
            `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
            pad(hasFrameTime ? Math.floor(date.getMilliseconds() / 10) * 10
                : Math.max(10, Math.floor(date.getMilliseconds() / 10) * 10), 3);
    };
    const toolPanels = [waveTools, byteTools, byteSearchTools];
    const toolControlIds = [
        ...['wave', 'byte'].flatMap(prefix => [
            `${prefix}-jump-mode-absolute`, `${prefix}-jump-mode-relative`,
            `${prefix}-jump-absolute`, `${prefix}-jump-relative`, `${prefix}-jump-button`
        ]),
        ...['hex', 'ascii', 'number'].map(mode => `monitor-search-mode-${mode}`),
        'monitor-search-query', 'monitor-search-tolerance', 'monitor-search-channel',
        'monitor-search-button', 'monitor-search-prev', 'monitor-search-next',
        'monitor-search-nearest'
    ];
    const syncTimeTools = () => {
        for (const tools of toolPanels)
            tools.classList[capturePaused ? 'remove' : 'add']('tools-disabled');
        for (const id of toolControlIds)
            document.getElementById(id).disabled = !capturePaused;
        if (capturePaused) {
            const value = defaultJumpDateTime();
            document.getElementById('wave-jump-absolute').value = value;
            document.getElementById('byte-jump-absolute').value = value;
        }
    };
    syncTimeTools();

    const populateSearchChannels = () => {
        const selected = monitorSearchChannel.value;
        monitorSearchChannel.replaceChildren();
        for (let channel = -1; channel < frames.channelCount; channel++) {
            const option = document.createElement('option');
            option.value = String(channel);
            option.textContent = channel < 0 ? '全部通道' : `CH${channel + 1}`;
            monitorSearchChannel.appendChild(option);
        }
        monitorSearchChannel.value = selected !== '' && Number(selected) < frames.channelCount
            ? selected : '-1';
    };
    populateSearchChannels();
    monitorDisplayMode.addEventListener('change', () => monitor.setMode(monitorDisplayMode.value));
    monitorSearchMode.addEventListener('change', () => {
        const numeric = monitorSearchMode.value === 'number';
        monitorSearchTolerance.hidden = !numeric;
        monitorSearchChannel.hidden = !numeric;
        monitorSearchQuery.placeholder = numeric ? '目标数值' :
            monitorSearchMode.value === 'ascii' ? 'ASCII 文本' : '十六进制字节';
        if (numeric) populateSearchChannels();
        applyVerticalHeights();
    });

    let searchSession = null;
    let searchGeneration = 0;
    let searchMatches = [];
    let selectedMatch = -1;
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
        monitor.jumpToFrame(frame);
        monitorSearchStatus.textContent = `${selectedMatch + 1} / ${searchMatches.length}`;
    };
    document.getElementById('monitor-search-button').addEventListener('click', () => {
        if (!capturePaused) return;
        try {
            const options = MonitorSearch.parseMonitorSearch(monitorSearchMode.value,
                monitorSearchQuery.value, monitorSearchTolerance.value,
                Number(monitorSearchChannel.value));
            searchSession = new MonitorSearch.MonitorSearchSession(frames, options);
            searchMatches = [];
            selectedMatch = -1;
            monitor.setSearchResults([]);
            monitorDisplayMode.value = options.kind;
            monitorDisplayMode.dispatchEvent(new Event('change'));
            const generation = ++searchGeneration;
            const scan = () => {
                if (generation !== searchGeneration || !capturePaused) return;
                try {
                    let done = false;
                    for (let batch = 0; batch < 8 && !done; batch++) done = searchSession.step(512);
                    if (done) {
                        searchMatches = searchSession.matches;
                        monitor.setSearchResults(searchMatches);
                        monitorSearchStatus.textContent = `找到 ${searchMatches.length} 处匹配`;
                    } else {
                        monitorSearchStatus.textContent = `搜索中 ${searchSession.position} / ${searchSession.length}`;
                        setTimeout(scan, 0);
                    }
                } catch (error) { monitorSearchStatus.textContent = error.message; }
            };
            scan();
        } catch (error) { monitorSearchStatus.textContent = error.message; }
    });
    document.getElementById('monitor-search-prev').addEventListener('click', () =>
        showSearchMatch(selectedMatch < 0 ? searchMatches.length - 1 : selectedMatch - 1));
    document.getElementById('monitor-search-next').addEventListener('click', () =>
        showSearchMatch(selectedMatch + 1));
    document.getElementById('monitor-search-nearest').addEventListener('click', () => {
        const order = monitor.cursorOrder ?? monitor.anchor?.order ?? frames.orderAt(frames.length - 1);
        let low = 0, high = searchMatches.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (searchMatches[mid].startOrder < order) low = mid + 1;
            else high = mid;
        }
        const index = low === 0 ? 0 : low >= searchMatches.length ? searchMatches.length - 1
            : order - searchMatches[low - 1].startOrder <= searchMatches[low].startOrder - order
                ? low - 1 : low;
        showSearchMatch(index);
    });

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

    /** 切换帧头/帧尾配置区的启用状态（禁用时半透明 + 不可交互） */
    const toggleConfigSection = (checkbox, container) => {
        container.style.opacity = checkbox.checked ? '1' : '0.4';
        container.style.pointerEvents = checkbox.checked ? '' : 'none';
    };

    headerChk.addEventListener('change', () => { toggleConfigSection(headerChk, headerConfigDiv); saveConfig(); });
    footerChk.addEventListener('change', () => { toggleConfigSection(footerChk, footerConfigDiv); saveConfig(); });

    // 初始化时根据 checkbox 状态设置样式
    toggleConfigSection(headerChk, headerConfigDiv);
    toggleConfigSection(footerChk, footerConfigDiv);

    /** 将当前 UI 上的帧格式配置同步给 parser 和 plotter */
    const updateParserSettings = () => {
        const ch = parseIntInRange(channelsInput.value, Limits.minChannels, Limits.maxChannels, '通道数');
        const maxPoints = parseIntInRange(maxPointsInput.value, Limits.minPoints, Limits.maxPoints, '采样点数');
        const plotWindowPoints = parseIntInRange(plotWindowPointsInput.value,
            Limits.minPoints, Limits.maxPlotWindowPoints, '波形监视台内采样点数');
        parser.setFormat({
            enableHeader: headerChk.checked,
            headerHex: headerInput.value,
            enableFooter: footerChk.checked,
            footerHex: footerInput.value,
            dataType: dataTypeSelect.value,
            isLittleEndian: endiannessSelect.value === 'little',
            channelsCount: ch,
            enableChecksum: checksumChk.checked
        });
        plotter.setChannelCount(ch);
        populateSearchChannels();
        plotter.setMaxPoints(maxPoints);
        plotter.setPlotWindowPoints(Math.min(plotWindowPoints, maxPoints));
        plotWindowPointsInput.value = String(plotter.plotWindowPoints);
        plotWindowPointsInput.max = String(Math.min(maxPoints, Limits.maxPlotWindowPoints));
        rebuildChannelList();
        syncPlotDisplaySettings();
    };

    maxPointsInput.addEventListener('change', () => {
        try {
            plotter.setMaxPoints(parseIntInRange(maxPointsInput.value, Limits.minPoints, Limits.maxPoints, '采样点数'));
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

    applyBtn.addEventListener('click', () => {
        try { updateParserSettings(); }
        catch (error) { alert(error.message); return; }
        saveConfig();
        // 短暂反馈，让用户知道配置已生效
        applyBtn.textContent = '✓ 已应用';
        setTimeout(() => { applyBtn.textContent = '应用帧格式配置'; }, 1200);
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
    const syncPlotDisplaySettings = () => {
        plotter.setDisplayOptions({
            displayMode: plotViewMode.value,
            yScaleMode: plotYScaleMode.value,
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
            p.textContent = '请先在帧格式页设置通道数并点击应用。';
            channelListDiv.appendChild(p);
            return;
        }

        metas.forEach(meta => {
            const row = document.createElement('div');
            row.className = 'channel-row';

            // CH 按钮展开该通道的放大与偏移设置。
            const channelToggle = document.createElement('button');
            channelToggle.type = 'button';
            channelToggle.className = 'channel-row-label channel-expand-toggle';
            channelToggle.textContent = `CH${meta.index + 1}`;
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
            nameInput.placeholder = `CH${meta.index + 1}`;
            nameInput.addEventListener('change', () => {
                plotter.setChannelName(meta.index, nameInput.value || `CH${meta.index + 1}`);
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
                input.ariaLabel = `CH${meta.index + 1} ${text}`;
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
        syncPlotDisplaySettings(); saveConfig();
        updatePlotOptionVisibility(configElements);
        syncPlotChoices();
    });

    // 其他绘图选项变化时同步
    [plotYScaleMode, plotFftRemoveDc, plotTimeXUnit,
        plotFreqXUnit, plotFreqXScale, plotFreqYScale, plotFftWindow]
        .filter(Boolean)
        .forEach(el => el.addEventListener('change', () => {
            syncPlotDisplaySettings();
            updatePlotOptionVisibility(configElements);
            syncPlotChoices();
            saveConfig();
        }));

    // Y 轴范围变化时更新当前模式的 bounds 再同步
    [plotYMin, plotYMax]
        .filter(Boolean)
        .forEach(el => el.addEventListener('change', () => { updateYBounds(); syncPlotDisplaySettings(); saveConfig(); }));

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
        enableChecksum: checksumChk, dataType: dataTypeSelect,
        endianness: endiannessSelect, channelsCount: channelsInput,
        maxPoints: maxPointsInput, plotWindowPoints: plotWindowPointsInput, sendIntervalUnit,
        plotViewMode, plotYScaleMode, plotFftRemoveDc,
        plotTimeXUnit, plotFreqXUnit, plotFreqXScale, plotFreqYScale, plotFftWindow,
        plotYMin, plotYMax, wrapFftRemoveDc, wrapPlotTimeAxis, wrapPlotFreqAxis,
        wrapPlotYBounds
    };

    /** 从当前 UI 状态收集完整配置对象 */
    const getConfig = () => collectConfigFromView(configElements,
        plotYBounds, plotter.getChannelMeta());

    /** 将配置对象应用到 UI，并同步到 parser / plotter */
    const applyConfig = (cfg) => {
        if (!cfg) return;
        validateConfig({ ...getConfig(), ...cfg });
        applyConfigToView(cfg, {
            elements: configElements, bounds: plotYBounds, updateConnectionModeUI,
            updateFrameFormat: () => {
                toggleConfigSection(headerChk, headerConfigDiv);
                toggleConfigSection(footerChk, footerConfigDiv);
                updateParserSettings();
            },
            updateChannels: channels => {
                if (!channels) return;
                plotter.setChannelSettings(channels);
                rebuildChannelList();
            },
            updatePlot: syncPlotDisplaySettings, syncPlotChoices
        });
        syncSendIntervalUnit();
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
    [checksumChk, dataTypeSelect, endiannessSelect, channelsInput,
        headerInput, footerInput, sendIntervalUnit]
        .filter(Boolean)
        .forEach(el => el.addEventListener('change', saveConfig));


    /* ─────────────────────────────────────────────────────────
     *  11. 数据路由 & 解析器回调
     *
     *  数据流：串口/网络 → parser.appendData()
     *         parser 回调 → plotter.addFrame() + 监视台日志
     * ───────────────────────────────────────────────────────── */

    // 所有数据源统一送入 parser
    const globalDataHandler = data => {
        if (capturePaused) return;
        try { parser.appendData(data); }
        catch (error) { setCapturePaused(true); }
    };
    serialAdapter.onData(globalDataHandler);
    netAdapter.onData(globalDataHandler);

    // 原始数据到达 → 更新 RX 字节统计
    parser.onRawData = (bytes) => {
        stats.rxBytes += bytes.length;
    };

    // 成功解析一帧 → 更新波形 + 记录日志
    parser.onFrameParsed = (valuesArr, timeStr, frameBytes, timestamp) => {
        plotter.addFrame(valuesArr, frameBytes, timeStr, ++monitorOrder, timestamp);
        monitor.appendFrame();
    };

    // 帧校验失败 → 记录错误日志
    const frameErrorLabels = {
        checksum: '校验失败', footer: '帧尾不匹配', incomplete: '帧未完整'
    };
    parser.onFrameError = (type, timeStr, frameBytes) => {
        const label = frameErrorLabels[type] || '解析错误';
        monitor.appendExtra({ kind: 'error', time: timeStr, reason: label,
            bytes: frameBytes, order: ++monitorOrder });
    };

    parser.onCallbackError = error => {
        console.error('采集数据处理失败:', error);
        statusText.textContent = `采集已暂停: ${error.message}`;
    };


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
            parser.flushPending();
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
            monitor.setSearchResults([]);
            monitorSearchStatus.textContent = '';
        }
        syncTimeTools();
        if (paused) { parser.flushPending(); monitor.render(); plotter.draw(); }
        pauseBtn.textContent = paused ? '恢复捕获队列' : '暂停捕捉';
        pauseBtn.className = paused ? 'btn btn-success' : 'btn btn-secondary';
    };
    pauseBtn.addEventListener('click', () => setCapturePaused(!capturePaused));

    clearBtn.addEventListener('click', () => {
        searchGeneration++;
        searchSession = null;
        searchMatches = [];
        selectedMatch = -1;
        monitorSearchStatus.textContent = '';
        plotter.clear();
        monitor.clear();
        parser.reset();
        parser.frameCount = 0;
        parser.failCount = 0;
        stats.rxBytes = 0;
        stats.txBytes = 0;
        stats._rxLast = 0;
        stats._txLast = 0;
        stats._framesLast = 0;
        stats._failsLast = 0;
        stats.framesPerSec = 0;
    });

    exportBtn.addEventListener('click', async () => {
        if (!frames.length) { alert('目前无有效数据可导出。'); return; }
        const channels = plotter.getChannelMeta();
        const filename = `Scientific_Plot_Export_${Date.now()}.csv`;
        if (frames.length > 50000) {
            if (typeof window.showSaveFilePicker !== 'function') {
                alert('大容量 CSV 导出需要支持文件系统保存的 Chrome 或 Edge。');
                return;
            }
            let writable;
            try {
                const handle = await window.showSaveFilePicker({ suggestedName: filename,
                    types: [{ description: 'CSV 文件', accept: { 'text/csv': ['.csv'] } }] });
                writable = await handle.createWritable();
                exportBtn.disabled = true;
                await writeFrameCsv(frames, channels, writable, (done, total) => {
                    exportBtn.textContent = `正在导出 ${Math.round(done / total * 100)}%`;
                });
                await writable.close();
                writable = null;
            } catch (error) {
                if (writable) await writable.abort();
                if (error.name !== 'AbortError') alert(`导出失败: ${error.message}`);
            } finally {
                exportBtn.disabled = false;
                exportBtn.textContent = '导出全部通道至 CSV';
            }
            return;
        }
        const csv = exportFrameCsv(frames, channels);
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
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
        monitor.appendExtra({ kind,
            time: timeStr, reason, bytes: Uint8Array.from(bytes), order: ++monitorOrder });
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

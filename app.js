/* ═══════════════════════════════════════════════════════════════
 *  app.js — 应用主控制器
 *
 *  职责：将各独立模块（SerialEngine、NetEngine、DataParser、Plotter）
 *        组装为完整应用，处理所有 UI 事件与业务逻辑。
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
 *   10. 配置持久化（localStorage + JSON 文件导入导出）
 *   11. 数据路由 & 解析器回调
 *   12. 连接管理（串口 / 网络）
 *   13. 工具栏（暂停、清空、导出 CSV）
 *   14. 发送面板（Hex/Text、定时发送、文件载入）
 *   15. 字节流日志
 *   16. 初始化
 * ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

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

    /** 将 Hex 字符串中的字节数统计出来（去掉空格后每 2 字符 = 1 字节） */
    const countHexBytes = (hexStr) => hexStr ? hexStr.replace(/\s/g, '').length / 2 : 0;

    /** Hex 字符串 → Uint8Array */
    const hexToBytes = (str) => {
        const clean = str.replace(/[^0-9A-Fa-f]/g, '');
        const bytes = [];
        for (let i = 0; i + 1 < clean.length; i += 2)
            bytes.push(parseInt(clean.substr(i, 2), 16));
        return new Uint8Array(bytes);
    };

    /** Uint8Array → Hex 字符串（大写，空格分隔） */
    const bytesToHex = (arr) =>
        Array.from(arr).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

    /** 文本字符串 → Uint8Array（UTF-8 编码） */
    const textToBytes = (str) => new TextEncoder().encode(str);

    /** Uint8Array → 文本字符串（Latin1 解码，保持原始字节映射） */
    const bytesToText = (arr) => new TextDecoder('latin1').decode(arr);

    /** 安全地设置 DOM 元素的 value，元素不存在或值为 undefined 时跳过 */
    const setDomValue = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined) el.value = val;
    };


    /* ─────────────────────────────────────────────────────────
     *  2. 模块实例化 & 全局状态
     * ───────────────────────────────────────────────────────── */

    const serialAdapter = new SerialEngine();   // 串口通信适配器
    const netAdapter = new NetEngine();      // 网络通信适配器（通过 bridge.js）
    const parser = new DataParser();     // 二进制帧解析器
    const plotter = new Plotter('waveform-canvas');  // 波形绘图引擎

    let activeEngine = null;    // 当前激活的通信引擎（serialAdapter 或 netAdapter）
    let sendTimer = null;    // 定时发送的 interval ID
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
    const applyBtn = document.getElementById('btn-apply-format');

    // —— 通道 Tab ——
    const channelListDiv = document.getElementById('channel-config-list');
    const channelsAllOnBtn = document.getElementById('btn-channels-all-on');
    const channelsAllOffBtn = document.getElementById('btn-channels-all-off');
    const plotViewMode = document.getElementById('plot-view-mode');
    const plotYScaleMode = document.getElementById('plot-y-scale-mode');
    const plotFftRemoveDc = document.getElementById('plot-fft-remove-dc');
    const plotYMin = document.getElementById('plot-y-min');
    const plotYMax = document.getElementById('plot-y-max');
    const plotInfoRow = document.getElementById('plot-info-row');

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
    const canvasWrapper = document.getElementById('canvas-wrapper');
    const vResizer = document.getElementById('v-resizer');
    const monitorPanel = document.getElementById('monitor-panel');


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

    /* 定时刷新字节流监视台统计面板
     * 采用与波形监视台 renderPlotStats 相同的 innerHTML + fmtFixed 模式，
     * 确保两个监视台的数值显示风格一致（等宽字体、右对齐）。 */
    const statsBarRow = document.querySelector('.stats-bar-row');

    setInterval(() => {
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

        // 使用 innerHTML 统一渲染，与波形监视台的 renderPlotStats 保持一致
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
    }, stats._period);

    /** 渲染波形统计信息到绘图区标题栏（单通道时显示） */
    const renderPlotStats = (statsData) => {
        if (!statsData) {
            plotInfoRow.innerHTML = '&nbsp;';
            return;
        }
        // 主频 = dominantBin / fftSize * 帧率（Hz）
        const freqHz = statsData.freq === null
            ? '--'
            : fmtFixed(statsData.freq * stats.framesPerSec, 6, 15);
        const periodText = statsData.period === null
            ? '--'
            : fmtFixed(statsData.period, 0, 15);

        plotInfoRow.innerHTML = [
            ['通道: ', statsData.channelLabel],
            ['最大值: ', fmtFixed(statsData.max, 6, 15)],
            ['最小值: ', fmtFixed(statsData.min, 6, 15)],
            ['峰峰值: ', fmtFixed(statsData.pp, 6, 15)],
            ['均值: ', fmtFixed(statsData.mean, 6, 15)],
            ['标准差: ', fmtFixed(statsData.stdDev, 6, 15)],
            ['主频: ', `${freqHz} Hz`],
            ['主周期: ', `${periodText} sample`]
        ].map(([label, value]) => `<span class="plot-info-segment">${label} ${value}</span>`).join('');
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

    // —— 水平分隔条（侧栏 ↔ 主区域）——
    let hDragging = false, hStartX = 0, hStartW = 0;

    /** 应用侧栏宽度并触发波形重绘，与 applyVerticalHeights 对应 */
    const applySidebarWidth = (newW) => {
        const w = Math.max(180, Math.min(500, newW));
        sidebar.style.width = sidebar.style.minWidth = sidebar.style.maxWidth = w + 'px';
        plotter.resize();
    };

    /* 窗口缩小时约束侧栏宽度不超出可用空间 */
    window.addEventListener('resize', () => {
        const maxW = mainDisplay.clientWidth - 100;
        if (sidebar.offsetWidth > maxW) applySidebarWidth(maxW);
    });

    hResizer.addEventListener('mousedown', (e) => {
        hDragging = true;
        hStartX = e.clientX;
        hStartW = sidebar.offsetWidth;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!hDragging) return;
        applySidebarWidth(hStartW + (e.clientX - hStartX));
    });

    document.addEventListener('mouseup', () => {
        if (!hDragging) return;
        hDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });

    // —— 垂直分隔条（波形区 ↔ 监视台）——
    let vDragging = false, vStartY = 0, vStartH = 0;
    let canvasH = null;  // null 表示首次使用默认比例（62%）

    /** 根据 canvasH 重新分配波形区和监视台的高度，与 applySidebarWidth 对应 */
    const applyVerticalHeights = () => {
        const totalH = mainDisplay.clientHeight;
        const vH = vResizer.offsetHeight;
        if (canvasH === null) canvasH = Math.round((totalH - vH) * 0.62);
        const monH = Math.max(80, totalH - vH - canvasH);
        canvasWrapper.style.flex = 'none';
        canvasWrapper.style.height = canvasH + 'px';
        monitorPanel.style.flex = 'none';
        monitorPanel.style.height = monH + 'px';
        plotter.resize();
    };

    applyVerticalHeights();
    window.addEventListener('resize', applyVerticalHeights);

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
        const totalH = mainDisplay.clientHeight;
        const vH = vResizer.offsetHeight;
        canvasH = Math.max(60, Math.min(totalH - vH - 80, vStartH + (e.clientY - vStartY)));
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

    connTypeSelect.addEventListener('change', () => {
        const v = connTypeSelect.value;
        serialConfigDiv.style.display = v === 'serial' ? '' : 'none';
        netConfigDiv.style.display = v !== 'serial' ? '' : 'none';
        // UDP 和 TCP Server 需要额外配置本地端口
        localPortWrap.style.display = (v === 'udp' || v === 'tcp-server') ? 'flex' : 'none';
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
        const ch = parseInt(channelsInput.value) || 1;
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
        plotter.setMaxPoints(parseInt(maxPointsInput.value) || 1000);
        rebuildChannelList();
        syncPlotDisplaySettings();
    };

    maxPointsInput.addEventListener('change', () => {
        plotter.setMaxPoints(parseInt(maxPointsInput.value) || 1000);
        saveConfig();
    });

    applyBtn.addEventListener('click', () => {
        updateParserSettings();
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

    /** 将绘图显示选项同步给 plotter（时域/频域、Y 轴策略等） */
    const syncPlotDisplaySettings = () => {
        plotter.setDisplayOptions({
            displayMode: plotViewMode.value,
            yScaleMode: plotYScaleMode.value,
            removeDcForFft: plotFftRemoveDc.checked,
            yMin: plotYMin.value,
            yMax: plotYMax.value
        });
        if (!plotInfoRow.innerHTML) plotInfoRow.innerHTML = '&nbsp;';
    };

    /** 重建通道配置列表 UI（在通道数变化或应用帧格式时调用） */
    const rebuildChannelList = () => {
        channelListDiv.innerHTML = '';
        const metas = plotter.getChannelMeta();

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

            // 通道标签（CH1, CH2, ...）
            const label = document.createElement('span');
            label.className = 'channel-row-label';
            label.textContent = `CH${meta.index + 1}`;

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
                label.style.opacity = visChk.checked ? '1' : '0.4';
                saveConfig();
                syncPlotDisplaySettings();
            });

            row.append(label, colorInput, nameInput, visChk);
            channelListDiv.appendChild(row);
        });
    };

    // 绘图显示选项变化时同步
    [plotViewMode, plotYScaleMode, plotFftRemoveDc, plotYMin, plotYMax]
        .filter(Boolean)
        .forEach(el => el.addEventListener('change', () => { syncPlotDisplaySettings(); saveConfig(); }));

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

    /** 从当前 UI 状态收集完整配置对象 */
    const getConfig = () => ({
        connType: connTypeSelect.value,
        serialBaud: document.getElementById('serial-baud').value,
        serialData: document.getElementById('serial-data').value,
        serialStop: document.getElementById('serial-stop').value,
        serialParity: document.getElementById('serial-parity').value,
        netHost: document.getElementById('net-host').value,
        netPort: document.getElementById('net-port').value,
        netLocalPort: document.getElementById('net-local').value,
        enableHeader: headerChk.checked,
        headerHex: headerInput.value,
        enableFooter: footerChk.checked,
        footerHex: footerInput.value,
        enableChecksum: checksumChk.checked,
        dataType: dataTypeSelect.value,
        endianness: endiannessSelect.value,
        channelsCount: channelsInput.value,
        maxPoints: maxPointsInput.value,
        sendIntervalUnit: sendIntervalUnit.value,
        plotViewMode: plotViewMode.value,
        plotYScaleMode: plotYScaleMode.value,
        plotFftRemoveDc: plotFftRemoveDc.checked,
        plotYMin: plotYMin.value,
        plotYMax: plotYMax.value,
        channels: plotter.getChannelMeta().map(m => ({
            name: m.name, color: m.color, visible: m.visible
        }))
    });

    /** 将配置对象应用到 UI，并同步到 parser / plotter */
    const applyConfig = (cfg) => {
        if (!cfg) return;

        // 连接参数
        connTypeSelect.value = cfg.connType || 'serial';
        connTypeSelect.dispatchEvent(new Event('change'));
        setDomValue('serial-baud', cfg.serialBaud);
        setDomValue('serial-data', cfg.serialData);
        setDomValue('serial-stop', cfg.serialStop);
        setDomValue('serial-parity', cfg.serialParity);
        setDomValue('net-host', cfg.netHost);
        setDomValue('net-port', cfg.netPort);
        setDomValue('net-local', cfg.netLocalPort);

        // 帧格式参数
        if (cfg.enableHeader !== undefined) headerChk.checked = cfg.enableHeader;
        if (cfg.enableFooter !== undefined) footerChk.checked = cfg.enableFooter;
        if (cfg.enableChecksum !== undefined) checksumChk.checked = cfg.enableChecksum;
        if (cfg.headerHex) headerInput.value = cfg.headerHex;
        if (cfg.footerHex) footerInput.value = cfg.footerHex;
        if (cfg.dataType) dataTypeSelect.value = cfg.dataType;
        if (cfg.endianness) endiannessSelect.value = cfg.endianness;
        if (cfg.channelsCount) channelsInput.value = cfg.channelsCount;
        if (cfg.maxPoints) maxPointsInput.value = cfg.maxPoints;

        // 发送 & 绘图选项
        if (cfg.sendIntervalUnit) sendIntervalUnit.value = cfg.sendIntervalUnit;
        if (cfg.plotViewMode) plotViewMode.value = cfg.plotViewMode;
        if (cfg.plotYScaleMode) plotYScaleMode.value = cfg.plotYScaleMode;
        if (cfg.plotFftRemoveDc !== undefined) plotFftRemoveDc.checked = cfg.plotFftRemoveDc;
        if (cfg.plotYMin !== undefined) plotYMin.value = cfg.plotYMin;
        if (cfg.plotYMax !== undefined) plotYMax.value = cfg.plotYMax;

        // 同步帧格式到 parser & plotter
        toggleConfigSection(headerChk, headerConfigDiv);
        toggleConfigSection(footerChk, footerConfigDiv);
        updateParserSettings();

        // 恢复每个通道的自定义设置（名称、颜色、可见性）
        if (cfg.channels) {
            cfg.channels.forEach((ch, i) => {
                plotter.setChannelColor(i, ch.color);
                plotter.setChannelVisible(i, ch.visible !== false);
                plotter.setChannelName(i, ch.name || `CH${i + 1}`);
            });
            rebuildChannelList();
        }
        syncPlotDisplaySettings();
    };

    /** 保存当前配置到 localStorage */
    const saveConfig = () => {
        try {
            localStorage.setItem(CONFIG_KEY, JSON.stringify(getConfig()));
            cfgStatusText.textContent = '配置已自动保存。';
        } catch (e) {
            cfgStatusText.textContent = '保存失败: ' + e.message;
        }
    };

    /** 从 localStorage 加载配置；无配置时使用默认值初始化 parser */
    const loadConfig = () => {
        try {
            const raw = localStorage.getItem(CONFIG_KEY);
            if (raw) {
                applyConfig(JSON.parse(raw));
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

    // 任意配置字段变化时自动保存
    [checksumChk, dataTypeSelect, endiannessSelect, channelsInput,
        headerInput, footerInput, sendIntervalUnit,
        plotViewMode, plotYScaleMode, plotFftRemoveDc, plotYMin, plotYMax]
        .filter(Boolean)
        .forEach(el => el.addEventListener('change', saveConfig));


    /* ─────────────────────────────────────────────────────────
     *  11. 数据路由 & 解析器回调
     *
     *  数据流：串口/网络 → parser.appendData()
     *         parser 回调 → plotter.addFrame() + 监视台日志
     * ───────────────────────────────────────────────────────── */

    // 所有数据源统一送入 parser
    const globalDataHandler = (data) => parser.appendData(data);
    serialAdapter.onData(globalDataHandler);
    netAdapter.onData(globalDataHandler);

    // 原始数据到达 → 更新 RX 字节统计
    parser.onRawData = (hexStr, timeStr) => {
        if (capturePaused) return;
        stats.rxBytes += countHexBytes(hexStr);
    };

    // 成功解析一帧 → 更新波形 + 记录日志
    parser.onFrameParsed = (valuesArr, timeStr, hexStr) => {
        if (capturePaused) return;
        plotter.addFrame(valuesArr);
        appendMonitorLine('log-rx-ok', 'RX', timeStr, '', hexStr);
    };

    // 帧校验失败 → 记录错误日志
    parser.onFrameError = (type, timeStr, hexStr) => {
        if (capturePaused) return;
        const label = type === 'checksum' ? '校验失败'
            : type === 'footer' ? '帧尾不匹配'
                : '解析错误';
        appendMonitorLine('log-rx-error', 'RX', timeStr, label, hexStr);
    };


    /* ─────────────────────────────────────────────────────────
     *  12. 连接管理
     *
     *  统一处理串口 / 网络的连接状态变化，
     *  更新 UI 指示器和按钮样式。
     * ───────────────────────────────────────────────────────── */

    /** 连接状态变化回调（串口和网络共用） */
    const onConnectionStatusChange = (connected) => {
        if (connected) {
            connectBtn.textContent = '主动断开连接';
            connectBtn.classList.replace('btn-primary', 'btn-danger');
            statusIndicator.className = 'status-dot connected';
            connTypeSelect.disabled = true;
        } else {
            stopSendTimer();
            connectBtn.textContent = '请求建立连接';
            connectBtn.classList.replace('btn-danger', 'btn-primary');
            statusIndicator.className = 'status-dot disconnected';
            statusText.textContent = '设备处于离线断开状态。';
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
        // 已连接 → 断开
        if (activeEngine) {
            await disconnectActiveEngine();
            return;
        }

        // 未连接 → 根据模式建立连接
        const mode = connTypeSelect.value;
        statusText.textContent = '正在处理连接要求...';

        try {
            if (mode === 'serial') {
                const config = {
                    baudRate: parseInt(document.getElementById('serial-baud').value),
                    dataBits: parseInt(document.getElementById('serial-data').value),
                    stopBits: parseInt(document.getElementById('serial-stop').value),
                    parity: document.getElementById('serial-parity').value
                };
                statusText.textContent = '请于弹出框选择对应的串口通道...';
                await serialAdapter.connect(config);
                activeEngine = serialAdapter;
                statusText.textContent = `串口就位: ${config.baudRate} bps`;
            } else {
                const config = {
                    mode,
                    host: document.getElementById('net-host').value,
                    port: parseInt(document.getElementById('net-port').value),
                    localPort: parseInt(document.getElementById('net-local').value)
                        || parseInt(document.getElementById('net-port').value)
                };
                await netAdapter.connect(config);
                activeEngine = netAdapter;
                statusText.textContent = 'TCP/UDP Bridge 已连通。';
            }
        } catch (e) {
            console.error('连接调度中断', e);
            statusText.textContent = `连接失败: ${e.message}`;
            activeEngine = null;
        }
    });


    /* ─────────────────────────────────────────────────────────
     *  13. 工具栏（暂停、清空、导出 CSV）
     * ───────────────────────────────────────────────────────── */

    pauseBtn.addEventListener('click', () => {
        const paused = plotter.togglePause();
        capturePaused = paused;
        pauseBtn.textContent = paused ? '恢复捕获队列' : '暂停捕捉';
        pauseBtn.className = paused ? 'btn btn-success' : 'btn btn-secondary';
    });

    clearBtn.addEventListener('click', () => {
        plotter.clear();
        logContent.innerHTML = '';
        parser.buffer = new Uint8Array(0);
        parser.frameCount = 0;
        parser.failCount = 0;
        stats.rxBytes = 0;
        stats.txBytes = 0;
        stats._rxLast = 0;
        stats._txLast = 0;
        stats._framesLast = 0;
        stats._failsLast = 0;
    });

    exportBtn.addEventListener('click', () => {
        const csv = plotter.exportCSV();
        if (!csv) { alert('目前无有效数据可导出。'); return; }
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Scientific_Plot_Export_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    });


    /* ─────────────────────────────────────────────────────────
     *  14. 发送面板
     *
     *  支持 Hex / Text 两种模式，可切换（自动转换内容）。
     *  支持定时发送（间隔单位：ms / s / Hz）。
     *  支持从文件载入待发送数据。
     * ───────────────────────────────────────────────────────── */

    /** 停止定时发送并恢复按钮样式 */
    const stopSendTimer = () => {
        if (sendTimer) {
            clearInterval(sendTimer);
            sendTimer = null;
        }
        sendBtn.textContent = '发送';
        sendBtn.className = 'btn btn-primary';
    };

    /** 根据间隔设置计算发送周期（ms），返回 0 表示单次发送 */
    const getSendPeriodMs = () => {
        const value = parseFloat(sendIntervalInput.value);
        if (!Number.isFinite(value) || value <= 0) return 0;
        switch (sendIntervalUnit.value) {
            case 's': return value * 1000;
            case 'hz': return value > 0 ? 1000 / value : 0;
            default: return value;  // ms
        }
    };

    /** 执行一次数据发送 */
    const doSend = async () => {
        if (!activeEngine) {
            stopSendTimer();
            return;
        }
        try {
            const mode = sendModeSelect.value;
            const bytes = mode === 'hex' ? hexToBytes(sendInput.value) : textToBytes(sendInput.value);
            if (bytes.length === 0) return;
            await activeEngine.send(bytes);
            stats.txBytes += bytes.length;
            appendMonitorLine('log-tx-ok', 'TX', formatMonitorTime(), '', bytesToHex(bytes));
        } catch (e) {
            const mode = sendModeSelect.value;
            const bytes = mode === 'hex' ? hexToBytes(sendInput.value) : textToBytes(sendInput.value);
            const reason = e && e.message ? e.message : '发送失败';
            appendMonitorLine('log-tx-error', 'TX', formatMonitorTime(), reason, bytesToHex(bytes));
            stopSendTimer();
            void disconnectActiveEngine();
        }
    };

    // Hex ↔ Text 模式切换时自动转换输入框内容
    sendModeSelect.addEventListener('change', () => {
        try {
            if (sendModeSelect.value === 'hex') {
                sendInput.value = bytesToHex(textToBytes(sendInput.value));
            } else {
                sendInput.value = bytesToText(hexToBytes(sendInput.value));
            }
        } catch (e) { /* 转换失败时保持原内容不变 */ }
    });

    // 发送按钮：有定时间隔时切换为"停止"，否则单次发送
    sendBtn.addEventListener('click', () => {
        const interval = getSendPeriodMs();
        // 已在定时发送 → 停止
        if (sendTimer) {
            stopSendTimer();
            return;
        }
        if (interval > 0) {
            // 定时发送模式
            doSend();
            sendTimer = setInterval(doSend, interval);
            sendBtn.textContent = '停止';
            sendBtn.className = 'btn btn-danger';
        } else {
            // 单次发送
            doSend();
        }
    });

    // 从文件载入待发送数据
    loadFileBtn.addEventListener('click', () => sendFileInput.click());
    sendFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const bytes = new Uint8Array(ev.target.result);
            sendInput.value = sendModeSelect.value === 'hex' ? bytesToHex(bytes) : bytesToText(bytes);
        };
        reader.readAsArrayBuffer(file);
        e.target.value = '';  // 清空 input 以便重复选择同一文件
    });


    /* ─────────────────────────────────────────────────────────
     *  15. 字节流日志
     *
     *  最多保留 120 条，超限自动移除最早的。
     *  颜色由 CSS class 控制：
     *    log-rx-ok    → 蓝色（接收成功）
     *    log-rx-error → 黄色（接收错误）
     *    log-tx-ok    → 绿色（发送成功）
     *    log-tx-error → 红色（发送失败）
     * ───────────────────────────────────────────────────────── */

    const MAX_LOG_LINES = 120;

    /** 向日志面板追加一行 HTML */
    const appendLog = (html) => {
        const div = document.createElement('div');
        div.innerHTML = html;
        logContent.appendChild(div);
        while (logContent.children.length > MAX_LOG_LINES)
            logContent.removeChild(logContent.firstChild);
        logContent.scrollTop = logContent.scrollHeight;
    };

    /** 追加一条带时间戳的监视台日志行 */
    const appendMonitorLine = (className, prefix, timeStr, reason, hexStr) => {
        const reasonText = reason ? `[${reason}]` : '';
        const parts = [`[${timeStr}]`, `${prefix}${reasonText}`];
        if (hexStr) parts.push(hexStr);
        appendLog(`<span class="${className}">${parts.join(' ')}</span>`);
    };


    /* ─────────────────────────────────────────────────────────
     *  16. 初始化
     *
     *  加载保存的配置，并在下一帧同步绘图显示设置。
     * ───────────────────────────────────────────────────────── */

    loadConfig();
    requestAnimationFrame(() => {
        syncPlotDisplaySettings();
    });

});  // end DOMContentLoaded

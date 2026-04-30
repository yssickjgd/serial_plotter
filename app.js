document.addEventListener('DOMContentLoaded', () => {
    const serialAdapter = new SerialEngine();
    const netAdapter    = new NetEngine();
    const parser        = new DataParser();
    const plotter       = new Plotter('waveform-canvas');
    let activeEngine    = null;
    let sendTimer       = null;

    /* ════ DOM ════ */
    const sConnType       = document.getElementById('conn-type');
    const divSerial       = document.getElementById('config-serial');
    const divNet          = document.getElementById('config-net');
    const wrapLocalPort   = document.getElementById('wrap-local-port');
    const btnConnect      = document.getElementById('btn-connect');
    const indicator       = document.getElementById('connection-indicator');
    const statusText      = document.getElementById('connection-status');
    const chkHeader       = document.getElementById('chk-header');
    const headerConfig    = document.getElementById('header-config');
    const iptHeader       = document.getElementById('frame-header');
    const chkFooter       = document.getElementById('chk-footer');
    const footerConfig    = document.getElementById('footer-config');
    const iptFooter       = document.getElementById('frame-footer');
    const chkChecksum     = document.getElementById('chk-checksum');
    const sDataType       = document.getElementById('data-type');
    const sEndianness     = document.getElementById('endianness');
    const iptChannels     = document.getElementById('channels-count');
    const iptMaxPoints    = document.getElementById('max-points');
    const btnApply        = document.getElementById('btn-apply-format');
    const btnPause        = document.getElementById('btn-pause');
    const btnClear        = document.getElementById('btn-clear');
    const btnExport       = document.getElementById('btn-export');
    const btnExportCfg    = document.getElementById('btn-export-cfg');
    const btnImportCfg    = document.getElementById('btn-import-cfg');
    const cfgFileInput    = document.getElementById('cfg-file-input');
    const cfgSaveStatus   = document.getElementById('cfg-save-status');
    const channelList     = document.getElementById('channel-config-list');
    const logContent      = document.getElementById('data-log');
    const sendMode        = document.getElementById('send-mode');
    const sendInterval    = document.getElementById('send-interval');
    const sendIntervalUnit= document.getElementById('send-interval-unit');
    const sendInput       = document.getElementById('send-input');
    const btnSend         = document.getElementById('btn-send');
    const btnLoadFile     = document.getElementById('btn-load-file');
    const sendFileInput   = document.getElementById('send-file-input');
    const btnChannelsAllOn= document.getElementById('btn-channels-all-on');
    const btnChannelsAllOff= document.getElementById('btn-channels-all-off');
    const channelsListPanel= document.getElementById('channels-list-panel');
    const channelsDisplayPanel = document.getElementById('channels-display-panel');
    const plotInfoRow     = document.getElementById('plot-info-row');
    const plotViewMode    = document.getElementById('plot-view-mode');
    const plotYScaleMode  = document.getElementById('plot-y-scale-mode');
    const plotFftRemoveDc = document.getElementById('plot-fft-remove-dc');
    const plotYMin        = document.getElementById('plot-y-min');
    const plotYMax        = document.getElementById('plot-y-max');
    const statRx          = document.getElementById('stat-rx');
    const statTx          = document.getElementById('stat-tx');
    const statFps         = document.getElementById('stat-fps');
    const statFail        = document.getElementById('stat-fail');
    let capturePaused = false;

    const fmtFixed = (value, digits, width) => {
        if (!Number.isFinite(value)) return '--'.padStart(width, ' ');
        return value.toFixed(digits).padStart(width, ' ');
    };
    const formatMonitorTime = () => {
        const now = new Date();
        return [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map(n => n.toString().padStart(2, '0')).join(':')
            + '.' + now.getMilliseconds().toString().padStart(3, '0');
    };
    const stopSendTimer = () => {
        if (sendTimer) {
            clearInterval(sendTimer);
            sendTimer = null;
        }
        btnSend.textContent = '发送';
        btnSend.className = 'btn btn-primary';
    };
    const appendMonitorLine = (className, prefix, timeStr, reason, hexStr) => {
        const reasonText = reason ? `[${reason}]` : '';
        const parts = [`[${timeStr}]`, `${prefix}${reasonText}`];
        if (hexStr) parts.push(hexStr);
        appendLog(`<span class="${className}">${parts.join(' ')}</span>`);
    };
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
            } catch (_) {}
        }
    };
    const renderPlotStats = (stats) => {
        if (!stats) {
            plotInfoRow.innerHTML = '&nbsp;';
            return;
        }
        const periodText = stats.period === null ? '--' : fmtFixed(stats.period, 2, 7);
        plotInfoRow.innerHTML = [
            ['通道', stats.channelLabel],
            ['最大值', fmtFixed(stats.max, 6, 11)],
            ['最小值', fmtFixed(stats.min, 6, 11)],
            ['峰峰值', fmtFixed(stats.pp, 6, 11)],
            ['均值', fmtFixed(stats.mean, 6, 11)],
            ['标准差', fmtFixed(stats.stdDev, 6, 11)],
            ['主频', `${fmtFixed(stats.freq, 4, 8)} cyc/样本`],
            ['周期', `${periodText} 样本`]
        ].map(([label, value]) => `<span class="plot-info-segment"><span class="plot-info-label">${label}</span><span class="plot-info-value">${value}</span></span>`).join('');
    };

    plotter.onStatsUpdate = renderPlotStats;

    /* ════ Stats ════ */
    const stats = {
        rxBytes:0, txBytes:0,
        _rxLast:0, _txLast:0,
        _framesLast:0, _failsLast:0
    };
    setInterval(() => {
        if (capturePaused) return;
        const rxBps   = stats.rxBytes - stats._rxLast;
        const txBps   = stats.txBytes - stats._txLast;
        const frames  = parser.frameCount - stats._framesLast;
        const fails   = parser.failCount  - stats._failsLast;
        const total   = frames + fails;
        const failPct = total > 0 ? ((fails / total) * 100).toFixed(1) : '0.0';
        statRx.textContent   = `RX: ${_fmtBytes(rxBps)}/s`;
        statTx.textContent   = `TX: ${_fmtBytes(txBps)}/s`;
        statFps.textContent  = `帧率: ${frames} f/s`;
        statFail.textContent = `校验失败: ${failPct}%`;
        stats._rxLast     = stats.rxBytes;
        stats._txLast     = stats.txBytes;
        stats._framesLast = parser.frameCount;
        stats._failsLast  = parser.failCount;
    }, 1000);

    const countHexBytes = (hexStr) => hexStr ? hexStr.replace(/\s/g, '').length / 2 : 0;

    /* ════ Tabs ════ */
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
        });
    });

    /* ════ Left-Right Resizer ════ */
    const sidebar     = document.getElementById('sidebar');
    const hResizer    = document.getElementById('h-resizer');
    const mainDisplay = document.getElementById('main-display');
    let hDragging = false, hStartX = 0, hStartW = 0;
    hResizer.addEventListener('mousedown', e => {
        hDragging = true; hStartX = e.clientX; hStartW = sidebar.offsetWidth;
        document.body.style.cursor = 'ew-resize'; document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!hDragging) return;
        const newW = Math.max(180, Math.min(500, hStartW + (e.clientX - hStartX)));
        sidebar.style.width = sidebar.style.minWidth = sidebar.style.maxWidth = newW + 'px';
        plotter.resize();
    });
    document.addEventListener('mouseup', () => {
        if (!hDragging) return; hDragging = false;
        document.body.style.cursor = ''; document.body.style.userSelect = '';
    });

    /* ════ Top-Bottom Resizer (canvas / monitor) ════ */
    const canvasWrapper = document.getElementById('canvas-wrapper');
    const vResizer      = document.getElementById('v-resizer');
    const monitorPanel  = document.getElementById('monitor-panel');
    let vDragging = false, vStartY = 0, vStartH = 0;
    let canvasH = null; // null = use ratio on first call

    const applyVHeights = () => {
        const totalH = mainDisplay.clientHeight;
        const vH     = vResizer.offsetHeight;
        if (canvasH === null) canvasH = Math.round((totalH - vH) * 0.62);
        const monH = Math.max(80, totalH - vH - canvasH);
        canvasWrapper.style.flex = 'none'; canvasWrapper.style.height = canvasH + 'px';
        monitorPanel.style.flex  = 'none'; monitorPanel.style.height  = monH  + 'px';
        plotter.resize();
    };
    applyVHeights();
    window.addEventListener('resize', applyVHeights);

    vResizer.addEventListener('mousedown', e => {
        vDragging = true; vStartY = e.clientY; vStartH = canvasWrapper.offsetHeight;
        document.body.style.cursor = 'ns-resize'; document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!vDragging) return;
        const totalH = mainDisplay.clientHeight, vH = vResizer.offsetHeight;
        canvasH = Math.max(60, Math.min(totalH - vH - 80, vStartH + (e.clientY - vStartY)));
        applyVHeights();
    });
    document.addEventListener('mouseup', () => {
        if (!vDragging) return; vDragging = false;
        document.body.style.cursor = ''; document.body.style.userSelect = '';
    });

    /* ════ Connection type switch ════ */
    sConnType.addEventListener('change', () => {
        const v = sConnType.value;
        divSerial.style.display     = v === 'serial' ? '' : 'none';
        divNet.style.display        = v !== 'serial' ? '' : 'none';
        wrapLocalPort.style.display = (v === 'udp' || v === 'tcp-server') ? 'flex' : 'none';
        saveConfig();
    });

    /* ════ Frame format toggle ════ */
    const toggleSub = (chk, el) => {
        el.style.opacity = chk.checked ? '1' : '0.4';
        el.style.pointerEvents = chk.checked ? '' : 'none';
    };
    chkHeader.addEventListener('change', () => { toggleSub(chkHeader, headerConfig); saveConfig(); });
    chkFooter.addEventListener('change', () => { toggleSub(chkFooter, footerConfig); saveConfig(); });
    toggleSub(chkHeader, headerConfig);
    toggleSub(chkFooter, footerConfig);

    /* ════ Channel config UI — defined BEFORE updateParserSettings ════ */
    const rebuildChannelConfigUI = () => {
        channelList.innerHTML = '';
        const metas = plotter.getChannelMeta();
        if (metas.length === 0) {
            const p = document.createElement('p');
            p.className = 'hint-text';
            p.textContent = '请先在帧格式页设置通道数并点击应用。';
            channelList.appendChild(p);
            return;
        }
        metas.forEach(meta => {
            const row = document.createElement('div');
            row.className = 'channel-row';

            const lbl = document.createElement('span');
            lbl.className = 'channel-row-label'; lbl.textContent = `CH${meta.index+1}`;

            const colorIn = document.createElement('input');
            colorIn.type = 'color'; colorIn.className = 'channel-color-swatch';
            colorIn.value = meta.color; colorIn.title = '点击更改颜色';
            colorIn.addEventListener('input', () => {
                plotter.setChannelColor(meta.index, colorIn.value); saveConfig();
            });

            const nameIn = document.createElement('input');
            nameIn.type = 'text'; nameIn.className = 'channel-name-input';
            nameIn.value = meta.name; nameIn.placeholder = `CH${meta.index+1}`;
            nameIn.addEventListener('change', () => {
                plotter.setChannelName(meta.index, nameIn.value || `CH${meta.index+1}`); saveConfig();
            });

            const visChk = document.createElement('input');
            visChk.type = 'checkbox'; visChk.className = 'channel-vis-chk';
            visChk.checked = meta.visible; visChk.title = '显示/隐藏';
            visChk.addEventListener('change', () => {
                plotter.setChannelVisible(meta.index, visChk.checked);
                lbl.style.opacity = visChk.checked ? '1' : '0.4'; saveConfig();
                syncPlotDisplaySettings();
            });

            row.append(lbl, colorIn, nameIn, visChk);
            channelList.appendChild(row);
        });
    };

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

    [plotViewMode, plotYScaleMode, plotFftRemoveDc, plotYMin, plotYMax].filter(Boolean).forEach(el => {
        el.addEventListener('change', () => { syncPlotDisplaySettings(); saveConfig(); });
    });

    btnChannelsAllOn.addEventListener('click', () => {
        plotter.setAllChannelsVisible(true);
        rebuildChannelConfigUI();
        syncPlotDisplaySettings();
        saveConfig();
    });
    btnChannelsAllOff.addEventListener('click', () => {
        plotter.setAllChannelsVisible(false);
        rebuildChannelConfigUI();
        syncPlotDisplaySettings();
        saveConfig();
    });

    /* ════ Apply frame format ════ */
    const updateParserSettings = () => {
        const ch = parseInt(iptChannels.value) || 1;
        parser.setFormat({
            enableHeader:   chkHeader.checked,
            headerHex:      iptHeader.value,
            enableFooter:   chkFooter.checked,
            footerHex:      iptFooter.value,
            dataType:       sDataType.value,
            isLittleEndian: sEndianness.value === 'little',
            channelsCount:  ch,
            enableChecksum: chkChecksum.checked
        });
        plotter.setChannelCount(ch);
        plotter.setMaxPoints(parseInt(iptMaxPoints.value) || 1000);
        rebuildChannelConfigUI();
        syncPlotDisplaySettings();
    };

    iptMaxPoints.addEventListener('change', () => {
        plotter.setMaxPoints(parseInt(iptMaxPoints.value) || 1000); saveConfig();
    });
    btnApply.addEventListener('click', () => {
        updateParserSettings(); saveConfig();
        btnApply.textContent = '✓ 已应用';
        setTimeout(() => { btnApply.textContent = '应用帧格式配置'; }, 1200);
    });

    /* ════ Config Persistence ════ */
    const CFG_KEY = 'serialplot_v3_config';

    const getConfig = () => ({
        connType:    sConnType.value,
        serialBaud:  document.getElementById('serial-baud').value,
        serialData:  document.getElementById('serial-data').value,
        serialStop:  document.getElementById('serial-stop').value,
        serialParity:document.getElementById('serial-parity').value,
        netHost:     document.getElementById('net-host').value,
        netPort:     document.getElementById('net-port').value,
        netLocalPort: document.getElementById('net-local').value,
        enableHeader:chkHeader.checked,
        headerHex:   iptHeader.value,
        enableFooter:chkFooter.checked,
        footerHex:   iptFooter.value,
        enableChecksum:chkChecksum.checked,
        dataType:    sDataType.value,
        endianness:  sEndianness.value,
        channelsCount:iptChannels.value,
        maxPoints:   iptMaxPoints.value,
        sendIntervalUnit: sendIntervalUnit.value,
        plotViewMode: plotViewMode.value,
        plotYScaleMode: plotYScaleMode.value,
        plotFftRemoveDc: plotFftRemoveDc.checked,
        plotYMin: plotYMin.value,
        plotYMax: plotYMax.value,
        channels:    plotter.getChannelMeta().map(m => ({ name:m.name, color:m.color, visible:m.visible }))
    });

    const applyConfig = (cfg) => {
        if (!cfg) return;
        const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
        sConnType.value = cfg.connType || 'serial';
        sConnType.dispatchEvent(new Event('change'));
        set('serial-baud',  cfg.serialBaud);
        set('serial-data',  cfg.serialData);
        set('serial-stop',  cfg.serialStop);
        set('serial-parity',cfg.serialParity);
        set('net-host',     cfg.netHost);
        set('net-port',     cfg.netPort);
        set('net-local',    cfg.netLocalPort);
        if (cfg.enableHeader   !== undefined) chkHeader.checked   = cfg.enableHeader;
        if (cfg.enableFooter   !== undefined) chkFooter.checked   = cfg.enableFooter;
        if (cfg.enableChecksum !== undefined) chkChecksum.checked = cfg.enableChecksum;
        if (cfg.headerHex)    iptHeader.value     = cfg.headerHex;
        if (cfg.footerHex)    iptFooter.value     = cfg.footerHex;
        if (cfg.dataType)     sDataType.value     = cfg.dataType;
        if (cfg.endianness)   sEndianness.value   = cfg.endianness;
        if (cfg.channelsCount)iptChannels.value   = cfg.channelsCount;
        if (cfg.maxPoints)    iptMaxPoints.value  = cfg.maxPoints;
        if (cfg.sendIntervalUnit) sendIntervalUnit.value = cfg.sendIntervalUnit;
        if (cfg.plotViewMode) plotViewMode.value = cfg.plotViewMode;
        if (cfg.plotYScaleMode) plotYScaleMode.value = cfg.plotYScaleMode;
        if (cfg.plotFftRemoveDc !== undefined) plotFftRemoveDc.checked = cfg.plotFftRemoveDc;
        if (cfg.plotYMin !== undefined) plotYMin.value = cfg.plotYMin;
        if (cfg.plotYMax !== undefined) plotYMax.value = cfg.plotYMax;
        toggleSub(chkHeader, headerConfig);
        toggleSub(chkFooter, footerConfig);
        updateParserSettings();
        // Restore per-channel settings after channels are created
        if (cfg.channels) {
            cfg.channels.forEach((ch, i) => {
                plotter.setChannelColor(i, ch.color);
                plotter.setChannelVisible(i, ch.visible !== false);
                plotter.setChannelName(i, ch.name || `CH${i+1}`);
            });
            rebuildChannelConfigUI();
        }
        syncPlotDisplaySettings();
    };

    const saveConfig = () => {
        try {
            localStorage.setItem(CFG_KEY, JSON.stringify(getConfig()));
            cfgSaveStatus.textContent = '配置已自动保存。';
        } catch(e) { cfgSaveStatus.textContent = '保存失败: ' + e.message; }
    };

    const loadConfig = () => {
        try {
            const raw = localStorage.getItem(CFG_KEY);
            if (raw) { applyConfig(JSON.parse(raw)); cfgSaveStatus.textContent = '已从本地存储载入配置。'; }
            else      { updateParserSettings(); }
        } catch(e) { console.warn('配置加载失败:', e); updateParserSettings(); }
    };

    btnExportCfg.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(getConfig(), null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `serialplot_config_${Date.now()}.json`;
        a.click(); URL.revokeObjectURL(a.href);
    });
    btnImportCfg.addEventListener('click', () => cfgFileInput.click());
    cfgFileInput.addEventListener('change', e => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try { applyConfig(JSON.parse(ev.target.result)); saveConfig(); cfgSaveStatus.textContent = '配置已导入。'; }
            catch(err) { alert('配置文件格式错误: ' + err.message); }
        };
        reader.readAsText(file); e.target.value = '';
    });

    // Auto-save on any config field change
    [chkChecksum, sDataType, sEndianness, iptChannels, iptHeader, iptFooter, sendIntervalUnit, plotViewMode, plotYScaleMode, plotFftRemoveDc, plotYMin, plotYMax].filter(Boolean).forEach(el => {
        el.addEventListener('change', saveConfig);
    });

    /* ════ Parser callbacks ════ */
    // Raw data → show in monitor (all incoming bytes, regardless of frame validity)
    parser.onRawData = (hexStr, timeStr) => {
        if (capturePaused) return;
        stats.rxBytes += countHexBytes(hexStr);
    };

    // Valid frame → update plotter + show in monitor with different color
    parser.onFrameParsed = (valuesArr, timeStr, hexStr) => {
        if (capturePaused) return;
        plotter.addFrame(valuesArr);
        appendMonitorLine('log-rx-ok', 'RX', timeStr, '', hexStr);
    };

    // Frame error → show in monitor
    parser.onFrameError = (type, timeStr, hexStr) => {
        if (capturePaused) return;
        const label = type === 'checksum' ? '校验失败' : type === 'footer' ? '帧尾不匹配' : '解析错误';
        appendMonitorLine('log-rx-error', 'RX', timeStr, label, hexStr);
    };

    /* ════ Data routing ════ */
    const globalDataHandler = (data) => parser.appendData(data);
    serialAdapter.onData(globalDataHandler);
    netAdapter.onData(globalDataHandler);

    /* ════ Connection status ════ */
    const globalStatusHandler = (connected) => {
        if (connected) {
            btnConnect.textContent = '主动断开连接';
            btnConnect.classList.replace('btn-primary', 'btn-danger');
            indicator.className = 'status-dot connected';
            sConnType.disabled  = true;
        } else {
            stopSendTimer();
            btnConnect.textContent = '请求建立连接';
            btnConnect.classList.replace('btn-danger', 'btn-primary');
            indicator.className = 'status-dot disconnected';
            statusText.textContent = '设备处于离线断开状态。';
            activeEngine = null; sConnType.disabled = false;
        }
    };
    serialAdapter.onStatusChange(globalStatusHandler);
    netAdapter.onStatusChange(globalStatusHandler);

    /* ════ Connect button ════ */
    btnConnect.addEventListener('click', async () => {
        if (activeEngine) {
            await disconnectActiveEngine();
            return;
        }
        const mode = sConnType.value;
        statusText.textContent = '正在处理连接要求...';
        try {
            if (mode === 'serial') {
                const config = {
                    baudRate: parseInt(document.getElementById('serial-baud').value),
                    dataBits: parseInt(document.getElementById('serial-data').value),
                    stopBits: parseInt(document.getElementById('serial-stop').value),
                    parity:   document.getElementById('serial-parity').value
                };
                statusText.textContent = '请于弹出框选择对应的串口通道...';
                await serialAdapter.connect(config);
                activeEngine = serialAdapter;
                statusText.textContent = `串口就位: ${config.baudRate} bps`;
            } else {
                const config = {
                    mode, host: document.getElementById('net-host').value,
                    port: parseInt(document.getElementById('net-port').value),
                    localPort: parseInt(document.getElementById('net-local').value) || parseInt(document.getElementById('net-port').value)
                };
                await netAdapter.connect(config);
                activeEngine = netAdapter;
                statusText.textContent = 'TCP/UDP Bridge 已连通。';
            }
        } catch(e) {
            console.error('连接调度中断', e);
            statusText.textContent = `连接失败: ${e.message}`;
            activeEngine = null;
        }
    });

    /* ════ Toolbar ════ */
    btnPause.addEventListener('click', () => {
        const paused = plotter.togglePause();
        capturePaused = paused;
        btnPause.textContent = paused ? '恢复捕获队列' : '暂停捕捉';
        btnPause.className   = paused ? 'btn btn-success' : 'btn btn-secondary';
    });
    btnClear.addEventListener('click', () => {
        plotter.clear(); logContent.innerHTML = '';
        parser.buffer = new Uint8Array(0);
        parser.frameCount = 0; parser.failCount = 0;
        stats.rxBytes = 0;
        stats.txBytes = 0;
        stats._rxLast = 0;
        stats._txLast = 0;
        stats._framesLast = 0;
        stats._failsLast = 0;
    });
    btnExport.addEventListener('click', () => {
        const csv = plotter.exportCSV();
        if (!csv) { alert('目前无有效数据可导出。'); return; }
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Scientific_Plot_Export_${Date.now()}.csv`;
        a.click(); URL.revokeObjectURL(a.href);
    });

    /* ════ Send Panel ════ */
    // Hex ↔ Text conversion helpers
    const hexToBytes = str => {
        const clean = str.replace(/[^0-9A-Fa-f]/g, '');
        const bytes = [];
        for (let i = 0; i + 1 < clean.length; i += 2)
            bytes.push(parseInt(clean.substr(i, 2), 16));
        return new Uint8Array(bytes);
    };
    const bytesToHex  = arr => Array.from(arr).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
    const textToBytes = str => new TextEncoder().encode(str);
    const bytesToText = arr => new TextDecoder('latin1').decode(arr);

    sendMode.addEventListener('change', () => {
        const cur = sendMode.value;
        try {
            if (cur === 'hex') {
                const bytes = textToBytes(sendInput.value);
                sendInput.value = bytesToHex(bytes);
            } else {
                const bytes = hexToBytes(sendInput.value);
                sendInput.value = bytesToText(bytes);
            }
        } catch(e) { /* keep as-is */ }
    });

    const getSendPeriodMs = () => {
        const value = parseFloat(sendInterval.value);
        if (!Number.isFinite(value) || value <= 0) return 0;
        switch (sendIntervalUnit.value) {
            case 's': return value * 1000;
            case 'hz': return value > 0 ? 1000 / value : 0;
            default: return value;
        }
    };

    const doSend = async () => {
        if (!activeEngine) {
            stopSendTimer();
            return;
        }
        try {
            const mode  = sendMode.value;
            const bytes = mode === 'hex' ? hexToBytes(sendInput.value) : textToBytes(sendInput.value);
            if (bytes.length === 0) return;
            await activeEngine.send(bytes);
            stats.txBytes += bytes.length;
            appendMonitorLine('log-tx-ok', 'TX', formatMonitorTime(), '', bytesToHex(bytes));
        } catch(e) {
            const mode  = sendMode.value;
            const bytes = mode === 'hex' ? hexToBytes(sendInput.value) : textToBytes(sendInput.value);
            const reason = e && e.message ? e.message : '发送失败';
            appendMonitorLine('log-tx-error', 'TX', formatMonitorTime(), reason, bytesToHex(bytes));
            stopSendTimer();
            void disconnectActiveEngine();
        }
    };

    btnSend.addEventListener('click', () => {
        const interval = getSendPeriodMs();
        if (sendTimer) {
            stopSendTimer();
            return;
        }
        if (interval > 0) {
            doSend();
            sendTimer = setInterval(doSend, interval);
            btnSend.textContent = '停止'; btnSend.className = 'btn btn-danger';
        } else {
            doSend();
        }
    });

    btnLoadFile.addEventListener('click', () => sendFileInput.click());
    sendFileInput.addEventListener('change', e => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            const bytes = new Uint8Array(ev.target.result);
            sendInput.value = sendMode.value === 'hex' ? bytesToHex(bytes) : bytesToText(bytes);
        };
        reader.readAsArrayBuffer(file); e.target.value = '';
    });

    /* ════ Log renderer ════ */
    const MAX_LOG = 120;
    const appendLog = (html) => {
        const div = document.createElement('div');
        div.innerHTML = html;
        logContent.appendChild(div);
        while (logContent.children.length > MAX_LOG)
            logContent.removeChild(logContent.firstChild);
        logContent.scrollTop = logContent.scrollHeight;
    };

    /* ════ Init ════ */
    loadConfig();
    requestAnimationFrame(() => {
        syncPlotDisplaySettings();
    });
});

/* ── Format bytes helper ── */
function _fmtBytes(n) {
    if (n < 1024)       return n + ' B';
    if (n < 1024*1024)  return (n/1024).toFixed(1) + ' KB';
    return (n/(1024*1024)).toFixed(1) + ' MB';
}

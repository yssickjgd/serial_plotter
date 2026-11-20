/** Assemble persistent acquisition and independently configured workspace views. */
document.addEventListener('DOMContentLoaded', () => {
    globalThis.SerialPlotter.applicationReady = startSerialPlotterApplication();
});

async function startSerialPlotterApplication() {
    'use strict';
    const S = globalThis.SerialPlotter, el = id => document.getElementById(id);
    const CONFIG_KEY = 'serialplot_v3_config', WORKSPACE_KEY = 'serialplot_v3_workspace';
    const cleanups = [], progressRows = new Map(), rates = new Map(), draws = new Map();
    let disposed = false, restoring = true, saveTimer = null, exporting = false, importRevision = 0;
    let boundExportSourceId = null, boundExportFormat = null, bindingExport = false;
    let activeEngine = null, connecting = false, widgets = null, tools = null, exportView = null, uiFrame = null, engineView = null;
    const serialSources = new Map();
    let nextSerialSourceNumber = 2;
    const captureQuota = (global, count) => Math.floor(Number(global.captureMemoryMiB) * 1048576 / (count + 1));
    let previousStats = { time: performance.now(), rx: 0, tx: 0, epoch: 0 };
    const listen = (target, name, fn) => { target?.addEventListener(name, fn); cleanups.push(() => target?.removeEventListener(name, fn)); };
    const status = (id, message) => { const node = el(id); if (node) { node.textContent = message; node.hidden = !message; } };
    const report = error => status('cfg-save-status', error.message ?? String(error));
    const bytesLabel = n => n < 1024 ? Math.round(n) + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
    let storageBlocked = false, storageLoadError = null, storageWarnings = 0, configRevision = 0;
    const validateStoredConfig = (candidate, layout) => {
        const config = S.WidgetConfig.migrateWorkspaceConfig(candidate, layout);
        S.preflightDataEngine(config.dataEngine, config.global, { memoryLimitBytes: captureQuota(config.global, config.serialSources.entries.length) });
        return config;
    };
    const workspaceStorage = new S.WorkspaceStorage({ indexedDB: globalThis.indexedDB, localStorage: globalThis.localStorage,
        configKey: CONFIG_KEY, workspaceKey: WORKSPACE_KEY,
        validate: validateStoredConfig,
        onError(error) { storageWarnings++; report(error); } });
    let initial;
    try {
        if (workspaceStorage.hasIndexedDB) {
            initial = await workspaceStorage.load() ?? S.WidgetConfig.migrateWorkspaceConfig(null);
        } else {
            // Legacy-only environments initialize synchronously, including the browser test harness.
            const raw = localStorage.getItem(CONFIG_KEY), layout = localStorage.getItem(WORKSPACE_KEY);
            let candidate = raw ? JSON.parse(raw) : null;
            if (candidate?.storage === 'indexedDB') {
                const backup = localStorage.getItem(workspaceStorage.backupKey);
                if (!backup) throw new Error('IndexedDB 工作区不可用，且没有旧配置备份');
                candidate = JSON.parse(backup);
                if (candidate?.storage === 'indexedDB') throw new Error('旧配置备份无效');
                report(new Error('IndexedDB 工作区不可用，已加载旧配置备份'));
            }
            if (raw && (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))) throw new Error('保存的工作区配置无效');
            initial = validateStoredConfig(candidate, layout ? JSON.parse(layout) : null);
        }
    } catch (error) {
        storageBlocked = true; storageLoadError = error;
        initial = S.WidgetConfig.migrateWorkspaceConfig(null);
        report(new Error('配置读取失败，自动保存已停止；导入有效配置后可重新保存：' + (error.message ?? String(error))));
    }
    const globals = { ...initial.global, channelNames: [...initial.global.channelNames] };
    const uiLayout = { ...initial.uiLayout };
    const bufferFormat = value => value === 'binary' ? 'binary' : 'hex-text';
    const bufferSourceId = value => value === 'numeric' || value?.startsWith('engine:') ? 'base' : value;
    let exportProfiles = initial.tools.exportProfiles, exportFormat = bufferFormat(initial.tools.exportFormat);
    let exportRecordSourceId = bufferSourceId(initial.tools.exportRecordSourceId), exportRecordSource = null;
    let widgetExport = initial.tools.widgetExport, widgetExportSelection = null;
    async function saveNow() {
        if (disposed || restoring || storageBlocked) return null;
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = null;
        const revision = ++configRevision, warnings = storageWarnings;
        try {
            const config = S.WidgetConfig.validateWorkspaceConfig(getConfig());
            status('cfg-save-status', '正在保存配置…');
            const saved = await workspaceStorage.save(config);
            if (!disposed && revision === configRevision && warnings === storageWarnings) status('cfg-save-status', '配置已保存');
            return saved;
        } catch (error) { if (!disposed && revision === configRevision) report(error); return null; }
    }
    function saveSoon() {
        if (disposed || restoring || storageBlocked) return;
        configRevision++;
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = setTimeout(saveNow, 150);
    }
    async function flushConfig() {
        if (storageBlocked) throw storageLoadError ?? new Error('自动保存已停止');
        if (saveTimer !== null) await saveNow();
        return workspaceStorage.flush();
    }
    function showProgress(source, progress) {
        if (disposed) return;
        const container = el('history-rebuild-progress');
        if (source && (source.rebuilding || source.frames.rebuilding)) {
            let row = progressRows.get(source);
            if (!row) { row = document.createElement('div'); row.dataset.sourceId = source.id; progressRows.set(source, row); container.appendChild(row); }
            const titles = [...(widgets?.widgets.values() ?? [])].filter(widget => widget.source === source).map(widget => widget.title);
            progress ??= source.rebuilding ? source.progress : source.frames.progress;
            const fraction = typeof progress === 'number' ? progress : progress?.fraction ?? progress?.progress ??
                (progress?.totalBytes ? progress.processedBytes / progress.totalBytes : 0);
            row.textContent = (titles.join('、') || (source.kind === 'numeric' ? '共享数值' : '原始字节')) +
                '：准备历史 ' + Math.round(fraction * 100) + '%';
        } else if (source) { progressRows.get(source)?.remove(); progressRows.delete(source); }
        for (const [item, row] of progressRows) if (!service.sources.has(item) || !item.rebuilding && !item.frames.rebuilding) { row.remove(); progressRows.delete(item); }
        container.hidden = progressRows.size === 0;
    }
    function scheduleSourceUi() {
        if (disposed || uiFrame !== null) return;
        uiFrame = requestAnimationFrame(() => {
            uiFrame = null;
            if (disposed) return;
            showProgress(null, null); tools?.syncPaused(); syncExportAvailability();
        });
    }
    const service = new S.CaptureService({ capacity: Number(globals.maxPoints), maxRawFrameBytes: globals.maxRawFrameBytes,
        memoryLimitBytes: captureQuota(globals, initial.serialSources.entries.length),
        rebuildHistory: globals.rebuildHistory, numericFormat: { ...globals, ...initial.dataEngine.array }, channelNames: globals.channelNames, channelDefinitions: globals.channelDefinitions,
        onChange(source, { pendingRaw = false } = {}) {
            if (disposed) return;
            widgets?.syncData(source, { pendingRaw });
            if (pendingRaw) return;
            if (source && !source.rebuilding && progressRows.has(source)) showProgress(source, null);
            scheduleSourceUi();
        },
        onProgress: showProgress,
        onMemoryPressure(state) {
            tools?.invalidate();
            if (state.blocked) setPaused(true);
            updateMemoryStatus(); scheduleSourceUi();
        },
        onError(error, source) {
            if (error.bytes) widgets?.appendExtra(error, source);
            else status('format-apply-status', error.message ?? error.reason);
            scheduleSourceUi();
        }
    });
    const dataEngine = new S.DataEngine(service, initial.dataEngine, globals, { onProgress: showProgress });
    const serialAdapter = new S.SerialEngine(), netAdapter = new S.NetEngine();
    const serialSourceView = new S.SerialSourceView(el('serial-source-list'), {
        onConnect: source => { void toggleAdditionalSerial(source); },
        onRemove(source) {
            if (source.connected || source.pending) return;
            if (source.capture.history.endByte > source.capture.history.startByte &&
                !window.confirm('删除「' + source.settings.name + '」及其接收记录？')) return;
            dropSerialSource(source); applyCaptureQuotas(); syncExportSources(); saveSoon();
        },
        onEdit(source, key, value) {
            if (key !== 'name' && (source.connected || source.pending)) return;
            try {
                source.settings = S.WidgetConfig.normalizeSerialSource({ ...source.settings, [key]: value });
                source.error = ''; syncExportSources(); saveSoon();
            } catch (error) { source.error = error.message; }
            serialSourceView.apply(source); serialSourceView.refresh(source);
        }
    });
    function applyCaptureQuotas() {
        const limit = captureQuota(globals, serialSources.size);
        if (service.memory.limitBytes !== limit) service.setMemoryLimit(limit);
        for (const { capture } of serialSources.values()) if (capture.memory.limitBytes !== limit) capture.setMemoryLimit(limit);
    }
    function createSerialSource(settings, limit, rawIdleGapSeconds) {
        const adapter = new S.SerialEngine();
        const capture = new S.CaptureService({
            rawOnly: true, rawIdleGapSeconds, workerPool: service.workerPool, ownsWorkerPool: false,
            capacity: Number(globals.maxPoints), maxRawFrameBytes: globals.maxRawFrameBytes, memoryLimitBytes: limit,
            rebuildHistory: globals.rebuildHistory,
            onChange: scheduleSourceUi,
            onMemoryPressure(state) {
                if (state.blocked) source.error = state.blockedReason;
                serialSourceView.refresh(source); scheduleSourceUi();
            }
        });
        const source = { settings, adapter, capture, connected: false, pending: false, error: '' };
        serialSources.set(settings.id, source);
        capture.pause(service.paused);
        adapter.onData((bytes, stamp) => capture.receive(bytes, stamp));
        adapter.onStatusChange((connected, error) => {
            if (disposed || serialSources.get(settings.id) !== source) return;
            if (!connected) capture.endStream();
            source.connected = connected;
            source.error = error?.message ?? '';
            serialSourceView.refresh(source); scheduleSourceUi();
        });
        serialSourceView.add(source);
        return source;
    }
    async function toggleAdditionalSerial(source) {
        if (source.pending || disposed) return;
        source.pending = true; source.error = ''; serialSourceView.refresh(source);
        try {
            if (source.connected) await source.adapter.disconnect();
            else await source.adapter.connect(source.settings);
        } catch (error) {
            if (error.name !== 'AbortError') source.error = '连接失败：' + error.message;
        } finally {
            source.pending = false; serialSourceView.refresh(source); scheduleSourceUi();
        }
    }
    function dropSerialSource(source) {
        const { id } = source.settings;
        serialSources.delete(id); serialSourceView.remove(id);
        source.capture.dispose(); void source.adapter.dispose();
    }
    function installSerialSources(config, rawTimeout) {
        nextSerialSourceNumber = config.nextNumber;
        const ids = new Set(config.entries.map(entry => entry.id));
        const limit = captureQuota(globals, ids.size);
        for (const source of serialSources.values()) if (!ids.has(source.settings.id)) dropSerialSource(source);
        for (const settings of config.entries) {
            const source = serialSources.get(settings.id);
            if (!source) createSerialSource(settings, limit, rawTimeout / 1000);
            else {
                const previous = source.settings;
                source.settings = settings;
                serialSourceView.apply(source);
                if (['baudRate', 'dataBits', 'stopBits', 'parity'].some(key => previous[key] !== settings[key]))
                    void source.adapter.disconnect();
                const { capture } = source;
                capture.rebuildHistory = globals.rebuildHistory;
                capture.setCapacity(Number(globals.maxPoints));
                void capture.setMaxRawFrameBytes(globals.maxRawFrameBytes);
                void capture.setRawIdleFraming(rawTimeout / 1000);
            }
        }
        applyCaptureQuotas();
    }
    listen(el('serial-source-add'), 'click', () => {
        let number = nextSerialSourceNumber;
        while (Number.isSafeInteger(number + 1) && widgets.widgets.has('serial-' + number)) number++;
        try {
            if (!Number.isSafeInteger(number + 1)) throw new Error('串口来源编号已达上限');
            const limit = captureQuota(globals, serialSources.size + 1);
            S.preflightDataEngine(dataEngine.serialize(), globals, { memoryLimitBytes: limit });
            const settings = S.WidgetConfig.normalizeSerialSource({ id: 'serial-' + number, name: '串口 ' + number,
                baudRate: globals.serialBaud, dataBits: globals.serialData, stopBits: globals.serialStop, parity: globals.serialParity });
            createSerialSource(settings, limit, dataEngine.config.rawIdleTimeouts.Raw_Data / 1000);
            nextSerialSourceNumber = number + 1;
            applyCaptureQuotas(); syncExportSources(); saveSoon();
        } catch (error) { status('connection-status', error.message); }
    });
    const workspace = new S.WidgetWorkspace({ document, window, viewport: el('workspace-viewport'), surface: el('workspace-surface'),
        step: initial.workspace.step, zoom: initial.workspace.zoom,
        onZoomChange: zoom => {
            el('workspace-zoom-percent').value = String(Math.round(zoom * 100));
            for (const widget of widgets?.widgets.values() ?? [])
                if (widget.type === 'wave' || widget.type === 'pose') widget.view.resize();
        },
        onActivate: id => widgets?.activate(id), onResize: id => widgets?.resize(id),
        onDelete: id => widgets?.requestRemove(id), onDrop: ({ type, rect }) => widgets?.create({ type, rect }), onLayoutChange: saveSoon });
    widgets = new S.WidgetController({ document, service, globals, workspace,
        onChange() {
            if (!widgets || disposed) return;
            tools?.syncSources(); syncExportSources(); showProgress(null, null); saveSoon();
        },
        onRulesChange() { tools?.invalidate(); rates.clear(); syncExportSources(); },
        onChannelMetadataChange(index, patch) { engineView?.channels.updateMetadata(index, patch); },
        onBeforeChannelRenumber(numberMap) {
            saveExportProfile(); boundExportSourceId = null;
            for (const settings of Object.values(exportProfiles)) for (const profile of Object.values(settings.formats))
                if (profile.channelIndices !== null) profile.channelIndices = profile.channelIndices
                    .filter(index => numberMap.has(index + 1)).map(index => numberMap.get(index + 1) - 1);
            if (tools?.selectedChannels) tools.selectedChannels = new Set([...tools.selectedChannels]
                .filter(index => numberMap.has(index + 1)).map(index => numberMap.get(index + 1) - 1));
        },
        onActivate() { tools?.syncSources(); syncExportSources(); }
    });
    engineView = new S.DataEngineView({ document, engine: dataEngine, controller: widgets, onChange: saveSoon,
        getProtocolReferences(id) {
            const references = [], visit = nodes => {
                for (const node of nodes) {
                    if (node.mode === 'protocol' && node.protocol?.protocolId === id) references.push({ kind: 'command', id: node.id, label: `一键发送 · ${node.name}` });
                    if (node.children) visit(node.children);
                }
            };
            visit(commandLibrary.nodes);
            if (el('send-mode').value === 'protocol' && regularProtocolView.getDraft().protocolId === id)
                references.push({ kind: 'regular-send', id: 'regular', label: '常规发送 · 协议消息' });
            return references;
        },
        onLayout: syncEngineSplit,
        onApply() {
            for (const { capture } of serialSources.values()) {
                capture.rebuildHistory = globals.rebuildHistory;
                void capture.setRawIdleFraming(dataEngine.config.rawIdleTimeouts.Raw_Data / 1000);
            }
            tools?.invalidate(); rates.clear(); syncExportSources(); regularProtocolView.refresh(); commandView.render();
        } });
    tools = new S.WorkspaceTools({ document, service, getWidgets: () => widgets.widgets,
        getActiveWidget: () => widgets.active,
        getChannelNames: () => globals.channelNames, onStateChange: saveSoon });
    exportView = new S.ExportSettingsView(document, { onChange: exportSettingsChanged });
    const widgetExportView = new S.ExportSettingsView(document, { widget: true, onChange(key) {
        saveWidgetExportProfile();
        if (key === 'format') {
            widgetExport.format = el('widget-export-format').value;
            restoreWidgetExportProfile();
        }
        syncExportAvailability(); saveSoon();
    } });

    function exportSources() {
        const items = [{ id: 'base', title: '基础原始记录', source: service.baseSource, aliases: ['base'], associated: [] }];
        for (const widget of widgets.widgets.values()) {
            if (widget.type !== 'byte' || widget.source.kind !== 'raw') continue;
            let item = items.find(entry => entry.source === widget.source);
            if (!item) {
                item = { id: widget.id, title: '指定字节流的记录 · ' + widget.title, source: widget.source,
                    aliases: [], associated: [] };
                items.push(item);
            }
            item.aliases.push(widget.id); item.associated.push(widget.title);
        }
        for (const { settings, capture } of serialSources.values())
            items.push({ id: settings.id, title: settings.name + ' · 原始记录', source: capture.baseSource, capture, aliases: [settings.id], associated: [] });
        return items;
    }
    function rawExportCapture() { return exportRecordSource?.capture ?? service; }
    function rawExportSource() {
        if (el('export-direction').value === 'tx') return rawExportCapture().baseSource;
        return exportRecordSource?.source ?? null;
    }
    function saveExportProfile() {
        if (!exportView || bindingExport || !boundExportSourceId) return;
        Object.assign(exportProfiles[boundExportSourceId].formats[boundExportFormat], exportView.readProfile());
    }
    function saveWidgetExportProfile() {
        Object.assign(widgetExport.formats[widgetExport.format], widgetExportView.readProfile());
    }
    function restoreWidgetExportProfile() {
        el('widget-export-format').value = widgetExport.format;
        widgetExportView.applyProfile(widgetExport.formats[widgetExport.format]);
    }
    function exportSettingsChanged(key) {
        if (bindingExport || exporting) return;
        saveExportProfile();
        if (key === 'format') { exportFormat = el('export-format').value; boundExportSourceId = null; syncExportSources(); }
        else syncExportAvailability();
        saveSoon();
    }
    function syncExportSources() {
        if (!exportView || !widgets) return;
        saveExportProfile();
        bindingExport = true;
        try {
            const items = exportSources();
            const selected = items.find(item => item.aliases.includes(exportRecordSourceId)) ??
                items.find(item => item.source === exportRecordSource?.source);
            if (selected && selected.id !== exportRecordSourceId) {
                if (exportProfiles[exportRecordSourceId]) exportProfiles[selected.id] = exportProfiles[exportRecordSourceId];
                exportRecordSourceId = selected.id;
            }
            exportRecordSource = selected ?? null;
            const option = item => {
                const node = document.createElement('option'); node.value = item.id; node.textContent = item.title; return node;
            };
            el('export-source').replaceChildren(...items.map(option));
            el('export-source').value = selected?.id ?? '';
            boundExportSourceId = selected?.id ?? (Object.hasOwn(exportProfiles, exportRecordSourceId) ? exportRecordSourceId : 'base');
            boundExportFormat = exportFormat;
            exportProfiles[boundExportSourceId] ??= S.WidgetConfig.normalizeBufferExportSettings(null);
            const settings = exportProfiles[boundExportSourceId];
            settings.format = exportFormat; el('export-format').value = exportFormat;
            exportView.applyProfile(settings.formats[exportFormat]);
            widgetExportSelection = S.widgetExportSelection(widgets.active, globals.channelNames, dataEngine.mode);
            syncExportAvailability();
        } finally { bindingExport = false; }
    }
    function widgetSelectionForFormat(format, selected = widgetExportSelection) {
        if (format !== 'text') return selected;
        const widget = widgets.active;
        return widget?.type === 'byte' && widget.settings.captureMode === 'text' && widget.source.kind === 'raw'
            ? { widget, source: widget.source, encoding: widget.settings.textEncoding } : null;
    }
    function widgetExportIssue(format, selected) {
        if (!selected) return format === 'text' ? '请选择显示「文本」的字节流控件。'
            : '请选择有解析数据的波形、位姿或显示「数据引擎」的字节流控件。';
        if (selected.source.rebuilding || selected.source.frames.rebuilding) return '当前控件正在重建历史。';
        if (!selected.source.frames.length) return '当前控件没有可导出的记录。';
        if ((format === 'csv' || format === 'engine-text' || selected.source.frames.provenanceAt) &&
            selected.source.kind === 'numeric' && !selected.channelIndices.length)
            return '请在当前控件中选择至少一个可导出的通道。';
        return '';
    }
    function exportTimeRange(buffers) {
        const times = buffers.filter(buffer => buffer.length).flatMap(buffer =>
            [buffer.timestampAt(0), buffer.timestampAt(buffer.length - 1)]).filter(Number.isFinite);
        const format = value => {
            const date = new Date(value), pad = (n, width = 2) => String(n).padStart(width, '0');
            return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
                pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' + pad(date.getMilliseconds(), 3);
        };
        return times.length ? '时间范围：' + format(Math.min(...times)) + ' ～ ' + format(Math.max(...times)) : '';
    }
    function syncExportAvailability() {
        if (!exportView || !widgets || disposed) return;
        const source = rawExportSource(), direction = el('export-direction').value, tx = rawExportCapture().txFrames;
        const rxCount = direction !== 'tx' ? source?.frames.length ?? 0 : 0, txCount = direction !== 'rx' ? tx.length : 0;
        const rawIssue = !source ? '请重新选择记录范围。' : direction !== 'tx' && source.rebuilding ? '所选来源正在准备历史。'
            : !rxCount && !txCount ? '所选缓冲区没有可导出的记录。' : '';
        exportView.sync({ busy: exporting, available: !rawIssue });
        el('export-source').disabled = exporting;
        el('wrap-export-source').hidden = direction === 'tx' && !serialSources.size;
        const buffers = source ? [direction !== 'tx' && source.frames, direction !== 'rx' && tx].filter(Boolean) : [];
        const byteCount = buffers.reduce((sum, buffer) => sum + buffer.retainedByteLength, 0);
        el('export-range-summary').textContent = source ? 'RX ' + rxCount + '，TX ' + txCount + ' 帧，原始字节 ' + byteCount.toLocaleString() + ' B。\n' +
            exportTimeRange(buffers) : '';
        const associated = exportRecordSource?.associated ?? [];
        el('export-scope-hint').textContent = direction === 'tx' ? '导出成功发送的 TX 记录。'
            : '导出保留的原始记录，包含未成功解析的字节。' +
                (associated.length ? ' 关联控件（共用缓冲区）：' + associated.join('、') + '。' : '');
        status('export-source-status', rawIssue);

        const format = widgetExport.format, selected = widgetSelectionForFormat(format), issue = widgetExportIssue(format, selected);
        widgetExportView.sync({ busy: exporting, available: !issue, syncAvailable: Boolean(selected?.source.frames.provenanceAt) });
        const title = widgets.active?.title;
        el('widget-export-scope-hint').textContent = title ? '当前控件：' + title : '';
        const hint = format === 'binary' || format === 'hex-text' ? '导出成功解析的原始帧。'
            : format === 'text' ? '按控件的字符集和记录边界导出。' : '导出该控件采用的通道或字段。';
        el('widget-export-range-summary').textContent = selected ? hint + '\n' + exportTimeRange([selected.source.frames]) : '';
        status('widget-export-source-status', issue);
    }
    listen(el('export-source'), 'change', () => {
        if (exporting) return;
        saveExportProfile();
        exportRecordSourceId = el('export-source').value || null; exportRecordSource = null;
        boundExportSourceId = null;
        syncExportSources(); saveSoon();
    });

    function download(parts, filename, type) {
        const blob = new Blob(parts, { type }), anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob); anchor.download = filename; anchor.click(); URL.revokeObjectURL(anchor.href);
    }
    async function writeExport(view, options, buffers, check, chunks, metadataSize = 0) {
        const csv = options.format === 'csv', binary = options.format === 'binary';
        const text = options.format === 'text' || options.format === 'engine-text';
        const extension = csv ? 'csv' : binary ? 'bin' : text ? 'txt' : 'hex';
        const filename = 'Scientific_Plot_Export_' + Date.now() + '.' + extension;
        const large = buffers.reduce((sum, buffer) => sum + buffer.length, 0) > 50000 ||
            buffers.reduce((sum, buffer) => sum + buffer.retainedByteLength, metadataSize) > 32 * 1024 * 1024;
        const statusId = view.prefix + '-source-status';
        exporting = true; syncExportAvailability();
        let writable, failure = '';
        try {
            if (large) {
                if (typeof window.showSaveFilePicker !== 'function') throw new Error('大容量导出需要支持文件系统保存的 Chrome 或 Edge');
                const handle = await window.showSaveFilePicker({ suggestedName: filename }); check();
                writable = await handle.createWritable(); check();
            }
            const encoder = binary ? null : await S.createExportTextEncoder(text ? options.outputEncoding : 'utf-8');
            check();
            const parts = [];
            const writeBytes = async bytes => {
                check();
                if (writable) { await writable.write(bytes); check(); } else parts.push(bytes);
            };
            if (csv) await writeBytes(encoder.encode('\uFEFF'));
            let written = false, work = 0;
            for await (const chunk of chunks) {
                if (typeof chunk !== 'string') {
                    if (chunk.length) { written = true; await writeBytes(chunk); work += chunk.length; }
                } else for (let start = 0; start < chunk.length;) {
                    let end = Math.min(chunk.length, start + 16384);
                    if (end < chunk.length && (chunk.charCodeAt(end - 1) >= 0xd800 && chunk.charCodeAt(end - 1) <= 0xdbff ||
                        /[\u0304\u030c]/.test(chunk[end]) && /[\u00ca\u00ea]/.test(chunk[end - 1]))) end++;
                    const bytes = encoder.encode(chunk.slice(start, end));
                    written = true; await writeBytes(bytes); work += bytes.length; start = end;
                    if (work >= 262144) { work = 0; await new Promise(resolve => setTimeout(resolve, 0)); check(); }
                }
                if (work >= 262144) { work = 0; await new Promise(resolve => setTimeout(resolve, 0)); check(); }
            }
            if (!written) throw new Error('暂无符合条件的记录');
            check();
            if (writable) { await writable.close(); writable = null; }
            else download(parts, filename, binary ? 'application/octet-stream' : csv ? 'text/csv;charset=utf-8' :
                'text/plain;charset=' + (text ? options.outputEncoding : 'utf-8'));
            return true;
        } catch (error) {
            if (writable) try { await writable.abort(); } catch { /* Preserve the original failure. */ }
            if (error.name !== 'AbortError') failure = '导出失败：' + error.message;
            return false;
        } finally {
            exporting = false; syncExportSources();
            if (failure) status(statusId, failure);
        }
    }
    function exportCheck(buffers, valid) {
        const epoch = service.epoch, orders = buffers.map(buffer => buffer.orderAt(0));
        return () => {
            if (disposed || service.epoch !== epoch || !valid() ||
                buffers.some((buffer, index) => buffer.orderAt(0) !== orders[index]))
                throw new Error('导出期间来源或保留窗口已变化，请重新导出');
        };
    }
    async function exportData() {
        if (exporting || disposed) return false;
        const options = exportView.read(), capture = rawExportCapture(), source = rawExportSource(), tx = capture.txFrames;
        if (!source || options.direction !== 'tx' && source.rebuilding) return false;
        const sources = [options.direction !== 'tx' && source.frames, options.direction !== 'rx' && tx].filter(Boolean);
        if (!sources.some(buffer => buffer.length)) return false;
        const generation = source.generation;
        const check = exportCheck(sources, () => exportFormat === options.format && rawExportCapture() === capture && (options.direction === 'tx' ||
            rawExportSource() === source && source.generation === generation && capture.sources.has(source)));
        return writeExport(exportView, options, sources, check, S.captureExportChunks(source.frames, tx, options));
    }
    async function exportWidgetData() {
        if (exporting || disposed) return false;
        const options = widgetExportView.read(), format = options.format;
        const selected = widgetSelectionForFormat(format, S.widgetExportSelection(widgets.active, globals.channelNames, dataEngine.mode));
        if (widgetExportIssue(format, selected)) return false;
        const { widget, source, channels, channelIndices, fieldPaths } = selected, { frames } = source;
        const wire = format === 'binary' || format === 'hex-text';
        const protocolSource = wire && source.kind === 'numeric' && dataEngine.mode === 'Self_Defined_Frame'
            ? dataEngine.recordsSource : null;
        const buffers = protocolSource ? [frames, protocolSource.frames] : [frames];
        const generation = source.generation, frameGeneration = frames.generation, protocolGeneration = protocolSource?.generation;
        const check = exportCheck(buffers, () => widgets.widgets.get(widget.id) === widget && widget.source === source &&
            source.generation === generation && frames.generation === frameGeneration &&
            (!protocolSource || dataEngine.recordsSource === protocolSource && protocolSource.generation === protocolGeneration));
        const settings = { ...options, check, fieldPaths, channelIndices, successfulOnly: true };
        const chunks = wire ? S.parsedByteChunks(selected, protocolSource, settings)
            : format === 'text' ? S.captureExportChunks(frames, service.txFrames, { ...settings, encoding: selected.encoding })
            : format === 'engine-text' ? S.parsedTextChunks(selected, settings)
            : source.kind === 'protocol' ? S.structuredCsvChunksAsync(frames, source.decodeRecord, settings)
            : typeof frames.provenanceAt === 'function' ? S.synchronizedCsvChunks(frames, channels, settings)
            : S.frameCsvChunks(frames, channels, 1024, settings);
        return writeExport(widgetExportView, options, buffers, check, chunks, !wire ? frames.length * (channelIndices?.length ?? 0) * 16 : 0);
    }
    listen(el('btn-export'), 'click', () => { void exportData(); });
    listen(el('btn-widget-export'), 'click', () => { void exportWidgetData(); });
    const connectionIds = { connType: 'conn-type', serialBaud: 'serial-baud', serialData: 'serial-data',
        serialStop: 'serial-stop', serialParity: 'serial-parity', netHost: 'net-host', netPort: 'net-port', netLocalPort: 'net-local' };
    function syncConnection() {
        el('config-serial').hidden = globals.connType !== 'serial'; el('config-net').hidden = globals.connType === 'serial';
        el('wrap-local-port').hidden = globals.connType !== 'udp';
        el('serial-source-add').hidden = globals.connType !== 'serial';
        for (const id of ['config-serial', 'config-net', 'wrap-local-port']) el(id).style.display = el(id).hidden ? 'none' : '';
        for (const id of Object.values(connectionIds)) el(id).disabled = connecting || Boolean(activeEngine);
        el('connection-indicator').classList.toggle('connected', Boolean(activeEngine));
        el('btn-connect').textContent = activeEngine ? '断开连接' : '连接'; el('btn-connect').disabled = connecting;
    }
    function applyGlobalFields() {
        for (const [key, id] of Object.entries(connectionIds)) el(id).value = globals[key];
        el('max-points').value = globals.maxPoints; el('max-raw-frame-bytes').value = String(globals.maxRawFrameBytes);
        status('engine-raw-limit-status', '');
        el('capture-memory-mib').value = String(globals.captureMemoryMiB);
        el('max-points-label').textContent = '每个来源最大帧数';
        updateMemoryStatus();
        widgets.syncGlobals(); syncConnection();
    }
    for (const [key, id] of Object.entries(connectionIds)) listen(el(id), 'change', () => {
        const candidate = { ...globals, [key]: el(id).value };
        try { S.validateConfig(candidate); Object.assign(globals, candidate); syncConnection(); saveSoon(); }
        catch (error) { report(error); }
    });
    for (const [key, id] of [['maxPoints', 'max-points'], ['maxRawFrameBytes', 'max-raw-frame-bytes'],
        ['captureMemoryMiB', 'capture-memory-mib']]) listen(el(id), 'change', () => {
        const candidate = getConfig(); candidate.global[key] = key === 'maxPoints' ? el(id).value : Number(el(id).value);
        try {
            const validated = S.WidgetConfig.validateWorkspaceConfig(candidate);
            if (key === 'captureMemoryMiB' && serialSources.size)
                S.preflightDataEngine(validated.dataEngine, validated.global, { memoryLimitBytes: captureQuota(validated.global, serialSources.size) });
            Object.assign(globals, validated.global);
            if (key === 'maxPoints') {
                service.setCapacity(Number(globals.maxPoints)); widgets.setCapacity(Number(globals.maxPoints));
                for (const { capture } of serialSources.values()) capture.setCapacity(Number(globals.maxPoints));
            }
            else if (key === 'maxRawFrameBytes') {
                void service.setMaxRawFrameBytes(globals.maxRawFrameBytes);
                for (const { capture } of serialSources.values()) {
                    capture.rebuildHistory = globals.rebuildHistory;
                    void capture.setMaxRawFrameBytes(globals.maxRawFrameBytes);
                }
                widgets.syncByteRecordRule();
                status('engine-raw-limit-status', '');
            }
            else applyCaptureQuotas();
            updateMemoryStatus();
            tools.invalidate(); saveSoon(); status('cfg-save-status', '');
        } catch (error) {
            if (key === 'maxRawFrameBytes') status('engine-raw-limit-status', error.message);
            else report(error);
        }
    });
    const protocolSession = new S.ProtocolSendSession({ getProtocols: () => dataEngine.config.protocols,
        getProtocol: id => dataEngine.config.protocols.find(schema => schema.id === id) });
    const regularProtocolView = new S.ProtocolSendView({ root: el('protocol-send-panel'), session: protocolSession,
        value: initial.send.protocol ?? {}, onChange: saveSoon });
    const commandLibrary = new S.CommandLibrary(initial.send.commands);
    commandLibrary.setProtocolResolver(id => protocolSession.getProtocol(id));
    let commandView = null, sendTab = 'regular';
    const commandRunner = new S.CommandRunner({ library: commandLibrary, protocolSession,
        getEngine: () => disposed ? null : activeEngine,
        send: (bytes, isCurrent) => sendController.sendBytes(bytes, isCurrent),
        beforeStart: () => sendController.stop(),
        onState: state => commandView?.setState(state),
        onError: error => commandView?.showError(error) });
    const sendController = new S.SendController({ protocolSession, getProtocolCommand: () => regularProtocolView.getCommand(), mode: el('send-mode'), input: el('send-input'), fileInput: el('send-file-input'),
        interval: el('send-interval'), intervalUnit: el('send-interval-unit'), button: el('btn-send'), loadButton: el('btn-load-file'),
        getEngine: () => disposed ? null : activeEngine,
        onStart: () => commandRunner.stop(),
        onSent(bytes) { const record = service.appendTx(bytes); widgets.appendExtra(record); syncExportAvailability(); },
        onInputError: report,
        onSendError(error, bytes) {
            widgets.appendExtra({ kind: 'tx-error', bytes, reason: error.message, order: service.nextOrder++, timestamp: Date.now(),
                time: S.RawFrameParser.formatTime(Date.now()) }); status('connection-status', error.message);
        }
    });
    commandView = new S.CommandSendView({ protocolSession, library: commandLibrary, runner: commandRunner, tree: el('command-tree'),
        addButton: el('command-add'), groupButton: el('command-add-group'), stopButton: el('command-stop'),
        status: el('command-status'), error: el('command-error'), onChange: saveSoon });
    function setSendTab(tab, save = true) {
        sendTab = tab;
        el('send-panel').hidden = tab !== 'regular'; el('command-panel').hidden = tab !== 'commands';
        for (const name of ['regular', 'commands']) {
            const button = el(`send-tab-${name}`), active = name === tab;
            button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
        }
        el('send-resizer').setAttribute('aria-controls', 'global-send');
        workspace.refresh();
        for (const id of widgets.widgets.keys()) widgets.resize(id);
        if (save) saveSoon();
    }
    for (const name of ['regular', 'commands']) {
        const button = el(`send-tab-${name}`);
        listen(button, 'click', () => setSendTab(name));
        listen(button, 'keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'regular' : event.key === 'End' ? 'commands'
                : name === 'regular' ? 'commands' : 'regular';
            setSendTab(next); el(`send-tab-${next}`).focus?.();
        });
    }
    function syncProtocolSend() {
        const protocol = el('send-mode').value === 'protocol';
        el('protocol-send-panel').hidden = !protocol; el('send-input').hidden = protocol; el('btn-load-file').disabled = protocol;
        if (protocol) regularProtocolView.refresh();
    }
    listen(el('send-mode'), 'change', syncProtocolSend);
    for (const id of ['send-mode', 'send-interval', 'send-interval-unit']) listen(el(id), 'change', saveSoon);
    for (const adapter of [serialAdapter, netAdapter]) {
        adapter.onData((bytes, stamp) => service.receive(bytes, stamp));
        adapter.onStatusChange((connected, error) => {
            if (disposed) return;
            if (connected) activeEngine = adapter;
            else if (activeEngine === adapter || connecting) { activeEngine = null; sendController.stop(); commandRunner.stop(); service.endStream(); }
            status('connection-status', error ? error.message : connected ? '已连接' : '已断开'); syncConnection();
        });
    }
    listen(el('btn-connect'), 'click', async () => {
        if (connecting || disposed) return;
        connecting = true; syncConnection();
        try {
            if (activeEngine) {
                const adapter = activeEngine;
                try { await adapter.disconnect(); } catch { await adapter.forceDisconnect?.(); }
                activeEngine = null; sendController.stop(); commandRunner.stop(); service.endStream(); status('connection-status', '已断开');
            } else if (globals.connType === 'serial') {
                await serialAdapter.connect({ baudRate: S.parseIntInRange(globals.serialBaud, 1, Number.MAX_SAFE_INTEGER, '波特率'),
                    dataBits: Number(globals.serialData), stopBits: Number(globals.serialStop), parity: globals.serialParity });
            } else {
                const port = S.parsePort(globals.netPort), localText = globals.netLocalPort.trim();
                await netAdapter.connect({ mode: globals.connType, host: globals.netHost, port, localPort: localText ? S.parsePort(localText) : port });
            }
        } catch (error) { if (!disposed) { activeEngine = null; status('connection-status', '连接失败：' + error.message); } }
        finally { connecting = false; if (!disposed) syncConnection(); }
    });
    function setPaused(paused) {
        service.pause(paused);
        for (const { capture } of serialSources.values()) capture.pause(paused);
        if (service.paused) tools.invalidate(); else tools.resetNavigation();
        widgets.setPaused(service.paused); tools.syncPaused();
        for (const widget of widgets.widgets.values()) { widget.view.draw?.(); widget.view.render?.(); }
        el('btn-pause').textContent = service.paused ? '恢复捕获' : '暂停捕获';
        el('btn-pause').className = service.paused ? 'btn btn-success' : 'btn btn-secondary';
    }
    listen(el('btn-pause'), 'click', () => setPaused(!service.paused));
    listen(document, 'keydown', event => {
        if (!['p', 'P'].includes(event.key) || event.repeat || event.isComposing || event.defaultPrevented ||
            event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.target?.isContentEditable || event.target?.closest?.('input, textarea, select')) return;
        event.preventDefault();
        setPaused(!service.paused);
    });
    listen(el('btn-clear'), 'click', () => {
        service.clear();
        for (const { capture } of serialSources.values()) capture.clear();
        tools.invalidate(); rates.clear(); draws.clear();
        for (const widget of widgets.widgets.values()) widget.view.clear();
        previousStats = { time: performance.now(), rx: 0, tx: 0, epoch: service.epoch };
        for (const row of progressRows.values()) row.remove(); progressRows.clear();
        el('history-rebuild-progress').hidden = true; tools.syncPaused(); updateStats(); syncExportAvailability();
    });
    function updateMemoryStatus() {
        const state = service.memoryUsage();
        for (const { capture } of serialSources.values()) {
            const other = capture.memoryUsage();
            state.usedBytes += other.usedBytes; state.evictedFrames += other.evictedFrames;
            state.blockedReason ||= other.blockedReason;
        }
        const used = (state.usedBytes / 1048576).toFixed(1), limit = Number(globals.captureMemoryMiB);
        let message = `采集估算：${used} / ${limit} MiB`;
        if (state.evictedFrames) message += `；已按预算淘汰 ${state.evictedFrames.toLocaleString()} 条来源记录`;
        if (state.blockedReason) message += '；' + state.blockedReason;
        status('capture-memory-status', message);
    }
    function updateStats() {
        if (disposed) return;
        service.memory.enforce();
        for (const source of serialSources.values()) { source.capture.memory.enforce(); serialSourceView.refresh(source); }
        updateMemoryStatus();
        const now = performance.now(), elapsed = Math.max(0.001, (now - previousStats.time) / 1000);
        const sameEpoch = previousStats.epoch === service.epoch;
        const rxRate = sameEpoch ? Math.max(0, service.stats.rxBytes - previousStats.rx) / elapsed : 0;
        const txRate = sameEpoch ? Math.max(0, service.stats.txBytes - previousStats.tx) / elapsed : 0;
        const sourceRates = new Map();
        for (const source of service.sources) {
            if (source.rebuilding) { rates.delete(source); sourceRates.set(source, 0); continue; }
            const previous = rates.get(source), count = source.parser.frameCount;
            const same = previous && previous.epoch === service.epoch && previous.generation === source.generation;
            sourceRates.set(source, same ? Math.max(0, count - previous.count) / elapsed : 0);
            rates.set(source, { count, epoch: service.epoch, generation: source.generation });
        }
        for (const widget of widgets.widgets.values()) {
            if (widget.type === 'wave' || widget.type === 'pose') {
                const count = widget.type === 'wave' && widget.view.displayMode !== 'time' ? widget.view.completedSpectrumDraws : widget.view.completedDraws;
                const previous = draws.get(widget.id), mode = widget.type === 'pose' ? 'pose' : widget.view.displayMode;
                const fps = previous?.mode === mode ? Math.max(0, count - previous.count) / elapsed : 0;
                draws.set(widget.id, { count, mode });
                widget.refs['stat-plot-fps'].textContent = '绘图帧率: ' + Math.round(fps) + ' FPS';
                if (widget.type === 'wave') {
                    const gpu = widget.view.gpuRenderer;
                    widget.refs['stat-plot-fps'].title = gpu?.available
                        ? `实际 WebGL 渲染器：${gpu.rendererName || '浏览器未提供设备名称'}。\n已请求高性能显卡，实际选择由浏览器和系统决定。`
                        : '波形曲线使用 Canvas 2D；显卡不可用时自动回退。';
                }
                const rate = widget.source.sampleRate?.rate;
                if (widget.type === 'wave' && !service.paused && rate > 0 && !widget.view.frames.responseMode) widget.view.setSampleRateHz(rate);
            } else {
                widget.refs['stat-rx-value'].textContent = bytesLabel(rxRate) + '/s (' + bytesLabel(service.stats.rxBytes) + ')';
                widget.refs['stat-tx-value'].textContent = bytesLabel(txRate) + '/s (' + bytesLabel(service.stats.txBytes) + ')';
                const text = widget.settings.captureMode === 'text';
                const counts = text ? service.getTextStats(widget.source, widget.settings.textEncoding) : null;
                widget.refs['stat-fps-value'].textContent = Math.round(sourceRates.get(widget.source) ?? 0) + ' f/s';
                widget.refs['stat-fail-label'].textContent = text ? '失败字符 / 总字符:' : '校验失败:';
                const total = text ? counts.total : widget.source.parser.frameCount + widget.source.parser.failCount;
                const failed = text ? counts.failed : widget.source.parser.failCount;
                const ratio = (total ? (failed / total * 100).toFixed(1) : '0') + '%';
                widget.refs['stat-fail-value'].textContent = text ? `${failed} / ${total} (${ratio})` : ratio;
            }
        }
        for (const source of rates.keys()) if (!service.sources.has(source)) rates.delete(source);
        for (const id of draws.keys()) if (!widgets.widgets.has(id)) draws.delete(id);
        previousStats = { time: now, rx: service.stats.rxBytes, tx: service.stats.txBytes, epoch: service.epoch }; syncExportAvailability();
    }
    function getConfig() {
        saveExportProfile(); saveWidgetExportProfile();
        return { version: 3, global: { ...globals, channelNames: [...globals.channelNames], channelRecords: widgets.getChannelRegistry().toJSON() }, widgets: widgets.serialize(),
            workspace: workspace.serialize(), nextNumber: widgets.nextNumber, uiLayout: { ...uiLayout },
            dataEngine: dataEngine.serialize(), serialSources: { nextNumber: nextSerialSourceNumber,
                entries: [...serialSources.values()].map(source => ({ ...source.settings })) },
            tools: { ...tools.serialize(), exportSourceId: exportRecordSourceId, exportRecordSourceId, exportFormat, widgetExport,
                exportProfiles: JSON.parse(JSON.stringify(exportProfiles)) },
            send: { mode: el('send-mode').value, interval: el('send-interval').value, unit: el('send-interval-unit').value,
                tab: sendTab, protocol: regularProtocolView.getDraft(), commands: commandLibrary.serialize() } };
    }
    function installWidgets(config) {
        installSerialSources(config.serialSources, config.dataEngine.rawIdleTimeouts.Raw_Data);
        exportProfiles = config.tools.exportProfiles; boundExportSourceId = null;
        exportFormat = bufferFormat(config.tools.exportFormat);
        exportRecordSourceId = bufferSourceId(config.tools.exportRecordSourceId); exportRecordSource = null;
        widgetExport = config.tools.widgetExport; restoreWidgetExportProfile();
        workspace.setZoom(config.workspace.zoom);
        workspace.setStep(config.workspace.step);
        for (const widget of config.widgets) widgets.create(widget);
        widgets.nextNumber = Math.max(config.nextNumber, widgets.nextNumber);
        workspace.restore(config.workspace); el('workspace-step').value = String(config.workspace.step);
        tools.syncSources(config.tools);
        el('send-mode').value = config.send.mode; sendController.previousMode = config.send.mode;
        regularProtocolView.setValue(config.send.protocol ?? {}); syncProtocolSend();
        el('send-interval').value = config.send.interval; el('send-interval-unit').value = config.send.unit;
        commandLibrary.replace(config.send.commands); commandView.selectedId = null; commandView.render();
        commandView.error.hidden = true; commandView.status.textContent = '拖动排序，名称直接修改';
        setSendTab(config.send.tab, false);
        widgets.activate(null); workspace.activate(null); applyGlobalFields(); applyUiLayout(config.uiLayout); syncExportSources();
    }
    function applyConfig(input) {
        const config = S.WidgetConfig.migrateWorkspaceConfig(input);
        S.preflightDataEngine(config.dataEngine, config.global, { memoryLimitBytes: captureQuota(config.global, config.serialSources.entries.length) });
        const wasRestoring = restoring, revision = ++importRevision; restoring = true;
        try {
            tools.invalidate();
            sendController.stop(); commandRunner.stop();
            for (const id of [...widgets.widgets.keys()]) widgets.remove(id);
            Object.assign(globals, config.global); service.rebuildHistory = globals.rebuildHistory;
            service.setMemoryLimit(captureQuota(globals, config.serialSources.entries.length));
            // Install validated definitions against the incoming raw count atomically.
            service.channelDefinitions = globals.channelDefinitions; service.channelNames = globals.channelNames; widgets.channelRegistry = null;
            service.setCapacity(Number(globals.maxPoints)); void service.setMaxRawFrameBytes(globals.maxRawFrameBytes);
            const ready = dataEngine.apply(config.dataEngine, { rebuild: globals.rebuildHistory, force: true });
            installWidgets(config); rates.clear(); draws.clear();
            engineView.draft = JSON.parse(JSON.stringify(config.dataEngine.draft ?? config.dataEngine)); engineView.render(); engineView.channels.refresh();
            ready.then(() => { if (!disposed && revision === importRevision) widgets.rebindEngineSources(); })
                .catch(error => { if (!disposed && revision === importRevision) report(error); });
        } finally { restoring = wasRestoring; }
        storageBlocked = false; storageLoadError = null;
        saveSoon(); return config;
    }
    listen(el('btn-export-cfg'), 'click', () => download([JSON.stringify(getConfig(), null, 2)], 'serialplot-config.json', 'application/json'));
    listen(el('btn-import-cfg'), 'click', () => el('cfg-file-input').click());
    listen(el('cfg-file-input'), 'change', async event => {
        const file = event.target.files?.[0]; if (!file) return;
        try { applyConfig(JSON.parse(await file.text())); status('cfg-save-status', '配置已导入'); }
        catch (error) { report(error); }
        finally { event.target.value = ''; }
    });
    for (const button of el('sidebar-top').querySelectorAll('.tab-btn')) listen(button, 'click', () => {
        for (const tab of el('sidebar-top').querySelectorAll('.tab-btn')) {
            const active = tab === button; tab.classList.toggle('active', active);
            el(tab.dataset.tab).classList.toggle('active', active); el(tab.dataset.tab).hidden = !active;
        }
    });
    for (const button of document.querySelectorAll('[data-add-widget]')) listen(button, 'click', () => widgets.create({ type: button.dataset.addWidget }));
    for (const item of document.querySelectorAll('[data-widget-type]')) listen(item, 'pointerdown', event => {
        if (!event.target.closest('button')) workspace.beginLibraryDrag(item.dataset.widgetType, event);
    });
    const shell = el('app-container');
    const sidebars = { left: 'workspace-toggle-left', right: 'workspace-toggle-right' };
    const preferredSidebarOpen = { left: true, right: true };
    let compactSidebarLayout = false;
    function setSidebarOpen(side, open, remember = true) {
        if (remember) {
            preferredSidebarOpen[side] = open;
            uiLayout[`${side}Open`] = open; saveSoon();
        }
        shell.classList.toggle(`${side}-collapsed`, !open);
        el(sidebars[side]).setAttribute('aria-expanded', String(open));
        resizeViews();
    }
    function syncSidebarLayout(force = false) {
        const panelWidth = (id, variable, fallback) => {
            const style = el(id).style;
            return parseFloat(style.getPropertyValue?.(variable) || style[variable]) || fallback;
        };
        const requiredWidth = panelWidth('sidebar', '--sidebar-w', 268) +
            panelWidth('channel-sidebar', '--channel-sidebar-w', 320) + 480 + 26;
        const compact = Number(window.innerWidth) > 0 && window.innerWidth < Math.max(1100, requiredWidth);
        if (!force && compact === compactSidebarLayout) return;
        compactSidebarLayout = compact;
        shell.classList.toggle('compact-layout', compact);
        for (const side of ['left', 'right']) setSidebarOpen(side, compact ? false : preferredSidebarOpen[side], false);
    }
    for (const side of ['left', 'right']) listen(el(sidebars[side]), 'click', () => {
        const open = shell.classList.contains(`${side}-collapsed`);
        if (compactSidebarLayout && open) setSidebarOpen(side === 'left' ? 'right' : 'left', false, false);
        setSidebarOpen(side, open);
    });
    for (const side of ['left', 'right']) listen(el(`sidebar-close-${side}`), 'click', () => setSidebarOpen(side, false));
    const help = el('workspace-help'), helpToggle = el('workspace-help-toggle');
    function setWorkspaceHelp(open) { help.hidden = !open; helpToggle.setAttribute('aria-expanded', String(open)); resizeViews(); }
    listen(helpToggle, 'click', () => setWorkspaceHelp(help.hidden));
    listen(el('workspace-help-dismiss'), 'click', () => setWorkspaceHelp(false));
    listen(el('workspace-step'), 'change', () => { workspace.setStep(Number(el('workspace-step').value)); saveSoon(); });
    listen(el('workspace-reset'), 'click', () => workspace.reset());
    listen(el('workspace-zoom-reset'), 'click', () => workspace.setZoom(1));
    listen(el('workspace-zoom-percent'), 'change', () => {
        const value = Number(el('workspace-zoom-percent').value);
        if (Number.isInteger(value) && value >= 25 && value <= 500) workspace.setZoom(value / 100);
        el('workspace-zoom-percent').value = String(Math.round(workspace.zoom * 100));
    });
    let panelDrag = null;
    let engineSplitDrag = null;
    function syncEngineSplit() {
        const sidebar = el('sidebar'), title = sidebar.querySelector('.app-title');
        const available = Math.max(0, sidebar.clientHeight - (title?.offsetHeight ?? 40) - 8);
        const preferred = uiLayout.leftSplitRatio ?? .5;
        const upperMinimum = Math.min(100, available / 3);
        const engineMinimum = Math.min(engineView?.minimumHeight() ?? 140, available - upperMinimum);
        const height = Math.max(upperMinimum, Math.min(available - engineMinimum, available * preferred));
        sidebar.style.setProperty('--sidebar-upper-height', height + 'px');
        el('engine-splitter').setAttribute('aria-valuenow', String(Math.round(preferred * 100)));
    }
    listen(el('engine-splitter'), 'pointerdown', event => {
        if (event.button !== 0) return;
        engineSplitDrag = { pointerId: event.pointerId }; el('engine-splitter').setPointerCapture?.(event.pointerId); event.preventDefault();
    });
    listen(el('engine-splitter'), 'pointermove', event => {
        if (!engineSplitDrag || event.pointerId !== engineSplitDrag.pointerId) return;
        const rect = el('sidebar').getBoundingClientRect(), title = el('sidebar').querySelector('.app-title')?.offsetHeight ?? 40;
        uiLayout.leftSplitRatio = Math.max(.15, Math.min(.85, (event.clientY - rect.top - title) / Math.max(160, rect.height - title - 8)));
        syncEngineSplit();
    });
    const finishEngineSplit = () => { if (!engineSplitDrag) return; engineSplitDrag = null; saveSoon(); };
    listen(el('engine-splitter'), 'pointerup', finishEngineSplit); listen(el('engine-splitter'), 'pointercancel', finishEngineSplit);
    listen(el('engine-splitter'), 'keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); uiLayout.leftSplitRatio = event.key === 'Home' ? .15 : event.key === 'End' ? .85 :
            Math.max(.15, Math.min(.85, uiLayout.leftSplitRatio + (event.key === 'ArrowUp' ? -.025 : .025)));
        syncEngineSplit(); saveSoon();
    });
    const resizeViews = () => { syncEngineSplit(); workspace.refresh(); for (const id of widgets.widgets.keys()) widgets.resize(id); };
    syncSidebarLayout();
    const sendSizeTarget = () => el('global-send');
    const sendMinimum = (target = sendSizeTarget()) => parseFloat(window.getComputedStyle?.(target).minHeight) || 160;
    function setPanelSize(drag, size) {
        if (drag.variable) drag.panel.style.setProperty(drag.variable, Math.min(700, Math.max(240, size)) + 'px');
        else {
            const input = drag.panel ?? sendSizeTarget(), area = el('monitor-workspace'), main = el('main-display');
            const css = window.getComputedStyle?.(main);
            const padding = (parseFloat(css?.paddingTop) || 0) + (parseFloat(css?.paddingBottom) || 0);
            const outerHeight = node => {
                if (node.hidden) return 0;
                const style = window.getComputedStyle?.(node);
                return node.getBoundingClientRect().height + (parseFloat(style?.marginTop) || 0) + (parseFloat(style?.marginBottom) || 0);
            };
            const fixedHeight = [...main.children].filter(node => node !== area && node !== el('global-send'))
                .reduce((height, node) => height + outerHeight(node), 0);
            const sendMargin = outerHeight(input) - input.getBoundingClientRect().height;
            const minimumWorkspace = Math.max(150, el('workspace-toolbar').offsetHeight +
                (el('workspace-help').hidden ? 0 : el('workspace-help').offsetHeight) + 122);
            const max = Math.max(drag.minimum, main.clientHeight - padding - fixedHeight - sendMargin - minimumWorkspace);
            input.style.height = Math.max(drag.minimum, Math.min(max, size)) + 'px';
        }
        resizeViews();
    }
    function applyUiLayout(layout) {
        Object.assign(uiLayout, layout);
        syncEngineSplit();
        preferredSidebarOpen.left = layout.leftOpen; preferredSidebarOpen.right = layout.rightOpen;
        el('sidebar').style.setProperty('--sidebar-w', layout.leftWidth + 'px');
        el('channel-sidebar').style.setProperty('--channel-sidebar-w', layout.rightWidth + 'px');
        syncSidebarLayout(true);
        setPanelSize({ minimum: sendMinimum() }, layout.sendHeight);
    }
    function endPanelResize(event, cancelled = false) {
        const drag = panelDrag;
        if (!drag || event?.pointerId !== undefined && drag.pointerId !== event.pointerId) return;
        panelDrag = null;
        if (cancelled) setPanelSize(drag, drag.size);
        Object.assign(document.body.style, { cursor: drag.cursor, userSelect: drag.userSelect });
        try { drag.handle.releasePointerCapture?.(drag.pointerId); } catch { /* Capture may already be released. */ }
        if (drag.variable) syncSidebarLayout();
        if (!cancelled) {
            if (drag.variable) uiLayout[drag.variable === '--sidebar-w' ? 'leftWidth' : 'rightWidth'] =
                parseFloat(drag.panel.style.getPropertyValue?.(drag.variable) || drag.panel.style[drag.variable]);
            else uiLayout.sendHeight = parseFloat(sendSizeTarget().style.height);
            saveSoon();
        }
    }
    for (const [handleId, panelId, sign, variable] of [
        ['h-resizer', 'sidebar', 1, '--sidebar-w'], ['right-resizer', 'channel-sidebar', -1, '--channel-sidebar-w'],
        ['send-resizer', 'global-send', -1, null]
    ]) {
        const handle = el(handleId), panel = el(panelId);
        listen(handle, 'pointerdown', event => {
            if (event.button !== 0 || panelDrag) return;
            event.preventDefault();
            const target = variable ? panel : sendSizeTarget();
            panelDrag = { handle, panel: target, sign, variable, pointerId: event.pointerId,
                start: variable ? event.clientX : event.clientY,
                size: target.getBoundingClientRect()[variable ? 'width' : 'height'], minimum: variable ? 240 : sendMinimum(target),
                cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
            Object.assign(document.body.style, { cursor: variable ? 'ew-resize' : 'ns-resize', userSelect: 'none' });
            try { handle.setPointerCapture?.(event.pointerId); } catch { /* Document listeners still finish the drag. */ }
        });
        listen(handle, 'lostpointercapture', event => endPanelResize(event, true));
    }
    listen(document, 'pointermove', event => {
        if (!panelDrag || panelDrag.pointerId !== event.pointerId) return;
        const position = panelDrag.variable ? event.clientX : event.clientY;
        setPanelSize(panelDrag, panelDrag.size + panelDrag.sign * (position - panelDrag.start));
    });
    listen(document, 'pointerup', event => endPanelResize(event));
    listen(document, 'pointercancel', event => endPanelResize(event, true));
    listen(document, 'keydown', event => {
        if (event.key === 'Escape' && panelDrag) { event.preventDefault(); endPanelResize(null, true); }
    });
    listen(el('send-resizer'), 'keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key) || panelDrag) return;
        event.preventDefault();
        const minimum = sendMinimum();
        setPanelSize({ minimum }, event.key === 'Home' ? minimum : sendSizeTarget().getBoundingClientRect().height +
            (event.key === 'ArrowUp' ? 20 : -20));
        uiLayout.sendHeight = parseFloat(sendSizeTarget().style.height); saveSoon();
    });
    listen(window, 'blur', () => endPanelResize(null, true));
    listen(window, 'resize', () => {
        syncSidebarLayout();
        setPanelSize({ minimum: sendMinimum() }, uiLayout.sendHeight);
    });
    // Leave wheel scrolling to the containing pane; a focused native select can otherwise change its value.
    const scrollPastSelect = event => {
        if (event.ctrlKey || !event.deltaY) return;
        const select = event.target?.closest?.('select');
        if (select && document.activeElement === select) select.blur();
    };
    document.addEventListener('wheel', scrollPastSelect, { capture: true, passive: true });
    cleanups.push(() => document.removeEventListener('wheel', scrollPastSelect, true));
    function dispose() {
        if (disposed) return;
        endPanelResize(null);
        if (saveTimer !== null) saveNow();
        disposed = true; if (saveTimer !== null) clearTimeout(saveTimer);
        if (uiFrame !== null) cancelAnimationFrame(uiFrame);
        clearInterval(statsTimer); regularProtocolView.dispose(); commandRunner.dispose(); commandView.dispose(); sendController.stop(); sendController.dispose?.(); exportView.dispose(); widgetExportView.dispose();
        engineView.dispose(); tools.dispose(); widgets.dispose(); workspace.dispose();
        for (const source of serialSources.values()) dropSerialSource(source);
        service.dispose();
        for (const cleanup of cleanups.splice(0)) cleanup();
        for (const adapter of [serialAdapter, netAdapter]) {
            adapter.onData(null); adapter.onStatusChange(null);
            void (adapter.dispose ? adapter.dispose() : adapter.disconnect());
        }
        return workspaceStorage.dispose();
    }
    installWidgets(initial); el('history-rebuild-progress').hidden = true; restoring = false; updateStats();
    const statsTimer = setInterval(updateStats, 1000);
    S.application = { service, widgets, workspace, tools, serialAdapter, serialSources, netAdapter, sendController,
        protocolSession, regularProtocolView, commandLibrary, commandRunner, commandView, getConfig, applyConfig, dispose, exportData, exportWidgetData, updateStats,
        dataEngine, engineView, workspaceStorage, saveNow, saveSoon, flushConfig };
    listen(window, 'pagehide', dispose);
    return S.application;
}

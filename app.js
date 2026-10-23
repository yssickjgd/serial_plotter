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
    let boundExportSourceId = null, boundExportFormat = null, boundExportSource = null, bindingExport = false;
    let activeEngine = null, connecting = false, widgets = null, tools = null, exportView = null, uiFrame = null, engineView = null;
    let previousStats = { time: performance.now(), rx: 0, tx: 0, epoch: 0 };
    const listen = (target, name, fn) => { target?.addEventListener(name, fn); cleanups.push(() => target?.removeEventListener(name, fn)); };
    const status = (id, message) => { const node = el(id); if (node) { node.textContent = message; node.hidden = !message; } };
    const report = error => status('cfg-save-status', error.message ?? String(error));
    const bytesLabel = n => n < 1024 ? Math.round(n) + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
    let storageBlocked = false, storageLoadError = null, storageWarnings = 0, configRevision = 0;
    const validateStoredConfig = (candidate, layout) => {
        const config = S.WidgetConfig.migrateWorkspaceConfig(candidate, layout);
        S.preflightDataEngine(config.dataEngine, config.global, { memoryLimitBytes: config.global.captureMemoryMiB * 1048576 });
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
    let exportSourceId = initial.tools.exportSourceId, exportProfiles = initial.tools.exportProfiles;
    let exportFormat = initial.tools.exportFormat, exportRecordSourceId = initial.tools.exportRecordSourceId;
    let exportRecordSource = null;
    let exportCsvSourceId = initial.tools.exportCsvSourceId;
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
        memoryLimitBytes: Number(globals.captureMemoryMiB) * 1048576,
        rebuildHistory: globals.rebuildHistory, numericFormat: { ...globals, ...initial.dataEngine.array }, channelNames: globals.channelNames, channelDefinitions: globals.channelDefinitions,
        onChange(source) {
            if (disposed) return;
            widgets?.syncData(source);
            if (source && !source.rebuilding && progressRows.has(source)) showProgress(source, null);
            scheduleSourceUi();
        },
        onProgress: showProgress,
        onMemoryPressure(state) {
            tools?.invalidate();
            if (state.blocked) setPaused(true);
            updateMemoryStatus(state); scheduleSourceUi();
        },
        onError(error, source) {
            if (error.bytes) widgets?.appendExtra(error, source);
            else status('format-apply-status', error.message ?? error.reason);
            scheduleSourceUi();
        }
    });
    const dataEngine = new S.DataEngine(service, initial.dataEngine, globals, { onProgress: showProgress });
    const serialAdapter = new S.SerialEngine(), netAdapter = new S.NetEngine();
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
        onApply() { tools?.invalidate(); rates.clear(); syncExportSources(); regularProtocolView.refresh(); commandView.render(); } });
    tools = new S.WorkspaceTools({ document, service, getWidgets: () => widgets.widgets,
        getActiveWidget: () => widgets.active,
        getChannelNames: () => globals.channelNames, onStateChange: saveSoon });
    exportView = new S.ExportSettingsView(document, { onChange: exportSettingsChanged });
    const baseExportSync = exportView.sync.bind(exportView);
    function exportSources() {
        const items = [
            { id: 'base', title: '基础原始记录', source: service.baseSource, aliases: ['base'], associated: [] },
            { id: 'numeric', title: dataEngine.mode === 'Self_Defined_Frame' ? '同步采样表' : '成功解析的数值帧', source: service.numericSource, aliases: ['numeric'], associated: [] }
        ];
        for (const source of dataEngine.outputs.values()) if (source !== service.numericSource && source !== dataEngine.emptySource) {
            const name = dataEngine.choices().find(item => 'engine:' + item.id === source.id)?.name;
            items.push({ id: source.id, title: source.kind === 'protocol' ? '结构化消息记录' : name ?? source.id, source, aliases: [source.id], associated: [] });
        }
        for (const widget of widgets.widgets.values()) {
            let item = items.find(item => item.source === widget.source);
            if (!item && widget.type === 'byte') {
                item = { id: widget.id, title: `指定字节流的记录 · ${widget.title}`, source: widget.source,
                    aliases: [], associated: [] };
                items.push(item);
            }
            if (item) {
                item.associated.push(widget.title);
                if (widget.type === 'byte') item.aliases.push(widget.id);
            }
        }
        return items.filter(item => exportFormat === 'csv' || item.source.kind !== 'numeric' ||
            dataEngine.mode === 'Data_Array' && item.source === service.numericSource)
            .map(item => ({ ...item, numeric: item.source.kind === 'numeric' }));
    }
    const exportFormats = () => ['binary', 'hex-text', 'text', 'csv'];
    exportView.sync = options => {
        const structured = exportSources().find(item => item.id === exportSourceId)?.source.kind === 'protocol';
        baseExportSync({ ...options, numericAvailable: true,
            allowedFormats: exportFormats(), directionAvailable: true, busy: exporting });
        el('export-source').disabled = exporting;
        if (structured && exportFormat === 'csv') {
            el('wrap-export-numeric-parsing').hidden = true; el('export-channels-wrap').hidden = true;
            exportView.parseError = ''; el('export-parse-status').hidden = true;
        }
        el('engine-export-options').hidden = exportFormat !== 'csv' || (!structured && !service.numericSource.frames.provenanceAt);
        el('export-field-paths-wrap').hidden = !structured;
        el('export-sync-states-wrap').hidden = structured;
        syncExportAvailability();
    };
    function exportSource() {
        const csv = exportFormat === 'csv', txOnly = !csv && el('export-direction').value === 'tx';
        const selected = exportSources().find(item => item.id === exportSourceId);
        // TX is global; a deleted RX range must not prevent exporting TX.
        const effective = txOnly ? { id: exportSourceId, source: service.baseSource } : selected;
        return !effective || !exportFormats().includes(exportFormat) ? null
            : { ...effective, channels: exportChannels() };
    }
    function exportChannels() {
        const configured = Number(el('export-channels-count').value), original = Number(globals.channelsCount);
        const count = exportView.numericFormatEdited ? configured : original;
        if (!Number.isInteger(count) || count < 1 || count > 65535) return [];
        const same = count === original;
        return Array.from({ length: same ? service.numericSource.frames.channelCount : count }, (_, index) => ({
            name: index < original || same ? globals.channelNames[index] ?? S.formatChannelId(index) : S.formatChannelId(index),
            signal: !same || service.numericSource.frames.isSignal(index)
        }));
    }
    function saveExportProfile() {
        if (!exportView || bindingExport || !boundExportSourceId || !exportProfiles[boundExportSourceId]) return true;
        let profile;
        try { profile = exportView.readProfile(); }
        catch (error) { status('export-parse-status', error.message); return false; }
        const settings = exportProfiles[boundExportSourceId];
        if (boundExportFormat === 'csv') profile.direction = 'rx';
        settings.formats[boundExportFormat] = profile;
        return true;
    }
    function exportSettingsChanged(kind) {
        if (bindingExport || exporting) return;
        if (!saveExportProfile() && kind !== 'format') { syncExportAvailability(); return; }
        if (kind === 'format') {
            exportFormat = el('export-format').value;
            exportSourceId = exportFormat === 'csv' ? exportCsvSourceId : exportRecordSourceId;
            boundExportSourceId = null;
            syncExportSources();
        } else if (kind === 'numeric') syncExportSources();
        else syncExportAvailability();
        saveSoon();
    }
    function syncExportSources() {
        if (!exportView || !widgets) return;
        if (!saveExportProfile()) return;
        bindingExport = true;
        try {
            const items = exportSources();
            const record = items.find(item => item.aliases.includes(exportRecordSourceId)) ??
                items.find(item => item.source === exportRecordSource);
            if (record) {
                if (record.id !== exportRecordSourceId && exportProfiles[exportRecordSourceId])
                    exportProfiles[record.id] = exportProfiles[exportRecordSourceId];
                exportRecordSourceId = record.id; exportRecordSource = record.source;
                if (exportFormat !== 'csv') exportSourceId = record.id;
            }
            const selected = items.find(item => item.aliases.includes(exportSourceId)) ??
                (boundExportSourceId === exportSourceId ? items.find(item => item.source === boundExportSource) : null);
            if (selected && selected.id !== exportSourceId) {
                if (exportProfiles[exportSourceId]) exportProfiles[selected.id] = exportProfiles[exportSourceId];
                exportSourceId = selected.id;
                if (exportFormat !== 'csv') exportRecordSourceId = selected.id;
                else exportCsvSourceId = selected.id;
            }
            const option = (value, title) => { const node = document.createElement('option'); node.value = value; node.textContent = title; return node; };
            el('export-source').replaceChildren(...items.map(item => option(item.id, item.title)));
            el('export-source').value = selected?.id ?? '';
            boundExportSourceId = exportSourceId ?? 'base'; boundExportFormat = exportFormat;
            boundExportSource = selected?.source ?? null;
            exportProfiles[boundExportSourceId] ??= S.WidgetConfig.normalizeBufferExportSettings(null);
            const settings = exportProfiles[boundExportSourceId];
            settings.format = exportFormat; el('export-format').value = exportFormat;
            const active = widgets.active;
            exportView.setParsingDefaults(globals, { encoding: active?.type === 'byte' ? active.settings.textEncoding : globals.textEncoding,
                boundary: active?.type === 'byte' ? active.settings.textBoundary : globals.textBoundary });
            exportView.numericFormatEdited = Boolean(settings.formats[exportFormat].numericFormat);
            if (exportView.numericFormatEdited) el('export-channels-count').value = settings.formats[exportFormat].numericFormat.channelsCount;
            const channels = exportFormat === 'csv' ? exportSource().channels : [];
            const profile = settings.formats[exportFormat];
            exportView.applyProfile(profile, channels, exportView.textDefaults.encoding ?? profile.encoding);
            exportView.sync();
        } finally { bindingExport = false; }
    }
    function syncExportAvailability() {
        if (!exportView || disposed) return;
        const selected = exportSource(), csv = el('export-format').value === 'csv';
        const direction = csv ? 'rx' : el('export-direction').value;
        const count = selected ? (direction !== 'tx' ? selected.source.frames.length : 0) + (direction !== 'rx' ? service.txFrames.length : 0) : 0;
        el('btn-export').disabled = exporting || !selected || !count || csv && selected.source.kind !== 'protocol' && !exportView.selectedChannels().length ||
            direction !== 'tx' && selected.source.rebuilding || csv && selected.source.frames.rebuilding || Boolean(exportView.parseError);
        el('wrap-export-source').hidden = !csv && direction === 'tx';
        const rx = selected?.source.frames.length ?? 0, tx = service.txFrames.length;
        const buffers = selected ? [direction !== 'tx' && selected.source.frames, direction !== 'rx' && service.txFrames].filter(Boolean) : [];
        const byteCount = buffers.reduce((sum, buffer) => sum + buffer.retainedByteLength, 0);
        const timestamps = buffers.filter(buffer => buffer.length).flatMap(buffer =>
            [buffer.timestampAt(0), buffer.timestampAt(buffer.length - 1)]).filter(Number.isFinite);
        const formatTime = value => {
            const date = new Date(value), pad = (n, width = 2) => String(n).padStart(width, '0');
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
        };
        const timeRange = timestamps.length ? `${formatTime(Math.min(...timestamps))} ～ ${formatTime(Math.max(...timestamps))}` : '暂无记录';
        const countLabel = csv || el('export-format').value === 'text' ? `本次读取 ${count} 条记录` : `本次导出 ${count} 帧`;
        el('export-range-summary').textContent = selected ? `完整保留缓冲区：${direction === 'tx' ? `TX ${tx}` : direction === 'rx' ? `RX ${rx}` : `RX ${rx}，TX ${tx}`} 帧；${countLabel}，原始字节 ${byteCount.toLocaleString()} B。\n时间范围：${timeRange}` : '';
        const item = exportSources().find(item => item.id === exportSourceId);
        const scope = csv ? '按独立导出参数读取所选记录的原始字节，不修改采集规则或历史；数值源不包含采集时已丢弃的无效字节。'
            : direction === 'tx' ? '导出全局共用的成功发送记录，与 RX 记录范围无关。'
                : item?.numeric ? '仅包含成功解析的数值帧对应的原始字节，排除无法匹配的字节。'
                    : '导出当前保留的原始记录，包含未成功解析的字节。';
        el('export-scope-hint').textContent = scope + (direction !== 'tx' && item?.associated.length ?
            ` 关联控件（共用缓冲区）：${item.associated.join('、')}。` : '');
        status('export-source-status', !selected ? '请重新选择记录范围；不会自动切换到其他缓冲区。' : !count ? '所选缓冲区没有可导出的记录。'
            : direction !== 'tx' && selected.source.rebuilding ? '所选来源正在准备历史。' : '');
    }
    listen(el('export-source'), 'change', () => {
        if (exporting) return;
        if (!saveExportProfile()) { el('export-source').value = exportSourceId ?? ''; return; }
        exportSourceId = el('export-source').value || null;
        if (exportFormat === 'csv') exportCsvSourceId = exportSourceId;
        else { exportRecordSourceId = exportSourceId; exportRecordSource = null; }
        boundExportSourceId = null;
        syncExportSources(); saveSoon();
    });
    for (const id of ['export-direction', 'export-encoding', 'export-timestamps', 'export-markers', 'export-output-encoding', 'export-text-boundary'])
        listen(el(id), 'change', () => exportSettingsChanged('profile'));
    function download(parts, filename, type) {
        const blob = new Blob(parts, { type }), anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob); anchor.download = filename; anchor.click(); URL.revokeObjectURL(anchor.href);
    }
    async function exportData() {
        if (exporting || disposed) return false;
        const selected = exportSource();
        if (!selected) { syncExportAvailability(); return false; }
        const options = exportView.read(), csv = options.format === 'csv', source = selected.source;
        const txOnly = !csv && options.direction === 'tx';
        const frames = source.frames, tx = service.txFrames;
        const sources = csv || options.direction === 'rx' ? [frames] : options.direction === 'tx' ? [tx] : [frames, tx];
        const count = sources.reduce((sum, buffer) => sum + buffer.length, 0);
        if (!count || !txOnly && source.rebuilding || csv && (frames.rebuilding || source.kind !== 'protocol' && !options.channelIndices.length)) return false;
        const epoch = service.epoch, generation = source.generation, computedGeneration = frames.generation;
        const firstOrders = sources.map(buffer => buffer.orderAt(0));
        const check = () => {
            if (disposed || service.epoch !== epoch || exportFormat !== options.format ||
                !txOnly && (source.generation !== generation || !service.sources.has(source) ||
                    exportSource()?.source !== source) ||
                csv && frames.generation !== computedGeneration ||
                sources.some((buffer, index) => buffer.orderAt(0) !== firstOrders[index]))
                throw new Error('导出期间来源或保留窗口已变化，请重新选择并导出');
        };
        let large = count > 50000, retainedBytes = 0;
        if (!large) for (const buffer of sources) {
            for (let i = 0; i < buffer.length && retainedBytes <= 32 * 1024 * 1024; i++) retainedBytes += buffer.rawBytesAt(i).length;
            if (retainedBytes > 32 * 1024 * 1024) { large = true; break; }
        }
        const extension = csv ? 'csv' : options.format === 'binary' ? 'bin' : options.format === 'hex-text' ? 'hex' : 'txt';
        const filename = 'Scientific_Plot_Export_' + Date.now() + '.' + extension;
        exporting = true; exportView.sync({ busy: true });
        let writable, failure = '';
        try {
            const structuredCsv = csv && source.kind === 'protocol';
            const syncCsv = csv && typeof frames.provenanceAt === 'function';
            const engineCsv = structuredCsv || syncCsv;
            const customCsv = !engineCsv && csv && (source.kind !== 'numeric' || exportView.numericFormatEdited && S.EXPORT_NUMERIC_FIELDS.some(key =>
                String(options.numericFormat[key]) !== String(globals[key])));
            const customText = options.format === 'text';
            const encodedText = options.format === 'text';
            if (engineCsv || customCsv || customText || encodedText) {
                el('btn-export').textContent = '准备导出…';
                const encoder = await S.createExportTextEncoder(encodedText ? options.outputEncoding : 'utf-8');
                check();
                const context = { check, onProgress(done, total) {
                    check(); el('btn-export').textContent = `正在解析 ${total ? Math.round(done / total * 100) : 100}%`;
                }, definitions: Number(options.numericFormat?.channelsCount) === Number(globals.channelsCount) ? globals.channelDefinitions : [] };
                const selectedPaths = el('export-field-paths').value.split(/[\n,]/).map(path => path.trim()).filter(Boolean);
                const chunks = structuredCsv ? S.structuredCsvChunksAsync(frames, source.decodeRecord, { check, timestamps: options.timestamps, fieldPaths: selectedPaths.length ? selectedPaths : null })
                    : syncCsv ? S.synchronizedCsvChunks(frames, selected.channels, { ...options, check, syncStates: el('export-sync-states').checked })
                    : customCsv ? S.reparsedCsvChunks(frames, options.numericFormat, selected.channels, options, context)
                    : customText ? S.reparsedTextChunks(frames, tx, options, context) : S.captureExportChunks(frames, tx, options);
                const parts = [];
                if (large) {
                    if (typeof window.showSaveFilePicker !== 'function') throw new Error('大容量导出需要支持文件系统保存的 Chrome 或 Edge');
                    const handle = await window.showSaveFilePicker({ suggestedName: filename }); check();
                    writable = await handle.createWritable(); check();
                }
                const write = async text => {
                    let encodedWork = 0;
                    for (let start = 0; start < text.length;) {
                        let end = Math.min(text.length, start + 16384);
                        if (end < text.length && (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff ||
                            /[\u0304\u030c]/.test(text[end]) && /[\u00ca\u00ea]/.test(text[end - 1]))) end++;
                        check(); const bytes = encoder.encode(text.slice(start, end)); start = end;
                        if (writable) { await writable.write(bytes); check(); } else parts.push(bytes);
                        if ((encodedWork += bytes.length) >= 65536) {
                            encodedWork = 0; await new Promise(resolve => setTimeout(resolve, 0)); check();
                        }
                    }
                };
                if (csv) await write('\uFEFF');
                let work = 0;
                for await (const chunk of chunks) {
                    await write(chunk);
                    if ((work += chunk.length) > 262144) { work = 0; await new Promise(resolve => setTimeout(resolve, 0)); check(); }
                }
                if (writable) { await writable.close(); writable = null; }
                else { check(); download(parts, filename, csv ? 'text/csv;charset=utf-8' : 'text/plain;charset=' + options.outputEncoding); }
                return true;
            }
            if (large) {
                if (typeof window.showSaveFilePicker !== 'function') throw new Error('大容量导出需要支持文件系统保存的 Chrome 或 Edge');
                const handle = await window.showSaveFilePicker({ suggestedName: filename }); check();
                writable = await handle.createWritable(); check();
                const guarded = { async write(chunk) { check(); await writable.write(chunk); check(); } };
                const progress = done => { check(); el('btn-export').textContent = '正在导出 ' + Math.min(100, Math.round(done / count * 100)) + '%'; };
                if (csv) await S.writeFrameCsv(frames, selected.channels, guarded, progress, options);
                else await S.writeCaptureExport(frames, tx, options, guarded, progress);
                check(); await writable.close(); writable = null;
            } else {
                check();
                const parts = csv ? ['\uFEFF' + S.exportFrameCsv(frames, selected.channels, options)] : [...S.captureExportChunks(frames, tx, options)];
                check(); download(parts, filename, csv ? 'text/csv;charset=utf-8'
                    : options.format === 'binary' ? 'application/octet-stream' : 'text/plain;charset=utf-8');
            }
            return true;
        } catch (error) {
            if (writable) try { await writable.abort(); } catch { /* Preserve the original failure. */ }
            if (error.name !== 'AbortError') failure = '导出失败：' + error.message;
            return false;
        } finally {
            exporting = false; el('btn-export').textContent = '导出数据'; syncExportSources();
            if (failure) status('export-source-status', failure);
        }
    }
    listen(el('btn-export'), 'click', () => { void exportData(); });
    const connectionIds = { connType: 'conn-type', serialBaud: 'serial-baud', serialData: 'serial-data',
        serialStop: 'serial-stop', serialParity: 'serial-parity', netHost: 'net-host', netPort: 'net-port', netLocalPort: 'net-local' };
    function syncConnection() {
        el('config-serial').hidden = globals.connType !== 'serial'; el('config-net').hidden = globals.connType === 'serial';
        el('wrap-local-port').hidden = globals.connType !== 'udp';
        for (const id of ['config-serial', 'config-net', 'wrap-local-port']) el(id).style.display = el(id).hidden ? 'none' : '';
        for (const id of Object.values(connectionIds)) el(id).disabled = connecting || Boolean(activeEngine);
        el('connection-indicator').classList.toggle('connected', Boolean(activeEngine));
        el('btn-connect').textContent = activeEngine ? '断开连接' : '连接'; el('btn-connect').disabled = connecting;
    }
    function applyGlobalFields() {
        for (const [key, id] of Object.entries(connectionIds)) el(id).value = globals[key];
        el('max-points').value = globals.maxPoints; el('max-raw-frame-bytes').value = String(globals.maxRawFrameBytes);
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
            const validated = S.WidgetConfig.validateWorkspaceConfig(candidate); Object.assign(globals, validated.global);
            if (key === 'maxPoints') { service.setCapacity(Number(globals.maxPoints)); widgets.setCapacity(Number(globals.maxPoints)); }
            else if (key === 'maxRawFrameBytes') void service.setMaxRawFrameBytes(globals.maxRawFrameBytes);
            else service.setMemoryLimit(Number(globals.captureMemoryMiB) * 1048576);
            updateMemoryStatus();
            tools.invalidate(); saveSoon(); status('cfg-save-status', '');
        } catch (error) { report(error); }
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
        adapter.onData(bytes => service.receive(bytes));
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
        service.clear(); tools.invalidate(); rates.clear(); draws.clear();
        for (const widget of widgets.widgets.values()) widget.view.clear();
        previousStats = { time: performance.now(), rx: 0, tx: 0, epoch: service.epoch };
        for (const row of progressRows.values()) row.remove(); progressRows.clear();
        el('history-rebuild-progress').hidden = true; tools.syncPaused(); updateStats(); syncExportAvailability();
    });
    function updateMemoryStatus(state = service.memoryUsage()) {
        const used = (state.usedBytes / 1048576).toFixed(1), limit = Math.round(state.limitBytes / 1048576);
        let message = `采集估算：${used} / ${limit} MiB`;
        if (state.evictedFrames) message += `；已按预算淘汰 ${state.evictedFrames.toLocaleString()} 条来源记录`;
        if (state.blockedReason) message += '；' + state.blockedReason;
        status('capture-memory-status', message);
    }
    function updateStats() {
        if (disposed) return;
        service.memory.enforce(); updateMemoryStatus();
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
        saveExportProfile();
        return { version: 3, global: { ...globals, channelNames: [...globals.channelNames], channelRecords: widgets.getChannelRegistry().toJSON() }, widgets: widgets.serialize(),
            workspace: workspace.serialize(), nextNumber: widgets.nextNumber, uiLayout: { ...uiLayout },
            dataEngine: dataEngine.serialize(),
            tools: { ...tools.serialize(), exportSourceId, exportRecordSourceId, exportCsvSourceId, exportFormat,
                exportProfiles: JSON.parse(JSON.stringify(exportProfiles)) },
            send: { mode: el('send-mode').value, interval: el('send-interval').value, unit: el('send-interval-unit').value,
                tab: sendTab, protocol: regularProtocolView.getDraft(), commands: commandLibrary.serialize() } };
    }
    function installWidgets(config) {
        exportSourceId = config.tools.exportSourceId;
        exportProfiles = config.tools.exportProfiles; boundExportSourceId = null; boundExportSource = null;
        exportFormat = config.tools.exportFormat; exportRecordSourceId = config.tools.exportRecordSourceId;
        exportRecordSource = null;
        exportCsvSourceId = config.tools.exportCsvSourceId;
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
        widgets.activate(null); workspace.activate(null); applyGlobalFields(); applyUiLayout(config.uiLayout);
    }
    function applyConfig(input) {
        const config = S.WidgetConfig.migrateWorkspaceConfig(input);
        S.preflightDataEngine(config.dataEngine, config.global, { memoryLimitBytes: config.global.captureMemoryMiB * 1048576 });
        const wasRestoring = restoring, revision = ++importRevision; restoring = true;
        try {
            tools.invalidate();
            sendController.stop(); commandRunner.stop();
            for (const id of [...widgets.widgets.keys()]) widgets.remove(id);
            Object.assign(globals, config.global); service.rebuildHistory = globals.rebuildHistory;
            service.setMemoryLimit(Number(globals.captureMemoryMiB) * 1048576);
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
        clearInterval(statsTimer); regularProtocolView.dispose(); commandRunner.dispose(); commandView.dispose(); sendController.stop(); sendController.dispose?.(); exportView.dispose?.();
        engineView.dispose(); tools.dispose(); widgets.dispose(); workspace.dispose(); service.dispose();
        for (const cleanup of cleanups.splice(0)) cleanup();
        for (const adapter of [serialAdapter, netAdapter]) {
            adapter.onData(null); adapter.onStatusChange(null);
            void (adapter.dispose ? adapter.dispose() : adapter.disconnect());
        }
        return workspaceStorage.dispose();
    }
    installWidgets(initial); el('history-rebuild-progress').hidden = true; restoring = false; updateStats();
    const statsTimer = setInterval(updateStats, 1000);
    S.application = { service, widgets, workspace, tools, serialAdapter, netAdapter, sendController,
        protocolSession, regularProtocolView, commandLibrary, commandRunner, commandView, getConfig, applyConfig, dispose, exportData, updateStats,
        dataEngine, engineView, workspaceStorage, saveNow, saveSoon, flushConfig };
    listen(window, 'pagehide', dispose);
    return S.application;
}

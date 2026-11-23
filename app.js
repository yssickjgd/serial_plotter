/** Assemble persistent acquisition and independently configured workspace views. */
document.addEventListener('DOMContentLoaded', () => {
    globalThis.SerialPlotter.applicationReady = startSerialPlotterApplication();
});

async function startSerialPlotterApplication() {
    'use strict';
    const S = globalThis.SerialPlotter, el = id => document.getElementById(id);
    const CONFIG_KEY = 'serialplot_v3_config', WORKSPACE_KEY = 'serialplot_v3_workspace';
    const cleanups = [], progressRows = new Map(), captureProgressSources = new Set(), rates = new Map(), draws = new Map();
    const taskProgress = el('history-rebuild-progress'), workspaceTaskSlot = el('workspace-task-slot');
    let disposed = false, restoring = true, saveTimer = null, exporting = false, importRevision = 0;
    let boundExportSourceId = null, boundExportFormat = null, bindingExport = false;
    let widgets = null, tools = null, exportView = null, uiFrame = null, engineView = null;
    const connectionSources = new Map();
    let nextConnectionSourceNumber = 2;
    const captureQuota = (global, count) => Math.floor(Number(global.captureMemoryMiB) * 1048576 / (count + 1));
    let previousStats = { time: performance.now(), rx: 0, tx: 0, epoch: 0 };
    const listen = (target, name, fn) => { target?.addEventListener(name, fn); cleanups.push(() => target?.removeEventListener(name, fn)); };
    const status = (id, message) => { const node = el(id); if (node) { node.textContent = message; node.hidden = !message; } };
    const report = error => status('cfg-save-status', error.message ?? String(error));
    const bytesLabel = n => n < 1024 ? Math.round(n) + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
    let storageBlocked = false, storageLoadError = null, storageWarnings = 0, configRevision = 0;
    function paintProgress() {
        if (document.hidden || typeof window.requestAnimationFrame !== 'function') return;
        return new Promise(resolve => {
            const fallback = setTimeout(resolve, 80);
            window.requestAnimationFrame(() => setTimeout(() => {
                clearTimeout(fallback); resolve();
            }, 0));
        });
    }
    const itemsProcessed = (done, total, unit) => done.toLocaleString() + ' / ' + total.toLocaleString() + ' ' + unit;
    const configProgress = (key, label, done) => setTaskProgress(key, label, done / 3, itemsProcessed(done, 3, '步'));
    const validateStoredConfig = (candidate, layout) => {
        const config = S.WidgetConfig.migrateWorkspaceConfig(candidate, layout);
        preflightWorkspaceEngines(config);
        return config;
    };
    function preflightWorkspaceEngines(config) {
        const mapped = config.workspaceChannels.mappings.length;
        const memoryLimitBytes = captureQuota(config.global, config.serialSources.entries.length + Number(mapped > 0));
        if (mapped) {
            const operations = new S.ChannelOperations(mapped, config.workspaceChannels.channelDefinitions,
                { names: config.workspaceChannels.channelNames, symbolVersion: 2 });
            if (operations.requiredMemoryBytes > memoryLimitBytes) throw new Error('全局通道状态超过内存预算');
        }
        S.preflightDataEngine(config.dataEngine, config.global, { memoryLimitBytes });
        for (const source of config.serialSources.entries)
            S.preflightDataEngine(source.engine, S.WidgetConfig.serialSourceGlobals(config.global, source), { memoryLimitBytes });
    }
    const workspaceStorage = new S.WorkspaceStorage({ indexedDB: globalThis.indexedDB, localStorage: globalThis.localStorage,
        configKey: CONFIG_KEY, workspaceKey: WORKSPACE_KEY,
        validate(candidate, layout) {
            if (restoring) configProgress('config-restore', '正在校验启动配置', 1);
            return validateStoredConfig(candidate, layout);
        },
        onError(error) { storageWarnings++; report(error); } });
    let initial;
    try {
        if (workspaceStorage.hasIndexedDB) {
            configProgress('config-restore', '正在读取启动配置', 0);
            initial = await workspaceStorage.load() ?? S.WidgetConfig.migrateWorkspaceConfig(null);
            configProgress('config-restore', '正在恢复工作区', 2);
            await paintProgress();
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
    function setTaskProgress(key, label, fraction, counter = '') {
        if (disposed) return;
        let item = progressRows.get(key);
        if (!label) {
            if (!item) return;
            item.row.remove(); progressRows.delete(key);
        } else {
            if (!item) {
                const row = document.createElement('div'), title = document.createElement('span');
                const detail = document.createElement('span'), meter = document.createElement('progress');
                const amount = document.createElement('span');
                row.className = 'task-progress-row'; detail.className = 'task-progress-detail';
                meter.max = 100; meter.setAttribute('aria-hidden', 'true');
                detail.append(meter, amount); row.append(title, detail);
                item = { row, title, detail, meter, amount };
                progressRows.set(key, item); taskProgress.append(row);
            }
            if (item.title.textContent !== label) item.title.textContent = label;
            const percent = Number.isFinite(fraction) ? Math.round(Math.max(0, Math.min(1, fraction)) * 100) : null;
            const amount = [percent === null ? '' : percent + '%', counter].filter(Boolean).join(' · ');
            item.detail.hidden = !amount;
            item.meter.hidden = percent === null;
            if (percent !== null && item.meter.value !== percent) item.meter.value = percent;
            if (item.amount.textContent !== amount) item.amount.textContent = amount;
        }
        syncTaskProgressVisibility();
    }
    function syncTaskProgressVisibility() {
        const hidden = progressRows.size === 0;
        const hideWorkspace = hidden || taskProgress.parentElement !== workspaceTaskSlot;
        if (taskProgress.hidden !== hidden) taskProgress.hidden = hidden;
        if (workspaceTaskSlot.hidden !== hideWorkspace) workspaceTaskSlot.hidden = hideWorkspace;
    }
    function resetTaskProgress() {
        captureProgressSources.clear(); progressRows.clear();
        taskProgress.replaceChildren(); syncTaskProgressVisibility();
    }
    function showProgress(source, progress) {
        if (disposed) return;
        // The protocol records, message sequences and synchronized table share one replay.
        const sharedOutput = source?.engineManaged && source.rebuilding && source.kind !== 'protocol';
        if (source && !sharedOutput && (source.rebuilding || source.frames.rebuilding)) {
            captureProgressSources.add(source);
            const owner = allConnections().find(connection => connection.capture.sources.has(source));
            const title = source.kind === 'protocol' ? '正在重新解析协议历史'
                : source.kind === 'raw' ? '正在重建字节流历史'
                    : source.rebuilding ? '正在重建数值历史' : '正在重算运算通道';
            progress ??= source.rebuilding ? source.progress : source.frames.progress;
            const fraction = typeof progress === 'number' ? progress : progress?.fraction ?? progress?.progress ??
                (progress?.totalBytes ? progress.processedBytes / progress.totalBytes : null);
            const counter = progress?.totalBytes
                ? bytesLabel(progress.processedBytes ?? 0) + ' / ' + bytesLabel(progress.totalBytes) : '';
            setTaskProgress(source, owner ? title + ' · ' + owner.settings.name : title, fraction, counter);
        }
        for (const item of captureProgressSources) {
            if (hasCaptureSource(item) && (item.rebuilding || item.frames.rebuilding)) continue;
            captureProgressSources.delete(item); setTaskProgress(item);
        }
    }
    function scheduleSourceUi() {
        if (disposed || uiFrame !== null) return;
        uiFrame = requestAnimationFrame(() => {
            uiFrame = null;
            if (disposed) return;
            pumpWorkspaceChannels();
            showProgress(null, null); tools?.syncPaused(); syncExportAvailability(); renderAlignmentTimebaseStatus();
        });
    }
    const service = new S.CaptureService({ capacity: Number(globals.maxPoints), maxRawFrameBytes: globals.maxRawFrameBytes,
        memoryLimitBytes: captureQuota(globals, initial.serialSources.entries.length + Number(initial.workspaceChannels.mappings.length > 0)),
        rebuildHistory: globals.rebuildHistory, numericFormat: { ...globals, ...initial.dataEngine.array }, channelNames: globals.channelNames, channelDefinitions: globals.channelDefinitions,
        onChange(source, { pendingRaw = false } = {}) {
            if (disposed) return;
            widgets?.syncData(source, { pendingRaw });
            if (pendingRaw) return;
            if (captureProgressSources.has(source)) showProgress(source);
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
    const workspaceChannels = new S.WorkspaceChannelCapture(initial.workspaceChannels, Number(globals.maxPoints), {
        memoryLimit: () => captureQuota(globals, connectionSources.size + 1),
        resolveFrame(origin) {
            const capture = origin.sourceId === 'primary' ? service : connectionSources.get(origin.sourceId)?.capture;
            if (!capture || capture.epoch !== origin.epoch) return null;
            const engine = capture.dataEngine, source = engine.mode === 'Self_Defined_Frame' ? engine.recordsSource : engine.arraySource;
            if (!source || source.generation !== origin.generation) return null;
            const frames = source.frames, index = frames.indexAtOrAfterOrder(origin.order);
            return index >= 0 && frames.orderAt(index) === origin.order ? frames.frameAt(index, { copyBytes: false }) : null;
        }
    });
    workspaceChannels.onChange = () => {
        if (!disposed) widgets?.syncData(workspaceChannels.numericSource, {}, workspaceChannels);
    };
    let workspaceChannelTimer = null, workspaceChannelView = null, replayWorkspace = false, alignmentReplay = null;
    function scheduleWorkspaceReplay() { replayWorkspace = true; scheduleSourceUi(); }
    function cancelAlignmentReplay() {
        alignmentReplay?.capture.dispose();
        alignmentReplay = null;
        setTaskProgress('alignment');
    }
    function restartAlignmentReplay(settings) {
        const capture = workspaceChannels.createAlignmentReplay(settings);
        alignmentReplay?.capture.dispose();
        alignmentReplay = { epoch: workspaceChannels.epoch, definitions: workspaceChannels.settings.channelDefinitions, capture };
        setTaskProgress('alignment', '正在按新时基重新对齐保留历史');
    }
    function alignmentScanTargets(inputs, replay) {
        const mappedSources = new Set(replay.mappings.map(entry => entry.sourceId));
        return inputs.flatMap(({ settings, capture }) => {
            const engine = capture.dataEngine;
            if (!mappedSources.has(settings.id) || engine.mode === 'Raw_Data') return [];
            const source = engine.mode === 'Self_Defined_Frame' ? engine.recordsSource : engine.arraySource;
            if (!source || source.rebuilding || !source.frames.length) return [];
            const frames = source.frames;
            return [{ id: settings.id, source, first: frames.frameOrdinalAt(Math.max(0, frames.length - replay.capacity)),
                last: frames.frameOrdinalAt(frames.length - 1) }];
        });
    }
    function reportAlignmentReplay(replay, caughtUp) {
        let done = 0, total = 0;
        for (const target of alignmentReplay.targets) {
            const { first, last, source } = target;
            const frames = source.frames, remainingFirst = frames.frameOrdinalAt(0);
            const cursor = replay.cursors.get(target.id);
            const scanned = cursor?.source === source ? cursor.readFrame : null;
            const count = last - first + 1;
            done += Math.max(0, Math.min(count, (scanned ?? first - 1) - first + 1));
            // Evicted frames are no longer part of the replay target.
            const retainedStart = Number.isFinite(remainingFirst) ? remainingFirst : last + 1;
            const skipped = Math.max(0, Math.min(last + 1, retainedStart) - Math.max(first, (scanned ?? first - 1) + 1));
            total += count - skipped;
        }
        const label = caughtUp ? '时基重新对齐等待有效样点' : done && done === total
            ? '正在生成对齐结果' : '正在按新时基重新对齐保留历史';
        setTaskProgress('alignment', label, total ? done / total : null, total ? itemsProcessed(done, total, '帧') : '');
    }
    function realignWorkspaceChannels(sourceId) {
        if (!workspaceChannels.mappings.some(entry => entry.sourceId === sourceId)) return;
        restartAlignmentReplay();
        scheduleSourceUi();
    }
    function pumpWorkspaceChannels(flush = false) {
        if (alignmentReplay && alignmentReplay.epoch !== workspaceChannels.epoch) cancelAlignmentReplay();
        if (!workspaceChannels.mappings.length || service.paused && !flush && !replayWorkspace && !alignmentReplay || disposed) return;
        const inputs = allConnections();
        const cutoff = service.paused || flush ? Infinity : Date.now();
        let next;
        try {
            if (alignmentReplay && alignmentReplay.definitions !== workspaceChannels.settings.channelDefinitions)
                restartAlignmentReplay();
            const replay = alignmentReplay?.capture;
            if (replay) {
                if (replay.capacity !== workspaceChannels.capacity) replay.resize(workspaceChannels.capacity);
                alignmentReplay.targets ??= alignmentScanTargets(inputs, replay);
                next = replay.collect(inputs, cutoff);
                const caughtUp = !Number.isFinite(next) || next > cutoff;
                if (caughtUp && (replay.numericSource.frames.length || !workspaceChannels.numericSource.frames.length)) {
                    workspaceChannels.finishAlignmentReplay(replay);
                    alignmentReplay = null; setTaskProgress('alignment');
                    tools?.invalidate();
                    renderAlignmentTimebaseStatus();
                } else reportAlignmentReplay(replay, caughtUp);
            } else next = workspaceChannels.collect(inputs, cutoff);
        } catch (error) {
            cancelAlignmentReplay();
            report(error); replayWorkspace = false; return;
        }
        const pending = Number.isFinite(next);
        replayWorkspace = (replayWorkspace || flush) && pending;
        if (pending && workspaceChannelTimer === null) workspaceChannelTimer = setTimeout(() => {
            workspaceChannelTimer = null; pumpWorkspaceChannels();
        }, Math.max(0, Math.min(1000, next - cutoff)));
    }
    const serialAdapter = new S.SerialEngine(), netAdapter = new S.NetEngine();
    const portBindings = new S.SerialPortBindings(initial.serialSources.bindings);
    const primaryFields = { mode: 'connType', name: 'serialName', baudRate: 'serialBaud', dataBits: 'serialData',
        stopBits: 'serialStop', parity: 'serialParity', host: 'netHost', port: 'netPort', localPort: 'netLocalPort' };
    function primaryConnectionSettings() {
        const settings = Object.fromEntries(Object.entries(primaryFields).map(([key, globalKey]) => [key, globals[globalKey]]));
        // Older configurations could keep a separate local port in TCP server mode.
        if (settings.mode === 'tcp-server' && settings.localPort) settings.port = settings.localPort;
        return { id: 'primary', ...settings };
    }
    const primarySource = { adapter: globals.connType === 'serial' ? serialAdapter : netAdapter, capture: service,
        connected: false, pending: false, error: '', bindingMessage: '', settings: primaryConnectionSettings() };
    let connectionBusy = false;
    function primaryConnectionName() { return primarySource.settings.name; }
    function connectionChoices() {
        return [...connectionSources.values()].map(source => ({ id: source.settings.id, name: source.settings.name, capture: source.capture }));
    }
    function hasCaptureSource(source) {
        return service.sources.has(source) || [...connectionSources.values()].some(item => item.capture.sources.has(source));
    }
    const sidebarAlignmentSource = el('sidebar-alignment-source');
    const alignmentPanel = (container, prefix, offset, source) => ({
        container: el(container), source, offset: el(offset),
        mode: el(prefix + '-timebase-mode'), rate: el(prefix + '-timebase-rate'), fixed: el(prefix + '-timebase-fixed'),
        method: el(prefix + '-grid-method'), errorId: prefix + '-alignment-status', statusId: prefix + '-timebase-state',
        fixedResync: el(prefix + '-resync-fixed'),
        resync: el(prefix + '-resync-enabled'), delay: el(prefix + '-resync-delay'), batches: el(prefix + '-resync-batches'),
        confirmation: el(prefix + '-resync-confirmation')
    });
    const dialogAlignment = alignmentPanel('serial-config-alignment', 'channel', 'serial-config-offset', () => connectionView.selectedSource);
    const sidebarAlignment = alignmentPanel('sidebar-source-alignment', 'sidebar', 'sidebar-config-offset',
        () => sidebarAlignmentSource.value === 'primary' ? primarySource : connectionSources.get(sidebarAlignmentSource.value));
    const alignmentPanels = [dialogAlignment, sidebarAlignment];

    function showTimebaseFields(panel) {
        panel.fixed.hidden = panel.fixedResync.hidden = panel.mode.value !== 'fixed';
        panel.delay.disabled = panel.batches.disabled = panel.confirmation.disabled = !panel.resync.checked;
    }
    function renderAlignmentTimebaseStatus() {
        for (const panel of alignmentPanels) {
            const source = panel.source();
            const id = source?.settings.id;
            if (!id || workspaceChannels.timebases[id]?.mode !== 'fixed') { status(panel.statusId, ''); continue; }
            const live = workspaceChannels.cursors.get(id);
            const mapped = workspaceChannels.mappings.some(entry => entry.sourceId === id);
            status(panel.statusId, !mapped ? '此来源尚未映射到全局通道。' : alignmentReplay ? ''
                : !live ? '等待可解析的帧。' : live.invalidLatest ? '最近的帧缺少有效的时基值，已保留原始记录。'
                    : live.lastResync ? '最近一次自动重同步估算跳过 ' + live.lastResync.toLocaleString() + ' 帧。' : '');
        }
    }
    function renderAlignmentTimebase(panel, source = panel.source()) {
        panel.currentSource = source;
        panel.offset.disabled = !source || source === primarySource;
        panel.offset.value = String(source?.settings.timeOffsetMs ?? 0);
        const timing = S.normalizeSourceTimebase(source && workspaceChannels.timebases[source.settings.id]);
        panel.mode.value = timing.mode;
        panel.rate.value = String(timing.sampleRate);
        panel.resync.checked = timing.resyncEnabled;
        panel.delay.value = String(timing.resyncDelayMs);
        panel.batches.value = String(timing.resyncBatches);
        panel.confirmation.value = String(timing.resyncConfirmationMs);
        panel.method.value = workspaceChannels.methods[source?.settings.id] ?? 'hold';
        status(panel.errorId, '');
        showTimebaseFields(panel); renderAlignmentTimebaseStatus();
    }
    function commitAlignment(panel, source = panel.source()) {
        if (!source) return true;
        try {
            const id = source.settings.id, saved = workspaceChannels.timebases[id];
            const previous = S.normalizeSourceTimebase(saved);
            const fixed = panel.mode.value === 'fixed', resyncEnabled = fixed ? panel.resync.checked : previous.resyncEnabled;
            const resyncActive = fixed && resyncEnabled;
            const timing = S.normalizeSourceTimebase({ ...previous, mode: panel.mode.value, resyncEnabled,
                sampleRate: fixed ? Number(panel.rate.value) : previous.sampleRate,
                resyncDelayMs: resyncActive ? Number(panel.delay.value.trim() || NaN) : previous.resyncDelayMs,
                resyncBatches: resyncActive ? Number(panel.batches.value) : previous.resyncBatches,
                resyncConfirmationMs: resyncActive ? Number(panel.confirmation.value.trim() || NaN) : previous.resyncConfirmationMs });
            const originalSettings = source.settings;
            const nextSettings = source === primarySource ? originalSettings : S.WidgetConfig.normalizeConnectionSource({
                ...originalSettings, timeOffsetMs: panel.offset.value
            });
            const oldMethod = workspaceChannels.methods[id];
            const method = panel.method.value;
            if (JSON.stringify(previous) === JSON.stringify(timing) && method === (oldMethod ?? 'hold') &&
                originalSettings.timeOffsetMs === nextSettings.timeOffsetMs) { status(panel.errorId, ''); return true; }
            source.settings = nextSettings;
            workspaceChannels.methods[id] = method;
            workspaceChannels.timebases[id] = timing;
            try {
                realignWorkspaceChannels(id);
            } catch (error) {
                source.settings = originalSettings;
                if (oldMethod === undefined) delete workspaceChannels.methods[id];
                else workspaceChannels.methods[id] = oldMethod;
                if (saved) workspaceChannels.timebases[id] = saved;
                else delete workspaceChannels.timebases[id];
                throw error;
            }
            for (const widget of widgets.widgets.values()) {
                if (widget.type === 'wave' && widget.capture === source.capture) widgets.applySettings(widget);
            }
            if (widgets.active?.type === 'wave' && widgets.active.capture === source.capture) widgets.activate(widgets.active.id);
            for (const view of alignmentPanels) {
                if (view.source() === source) renderAlignmentTimebase(view, source);
            }
            connectionView.refresh(source); tools?.invalidate(); saveSoon();
            return true;
        } catch (error) { status(panel.errorId, error.message); return false; }
    }
    for (const panel of alignmentPanels) {
        listen(panel.mode, 'change', () => showTimebaseFields(panel));
        listen(panel.resync, 'change', () => showTimebaseFields(panel));
        S.bindAutoApply(panel.container, () => commitAlignment(panel), listen);
    }
    listen(sidebarAlignmentSource, 'change', () => {
        const previous = sidebarAlignment.currentSource;
        if (previous && !commitAlignment(sidebarAlignment, previous)) {
            sidebarAlignmentSource.value = previous.settings.id;
            return;
        }
        renderAlignmentTimebase(sidebarAlignment);
    });
    function refreshAlignmentSources() {
        const saved = sidebarAlignmentSource.value;
        sidebarAlignmentSource.replaceChildren(...allConnections().map(({ settings }) => {
            const option = document.createElement('option');
            option.value = settings.id; option.textContent = settings.name;
            return option;
        }));
        sidebarAlignmentSource.value = connectionSources.has(saved) ? saved : 'primary';
        for (const panel of alignmentPanels) renderAlignmentTimebase(panel);
    }
    function refreshConnectionChoices() {
        renderSendConnections(); renderWorkspaceChannels(); renderEngineScope(); refreshAlignmentSources();
        if (widgets?.active) widgets.activate(widgets.active.id);
        else syncExportSources();
    }
    function renderEngineScope() {
        const multiple = connectionSources.size > 0;
        for (const id of ['engine-parsing', 'engine-raw-records']) for (const badge of el(id).querySelectorAll('.scope-badge'))
            badge.textContent = multiple && badge.getAttribute('data-global-scope') === null ? '来源共用' : '全局共用';
    }
    const connectionView = new S.SerialSourceView(el('serial-source-list'), {
        dialog: el('serial-config-dialog'),
        onDialogChange(open) {
            const slot = open ? el('dialog-task-slot') : workspaceTaskSlot;
            if (taskProgress.parentElement !== slot) slot.append(taskProgress);
            syncTaskProgressVisibility();
        },
        onConnect: source => { void changeConnections([source], !source.connected); },
        onBind: source => { void bindSerialPort(source); },
        onEngine(source, tab, focus = true) {
            connectionView.showEngine(source, () => {
                if (disposed) return;
                if (engineView.engine === dataEngine) engineView.editor.close();
                else engineView.setEngine(dataEngine);
            });
            renderEngineScope();
            engineView.setEngine(source.capture.dataEngine);
            engineView.channels.allowDerived = false; engineView.channels.refresh();
            connectionView.restoreEnginePosition(connectionView.enginePositions.get(source.settings.id), focus, tab);
        },
        onRemove(source) {
            if (source.connected || source.pending || connectionBusy) return;
            if ([...widgets.widgets.values()].some(widget => widget.capture === source.capture)) {
                source.error = '仍有控件使用该来源，请先更改控件的接收来源。'; connectionView.refresh(source); return;
            }
            if (source.capture.history.endByte > source.capture.history.startByte &&
                !window.confirm('删除「' + source.settings.name + '」及其接收记录？')) return;
            try {
                const mappings = workspaceChannels.mappings.filter(entry => entry.sourceId !== source.settings.id);
                if (mappings.length !== workspaceChannels.mappings.length) applyWorkspaceMappings(mappings);
            } catch (error) { source.error = error.message; connectionView.refresh(source); return; }
            delete workspaceChannels.methods[source.settings.id];
            dropConnectionSource(source); applyCaptureQuotas(); refreshConnectionChoices(); syncConnection(); saveSoon();
        },
        onSelect: source => renderAlignmentTimebase(dialogAlignment, source),
        onSave(source, draft) {
            const previous = source.settings;
            if (source === primarySource) {
                const normalized = S.WidgetConfig.normalizeConnectionSettings({ ...previous, ...draft });
                for (const [key, globalKey] of Object.entries(primaryFields))
                    if (Object.hasOwn(draft, key)) globals[globalKey] = String(normalized[key]);
                if (draft.mode === 'tcp-server') globals.netLocalPort = '';
                replaceConnectionSettings(source, primaryConnectionSettings());
            } else {
                replaceConnectionSettings(source, S.WidgetConfig.normalizeConnectionSource({ ...previous, ...draft }));
            }
            source.error = '';
            if (previous.name !== source.settings.name) refreshConnectionChoices();
            syncConnection(); saveSoon();
        }
    });
    connectionView.add(primarySource);
    listen(el('serial-manager-open'), 'click', () => { syncConnection(); connectionView.showManager(); });
    function applyCaptureQuotas() {
        const limit = captureQuota(globals, connectionSources.size + Number(workspaceChannels.mappings.length > 0));
        workspaceChannels.trim();
        if (service.memory.limitBytes !== limit) service.setMemoryLimit(limit);
        for (const { capture } of connectionSources.values()) if (capture.memory.limitBytes !== limit) capture.setMemoryLimit(limit);
    }
    function createTransport(mode) {
        return mode === 'serial' ? new S.SerialEngine() : new S.NetEngine();
    }
    function createConnectionSource(settings, limit) {
        const adapter = createTransport(settings.mode);
        const local = S.WidgetConfig.serialSourceGlobals(globals, settings);
        local.rebuildHistory = settings.rebuildHistory ?? globals.rebuildHistory;
        const capture = new S.CaptureService({
            workerPool: service.workerPool, ownsWorkerPool: false,
            numericFormat: { ...local, ...settings.engine.array }, catalogCount: Number(local.channelsCount),
            channelNames: local.channelNames, channelDefinitions: local.channelDefinitions,
            capacity: Number(globals.maxPoints), maxRawFrameBytes: globals.maxRawFrameBytes, memoryLimitBytes: limit,
            rebuildHistory: local.rebuildHistory,
            onChange(output, options) { widgets?.syncData(output, options, capture); scheduleSourceUi(); },
            onProgress: showProgress,
            onError(error, output) { widgets?.appendExtra(error, output, capture); scheduleSourceUi(); },
            onMemoryPressure(state) {
                if (state.blocked) source.error = state.blockedReason;
                connectionView.refresh(source); scheduleSourceUi();
            }
        });
        const source = { settings, adapter, capture, connected: false, pending: false, error: '', bindingMessage: '' };
        connectionSources.set(settings.id, source);
        new S.DataEngine(capture, settings.engine, local, { onProgress: showProgress });
        capture.pause(service.paused);
        watchTransport(source, adapter);
        connectionView.add(source);
        return source;
    }
    function allConnections() { return [primarySource, ...connectionSources.values()]; }

    function renderWorkspaceChannels() {
        if (!workspaceChannelView) return;
        const ranges = new Map();
        for (const [index, entry] of workspaceChannels.mappings.entries()) {
            if (!ranges.has(entry.sourceId)) ranges.set(entry.sourceId, [index, index]);
            else ranges.get(entry.sourceId)[1] = index;
        }
        el('workspace-channel-ranges').replaceChildren(...[...ranges].map(([id, [first, last]]) => {
            const row = document.createElement('p');
            const name = id === 'primary' ? primaryConnectionName() : connectionSources.get(id)?.settings.name ?? id;
            row.textContent = name + ' · ' + S.formatChannelId(first) + (last === first ? '' : '–' + S.formatChannelId(last));
            return row;
        }));
        el('workspace-sample-rate').value = String(workspaceChannels.sampleRate);
        el('workspace-wait-ms').value = String(workspaceChannels.waitMs);
        el('workspace-hold-ms').value = String(workspaceChannels.holdMs);
        el('workspace-channel-panel').hidden = !workspaceChannels.mappings.length;
        workspaceChannelView.refresh();
    }

    function applyWorkspaceMappings(mappings, legacy = []) {
        if (!mappings.length && [...widgets.widgets.values()].some(widget => widget.capture === workspaceChannels))
            throw new Error('仍有波形使用全局通道，请先更改其接收来源');
        const local = workspaceChannels.dataEngine.globals;
        const plan = S.planWorkspaceChannels(workspaceChannels.settings, mappings, legacy);
        const { channelNames, channelColors, channelDefinitions } = plan.globals;
        workspaceChannels.configure(plan.globals, () => widgets.commitChannelRemap({
            globals: { channelsCount: String(Math.max(1, mappings.length)), channelNames, channelColors, channelDefinitions, channelRecords: [] },
            numberMap: plan.numberMap, previous: local.channelDefinitions, previousRawCount: local.channelsCount, capture: workspaceChannels
        }));
        applyCaptureQuotas(); renderWorkspaceChannels(); widgets.rebindEngineSources(workspaceChannels);
        if (widgets.active) widgets.activate(widgets.active.id);
        scheduleWorkspaceReplay(); saveSoon();
    }

    listen(el('workspace-channel-auto-map'), 'click', () => {
        try {
            const mappings = [], legacy = [];
            for (const { settings, capture } of allConnections()) {
                const engine = capture.dataEngine, local = engine.globals;
                if (engine.mode === 'Raw_Data') continue;
                for (const entry of widgets.getChannelRegistry(capture).getChannels()) if (entry.type === 'raw')
                    mappings.push({ sourceId: settings.id, channelId: entry.id, number: entry.number, name: entry.name,
                        color: widgets.channelColor(entry.number - 1, local.channelColors) });
                if (!workspaceChannels.mappings.length) legacy.push({ id: settings.id,
                    definitions: local.channelDefinitions, names: local.channelNames, colors: local.channelColors });
            }
            if (!mappings.length) throw new Error('请先为至少一路来源应用数组或自定义帧解析');
            applyWorkspaceMappings(mappings, legacy);
            el('workspace-channel-status').classList.remove('is-error');
            status('workspace-channel-status', '已映射 ' + mappings.length + ' 路原始通道');
        } catch (error) {
            el('workspace-channel-status').classList.add('is-error'); status('workspace-channel-status', error.message);
        }
    });
    S.bindAutoApply(el('workspace-grid-settings'), () => {
        const rate = el('workspace-sample-rate').value, hold = el('workspace-hold-ms').value;
        try {
            if (!rate.trim() || !hold.trim()) throw new Error('请输入同步采样率和样点有效期');
            const wait = el('workspace-wait-ms').value;
            if (!wait.trim()) throw new Error('请输入最多等待时间');
            const settings = { ...workspaceChannels.settings, sampleRate: Number(rate), holdMs: Number(hold), waitMs: Number(wait) };
            if (settings.sampleRate === workspaceChannels.sampleRate && settings.holdMs === workspaceChannels.holdMs &&
                settings.waitMs === workspaceChannels.waitMs) return;
            if (workspaceChannels.mappings.length) restartAlignmentReplay(settings);
            else workspaceChannels.configure(settings);
            Object.assign(workspaceChannels, { sampleRate: settings.sampleRate, holdMs: settings.holdMs, waitMs: settings.waitMs });
            scheduleSourceUi();
            status('workspace-grid-state', '同步表设置已应用'); el('workspace-grid-state').classList.remove('is-error'); saveSoon();
        } catch (error) {
            el('workspace-grid-state').classList.add('is-error'); status('workspace-grid-state', error.message);
        }
    }, listen);
    function endConnectionStream(source) {
        source.connected = false;
        source.capture.endStream();
        if (sendConnectionId === source.settings.id) { sendController.stop(); commandRunner.stop(); }
    }
    function watchTransport(source, adapter) {
        const current = () => !disposed && source.adapter === adapter &&
            (source === primarySource || connectionSources.get(source.settings.id) === source);
        adapter.onData((bytes, stamp) => {
            if (current()) source.capture.receive(bytes, stamp);
        });
        adapter.onStatusChange((connected, error) => {
            if (!current()) return;
            if (connected) source.connected = true;
            else endConnectionStream(source);
            source.error = error?.message ?? '';
            syncConnection(); scheduleSourceUi();
        });
    }
    function releaseTransport(adapter) {
        adapter.onData(null); adapter.onStatusChange(null);
        void (adapter.dispose ? adapter.dispose() : adapter.disconnect());
    }
    function replaceConnectionSettings(source, settings) {
        const previous = source.settings, adapter = source.adapter;
        const serial = settings.mode === 'serial';
        source.settings = settings;
        if (serial !== (previous.mode === 'serial')) {
            if (source.connected) endConnectionStream(source);
            if (!serial) portBindings.remove(settings.id);
            source.bindingMessage = '';
            if (source === primarySource) {
                source.adapter = serial ? serialAdapter : netAdapter;
                void adapter.disconnect();
            } else {
                source.adapter = createTransport(settings.mode);
                watchTransport(source, source.adapter);
                releaseTransport(adapter);
            }
        } else {
            const keys = serial ? ['baudRate', 'dataBits', 'stopBits', 'parity']
                : ['mode', 'host', 'port', 'localPort'];
            if (source.connected && keys.some(key => previous[key] !== settings[key])) void adapter.disconnect();
        }
    }
    async function authorizedPorts() {
        const serial = navigator.serial;
        if (!serial) throw new Error('当前浏览器不支持 Web Serial API');
        return typeof serial.getPorts === 'function' ? await serial.getPorts() : null;
    }
    function isCurrentConnection(source, revision) {
        return !disposed && revision === importRevision &&
            (source === primarySource || connectionSources.get(source.settings.id) === source);
    }
    async function bindSerialPort(source) {
        if (connectionBusy || source.settings.mode !== 'serial' || source.connected || source.pending || disposed) return;
        const revision = importRevision, id = source.settings.id;
        connectionBusy = source.pending = true;
        source.error = ''; syncConnection();
        try {
            if (!navigator.serial?.requestPort) throw new Error('当前浏览器不支持 Web Serial API');
            const port = await navigator.serial.requestPort();
            const grants = await authorizedPorts().catch(() => null);
            if (!isCurrentConnection(source, revision)) return;
            portBindings.bind(id, port, grants);
            source.bindingMessage = '已绑定端口';
            saveSoon();
        } catch (error) {
            if (isCurrentConnection(source, revision) && error.name !== 'NotFoundError' && error.name !== 'AbortError')
                source.error = '绑定失败：' + error.message;
        } finally {
            connectionBusy = source.pending = false;
            if (!disposed) syncConnection();
        }
    }
    function networkOptions({ mode, host, port, localPort }) {
        const remote = S.parsePort(port);
        if (mode === 'tcp-server') return { mode, port: remote, localPort: remote };
        const address = typeof host === 'string' ? host.trim() : '';
        if (!address) throw new Error('请输入远端地址');
        const local = String(localPort ?? '').trim();
        return mode === 'udp' ? { mode, host: address, port: remote, localPort: local ? S.parsePort(local) : remote }
            : { mode, host: address, port: remote };
    }
    async function changeConnections(sources, connect) {
        if (connectionBusy || disposed) return;
        const revision = importRevision, selected = sources.filter(source => source.connected !== connect && !source.pending);
        if (!selected.length) return;
        const savedHints = JSON.stringify(portBindings.snapshot());
        connectionBusy = true;
        for (const source of selected) { source.pending = true; source.error = ''; }
        syncConnection();
        try {
            const grants = connect && selected.some(source => source.settings.mode === 'serial') ? authorizedPorts() : null;
            await Promise.all(selected.map(async source => {
                if (!isCurrentConnection(source, revision)) return;
                const { adapter, settings } = source;
                try {
                    if (!connect) {
                        await adapter.disconnect();
                        if (isCurrentConnection(source, revision) && source.connected) endConnectionStream(source);
                        return;
                    }
                    if (settings.mode !== 'serial') {
                        await adapter.connect(networkOptions(settings));
                        return;
                    }
                    const authorized = await grants;
                    if (!isCurrentConnection(source, revision)) return;
                    const { id, baudRate, dataBits, stopBits, parity } = settings;
                    const match = portBindings.resolve(id, authorized);
                    source.bindingMessage = match.issue ?? '已绑定端口';
                    if (!match.port) return;
                    await adapter.connect({ baudRate: Number(baudRate), dataBits: Number(dataBits), stopBits: Number(stopBits), parity },
                        match.port);
                    if (isCurrentConnection(source, revision)) portBindings.ports.set(id, match.port);
                } catch (error) {
                    if (error.name !== 'AbortError' && isCurrentConnection(source, revision))
                        source.error = (connect ? '连接失败：' : '断开失败：') + error.message;
                }
            }));
            if (connect && revision === importRevision && savedHints !== JSON.stringify(portBindings.snapshot())) saveSoon();
        } finally {
            connectionBusy = false;
            for (const source of selected) source.pending = false;
            if (!disposed) { syncConnection(); scheduleSourceUi(); }
        }
    }
    function dropConnectionSource(source) {
        const { id } = source.settings;
        connectionSources.delete(id); portBindings.remove(id); connectionView.remove(id);
        delete workspaceChannels.timebases[id];
        source.capture.dispose(); releaseTransport(source.adapter);
    }
    function installConnectionSources(config) {
        replaceConnectionSettings(primarySource, primaryConnectionSettings());
        nextConnectionSourceNumber = config.nextNumber;
        const ids = new Set(config.entries.map(entry => entry.id));
        const limit = captureQuota(globals, ids.size);
        for (const source of connectionSources.values()) if (!ids.has(source.settings.id)) dropConnectionSource(source);
        for (const settings of config.entries) {
            const source = connectionSources.get(settings.id);
            if (!source) createConnectionSource(settings, limit);
            else {
                replaceConnectionSettings(source, settings);
                connectionView.refresh(source);
                const { capture } = source;
                capture.rebuildHistory = settings.rebuildHistory;
                capture.setCapacity(Number(globals.maxPoints));
                void capture.setMaxRawFrameBytes(globals.maxRawFrameBytes);
                const engine = capture.dataEngine, next = S.WidgetConfig.serialSourceGlobals(globals, settings);
                const changed = engine.globals.channelsCount !== next.channelsCount ||
                    JSON.stringify(engine.globals.channelDefinitions) !== JSON.stringify(next.channelDefinitions) ||
                    JSON.stringify(engine.serialize()) !== JSON.stringify(settings.engine);
                Object.assign(engine.globals, next, { rebuildHistory: settings.rebuildHistory });
                capture.channelNames = next.channelNames;
                if (changed) void engine.apply(settings.engine, { force: true }).catch(report);
                else for (const output of capture.sources) if (output.kind === 'numeric') {
                    output.frames.channelNames = next.channelNames; output.frames.names = next.channelNames;
                }
            }
        }
        portBindings.load(config.bindings);
        for (const source of allConnections()) source.bindingMessage = '';
        applyCaptureQuotas();
    }
    listen(el('serial-source-add'), 'click', () => {
        let number = nextConnectionSourceNumber;
        while (Number.isSafeInteger(number + 1) && widgets.widgets.has('serial-' + number)) number++;
        status('serial-source-add-status', '');
        try {
            if (!Number.isSafeInteger(number + 1)) throw new Error('接收来源编号已达上限');
            const { netHost, netPort, netLocalPort } = S.WidgetConfig.GLOBAL_DEFAULTS;
            const settings = S.WidgetConfig.normalizeConnectionSource({ ...primaryConnectionSettings(), id: 'serial-' + number,
                mode: 'serial', name: '来源 ' + number, host: netHost, port: netPort, localPort: netLocalPort, timeOffsetMs: 0 });
            const limit = captureQuota(globals, connectionSources.size + 1);
            const engine = dataEngine.serialize();
            S.preflightDataEngine(engine, globals, { memoryLimitBytes: limit });
            createConnectionSource({ ...settings, channelCount: Number(globals.channelsCount),
                engine: { ...engine, mode: 'Raw_Data', draft: null } }, limit);
            nextConnectionSourceNumber = number + 1;
            applyCaptureQuotas(); refreshConnectionChoices(); syncConnection(); saveSoon();
            connectionView.revealSource(settings.id);
        } catch (error) { status('serial-source-add-status', error.message); }
    });
    const workspace = new S.WidgetWorkspace({ document, window, viewport: el('workspace-viewport'), surface: el('workspace-surface'),
        step: initial.workspace.step, zoom: initial.workspace.zoom,
        onZoomChange: zoom => {
            el('workspace-zoom-percent').value = String(Math.round(zoom * 100));
            for (const widget of widgets?.widgets.values() ?? []) {
                // Synchronize the log offset before the browser reports zoom-induced scrolling.
                if (widget.type === 'byte') widget.view.render();
                else widget.view.resize();
            }
        },
        onActivate: id => widgets?.activate(id), onResize: id => widgets?.resize(id),
        onDelete: id => widgets?.requestRemove(id), onDrop: ({ type, rect }) => widgets?.create({ type, rect }), onLayoutChange: saveSoon });
    widgets = new S.WidgetController({ document, service, globals, workspace, getConnections: connectionChoices, getPrimaryConnectionName: primaryConnectionName,
        getWorkspaceCapture: () => workspaceChannels,
        onTextPreparation: (widget, fraction, done, total) => setTaskProgress(widget,
            fraction === null || !total ? null : '正在准备字节流文本 · ' + widget.title, fraction,
            total ? bytesLabel(done) + ' / ' + bytesLabel(total) : ''),
        onChange() {
            if (!widgets || disposed) return;
            tools?.syncSources(); syncExportSources(); showProgress(null, null); saveSoon();
        },
        onRulesChange() { tools?.invalidate(); rates.clear(); syncExportSources(); },
        onChannelMetadataChange(index, patch, capture) {
            if (engineView?.engine.service === capture) engineView.channels.updateMetadata(index, patch);
            if (capture === workspaceChannels) workspaceChannelView?.updateMetadata(index, patch);
        },
        onBeforeChannelRenumber(numberMap, capture) {
            if (capture === workspaceChannels) workspaceChannelView?.remapDrafts(numberMap, capture);
            else engineView?.channels.remapDrafts(numberMap, capture);
            if (capture === service) {
                saveExportProfile(); boundExportSourceId = null;
                for (const settings of Object.values(exportProfiles)) for (const profile of Object.values(settings.formats))
                    if (profile.channelIndices !== null) profile.channelIndices = profile.channelIndices
                        .filter(index => numberMap.has(index + 1)).map(index => numberMap.get(index + 1) - 1);
            }
            if (tools?.selectedChannels && widgets.active?.capture === capture) tools.selectedChannels = new Set([...tools.selectedChannels]
                .filter(index => numberMap.has(index + 1)).map(index => numberMap.get(index + 1) - 1));
        },
        onActivate() { tools?.syncSources(); syncExportSources(); }
    });
    engineView = new S.DataEngineView({ document, engine: dataEngine, controller: widgets, onChange: saveSoon,
        onTabChange: tab => connectionView.handleTab(tab),
        getSourceName: () => allConnections().find(source => source.capture.dataEngine === engineView.engine)?.settings.name,
        onProtocolOpen() {
            const opener = el('engine-protocol-edit');
            if (!connectionView.enginePage) {
                const source = allConnections().find(source => source.capture.dataEngine === engineView.engine) ?? primarySource;
                connectionView.showEngine(source, () => engineView.editor.close());
            }
            connectionView.showProtocol(opener, () => engineView.editor.close());
        },
        onProtocolClose: () => connectionView.returnFromProtocol(),
        onSampleProgress: progress => setTaskProgress('protocol-samples',
            progress && '协议样例 · ' + progress.label, progress?.fraction, progress?.counter),
        async onSaveProtocolDraft() {
            if (!await saveNow()) throw new Error('未能写入配置存储');
        },
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
        onApply(engine) {
            if (workspaceChannels.mappings.length) { workspaceChannels.clear(); scheduleWorkspaceReplay(); }
            tools?.invalidate(); rates.clear(); syncExportSources();
            if (engine === sendingEngine()) { regularProtocolView.refresh(); commandView.render(); }
        } });
    workspaceChannelView = new S.EngineChannelView({ document, root: el('workspace-channel-panel'), controller: widgets,
        capture: workspaceChannels, onChange: saveSoon });
    function resolveAlignedIndex({ target, origin, timestamp, byteOffset, originIndex }) {
        const sourceId = widget => widget?.settings.connectionSource ?? 'primary';
        const from = sourceId(origin), to = sourceId(target), shared = workspaceChannels.numericSource.frames;
        const active = workspaceChannels.appliedTimebases;
        const projected = id => Boolean(active[id]?.mode && active[id].mode !== 'receive');
        const merged = from === 'workspace' || to === 'workspace';
        if (!projected(from) && !projected(to) && !merged) return undefined;
        const originalFrames = origin?.source.frames;
        const sourceOffset = Number.isFinite(byteOffset) ? byteOffset : originalFrames?.rawByteOffsetAt?.(originIndex);
        const time = from === 'workspace' ? timestamp : projected(from) ? shared.locateOrigin(from, sourceOffset, true)?.origin.alignedTime
            : workspaceChannels.plotTime(timestamp) + (connectionSources.get(from)?.settings.timeOffsetMs ?? 0);
        const targetFrames = target?.source.frames;
        if (!targetFrames?.length || !Number.isFinite(time)) return -1;
        if (projected(to)) {
            const match = shared.locateOrigin(to, time);
            if (!match) return -1;
            const offset = match.origin.byteOffset;
            const index = S.FrameNavigation.frameIndexAtByteOffset(targetFrames, offset);
            const frame = targetFrames.frameAt(index, { copyBytes: false });
            return frame && frame.byteOffset <= offset && offset < frame.endByte ? index : -1;
        }
        const targetTime = to === 'workspace' ? time : workspaceChannels.receiveTime(time - (connectionSources.get(to)?.settings.timeOffsetMs ?? 0));
        if (targetTime < targetFrames.timestampAt(0) || targetTime > targetFrames.timestampAt(targetFrames.length - 1)) return -1;
        return targetFrames.nearestTimestampIndex(targetTime);
    }
    tools = new S.WorkspaceTools({ document, service, getWidgets: () => widgets.widgets, getAlignedIndex: resolveAlignedIndex,
        toCaptureTime: time => workspaceChannels.plotTime(time), toWallTime: time => workspaceChannels.receiveTime(time),
        getActiveWidget: () => widgets.active,
        getChannelNames: () => widgets.active?.capture.dataEngine.globals.channelNames ?? globals.channelNames,
        getTimeOffset: widget => connectionSources.get(widget?.settings.connectionSource)?.settings.timeOffsetMs ?? 0,
        onSearchProgress: progress => setTaskProgress('search', progress && '搜索中 · ' + progress.title, progress?.fraction,
            progress ? itemsProcessed(progress.done, progress.total, '条') : ''),
        onTimeProgress: progress => setTaskProgress('time-jump', progress && '正在定位时间',
            progress ? progress.done / progress.total : null,
            progress ? itemsProcessed(progress.done, progress.total, '条') : ''),
        onStateChange: saveSoon });
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
        const title = primaryConnectionName() + ' · 原始记录';
        const items = [{ id: 'base', title, source: service.baseSource, aliases: ['base'], associated: [] }];
        for (const { settings, capture } of connectionSources.values())
            items.push({ id: settings.id, title: settings.name + ' · 原始记录', source: capture.baseSource, capture, aliases: [settings.id], associated: [] });
        for (const widget of widgets.widgets.values()) {
            if (widget.type !== 'byte' || widget.source.kind !== 'raw') continue;
            let item = items.find(entry => entry.source === widget.source);
            if (!item) {
                item = { id: widget.id, title: '指定字节流的记录 · ' + widget.title, source: widget.source,
                    aliases: [], associated: [], capture: widget.capture };
                items.push(item);
            }
            item.aliases.push(widget.id); item.associated.push(widget.title);
        }
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
            const active = widgets.active, engine = active?.capture.dataEngine;
            widgetExportSelection = S.widgetExportSelection(active, engine?.globals.channelNames, engine?.mode);
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
        if (selected.widget.capture === workspaceChannels && (format === 'binary' || format === 'hex-text'))
            return '请在左侧「导出数据」中按通讯来源导出原始字节。此处可导出全局通道的 TXT 或 CSV。';
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
        el('wrap-export-source').hidden = direction === 'tx' && !connectionSources.size;
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
    async function writeExport(view, options, buffers, check, makeChunks, metadataSize = 0) {
        const csv = options.format === 'csv', binary = options.format === 'binary';
        const text = options.format === 'text' || options.format === 'engine-text';
        const extension = csv ? 'csv' : binary ? 'bin' : text ? 'txt' : 'hex';
        const filename = 'Scientific_Plot_Export_' + Date.now() + '.' + extension;
        const large = buffers.reduce((sum, buffer) => sum + buffer.length, 0) > 50000 ||
            buffers.reduce((sum, buffer) => sum + buffer.retainedByteLength, metadataSize) > 32 * 1024 * 1024;
        const statusId = view.prefix + '-source-status';
        exporting = true; syncExportAvailability();
        const key = 'export';
        let writable, failure = '', writtenBytes = 0, processed = 0, total = 0;
        const updateProgress = (label = '正在导出数据') => setTaskProgress(key, label, total ? processed / total : null,
            [total ? itemsProcessed(processed, total, '条') : '', writtenBytes ? '已输出 ' + bytesLabel(writtenBytes) : '']
                .filter(Boolean).join(' · '));
        const onProgress = (done, count) => { processed = done; total = count; updateProgress(); };
        updateProgress('正在准备导出');
        try {
            if (large) {
                if (typeof window.showSaveFilePicker !== 'function') throw new Error('大容量导出需要支持文件系统保存的 Chrome 或 Edge');
                updateProgress('等待选择导出位置');
                const handle = await window.showSaveFilePicker({ suggestedName: filename }); check();
                updateProgress('正在准备导出');
                writable = await handle.createWritable(); check();
            }
            const encoder = binary ? null : await S.createExportTextEncoder(text ? options.outputEncoding : 'utf-8');
            check();
            const parts = [];
            const writeBytes = async bytes => {
                check();
                if (writable) { await writable.write(bytes); check(); } else parts.push(bytes);
                writtenBytes += bytes.length;
            };
            if (csv) await writeBytes(encoder.encode('\uFEFF'));
            let written = false, work = 0, nextYield = performance.now() + 12;
            const yieldExport = async () => {
                updateProgress();
                await new Promise(resolve => setTimeout(resolve, 0)); check();
                work = 0; nextYield = performance.now() + 12;
            };
            for await (const chunk of makeChunks(onProgress)) {
                if (typeof chunk !== 'string') {
                    if (chunk.length) { written = true; await writeBytes(chunk); work += chunk.length; }
                } else for (let start = 0; start < chunk.length;) {
                    let end = Math.min(chunk.length, start + 16384);
                    if (end < chunk.length && (chunk.charCodeAt(end - 1) >= 0xd800 && chunk.charCodeAt(end - 1) <= 0xdbff ||
                        /[\u0304\u030c]/.test(chunk[end]) && /[\u00ca\u00ea]/.test(chunk[end - 1]))) end++;
                    const bytes = encoder.encode(chunk.slice(start, end));
                    written = true; await writeBytes(bytes); work += bytes.length; start = end;
                    if (work >= 262144 || performance.now() >= nextYield) await yieldExport();
                }
                if (work >= 262144 || performance.now() >= nextYield) await yieldExport();
            }
            if (!written) throw new Error('暂无符合条件的记录');
            check();
            if (writable) {
                updateProgress('正在完成文件保存');
                await writable.close(); writable = null;
            }
            else download(parts, filename, binary ? 'application/octet-stream' : csv ? 'text/csv;charset=utf-8' :
                'text/plain;charset=' + (text ? options.outputEncoding : 'utf-8'));
            return true;
        } catch (error) {
            if (writable) try { await writable.abort(); } catch { /* Preserve the original failure. */ }
            if (error.name !== 'AbortError') failure = '导出失败：' + error.message;
            return false;
        } finally {
            setTaskProgress(key); exporting = false; syncExportSources();
            if (failure) status(statusId, failure);
        }
    }
    function exportCheck(buffers, valid, capture = service) {
        const epoch = capture.epoch, orders = buffers.map(buffer => buffer.orderAt(0));
        return () => {
            if (disposed || capture.disposed || capture.epoch !== epoch || !valid() ||
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
            rawExportSource() === source && source.generation === generation && capture.sources.has(source)), capture);
        return writeExport(exportView, options, sources, check,
            onProgress => S.captureExportChunks(source.frames, tx, { ...options, onProgress }));
    }
    async function exportWidgetData() {
        if (exporting || disposed) return false;
        const options = widgetExportView.read(), format = options.format;
        const active = widgets.active, engine = active?.capture.dataEngine;
        const selected = widgetSelectionForFormat(format, S.widgetExportSelection(active, engine?.globals.channelNames, engine?.mode));
        if (widgetExportIssue(format, selected)) return false;
        const { widget, source, channels, channelIndices, fieldPaths } = selected, { frames } = source;
        const wire = format === 'binary' || format === 'hex-text';
        const protocolSource = wire && source.kind === 'numeric' && engine.mode === 'Self_Defined_Frame'
            ? engine.recordsSource : null;
        const buffers = protocolSource ? [frames, protocolSource.frames] : [frames];
        const generation = source.generation, frameGeneration = frames.generation, protocolGeneration = protocolSource?.generation;
        const check = exportCheck(buffers, () => widgets.widgets.get(widget.id) === widget && widget.source === source &&
            source.generation === generation && frames.generation === frameGeneration &&
            (!protocolSource || engine.recordsSource === protocolSource && protocolSource.generation === protocolGeneration), widget.capture);
        const makeChunks = onProgress => {
            const settings = { ...options, check, onProgress, fieldPaths, channelIndices, successfulOnly: true };
            if (wire) return S.parsedByteChunks(selected, protocolSource, settings);
            if (format === 'text') return S.captureExportChunks(frames, widget.capture.txFrames, { ...settings, encoding: selected.encoding });
            if (format === 'engine-text') return S.parsedTextChunks(selected, settings);
            if (source.kind === 'protocol') return S.structuredCsvChunksAsync(frames, source.decodeRecord, settings);
            if (typeof frames.provenanceAt === 'function') return S.synchronizedCsvChunks(frames, channels, settings);
            return S.frameCsvChunks(frames, channels, 1024, settings);
        };
        return writeExport(widgetExportView, options, buffers, check, makeChunks, !wire ? frames.length * (channelIndices?.length ?? 0) * 16 : 0);
    }
    listen(el('btn-export'), 'click', () => { void exportData(); });
    listen(el('btn-widget-export'), 'click', () => { void exportWidgetData(); });
    function syncConnection() {
        const sources = allConnections(), connected = sources.filter(source => source.connected).length;
        el('connection-indicator').classList.toggle('connected', connected > 0);
        el('btn-connect').disabled = connectionBusy || connected === sources.length;
        el('serial-disconnect-all').disabled = connectionBusy || connected === 0;
        el('serial-source-add').disabled = connectionBusy;
        for (const source of sources) {
            const { id, mode } = source.settings;
            source.controlsLocked = connectionBusy;
            source.hasBinding = mode === 'serial' && (portBindings.ports.has(id) || portBindings.hints.has(id));
            source.needsConfirmation = source.hasBinding && !portBindings.ports.has(id) && portBindings.hints.get(id)?.ambiguous;
            connectionView.refresh(source);
        }
        const serialOffline = sources.filter(source => !source.connected && source.settings.mode === 'serial');
        const needsBinding = serialOffline.some(source => !source.hasBinding || source.needsConfirmation || source.bindingMessage.includes('重新确认'));
        const failed = sources.find(source => !source.connected && source.error);
        const offline = serialOffline.some(source => source.bindingMessage.includes('不在线'));
        const detail = connectionBusy ? ' · 正在处理…' : failed ? ' · ' + failed.settings.name + '：' + failed.error
            : needsBinding ? ' · 请在配置中绑定端口' : offline ? ' · 请在配置中查看端口状态' : '';
        status('connection-status', '已连接 ' + connected + ' / ' + sources.length + detail);
        connectionView.syncDialog();
        renderSendConnections();
    }
    function applyGlobalFields() {
        el('max-points').value = globals.maxPoints; el('max-raw-frame-bytes').value = String(globals.maxRawFrameBytes);
        status('engine-raw-limit-status', '');
        el('capture-memory-mib').value = String(globals.captureMemoryMiB);
        el('max-points-label').textContent = '每个来源最大帧数';
        updateMemoryStatus();
        widgets.syncGlobals(); syncConnection();
    }
    for (const [key, id] of [['maxPoints', 'max-points'], ['maxRawFrameBytes', 'max-raw-frame-bytes'],
        ['captureMemoryMiB', 'capture-memory-mib']]) listen(el(id), 'change', () => {
        const candidate = getConfig(); candidate.global[key] = key === 'maxPoints' ? el(id).value : Number(el(id).value);
        try {
            const validated = S.WidgetConfig.validateWorkspaceConfig(candidate);
            if (key === 'captureMemoryMiB') preflightWorkspaceEngines(validated);
            Object.assign(globals, validated.global);
            if (key === 'maxPoints') {
                service.setCapacity(Number(globals.maxPoints)); workspaceChannels.resize(Number(globals.maxPoints)); widgets.setCapacity(Number(globals.maxPoints));
                for (const { capture } of connectionSources.values()) capture.setCapacity(Number(globals.maxPoints));
            }
            else if (key === 'maxRawFrameBytes') {
                void service.setMaxRawFrameBytes(globals.maxRawFrameBytes);
                for (const { capture } of connectionSources.values()) {
                    capture.rebuildHistory = capture.dataEngine.globals.rebuildHistory;
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
    let sendConnectionId = initial.send.connectionSource;
    const sendingEngine = () => sendConnectionId === 'primary' ? dataEngine : connectionSources.get(sendConnectionId)?.capture.dataEngine;
    const protocolSession = new S.ProtocolSendSession({ getProtocols: () => sendingEngine()?.config.protocols ?? [],
        getProtocol: id => sendingEngine()?.config.protocols.find(schema => schema.id === id) });
    const regularProtocolView = new S.ProtocolSendView({ root: el('protocol-send-panel'), session: protocolSession,
        value: initial.send.protocol ?? {}, onChange: saveSoon });
    const commandLibrary = new S.CommandLibrary(initial.send.commands);
    commandLibrary.setProtocolResolver(id => protocolSession.getProtocol(id));
    let commandView = null, sendTab = 'regular';
    function renderSendConnections() {
        const select = el('send-connection-source');
        const items = allConnections().map(source => ({
            id: source.settings.id, name: source.settings.name, connected: source.connected
        }));
        if (!items.some(item => item.id === sendConnectionId)) sendConnectionId = 'primary';
        el('send-connection-target').hidden = items.length === 1;
        select.replaceChildren(...items.map(({ id, name, connected }) => {
            const option = document.createElement('option'); option.value = id;
            option.textContent = name + (connected ? '' : '（未连接）'); return option;
        }));
        select.value = sendConnectionId;
    }
    function getSendEngine() {
        if (disposed) return null;
        const target = sendConnectionId === 'primary' ? primarySource : connectionSources.get(sendConnectionId);
        return target?.connected ? target.adapter : null;
    }
    function captureForTransport(transport = serialAdapter) {
        if (transport === serialAdapter || transport === netAdapter) return service;
        return [...connectionSources.values()].find(source => source.adapter === transport)?.capture;
    }
    listen(el('send-connection-source'), 'change', () => {
        const id = el('send-connection-source').value;
        if (id === sendConnectionId || id !== 'primary' && !connectionSources.has(id)) return;
        sendController.stop(); commandRunner.stop();
        sendConnectionId = id;
        regularProtocolView.refresh(); commandView?.render(); saveSoon();
    });
    const commandRunner = new S.CommandRunner({ library: commandLibrary, protocolSession,
        getEngine: getSendEngine,
        send: (bytes, isCurrent) => sendController.sendBytes(bytes, isCurrent),
        beforeStart: () => sendController.stop(),
        onState: state => commandView?.setState(state),
        onError: error => commandView?.showError(error) });
    const sendController = new S.SendController({ protocolSession, getProtocolCommand: () => regularProtocolView.getCommand(), mode: el('send-mode'), input: el('send-input'), fileInput: el('send-file-input'),
        interval: el('send-interval'), intervalUnit: el('send-interval-unit'), button: el('btn-send'), loadButton: el('btn-load-file'),
        getEngine: getSendEngine,
        onStart: () => commandRunner.stop(),
        onSent(bytes, transport) {
            const capture = captureForTransport(transport);
            if (!capture) return;
            const record = capture.appendTx(bytes);
            widgets.appendExtra(record, undefined, capture); syncExportAvailability();
        },
        onInputError: report,
        onSendError(error, bytes, transport) {
            const capture = captureForTransport(transport), timestamp = Date.now();
            if (capture) widgets.appendExtra({ kind: 'tx-error', bytes, reason: error.message, order: capture.nextOrder++, timestamp,
                time: S.RawFrameParser.formatTime(timestamp) }, undefined, capture);
            const slot = allConnections().find(source => source.adapter === transport);
            if (slot) { slot.error = error.message; connectionView.refresh(slot); }
            else status('connection-status', error.message);
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
    for (const adapter of [serialAdapter, netAdapter]) watchTransport(primarySource, adapter);
    listen(el('serial-disconnect-all'), 'click', () => { void changeConnections(allConnections(), false); });
    listen(el('btn-connect'), 'click', () => { void changeConnections(allConnections(), true); });
    function setPaused(paused) {
        workspaceChannels.setPaused(Boolean(paused), service.wallNow());
        service.pause(paused);
        if (!paused) scheduleSourceUi();
        for (const { capture } of connectionSources.values()) capture.pause(paused);
        if (paused) pumpWorkspaceChannels(true);
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
        for (const { capture } of connectionSources.values()) capture.clear();
        workspaceChannels.clear();
        workspaceChannels.pauses.length = 0;
        if (workspaceChannels.paused) workspaceChannels.pauseStarted = service.wallNow();
        tools.invalidate(); rates.clear(); draws.clear();
        for (const widget of widgets.widgets.values()) widget.view.clear();
        previousStats = { time: performance.now(), rx: 0, tx: 0, epoch: service.epoch };
        cancelAlignmentReplay(); showProgress();
        setTaskProgress('export');
        tools.syncPaused(); updateStats(); syncExportAvailability();
    });
    function updateMemoryStatus() {
        const state = service.memoryUsage();
        for (const { capture } of connectionSources.values()) {
            const other = capture.memoryUsage();
            state.usedBytes += other.usedBytes; state.evictedFrames += other.evictedFrames;
            state.blockedReason ||= other.blockedReason;
        }
        if (workspaceChannels.mappings.length) state.usedBytes += workspaceChannels.numericSource.frames.estimatedMemoryBytes;
        const used = (state.usedBytes / 1048576).toFixed(1), limit = Number(globals.captureMemoryMiB);
        let message = `采集估算：${used} / ${limit} MiB`;
        if (state.evictedFrames) message += `；已按预算淘汰 ${state.evictedFrames.toLocaleString()} 条来源记录`;
        if (state.blockedReason) message += '；' + state.blockedReason;
        status('capture-memory-status', message);
    }
    function updateStats() {
        if (disposed) return;
        service.memory.enforce();
        for (const source of connectionSources.values()) { source.capture.memory.enforce(); connectionView.refresh(source); }
        updateMemoryStatus();
        const now = performance.now(), elapsed = Math.max(0.001, (now - previousStats.time) / 1000);
        const sameEpoch = previousStats.epoch === service.epoch;
        const rxRate = sameEpoch ? Math.max(0, service.stats.rxBytes - previousStats.rx) / elapsed : 0;
        const txRate = sameEpoch ? Math.max(0, service.stats.txBytes - previousStats.tx) / elapsed : 0;
        const sourceRates = new Map(), captures = [service];
        for (const slot of connectionSources.values()) {
            const { capture } = slot, previous = slot.previousStats, interval = Math.max(.001, (now - (previous?.time ?? now)) / 1000);
            const same = previous?.epoch === capture.epoch;
            slot.rates = { rxRate: same ? (capture.stats.rxBytes - previous.rx) / interval : 0,
                txRate: same ? (capture.stats.txBytes - previous.tx) / interval : 0 };
            slot.previousStats = { time: now, epoch: capture.epoch, rx: capture.stats.rxBytes, tx: capture.stats.txBytes };
            captures.push(capture);
        }
        for (const capture of captures) for (const source of capture.sources) {
            if (source.rebuilding) { rates.delete(source); sourceRates.set(source, 0); continue; }
            const previous = rates.get(source), count = source.parser.frameCount;
            const same = previous && previous.epoch === capture.epoch && previous.generation === source.generation;
            sourceRates.set(source, same ? Math.max(0, count - previous.count) / elapsed : 0);
            rates.set(source, { count, epoch: capture.epoch, generation: source.generation });
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
                const rate = widget.view.fixedTimeRate || widget.source.sampleRate?.rate;
                if (widget.type === 'wave' && !service.paused && rate > 0 && !widget.view.frames.responseMode) widget.view.setSampleRateHz(rate);
            } else {
                const capture = widget.capture;
                const local = capture === service ? { rxRate, txRate } : connectionSources.get(widget.settings.connectionSource)?.rates ?? { rxRate: 0, txRate: 0 };
                widget.refs['stat-rx-value'].textContent = bytesLabel(local.rxRate) + '/s (' + bytesLabel(capture.stats.rxBytes) + ')';
                widget.refs['stat-tx-value'].textContent = bytesLabel(local.txRate) + '/s (' + bytesLabel(capture.stats.txBytes) + ')';
                const text = widget.settings.captureMode === 'text';
                const counts = text ? capture.getTextStats(widget.source, widget.settings.textEncoding) : null;
                widget.refs['stat-fps-value'].textContent = Math.round(sourceRates.get(widget.source) ?? 0) + ' f/s';
                widget.refs['stat-fail-label'].textContent = text ? '失败字符 / 总字符:' : '校验失败:';
                const total = text ? counts.total : widget.source.parser.frameCount + widget.source.parser.failCount;
                const failed = text ? counts.failed : widget.source.parser.failCount;
                const ratio = (total ? (failed / total * 100).toFixed(1) : '0') + '%';
                widget.refs['stat-fail-value'].textContent = text ? `${failed} / ${total} (${ratio})` : ratio;
            }
        }
        for (const source of rates.keys()) if (!hasCaptureSource(source)) rates.delete(source);
        for (const id of draws.keys()) if (!widgets.widgets.has(id)) draws.delete(id);
        previousStats = { time: now, rx: service.stats.rxBytes, tx: service.stats.txBytes, epoch: service.epoch }; syncExportAvailability();
    }
    function getConfig() {
        saveExportProfile(); saveWidgetExportProfile();
        return { version: 3, global: { ...globals, channelNames: [...globals.channelNames], channelRecords: widgets.getChannelRegistry().toJSON() }, widgets: widgets.serialize(),
            workspace: workspace.serialize(), nextNumber: widgets.nextNumber, uiLayout: { ...uiLayout },
            dataEngine: dataEngine.serialize(), workspaceChannels: workspaceChannels.settings, serialSources: { nextNumber: nextConnectionSourceNumber, bindings: portBindings.snapshot(),
                entries: [...connectionSources.values()].map(({ settings, capture }) => {
                    const engine = capture.dataEngine;
                    const { channelsCount, channelNames, channelColors, channelDefinitions, rebuildHistory } = engine.globals;
                    return { ...settings, channelCount: Number(channelsCount), channelNames: [...channelNames], channelColors: [...channelColors],
                        channelDefinitions: channelDefinitions.map(definition => ({ ...definition })),
                        channelRecords: widgets.getChannelRegistry(capture).toJSON(), rebuildHistory, engine: engine.serialize() };
                }) },
            tools: { ...tools.serialize(), exportSourceId: exportRecordSourceId, exportRecordSourceId, exportFormat, widgetExport,
                exportProfiles: JSON.parse(JSON.stringify(exportProfiles)) },
            send: { mode: el('send-mode').value, interval: el('send-interval').value, unit: el('send-interval-unit').value,
                tab: sendTab, connectionSource: sendConnectionId, protocol: regularProtocolView.getDraft(), commands: commandLibrary.serialize() } };
    }
    function installWidgets(config) {
        installConnectionSources(config.serialSources);
        scheduleWorkspaceReplay();
        sendConnectionId = config.send.connectionSource;
        renderSendConnections(); renderWorkspaceChannels(); refreshAlignmentSources();
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
        return applyValidatedConfig(validateStoredConfig(input));
    }
    function applyValidatedConfig(config) {
        connectionView.close(false);
        connectionView.clearFormDrafts();
        cancelAlignmentReplay();
        const wasRestoring = restoring, revision = ++importRevision; restoring = true;
        try {
            for (const source of allConnections()) if (source.pending && !source.connected)
                void source.adapter.disconnect();
            tools.invalidate();
            sendController.stop(); commandRunner.stop();
            for (const id of [...widgets.widgets.keys()]) widgets.remove(id);
            Object.assign(globals, config.global); service.rebuildHistory = globals.rebuildHistory;
            workspaceChannels.resize(Number(globals.maxPoints)); workspaceChannels.configure(config.workspaceChannels);
            service.setMemoryLimit(captureQuota(globals, config.serialSources.entries.length + Number(config.workspaceChannels.mappings.length > 0)));
            // Install validated definitions against the incoming raw count atomically.
            service.channelDefinitions = globals.channelDefinitions; service.channelNames = globals.channelNames;
            service.setCapacity(Number(globals.maxPoints)); void service.setMaxRawFrameBytes(globals.maxRawFrameBytes);
            const ready = dataEngine.apply(config.dataEngine, { rebuild: globals.rebuildHistory, force: true });
            installWidgets(config); rates.clear(); draws.clear();
            engineView.draft = JSON.parse(JSON.stringify(engineView.engine.config.draft ?? engineView.engine.config)); engineView.render(); engineView.channels.refresh();
            ready.then(() => { if (!disposed && revision === importRevision) widgets.rebindEngineSources(); })
                .catch(error => { if (!disposed && revision === importRevision) report(error); });
        } finally { restoring = wasRestoring; }
        storageBlocked = false; storageLoadError = null;
        saveSoon(); return config;
    }
    listen(el('btn-export-cfg'), 'click', () => download([JSON.stringify(getConfig(), null, 2)], 'serialplot-config.json', 'application/json'));
    listen(el('btn-import-cfg'), 'click', () => el('cfg-file-input').click());
    let fileImportRevision = 0;
    function readConfigFile(file, onProgress) {
        if (typeof FileReader !== 'function') return file.text();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onprogress = event => {
                if (event.lengthComputable && event.total) onProgress(event.loaded, event.total);
            };
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.onabort = () => reject(new Error('配置文件读取已取消'));
            reader.readAsText(file);
        });
    }
    listen(el('cfg-file-input'), 'change', async event => {
        const file = event.target.files?.[0]; if (!file) return;
        event.target.value = '';
        const revision = ++fileImportRevision, key = 'config-import';
        const current = () => !disposed && revision === fileImportRevision;
        const canPaint = file.size >= 512 * 1024;
        configProgress(key, '正在读取配置文件', 0);
        try {
            const raw = await readConfigFile(file, (done, total) => {
                if (current()) setTaskProgress(key, '正在读取配置文件', done / total / 3,
                    bytesLabel(done) + ' / ' + bytesLabel(total));
            });
            if (!current()) return;
            configProgress(key, '正在校验导入配置', 1);
            if (canPaint) await paintProgress();
            if (!current()) return;
            const config = validateStoredConfig(JSON.parse(raw));
            configProgress(key, '正在应用导入配置', 2);
            if (canPaint) await paintProgress();
            if (!current()) return;
            applyValidatedConfig(config);
            status('cfg-save-status', '配置已导入');
        } catch (error) { if (current()) report(error); }
        finally { if (current()) setTaskProgress(key); }
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
    const resizeViews = () => { workspace.refresh(); for (const id of widgets.widgets.keys()) widgets.resize(id); };
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
        if (workspaceChannelTimer !== null) clearTimeout(workspaceChannelTimer);
        alignmentReplay?.capture.dispose(); resetTaskProgress();
        workspaceChannelView.dispose(); workspaceChannels.dispose();
        clearInterval(statsTimer); regularProtocolView.dispose(); commandRunner.dispose(); commandView.dispose(); sendController.stop(); sendController.dispose?.(); exportView.dispose(); widgetExportView.dispose();
        engineView.dispose(); tools.dispose(); widgets.dispose(); workspace.dispose();
        connectionView.dispose();
        for (const source of connectionSources.values()) dropConnectionSource(source);
        service.dispose();
        for (const cleanup of cleanups.splice(0)) cleanup();
        for (const adapter of [serialAdapter, netAdapter]) releaseTransport(adapter);
        return workspaceStorage.dispose();
    }
    installWidgets(initial); restoring = false; setTaskProgress('config-restore'); updateStats();
    const statsTimer = setInterval(updateStats, 1000);
    S.application = { service, widgets, workspace, tools, serialAdapter, serialSources: connectionSources, netAdapter, sendController,
        protocolSession, regularProtocolView, commandLibrary, commandRunner, commandView, getConfig, applyConfig, dispose, exportData, exportWidgetData, updateStats,
        dataEngine, engineView, workspaceChannels, workspaceStorage, saveNow, saveSoon, flushConfig };
    listen(window, 'pagehide', dispose);
    return S.application;
}

/** Assemble persistent acquisition and independently configured workspace views. */
document.addEventListener('DOMContentLoaded', () => {
    globalThis.SerialPlotter.applicationReady = startSerialPlotterApplication();
});

async function startSerialPlotterApplication() {
    'use strict';
    const S = globalThis.SerialPlotter, el = id => document.getElementById(id);
    const CONFIG_KEY = 'serialplot_v3_config', WORKSPACE_KEY = 'serialplot_v3_workspace';
    const WORKSPACE_RELOAD_KEY = WORKSPACE_KEY + '_reload';
    const cleanups = [], progressRows = new Map(), captureProgressSources = new Set(), rates = new Map(), draws = new Map();
    const taskProgress = el('history-rebuild-progress'), workspaceTaskSlot = el('workspace-task-slot');
    let disposed = false, restoring = true, saveTimer = null, exporting = false, importRevision = 0;
    let boundExportSourceId = null, boundExportFormat = null, bindingExport = false;
    let widgets = null, tools = null, exportView = null, uiFrame = null, engineView = null, workspaceChannels;
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
    const visibilityGraceMs = 5000, visibilityPauses = [];
    let visibilityStarted = null, visibilityCutoff = null, visibilityTimer = null, manuallyPaused = false;
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
        if (visibilityCutoff) return;
        if (workspaceChannels?.mappings.length) scheduleWorkspaceChannelPump();
        scheduleSourceIndicators();
    }
    function scheduleSourceIndicators() {
        if (disposed || uiFrame !== null) return;
        uiFrame = requestAnimationFrame(() => {
            uiFrame = null;
            if (disposed) return;
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
    workspaceChannels = new S.WorkspaceChannelCapture(initial.workspaceChannels, Number(globals.maxPoints), {
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
    let workspaceChannelTimer = null, workspaceChannelDue = Infinity;
    let workspaceChannelView = null, replayWorkspace = false, alignmentReplay = null, pauseDrain = null;
    let batchingWorkspace = false, workspaceChanged = false;
    function publishWorkspaceChange() {
        if (!workspaceChanged || disposed) return;
        workspaceChanged = false;
        if (!pauseDrain) widgets?.syncData(workspaceChannels.numericSource, {}, workspaceChannels);
        scheduleSourceIndicators();
    }
    workspaceChannels.onChange = () => {
        workspaceChanged = true;
        if (!batchingWorkspace) publishWorkspaceChange();
    };
    function cancelWorkspacePump() {
        if (workspaceChannelTimer !== null) clearTimeout(workspaceChannelTimer);
        workspaceChannelTimer = null;
        workspaceChannelDue = Infinity;
    }
    function wakeWorkspacePump() {
        if (document.hidden || !workspaceChannels.mappings.length) return;
        cancelWorkspacePump();
        scheduleSourceUi();
    }
    listen(document, 'visibilitychange', () => { syncCaptureVisibility(); wakeWorkspacePump(); });
    listen(window, 'focus', wakeWorkspacePump);
    function scheduleWorkspaceChannelPump(delay = 0) {
        if (disposed || visibilityCutoff || service.paused && !pauseDrain && !replayWorkspace && !alignmentReplay) return;
        const due = performance.now() + delay;
        if (workspaceChannelTimer !== null) {
            if (workspaceChannelDue <= due) return;
            clearTimeout(workspaceChannelTimer);
        }
        workspaceChannelDue = due;
        // Parse and align received batches independently of the browser paint cycle.
        workspaceChannelTimer = setTimeout(() => {
            workspaceChannelTimer = null;
            pumpWorkspaceChannels();
        }, delay);
    }
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
    function finishPauseDrain() {
        if (!pauseDrain) return;
        pauseDrain = null;
        workspaceChanged = false;
        setTaskProgress('pause-alignment');
        widgets.syncData(workspaceChannels.numericSource, {}, workspaceChannels);
        widgets.setWorkspacePresentationDeferred(false);
        tools?.syncPaused();
        scheduleSourceIndicators();
    }
    function reportPauseDrain(capture) {
        let done = 0, total = 0;
        for (const [id, target] of pauseDrain.targets) {
            const count = Math.max(0, target.last - target.start + 1);
            const cursor = capture.cursors.get(id);
            const scanned = cursor?.source === target.source ? cursor.readFrame : null;
            total += count;
            done += Math.max(0, Math.min(count, (scanned ?? target.start - 1) - target.start + 1));
        }
        const scanning = done < total;
        setTaskProgress('pause-alignment', scanning ? '正在整理暂停前的数据' : '正在整理暂停前的数据 · 完成同步采样',
            scanning ? done / total : null, scanning ? itemsProcessed(done, total, '帧') : '');
    }
    function pumpWorkspaceChannels(firstPauseBatch = false) {
        if (disposed || visibilityCutoff) return;
        if (alignmentReplay && alignmentReplay.epoch !== workspaceChannels.epoch) cancelAlignmentReplay();
        if (pauseDrain && (!workspaceChannels.mappings.length || pauseDrain.epoch !== workspaceChannels.epoch)) finishPauseDrain();
        if (!workspaceChannels.mappings.length || service.paused && !pauseDrain && !replayWorkspace && !alignmentReplay) return;
        const inputs = allConnections(), cutoff = service.paused ? Infinity : Date.now();
        let next;
        batchingWorkspace = true;
        try {
            if (alignmentReplay && alignmentReplay.definitions !== workspaceChannels.settings.channelDefinitions)
                restartAlignmentReplay();
            const replay = alignmentReplay?.capture, capture = replay ?? workspaceChannels;
            if (replay) {
                if (replay.capacity !== workspaceChannels.capacity) replay.resize(workspaceChannels.capacity);
                alignmentReplay.targets ??= alignmentScanTargets(inputs, replay);
            }
            // Drain more than one bounded batch when there is backlog, then yield to receive and paint.
            const deadline = performance.now() + 6;
            let batches = 0;
            do {
                next = capture.collect(inputs, cutoff, undefined, pauseDrain?.targets);
            } while (Number.isFinite(next) && next <= cutoff &&
                ++batches < (firstPauseBatch ? 1 : 8) && performance.now() < deadline);
            const pending = Number.isFinite(next);
            const caughtUp = !pending || next > cutoff;
            if (replay) {
                if (caughtUp && (replay.numericSource.frames.length || !workspaceChannels.numericSource.frames.length)) {
                    workspaceChannels.finishAlignmentReplay(replay);
                    alignmentReplay = null; setTaskProgress('alignment');
                    tools?.invalidate();
                } else reportAlignmentReplay(replay, caughtUp);
            }
            if (pauseDrain) {
                if (pending) reportPauseDrain(capture);
                else finishPauseDrain();
            }
            replayWorkspace = replayWorkspace && pending;
            if (pending) scheduleWorkspaceChannelPump(Math.max(0, Math.min(1000, next - cutoff)));
        } catch (error) {
            cancelAlignmentReplay();
            finishPauseDrain();
            report(error); replayWorkspace = false;
        } finally {
            batchingWorkspace = false;
            publishWorkspaceChange();
        }
    }
    const serialAdapter = new S.SerialEngine(), netAdapter = new S.NetEngine();
    const portBindings = new S.SerialPortBindings(initial.serialSources.bindings);
    const bridgeBindings = new Map();
    const bridgeTokenKey = 'serialplot_bridge_access';
    let bridgeToken = '', bridgeBindingSource = null, bridgePorts = [], bridgeListRevision = 0;
    const bridgeBindingDialog = el('bridge-serial-binding');
    let bridgeAuthorization = null;
    const bridgeRevokedMessage = 'Bridge 已由另一个页面接管，当前页面保留已采集数据。';
    const bridgeWorkspace = new S.BridgeWorkspace(() => {
        rememberBridgeToken('');
        if (connectionView.dialog.open) status('serial-config-status', bridgeRevokedMessage);
        syncConnection();
    });
    let bridgeStatusTimer = null, bridgeStatusRevision = 0;
    const { isSerialConnectionMode } = S.WidgetConfig;
    try { bridgeToken = window.sessionStorage?.getItem(bridgeTokenKey) ?? ''; } catch { /* Storage may be unavailable for file pages. */ }
    const primaryFields = { mode: 'connType', name: 'serialName', baudRate: 'serialBaud', dataBits: 'serialData',
        stopBits: 'serialStop', parity: 'serialParity', host: 'netHost', port: 'netPort', localPort: 'netLocalPort' };
    function primaryConnectionSettings() {
        const settings = Object.fromEntries(Object.entries(primaryFields).map(([key, globalKey]) => [key, globals[globalKey]]));
        // Older configurations could keep a separate local port in TCP server mode.
        if (settings.mode === 'tcp-server' && settings.localPort) settings.port = settings.localPort;
        return { id: 'primary', ...settings };
    }
    const primarySource = { adapter: createTransport(globals.connType, true), capture: service,
        connected: false, pending: false, error: '', bindingMessage: '', settings: primaryConnectionSettings() };
    let connectionBusy = false;
    function primaryConnectionName() { return primarySource.settings.name; }
    function connectionChoices() {
        return [...connectionSources.values()].map(source => ({ id: source.settings.id, name: source.settings.name, capture: source.capture }));
    }
    function hasCaptureSource(source) {
        return service.sources.has(source) || [...connectionSources.values()].some(item => item.capture.sources.has(source));
    }
    const timebaseControls = (prefix, offset) => ({
        offset: el(offset), mode: el(prefix + '-timebase-mode'),
        rate: el(prefix + '-timebase-rate'), fixed: el(prefix + '-timebase-fixed')
    });
    const samplingControls = prefix => ({
        method: el(prefix + '-grid-method'), statusId: prefix + '-timebase-state',
        fixed: el(prefix + '-resync-fixed'), resync: el(prefix + '-resync-enabled'),
        delay: el(prefix + '-resync-delay'), batches: el(prefix + '-resync-batches'),
        confirmation: el(prefix + '-resync-confirmation')
    });
    const dialogAlignment = {
        container: el('serial-config-alignment'), source: () => connectionView.selectedSource,
        timebase: timebaseControls('channel', 'serial-config-offset'), sampling: samplingControls('channel'),
        feedbackId: 'channel-alignment-status', drafts: new Map()
    };
    function sidebarTimingPanel(group, controls) {
        const picker = el('sidebar-' + group + '-source');
        return { ...controls, picker, feedbackId: 'sidebar-' + group + '-status',
            container: el(group === 'alignment' ? 'sidebar-time-alignment-group' : 'sidebar-sampling-group'),
            source: () => picker.value === 'primary' ? primarySource : connectionSources.get(picker.value) };
    }
    const sidebarPanels = [
        sidebarTimingPanel('alignment', { timebase: timebaseControls('sidebar', 'sidebar-config-offset') }),
        sidebarTimingPanel('sampling', { sampling: samplingControls('sidebar') })
    ];
    const alignmentPanels = [dialogAlignment, ...sidebarPanels];

    function showTimebaseFields(panel, source = panel.source()) {
        const { timebase, sampling } = panel;
        const mode = timebase?.mode.value ?? workspaceChannels.timebases[source?.settings.id]?.mode;
        if (timebase) timebase.fixed.hidden = mode !== 'fixed';
        if (sampling) {
            sampling.fixed.hidden = mode !== 'fixed';
            sampling.delay.disabled = sampling.batches.disabled = sampling.confirmation.disabled = !sampling.resync.checked;
        }
    }
    function renderAlignmentTimebaseStatus() {
        for (const { source: selectedSource, sampling } of alignmentPanels) {
            if (!sampling) continue;
            const { statusId } = sampling, source = selectedSource();
            const id = source?.settings.id;
            const mapped = id && workspaceChannels.mappings.some(entry => entry.sourceId === id);
            const live = workspaceChannels.cursors.get(id);
            const fixed = workspaceChannels.timebases[id]?.mode === 'fixed';
            const messages = [];
            if (id && !mapped && fixed) messages.push('此来源尚未映射到全局通道。');
            if (mapped) {
                const capture = alignmentReplay?.capture ?? workspaceChannels;
                const evicted = capture.cursors.get(id)?.evictedUnread;
                if (evicted) messages.push('对齐前已淘汰 ' + evicted.toLocaleString() + ' 帧');
                if (fixed && !alignmentReplay) {
                    if (!live) messages.push('等待可解析的帧。');
                    else if (live.invalidLatest) messages.push('最近的帧缺少有效的时基值，已保留原始记录。');
                    else if (live.lastResync) messages.push('最近一次自动重同步估算跳过 ' + live.lastResync.toLocaleString() + ' 帧。');
                }
            }
            const message = messages.join(' · ');
            if (el(statusId).textContent !== message) status(statusId, message);
        }
    }
    function setTimingFeedback(panel, message = '', error = false) {
        el(panel.feedbackId).classList.toggle('is-error', error);
        status(panel.feedbackId, message);
    }
    function renderAlignmentTimebase(panel, source = panel.source(), changed = panel) {
        panel.currentSource = source;
        const { timebase, sampling } = panel;
        const timing = S.normalizeSourceTimebase(source && workspaceChannels.timebases[source.settings.id]);
        if (timebase && changed.timebase) {
            timebase.offset.disabled = !source || source === primarySource;
            timebase.offset.value = String(source?.settings.timeOffsetMs ?? 0);
            timebase.mode.value = timing.mode;
            timebase.rate.value = String(timing.sampleRate);
        }
        if (sampling && changed.sampling) {
            sampling.resync.checked = timing.resyncEnabled;
            sampling.delay.value = String(timing.resyncDelayMs);
            sampling.batches.value = String(timing.resyncBatches);
            sampling.confirmation.value = String(timing.resyncConfirmationMs);
            sampling.method.value = workspaceChannels.methods[source?.settings.id] ?? 'hold';
        }
        if (timebase && changed.timebase || sampling && changed.sampling) setTimingFeedback(panel);
        const draft = panel.drafts?.get(source?.settings.id);
        for (const [id, { property, value }] of Object.entries(draft ?? {}))
            el(id)[property] = value;
        showTimebaseFields(panel, source); renderAlignmentTimebaseStatus();
    }
    const sourcePlotTimelines = new WeakMap();
    function updateSourcePlotTimelines(capture, previous, timing) {
        if (previous.mode === timing.mode && (timing.mode !== 'fixed' || previous.sampleRate === timing.sampleRate)) return;
        for (const source of capture.sources) {
            if (source.kind !== 'numeric' || source === capture.dataEngine.syncSource) continue;
            if (capture.rebuildHistory) { sourcePlotTimelines.delete(source); continue; }
            if (!source.frames?.length || !source.frames.frameOrdinalAt || source.rebuilding) continue;
            const saved = sourcePlotTimelines.get(source);
            const timeline = saved?.valid ? saved : new S.SourcePlotTimeline(source, previous, projectVisibleReceiveTime);
            timeline.change(timing);
            sourcePlotTimelines.set(source, timeline);
        }
    }
    function prepareAlignment(panel, source) {
        const id = source.settings.id, saved = workspaceChannels.timebases[id];
        const previous = S.normalizeSourceTimebase(saved);
        const { timebase, sampling } = panel;
        const mode = timebase?.mode.value ?? previous.mode, fixed = mode === 'fixed';
        const resyncEnabled = fixed && sampling ? sampling.resync.checked : previous.resyncEnabled;
        const resyncActive = fixed && resyncEnabled && sampling;
        const timing = S.normalizeSourceTimebase({ ...previous, mode, resyncEnabled,
            sampleRate: fixed && timebase ? Number(timebase.rate.value) : previous.sampleRate,
            resyncDelayMs: resyncActive ? Number(sampling.delay.value.trim() || NaN) : previous.resyncDelayMs,
            resyncBatches: resyncActive ? Number(sampling.batches.value) : previous.resyncBatches,
            resyncConfirmationMs: resyncActive ? Number(sampling.confirmation.value.trim() || NaN) : previous.resyncConfirmationMs });
        const originalSettings = source.settings;
        const nextSettings = !timebase || source === primarySource ? originalSettings : S.WidgetConfig.normalizeConnectionSource({
            ...originalSettings, timeOffsetMs: timebase.offset.value
        });
        const oldMethod = workspaceChannels.methods[id];
        const method = sampling?.method.value ?? oldMethod ?? 'hold';
        return { id, saved, previous, timing, originalSettings, nextSettings, oldMethod, method };
    }
    function commitAlignment(panel, source = panel.source(), prepared) {
        if (!source) return true;
        try {
            const { id, saved, previous, timing, originalSettings, nextSettings, oldMethod, method } =
                prepared ?? prepareAlignment(panel, source);
            if (JSON.stringify(previous) === JSON.stringify(timing) && method === (oldMethod ?? 'hold') &&
                originalSettings.timeOffsetMs === nextSettings.timeOffsetMs) {
                if (el(panel.feedbackId).classList.contains('is-error')) setTimingFeedback(panel);
                return true;
            }
            source.settings = nextSettings;
            workspaceChannels.methods[id] = method;
            workspaceChannels.timebases[id] = timing;
            try {
                if (source.capture.rebuildHistory) realignWorkspaceChannels(id);
                else {
                    if (JSON.stringify(previous) !== JSON.stringify(timing) || originalSettings.timeOffsetMs !== nextSettings.timeOffsetMs) {
                        const staged = alignmentReplay?.capture;
                        if (staged) {
                            const prior = S.normalizeSourceTimebase(staged.timebases[id]);
                            staged.timebases[id] = timing;
                            staged.changeTimebaseForFuture(source, prior, originalSettings.timeOffsetMs ?? 0);
                        }
                        workspaceChannels.changeTimebaseForFuture(source, previous, originalSettings.timeOffsetMs ?? 0);
                    }
                    for (const active of [workspaceChannels, alignmentReplay?.capture]) if (active) {
                        active.methods[id] = method;
                        active.mappings.forEach((entry, index) => {
                            if (entry.sourceId === id) active.numericSource.frames.sampleMethods[index] = method;
                        });
                    }
                    scheduleSourceUi();
                }
            } catch (error) {
                source.settings = originalSettings;
                if (oldMethod === undefined) delete workspaceChannels.methods[id];
                else workspaceChannels.methods[id] = oldMethod;
                if (saved) workspaceChannels.timebases[id] = saved;
                else delete workspaceChannels.timebases[id];
                throw error;
            }
            updateSourcePlotTimelines(source.capture, previous, timing);
            for (const widget of widgets.widgets.values()) {
                if (widget.type === 'wave' && widget.capture === source.capture) widgets.applySettings(widget);
            }
            if (widgets.active?.type === 'wave' && widgets.active.capture === source.capture) widgets.activate(widgets.active.id);
            const dialogDraft = dialogAlignment.drafts.get(id);
            if (dialogDraft) {
                if (panel.timebase) for (const input of Object.values(dialogAlignment.timebase)) delete dialogDraft[input.id];
                if (panel.sampling) for (const input of Object.values(dialogAlignment.sampling)) delete dialogDraft[input?.id];
            }
            for (const view of alignmentPanels) {
                if (view.source() === source) renderAlignmentTimebase(view, source, panel);
            }
            connectionView.refresh(source); tools?.invalidate(); saveSoon();
            if (panel.picker) setTimingFeedback(panel, '设置已应用');
            return true;
        } catch (error) { setTimingFeedback(panel, error.message, true); return false; }
    }
    for (const panel of alignmentPanels) {
        if (panel.timebase) listen(panel.timebase.mode, 'change', () => showTimebaseFields(panel));
        if (panel.sampling) listen(panel.sampling.resync, 'change', () => showTimebaseFields(panel));
    }
    for (const event of ['input', 'change']) listen(dialogAlignment.container, event, ({ target }) => {
        const id = dialogAlignment.currentSource?.settings.id;
        if (!id || !['INPUT', 'SELECT'].includes(target.tagName)) return;
        const property = target.type === 'checkbox' ? 'checked' : 'value';
        const draft = dialogAlignment.drafts.get(id) ?? {};
        draft[target.id] = { property, value: target[property] };
        dialogAlignment.drafts.set(id, draft);
        setTimingFeedback(dialogAlignment, '时间对齐与同步采样待应用');
    });
    for (const panel of sidebarPanels) {
        S.bindAutoApply(panel.container, () => commitAlignment(panel, panel.currentSource), listen);
        for (const event of ['input', 'change']) listen(panel.container, event, ({ target }) => {
            if (target !== panel.picker) setTimingFeedback(panel);
        });
        // The change handler applies the previous draft while Enter stays available to the picker.
        listen(panel.picker, 'keydown', event => {
            if (event.key === 'Enter') event.stopPropagation();
        });
        listen(panel.picker, 'change', () => {
            const previous = panel.currentSource;
            if (previous && !commitAlignment(panel, previous)) {
                panel.picker.value = previous.settings.id;
                return;
            }
            renderAlignmentTimebase(panel);
        });
    }
    function refreshAlignmentSources() {
        for (const { picker } of sidebarPanels) {
            const saved = picker.value;
            picker.replaceChildren(...allConnections().map(({ settings }) => {
                const option = document.createElement('option');
                option.value = settings.id; option.textContent = settings.name;
                return option;
            }));
            picker.value = connectionSources.has(saved) ? saved : 'primary';
        }
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
            watchBridgeStatus(open);
            if (!open) closeBridgeBinding();
            if (open && engineView && connectionView.selectedSource) engineView.setEngine(connectionView.selectedSource.capture.dataEngine);
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
            dialogAlignment.drafts.delete(source.settings.id);
            dropConnectionSource(source); applyCaptureQuotas(); refreshConnectionChoices(); syncConnection(); saveSoon();
        },
        onSelect(source) {
            closeBridgeBinding();
            renderAlignmentTimebase(dialogAlignment, source);
            if (connectionView.dialog.open) engineView?.setEngine(source.capture.dataEngine);
        }
    });
    function saveConnectionSettings(source, settings) {
        const previous = source.settings;
        if (source === primarySource) {
            for (const [key, globalKey] of Object.entries(primaryFields)) globals[globalKey] = String(settings[key]);
            if (settings.mode === 'tcp-server') globals.netLocalPort = '';
            replaceConnectionSettings(source, primaryConnectionSettings());
        } else {
            replaceConnectionSettings(source, { ...settings, timeOffsetMs: previous.timeOffsetMs });
        }
        source.error = '';
        if (previous.name !== source.settings.name) refreshConnectionChoices();
        syncConnection();
    }
    function normalizeSourceConnection(source, settings) {
        const normalize = source === primarySource ? S.WidgetConfig.normalizeConnectionSettings : S.WidgetConfig.normalizeConnectionSource;
        return normalize(settings);
    }
    function connectionPortOrDefault(value, fallback) {
        try { S.parsePort(value); return value; }
        catch { return fallback; }
    }
    function applyConnectionMode() {
        const source = connectionView.selectedSource, select = el('conn-type');
        if (!source || select.value === source.settings.mode) return;
        if (source.connected || source.pending || applyingSourceSettings) {
            select.value = source.settings.mode;
            connectionView.syncDialog();
            return;
        }
        closeBridgeBinding();
        const mode = select.value, settings = { ...source.settings, mode };
        const { netHost, netPort, netLocalPort } = S.WidgetConfig.GLOBAL_DEFAULTS;
        if (!isSerialConnectionMode(mode)) {
            settings.port = connectionPortOrDefault(settings.port, netPort);
            if (mode !== 'tcp-server') settings.host = settings.host?.trim() || netHost;
            if (mode === 'udp') settings.localPort = connectionPortOrDefault(settings.localPort, netLocalPort);
        }
        try {
            saveConnectionSettings(source, normalizeSourceConnection(source, settings));
            saveSoon();
        } catch (error) {
            select.value = source.settings.mode;
            connectionView.syncDialog();
            connectionView.finishConnectionSettings(source.settings.id, error.message);
        }
    }
    let applyingSourceSettings = false;
    async function applySourceSettings(validateOnly) {
        const source = connectionView.selectedSource, revision = importRevision;
        if (!source || !connectionView.dialog.open || applyingSourceSettings) return;
        const id = source.settings.id, engine = source.capture.dataEngine;
        let settings;
        try {
            const draft = connectionView.connectionDraft();
            if (Object.keys(draft).length) {
                try {
                    settings = normalizeSourceConnection(source, { ...source.settings, ...draft });
                } catch (error) {
                    connectionView.finishConnectionSettings(id, error.message);
                    throw error;
                }
            }
            let timing;
            try { timing = prepareAlignment(dialogAlignment, source); }
            catch (error) { setTimingFeedback(dialogAlignment, error.message, true); throw error; }
            const rawLimit = Number(el('max-raw-frame-bytes').value);
            const invalidLimit = !Number.isSafeInteger(rawLimit) || rawLimit < 64 || rawLimit > 64 * 1024 * 1024;
            const limitError = invalidLimit ? '原始帧分段上限必须为 64 至 67108864 B 的整数' : '';
            status('engine-raw-limit-status', limitError);
            if (invalidLimit) throw new Error(limitError);
            const rebuild = engineView.rebuildHistoryDraft();
            const metadata = engineView.channels.prepareMetadata();
            const parsingChanged = Boolean(engine.config.draft);
            if (validateOnly) {
                if (parsingChanged) engineView.validate();
                engineView.status('草稿校验通过；点击「应用设置」生效');
                return;
            }
            applyingSourceSettings = true;
            el('engine-validate').disabled = el('engine-apply').disabled = true;
            if (parsingChanged && !await engineView.apply()) return;
            if (!isCurrentConnection(source, revision)) return;
            engineView.commitRebuildHistory(engine, rebuild);
            if (!commitAlignment(dialogAlignment, source, timing))
                throw new Error(el(dialogAlignment.feedbackId).textContent);
            dialogAlignment.drafts.delete(id);
            if (settings) {
                saveConnectionSettings(source, settings);
                connectionView.finishConnectionSettings(id);
            }
            if (connectionView.selectedSource === source) renderAlignmentTimebase(dialogAlignment, source);
            engineView.channels.commitMetadata(source.capture, metadata);
            if (rawLimit !== globals.maxRawFrameBytes) applyRawFrameLimit(rawLimit);
            tools?.invalidate();
            saveSoon();
            if (connectionView.selectedSource === source) engineView.status('设置已应用');
        } catch (error) {
            if (isCurrentConnection(source, revision) && connectionView.selectedSource === source) engineView.status(error.message, true);
        } finally {
            if (!validateOnly) {
                applyingSourceSettings = false;
                el('engine-validate').disabled = el('engine-apply').disabled = false;
            }
        }
    }
    connectionView.add(primarySource);
    listen(el('serial-manager-open'), 'click', () => { syncConnection(); connectionView.showManager(); });
    function applyCaptureQuotas() {
        const limit = captureQuota(globals, connectionSources.size + Number(workspaceChannels.mappings.length > 0));
        workspaceChannels.trim();
        if (service.memory.limitBytes !== limit) service.setMemoryLimit(limit);
        for (const { capture } of connectionSources.values()) if (capture.memory.limitBytes !== limit) capture.setMemoryLimit(limit);
    }
    function createTransport(mode, isPrimary = false) {
        if (mode === 'bridge-serial') return new S.BridgeSerialEngine();
        if (mode === 'serial') return isPrimary ? serialAdapter : new S.SerialEngine();
        return isPrimary ? netAdapter : new S.NetEngine();
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
            throw new Error('仍有控件使用全局通道，请先更改其接收来源');
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
        adapter.setCaptureVisible?.(!visibilityCutoff);
        if (visibilityStarted && !visibilityCutoff) adapter.setCaptureGrace?.(Math.max(0, Math.ceil(visibilityGraceMs - visibilityElapsed())));
        adapter.onData((bytes, stamp) => {
            if (!current() || visibilityCutoff) return;
            // A transport callback can run before an overdue visibility timer after a freeze.
            if (visibilityStarted && visibilityElapsed() >= visibilityGraceMs) { syncCaptureVisibility(); return; }
            source.capture.receive(bytes, stamp);
        });
        adapter.onStatusChange((connected, error, info) => {
            if (!current()) return;
            if (connected) {
                if (info?.gap) {
                    source.capture.endStream();
                    source.bindingMessage = 'Bridge · ' + source.bridgePath + ' · 上一段数据有缺口';
                }
                source.connected = true;
            } else if (info?.detached) {
                source.connected = false;
                source.bindingMessage = 'Bridge · ' + source.bridgePath + ' · 网页订阅中断';
            } else endConnectionStream(source);
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
        const serial = isSerialConnectionMode(settings.mode);
        source.settings = settings;
        if (settings.mode !== previous.mode && (serial || isSerialConnectionMode(previous.mode))) {
            const wasConnected = source.connected;
            if (wasConnected) endConnectionStream(source);
            if (bridgeBindingSource === source) closeBridgeBinding();
            source.bindingMessage = ''; source.bridgePath = '';
            source.adapter = createTransport(settings.mode, source === primarySource);
            watchTransport(source, source.adapter);
            if (adapter === serialAdapter || adapter === netAdapter) void adapter.disconnect();
            else if (previous.mode === 'bridge-serial' && wasConnected)
                void adapter.disconnect().catch(report).finally(() => releaseTransport(adapter));
            else releaseTransport(adapter);
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
    function openBoundSerialPort(adapter, { baudRate, dataBits, stopBits, parity }, port) {
        return adapter.connect({ baudRate: Number(baudRate), dataBits: Number(dataBits), stopBits: Number(stopBits), parity }, port);
    }
    function watchBridgeStatus(open) {
        clearInterval(bridgeStatusTimer);
        const revision = ++bridgeStatusRevision;
        if (!open) return;
        status('serial-config-status', '正在检测 Bridge…');
        const update = async () => {
            const result = await S.BridgeSerialEngine.probe();
            if (revision !== bridgeStatusRevision || disposed) return;
            const message = bridgeWorkspace.revoked && result ? bridgeRevokedMessage : result
                ? (result.serial ? 'Bridge 已运行' : 'Bridge 已运行，仅提供 TCP / UDP')
                : 'Bridge 未响应。使用 Bridge 模式前请启动 bridge.js。';
            const hint = el('serial-config-status');
            if (hint.textContent !== message) hint.textContent = message;
        };
        void update();
        bridgeStatusTimer = setInterval(update, 2500);
    }
    function closeBridgeBinding() {
        bridgeBindingSource = null;
        const authorization = bridgeAuthorization;
        bridgeAuthorization = null;
        authorization?.reject(Object.assign(new Error('已取消 Bridge 授权'), { name: 'AbortError' }));
        bridgeListRevision++;
        bridgePorts = [];
        if (bridgeBindingDialog.open) bridgeBindingDialog.close();
        el('bridge-serial-token').value = '';
    }
    function showBridgeBinding(source) {
        if (!connectionView.dialog.open || connectionView.selectedSource !== source || bridgeBindingDialog.open) return;
        bridgeBindingSource = source;
        el('bridge-serial-token').value = bridgeToken;
        resetBridgePortList();
        status('bridge-serial-binding-title', '绑定 Bridge 串口');
        status('bridge-serial-source', source.settings.name);
        el('bridge-serial-list').textContent = '列出端口';
        el('bridge-serial-connect').hidden = false;
        status('bridge-serial-status', '请输入 Bridge 终端显示的串口访问码。');
        lockBridgeBinding(false);
        bridgeBindingDialog.showModal();
        if (bridgeToken) void listBridgePorts();
        else el('bridge-serial-token').focus();
    }
    function rememberBridgeToken(token) {
        bridgeToken = token;
        try {
            if (token) window.sessionStorage?.setItem(bridgeTokenKey, token);
            else window.sessionStorage?.removeItem(bridgeTokenKey);
        } catch { /* Storage is optional for local files. */ }
    }
    async function obtainBridgeWorkspace(interactive = true) {
        if (bridgeWorkspace.key) return bridgeWorkspace.key;
        const capability = await S.BridgeSerialEngine.probe();
        if (!capability?.exclusive) return null;
        if (bridgeToken) {
            try { return await bridgeWorkspace.claim(S.BridgeSerialEngine.url, bridgeToken); }
            catch (error) {
                if (!interactive || error.code !== 'invalid-access-code') throw error;
                rememberBridgeToken('');
            }
        }
        if (!interactive) throw new Error('请输入 Bridge 访问码');
        if (bridgeBindingDialog.open) throw new Error('请先完成当前的 Bridge 授权');
        return new Promise((resolve, reject) => {
            bridgeAuthorization = { resolve, reject };
            resetBridgePortList();
            status('bridge-serial-binding-title', '授权 Bridge');
            status('bridge-serial-source', '');
            status('bridge-serial-status', '请输入 Bridge 终端显示的访问码。');
            el('bridge-serial-token').value = '';
            el('bridge-serial-list').textContent = '授权并连接';
            el('bridge-serial-connect').hidden = true;
            lockBridgeBinding(false);
            bridgeBindingDialog.showModal();
            el('bridge-serial-token').focus();
        });
    }
    async function submitBridgeAuthorization() {
        const authorization = bridgeAuthorization;
        const button = el('bridge-serial-list'), token = el('bridge-serial-token').value.trim();
        if (!authorization || button.disabled) return;
        if (!token) { status('bridge-serial-status', '请输入 Bridge 访问码。'); return; }
        lockBridgeBinding(true);
        try {
            const key = await bridgeWorkspace.claim(S.BridgeSerialEngine.url, token);
            if (bridgeAuthorization !== authorization) return;
            rememberBridgeToken(token);
            bridgeAuthorization = null;
            closeBridgeBinding();
            authorization.resolve(key);
        } catch (error) {
            if (bridgeAuthorization === authorization) status('bridge-serial-status', error.message);
        } finally {
            if (bridgeAuthorization === authorization) lockBridgeBinding(false);
        }
    }
    function resetBridgePortList() {
        bridgeListRevision++;
        bridgePorts = [];
        el('bridge-serial-port').replaceChildren();
        el('bridge-serial-port-wrap').hidden = true;
        syncBridgePortSelection();
    }
    function syncBridgePortSelection() {
        const path = el('bridge-serial-port').value;
        el('bridge-serial-connect').disabled = !bridgePorts.some(port => port.path === path) || Boolean(bridgeBindingSource?.pending);
    }
    function lockBridgeBinding(locked) {
        for (const id of ['bridge-serial-token', 'bridge-serial-list', 'bridge-serial-port', 'bridge-serial-cancel'])
            el(id).disabled = locked;
        syncBridgePortSelection();
    }
    async function listBridgePorts() {
        const source = bridgeBindingSource, token = el('bridge-serial-token').value.trim();
        const button = el('bridge-serial-list'), select = el('bridge-serial-port');
        if (!source || button.disabled) return;
        resetBridgePortList();
        const revision = bridgeListRevision;
        button.disabled = true;
        try {
            if (!token) throw new Error('请输入 Bridge 访问码');
            const ports = await S.BridgeSerialEngine.ports(token);
            if (bridgeListRevision !== revision) return;
            rememberBridgeToken(token);
            bridgePorts = ports;
            select.replaceChildren(...bridgePorts.map(port => {
                const option = document.createElement('option');
                option.value = port.path; option.textContent = port.label;
                return option;
            }));
            const existing = bridgeBindings.get(source.settings.id);
            select.value = bridgePorts.some(port => port.path === existing?.path && port.identity === existing.identity) ? existing.path : '';
            el('bridge-serial-port-wrap').hidden = !ports.length;
            status('bridge-serial-status', ports.length ? '请选择此来源对应的端口。' : 'Bridge 没有检测到可用串口。');
            syncBridgePortSelection();
            if (ports.length) select.focus();
        } catch (error) {
            if (bridgeListRevision === revision) status('bridge-serial-status', error.message);
        } finally {
            if (bridgeListRevision === revision) button.disabled = false;
        }
    }
    async function openBridgeSerial(source, binding, workspaceKey) {
        if (!bridgeToken) throw new Error('请在通讯配置中输入 Bridge 访问码并绑定端口');
        const adapter = source.adapter;
        source.bridgePath = binding.path;
        source.bindingMessage = 'Bridge · ' + binding.path;
        const { baudRate, dataBits, stopBits, parity } = source.settings;
        return adapter.connect({ baudRate: Number(baudRate), dataBits: Number(dataBits), stopBits: Number(stopBits), parity }, binding, bridgeToken, workspaceKey);
    }
    async function confirmBridgeBinding() {
        const source = bridgeBindingSource, path = el('bridge-serial-port').value;
        const chosen = bridgePorts.find(port => port.path === path);
        if (!source || source.settings.mode !== 'bridge-serial' || !chosen || source.connected || source.pending || connectionBusy) return;
        const id = source.settings.id;
        if ([...bridgeBindings.values()].some(binding => binding.id !== id && binding.path === path)) {
            status('bridge-serial-status', '此端口已绑定到另一来源。');
            return;
        }
        const revision = importRevision;
        connectionBusy = source.pending = true; source.error = ''; syncConnection();
        lockBridgeBinding(true);
        try {
            const binding = { id, path, identity: chosen.identity };
            const workspaceKey = await obtainBridgeWorkspace(false);
            if (!isCurrentConnection(source, revision)) return;
            await openBridgeSerial(source, binding, workspaceKey);
            if (!isCurrentConnection(source, revision)) return;
            bridgeBindings.set(id, binding);
            saveSoon();
            if (bridgeBindingSource === source) closeBridgeBinding();
        } catch (error) {
            if (isCurrentConnection(source, revision)) {
                source.error = 'Bridge 串口连接失败：' + error.message;
                if (bridgeBindingSource === source) status('bridge-serial-status', error.message);
            }
        } finally {
            connectionBusy = source.pending = false;
            if (bridgeBindingSource === source) lockBridgeBinding(false);
            if (!disposed) { syncConnection(); scheduleSourceUi(); }
        }
    }
    listen(el('conn-type'), 'change', applyConnectionMode);
    const submitBridgeCode = () => { void (bridgeAuthorization ? submitBridgeAuthorization() : listBridgePorts()); };
    listen(el('bridge-serial-list'), 'click', submitBridgeCode);
    listen(el('bridge-serial-connect'), 'click', () => { void confirmBridgeBinding(); });
    listen(el('bridge-serial-cancel'), 'click', closeBridgeBinding);
    listen(bridgeBindingDialog, 'cancel', event => {
        event.preventDefault();
        if (!bridgeBindingSource?.pending && !el('bridge-serial-token').disabled) closeBridgeBinding();
    });
    listen(el('bridge-serial-token'), 'input', () => {
        resetBridgePortList();
        el('bridge-serial-list').disabled = false;
        status('bridge-serial-status', '请输入 Bridge 终端显示的串口访问码。');
    });
    listen(el('bridge-serial-token'), 'keydown', event => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        submitBridgeCode();
    });
    listen(el('bridge-serial-port'), 'change', syncBridgePortSelection);
    listen(el('bridge-serial-port'), 'keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void confirmBridgeBinding();
    });
    async function bindSerialPort(source) {
        if (connectionBusy || !isSerialConnectionMode(source.settings.mode) || source.connected || source.pending || disposed) return;
        if (source.settings.mode === 'bridge-serial') { showBridgeBinding(source); return; }
        const revision = importRevision, id = source.settings.id;
        let bound = false;
        connectionBusy = source.pending = true;
        source.error = ''; syncConnection();
        try {
            if (!navigator.serial?.requestPort) throw new Error('当前浏览器不支持 Web Serial API');
            const port = await navigator.serial.requestPort();
            const grants = await authorizedPorts().catch(() => null);
            if (!isCurrentConnection(source, revision)) return;
            portBindings.bind(id, port, grants);
            source.bindingMessage = '已绑定端口';
            bound = true;
            saveSoon();
            await openBoundSerialPort(source.adapter, source.settings, port);
        } catch (error) {
            if (isCurrentConnection(source, revision) && error.name !== 'AbortError' && (bound || error.name !== 'NotFoundError'))
                source.error = (bound ? '连接失败：' : '绑定失败：') + error.message;
        } finally {
            connectionBusy = source.pending = false;
            if (!disposed) { syncConnection(); scheduleSourceUi(); }
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
            const hasWebSerial = connect && selected.some(source => source.settings.mode === 'serial');
            const grants = hasWebSerial ? authorizedPorts().then(ports => ({ ports }), error => ({ error })) : null;
            let bridgeKey;
            const getBridgeKey = () => bridgeKey ??= obtainBridgeWorkspace();
            await Promise.all(selected.map(async source => {
                if (!isCurrentConnection(source, revision)) return;
                const { adapter, settings } = source;
                try {
                    if (!connect) {
                        await adapter.disconnect();
                        if (isCurrentConnection(source, revision) && source.connected) endConnectionStream(source);
                        return;
                    }
                    if (!isSerialConnectionMode(settings.mode)) {
                        const options = networkOptions(settings), key = await getBridgeKey();
                        if (isCurrentConnection(source, revision)) await adapter.connect(options, key);
                        return;
                    }
                    const { id } = settings;
                    if (settings.mode === 'bridge-serial') {
                        const binding = bridgeBindings.get(id);
                        if (!binding) throw new Error('请在通讯配置中绑定 Bridge 串口');
                        const key = await getBridgeKey();
                        if (isCurrentConnection(source, revision)) await openBridgeSerial(source, binding, key);
                        return;
                    }
                    const { ports, error } = await grants;
                    if (!isCurrentConnection(source, revision)) return;
                    if (error) throw error;
                    const match = portBindings.resolve(id, ports);
                    source.bindingMessage = match.issue ?? '已绑定端口';
                    if (!match.port) return;
                    await openBoundSerialPort(adapter, settings, match.port);
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
        connectionSources.delete(id); portBindings.remove(id); bridgeBindings.delete(id); connectionView.remove(id);
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
        bridgeBindings.clear();
        for (const binding of config.bridgeBindings ?? []) bridgeBindings.set(binding.id, binding);
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
            const engine = { ...dataEngine.serialize(), mode: 'Raw_Data', draft: null };
            S.preflightDataEngine(engine, globals, { memoryLimitBytes: limit });
            createConnectionSource({ ...settings, channelCount: Number(globals.channelsCount), engine }, limit);
            nextConnectionSourceNumber = number + 1;
            applyCaptureQuotas(); refreshConnectionChoices(); syncConnection(); saveSoon();
            connectionView.revealSource(settings.id);
        } catch (error) { status('serial-source-add-status', error.message); }
    });
    listen(el('monitor-workspace'), 'contextmenu', event => event.preventDefault());
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
        onDelete: id => widgets?.requestRemove(id), onDrop: ({ type, rect }) => widgets?.create({ type, rect }),
        onLayoutChange: saveSoon, onScrollChange: saveSoon });
    widgets = new S.WidgetController({ document, service, globals, workspace, getConnections: connectionChoices, getPrimaryConnectionName: primaryConnectionName,
        getWorkspaceCapture: () => workspaceChannels, projectReceiveTime: projectVisibleReceiveTime, getSourcePlotTimeline: source => sourcePlotTimelines.get(source),
        onTextPreparation: (widget, fraction, done, total) => setTaskProgress(widget,
            fraction === null || !total ? null : '正在准备字节流文本 · ' + widget.title, fraction,
            total ? bytesLabel(done) + ' / ' + bytesLabel(total) : ''),
        onChange() {
            if (!widgets || disposed) return;
            tools?.syncSources(); syncExportSources(); showProgress(null, null); saveSoon();
        },
        onRulesChange() { tools?.invalidate(); rates.clear(); syncExportSources(); },
        onChannelMetadataChange(index, patch, capture) {
            engineView?.channels.updateMetadata(index, patch, capture);
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
        onSettingsAction: validateOnly => { void applySourceSettings(validateOnly); },
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
        const projected = id => Boolean(active[id]?.mode && active[id].mode !== 'receive' ||
            workspaceChannels.cursors.get(id)?.timebaseChanged);
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
        canNavigate: () => !pauseDrain,
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
    function widgetSelectionForFormat(format, refresh = false) {
        const widget = widgets.active;
        if (format === 'svg') {
            return typeof widget?.view?.exportSvg === 'function' ? { widget } : null;
        }
        if (format === 'wavelet-csv') return widget?.type === 'wavelet' ? { widget } : null;
        if (format !== 'text') {
            if (!refresh) return widgetExportSelection;
            const engine = widget?.capture.dataEngine;
            return S.widgetExportSelection(widget, engine?.globals.channelNames, engine?.mode);
        }
        return widget?.type === 'byte' && widget.settings.captureMode === 'text' && widget.source.kind === 'raw'
            ? { widget, source: widget.source, encoding: widget.settings.textEncoding } : null;
    }
    function widgetExportIssue(format, selected) {
        if (format === 'svg') return selected ? '' : '请选择可导出 SVG 的绘图控件。';
        if (format === 'wavelet-csv') return selected ? '' : '请选择小波变换控件。';
        if (!selected) return format === 'text' ? '请选择显示「文本」的字节流控件。'
            : '请选择有解析数据的绘图、位姿或显示「数据引擎」的字节流控件。';
        if (selected.widget.capture === workspaceChannels && (format === 'binary' || format === 'hex-text'))
            return '请在左侧「导出数据」中按通讯来源导出原始字节。此处可导出全局通道的 TXT 或 CSV。';
        if (pauseDrain && selected.widget.capture === workspaceChannels) return '正在整理暂停前的数据。';
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
        widgetExportView.sync({ busy: exporting, available: !issue, syncAvailable: Boolean(selected?.source?.frames.provenanceAt) });
        const title = widgets.active?.title;
        el('widget-export-scope-hint').textContent = title ? '当前控件：' + title : '';
        const hint = format === 'binary' || format === 'hex-text' ? '导出成功解析的原始帧。'
            : format === 'text' ? '按控件的字符集和记录边界导出。' : '导出该控件采用的通道或字段。';
        el('widget-export-range-summary').textContent = !selected ? '' : format === 'svg'
            ? '保存点击导出时的图形、刻度和坐标范围。'
            : format === 'wavelet-csv' ? '导出当前分析结果的时间、频率、幅度及相位，缺失系数留空。'
            : hint + '\n' + exportTimeRange([selected.source.frames]);
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
        const csv = ['csv', 'wavelet-csv'].includes(options.format), binary = options.format === 'binary';
        const text = options.format === 'text' || options.format === 'engine-text';
        const svg = options.format === 'svg';
        const extension = svg ? 'svg' : csv ? 'csv' : binary ? 'bin' : text ? 'txt' : 'hex';
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
            else download(parts, filename, svg ? 'image/svg+xml;charset=utf-8' : binary ? 'application/octet-stream' : csv ? 'text/csv;charset=utf-8' :
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
        const pool = service.workerPool;
        const parallel = pool.available && options.format === 'hex-text' &&
            sources.reduce((total, frames) => total + frames.retainedByteLength, 0) >= 262144;
        return writeExport(exportView, options, sources, check, onProgress => parallel
            ? S.captureHexChunksInWorkers(source.frames, tx, pool, { ...options, onProgress, check })
            : S.captureExportChunks(source.frames, tx, { ...options, onProgress }));
    }
    async function exportWidgetData() {
        if (exporting || disposed) return false;
        const options = widgetExportView.read(), format = options.format;
        const active = widgets.active, engine = active?.capture.dataEngine;
        const selected = widgetSelectionForFormat(format, true);
        if (widgetExportIssue(format, selected)) return false;
        if (format === 'svg') {
            let svg;
            try { svg = active.view.exportSvg(active.title); }
            catch (error) { status('widget-export-source-status', '导出失败：' + error.message); return false; }
            // The image is immutable before the first await, even if live acquisition wraps the source buffer.
            return writeExport(widgetExportView, options, [], () => {
                if (disposed) throw new Error('当前工作区已关闭');
            }, () => [svg], svg.length * 2);
        }
        if (format === 'wavelet-csv') {
            const snapshot = active.view.wavelet.snapshot;
            if (!snapshot?.result.magnitude.some(Number.isFinite)) {
                status('widget-export-source-status', '当前没有可导出的小波系数。');
                return false;
            }
            return writeExport(widgetExportView, options, [], () => {
                if (disposed) throw new Error('当前工作区已关闭');
            }, onProgress => S.WaveletPlot.waveletCsv(snapshot, onProgress), snapshot.result.magnitude.length * 64);
        }
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
            if (service.workerPool.available && frames.length * (channelIndices?.length ?? 0) >= 32768)
                return S.frameCsvChunksInWorkers(frames, channels, service.workerPool, settings);
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
            source.hasBinding = mode === 'bridge-serial' ? bridgeBindings.has(id) :
                mode === 'serial' && (portBindings.ports.has(id) || portBindings.hints.has(id));
            source.needsConfirmation = mode === 'serial' && !portBindings.ports.has(id) && portBindings.hints.get(id)?.ambiguous;
            if (mode === 'bridge-serial') source.bridgePath = bridgeBindings.get(id)?.path ?? source.bridgePath;
            connectionView.refresh(source);
        }
        const serialOffline = sources.filter(source => !source.connected && isSerialConnectionMode(source.settings.mode));
        const needsBinding = serialOffline.some(source => !source.hasBinding || source.needsConfirmation || source.bindingMessage.includes('重新确认'));
        const failed = sources.find(source => !source.connected && source.error);
        const offline = serialOffline.some(source => source.bindingMessage.includes('不在线'));
        const detail = connectionBusy ? ' · 正在处理…' : bridgeWorkspace.revoked ? ' · ' + bridgeRevokedMessage
            : failed ? ' · ' + failed.settings.name + '：' + failed.error
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
        el('capture-visible-only').checked = globals.captureVisibleOnly;
        syncCaptureVisibility();
        updateMemoryStatus();
        widgets.syncGlobals(); syncConnection();
    }
    function applyRawFrameLimit(bytes) {
        globals.maxRawFrameBytes = bytes;
        el('max-raw-frame-bytes').value = String(bytes);
        for (const { capture } of allConnections()) void capture.setMaxRawFrameBytes(bytes).catch(report);
        widgets.syncByteRecordRule();
    }
    for (const event of ['input', 'change']) listen(el('max-raw-frame-bytes'), event, () => {
        status('engine-raw-limit-status', '');
        engineView.status('原始帧分段上限待应用');
    });
    function applyBufferSetting(key, id) {
        const value = key === 'maxPoints' ? el(id).value : Number(el(id).value);
        if (String(globals[key]) === String(value)) return;
        const candidate = getConfig(); candidate.global[key] = value;
        try {
            const validated = S.WidgetConfig.validateWorkspaceConfig(candidate);
            if (key === 'captureMemoryMiB') preflightWorkspaceEngines(validated);
            Object.assign(globals, validated.global);
            if (key === 'maxPoints') {
                service.setCapacity(Number(globals.maxPoints)); workspaceChannels.resize(Number(globals.maxPoints)); widgets.setCapacity(Number(globals.maxPoints));
                for (const { capture } of connectionSources.values()) capture.setCapacity(Number(globals.maxPoints));
            } else applyCaptureQuotas();
            updateMemoryStatus();
            tools.invalidate(); saveSoon(); status('cfg-save-status', '');
        } catch (error) { report(error); }
    }
    const bufferFields = [['maxPoints', 'max-points'], ['captureMemoryMiB', 'capture-memory-mib']];
    for (const [key, id] of bufferFields) listen(el(id), 'change', () => applyBufferSetting(key, id));
    S.bindAutoApply(el('board-toolbar'), () => {
        for (const [key, id] of bufferFields) applyBufferSetting(key, id);
    }, listen);
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
    function captureForTransport(transport = primarySource.adapter) {
        if (transport === primarySource.adapter || transport === serialAdapter || transport === netAdapter) return service;
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
    for (const id of ['send-mode', 'send-interval', 'send-interval-unit']) S.bindSettingField(el(id), saveSoon, listen);
    watchTransport(primarySource, primarySource.adapter);
    listen(el('serial-disconnect-all'), 'click', () => { void changeConnections(allConnections(), false); });
    listen(el('btn-connect'), 'click', () => { void changeConnections(allConnections(), true); });
    function visibilityElapsed() {
        return Math.max(performance.now() - visibilityStarted.arrival, service.wallNow() - visibilityStarted.timestamp);
    }
    function projectVisibleReceiveTime(time) {
        if (!visibilityPauses.length) return time;
        const section = workspaceChannels.pauseSection(time, visibilityPauses);
        return time - (visibilityPauses[section - 1]?.total ?? 0);
    }
    function syncCaptureVisibility() {
        const hidden = globals.captureVisibleOnly && document.hidden;
        if (visibilityStarted && !visibilityCutoff && visibilityElapsed() >= visibilityGraceMs) {
            // Preserve the original deadline even if Chrome suspended all page tasks.
            visibilityCutoff = {
                timestamp: Math.min(service.wallNow(), visibilityStarted.timestamp + visibilityGraceMs),
                arrival: Math.min(performance.now(), visibilityStarted.arrival + visibilityGraceMs)
            };
            cancelWorkspacePump();
            widgets.setCaptureHidden(true);
            for (const { adapter } of allConnections()) adapter.setCaptureVisible?.(false);
            applyCapturePause(visibilityCutoff);
        }
        if (hidden) {
            if (!visibilityStarted) {
                visibilityStarted = { timestamp: service.wallNow(), arrival: performance.now() };
                for (const { adapter } of allConnections()) adapter.setCaptureGrace?.(visibilityGraceMs);
            }
            if (!visibilityCutoff && visibilityTimer === null) {
                visibilityTimer = setTimeout(() => {
                    visibilityTimer = null;
                    syncCaptureVisibility();
                }, Math.max(0, visibilityGraceMs - visibilityElapsed()));
            }
            return;
        }
        if (!visibilityStarted) return;
        clearTimeout(visibilityTimer);
        visibilityTimer = null;
        visibilityStarted = null;
        if (!visibilityCutoff) {
            for (const { adapter } of allConnections()) adapter.setCaptureGrace?.(null);
            return;
        }
        const end = Math.max(visibilityCutoff.timestamp, service.wallNow());
        visibilityPauses.push({ end, total: (visibilityPauses.at(-1)?.total ?? 0) + end - visibilityCutoff.timestamp });
        visibilityCutoff = null;
        // Only a deliberate resume may release a memory-pressure stop.
        if (service.memory.blockedReason) manuallyPaused = true;
        applyCapturePause(undefined, true);
        for (const { adapter } of allConnections()) {
            adapter.setCaptureVisible?.(true);
            adapter.setCaptureGrace?.(null);
        }
        widgets.setCaptureHidden(false);
        scheduleSourceUi();
    }
    listen(el('capture-visible-only'), 'change', () => {
        globals.captureVisibleOnly = el('capture-visible-only').checked;
        syncCaptureVisibility();
        saveSoon();
    });
    function setPaused(paused) {
        manuallyPaused = paused;
        applyCapturePause();
    }
    function applyCapturePause(boundary, automaticResume = false) {
        const paused = manuallyPaused || Boolean(visibilityCutoff);
        if (workspaceChannels.paused === paused && service.paused === paused) return;
        workspaceChannels.setPaused(paused, boundary?.timestamp ?? service.wallNow());
        // Hold the last presented frame while parsers close and alignment catches up.
        if (paused && !visibilityCutoff && workspaceChannels.mappings.length) {
            pauseDrain = { epoch: workspaceChannels.epoch, targets: null };
            widgets.setWorkspacePresentationDeferred(true);
        }
        service.pause(paused, boundary);
        for (const { capture } of connectionSources.values()) {
            if (!automaticResume || paused || !capture.memory.blockedReason) capture.pause(paused, boundary);
        }
        if (pauseDrain && paused) pauseDrain.targets = (alignmentReplay?.capture ?? workspaceChannels).alignmentTargets(allConnections());
        if (paused) tools.invalidate(); else tools.resetNavigation();
        widgets.setPaused(paused);
        if (!paused) { finishPauseDrain(); scheduleSourceUi(); }
        tools.syncPaused();
        if (!visibilityCutoff) for (const widget of widgets.widgets.values()) { widget.view.draw?.(); widget.view.render?.(); }
        if (pauseDrain && paused) {
            cancelWorkspacePump();
            pumpWorkspaceChannels(true);
        }
        el('btn-pause').textContent = paused ? '恢复捕获' : '暂停捕获';
        el('btn-pause').className = paused ? 'btn btn-success' : 'btn btn-secondary';
    }
    listen(el('btn-pause'), 'click', () => setPaused(!service.paused));
    listen(document, 'keydown', event => {
        const key = event.key?.toLowerCase();
        if ((key !== 'p' && key !== 'c') || event.repeat || event.isComposing || event.defaultPrevented ||
            event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.target?.isContentEditable || event.target?.closest?.('input, textarea, select')) return;
        event.preventDefault();
        if (key === 'p') setPaused(!service.paused);
        else el('btn-clear').click();
    });
    listen(el('btn-clear'), 'click', () => {
        service.clear();
        for (const { capture } of connectionSources.values()) capture.clear();
        workspaceChannels.clear();
        finishPauseDrain();
        workspaceChannels.pauses.length = 0;
        visibilityPauses.length = 0;
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
        if (disposed || visibilityCutoff) return;
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
            if (widget.type !== 'byte') {
                const count = widget.type === 'wave' && widget.view.displayMode !== 'time' ? widget.view.completedSpectrumDraws : widget.view.completedDraws;
                const previous = draws.get(widget.id), mode = widget.type === 'wave' ? widget.view.displayMode : widget.type;
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
                bridgeBindings: [...bridgeBindings.values()],
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
        el('workspace-step').value = String(config.workspace.step);
        tools.syncSources(config.tools);
        el('send-mode').value = config.send.mode; sendController.previousMode = config.send.mode;
        regularProtocolView.setValue(config.send.protocol ?? {}); syncProtocolSend();
        el('send-interval').value = config.send.interval; el('send-interval-unit').value = config.send.unit;
        commandLibrary.replace(config.send.commands); commandView.selectedId = null; commandView.render();
        commandView.error.hidden = true; commandView.status.textContent = '拖动排序，名称直接修改';
        setSendTab(config.send.tab, false);
        widgets.activate(null); workspace.activate(null); applyGlobalFields(); applyUiLayout(config.uiLayout);
        workspace.restore(config.workspace); syncExportSources();
    }
    function applyConfig(input) {
        return applyValidatedConfig(validateStoredConfig(input));
    }
    function applyValidatedConfig(config) {
        connectionView.close(false);
        dialogAlignment.drafts.clear();
        engineView.rebuildDrafts = new WeakMap();
        engineView.channels.metadataDrafts = new WeakMap();
        connectionView.clearFormDrafts();
        finishPauseDrain();
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
    S.bindSettingField(el('workspace-zoom-percent'), () => {
        const value = Number(el('workspace-zoom-percent').value);
        if (Number.isInteger(value) && value >= 25 && value <= 500) workspace.setZoom(value / 100);
        el('workspace-zoom-percent').value = String(Math.round(workspace.zoom * 100));
    }, listen);
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
        clearTimeout(visibilityTimer);
        if (uiFrame !== null) cancelAnimationFrame(uiFrame);
        if (workspaceChannelTimer !== null) clearTimeout(workspaceChannelTimer);
        alignmentReplay?.capture.dispose(); resetTaskProgress();
        workspaceChannelView.dispose(); workspaceChannels.dispose();
        clearInterval(statsTimer); regularProtocolView.dispose(); commandRunner.dispose(); commandView.dispose(); sendController.stop(); sendController.dispose?.(); exportView.dispose(); widgetExportView.dispose();
        engineView.dispose(); tools.dispose(); widgets.dispose(); workspace.dispose();
        closeBridgeBinding();
        bridgeWorkspace.dispose();
        connectionView.dispose();
        for (const source of connectionSources.values()) dropConnectionSource(source);
        service.dispose();
        for (const cleanup of cleanups.splice(0)) cleanup();
        for (const adapter of new Set([serialAdapter, netAdapter, primarySource.adapter])) releaseTransport(adapter);
        return workspaceStorage.dispose();
    }
    function recoverWorkspaceView(layout) {
        // A reload can finish before the debounced IndexedDB transaction commits.
        let pending;
        try {
            const raw = globalThis.sessionStorage?.getItem(WORKSPACE_RELOAD_KEY);
            if (!raw) return false;
            globalThis.sessionStorage.removeItem(WORKSPACE_RELOAD_KEY);
            pending = JSON.parse(raw);
        } catch { return false; }
        if (storageBlocked || !pending?.rects || pending.step !== layout.step ||
            !Number.isFinite(pending.zoom) || pending.zoom < 0.25 || pending.zoom > 5 ||
            pending.view !== undefined && !S.validWorkspaceView(pending.view)) return false;
        const ids = Object.keys(layout.rects);
        if (ids.length !== Object.keys(pending.rects).length || ids.some(id => {
            const rect = pending.rects[id];
            return !rect || ['x', 'y', 'width', 'height'].some(key => rect[key] !== layout.rects[id][key]);
        })) return false;
        if (pending.zoom === layout.zoom && JSON.stringify(pending.view) === JSON.stringify(layout.view)) return false;
        layout.zoom = pending.zoom;
        if (pending.view === undefined) delete layout.view;
        else layout.view = pending.view;
        return true;
    }
    const recoveredView = recoverWorkspaceView(initial.workspace);
    installWidgets(initial); restoring = false; setTaskProgress('config-restore'); updateStats();
    if (recoveredView) saveSoon();
    const statsTimer = setInterval(updateStats, 1000);
    S.application = { service, widgets, workspace, tools, serialAdapter, serialSources: connectionSources, netAdapter, sendController,
        protocolSession, regularProtocolView, commandLibrary, commandRunner, commandView, getConfig, applyConfig, dispose, exportData, exportWidgetData, updateStats,
        dataEngine, engineView, workspaceChannels, workspaceStorage, saveNow, saveSoon, flushConfig };
    listen(window, 'pagehide', () => {
        if (!disposed && !restoring && !storageBlocked) {
            try { globalThis.sessionStorage?.setItem(WORKSPACE_RELOAD_KEY, JSON.stringify(workspace.serialize())); }
            catch { /* Normal configuration autosave remains available. */ }
        }
        return dispose();
    });
    return S.application;
}

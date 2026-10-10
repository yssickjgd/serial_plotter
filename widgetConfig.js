/** Versioned workspace configuration. Runtime byte positions never enter saved settings. */
const widgetConfigUtils = typeof module !== 'undefined' ? require('./configValidation') : globalThis.SerialPlotter;
const widgetDisplayUtils = typeof module !== 'undefined' ? require('./monitorDisplay') : globalThis.SerialPlotter.MonitorDisplay;
const widgetChannelUtils = typeof module !== 'undefined' ? require('./channelOperations') : globalThis.SerialPlotter;
const widgetViewportUtils = () => typeof module !== 'undefined' ? require('./widgetViewport') : globalThis.SerialPlotter.WidgetViewport;
const widgetPoseUtils = () => typeof module !== 'undefined' ? require('./poseConfig').PoseConfig : globalThis.SerialPlotter.PoseConfig;

const GLOBAL_DEFAULTS = {
    connType: 'serial', serialBaud: '115200', serialData: '8', serialStop: '1', serialParity: 'none',
    netHost: '127.0.0.1', netPort: '8081', netLocalPort: '', maxPoints: '1000', plotWindowPoints: '1000',
    maxRawFrameBytes: 1048576, rebuildHistory: true, channelsCount: '1', dataType: 'float32',
    endianness: 'little', enableHeader: true, headerHex: 'AB', enableFooter: false,
    footerHex: '0D 0A', enableChecksum: false, channelNames: ['CH01'], channelColors: [], channelDefinitions: []
};
const WAVE_DEFAULTS = {
    plotViewMode: 'time', plotTimeXUnit: 'samples', plotFreqXUnit: 'hz',
    plotFreqXScale: 'log', plotFreqYScale: 'linear', plotFftWindow: 'hann', plotFftRemoveDc: true,
    plotContent: 'samples', plotMagnitudeUnit: 'db', plotDbFactor: '10', plotPhaseUnwrap: true, plotPhaseUnit: 'radians',
    plotResponseSampleRate: '0', plotResponseTimePoints: '1000', responseChannels: [], responseViewport: null,
    plotYScaleModePhase: 'auto', plotYMinPhase: String(-Math.PI), plotYMaxPhase: String(Math.PI),
    plotYScaleModeDb: 'auto', plotYMinDb: '-80', plotYMaxDb: '20',
    plotYScaleModeTime: 'auto', plotYScaleModeFreq: 'auto', plotYMinTime: '-1', plotYMaxTime: '1',
    plotYMinFreq: '0.001', plotYMaxFreq: '1', channels: [], viewport: null, exportSettings: null
};
const BYTE_DEFAULTS = {
    captureMode: 'hex', textEncoding: 'utf-8', textBoundary: 'idle', idleGapSeconds: '0.001', exportSettings: null
};
const copy = value => JSON.parse(JSON.stringify(value));
const isValidWidgetId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && !['numeric', 'base'].includes(id);
const pick = (object, defaults) => Object.fromEntries(Object.keys(defaults)
    .map(key => [key, object[key] === undefined ? copy(defaults[key]) : copy(object[key])]));

function normalizeExportProfile(profile = {}) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('导出配置无效');
    const result = { direction: 'rx', encoding: 'utf-8', timestamps: false, markers: false,
        channelIndices: null, encodingEdited: false, outputEncoding: 'utf-8', textBoundary: 'records',
        textParsingEdited: false, numericFormat: null, ...profile };
    if (!['rx', 'tx', 'both'].includes(result.direction) || typeof result.encoding !== 'string' ||
        ['timestamps', 'markers', 'encodingEdited'].some(key => typeof result[key] !== 'boolean') ||
        result.channelIndices !== null && (!Array.isArray(result.channelIndices) ||
            result.channelIndices.some(index => !Number.isInteger(index) || index < 0 || index >= widgetChannelUtils.CHANNEL_LIMIT) ||
            new Set(result.channelIndices).size !== result.channelIndices.length)) throw new Error('导出配置无效');
    widgetConfigUtils.validateConfig({ textEncoding: result.encoding });
    widgetConfigUtils.validateConfig({ textEncoding: result.outputEncoding });
    if (typeof result.outputEncoding !== 'string' || typeof result.textParsingEdited !== 'boolean' ||
        !['records', 'idle', 'cr', 'lf', 'crlf', 'lfcr'].includes(result.textBoundary)) throw new Error('导出文本帧配置无效');
    if (result.numericFormat !== null) {
        if (!result.numericFormat || typeof result.numericFormat !== 'object' || Array.isArray(result.numericFormat)) throw new Error('导出数值帧配置无效');
        widgetConfigUtils.validateConfig(result.numericFormat);
        for (const key of ['dataType', 'endianness', 'channelsCount', 'headerHex', 'footerHex'])
            if (typeof result.numericFormat[key] !== 'string') throw new Error('导出数值帧参数必须完整');
        for (const key of ['enableHeader', 'enableFooter', 'enableChecksum'])
            if (typeof result.numericFormat[key] !== 'boolean') throw new Error('导出帧启用值无效');
    }
    return pick(result, { direction: 'rx', encoding: 'utf-8', timestamps: false, markers: false,
        channelIndices: null, encodingEdited: false, outputEncoding: 'utf-8', textBoundary: 'records',
        textParsingEdited: false, numericFormat: null });
}

function normalizeWidgetExportSettings(type, input) {
    if (input === null || input === undefined) return null;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('导出配置无效');
    const allowed = type === 'wave' ? ['binary', 'hex-text', 'text', 'csv'] : ['binary', 'hex-text', 'text'];
    if (!allowed.includes(input.format) || !input.formats || typeof input.formats !== 'object' || Array.isArray(input.formats) ||
        Object.keys(input.formats).some(format => !allowed.includes(format))) throw new Error('导出格式配置无效');
    return { format: input.format, formats: Object.fromEntries(allowed.map(format => {
        const profile = normalizeExportProfile(input.formats[format]);
        if (type === 'wave') profile.direction = 'rx';
        return [format, profile];
    })) };
}

function normalizeBufferExportSettings(input, defaultFormat = 'hex-text') {
    input ??= { format: defaultFormat, formats: {} };
    const allowed = ['binary', 'hex-text', 'text', 'csv'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || !allowed.includes(input.format) ||
        !input.formats || typeof input.formats !== 'object' || Array.isArray(input.formats) ||
        Object.keys(input.formats).some(format => !allowed.includes(format))) throw new Error('缓冲区导出配置无效');
    return { format: input.format, formats: Object.fromEntries(allowed.map(format => {
        const profile = normalizeExportProfile(input.formats[format]);
        if (format === 'csv') profile.direction = 'rx';
        return [format, profile];
    })) };
}

function legacyWindowPoints(settings = {}) {
    if (!settings || typeof settings !== 'object') return undefined;
    widgetConfigUtils.validateConfig({ plotWindowPoints: settings.plotWindowPoints, plotResponsePoints: settings.plotResponsePoints });
    return settings.plotContent === 'response' && settings.plotResponsePoints !== undefined
        ? settings.plotResponsePoints : settings.plotWindowPoints ?? settings.plotResponsePoints;
}

function normalizeWidgetSettings(type, settings = {}, globals = GLOBAL_DEFAULTS) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('控件设置无效');
    if (type === 'pose') {
        const originalCount = Number(globals.channelsCount);
        const engine = new widgetChannelUtils.ChannelOperations(originalCount, globals.channelDefinitions ?? []);
        return widgetPoseUtils().normalize(settings, { channelCount: engine.channelCount,
            isSignal: index => index < originalCount || engine.entries.get(index + 1)?.definition.type === 'formula' });
    }
    if (type === 'wave') {
        const result = pick(settings, WAVE_DEFAULTS);
        result.plotResponseTimePoints = settings.plotResponseTimePoints ?? settings.plotResponsePoints ?? String(Math.max(2, Number(globals.plotWindowPoints)));
        widgetConfigUtils.parseIntInRange(result.plotResponseTimePoints, 2, 65536, '系统响应时域采样点数');
        result.plotResponseTimePoints = String(result.plotResponseTimePoints);
        result.plotYMinPhase = settings.plotYMinPhase ?? (result.plotPhaseUnit === 'radians' ? String(-Math.PI) : '-180');
        result.plotYMaxPhase = settings.plotYMaxPhase ?? (result.plotPhaseUnit === 'radians' ? String(Math.PI) : '180');
        // Validate legacy per-widget counts; current settings store the count globally.
        legacyWindowPoints(settings);
        result.exportSettings = normalizeWidgetExportSettings(type, result.exportSettings);
        widgetConfigUtils.validateConfig({ channels: result.responseChannels });
        if (result.responseViewport !== null)
            result.responseViewport = widgetViewportUtils().normalizeWidgetViewport(result.responseViewport);
        Object.assign(result, widgetConfigUtils.normalizeYConfig(settings));
        if (result.viewport !== null) {
            result.viewport = widgetViewportUtils().normalizeWidgetViewport(result.viewport);
            result.viewport.time.displayCount = Math.min(result.viewport.time.displayCount, Number(globals.maxPoints));
        }
        widgetConfigUtils.validateConfig({ ...globals, ...result });
        return result;
    }
    if (type !== 'byte') throw new Error('控件类型无效');
    const result = pick(settings, BYTE_DEFAULTS);
    result.exportSettings = normalizeWidgetExportSettings(type, result.exportSettings);
    result.monitorDisplay = widgetDisplayUtils.normalizeDisplayOptions(settings.monitorDisplay ?? {});
    widgetConfigUtils.validateConfig({ ...globals, ...result });
    result.textEncoding = globals.textEncoding ?? result.textEncoding;
    result.textBoundary = globals.textBoundary ?? result.textBoundary;
    // Retain the legacy field for configuration compatibility; widget idle framing is fixed.
    result.idleGapSeconds = BYTE_DEFAULTS.idleGapSeconds;
    return result;
}

function validateWorkspaceConfig(config) {
    if (!config || config.version !== 2 || !config.global || typeof config.global !== 'object' ||
        Array.isArray(config.global) || !Array.isArray(config.widgets))
        throw new Error('工作区配置版本或结构无效');
    const globals = pick(config.global, GLOBAL_DEFAULTS);
    const legacyText = config.widgets.find(widget => widget?.type === 'byte' && widget.settings?.captureMode === 'text') ??
        config.widgets.find(widget => widget?.type === 'byte');
    globals.textEncoding = config.global.textEncoding ?? legacyText?.settings?.textEncoding ?? 'utf-8';
    globals.textBoundary = config.global.textBoundary ?? legacyText?.settings?.textBoundary ?? 'idle';
    const windowPoints = config.global.plotWindowPoints ??
        legacyWindowPoints(config.widgets.find(widget => widget?.type === 'wave')?.settings) ?? GLOBAL_DEFAULTS.plotWindowPoints;
    widgetConfigUtils.validateConfig({ plotWindowPoints: windowPoints });
    globals.plotWindowPoints = String(Math.min(Number(windowPoints), Number(globals.maxPoints)));
    widgetConfigUtils.validateConfig(globals);
    if (!Number.isSafeInteger(globals.maxRawFrameBytes) || globals.maxRawFrameBytes < 64 || globals.maxRawFrameBytes > 64 * 1024 * 1024)
        throw new Error('原始帧分段上限需为 64–67108864 字节的整数');
    if (!Array.isArray(globals.channelNames) || globals.channelNames.some(name => typeof name !== 'string'))
        throw new Error('通道名称无效');
    if (!Array.isArray(globals.channelColors) || globals.channelColors.some(color =>
        typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) throw new Error('通道颜色无效');
    if (!Array.isArray(globals.channelDefinitions)) throw new Error('通道运算配置无效');
    new widgetChannelUtils.ChannelOperations(Number(globals.channelsCount), globals.channelDefinitions);
    const ids = new Set();
    const widgets = config.widgets.map(widget => {
        if (!widget || !isValidWidgetId(widget.id) || ids.has(widget.id)) throw new Error('控件编号无效或重复');
        if (!['wave', 'byte', 'pose'].includes(widget.type) || typeof widget.title !== 'string' || !widget.title.trim())
            throw new Error('控件类型或标题无效');
        ids.add(widget.id);
        return { id: widget.id, type: widget.type, title: widget.title,
            settings: normalizeWidgetSettings(widget.type, widget.settings, globals) };
    });
    const workspace = copy(config.workspace ?? { step: 10, rects: {} });
    if (workspace.zoom === undefined) workspace.zoom = 1;
    if (!Number.isFinite(workspace.zoom) || workspace.zoom < 0.25 || workspace.zoom > 5)
        throw new Error('工作区缩放比例需在 25%–500% 之间');
    workspace.zoom = Math.round(workspace.zoom * 100) / 100;
    if (![10, 20, 40].includes(workspace.step) || !workspace.rects || typeof workspace.rects !== 'object' || Array.isArray(workspace.rects))
        throw new Error('工作区布局无效');
    const rects = [];
    for (const [id, rect] of Object.entries(workspace.rects)) {
        if (!ids.has(id) || !rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]) && rect[key] <= 1e7) ||
            rect.x < 0 || rect.y < 0 || rect.width < 100 || rect.height < 100) throw new Error('控件位置或尺寸无效');
        if (rects.some(other => rect.x < other.x + other.width && rect.x + rect.width > other.x &&
            rect.y < other.y + other.height && rect.y + rect.height > other.y)) throw new Error('控件布局不能重叠');
        rects.push(rect);
    }
    if (config.tools !== undefined && (!config.tools || typeof config.tools !== 'object' || Array.isArray(config.tools)))
        throw new Error('工具设置无效');
    const tools = copy(config.tools ?? {});
    for (const key of ['sourceId', 'referenceId', 'exportSourceId', 'exportRecordSourceId', 'exportCsvSourceId'])
        if (tools[key] !== undefined && tools[key] !== null && typeof tools[key] !== 'string') throw new Error('工具数据来源无效');
    const exported = tools.exportSettings;
    if (exported !== undefined) {
        if (!exported || typeof exported !== 'object' || Array.isArray(exported) ||
            !['binary', 'hex-text', 'text', 'csv'].includes(exported.format) || !['rx', 'tx', 'both'].includes(exported.direction) ||
            !Array.isArray(exported.channelIndices) || exported.channelIndices.some(index => !Number.isInteger(index) || index < 0 || index >= widgetChannelUtils.CHANNEL_LIMIT) ||
            new Set(exported.channelIndices).size !== exported.channelIndices.length ||
            ['timestamps', 'markers'].some(key => typeof exported[key] !== 'boolean') ||
            (exported.encodingEdited !== undefined && typeof exported.encodingEdited !== 'boolean')) throw new Error('导出设置无效');
        widgetConfigUtils.validateConfig({ textEncoding: exported.encoding });
        if (typeof exported.encoding !== 'string') throw new Error('导出字符集无效');
        const target = widgets.find(widget => widget.id === tools.exportSourceId) ??
            widgets.find(widget => tools.exportSourceId === 'numeric' ? widget.type === 'wave' :
                tools.exportSourceId === 'base' && widget.type === 'byte');
        if (target && target.settings.exportSettings === null && (target.type === 'wave' || exported.format !== 'csv')) {
            const { format, ...profile } = exported;
            target.settings.exportSettings = normalizeWidgetExportSettings(target.type, { format, formats: { [format]: profile } });
        }
    }
    const legacyId = tools.exportSourceId ?? tools.sourceId;
    const legacyWidget = widgets.find(widget => widget.id === legacyId);
    if (tools.exportProfiles !== undefined && (!tools.exportProfiles || typeof tools.exportProfiles !== 'object' || Array.isArray(tools.exportProfiles)))
        throw new Error('缓冲区导出配置无效');
    const profiles = tools.exportProfiles ?? {};
    for (const [id, profile] of Object.entries(profiles)) {
        if (!['numeric', 'base'].includes(id) && !isValidWidgetId(id)) throw new Error('导出数据来源无效');
        if (profile === null) throw new Error('缓冲区导出配置无效');
        profiles[id] = normalizeBufferExportSettings(profile);
    }
    const numericLegacy = legacyWidget?.type === 'wave' ? legacyWidget : widgets.find(widget => widget.type === 'wave');
    if (!Object.hasOwn(profiles, 'numeric')) profiles.numeric = normalizeBufferExportSettings(numericLegacy?.settings.exportSettings, 'csv');
    if (!Object.hasOwn(profiles, 'base')) profiles.base = normalizeBufferExportSettings(null);
    for (const widget of widgets) if (widget.type === 'byte' && !Object.hasOwn(profiles, widget.id))
        Object.defineProperty(profiles, widget.id, { enumerable: true, configurable: true, writable: true,
            value: normalizeBufferExportSettings(widget.settings.exportSettings, widget.settings.captureMode === 'number' ? 'csv' :
                widget.settings.captureMode === 'text' ? 'text' : 'hex-text') });
    tools.exportSourceId = tools.exportSourceId === null ? null : legacyWidget?.type === 'wave' ? 'numeric' : legacyId ?? 'numeric';
    if (exported && !tools.exportProfiles && ['numeric', 'base'].includes(tools.exportSourceId)) {
        const { format, ...profile } = exported;
        profiles[tools.exportSourceId] = normalizeBufferExportSettings({ format, formats: { [format]: profile } });
    }
    tools.exportProfiles = profiles;
    tools.exportFormat ??= profiles[tools.exportSourceId]?.format ?? 'hex-text';
    if (!['binary', 'hex-text', 'text', 'csv'].includes(tools.exportFormat)) throw new Error('导出格式无效');
    if (tools.exportRecordSourceId === undefined)
        tools.exportRecordSourceId = tools.exportFormat === 'csv' ? 'base' : tools.exportSourceId;
    tools.exportCsvSourceId ??= 'numeric';
    const nextNumber = config.nextNumber ?? widgets.length + 1;
    if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) throw new Error('控件序号无效');
    if (config.send !== undefined && (!config.send || typeof config.send !== 'object' || Array.isArray(config.send)))
        throw new Error('发送设置无效');
    const send = { interval: '0', unit: 's', mode: 'hex', ...config.send };
    if (!['hex', 'text'].includes(send.mode) || !['s', 'hz'].includes(send.unit) ||
        !['string', 'number'].includes(typeof send.interval) || String(send.interval).trim() === '' ||
        !Number.isFinite(Number(send.interval)) || Number(send.interval) < 0)
        throw new Error('发送模式、间隔或单位无效');
    if (!globals.channelColors.length) {
        const colors = widgets.find(widget => widget.type === 'wave')?.settings.channels ?? [];
        globals.channelColors = colors.map(channel => channel.color ?? '#ff0000');
    }
    return { version: 2, global: globals, widgets, workspace, nextNumber, tools, send };
}

function migrateWorkspaceConfig(legacy, legacyLayout) {
    if (legacy?.version === 2) return validateWorkspaceConfig(legacy);
    if (legacy?.version !== undefined) throw new Error('工作区配置版本无效');
    if (legacy === null || legacy === undefined) return validateWorkspaceConfig({
        version: 2, global: GLOBAL_DEFAULTS, widgets: [], workspace: { step: 10, rects: {} }, nextNumber: 1
    });
    widgetConfigUtils.validateConfig(legacy);
    const globals = { ...GLOBAL_DEFAULTS, ...pick(legacy, GLOBAL_DEFAULTS),
        channelNames: legacy.channels?.map((channel, index) => channel.name ?? `CH${String(index + 1).padStart(2, '0')}`) ?? ['CH01'] };
    globals.plotWindowPoints = String(Math.min(Number(legacyWindowPoints(legacy) ?? GLOBAL_DEFAULTS.plotWindowPoints), Number(globals.maxPoints)));
    const waveSettings = normalizeWidgetSettings('wave', legacy, globals);
    const widgets = [
        { id: 'wave-1', type: 'wave', title: '波形 1', settings: waveSettings },
        { id: 'byte-1', type: 'byte', title: '字节流 1', settings: { ...BYTE_DEFAULTS, ...pick(legacy, BYTE_DEFAULTS),
            captureMode: legacy.captureMode ?? 'number', monitorDisplay: legacy.monitorDisplay ?? {} } }
    ];
    const oldRects = legacyLayout?.layouts?.both?.rects;
    const rects = oldRects ? { 'wave-1': oldRects.wave, 'byte-1': oldRects.byte } : {};
    return validateWorkspaceConfig({ version: 2, global: globals, widgets,
        workspace: { step: legacyLayout?.step ?? 10, rects }, nextNumber: 2,
        tools: { sourceId: 'byte-1', referenceId: 'byte-1', exportSourceId: 'numeric' } });
}

const WidgetConfig = { GLOBAL_DEFAULTS, WAVE_DEFAULTS, BYTE_DEFAULTS,
    isValidWidgetId, normalizeWidgetExportSettings, normalizeBufferExportSettings, normalizeWidgetSettings, validateWorkspaceConfig, migrateWorkspaceConfig };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.WidgetConfig = WidgetConfig;
if (typeof module !== 'undefined') module.exports = WidgetConfig;

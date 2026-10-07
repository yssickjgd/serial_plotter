const configYUtils = typeof module !== 'undefined' ? require('./configValidation') : globalThis.SerialPlotter;
const configMonitorViewUtils = typeof module !== 'undefined'
    ? require('./monitorDisplayView') : globalThis.SerialPlotter;
const CONFIG_VALUE_FIELDS = [
    'serialBaud', 'serialData', 'serialStop', 'serialParity',
    'netHost', 'netPort', 'netLocalPort', 'headerHex', 'footerHex',
    'dataType', 'endianness', 'channelsCount', 'maxPoints', 'plotWindowPoints',
    'sendIntervalUnit', 'plotViewMode', 'plotYScaleMode',
    'plotTimeXUnit', 'plotFreqXUnit', 'plotFreqXScale', 'plotFreqYScale',
    'plotFftWindow'
];
const CONFIG_CHECK_FIELDS = ['enableHeader', 'enableFooter', 'enableChecksum', 'plotFftRemoveDc', 'rebuildHistory'];
const CAPTURE_DEFAULTS = { captureMode: 'number', textEncoding: 'utf-8', textBoundary: 'idle', idleGapSeconds: '0.001' };

function collectConfigFromView(elements, bounds, channelMeta) {
    const config = { connType: elements.connType.value };
    for (const key of CONFIG_VALUE_FIELDS) config[key] = elements[key].value;
    for (const [key, defaultValue] of Object.entries(CAPTURE_DEFAULTS))
        config[key] = elements[key]?.value ?? defaultValue;
    for (const key of CONFIG_CHECK_FIELDS) config[key] = elements[key]?.checked ?? (key === 'rebuildHistory');
    Object.assign(config, {
        monitorDisplay: configMonitorViewUtils.collectMonitorDisplayFromView(elements.monitorDisplay),
        plotYMinTime: bounds.time.min, plotYMaxTime: bounds.time.max,
        plotYMinFreq: bounds.frequency.min, plotYMaxFreq: bounds.frequency.max,
        plotYScaleModeTime: bounds.time.scaleMode ?? elements.plotYScaleMode.value,
        plotYScaleModeFreq: bounds.frequency.scaleMode ?? elements.plotYScaleMode.value,
        channels: channelMeta.map(({ name, color, visible,
            gainEnabled, gain, offsetEnabled, offset }) => ({
            name, color, visible, gainEnabled, gain, offsetEnabled, offset
        }))
    });
    return config;
}

function updatePlotOptionVisibility(elements) {
    const mode = elements.plotViewMode.value === 'frequency' ? 'frequency' : 'time';
    elements.wrapFftRemoveDc.style.display = mode === 'frequency' ? '' : 'none';
    elements.wrapPlotTimeAxis.style.display = mode === 'time' ? '' : 'none';
    elements.wrapPlotFreqAxis.style.display = mode === 'frequency' ? '' : 'none';
    elements.wrapPlotYBounds.style.display = elements.plotYScaleMode.value === 'manual' ? '' : 'none';
}

function applyConfigToView(config, { elements, bounds, updateConnectionModeUI,
    updateFrameFormat, updateChannels, updatePlot, syncPlotChoices, updateMonitorDisplay }) {
    elements.connType.value = config.connType || 'serial';
    updateConnectionModeUI();
    for (const key of CONFIG_VALUE_FIELDS) {
        if (config[key] !== undefined) elements[key].value = config[key];
    }
    for (const [key, defaultValue] of Object.entries(CAPTURE_DEFAULTS))
        if (elements[key]) elements[key].value = config[key] ?? defaultValue;
    if (elements.sendIntervalUnit.value === 'ms') {
        const milliseconds = Number(elements.sendInterval?.value);
        if (Number.isFinite(milliseconds) && elements.sendInterval)
            elements.sendInterval.value = String(milliseconds / 1000);
        elements.sendIntervalUnit.value = 's';
    }
    if (config.plotWindowPoints === undefined)
        elements.plotWindowPoints.value = String(Math.min(1000,
            Number(elements.maxPoints.value) || 1000));
    for (const [key, defaultValue] of Object.entries({
        plotTimeXUnit: 'samples', plotFreqXUnit: 'hz',
        plotFreqXScale: 'linear', plotFreqYScale: 'linear', plotFftWindow: 'hann'
    })) {
        if (!elements[key].value) elements[key].value = defaultValue;
    }
    for (const key of CONFIG_CHECK_FIELDS) {
        if (elements[key] && (config[key] !== undefined || key === 'rebuildHistory'))
            elements[key].checked = config[key] ?? true;
    }
    if (config.plotFftWindow === undefined) elements.plotFftWindow.value = 'hann';
    const mode = elements.plotViewMode.value === 'frequency' ? 'frequency' : 'time';
    const yConfig = configYUtils.normalizeYConfig(config, {
        plotViewMode: mode, plotFreqYScale: elements.plotFreqYScale.value
    });
    bounds.time.min = yConfig.plotYMinTime;
    bounds.time.max = yConfig.plotYMaxTime;
    bounds.frequency.min = yConfig.plotYMinFreq;
    bounds.frequency.max = yConfig.plotYMaxFreq;
    bounds.time.scaleMode = yConfig.plotYScaleModeTime;
    bounds.frequency.scaleMode = yConfig.plotYScaleModeFreq;
    elements.plotYScaleMode.value = bounds[mode].scaleMode;
    elements.plotYMin.value = bounds[mode].min;
    elements.plotYMax.value = bounds[mode].max;
    configMonitorViewUtils.applyMonitorDisplayToView(config.monitorDisplay, elements.monitorDisplay);
    if (updateMonitorDisplay) updateMonitorDisplay();
    updateFrameFormat();
    updateChannels(config.channels);
    updatePlot();
    updatePlotOptionVisibility(elements);
    if (syncPlotChoices) syncPlotChoices();
}

globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, {
    collectConfigFromView, applyConfigToView, updatePlotOptionVisibility, CaptureDefaults: CAPTURE_DEFAULTS
});
if (typeof module !== 'undefined') module.exports = {
    collectConfigFromView, applyConfigToView, updatePlotOptionVisibility
};

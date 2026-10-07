const monitorDisplayViewUtils = typeof module !== 'undefined'
    ? require('./monitorDisplay') : globalThis.SerialPlotter.MonitorDisplay;

const MONITOR_DISPLAY_IDS = {
    hexBytesPerLine: 'monitor-hex-bytes-per-line', hexGroupBytes: 'monitor-hex-group-bytes',
    hexOffset: 'monitor-hex-offset', hexAscii: 'monitor-hex-ascii',
    textInvalid: 'monitor-text-invalid', textNewline: 'monitor-text-newline', textTab: 'monitor-text-tab',
    timestamp: 'monitor-timestamp', showDirection: 'monitor-show-direction',
    showRx: 'monitor-show-rx', showTx: 'monitor-show-tx', showErrors: 'monitor-show-errors',
    keyword: 'monitor-keyword', keywordColor: 'monitor-keyword-color',
    keywordFormat: 'monitor-keyword-format',
    keywordCaseSensitive: 'monitor-keyword-case-sensitive',
    rxColor: 'monitor-rx-color', txColor: 'monitor-tx-color',
    rxErrorColor: 'monitor-rx-error-color', txErrorColor: 'monitor-tx-error-color',
    searchCurrentColor: 'monitor-search-current-color', searchMatchColor: 'monitor-search-match-color',
    foldLong: 'monitor-fold-long', foldLines: 'monitor-fold-lines', refreshRate: 'monitor-refresh-rate',
    numericSignificantDigits: 'monitor-numeric-significant-digits'
};

function collectMonitorDisplayFromView(elements = {}) {
    const options = {};
    for (const [key, defaultValue] of Object.entries(monitorDisplayViewUtils.DEFAULTS)) {
        if (!elements[key]) continue;
        options[key] = typeof defaultValue === 'boolean' ? elements[key].checked : elements[key].value;
        if (key === 'foldLines' || key === 'numericSignificantDigits') options[key] = Number(options[key]);
    }
    return monitorDisplayViewUtils.normalizeDisplayOptions(options);
}

function applyMonitorDisplayToView(options, elements = {}) {
    const normalized = monitorDisplayViewUtils.normalizeDisplayOptions(options);
    for (const [key, value] of Object.entries(normalized)) {
        if (!elements[key]) continue;
        if (typeof value === 'boolean') elements[key].checked = value;
        else elements[key].value = String(value);
    }
    return normalized;
}

/** Keep display controls separate from frame parsing and history retention. */
class MonitorDisplayView {
    constructor(document, { onChange = () => {} } = {}) {
        this.document = document;
        this.elements = Object.fromEntries(Object.entries(MONITOR_DISPLAY_IDS)
            .map(([key, id]) => [key, document.getElementById(id)]));
        this.status = document.getElementById('monitor-display-status');
        this.apply();
        const changed = () => {
            this.syncFoldVisibility();
            this.syncKeywordVisibility();
            try {
                const options = this.read();
                onChange(options);
                this.showError('');
            } catch (error) {
                this.showError(`显示设置无效：${error.message}`);
            }
        };
        for (const [key, element] of Object.entries(this.elements)) {
            element.addEventListener('change', changed);
            if (key === 'keyword' || key.endsWith('Color') || key === 'foldLines' || key === 'numericSignificantDigits')
                element.addEventListener('input', changed);
        }
        this.setMode('number');
    }

    read() { return collectMonitorDisplayFromView(this.elements); }

    apply(options) {
        applyMonitorDisplayToView(options, this.elements);
        this.syncFoldVisibility();
        this.syncKeywordVisibility();
        this.showError('');
    }

    syncFoldVisibility() {
        this.document.getElementById('monitor-fold-lines-wrap').hidden = !this.elements.foldLong.checked;
    }

    syncKeywordVisibility() {
        const hex = this.elements.keywordFormat.value === 'hex';
        this.document.getElementById('monitor-keyword-case-wrap').hidden = hex;
        this.elements.keyword.placeholder = hex ? 'AB CD EF\n0D 0A' : 'alarm\nERROR';
        this.document.getElementById('monitor-keyword-hint').textContent = hex
            ? '每行一个 Hex 字节序列，例如 AB CD EF；最多 32 个关键词，每行最多 256 个字符。'
            : '按原文匹配；最多 32 个关键词，每行最多 256 个字符。';
    }

    showError(message) {
        this.status.textContent = message;
        this.status.hidden = !message;
    }

    setMode(mode) {
        this.document.getElementById('monitor-display-panel').hidden = false;
        this.document.getElementById('monitor-config-panel').hidden = false;
        this.document.getElementById('monitor-hex-options').hidden = mode !== 'hex';
        this.document.getElementById('monitor-text-options').hidden = mode !== 'text';
        this.document.getElementById('monitor-number-options').hidden = mode !== 'number';
        this.syncFoldVisibility();
        this.syncKeywordVisibility();
    }
}

globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, {
    MonitorDisplayView, collectMonitorDisplayFromView, applyMonitorDisplayToView
});
if (typeof module !== 'undefined') module.exports = {
    MonitorDisplayView, collectMonitorDisplayFromView, applyMonitorDisplayToView
};

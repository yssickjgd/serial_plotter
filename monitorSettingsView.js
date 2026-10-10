/** Select configuration categories for the active monitor without changing acquisition state. */
class MonitorSettingsView {
    constructor(root, document = globalThis.document) {
        this.document = document;
        this.buttons = [...root.querySelectorAll('.tab-btn')];
        this.tabs = {
            wave: new Set(['tab-waveform-frame', 'tab-waveform-config', 'tab-waveform-channels']),
            byte: new Set(['tab-byte-frame', 'tab-monitor-config', 'tab-monitor-channels'])
        };
        this.lastTab = { wave: 'tab-waveform-config', byte: 'tab-monitor-config' };
        this.context = null;
        for (const button of this.buttons)
            button.addEventListener('click', () => this.select(button.dataset.tab));
        this.activate('byte');
    }

    activate(context) {
        if (!this.tabs[context] || this.context === context) return;
        this.context = context;
        this.document.getElementById('active-monitor-caption').textContent = context === 'wave'
            ? '波形监视台' : '字节流监视台';
        for (const button of this.buttons) {
            const id = button.dataset.tab;
            const hidden = !this.tabs[context].has(id);
            button.hidden = hidden;
            this.document.getElementById(id).hidden = hidden;
        }
        this.select(this.lastTab[context]);
    }

    select(id) {
        if (!this.tabs[this.context].has(id)) return;
        this.activeTab = id;
        this.lastTab[this.context] = id;
        for (const button of this.buttons) {
            const selected = button.dataset.tab === id;
            const panel = this.document.getElementById(button.dataset.tab);
            if (selected) { button.classList.add('active'); panel.classList.add('active'); }
            else { button.classList.remove('active'); panel.classList.remove('active'); }
            button.setAttribute?.('aria-pressed', String(selected));
        }
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.MonitorSettingsView = MonitorSettingsView;
if (typeof module !== 'undefined') module.exports = { MonitorSettingsView };

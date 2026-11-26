/** File presentation options for buffer export and active-widget export. */
const exportSettingsCodec = typeof module !== 'undefined'
    ? require('./textCodec') : globalThis.SerialPlotter.TextCodec;

class ExportSettingsView {
    constructor(document, { widget = false, onChange = () => {} } = {}) {
        this.document = document;
        this.widget = widget;
        this.prefix = widget ? 'widget-export' : 'export';
        this.allowedFormats = widget ? ['binary', 'hex-text', 'text', 'engine-text', 'csv', 'svg'] : ['binary', 'hex-text'];
        this.listeners = [];
        this.elements = Object.fromEntries(Object.entries({
            format: this.prefix + '-format', button: 'btn-' + this.prefix,
            timestamps: this.prefix + '-timestamps', markers: this.prefix + '-markers',
            ...(widget ? { outputEncoding: this.prefix + '-output-encoding', syncStates: this.prefix + '-sync-states' }
                : { direction: 'export-direction' })
        }).map(([key, id]) => [key, document.getElementById(id)]));
        for (const [key, element] of Object.entries(this.elements)) if (key !== 'button') {
            const listener = () => onChange(key);
            element.addEventListener('change', listener);
            this.listeners.push(() => element.removeEventListener?.('change', listener));
        }
    }

    dispose() { for (const remove of this.listeners.splice(0)) remove(); }

    applyProfile(profile) {
        for (const key of ['timestamps', 'markers', 'syncStates'])
            if (this.elements[key]) this.elements[key].checked = profile[key] ?? false;
        if (this.widget) this.elements.outputEncoding.value = profile.outputEncoding ?? 'utf-8';
        else this.elements.direction.value = profile.direction;
    }

    readProfile() {
        const { direction, timestamps, markers, outputEncoding, syncStates } = this.elements;
        return { timestamps: timestamps.checked, markers: markers.checked,
            ...(this.widget ? { outputEncoding: outputEncoding.value, syncStates: syncStates.checked } : { direction: direction.value }) };
    }

    read() {
        const { format } = this.elements;
        if (!this.allowedFormats.includes(format.value)) throw new RangeError('导出格式无效');
        const profile = this.readProfile();
        if (this.widget) {
            profile.direction = 'rx';
            if (['text', 'engine-text'].includes(format.value))
                profile.outputEncoding = exportSettingsCodec.normalizeTextEncoding(profile.outputEncoding);
        } else if (!['rx', 'tx', 'both'].includes(profile.direction)) throw new RangeError('导出范围无效');
        return { ...profile, format: format.value };
    }

    sync({ busy = false, available = false, syncAvailable = false } = {}) {
        const { format, button } = this.elements;
        const get = suffix => this.document.getElementById(this.prefix + suffix);
        this.document.getElementById('wrap-' + this.prefix + '-markers').hidden = format.value === 'csv';
        get('-text-metadata').hidden = format.value === 'binary' || format.value === 'svg';
        if (this.widget) {
            this.document.getElementById('wrap-widget-export-output-encoding').hidden =
                !['text', 'engine-text'].includes(format.value);
            get('-sync-states-wrap').hidden = format.value !== 'csv' || !syncAvailable;
        } else {
            this.document.getElementById('wrap-export-direction').hidden = false;
            get('-binary-hint').hidden = format.value !== 'binary';
            get('-retention-hint').hidden = false;
        }
        for (const element of Object.values(this.elements)) element.disabled = busy;
        button.disabled = busy || !available;
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.ExportSettingsView = ExportSettingsView;
if (typeof module !== 'undefined') module.exports = { ExportSettingsView };

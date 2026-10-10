/** Export controls bound to an independently selected buffer and its saved format profiles. */
const exportSettingsCodec = typeof module !== 'undefined'
    ? require('./textCodec') : globalThis.SerialPlotter.TextCodec;

class ExportSettingsView {
    constructor(document, { onChange = () => {} } = {}) {
        this.document = document;
        this.channels = [];
        this.excludedChannels = new Set();
        this.numericAvailable = true;
        this.busy = false;
        this.encodingEdited = false;
        this.textParsingEdited = false;
        this.numericFormatEdited = false;
        this.numericDefaults = { dataType: 'float32', endianness: 'little', channelsCount: '1',
            enableHeader: true, headerHex: 'AB', enableFooter: false, footerHex: '0D 0A', enableChecksum: false };
        this.onChange = onChange;
        this.allowedFormats = ['binary', 'hex-text', 'text', 'csv'];
        this.directionAvailable = true;
        this.listeners = [];
        this.elements = Object.fromEntries(Object.entries({
            format: 'export-format', direction: 'export-direction', encoding: 'export-encoding',
            timestamps: 'export-timestamps', markers: 'export-markers', button: 'btn-export',
            outputEncoding: 'export-output-encoding', textBoundary: 'export-text-boundary'
        }).map(([key, id]) => [key, document.getElementById(id)]));
        this.numericIds = { dataType: 'export-data-type', endianness: 'export-endianness', channelsCount: 'export-channels-count',
            enableHeader: 'export-chk-header', headerHex: 'export-frame-header', enableFooter: 'export-chk-footer',
            footerHex: 'export-frame-footer', enableChecksum: 'export-chk-checksum' };
        for (const [key, id] of Object.entries(this.numericIds)) {
            const field = document.getElementById(id);
            if (key.startsWith('enable')) field.checked = this.numericDefaults[key]; else field.value = this.numericDefaults[key];
        }
        for (const id of Object.values(this.numericIds)) this.listen(document.getElementById(id), 'change', () => {
            this.numericFormatEdited = true; this.sync(); this.onChange('numeric');
        });
        this.listen(this.elements.textBoundary, 'change', () => {
            this.textParsingEdited = true; document.getElementById('export-follow-text').checked = false;
        });
        this.listen(document.getElementById('export-follow-numeric'), 'change', () => {
            this.numericFormatEdited = !document.getElementById('export-follow-numeric').checked;
            if (!this.numericFormatEdited) for (const [key, id] of Object.entries(this.numericIds)) {
                const field = document.getElementById(id);
                if (key.startsWith('enable')) field.checked = this.numericDefaults[key]; else field.value = this.numericDefaults[key];
            }
            this.sync(); this.onChange('numeric');
        });
        this.listen(document.getElementById('export-follow-text'), 'change', () => {
            const follow = document.getElementById('export-follow-text').checked;
            this.encodingEdited = !follow; this.textParsingEdited = !follow;
            if (follow) {
                this.elements.encoding.value = this.textDefaults?.encoding ?? 'utf-8';
                this.elements.textBoundary.value = this.textDefaults?.boundary ?? 'idle';
            }
            this.onChange('profile');
        });
        this.listen(this.elements.format, 'change', () => { this.sync(); this.onChange('format'); });
        this.listen(this.elements.encoding, 'change', () => {
            this.encodingEdited = true; document.getElementById('export-follow-text').checked = false;
        });
        for (const [id, selected] of [['btn-export-channels-all-on', true], ['btn-export-channels-all-off', false]])
            this.listen(document.getElementById(id), 'click', () => {
                this.excludedChannels = new Set(selected ? [] : this.channels.map((_, index) => index));
                this.renderChannels();
                this.sync();
                this.onChange('channels');
            });
        this.sync();
    }

    listen(element, name, callback) {
        element.addEventListener(name, callback);
        this.listeners.push(() => element.removeEventListener?.(name, callback));
    }

    dispose() { for (const remove of this.listeners.splice(0)) remove(); }

    selectedChannels() {
        return this.channels.flatMap((channel, index) => this.excludedChannels.has(index) || channel.signal === false ? [] : [index]);
    }

    setParsingDefaults(numeric, text = {}) {
        for (const key of Object.keys(this.numericIds)) this.numericDefaults[key] = numeric[key];
        this.textDefaults = text;
    }

    readNumericFormat() {
        const result = Object.fromEntries(Object.entries(this.numericIds).map(([key, id]) => {
            const field = this.document.getElementById(id);
            return [key, key.startsWith('enable') ? field.checked : field.value];
        }));
        const api = typeof module !== 'undefined' ? require('./configValidation') : SerialPlotter;
        api.validateConfig(result);
        return result;
    }

    read() {
        const { format, direction, encoding, timestamps, markers } = this.elements;
        if (!this.allowedFormats.includes(format.value)) throw new RangeError('导出格式无效');
        if (format.value !== 'csv' && !['rx', 'tx', 'both'].includes(direction.value))
            throw new RangeError('导出范围无效');
        return { format: format.value, direction: format.value === 'csv' || !this.directionAvailable ? 'rx' : direction.value,
            encoding: format.value === 'text' ? exportSettingsCodec.normalizeTextEncoding(encoding.value) : 'utf-8',
            outputEncoding: format.value === 'text' ? exportSettingsCodec.normalizeTextEncoding(this.elements.outputEncoding.value) : 'utf-8',
            textBoundary: this.elements.textBoundary.value,
            numericFormat: format.value === 'csv' ? this.readNumericFormat() : null,
            numericFormatEdited: this.numericFormatEdited,
            timestamps: timestamps.checked, markers: markers.checked, channelIndices: this.selectedChannels() };
    }

    readProfile() {
        return { direction: this.elements.direction.value, encoding: this.elements.encoding.value,
            timestamps: this.elements.timestamps.checked, markers: this.elements.markers.checked,
            outputEncoding: this.elements.outputEncoding.value || 'utf-8', textBoundary: this.elements.textBoundary.value || 'records',
            textParsingEdited: this.textParsingEdited,
            numericFormat: this.numericFormatEdited ? this.readNumericFormat() : null,
            channelIndices: this.excludedChannels.size ? this.selectedChannels() : null, encodingEdited: this.encodingEdited };
    }

    applyProfile(profile, channels, defaultEncoding) {
        for (const key of ['direction', 'encoding']) this.elements[key].value = profile[key];
        for (const key of ['timestamps', 'markers']) this.elements[key].checked = profile[key];
        this.encodingEdited = profile.encodingEdited;
        this.textParsingEdited = profile.textParsingEdited ?? false;
        this.numericFormatEdited = profile.numericFormat !== null && profile.numericFormat !== undefined;
        this.document.getElementById('export-follow-text').checked = !this.encodingEdited && !this.textParsingEdited;
        this.elements.outputEncoding.value = profile.outputEncoding ?? 'utf-8';
        this.elements.textBoundary.value = this.textParsingEdited ? profile.textBoundary : this.textDefaults?.boundary ?? profile.textBoundary ?? 'records';
        const numeric = profile.numericFormat ?? this.numericDefaults;
        for (const [key, id] of Object.entries(this.numericIds)) {
            const field = this.document.getElementById(id);
            if (key.startsWith('enable')) field.checked = numeric[key]; else field.value = numeric[key];
        }
        this.setDefaultEncoding(defaultEncoding);
        this.excludedChannels = new Set(channels.flatMap((_, index) =>
            profile.channelIndices === null || profile.channelIndices.includes(index) ? [] : [index]));
        this.setChannels(channels);
    }

    setDefaultEncoding(encoding) {
        if (!this.encodingEdited) this.elements.encoding.value = exportSettingsCodec.normalizeTextEncoding(encoding);
    }

    setChannels(channels) {
        this.channels = channels.map(channel => ({ name: channel.name, signal: channel.signal }));
        for (const index of this.excludedChannels)
            if (index >= channels.length) this.excludedChannels.delete(index);
        this.renderChannels();
        this.sync();
    }

    renderChannels() {
        const labels = this.channels.flatMap(({ name, signal }, index) => {
            if (signal === false) return [];
            const label = this.document.createElement('label');
            label.className = 'export-channel-choice';
            const checkbox = this.document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = !this.excludedChannels.has(index);
            checkbox.disabled = this.busy;
            const text = this.document.createElement('span');
            const id = `CH${String(index + 1).padStart(2, '0')}`;
            text.textContent = name && name !== id ? `${id} · ${name}` : id;
            label.title = text.textContent;
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) this.excludedChannels.delete(index);
                else this.excludedChannels.add(index);
                this.sync();
                this.onChange('channels');
            });
            label.append(checkbox, text);
            return [label];
        });
        this.document.getElementById('export-channel-list').replaceChildren(...labels);
    }

    sync({ numericAvailable = this.numericAvailable, busy = this.busy, allowedFormats = this.allowedFormats,
        directionAvailable = this.directionAvailable } = {}) {
        this.numericAvailable = numericAvailable;
        this.busy = busy;
        this.allowedFormats = allowedFormats;
        this.directionAvailable = directionAvailable;
        const format = this.elements.format.value, csv = format === 'csv';
        this.document.getElementById('export-follow-numeric').checked = !this.numericFormatEdited;
        for (const id of ['export-follow-text', 'export-follow-numeric']) this.document.getElementById(id).disabled = busy;
        this.document.getElementById('wrap-export-source').hidden = !csv && this.elements.direction.value === 'tx';
        for (const option of this.elements.format.options) {
            option.hidden = false;
            option.disabled = !allowedFormats.includes(option.value) || option.value === 'csv' && !numericAvailable;
        }
        for (const element of Object.values(this.elements)) element.disabled = busy;
        this.document.getElementById('wrap-export-direction').hidden = csv || !directionAvailable;
        this.document.getElementById('wrap-export-encoding').hidden = format !== 'text';
        this.document.getElementById('wrap-export-text-parsing').hidden = format !== 'text';
        this.document.getElementById('wrap-export-numeric-parsing').hidden = !csv;
        this.document.getElementById('export-header-config').hidden = !this.document.getElementById('export-chk-header').checked;
        this.document.getElementById('export-footer-config').hidden = !this.document.getElementById('export-chk-footer').checked;
        for (const id of Object.values(this.numericIds)) this.document.getElementById(id).disabled = busy;
        this.document.getElementById('export-text-metadata').hidden = format === 'binary';
        this.document.getElementById('wrap-export-markers').hidden = csv;
        this.document.getElementById('export-channels-wrap').hidden = !csv;
        this.document.getElementById('export-binary-hint').hidden = format !== 'binary';
        this.document.getElementById('export-retention-hint').hidden = csv || !directionAvailable;
        const selected = this.selectedChannels().length;
        const total = this.channels.filter(channel => channel.signal !== false).length;
        this.document.getElementById('export-channel-summary').textContent = `导出通道（${selected} / ${total}）`;
        const unavailable = csv && (!numericAvailable || !selected);
        const status = this.document.getElementById('export-availability');
        status.textContent = !numericAvailable ? '暂无可导出的通道数值数据。' : '请至少选择一个导出通道。';
        status.hidden = !unavailable;
        this.parseError = '';
        if (csv) try { this.readNumericFormat(); } catch (error) { this.parseError = error.message; }
        const parseStatus = this.document.getElementById('export-parse-status');
        parseStatus.textContent = this.parseError; parseStatus.hidden = !this.parseError;
        this.elements.button.disabled = busy || unavailable || Boolean(this.parseError);
        for (const id of ['btn-export-channels-all-on', 'btn-export-channels-all-off'])
            this.document.getElementById(id).disabled = busy;
        for (const label of this.document.getElementById('export-channel-list').children)
            label.children[0].disabled = busy;
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.ExportSettingsView = ExportSettingsView;
if (typeof module !== 'undefined') module.exports = { ExportSettingsView };

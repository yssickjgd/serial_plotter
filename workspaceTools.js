/** Paused navigation and search across independent views of one receive byte stream. */
(function(root) {
    'use strict';
    const dependencies = typeof module !== 'undefined' && module.exports
        ? { MonitorSearch: require('./monitorSearch'), FrameNavigation: require('./frameNavigation'),
            ...require('./channelTransform'), MonitorDisplay: require('./monitorDisplay'), PoseConfig: require('./poseConfig').PoseConfig } : root.SerialPlotter;
    const { MonitorSearch, FrameNavigation, transformChannelValue, MonitorDisplay, PoseConfig } = dependencies;
    const framesOf = widget => widget?.source?.frames ?? widget?.source;
    const isWave = widget => widget?.type === 'wave' || widget?.type === 'waveform';
    const hasMarkers = widget => isWave(widget) || widget?.type === 'pose';
    const endAt = (frames, index) => frames.rawEndByteAt?.(index) ?? frames.rawByteOffsetAt(index) + frames.rawBytesAt(index).length;
    const indexAt = (frames, offset) => {
        if (!frames?.length || !Number.isFinite(offset)) return -1;
        const index = FrameNavigation.frameIndexAtByteOffset(frames, offset);
        return index >= 0 && offset >= frames.rawByteOffsetAt(index) && offset < endAt(frames, index) ? index : -1;
    };
    const coversSpan = (frames, first, last) => {
        for (let index = first; index < last; index++)
            if (endAt(frames, index) < frames.rawByteOffsetAt(index + 1)) return false;
        return true;
    };
    const localDate = timestamp => {
        if (!Number.isFinite(timestamp)) return '';
        const date = new Date(timestamp), pad = (n, width = 2) => String(n).padStart(width, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
            `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
    };

    class WorkspaceTools {
        constructor({ document = root.document, service, getWidgets, getActiveWidget = () => null, onStateChange = () => {},
            onMessage = () => {}, getChannelNames = () => service.channelNames ?? service.numericSource?.format?.channelNames ?? [] }) {
            Object.assign(this, { document, service, getWidgets, getActiveWidget, onStateChange, onMessage, getChannelNames });
            this.sourceId = this.referenceId = null;
            this.matches = [];
            this.currentMatch = -1;
            this.generation = 0;
            this.cleanups = [];
            this.channelCleanups = [];
            this.channelInputs = [];
            this.selectedChannels = null;
            this.disposed = false;
            this.lastPaused = false;
            const el = id => this._el(id);
            this._listen(el('monitor-search-origin'), 'change', () => this.syncSources({ referenceId: el('monitor-search-origin').value }));
            for (const id of ['monitor-search-query', 'monitor-search-tolerance'])
                this._listen(el(id), 'input', () => this.invalidate());
            this._listen(el('monitor-search-case-sensitive'), 'change', () => this.invalidate());
            for (const action of ['nearest', 'prev', 'next'])
                this._listen(el(`monitor-search-${action}`), 'click', () => { void this.requestSearch(action); });
            this._listen(el('nav-jump-mode'), 'change', () => this._syncTimeMode());
            this._listen(el('nav-jump-button'), 'click', () => this.jumpToTime());
            this._listen(el('monitor-search-channel-toggle'), 'click', () => {
                if (!this._enabled()) return;
                el('monitor-search-channel-options').hidden = !el('monitor-search-channel-options').hidden;
                el('monitor-search-channel-toggle').ariaExpanded = String(!el('monitor-search-channel-options').hidden);
            });
            this._listen(document, 'click', event => {
                if (!el('monitor-search-channel')?.contains(event.target)) this._closeChannels();
            });
            this._listen(document, 'keydown', event => { if (event.key === 'Escape') this._closeChannels(); });
            this._buildProtocolControls();
            this.syncSources();
            this._syncTimeMode();
        }

        _el(id) { return this.document.getElementById(id); }
        _listen(target, name, fn, list = this.cleanups) {
            target?.addEventListener(name, fn); list.push(() => target?.removeEventListener(name, fn));
        }
        _source() { return this.getWidgets().get(this.sourceId); }
        _enabled() { return !this.disposed && this.service.paused && !!this._source() && !this._source().view?.frames?.responseMode &&
            !this._source().source?.rebuilding && !framesOf(this._source())?.rebuilding; }
        _status(id, text) { const element = this._el(id); if (element) element.textContent = text; }
        _searchStatus(text) { this._status('monitor-search-status', text); }
        serialize() { return { referenceId: this.referenceId }; }

        _buildProtocolControls() {
            const host = this.document.createElement('div'); host.className = 'protocol-search-fields'; host.id = 'monitor-search-protocol';
            const kind = this.document.createElement('select'); kind.id = 'monitor-search-protocol-kind';
            kind.setAttribute?.('aria-label', '协议字段搜索类型');
            for (const [value, title] of [['number', '字段数值'], ['text', '字段文本'], ['integer64', '精确 64 位整数']]) {
                const option = this.document.createElement('option'); option.value = value; option.textContent = title; kind.append(option);
            }
            kind.value = 'number';
            const path = this.document.createElement('input'); path.type = 'text'; path.id = 'monitor-search-protocol-path';
            path.placeholder = '字段路径（留空搜索全部，可用逗号分隔）'; path.setAttribute?.('aria-label', '搜索字段路径');
            host.append(kind, path); this._el('nav-search-tools')?.append(host); this.protocolControls = { host, kind, path };
            this._listen(kind, 'change', () => { this.invalidate(); this._syncSearchFields(); this.syncPaused(); });
            this._listen(path, 'input', () => this.invalidate());
        }

        syncSources(selection = {}) {
            if (this.disposed) return;
            const widgets = this.getWidgets(), previous = this.sourceId;
            const oldReference = this.referenceId;
            const active = this.getActiveWidget();
            this.sourceId = active && widgets.get(active.id) === active ? active.id : null;
            const eligible = id => widgets.has(id) && !widgets.get(id).view?.frames?.responseMode;
            const desired = Object.hasOwn(selection, 'referenceId') ? selection.referenceId
                : previous !== this.sourceId ? this.sourceId : this.referenceId;
            this.referenceId = !this.sourceId ? null : eligible(desired) ? desired : eligible(this.sourceId) ? this.sourceId : null;
            const select = this._el('monitor-search-origin');
            if (select) {
                const options = [];
                for (const widget of widgets.values()) {
                    if (widget.view?.frames?.responseMode) continue;
                    const option = this.document.createElement('option');
                    option.value = widget.id; option.textContent = widget.title; options.push(option);
                }
                select.replaceChildren(...options); select.value = this.referenceId ?? '';
            }
            if (previous !== this.sourceId) {
                this.selectedChannels = null; this.invalidate(); this._status('nav-jump-status', '');
            } else if (oldReference && !eligible(oldReference)) this.invalidate();
            if (!this.sourceId || !this.referenceId) this._searchStatus(!this.sourceId ? '请激活一个控件' : '请选择参考控件');
            this._syncSearchFields();
            this.syncPaused();
            if (previous !== this.sourceId) this._defaultAbsoluteTime();
            if (oldReference !== this.referenceId) this.onStateChange(this.serialize());
        }

        _syncTimeMode() {
            const relative = this._el('nav-jump-mode')?.value === 'relative';
            for (const id of ['nav-jump-relative', 'nav-jump-relative-unit']) if (this._el(id)) this._el(id).hidden = !relative;
            if (this._el('nav-jump-absolute')) this._el('nav-jump-absolute').hidden = relative;
        }

        _defaultAbsoluteTime() {
            const frames = framesOf(this._source());
            const input = this._el('nav-jump-absolute');
            if (input) input.value = frames?.length ? localDate(frames.timestampAt(frames.length - 1)) : '';
        }

        syncPaused() {
            const enabled = this._enabled(), source = !!this._source();
            if (this._el('monitor-search-origin')) this._el('monitor-search-origin').disabled = !enabled;
            for (const id of ['nav-jump-mode', 'nav-jump-absolute', 'nav-jump-relative', 'nav-jump-button',
                'monitor-search-query', 'monitor-search-tolerance', 'monitor-search-channel-toggle',
                'monitor-search-case-sensitive', 'monitor-search-nearest', 'monitor-search-prev', 'monitor-search-next']) {
                if (this._el(id)) this._el(id).disabled = !enabled || !source;
            }
            for (const id of ['nav-time-tools', 'nav-search-tools']) this._el(id)?.classList[enabled ? 'remove' : 'add']('tools-disabled');
            for (const { input } of this.channelInputs) input.disabled = !enabled || !source;
            if (this.protocolControls) for (const input of [this.protocolControls.kind, this.protocolControls.path]) input.disabled = !enabled || !source;
            if (this.channelPicker) {
                this.channelPicker.filter.disabled = !enabled || !source;
                this.channelPicker.previous.disabled = !enabled || this.channelPage <= 0;
                this.channelPicker.next.disabled = !enabled || (this.channelPage + 1) * 40 >= this.filteredChannels.length;
            }
            if (!enabled) { this._closeChannels(); if (this.pending) this.invalidate(); }
            if (enabled && !this.lastPaused) this._defaultAbsoluteTime();
            this.lastPaused = enabled;
        }

        _kind() {
            const widget = this._source();
            if (this.service.dataEngine?.mode === 'Raw_Data') return 'hex';
            if (widget?.source?.kind === 'protocol') return 'protocol';
            if (widget?.source?.kind === 'numeric') return 'number';
            return hasMarkers(widget) ? 'number' : widget?.settings?.captureMode === 'engine' ? 'hex' : widget?.settings?.captureMode ?? 'hex';
        }
        _poseChannels() {
            const widget = this._source(), frames = framesOf(widget);
            return widget?.type === 'pose' ? PoseConfig.boundChannels(widget.settings)
                .filter(index => index < frames.channelCount && (!frames.isSignal || frames.isSignal(index))) : null;
        }
        _syncSearchFields() {
            const kind = this._kind(), structured = kind === 'protocol', type = structured ? this.protocolControls.kind.value : kind;
            if (this.protocolControls) this.protocolControls.host.hidden = !structured;
            if (this._el('monitor-search-tolerance')) this._el('monitor-search-tolerance').hidden = type !== 'number';
            if (this._el('monitor-search-channel')) this._el('monitor-search-channel').hidden = kind !== 'number';
            if (this._el('monitor-search-case-wrap')) this._el('monitor-search-case-wrap').hidden = type !== 'text';
            if (this._el('monitor-search-query')) this._el('monitor-search-query').placeholder = type === 'number' ? '目标数值'
                : type === 'integer64' ? '精确十进制整数' : type === 'text' ? '文本搜索' : '十六进制字节';
            this._closeChannels(); this._populateChannels();
        }

        _closeChannels() {
            if (this._el('monitor-search-channel-options')) this._el('monitor-search-channel-options').hidden = true;
            if (this._el('monitor-search-channel-toggle')) this._el('monitor-search-channel-toggle').ariaExpanded = 'false';
        }

        _populateChannels() {
            const container = this._el('monitor-search-channel-options');
            if (!container) return;
            if (!this.channelPicker) {
                const toolbar = this.document.createElement('div'); toolbar.className = 'channel-picker-toolbar';
                const filter = this.document.createElement('input'); filter.type = 'search'; filter.id = 'monitor-search-channel-filter';
                filter.placeholder = '通道编号或名称'; filter.setAttribute?.('aria-label', '筛选搜索通道');
                const previous = this.document.createElement('button'), next = this.document.createElement('button'), summary = this.document.createElement('span');
                previous.type = next.type = 'button'; previous.textContent = '上一页'; next.textContent = '下一页';
                toolbar.append(filter, previous, summary, next);
                const rows = this.document.createElement('div'); rows.className = 'search-channel-results';
                this.channelPicker = { toolbar, filter, previous, next, summary, rows }; this.channelPage = 0;
                this._listen(filter, 'input', () => { this.channelPage = 0; this._renderChannelPage(); });
                this._listen(previous, 'click', () => { if (this.channelPage > 0) { this.channelPage--; this._renderChannelPage(); } });
                this._listen(next, 'click', () => { if ((this.channelPage + 1) * 40 < this.filteredChannels.length) { this.channelPage++; this._renderChannelPage(); } });
            }
            container.replaceChildren(this.channelPicker.toolbar, this.channelPicker.rows);
            const frames = framesOf(this._source()), count = frames?.channelCount ?? 0, allowed = this._poseChannels();
            this.eligibleChannels = [];
            for (let channel = 0; channel < count; channel++) {
                if (allowed && !allowed.includes(channel) || frames?.isSignal && !frames.isSignal(channel)) continue;
                this.eligibleChannels.push(channel);
            }
            if (this.selectedChannels) {
                const eligible = new Set(this.eligibleChannels);
                this.selectedChannels = new Set([...this.selectedChannels].filter(channel => eligible.has(channel)));
                if (!this.selectedChannels.size) this.selectedChannels = null;
            }
            this._renderChannelPage();
        }

        _channelLabel(channel, names = this.getChannelNames()) {
            if (channel < 0) return this._source()?.type === 'pose' ? '全部绑定通道' : '全部通道';
            const number = `CH${String(channel + 1).padStart(5, '0')}`;
            const name = names[channel] ?? this._source()?.view?.channels?.[channel]?.name;
            const defaultName = /^CH0*\d+$/i.test(name ?? '') && Number(name.slice(2)) === channel + 1;
            return name && !defaultName ? `${number} · ${name}` : number;
        }

        _renderChannelPage() {
            for (const cleanup of this.channelCleanups) cleanup();
            this.channelCleanups = []; this.channelInputs = [];
            const picker = this.channelPicker, container = picker.rows;
            container.replaceChildren();
            const names = this.getChannelNames(), query = picker.filter.value.trim().toLocaleLowerCase(), exact = /^ch0*(\d+)$/i.exec(query);
            this.filteredChannels = this.eligibleChannels.filter(channel => !query || (exact ? channel + 1 === Number(exact[1]) : this._channelLabel(channel, names).toLocaleLowerCase().includes(query)));
            this.channelPage = Math.max(0, Math.min(this.channelPage, Math.ceil(this.filteredChannels.length / 40) - 1));
            const visible = this.filteredChannels.slice(this.channelPage * 40, (this.channelPage + 1) * 40);
            for (const channel of [-1, ...visible]) {
                const label = this.document.createElement('label'), input = this.document.createElement('input');
                const text = this.document.createElement('span');
                text.textContent = this._channelLabel(channel, names);
                text.className = 'search-channel-name'; input.type = 'checkbox'; input.value = String(channel);
                label.append(input, text); label.title = text.textContent; container.appendChild(label);
                this.channelInputs.push({ channel, input, text });
                this._listen(input, 'change', () => {
                    if (channel < 0) this.selectedChannels = null;
                    else {
                        this.selectedChannels ??= new Set();
                        if (input.checked) this.selectedChannels.add(channel); else this.selectedChannels.delete(channel);
                        if (!this.selectedChannels.size) this.selectedChannels = null;
                    }
                    this._channelLabels(); this.invalidate();
                }, this.channelCleanups);
            }
            picker.summary.textContent = this.filteredChannels.length ? `${this.channelPage * 40 + 1}–${Math.min(this.filteredChannels.length, (this.channelPage + 1) * 40)} / ${this.filteredChannels.length}` : '无匹配通道';
            picker.previous.disabled = this.channelPage <= 0;
            picker.next.disabled = (this.channelPage + 1) * 40 >= this.filteredChannels.length;
            this._channelLabels();
        }

        _channelLabels() {
            for (const { channel, input, text } of this.channelInputs) {
                input.checked = channel < 0 ? this.selectedChannels === null : !!this.selectedChannels?.has(channel);
            }
            const selected = this.selectedChannels ? [...this.selectedChannels] : [], names = selected.slice(0, 2).map(channel => this._channelLabel(channel));
            const toggle = this._el('monitor-search-channel-toggle');
            if (toggle) { toggle.textContent = !selected.length ? this._channelLabel(-1) : selected.length > 2 ? `已选 ${selected.length} 通道` : names.join('、'); toggle.title = names.join('、'); }
        }

        invalidate() {
            this.generation++;
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
            this.pending?.resolve(false); this.pending = null;
            this.matches = []; this.currentMatch = -1; this.searchKey = null;
            this._publish(); this._searchStatus('');
        }

        resetNavigation() {
            this.invalidate();
            this._status('nav-jump-status', '');
            for (const widget of this.getWidgets().values()) {
                widget.view.setNavigationMarkers?.({ timeOrder: null, matches: [], currentMatch: -1 });
            }
        }

        _publish() {
            const origin = this._source();
            const display = !isWave(origin) ? origin?.settings?.monitorDisplay : null;
            const colors = { match: display?.searchMatchColor ?? MonitorDisplay.DEFAULTS.searchMatchColor,
                current: display?.searchCurrentColor ?? MonitorDisplay.DEFAULTS.searchCurrentColor };
            for (const widget of this.getWidgets().values()) {
                const frames = framesOf(widget), mapped = [];
                if (widget.view?.frames?.responseMode) continue;
                let current = -1;
                for (let index = 0; index < this.matches.length; index++) {
                    const match = this.matches[index];
                    if (match.unretained) continue;
                    const sample = frames === framesOf(origin) && Number.isInteger(match.sampleFrame);
                    const first = sample ? match.sampleFrame : indexAt(frames, match.startByte), last = sample ? first : indexAt(frames, match.endByte - 1);
                    if (first < 0 || last < 0 || !coversSpan(frames, first, last)) continue;
                    const local = { ...match, startFrame: first, endFrame: last,
                        startOrder: frames.orderAt(first), endOrder: frames.orderAt(last),
                        startByte: sample ? 0 : match.startByte - frames.rawByteOffsetAt(first),
                        endByte: sample ? frames.rawBytesAt(last)?.length ?? 0 : match.endByte - frames.rawByteOffsetAt(last),
                        absoluteStartByte: match.startByte, absoluteEndByte: match.endByte };
                    if (frames !== framesOf(origin)) delete local.channel;
                    if (index === this.currentMatch) current = mapped.length;
                    mapped.push(local);
                }
                if (hasMarkers(widget)) {
                    widget.view.setNavigationColors?.(colors);
                    widget.view.setNavigationMarkers?.({ timeOrder: widget.view.navigationMarkers?.timeOrder ?? null,
                        matches: mapped, currentMatch: current });
                } else {
                    widget.view.setDisplayOptions?.({ searchMatchColor: colors.match, searchCurrentColor: colors.current }, { deferRender: true });
                    widget.view.setSearchResults?.(mapped, current);
                }
            }
        }

        _jumpAll(offset, timeMarker = false, preferred = null) {
            const skipped = [];
            for (const widget of this.getWidgets().values()) {
                const frames = framesOf(widget), sample = preferred && frames === preferred.frames;
                const index = sample ? preferred.index : indexAt(frames, offset);
                if (widget.view?.frames?.responseMode) continue;
                if (index < 0) { skipped.push(widget.title); continue; }
                const moved = sample && widget.view.jumpToFrame ? widget.view.jumpToFrame(index) : widget.view.jumpToByteOffset ? widget.view.jumpToByteOffset(offset)
                    : widget.view.jumpToFrame?.(index);
                if (moved === false) { skipped.push(widget.title); continue; }
                if (timeMarker && hasMarkers(widget)) widget.view.setNavigationMarkers?.({
                    ...widget.view.navigationMarkers, timeOrder: frames.orderAt(index) });
                if (!hasMarkers(widget)) widget.view.cursorOrder = frames.orderAt(index);
            }
            return skipped;
        }

        _mapSearchMatch(match, frames, widget, epoch) {
            const mapped = { ...match,
                startByte: frames.rawByteOffsetAt(match.startFrame) + (match.startByte ?? 0),
                endByte: match.endByte === undefined ? endAt(frames, match.endFrame)
                    : frames.rawByteOffsetAt(match.endFrame) + match.endByte,
                sourceId: widget.id, sessionEpoch: epoch };
            if (typeof frames.provenanceAt !== 'function' || match.channel === undefined) return mapped;
            const origin = frames.provenanceAt(match.channel, match.startFrame);
            const provenance = frames.provenanceInfoAt?.(match.channel, match.startFrame);
            const records = this.service.dataEngine?.recordsSource?.frames;
            let record = null;
            if (origin && records?.length) {
                const index = records.indexAtOrAfterOrder(origin.order);
                if (index >= 0 && records.orderAt(index) === origin.order) record = records.frameAt(index);
            } else if (origin && frames.resolveFrame) record = frames.resolveFrame(origin);
            mapped.sampleFrame = match.startFrame; mapped.provenance = origin;
            mapped.startByte = origin?.byteOffset ?? record?.byteOffset ?? mapped.startByte;
            mapped.endByte = origin?.endByte ?? record?.endByte ?? mapped.startByte + (record?.bytes?.length ?? 1);
            mapped.unretained = !record;
            mapped.noSource = provenance?.hasInputs === false;
            return mapped;
        }

        jumpToTime() {
            if (!this._enabled()) return false;
            const frames = framesOf(this._source());
            if (!frames?.length) { this._status('nav-jump-status', '当前控件没有保留数据'); return false; }
            const relative = this._el('nav-jump-mode').value === 'relative';
            const text = this._el(relative ? 'nav-jump-relative' : 'nav-jump-absolute').value;
            const seconds = Number(text);
            const target = relative ? text.trim() !== '' && Number.isFinite(seconds) && seconds >= 0
                ? frames.timestampAt(0) + seconds * 1000 : NaN : new Date(text).getTime();
            if (!Number.isFinite(target)) { this._status('nav-jump-status', '请输入有效时间'); return false; }
            let minimum = Infinity, maximum = -Infinity;
            for (let index = 0; index < frames.length; index++) {
                const timestamp = frames.timestampAt(index);
                minimum = Math.min(minimum, timestamp); maximum = Math.max(maximum, timestamp);
            }
            if (target < minimum || target > maximum) {
                this._status('nav-jump-status', '时间超出来源控件的保留范围'); return false;
            }
            const index = frames.nearestTimestampIndex(target);
            const skipped = this._jumpAll(frames.rawByteOffsetAt(index), true, { frames, index });
            const textStatus = `已定位第 ${index + 1} 帧` + (skipped.length ? `；${skipped.join('、')} 超出保留范围` : '');
            this._status('nav-jump-status', textStatus); this.onMessage(textStatus);
            return true;
        }

        requestSearch(action = 'nearest') {
            if (!this._enabled()) return Promise.resolve(false);
            const widget = this._source(), reference = this.getWidgets().get(this.referenceId), frames = framesOf(widget);
            if (!widget || !reference) { this._searchStatus(!widget ? '请激活一个控件' : '请选择参考控件'); return Promise.resolve(false); }
            if (!frames?.length) { this._searchStatus('当前控件没有保留数据'); return Promise.resolve(false); }
            try {
                const byteOffset = reference.view.getReferenceByteOffset?.();
                if (!Number.isFinite(byteOffset)) { this._searchStatus('参考控件没有可用的时间位置'); return Promise.resolve(false); }
                const query = this._el('monitor-search-query').value, tolerance = this._el('monitor-search-tolerance').value;
                const channels = this.selectedChannels ? [...this.selectedChannels].sort((a, b) => a - b) : this._poseChannels() ?? -1;
                if (Array.isArray(channels) && !channels.length) throw new Error('请先绑定姿态来源通道');
                const kind = this._kind(), encoding = widget.settings.textEncoding ?? 'utf-8';
                const caseSensitive = this._el('monitor-search-case-sensitive').checked;
                const structured = kind === 'protocol', fieldKind = this.protocolControls.kind.value;
                const paths = this.protocolControls.path.value.split(/[\n,]/).map(path => path.trim()).filter(Boolean);
                const options = structured ? { ...MonitorSearch.parseProtocolFieldSearch(fieldKind, query, tolerance, paths.length ? paths : null, caseSensitive), query,
                    decodeRecord: index => {
                        const decoder = widget.source.decodeRecord ?? widget.view.protocolDecoder;
                        if (typeof decoder !== 'function') throw new Error('当前协议来源没有可用的字段解码器');
                        return decoder.call(widget.source, index);
                    } } : MonitorSearch.parseMonitorSearch(kind, query, tolerance, channels, encoding, caseSensitive);
                if (!structured && isWave(widget)) options.valueTransform = (value, channel) => transformChannelValue(value, widget.settings.channels?.[channel]);
                const key = JSON.stringify([widget.id, frames.version, this.service.epoch, widget.source.generation,
                    kind, structured ? fieldKind : null, structured ? paths : null, query, tolerance, channels, encoding, caseSensitive, isWave(widget) ? widget.settings.channels : null]);
                const request = { action, byteOffset };
                if (key === this.searchKey) {
                    if (this.pending) { this.pending.request = request; return this.pending.promise; }
                    return Promise.resolve(this._navigate(request));
                }
                this.invalidate(); this.searchKey = key;
                const session = structured ? new MonitorSearch.ProtocolFieldSearchSession(frames, options) : new MonitorSearch.MonitorSearchSession(frames, options);
                const generation = this.generation, epoch = this.service.epoch, sourceGeneration = widget.source.generation;
                const version = frames.version;
                let resolve;
                const promise = new Promise(done => { resolve = done; });
                this.pending = { promise, resolve, request };
                const scan = () => {
                    this.timer = null;
                    if (generation !== this.generation) return;
                    if (!this._enabled() || this.service.epoch !== epoch || widget.source.generation !== sourceGeneration ||
                        framesOf(this._source()) !== frames || frames.version !== version) { this.invalidate(); return; }
                    try {
                        if (session.step(256)) {
                            this.matches = session.matches.map(match => this._mapSearchMatch(match, frames, widget, epoch))
                                .sort((a, b) => a.startByte - b.startByte || (a.sampleFrame ?? a.startFrame) - (b.sampleFrame ?? b.startFrame));
                            const pending = this.pending;
                            const success = this._navigate(pending.request);
                            this.pending = null; pending.resolve(success);
                        } else {
                            this._searchStatus(`搜索中 ${session.position} / ${session.length}`);
                            this.timer = setTimeout(scan, 0);
                        }
                    } catch (error) { this.invalidate(); this._searchStatus(error.message); }
                };
                scan(); return promise;
            } catch (error) { this._searchStatus(error.message); return Promise.resolve(false); }
        }

        _navigate({ action, byteOffset }) {
            if (!this.getWidgets().has(this.referenceId)) {
                this._searchStatus('请选择参考控件'); return false;
            }
            if (!this.matches.length) { this._searchStatus('无匹配结果'); return false; }
            let selected = this.currentMatch;
            if (action !== 'nearest' && selected >= 0) selected += action === 'next' ? 1 : -1;
            else {
                let low = 0, high = this.matches.length;
                while (low < high) { const mid = Math.floor((low + high) / 2); if (this.matches[mid].startByte < byteOffset) low = mid + 1; else high = mid; }
                selected = low >= this.matches.length ? this.matches.length - 1 : low > 0 &&
                    byteOffset - this.matches[low - 1].startByte <= this.matches[low].startByte - byteOffset ? low - 1 : low;
                while (selected > 0 && this.matches[selected - 1].startByte === this.matches[selected].startByte) selected--;
                selected += action === 'prev' ? 1 : action === 'next' ? -1 : 0;
            }
            this.currentMatch = (selected + this.matches.length) % this.matches.length;
            const match = this.matches[this.currentMatch];
            if (match.unretained) {
                this._publish(); this._searchStatus(`${this.currentMatch + 1} / ${this.matches.length}；` +
                    (match.noSource ? '该运算值没有关联源消息' : '值仍匹配，源消息已超出保留范围')); return false;
            }
            const skipped = this._jumpAll(match.startByte, false, Number.isInteger(match.sampleFrame)
                ? { frames: framesOf(this._source()), index: match.sampleFrame } : null);
            this._publish();
            this._searchStatus(`${this.currentMatch + 1} / ${this.matches.length}` + (skipped.length ? `；${skipped.join('、')} 超出保留范围` : ''));
            return true;
        }

        dispose() {
            if (this.disposed) return;
            this.invalidate(); this.disposed = true;
            for (const cleanup of [...this.cleanups, ...this.channelCleanups]) cleanup();
        }
    }
    root.SerialPlotter ??= {};
    root.SerialPlotter.WorkspaceTools = WorkspaceTools;
    if (typeof module !== 'undefined' && module.exports) module.exports = { WorkspaceTools };
})(typeof globalThis !== 'undefined' ? globalThis : this);

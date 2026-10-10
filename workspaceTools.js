/** Paused navigation and search across independent views of one receive byte stream. */
(function(root) {
    'use strict';
    const dependencies = typeof module !== 'undefined' && module.exports
        ? { MonitorSearch: require('./monitorSearch'), FrameNavigation: require('./frameNavigation'),
            ...require('./channelTransform'), MonitorDisplay: require('./monitorDisplay') } : root.SerialPlotter;
    const { MonitorSearch, FrameNavigation, transformChannelValue, MonitorDisplay } = dependencies;
    const framesOf = widget => widget?.source?.frames ?? widget?.source;
    const isWave = widget => widget?.type === 'wave' || widget?.type === 'waveform';
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

        syncSources(selection = {}) {
            if (this.disposed) return;
            const widgets = this.getWidgets(), previous = this.sourceId;
            const oldReference = this.referenceId;
            const active = this.getActiveWidget();
            this.sourceId = active && widgets.get(active.id) === active ? active.id : null;
            const desired = Object.hasOwn(selection, 'referenceId') ? selection.referenceId : this.referenceId;
            this.referenceId = widgets.has(desired) && !widgets.get(desired).view?.frames?.responseMode ? desired : null;
            const select = this._el('monitor-search-origin');
            if (select) {
                const placeholder = this.document.createElement('option');
                placeholder.value = ''; placeholder.textContent = '请选择参考控件';
                const options = [placeholder];
                for (const widget of widgets.values()) {
                    if (widget.view?.frames?.responseMode) continue;
                    const option = this.document.createElement('option');
                    option.value = widget.id; option.textContent = widget.title; options.push(option);
                }
                select.replaceChildren(...options); select.value = this.referenceId ?? '';
            }
            if (previous !== this.sourceId) {
                this.selectedChannels = null; this.invalidate(); this._status('nav-jump-status', '');
            }
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
            if (!enabled) { this._closeChannels(); if (this.pending) this.invalidate(); }
            if (enabled && !this.lastPaused) this._defaultAbsoluteTime();
            this.lastPaused = enabled;
        }

        _kind() { const widget = this._source(); return isWave(widget) ? 'number' : widget?.settings?.captureMode ?? 'hex'; }
        _syncSearchFields() {
            const kind = this._kind(), numeric = kind === 'number';
            for (const id of ['monitor-search-tolerance', 'monitor-search-channel']) if (this._el(id)) this._el(id).hidden = !numeric;
            if (this._el('monitor-search-case-wrap')) this._el('monitor-search-case-wrap').hidden = kind !== 'text';
            if (this._el('monitor-search-query')) this._el('monitor-search-query').placeholder = numeric ? '目标数值' : kind === 'text' ? '文本搜索' : '十六进制字节';
            this._closeChannels(); this._populateChannels();
        }

        _closeChannels() {
            if (this._el('monitor-search-channel-options')) this._el('monitor-search-channel-options').hidden = true;
            if (this._el('monitor-search-channel-toggle')) this._el('monitor-search-channel-toggle').ariaExpanded = 'false';
        }

        _populateChannels() {
            for (const cleanup of this.channelCleanups) cleanup();
            this.channelCleanups = []; this.channelInputs = [];
            const container = this._el('monitor-search-channel-options');
            if (!container) return;
            container.replaceChildren();
            const count = framesOf(this._source())?.channelCount ?? 0;
            if (this.selectedChannels) {
                this.selectedChannels = new Set([...this.selectedChannels].filter(channel => channel < count));
                if (!this.selectedChannels.size) this.selectedChannels = null;
            }
            const names = this.getChannelNames();
            for (let channel = -1; channel < count; channel++) {
                if (channel >= 0 && framesOf(this._source())?.isSignal && !framesOf(this._source()).isSignal(channel)) continue;
                const label = this.document.createElement('label'), input = this.document.createElement('input');
                const text = this.document.createElement('span');
                const number = `CH${String(channel + 1).padStart(2, '0')}`;
                const name = names[channel] ?? this._source()?.view?.channels?.[channel]?.name;
                text.textContent = channel < 0 ? '全部通道' : name && name !== number ? `${number} · ${name}` : number;
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
            this._channelLabels();
        }

        _channelLabels() {
            const names = [];
            for (const { channel, input, text } of this.channelInputs) {
                input.checked = channel < 0 ? this.selectedChannels === null : !!this.selectedChannels?.has(channel);
                if (channel >= 0 && input.checked) names.push(text.textContent);
            }
            const toggle = this._el('monitor-search-channel-toggle');
            if (toggle) { toggle.textContent = !names.length ? '全部通道' : names.length > 2 ? `已选 ${names.length} 通道` : names.join('、'); toggle.title = names.join('、'); }
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
                    const match = this.matches[index], first = indexAt(frames, match.startByte), last = indexAt(frames, match.endByte - 1);
                    if (first < 0 || last < 0 || !coversSpan(frames, first, last)) continue;
                    const local = { ...match, startFrame: first, endFrame: last,
                        startOrder: frames.orderAt(first), endOrder: frames.orderAt(last),
                        startByte: match.startByte - frames.rawByteOffsetAt(first),
                        endByte: match.endByte - frames.rawByteOffsetAt(last),
                        absoluteStartByte: match.startByte, absoluteEndByte: match.endByte };
                    if (frames !== framesOf(origin)) delete local.channel;
                    if (index === this.currentMatch) current = mapped.length;
                    mapped.push(local);
                }
                if (isWave(widget)) {
                    widget.view.setNavigationColors?.(colors);
                    widget.view.setNavigationMarkers?.({ timeOrder: widget.view.navigationMarkers?.timeOrder ?? null,
                        matches: mapped, currentMatch: current });
                } else {
                    widget.view.setDisplayOptions?.({ searchMatchColor: colors.match, searchCurrentColor: colors.current }, { deferRender: true });
                    widget.view.setSearchResults?.(mapped, current);
                }
            }
        }

        _jumpAll(offset, timeMarker = false) {
            const skipped = [];
            for (const widget of this.getWidgets().values()) {
                const frames = framesOf(widget), index = indexAt(frames, offset);
                if (widget.view?.frames?.responseMode) continue;
                if (index < 0) { skipped.push(widget.title); continue; }
                const moved = widget.view.jumpToByteOffset ? widget.view.jumpToByteOffset(offset)
                    : widget.view.jumpToFrame?.(index);
                if (moved === false) { skipped.push(widget.title); continue; }
                if (timeMarker && isWave(widget)) widget.view.setNavigationMarkers?.({
                    ...widget.view.navigationMarkers, timeOrder: frames.orderAt(index) });
                if (!isWave(widget)) widget.view.cursorOrder = frames.orderAt(index);
            }
            return skipped;
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
            const skipped = this._jumpAll(frames.rawByteOffsetAt(index), true);
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
                const channels = this.selectedChannels ? [...this.selectedChannels].sort((a, b) => a - b) : -1;
                const kind = this._kind(), encoding = widget.settings.textEncoding ?? 'utf-8';
                const caseSensitive = this._el('monitor-search-case-sensitive').checked;
                const options = MonitorSearch.parseMonitorSearch(kind, query, tolerance, channels, encoding, caseSensitive);
                if (isWave(widget)) options.valueTransform = (value, channel) => transformChannelValue(value, widget.settings.channels?.[channel]);
                const key = JSON.stringify([widget.id, frames.version, this.service.epoch, widget.source.generation,
                    kind, query, tolerance, channels, encoding, caseSensitive, isWave(widget) ? widget.settings.channels : null]);
                const request = { action, byteOffset };
                if (key === this.searchKey) {
                    if (this.pending) { this.pending.request = request; return this.pending.promise; }
                    return Promise.resolve(this._navigate(request));
                }
                this.invalidate(); this.searchKey = key;
                const session = new MonitorSearch.MonitorSearchSession(frames, options);
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
                            this.matches = session.matches.map(match => ({ ...match,
                                startByte: frames.rawByteOffsetAt(match.startFrame) + (match.startByte ?? 0),
                                endByte: match.endByte === undefined ? endAt(frames, match.endFrame)
                                    : frames.rawByteOffsetAt(match.endFrame) + match.endByte,
                                sourceId: widget.id, sessionEpoch: epoch }));
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
            const skipped = this._jumpAll(this.matches[this.currentMatch].startByte);
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

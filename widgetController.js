/** Own view instances and bind the one property inspector to the selected widget. */
class WidgetController {
    constructor({ document, service, globals, workspace, onChange = () => {}, onRulesChange = () => {}, onActivate = () => {},
        onBeforeChannelRenumber = () => {} }) {
        this.document = document;
        this.service = service;
        this.globals = globals;
        this.workspace = workspace;
        this.onChange = onChange;
        this.onRulesChange = onRulesChange;
        this.onBeforeChannelRenumber = onBeforeChannelRenumber;
        this.onActivate = onActivate;
        this.widgets = new Map();
        this.activeId = null;
        this.nextNumber = 1;
        this.decodeCache = new WeakMap();
        this.registry = new Map();
        this.cleanups = [];
        this.register('wave', { template: 'wave-widget-template', title: '波形' });
        this.register('byte', { template: 'byte-widget-template', title: '字节流' });
        this.fieldIds = {
            plotViewMode: 'plot-view-mode', plotTimeXUnit: 'plot-time-x-unit',
            plotFreqXScale: 'plot-freq-x-scale', plotFreqYScale: 'plot-freq-y-scale',
            plotFftWindow: 'plot-fft-window', plotFftRemoveDc: 'plot-fft-remove-dc',
            plotContent: 'plot-content',
            plotPhaseUnwrap: 'plot-phase-unwrap', plotPhaseUnit: 'plot-phase-unit', plotResponseSampleRate: 'plot-response-sample-rate',
            captureMode: 'capture-mode', textEncoding: 'text-encoding', textBoundary: 'text-boundary'
        };
        this.globalIds = { channelsCount: 'channels-count', dataType: 'data-type', endianness: 'endianness',
            enableHeader: 'chk-header', headerHex: 'frame-header', enableFooter: 'chk-footer', footerHex: 'frame-footer',
            enableChecksum: 'chk-checksum' };
        this.channelView = new SerialPlotter.ChannelConfigView(document, this);
        this.displayView = new SerialPlotter.MonitorDisplayView(document, { onChange: options => {
            const widget = this.active;
            if (widget?.type !== 'byte' || this.binding) return;
            widget.settings.monitorDisplay = options;
            widget.view.setDisplayOptions(options);
            this.onChange();
        }, onChannelNameChange: (index, name) => this.setChannelName(index, name) });
        this.displayView.channelRenderer = list => {
            if (this.active?.type === 'byte') this.channelView.render(list, this.active);
        };
        this._bindInspector();
        this.activate(null);
    }

    get active() { return this.widgets.get(this.activeId); }
    element(id) { return this.document.getElementById(id); }
    _listen(element, event, callback) {
        element.addEventListener(event, callback);
        this.cleanups.push(() => element.removeEventListener(event, callback));
    }
    register(type, definition) { this.registry.set(type, definition); }

    create({ id, type, title, settings = {}, rect } = {}) {
        const definition = this.registry.get(type);
        if (!definition) throw new Error('控件类型未注册');
        let number = this.nextNumber;
        if (id === undefined) {
            while (this.widgets.has(`${type}-${number}`)) number++;
            id = `${type}-${number}`;
        }
        if (!SerialPlotter.WidgetConfig.isValidWidgetId(id)) throw new Error('控件编号无效');
        if (this.widgets.has(id)) throw new Error('控件编号重复');
        if (title === undefined) title = `${definition.title} ${number}`;
        if (typeof title !== 'string' || !title.trim()) throw new Error('控件标题无效');
        const textRules = type === 'byte' && (settings.textEncoding !== undefined || settings.textBoundary !== undefined)
            ? { textEncoding: settings.textEncoding ?? this.globals.textEncoding,
                textBoundary: settings.textBoundary ?? this.globals.textBoundary } : null;
        settings = SerialPlotter.WidgetConfig.normalizeWidgetSettings(type, settings,
            textRules ? { ...this.globals, ...textRules } : this.globals);
        if (textRules) this.updateTextRules(textRules);
        this.nextNumber = number + 1;
        const element = this.element(definition.template).content.firstElementChild.cloneNode(true);
        const refs = Object.fromEntries([...element.querySelectorAll('[data-role]')]
            .map(node => [node.dataset.role, node]));
        refs[element.dataset.role] = element;
        for (const [role, node] of Object.entries(refs)) node.id = `${id}-${role}`;
        const handle = refs[type === 'wave' ? 'waveform-drag-handle' : 'monitor-header'];
        handle.querySelector('span').textContent = title;
        const remove = this.document.createElement('button');
        remove.className = 'widget-close'; remove.type = 'button'; remove.textContent = '×';
        remove.setAttribute('aria-label', `删除${title}`);
        handle.append(remove);
        const source = this.service.acquireSource(type === 'wave' ? { captureMode: 'number' } : settings);
        const widget = { id, type, title, settings, element, refs, source, lastTab: null, disposed: false };
        if (type === 'wave') widget.pendingViewport = settings[settings.plotContent === 'response' ? 'responseViewport' : 'viewport'];
        this.widgets.set(id, widget);
        this.workspace.add({ id, type, title, element, handle, rect, minWidth: 280, minHeight: 180 });
        if (type === 'wave') {
            widget.responseFrames = new SerialPlotter.SystemResponseFrames();
            widget.view = new SerialPlotter.Plotter(refs['waveform-canvas'], source.frames, { viewOnly: true, elements: {
                scrollWrap: refs['plot-scrollbar-wrap'], scrollThumb: refs['plot-scrollbar-thumb'],
                yScrollWrap: refs['plot-y-scrollbar-wrap'], yScrollThumb: refs['plot-y-scrollbar-thumb'],
                header: refs['plot-header'], infoRow: refs['plot-info-row']
            } });
            widget.view.onStatsUpdate = data => this._renderWaveStats(widget, data);
            widget.view.onStatusUpdate = message => {
                widget.responseStatus = message;
                if (this.activeId === widget.id) {
                    this.element('plot-response-status').textContent = message;
                    this.element('plot-response-status').hidden = !message;
                }
            };
            widget.view.onViewportChange = () => {
                if (widget.disposed) return;
                widget.pendingViewport = null;
                this._cancelViewportRestore(widget);
                this.onChange();
            };
        } else widget.view = new SerialPlotter.MonitorView(refs['data-log'], source.frames, {
            decodeCache: this.decodeCache, txFrames: this.service.txFrames, getSourceErrors: () => widget.source.errors
        });
        if (type === 'byte') {
            this._measureByteChrome(widget);
            if (typeof ResizeObserver === 'function') {
                widget.chromeObserver = new ResizeObserver(() => this._measureByteChrome(widget));
                widget.chromeObserver.observe(refs['monitor-header']);
                widget.chromeObserver.observe(refs['monitor-stats']);
            }
        }
        remove.addEventListener('click', event => { event.stopPropagation(); this.remove(id); });
        this.applySettings(widget);
        widget.view.setVisible(true);
        if (typeof IntersectionObserver === 'function') {
            widget.visibility = new IntersectionObserver(entries => widget.view.setVisible(entries[0].isIntersecting),
                { root: this.element('workspace-viewport') });
            widget.visibility.observe(element);
        }
        this._whenReady(widget);
        this.element('workspace-empty').hidden = true;
        this.workspace.activate(id);
        this.onChange();
        return widget;
    }

    _whenReady(widget) {
        this._cancelViewportRestore(widget);
        const source = widget.source, ready = source.ready;
        widget.readyPromise = ready;
        widget.readySource = null;
        ready.then(() => {
            if (widget.disposed || widget.source !== source || widget.readyPromise !== ready) return;
            if (source.ready !== ready) { this._whenReady(widget); return; }
            if (widget.type !== 'wave' || widget.settings.plotContent !== 'response') widget.view.setFrames(source.frames);
            this.applySettings(widget);
            widget.readySource = source;
            this._restoreViewport(widget);
            widget.view.invalidateData();
        });
    }

    applySettings(widget) {
        const { settings, view } = widget;
        if (widget.type === 'wave') {
            const response = settings.plotContent === 'response';
            widget.responseFrames.configure(this.service.numericSource.frames,
                Number(settings.plotResponseTimePoints), Number(this.globals.plotWindowPoints));
            const target = response ? widget.responseFrames : widget.source.frames;
            const switching = view.frames !== target;
            if (switching) {
                const previousResponse = view.frames.responseMode;
                if (widget.appliedContent !== undefined) {
                    settings[previousResponse ? 'responseChannels' : 'channels'] = view.getChannelMeta();
                    settings[previousResponse ? 'responseViewport' : 'viewport'] = SerialPlotter.WidgetViewport.captureWidgetViewport(view);
                }
                view.setFrames(target);
                widget.pendingViewport = null; this._cancelViewportRestore(widget);
            }
            view.setChannelCount(this.service.numericSource.frames.channelCount);
            const channelKey = this._channelSettingsKey(widget);
            const channels = view.getChannelMeta().map((channel, index) => ({ ...channel, ...settings[channelKey][index],
                name: this.globals.channelNames[index] ?? SerialPlotter.formatChannelId(index),
                color: this.channelColor(index),
                visible: target.isSignal(index) && (settings[channelKey][index]?.visible ?? false) }));
            view.setChannelSettings(channels);
            settings[channelKey] = view.getChannelMeta();
            view.maxPoints = response ? 65536 : Number(this.globals.maxPoints);
            // Plotter's window is the time viewport. Static spectra use responseFrames.gridSize separately.
            view.setPlotWindowPoints(Number(response
                ? settings.plotResponseTimePoints : this.globals.plotWindowPoints));
            const db = this._magnitudeUnit(settings) === 'db';
            view.setDisplayOptions({ displayMode: settings.plotViewMode, timeXUnit: settings.plotTimeXUnit,
                freqXUnit: settings.plotFreqXUnit, freqXScale: settings.plotFreqXScale, freqYScale: settings.plotFreqYScale,
                magnitudeUnit: this._magnitudeUnit(settings), dbFactor: settings.plotDbFactor,
                phaseUnwrap: settings.plotPhaseUnwrap, phaseUnit: settings.plotPhaseUnit, responseSampleRate: settings.plotResponseSampleRate,
                yScaleModePhase: settings.plotYScaleModePhase, yMinPhase: settings.plotYMinPhase, yMaxPhase: settings.plotYMaxPhase,
                fftWindow: settings.plotFftWindow, removeDcForFft: settings.plotFftRemoveDc,
                yScaleModeTime: settings.plotYScaleModeTime, yScaleModeFreq: settings[db ? 'plotYScaleModeDb' : 'plotYScaleModeFreq'],
                yMinTime: settings.plotYMinTime, yMaxTime: settings.plotYMaxTime,
                yMinFreq: settings[db ? 'plotYMinDb' : 'plotYMinFreq'], yMaxFreq: settings[db ? 'plotYMaxDb' : 'plotYMaxFreq'] });
            if (switching) {
                const saved = settings[response ? 'responseViewport' : 'viewport'];
                if (saved) {
                    if (!SerialPlotter.WidgetViewport.restoreWidgetViewport(view, saved)) {
                        widget.pendingViewport = saved;
                        for (const mode of ['time', 'frequency', 'phase']) if (saved[mode]) view.vp[mode].displayCount = saved[mode].displayCount;
                    }
                } else for (const mode of ['time', 'frequency', 'phase']) Object.assign(view.vp[mode],
                    { displayCount: view.plotWindowPoints, autoFollow: true, scrollOffset: Math.max(0, view.frames.length - view.plotWindowPoints) });
            }
            widget.appliedContent = settings.plotContent;
            if (view.isPaused !== this.service.paused) view.togglePause();
            view.resize();
        } else {
            view.setMode(settings.captureMode);
            view.setEncoding(settings.textEncoding);
            view.setDisplayOptions(settings.monitorDisplay);
            view.channelColors = Array.from({ length: this.service.numericSource.frames.channelCount }, (_, index) => this.channelColor(index));
        }
    }

    activate(id) {
        const nextId = this.widgets.has(id) ? id : null;
        if (nextId !== this.activeId) this._commitTitle();
        this.activeId = nextId;
        const widget = this.active;
        this.element('widget-selection-prompt').hidden = Boolean(widget);
        this.element('widget-title-tools').hidden = !widget;
        this.element('monitor-settings-tabs').hidden = !widget;
        this.element('active-monitor-caption').textContent = widget?.title ?? '控件属性';
        if (!widget) {
            for (const id of ['channel-config-list', 'monitor-channel-list']) this.channelView.clear(this.element(id));
            this.onActivate(null); return;
        }
        this.binding = true;
        this.element('widget-title').value = widget.title;
        for (const [key, id] of Object.entries(this.fieldIds)) {
            const field = this.element(id);
            if (widget.settings[key] === undefined) continue;
            if (field.type === 'checkbox') field.checked = widget.settings[key]; else field.value = widget.settings[key];
        }
        this.syncGlobals();
        if (widget.type === 'wave') this._bindYBounds(widget);
        else { this.displayView.apply(widget.settings.monitorDisplay); this.displayView.setMode(widget.settings.captureMode); }
        this.displayView.setChannels(this.channelMeta());
        this._renderChannels(widget);
        this._syncSections(widget);
        this.binding = false;
        this.onActivate(widget);
        this.selectTab(widget.lastTab ?? (widget.type === 'wave' ? 'tab-waveform-config' : 'tab-monitor-config'));
    }

    channelMeta() {
        const frames = this.service.numericSource.frames;
        return Array.from({ length: frames.channelCount }, (_, index) => ({ index, number: index + 1,
            definition: this.globals.channelDefinitions.find(value => value.number === index + 1),
            color: this.channelColor(index), signal: this.active?.type === 'wave' && this.active.settings.plotContent === 'response'
                ? ['constant', 'system'].includes(this.globals.channelDefinitions.find(value => value.number === index + 1)?.type)
                : frames.isSignal(index),
            name: this.globals.channelNames[index] ?? SerialPlotter.formatChannelId(index) }))
            .filter(channel => channel.index < Number(this.globals.channelsCount) || channel.definition);
    }

    channelColor(index) {
        return this.globals.channelColors[index] ?? ['#ff0000', '#00ff00', '#00ffff', '#ffff00', '#ff00ff', '#ffffff'][index % 6];
    }

    channelVisible(widget, index) {
        if (!(widget.type === 'wave' ? widget.view.frames : this.service.numericSource.frames).isSignal(index)) return false;
        return widget.type === 'wave' ? widget.view.getChannelMeta()[index]?.visible === true
            : !widget.settings.monitorDisplay.numericHiddenChannels.includes(index);
    }

    setChannelVisible(index, visible) {
        const widget = this.active;
        if (!widget || !(widget.type === 'wave' ? widget.view.frames : this.service.numericSource.frames).isSignal(index)) return;
        if (widget.type === 'wave') {
            widget.view.setChannelVisible(index, visible); widget.settings[this._channelSettingsKey(widget)] = widget.view.getChannelMeta();
        } else {
            const hidden = new Set(widget.settings.monitorDisplay.numericHiddenChannels);
            if (visible) hidden.delete(index); else hidden.add(index);
            widget.settings.monitorDisplay.numericHiddenChannels = [...hidden].sort((a, b) => a - b);
            this.displayView.elements.numericHiddenChannels.value = JSON.stringify([...hidden]);
            widget.view.setDisplayOptions(widget.settings.monitorDisplay);
        }
        this.onChange();
    }

    setChannelColor(index, color) {
        this.globals.channelColors[index] = color;
        // Keep colors at intervening indices valid for imported/saved arrays.
        for (let i = 0; i < this.globals.channelColors.length; i++) this.globals.channelColors[i] ??= this.channelColor(i);
        for (const widget of this.widgets.values()) {
            if (widget.type === 'wave') {
                widget.view.setChannelColor(index, color); widget.settings[this._channelSettingsKey(widget)] = widget.view.getChannelMeta();
            } else {
                widget.view.channelColors = Array.from({ length: this.service.numericSource.frames.channelCount }, (_, i) => this.channelColor(i));
                widget.view.invalidateData();
            }
        }
        this.onChange();
    }

    validateChannelDefinition(definition) {
        const definitions = this.globals.channelDefinitions.filter(value => value.number !== definition.number).concat(definition);
        return new SerialPlotter.ChannelOperations(Number(this.globals.channelsCount), definitions);
    }

    updateChannelDefinition(definition, { reapply = false } = {}) {
        this.validateChannelDefinition(definition);
        const definitions = this.globals.channelDefinitions.filter(value => value.number !== definition.number).concat({ ...definition })
            .sort((a, b) => a.number - b.number);
        const ready = this.service.updateChannelDefinitions(definitions, {
            rebuild: this.globals.rebuildHistory, reapply: reapply ? [definition.number] : []
        });
        this.globals.channelDefinitions = definitions;
        this._channelsChanged();
        return ready;
    }

    addChannel(type) {
        const number = Math.max(Number(this.globals.channelsCount), ...this.globals.channelDefinitions.map(value => value.number)) + 1;
        const definition = { number, type, expression: type === 'constant' ? '[0]=1' : type === 'system' ? 'x[0]' : 'CH01' };
        if (type === 'system') definition.initial = '';
        this.channelView.expanded.add(number);
        this.updateChannelDefinition(definition).catch(error => this._showError(error.message));
        return number;
    }

    removeChannel(number) {
        if (!this.globals.channelDefinitions.some(value => value.number === number)) return;
        const remaining = this.globals.channelDefinitions.filter(value => value.number !== number);
        // Reject references to the deleted channel before shifted IDs can hide them.
        new SerialPlotter.ChannelOperations(Number(this.globals.channelsCount), remaining);
        const oldCount = this.service.numericSource.frames.channelCount;
        const numberMap = new Map(Array.from({ length: oldCount }, (_, index) => index + 1)
            .filter(value => value !== number).map(value => [value, value > number ? value - 1 : value]));
        return this._remapChannels(remaining, numberMap);
    }

    moveChannel(from, to) {
        const order = this.globals.channelDefinitions.map(definition => definition.number).sort((a, b) => a - b);
        const first = order.indexOf(from), last = order.indexOf(to);
        if (first < 0 || last < 0) throw new Error('只能调整用户新增通道的顺序，原始数据通道固定');
        if (first === last) return Promise.resolve();
        const positions = [...order];
        order.splice(first, 1); order.splice(last, 0, from);
        const numberMap = new Map(Array.from({ length: this.service.numericSource.frames.channelCount }, (_, index) => [index + 1, index + 1]));
        order.forEach((number, index) => numberMap.set(number, positions[index]));
        return this._remapChannels(this.globals.channelDefinitions, numberMap);
    }

    _remapChannels(previousDefinitions, numberMap) {
        const remapDefinition = definition => ({ ...definition, number: numberMap.get(definition.number),
            expression: SerialPlotter.renumberChannelExpression(definition.expression, numberMap) });
        const definitions = previousDefinitions.map(remapDefinition).sort((a, b) => a.number - b.number);
        new SerialPlotter.ChannelOperations(Number(this.globals.channelsCount), definitions);
        this.onBeforeChannelRenumber(numberMap);
        const indices = values => values.filter(index => numberMap.has(index + 1)).map(index => numberMap.get(index + 1) - 1);
        const oldCount = this.service.numericSource.frames.channelCount;
        const names = Array.from({ length: oldCount }, (_, index) => this.globals.channelNames[index] ?? SerialPlotter.formatChannelId(index));
        const colors = Array.from({ length: oldCount }, (_, index) => this.channelColor(index));
        const reorder = values => {
            const result = [];
            values.forEach((value, index) => {
                if (numberMap.has(index + 1)) result[numberMap.get(index + 1) - 1] = value;
            });
            return result;
        };
        this.globals.channelNames = reorder(names.map((name, index) => name === SerialPlotter.formatChannelId(index) && numberMap.has(index + 1)
            ? SerialPlotter.formatChannelId(numberMap.get(index + 1) - 1) : name));
        this.globals.channelColors = reorder(colors);
        for (const widget of this.widgets.values()) {
            if (widget.type === 'wave') for (const key of ['channels', 'responseChannels'])
                widget.settings[key] = reorder(widget.settings[key]).map((channel, index) => ({ ...channel,
                    name: this.globals.channelNames[index], color: this.globals.channelColors[index] }));
            else widget.settings.monitorDisplay.numericHiddenChannels = indices(widget.settings.monitorDisplay.numericHiddenChannels);
            for (const profile of Object.values(widget.settings.exportSettings?.formats ?? {}))
                if (profile.channelIndices !== null) profile.channelIndices = indices(profile.channelIndices);
        }
        this.channelView.expanded = new Set([...this.channelView.expanded].filter(value => numberMap.has(value)).map(value => numberMap.get(value)));
        this.channelView.drafts = new Map([...this.channelView.drafts].filter(([value]) => numberMap.has(value))
            .map(([value, draft]) => [numberMap.get(value), remapDefinition(draft)]));
        const ready = this.service.updateChannelDefinitions(definitions, { rebuild: false, numberMap });
        this.globals.channelDefinitions = definitions;
        this._channelsChanged();
        return ready.catch(error => this._showError(error.message));
    }

    _channelsChanged() {
        for (const widget of this.widgets.values()) {
            if (widget.type === 'wave') this.applySettings(widget);
            else {
                widget.view.channelColors = Array.from({ length: this.service.numericSource.frames.channelCount }, (_, index) => this.channelColor(index));
                widget.view.setDisplayOptions(widget.settings.monitorDisplay);
                widget.view.invalidateData();
            }
        }
        if (this.active) this.activate(this.activeId);
        this.onRulesChange(); this.onChange();
    }

    setChannelName(index, name) {
        this.globals.channelNames[index] = name;
        for (let i = 0; i < this.globals.channelNames.length; i++) this.globals.channelNames[i] ??= SerialPlotter.formatChannelId(i);
        for (const widget of this.widgets.values()) if (widget.type === 'wave') {
            widget.view.setChannelName(index, name);
            widget.settings[this._channelSettingsKey(widget)] = widget.view.getChannelMeta();
        }
        this.displayView.setChannels(this.channelMeta());
        this.onChange();
    }

    syncGlobals() {
        this.element('plot-window-points').value = this.active?.type === 'wave' &&
            this.active.settings.plotContent === 'response' && this.active.settings.plotViewMode === 'time'
            ? this.active.settings.plotResponseTimePoints : this.globals.plotWindowPoints;
        for (const [key, id] of Object.entries(this.globalIds)) {
            const input = this.element(id);
            if (input.type === 'checkbox') input.checked = this.globals[key]; else input.value = this.globals[key];
        }
        for (const id of ['rebuild-history', 'rebuild-history-byte', 'channel-rebuild-wave', 'channel-rebuild-byte'])
            this.element(id).checked = this.globals.rebuildHistory;
        this.element('header-config').hidden = !this.globals.enableHeader;
        this.element('footer-config').hidden = !this.globals.enableFooter;
    }

    updateTextRules(rules) {
        const candidate = { ...this.globals, ...rules };
        SerialPlotter.validateConfig(candidate);
        if (candidate.textEncoding === this.globals.textEncoding && candidate.textBoundary === this.globals.textBoundary) return;
        Object.assign(this.globals, rules);
        for (const widget of this.widgets.values()) if (widget.type === 'byte') {
            Object.assign(widget.settings, rules);
            if (widget.settings.captureMode === 'text') {
                const previous = widget.source;
                widget.source = this.service.acquireSource(widget.settings);
                widget.view.setFrames(widget.source.frames);
                this.service.releaseSource(previous); this._whenReady(widget);
            }
            this.applySettings(widget);
        }
        this.onRulesChange(); this.onChange();
    }

    selectTab(tab) {
        const widget = this.active;
        if (!widget) return;
        const wave = widget.type === 'wave';
        const valid = new Set(wave ? ['tab-waveform-frame', 'tab-waveform-config', 'tab-waveform-channels']
            : ['tab-byte-frame', 'tab-monitor-config', ...(widget.settings.captureMode === 'number' ? ['tab-monitor-channels'] : [])]);
        if (!valid.has(tab)) tab = wave ? 'tab-waveform-config' : 'tab-monitor-config';
        widget.lastTab = tab;
        for (const button of this.element('monitor-settings-tabs').querySelectorAll('.tab-btn')) {
            const selected = button.dataset.tab === tab;
            button.hidden = !valid.has(button.dataset.tab);
            button.classList.toggle('active', selected);
            const panel = this.element(button.dataset.tab);
            panel.hidden = !selected;
            panel.classList.toggle('active', selected);
        }
    }

    _bindYBounds(widget) {
        const suffix = this._ySuffix(widget.settings);
        for (const [key, id] of [['plotYScaleMode', 'plot-y-scale-mode'], ['plotYMin', 'plot-y-min'], ['plotYMax', 'plot-y-max']])
            this.element(id).value = widget.settings[key + suffix];
    }

    _syncSections(widget) {
        const s = widget.settings;
        const byteNumeric = widget.type === 'byte' && s.captureMode === 'number';
        const shared = this.element('shared-numeric-settings');
        const host = this.element(byteNumeric ? 'byte-numeric-settings' : 'tab-waveform-frame');
        if (shared.parentElement !== host) host.append(shared);
        this.element('byte-numeric-settings').hidden = !byteNumeric;
        this.element('plot-response-status').textContent = widget.responseStatus ?? '';
        this.element('plot-response-status').hidden = !widget.responseStatus;
        const response = s.plotContent === 'response', phase = s.plotViewMode === 'phase', db = this._magnitudeUnit(s) === 'db';
        this.element('wrap-response-options').hidden = !response;
        this.element('plot-sample-axis-hint').hidden = response;
        this.element('wrap-fft-window').hidden = response;
        this.element('wrap-magnitude-scale').hidden = s.plotViewMode !== 'frequency';
        this.element('plot-freq-y-scale').value = db ? `db${s.plotDbFactor}` : `amplitude-${s.plotFreqYScale}`;
        this.element('plot-freq-x-scale').value = `${s.plotFreqXUnit}-${s.plotFreqXScale}`;
        this.element('plot-horizontal-settings').hidden = response && s.plotViewMode === 'time';
        this.element('plot-spectrum-settings').hidden = response || s.plotViewMode === 'time';
        this.element('plot-log-axis-hint').hidden = s.plotViewMode !== 'frequency' || db || s.plotFreqYScale !== 'log';
        this.element('wrap-phase-options').hidden = !phase;
        this.element('wrap-phase-unit').hidden = !phase;
        this.element('wrap-plot-time-axis').style.display = s.plotViewMode === 'time' && !response ? '' : 'none';
        this.element('wrap-plot-frequency-axis').style.display = s.plotViewMode !== 'time' ? '' : 'none';
        this.element('wrap-fft-remove-dc').style.display = s.plotViewMode !== 'time' && !response ? '' : 'none';
        this.element('wrap-plot-y-bounds').style.display = this.element('plot-y-scale-mode').value === 'manual' ? '' : 'none';
        this.element('frame-raw-settings').hidden = s.captureMode !== 'text';
        this.element('frame-text-settings').hidden = s.captureMode !== 'text';
        const independent = response && s.plotViewMode === 'time';
        this.element('plot-window-points').max = String(independent ? 65536 : Math.min(65536, Number(this.globals.maxPoints)));
        this.element('plot-window-label').textContent = independent ? '时域采样点数（当前控件）' : '采样点数（全局共用）';
    }

    _commitTitle() {
        const widget = this.active;
        if (!widget || this.binding) return;
        const field = this.element('widget-title'), title = field.value.trim();
        if (!title) { field.value = widget.title; return; }
        if (title === widget.title) return;
        widget.title = title;
        widget.refs[widget.type === 'wave' ? 'waveform-drag-handle' : 'monitor-header'].querySelector('span').textContent = title;
        this.element('active-monitor-caption').textContent = title;
        const entry = this.workspace.entries.get(widget.id);
        if (entry) { entry.title = title; entry.handle.setAttribute('aria-label', `${title}: arrow keys move, Shift + arrows resize, Delete removes`); }
        this.onChange();
    }

    _bindInspector() {
        this._listen(this.element('plot-window-points'), 'change', () => {
            try { this.setPlotWindowPoints(this.element('plot-window-points').value); this._showError(''); }
            catch (error) { this._showError(error.message); }
        });
        for (const kind of ['wave', 'byte']) this._listen(this.element(`channel-category-${kind}`), 'change', () => {
            if (!this.active) return;
            this.active.channelCategory = this.element(`channel-category-${kind}`).value;
            this._renderChannels(this.active);
        });
        for (const kind of ['wave', 'byte']) this._listen(this.element(`channel-add-type-${kind}`), 'change', () => {
            const widget = this.active;
            if (widget?.type !== kind || widget.channelCategory && widget.channelCategory !== 'all') return;
            widget.channelAddType = this.element(`channel-add-type-${kind}`).value;
        });
        for (const button of this.element('monitor-settings-tabs').querySelectorAll('.tab-btn'))
            this._listen(button, 'click', () => this.selectTab(button.dataset.tab));
        for (const name of ['change', 'blur', 'pointerleave'])
            this._listen(this.element('widget-title'), name, () => this._commitTitle());
        this._listen(this.element('widget-title-tools'), 'pointerleave', () => this._commitTitle());
        this._listen(this.element('widget-delete'), 'click', () => { if (this.active) this.remove(this.activeId); });
        for (const [key, id] of Object.entries(this.fieldIds)) this._listen(this.element(id), 'change', () => {
            const widget = this.active;
            if (!widget || this.binding) return;
            const field = this.element(id), candidate = { ...widget.settings,
                [key]: field.type === 'checkbox' ? field.checked : field.value };
            try {
                if (widget.type === 'byte' && ['textEncoding', 'textBoundary'].includes(key)) {
                    this.updateTextRules({ [key]: field.value });
                    this.activate(widget.id); this._showError(''); return;
                }
                // Combined axis choices map back to the existing configuration fields.
                if (key === 'plotFreqYScale') {
                    if (!['amplitude-linear', 'amplitude-log', 'db10', 'db20'].includes(field.value))
                        throw new Error('纵轴刻度无效');
                    const amplitude = field.value.startsWith('amplitude-');
                    candidate.plotMagnitudeUnit = amplitude ? 'amplitude' : 'db';
                    candidate.plotFreqYScale = amplitude ? field.value.slice(10) : widget.settings.plotFreqYScale;
                    if (!amplitude) candidate.plotDbFactor = field.value.slice(2);
                }
                if (key === 'plotFreqXScale') {
                    if (!['bins-linear', 'bins-log', 'hz-linear', 'hz-log'].includes(field.value))
                        throw new Error('横轴刻度无效');
                    [candidate.plotFreqXUnit, candidate.plotFreqXScale] = field.value.split('-');
                }
                if (key === 'plotPhaseUnit' && candidate.plotPhaseUnit !== widget.settings.plotPhaseUnit) {
                    const factor = candidate.plotPhaseUnit === 'radians' ? Math.PI / 180 : 180 / Math.PI;
                    candidate.plotYMinPhase = String(Number(candidate.plotYMinPhase) * factor);
                    candidate.plotYMaxPhase = String(Number(candidate.plotYMaxPhase) * factor);
                    for (const viewportKey of ['viewport', 'responseViewport']) {
                        const viewport = candidate[viewportKey], zoom = viewport?.phase?.yZoom;
                        if (!zoom) continue;
                        candidate[viewportKey] = { ...viewport, phase: { ...viewport.phase,
                            yZoom: { ...zoom, min: zoom.min * factor, max: zoom.max * factor,
                                ...(zoom.base ? { base: { ...zoom.base,
                                    min: zoom.base.min * factor, max: zoom.base.max * factor } } : {}) } } };
                    }
                }
                const next = SerialPlotter.WidgetConfig.normalizeWidgetSettings(widget.type, candidate, this.globals);
                const ruleChanged = widget.type === 'byte' && ['captureMode', 'textEncoding', 'textBoundary'].includes(key);
                widget.settings = next;
                if (key === 'plotPhaseUnit' && widget.pendingViewport)
                    widget.pendingViewport = next[next.plotContent === 'response' ? 'responseViewport' : 'viewport'];
                if (ruleChanged) {
                    const previous = widget.source;
                    widget.source = this.service.acquireSource(next);
                    widget.view.setFrames(widget.source.frames);
                    this.service.releaseSource(previous);
                    this._whenReady(widget);
                    this.onRulesChange(widget);
                }
                this.applySettings(widget);
                if (key === 'plotContent') this.onRulesChange(widget);
                this.activate(widget.id);
                this.onChange(); this._showError('');
            } catch (error) { this._showError(error.message); }
        });
        for (const id of ['plot-y-scale-mode', 'plot-y-min', 'plot-y-max']) this._listen(this.element(id), 'change', () => {
            const widget = this.active;
            if (widget?.type !== 'wave') return;
            const suffix = this._ySuffix(widget.settings);
            const candidate = { ...widget.settings, [`plotYScaleMode${suffix}`]: this.element('plot-y-scale-mode').value,
                [`plotYMin${suffix}`]: this.element('plot-y-min').value, [`plotYMax${suffix}`]: this.element('plot-y-max').value };
            try {
                widget.settings = SerialPlotter.WidgetConfig.normalizeWidgetSettings('wave', candidate, this.globals);
                this.applySettings(widget); this._syncSections(widget); this.onChange(); this._showError('');
            } catch (error) { this._showError(error.message); }
        });
        for (const [key, id] of Object.entries(this.globalIds)) this._listen(this.element(id), 'change', () => {
            const input = this.element(id), candidate = { ...this.globals, [key]: input.type === 'checkbox' ? input.checked : input.value };
            try {
                SerialPlotter.validateConfig(candidate);
                new SerialPlotter.ChannelOperations(Number(candidate.channelsCount), candidate.channelDefinitions);
                Object.assign(this.globals, candidate);
                void this.service.updateNumericFormat(candidate).then(() => this.syncData(this.service.numericSource));
                for (const widget of this.widgets.values()) if (widget.type === 'wave') this.applySettings(widget);
                this.syncGlobals(); this.activate(this.activeId); this.onRulesChange(); this.onChange(); this._showError('');
            } catch (error) { this._showError(error.message); }
        });
        for (const id of ['rebuild-history', 'rebuild-history-byte', 'channel-rebuild-wave', 'channel-rebuild-byte']) this._listen(this.element(id), 'change', () => {
            this.globals.rebuildHistory = this.element(id).checked;
            this.service.rebuildHistory = this.globals.rebuildHistory;
            this.syncGlobals(); this.onChange();
        });
        for (const kind of ['wave', 'byte']) this._listen(this.element(`channel-add-${kind}`), 'click', () => {
            const widget = this.active;
            if (widget?.type !== kind || widget.channelCategory === 'raw') return;
            const type = widget.channelCategory && widget.channelCategory !== 'all'
                ? widget.channelCategory : this.element(`channel-add-type-${kind}`).value;
            try { this.addChannel(type); }
            catch (error) { this._showError(error.message); }
        });
        for (const [id, visible] of [['btn-channels-all-on', true], ['btn-channels-all-off', false]])
            this._listen(this.element(id), 'click', () => {
                if (this.active?.type !== 'wave') return;
                this.active.view.setChannelSettings(this.active.view.getChannelMeta().map((channel, index) =>
                    ({ ...channel, visible: visible && this.active.view.frames.isSignal(index) })));
                this.active.settings[this._channelSettingsKey(this.active)] = this.active.view.getChannelMeta();
                this._renderChannels(this.active); this.onChange();
            });
    }

    _renderChannels(widget) {
        const category = widget.channelCategory ?? 'all', restricted = category !== 'all';
        this.element(`channel-category-${widget.type}`).value = category;
        const type = this.element(`channel-add-type-${widget.type}`), button = this.element(`channel-add-${widget.type}`);
        type.value = restricted ? category : widget.channelAddType ?? 'formula';
        type.disabled = restricted;
        for (const option of type.options) if (option.value === 'raw') option.hidden = category !== 'raw';
        button.disabled = category === 'raw';
        button.title = category === 'raw' ? '原始数据通道由帧解析生成，不能手动新增' : '';
        if (widget.type === 'wave') this.channelView.render(this.element('channel-config-list'), widget);
        else if (widget.settings.captureMode === 'number') this.channelView.render(this.element('monitor-channel-list'), widget);
    }

    _channelSettingsKey(widget) { return widget.settings.plotContent === 'response' ? 'responseChannels' : 'channels'; }
    _magnitudeUnit(settings) { return settings.plotMagnitudeUnit === 'auto'
        ? settings.plotContent === 'response' ? 'db' : 'amplitude' : settings.plotMagnitudeUnit; }
    _ySuffix(settings) { return settings.plotViewMode === 'time' ? 'Time' : settings.plotViewMode === 'phase' ? 'Phase'
        : this._magnitudeUnit(settings) === 'db' ? 'Db' : 'Freq'; }

    _showError(message) { const field = this.element('format-apply-status'); field.textContent = message; field.hidden = !message; }

    _renderWaveStats(widget, data) {
        const refs = widget.refs, view = widget.view;
        refs['plot-info-row'].hidden = !data;
        if (!data) return;
        const frequencyUnit = view.freqXUnit === 'bins' ? 'Bin' : 'Hz';
        const periodUnit = view.timeXUnit === 's' ? 's' : 'Sample';
        const number = value => Number.isFinite(value) ? value.toPrecision(6) : '--';
        const entries = [['通道:', data.channelLabel], ['最大值:', number(data.max)], ['最小值:', number(data.min)],
            ['峰峰值:', number(data.pp)], ['均值:', number(data.mean)], ['标准差:', number(data.stdDev)],
            ['主频:', `${number(frequencyUnit === 'Bin' ? data.dominantBin : view.sampleRateHz > 0 ? data.freq * view.sampleRateHz : NaN)} ${frequencyUnit}`],
            ['主周期:', `${number(periodUnit === 'Sample' ? data.period : view.sampleRateHz > 0 ? data.period / view.sampleRateHz : NaN)} ${periodUnit}`]];
        const target = refs['plot-channel-stats'];
        if (!target.children.length) target.replaceChildren(...entries.map(([label]) => {
            const cell = this.document.createElement('span'); cell.className = 'monitor-stat-item';
            const caption = this.document.createElement('span'); caption.className = 'monitor-stat-label'; caption.textContent = label;
            const value = this.document.createElement('span'); value.className = 'monitor-stat-value'; cell.append(caption, value); return cell;
        }));
        entries.forEach((entry, index) => { target.children[index].children[1].textContent = entry[1]; });
    }

    syncData(source) {
        for (const widget of this.widgets.values()) if (!source || widget.source === source) {
            if (widget.type === 'wave' && widget.settings.plotContent === 'response') continue;
            if (widget.view) this._restoreViewport(widget);
            widget.view?.invalidateData();
        }
    }

    _restoreViewport(widget) {
        if (widget.disposed || widget.type !== 'wave' || !widget.pendingViewport || !widget.view) return;
        const source = widget.source, ready = source.ready, frames = source.frames, generation = source.generation;
        if (widget.readyPromise !== ready) { this._whenReady(widget); return; }
        if (widget.readySource !== source || source.rebuilding || !frames.length || widget.viewportFrame != null) return;
        // Parser callbacks run once per sample. Restore against the completed receive block,
        // after the source-ready callback has applied its initial display settings.
        widget.viewportFrame = requestAnimationFrame(() => {
            widget.viewportFrame = null;
            if (widget.disposed || widget.source !== source || source.ready !== ready ||
                widget.readySource !== source || source.generation !== generation || source.rebuilding ||
                widget.view.frames !== frames || !widget.pendingViewport) return;
            if (SerialPlotter.WidgetViewport.restoreWidgetViewport(widget.view, widget.pendingViewport))
                widget.pendingViewport = null;
        });
    }

    _cancelViewportRestore(widget) {
        if (widget.viewportFrame != null) cancelAnimationFrame(widget.viewportFrame);
        widget.viewportFrame = null;
    }

    _measureByteChrome(widget) {
        if (widget.disposed || widget.type !== 'byte') return;
        const entry = this.workspace.entries.get(widget.id);
        if (!entry) return;
        const minHeight = widget.refs['monitor-header'].offsetHeight + widget.refs['monitor-stats'].offsetHeight + 92 + 12;
        if (entry.minHeight === minHeight) return;
        entry.minHeight = minHeight;
        this.workspace.refresh();
    }
    resize(id) {
        const widget = this.widgets.get(id);
        if (!widget) return;
        this._measureByteChrome(widget);
        widget.view?.resize?.(); widget.view?.schedule?.();
    }
    setPaused(paused) {
        for (const widget of this.widgets.values()) {
            if (widget.type === 'wave' && widget.view.isPaused !== paused) widget.view.togglePause();
            widget.view.invalidateData();
        }
    }
    appendExtra(record, source) {
        for (const widget of this.widgets.values()) if (widget.type === 'byte' && (!source || source === widget.source)) {
            if (record.kind === 'tx' || source) widget.view.invalidateData();
            else widget.view.appendExtra(record);
        }
    }
    setPlotWindowPoints(value) {
        if (this.active?.type === 'wave' && this.active.settings.plotContent === 'response' && this.active.settings.plotViewMode === 'time') {
            SerialPlotter.parseIntInRange(value, 2, 65536, '系统响应时域采样点数');
            this.active.settings.plotResponseTimePoints = String(value);
            this.applySettings(this.active);
            this.activate(this.activeId); this.onChange(); return;
        }
        SerialPlotter.validateConfig({ plotWindowPoints: value, maxPoints: this.globals.maxPoints });
        this.globals.plotWindowPoints = String(value);
        for (const widget of this.widgets.values()) if (widget.type === 'wave') this.applySettings(widget);
        this.activate(this.activeId);
        this.onChange();
    }
    setCapacity(capacity) {
        this.globals.plotWindowPoints = String(Math.min(Number(this.globals.plotWindowPoints), capacity));
        for (const widget of this.widgets.values()) if (widget.type === 'wave') {
            this.applySettings(widget);
        }
        this.activate(this.activeId);
    }
    remove(id) {
        const widget = this.widgets.get(id);
        if (!widget) return;
        this._cancelViewportRestore(widget);
        widget.disposed = true; widget.visibility?.disconnect(); widget.chromeObserver?.disconnect(); widget.view.dispose(); widget.responseFrames?.dispose();
        this.service.releaseSource(widget.source);
        this.widgets.delete(id); this.workspace.remove(id);
        if (this.activeId === id) this.activate(null);
        this.element('workspace-empty').hidden = this.widgets.size > 0;
        this.onRulesChange(widget); this.onChange();
    }
    serialize() {
        return [...this.widgets.values()].map(widget => {
            const { id, type, title, settings } = widget;
            if (type === 'wave' && widget.view && widget.view.frames.length)
                settings[settings.plotContent === 'response' ? 'responseViewport' : 'viewport'] =
                    widget.pendingViewport ?? SerialPlotter.WidgetViewport.captureWidgetViewport(widget.view);
            return { id, type, title, settings: JSON.parse(JSON.stringify(settings)) };
        });
    }
    dispose() {
        this.channelView.dispose();
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        this.displayView.dispose();
        for (const widget of this.widgets.values()) {
            this._cancelViewportRestore(widget);
            widget.disposed = true; widget.visibility?.disconnect(); widget.chromeObserver?.disconnect(); widget.view.dispose(); widget.responseFrames?.dispose(); this.service.releaseSource(widget.source);
        }
        this.widgets.clear();
    }
}
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.WidgetController = WidgetController;
if (typeof module !== 'undefined') module.exports = { WidgetController };

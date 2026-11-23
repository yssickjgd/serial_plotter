/** Own view instances and bind the one property inspector to the selected widget. */
class WidgetController {
    constructor({ document, service, globals, workspace, onChange = () => {}, onRulesChange = () => {}, onActivate = () => {},
        onBeforeChannelRenumber = () => {}, onChannelMetadataChange = () => {}, getConnections = () => [],
        getPrimaryConnectionName = () => '主连接', getWorkspaceCapture = () => null, getSourcePlotTimeline = () => null,
        onTextPreparation = null }) {
        this.document = document;
        this.service = service;
        this.getConnections = getConnections;
        this.getPrimaryConnectionName = getPrimaryConnectionName;
        this.getWorkspaceCapture = getWorkspaceCapture;
        this.getSourcePlotTimeline = getSourcePlotTimeline;
        this.globals = globals;
        this.workspace = workspace;
        this.onChange = onChange;
        this.onTextPreparation = onTextPreparation;
        this.onRulesChange = onRulesChange;
        this.onBeforeChannelRenumber = onBeforeChannelRenumber;
        this.onChannelMetadataChange = onChannelMetadataChange;
        this.channelSearchText = '';
        this.onActivate = onActivate;
        this.widgets = new Map();
        this.activeId = null;
        this.nextNumber = 1;
        this.decodeCache = new WeakMap();
        this.registry = new Map();
        this.cleanups = [];
        this.register('wave', { template: 'wave-widget-template', title: '波形' });
        this.register('byte', { template: 'byte-widget-template', title: '字节流' });
        this.register('pose', { template: 'pose-widget-template', title: '位姿' });
        this.fieldIds = {
            plotViewMode: 'plot-view-mode', plotTimeXUnit: 'plot-time-x-unit',
            plotFreqXScale: 'plot-freq-x-scale', plotFreqYScale: 'plot-freq-y-scale',
            plotFftWindow: 'plot-fft-window', plotFftRemoveDc: 'plot-fft-remove-dc',
            plotContent: 'plot-content',
            plotPhaseUnwrap: 'plot-phase-unwrap', plotPhaseUnit: 'plot-phase-unit', plotResponseSampleRate: 'plot-response-sample-rate',
            captureMode: 'capture-mode', hexBoundary: 'hex-boundary', textEncoding: 'text-encoding', textBoundary: 'text-boundary'
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
        }, onChannelNameChange: (index, name) => this.setChannelName(index, name, this.active?.capture) });
        this.displayView.channelRenderer = list => {
            if (this.active?.type === 'byte') this.channelView.render(list, this.active);
        };
        this._bindInspector();
        this.poseConfigView = new SerialPlotter.PoseConfigView(document, this);
        this.activate(null);
    }

    get active() { return this.widgets.get(this.activeId); }
    element(id) { return this.document.getElementById(id); }
    _listen(element, event, callback, cleanups = this.cleanups) {
        if (!element) return;
        element.addEventListener(event, callback);
        cleanups.push(() => element.removeEventListener(event, callback));
    }
    register(type, definition) { this.registry.set(type, definition); }

    captureFor(id = 'primary') {
        if (id === 'primary') return this.service;
        if (id === 'workspace') return this.getWorkspaceCapture();
        return this.getConnections().find(source => source.id === id)?.capture;
    }

    globalsFor(capture = this.service) {
        return capture === this.service ? this.globals : { ...capture.dataEngine.globals,
            maxPoints: this.globals.maxPoints, plotWindowPoints: this.globals.plotWindowPoints,
            textEncoding: this.globals.textEncoding, textBoundary: this.globals.textBoundary };
    }

    _acquire(capture, type, settings) {
        return capture.acquireSource(type === 'byte' ? settings : { captureMode: 'number', engineSource: settings.engineSource });
    }

    _bindCapture(widget, capture) {
        const previous = widget.source, owner = widget.capture;
        widget.source = this._acquire(capture, widget.type, widget.settings);
        widget.capture = capture;
        owner.releaseSource(previous);
        if (widget.type === 'byte') widget.view.txFrames = capture.txFrames;
        if (widget.type !== 'wave' || widget.settings.plotContent !== 'response') widget.view.setFrames(widget.source.frames);
    }

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
        const capture = this.captureFor(settings.connectionSource);
        if (!capture || settings.connectionSource === 'workspace' && type !== 'wave') throw new Error('控件引用了不存在的接收来源');
        const local = this.globalsFor(capture);
        const textRules = type === 'byte' && (settings.textEncoding !== undefined || settings.textBoundary !== undefined)
            ? { textEncoding: settings.textEncoding ?? this.globals.textEncoding,
                textBoundary: settings.textBoundary ?? this.globals.textBoundary } : null;
        settings = SerialPlotter.WidgetConfig.normalizeWidgetSettings(type, settings,
            textRules ? { ...local, ...textRules } : local);
        if (textRules) this.updateTextRules(textRules);
        this.nextNumber = number + 1;
        const element = this.element(definition.template).content.firstElementChild.cloneNode(true);
        const refs = Object.fromEntries([...element.querySelectorAll('[data-role]')]
            .map(node => [node.dataset.role, node]));
        refs[element.dataset.role] = element;
        for (const [role, node] of Object.entries(refs)) node.id = `${id}-${role}`;
        const handle = refs[type === 'wave' ? 'waveform-drag-handle' : type === 'pose' ? 'pose-header' : 'monitor-header'];
        handle.querySelector('span').textContent = title;
        const remove = this.document.createElement('button');
        remove.className = 'widget-close'; remove.type = 'button'; remove.textContent = '×';
        remove.setAttribute('aria-label', `删除${title}`);
        handle.append(remove);
        const source = this._acquire(capture, type, settings);
        const widget = { id, type, title, settings, element, refs, capture, source, lastTab: null, disposed: false };
        widget.engineNotice = this.document.createElement('div'); widget.engineNotice.className = 'widget-engine-notice';
        widget.engineNotice.setAttribute('role', 'status'); widget.engineNotice.hidden = true;
        element.append(widget.engineNotice);
        if (type === 'wave') widget.pendingViewport = settings[settings.plotContent === 'response' ? 'responseViewport' : 'viewport'];
        this.widgets.set(id, widget);
        this.workspace.add({ id, type, title, element, handle, rect, minWidth: 280, minHeight: 180 });
        if (type === 'wave') {
            widget.responseFrames = new SerialPlotter.SystemResponseFrames();
            widget.view = new SerialPlotter.Plotter(refs['waveform-canvas'], source.frames, {
                viewOnly: true, fftWorkerPool: this.service.workerPool.available ? this.service.workerPool : null,
                elements: {
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
        } else if (type === 'pose') widget.view = new SerialPlotter.PoseView(refs['pose-canvas'], source.frames, {
            settings, statusElement: refs['pose-status'], getRebuilding: () => widget.source.rebuilding || widget.source.frames.rebuilding,
            getGeneration: () => `${widget.settings.connectionSource}:${widget.capture.epoch}:${widget.source.generation}`,
            onCameraChange: camera => {
                if (widget.disposed) return;
                widget.settings.camera = camera;
                if (this.activeId === id) this.poseConfigView.render(widget);
                this.onChange();
            }
        });
        else widget.view = new SerialPlotter.MonitorView(refs['data-log'], source.frames, {
            decodeCache: this.decodeCache, txFrames: capture.txFrames, getSourceErrors: () => widget.source.errors,
            getPendingFrame: () => widget.source.rebuilding ? null : widget.source.parser.pendingIdleFrame?.(),
            onTextPreparation: this.onTextPreparation && ((fraction, done, total) => this.onTextPreparation(widget, fraction, done, total))
        });
        if (type === 'byte') {
            this._measureByteChrome(widget);
            if (typeof ResizeObserver === 'function') {
                widget.chromeObserver = new ResizeObserver(() => this._measureByteChrome(widget));
                widget.chromeObserver.observe(refs['monitor-header']);
                widget.chromeObserver.observe(refs['monitor-stats']);
            }
        }
        this._listen(remove, 'click', event => { event.stopPropagation(); this.requestRemove(id); }, widget.cleanups ??= []);
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
        const { capture } = widget, local = this.globalsFor(capture);
        const raw = capture.dataEngine?.mode === 'Raw_Data';
        widget.engineNotice.hidden = !raw || widget.type === 'wave' && settings.plotContent === 'response' || widget.type === 'byte' && settings.captureMode !== 'engine';
        widget.engineNotice.textContent = raw ? widget.type === 'byte' ? 'Raw_Data：当前展示原始记录，暂无数值字段。'
            : 'Raw_Data：暂无数值输入。可在「通讯 → 配置」中打开该来源的数据引擎；系统响应仍可查看。' : '';
        if (widget.type === 'wave') {
            const response = settings.plotContent === 'response';
            const combined = settings.connectionSource === 'workspace';
            const alignment = widget.refs['plot-alignment-status'];
            alignment.hidden = !combined || response;
            alignment.textContent = settings.plotViewMode === 'time' ? capture.alignmentLabel ?? '全局通道 · 近似对齐' : '全局通道 · 同步采样频谱';
            alignment.title = alignment.textContent;
            const timing = this.getWorkspaceCapture()?.timebases?.[settings.connectionSource ?? 'primary'];
            const timeline = !combined && !response ? this.getSourcePlotTimeline(widget.source) : null;
            view.timeProjection = timeline?.valid ? timeline : null;
            view.receiveTimeAxis = !combined && !response && timing?.mode !== 'fixed';
            view.fixedTimeRate = !response && !combined && timing?.mode === 'fixed' && widget.source !== capture.dataEngine?.syncSource
                ? timing.sampleRate : 0;
            if (!response && !combined) view.setSampleRateHz(view.fixedTimeRate || widget.source.sampleRate?.rate || 0);
            if (combined && !response) view.setSampleRateHz(capture.sampleRate);
            widget.responseFrames.configure(widget.source.kind === 'numeric' ? widget.source.frames : capture.numericSource.frames,
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
            view.setChannelCount(target.channelCount);
            const channelKey = this._channelSettingsKey(widget);
            const channels = view.getChannelMeta().map((channel, index) => ({ ...channel, ...settings[channelKey][index],
                name: local.channelNames[index] || SerialPlotter.formatChannelId(index),
                color: this.channelColor(index, local.channelColors),
                visible: target.isSignal(index) && (settings[channelKey][index]?.visible ?? false) }));
            view.setChannelSettings(channels);
            settings[channelKey] = view.getChannelMeta();
            view.maxPoints = response ? 65536 : Number(this.globals.maxPoints);
            // Plotter's window is the time viewport. Static spectra use responseFrames.gridSize separately.
            view.setPlotWindowPoints(Number(response
                ? settings.plotResponseTimePoints : this.globals.plotWindowPoints));
            const db = this._magnitudeUnit(settings) === 'db';
            // A fixed-rate source defaults to seconds until the user chooses a unit.
            const useSeconds = !response && (combined || ((view.fixedTimeRate || view.timeProjection) && !settings.plotTimeXUnitExplicit));
            view.setDisplayOptions({ displayMode: settings.plotViewMode, timeXUnit: useSeconds ? 's' : settings.plotTimeXUnit,
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
            if (view.isPaused !== capture.paused) view.togglePause();
            view.resize();
        } else if (widget.type === 'pose') {
            view.setFrames(widget.source.frames); view.setSettings(settings); view.setPaused(capture.paused); view.resize();
        } else {
            const mode = settings.captureMode === 'engine' ? widget.source.kind === 'protocol' ? 'protocol' : widget.source.kind === 'numeric' ? 'number' : 'hex' : settings.captureMode;
            if (view.setProtocolDecoder) view.setProtocolDecoder(widget.source.decodeRecord ?? null, { deferRender: true });
            if (view.setProtocolOptions) view.setProtocolOptions({ fieldPaths: settings.protocolFieldPaths,
                mappings: capture.dataEngine?.config.mappings ?? [] });
            view.setMode(mode);
            view.setEncoding(settings.textEncoding);
            view.setDisplayOptions(settings.monitorDisplay);
            view.channelColors = Array.from({ length: capture.numericSource.frames.channelCount }, (_, index) => this.channelColor(index, local.channelColors));
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
        const sourceWrap = this.element('widget-engine-source-wrap'), sourceSelect = this.element('widget-engine-source');
        const connections = [{ id: 'primary', name: this.getPrimaryConnectionName() }, ...this.getConnections()];
        if (widget?.type === 'wave' && this.getWorkspaceCapture()?.mappings.length)
            connections.push({ id: 'workspace', name: '全局通道（多来源）' });
        const connection = this.element('widget-connection-source');
        this.element('widget-connection-source-wrap').hidden = !widget || connections.length === 1;
        connection.replaceChildren(...connections.map(choice => {
            const option = this.document.createElement('option'); option.value = choice.id; option.textContent = choice.name; return option;
        }));
        if (widget) connection.value = widget.settings.connectionSource;
        const choices = widget?.capture.dataEngine?.choices() ?? [];
        sourceWrap.hidden = !widget || widget.type === 'byte' || !choices.length;
        sourceSelect.replaceChildren(...choices.map(choice => {
            const option = this.document.createElement('option'); option.value = choice.id; option.textContent = choice.name; return option;
        }));
        if (widget?.settings.engineSource && choices.length && !choices.some(choice => choice.id === widget.settings.engineSource)) {
            const option = this.document.createElement('option'); option.value = widget.settings.engineSource;
            option.textContent = `来源不可用：${widget.settings.engineSource}`; sourceSelect.append(option);
        }
        if (widget) sourceSelect.value = widget.settings.engineSource ?? 'synchronized';
        this.element('active-monitor-caption').textContent = widget?.title ?? '控件属性';
        const typeLabel = this.element('active-widget-type');
        typeLabel.hidden = !widget;
        typeLabel.textContent = widget ? { wave: '波形控件', byte: '字节流控件', pose: '位姿控件' }[widget.type] : '';
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
        const timeAxis = this.element('plot-time-x-unit');
        timeAxis.disabled = widget.type === 'wave' && widget.settings.connectionSource === 'workspace';
        if (widget.type === 'wave') timeAxis.value = widget.view.timeXUnit;
        this.syncGlobals();
        if (widget.type === 'wave') this._bindYBounds(widget);
        else if (widget.type === 'byte') { this.displayView.apply(widget.settings.monitorDisplay); this.displayView.setMode(widget.view.mode); }
        else this.poseConfigView.render(widget);
        this.displayView.setChannels(this.channelMeta());
        this._renderChannels(widget);
        this._syncSections(widget);
        this.binding = false;
        this.onActivate(widget);
        this.selectTab(widget.lastTab ?? (widget.type === 'wave' ? 'tab-waveform-config' : widget.type === 'pose' ? 'tab-pose-display' : 'tab-monitor-config'));
    }

    channelGlobals(capture = this.service) {
        return capture === this.service ? this.globals : capture.dataEngine.globals;
    }

    getChannelRegistry(capture = this.service) {
        this.channelRegistries ??= new WeakMap();
        const local = this.channelGlobals(capture);
        const { channelsCount, channelDefinitions, channelNames, channelRecords } = local;
        const cached = this.channelRegistries.get(capture);
        if (cached && cached.rawCount === channelsCount && cached.definitions === channelDefinitions &&
            cached.names === channelNames && cached.records === channelRecords) return cached.registry;
        const registry = new SerialPlotter.ChannelRegistry({
            rawCount: Number(channelsCount), definitions: channelDefinitions, names: channelNames, channels: channelRecords });
        local.channelRecords = registry.toJSON();
        this.channelRegistries.set(capture, { rawCount: channelsCount, definitions: channelDefinitions,
            names: channelNames, records: local.channelRecords, registry });
        return registry;
    }

    channelMeta(widget = this.active, capture = widget?.capture ?? this.service) {
        const frames = capture.numericSource.frames, { channelColors } = this.channelGlobals(capture);
        const response = widget?.type === 'wave' && widget.settings.plotContent === 'response';
        return this.getChannelRegistry(capture).getChannels().map(entry => ({ index: entry.number - 1, number: entry.number,
            definition: entry.definition, color: this.channelColor(entry.number - 1, channelColors), name: entry.name,
            signal: response ? ['constant', 'system'].includes(entry.type) : frames.isSignal(entry.number - 1) }));
    }

    ensureRawChannels(count) {
        const plan = this.prepareRawChannelExpansion(count);
        if (plan) return this._applyChannelRemap(plan);
    }

    prepareRawChannelExpansion(count, capture = this.service) {
        const local = this.channelGlobals(capture), old = Number(local.channelsCount);
        if (count <= old) return null;
        if (!Number.isInteger(count) || count + local.channelDefinitions.length > 65535) throw new Error('通道总数不能超过 65535');
        const registry = this.getChannelRegistry(capture), delta = count - old;
        const numberMap = new Map(registry.getChannels().map(entry => [entry.number, entry.number > old ? entry.number + delta : entry.number]));
        return this._prepareChannelRemap(local.channelDefinitions, numberMap, count, capture);
    }

    addMappedChannel() {
        this.ensureRawChannels(Number(this.globals.channelsCount) + 1);
        return this.getChannelRegistry().get(Number(this.globals.channelsCount));
    }

    rebindEngineSources(capture = this.service) {
        for (const widget of this.widgets.values()) if (widget.capture === capture) {
            // The capture service updates existing raw sources in place when their framing changes.
            if (widget.type !== 'byte' || widget.settings.captureMode === 'engine') {
                this._bindCapture(widget, capture);
            }
            if (widget.type !== 'wave' || widget.settings.plotContent !== 'response') widget.view.setFrames(widget.source.frames);
            this.applySettings(widget); this._whenReady(widget);
        }
        if (this.active?.capture === capture) this.activate(this.activeId);
        this.onRulesChange(); this.onChange();
    }

    channelColor(index, colors = this.globals.channelColors) {
        return colors[index] ?? ['#ff0000', '#00ff00', '#00ffff', '#ffff00', '#ff00ff', '#ffffff'][index % 6];
    }

    channelVisible(widget, index) {
        if (widget.type === 'pose') return false;
        if (!(widget.type === 'wave' ? widget.view.frames : widget.capture.numericSource.frames).isSignal(index)) return false;
        return widget.type === 'wave' ? widget.view.getChannelMeta()[index]?.visible === true
            : !widget.settings.monitorDisplay.numericHiddenChannels.includes(index);
    }

    setChannelVisible(index, visible) {
        const widget = this.active;
        if (widget?.type === 'pose') return;
        if (!widget || !(widget.type === 'wave' ? widget.view.frames : widget.capture.numericSource.frames).isSignal(index)) return;
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

    setChannelColor(index, color, capture = this.service) {
        const { channelColors } = this.globalsFor(capture);
        channelColors[index] = color;
        // Keep colors at intervening indices valid for imported/saved arrays.
        for (let i = 0; i < channelColors.length; i++) channelColors[i] ??= this.channelColor(i, channelColors);
        for (const widget of this.widgets.values()) if (widget.capture === capture) {
            if (widget.type === 'wave') {
                widget.view.setChannelColor(index, color); widget.settings[this._channelSettingsKey(widget)] = widget.view.getChannelMeta();
            } else if (widget.type === 'byte') {
                widget.view.channelColors = Array.from({ length: capture.numericSource.frames.channelCount }, (_, i) => this.channelColor(i, channelColors));
                widget.view.invalidateData();
            }
        }
        if (this.active?.capture === capture) this.channelView.setChannelColor(index, color);
        this.onChannelMetadataChange(index, { color }, capture);
        this.onChange();
    }

    validateChannelDefinition(definition, capture = this.service) {
        const local = this.channelGlobals(capture);
        const definitions = local.channelDefinitions.filter(value => value.number !== definition.number).concat(definition);
        return new SerialPlotter.ChannelOperations(Number(local.channelsCount), definitions, { names: local.channelNames, symbolVersion: 2 });
    }

    updateChannelDefinition(definition, { reapply = false } = {}, capture = this.service) {
        const local = this.channelGlobals(capture);
        definition = this.validateChannelDefinition(definition, capture).definitions.find(entry => entry.number === definition.number);
        const definitions = local.channelDefinitions.filter(value => value.number !== definition.number).concat({ ...definition })
            .sort((a, b) => a.number - b.number);
        const ready = capture.updateChannelDefinitions(definitions, {
            rebuild: local.rebuildHistory, reapply: reapply ? [definition.number] : []
        });
        local.channelDefinitions = definitions;
        this._channelsChanged(capture);
        return ready;
    }

    addChannel(type, capture = this.service) {
        const local = this.channelGlobals(capture);
        let number = Number(local.channelsCount);
        for (const definition of local.channelDefinitions) number = Math.max(number, definition.number);
        number++;
        if (number > 65535) throw new Error('通道总数不能超过 65535');
        const definition = { id: `channel-${Date.now()}-${this.channelSequence = (this.channelSequence ?? 0) + 1}`, number, type, expression: type === 'constant' ? '[0]=1' : type === 'system' ? 'X[0]' : 'CH00001' };
        if (type === 'system') definition.initial = '';
        if (this.active?.capture === capture) this.channelView.expanded.add(number);
        this.updateChannelDefinition(definition, {}, capture).catch(error => this._showError(error.message));
        return number;
    }

    removeChannel(number, capture = this.service) {
        const local = this.channelGlobals(capture);
        if (!local.channelDefinitions.some(value => value.number === number)) return;
        const remaining = local.channelDefinitions.filter(value => value.number !== number);
        // Reject references to the deleted channel before shifted IDs can hide them.
        new SerialPlotter.ChannelOperations(Number(local.channelsCount), remaining, { names: local.channelNames, symbolVersion: 2 });
        const oldCount = capture.numericSource.frames.channelCount;
        const numberMap = new Map(Array.from({ length: oldCount }, (_, index) => index + 1)
            .filter(value => value !== number).map(value => [value, value > number ? value - 1 : value]));
        return this._remapChannels(remaining, numberMap, capture);
    }

    moveChannel(from, to, capture = this.service) {
        const local = this.channelGlobals(capture);
        const order = local.channelDefinitions.map(definition => definition.number).sort((a, b) => a - b);
        const first = order.indexOf(from), last = order.indexOf(to);
        if (first < 0 || last < 0) throw new Error('只能调整用户新增通道的顺序，原始数据通道固定');
        if (first === last) return Promise.resolve();
        const positions = [...order];
        order.splice(first, 1); order.splice(last, 0, from);
        const numberMap = new Map(Array.from({ length: capture.numericSource.frames.channelCount }, (_, index) => [index + 1, index + 1]));
        order.forEach((number, index) => numberMap.set(number, positions[index]));
        return this._remapChannels(local.channelDefinitions, numberMap, capture);
    }

    _remapChannels(previousDefinitions, numberMap, capture) {
        const rawCount = Number(this.channelGlobals(capture).channelsCount);
        return this._applyChannelRemap(this._prepareChannelRemap(previousDefinitions, numberMap, rawCount, capture));
    }

    _prepareChannelRemap(previousDefinitions, numberMap, rawCount, capture) {
        const local = this.channelGlobals(capture), oldRegistry = this.getChannelRegistry(capture);
        const definitions = previousDefinitions.map(definition => ({ ...definition, number: numberMap.get(definition.number),
            expression: SerialPlotter.renumberChannelExpression(definition.type === 'formula'
                ? oldRegistry.canonicalizeExpression(definition.expression) : definition.expression, numberMap)
        })).sort((a, b) => a.number - b.number);
        const count = definitions.reduce((max, definition) => Math.max(max, definition.number), rawCount);
        const noSavedColors = [];
        const channelNames = Array.from({ length: count }, (_, index) => SerialPlotter.formatChannelId(index));
        const channelColors = Array.from({ length: count }, (_, index) => this.channelColor(index, noSavedColors));
        const channelRecords = [];
        for (const entry of oldRegistry.toJSON()) {
            if (!numberMap.has(entry.number)) continue;
            const number = numberMap.get(entry.number);
            const name = SerialPlotter.parseChannelId(entry.name) === entry.number
                ? SerialPlotter.formatChannelId(number - 1) : entry.name;
            channelNames[number - 1] = name;
            channelColors[number - 1] = this.channelColor(entry.number - 1, local.channelColors);
            channelRecords.push({ ...entry, number, name });
        }
        const previous = local.channelDefinitions;
        const globals = { ...local, channelsCount: String(rawCount),
            channelDefinitions: definitions, channelNames, channelColors, channelRecords };
        new SerialPlotter.ChannelOperations(rawCount, definitions, { names: channelNames, symbolVersion: 2 });
        return { globals, numberMap, previous, previousRawCount: local.channelsCount, capture };
    }

    commitChannelRemap({ globals, numberMap, previous, previousRawCount, capture = this.service }) {
        const local = this.channelGlobals(capture);
        if (local.channelsCount !== previousRawCount || local.channelDefinitions !== previous)
            throw new Error('通道目录已变化，请重新应用设置');
        this.onBeforeChannelRenumber(numberMap, capture);
        const indices = values => values.filter(index => numberMap.has(index + 1)).map(index => numberMap.get(index + 1) - 1);
        const reorder = values => {
            const result = [];
            values.forEach((value, index) => {
                if (numberMap.has(index + 1)) result[numberMap.get(index + 1) - 1] = value;
            });
            return result;
        };
        const { channelNames, channelColors } = globals;
        Object.assign(local, { channelsCount: globals.channelsCount, channelDefinitions: globals.channelDefinitions,
            channelNames, channelColors, channelRecords: globals.channelRecords });
        for (const widget of this.widgets.values()) if (widget.capture === capture) {
            if (widget.type === 'wave') for (const key of ['channels', 'responseChannels'])
                widget.settings[key] = Array.from(reorder(widget.settings[key]), (channel, index) => ({ visible: false, ...channel,
                    index, name: channelNames[index], color: channelColors[index] }));
            else if (widget.type === 'pose') widget.settings = { ...SerialPlotter.PoseConfig.remapBindings(widget.settings, numberMap), engineSource: widget.settings.engineSource ?? null, connectionSource: widget.settings.connectionSource };
            else widget.settings.monitorDisplay.numericHiddenChannels = indices(widget.settings.monitorDisplay.numericHiddenChannels);
            for (const profile of Object.values(widget.settings.exportSettings?.formats ?? {}))
                if (profile.channelIndices !== null) profile.channelIndices = indices(profile.channelIndices);
        }
        if (this.active?.capture !== capture) return;
        this.channelView.expanded = new Set([...this.channelView.expanded].filter(value => numberMap.has(value)).map(value => numberMap.get(value)));
        this.channelView.drafts = new Map([...this.channelView.drafts].filter(([value]) => numberMap.has(value))
            .map(([value, draft]) => [numberMap.get(value), { ...draft, number: numberMap.get(value),
                expression: SerialPlotter.renumberChannelExpression(draft.expression, numberMap) }]));
    }

    _applyChannelRemap(plan) {
        this.commitChannelRemap(plan);
        const ready = plan.capture.updateChannelDefinitions(plan.globals.channelDefinitions, { rebuild: false, numberMap: plan.numberMap });
        this._channelsChanged(plan.capture);
        return ready.catch(error => this._showError(error.message));
    }

    _channelsChanged(capture) {
        // History replay may still expose the previous frame shape. Bind against the new rules.
        const local = this.channelGlobals(capture);
        capture.channelNames = local.channelNames;
        const originalCount = Number(local.channelsCount);
        const engine = new SerialPlotter.ChannelOperations(originalCount, local.channelDefinitions, { names: local.channelNames, symbolVersion: 2 });
        const isScalar = index => index < originalCount || engine.entries.get(index + 1)?.definition.type === 'formula';
        for (const widget of this.widgets.values()) if (widget.capture === capture) {
            if (widget.type === 'pose') {
                for (const group of [widget.settings.bindings, widget.settings.overlay.bindings]) for (const key of Object.keys(group))
                    group[key] = group[key].map(index => index !== null && !isScalar(index) ? null : index);
                this.applySettings(widget);
            } else if (widget.type === 'wave') this.applySettings(widget);
            else {
                widget.view.channelColors = Array.from({ length: capture.numericSource.frames.channelCount }, (_, index) => this.channelColor(index, local.channelColors));
                widget.view.setDisplayOptions(widget.settings.monitorDisplay);
                widget.view.invalidateData();
            }
        }
        if (this.active?.capture === capture) this.activate(this.activeId);
        this.onRulesChange(); this.onChange();
    }

    setChannelName(index, name, capture = this.service) {
        const local = this.channelGlobals(capture), registry = this.getChannelRegistry(capture);
        name = registry.rename(index + 1, name).name;
        local.channelDefinitions = registry.getDefinitions();
        local.channelNames = registry.getNames(); local.channelRecords = registry.toJSON();
        capture.channelNames = local.channelNames;
        capture.channelDefinitions = local.channelDefinitions;
        for (const source of capture.sources) if (source.kind === 'numeric') {
            source.frames.channelNames = local.channelNames; source.frames.names = local.channelNames;
        }
        for (let i = 0; i < local.channelNames.length; i++) local.channelNames[i] ??= SerialPlotter.formatChannelId(i);
        for (const widget of this.widgets.values()) if (widget.type === 'wave' && widget.capture === capture) {
            widget.view.setChannelName(index, name);
            widget.settings[this._channelSettingsKey(widget)] = widget.view.getChannelMeta();
        }
        if (this.active?.capture === capture) {
            this.displayView.setChannels(this.channelMeta(), { render: false });
            this.channelView.setChannelName(index, name);
            if (this.active.type === 'pose') this.poseConfigView.render(this.active);
        }
        this.onChannelMetadataChange(index, { name }, capture);
        this.onChange();
    }

    syncGlobals() {
        this.element('plot-window-points').value = this.active?.type === 'wave' &&
            this.active.settings.plotContent === 'response' && this.active.settings.plotViewMode === 'time'
            ? this.active.settings.plotResponseTimePoints : this.globals.plotWindowPoints;
        // Numeric controls are an explicit-apply global draft; selecting widgets cannot overwrite it.
    }

    syncByteRecordRule() {
        if (this.active?.type !== 'byte') return;
        const { kind, format } = this.active.source;
        let rule;
        if (kind === 'raw') {
            const limit = format.maxRawFrameBytes + ' B';
            const delimiter = { cr: '\\r', lf: '\\n', crlf: '\\r\\n', lfcr: '\\n\\r' }[format.textBoundary];
            if (delimiter) rule = '按 ' + delimiter + ' 分段 · 上限 ' + limit;
            else {
                const prefix = format.arrayFraming ? '数组帧优先' : format.protocolFraming ? '自定义帧优先'
                    : format.basicIdle ? '仅基本空闲断帧' : '原始记录';
                const timeout = Number((format.idleGapSeconds * 1000).toPrecision(12));
                const finish = timeout ? '空闲 ' + timeout + ' ms 或达到 ' + limit + ' 时收尾' : '达到 ' + limit + ' 时收尾（空闲计时已关闭）';
                const unmatched = format.arrayFraming || format.protocolFraming ? '未匹配字节在' : '在';
                rule = prefix + ' · ' + unmatched + finish;
            }
        } else rule = kind === 'protocol' ? '按当前协议显示解析结果' : '按当前数组规则显示解析结果';
        this.element('monitor-record-rule').textContent = rule;
    }

    updateTextRules(rules) {
        const candidate = { ...this.globals, ...rules };
        SerialPlotter.validateConfig(candidate);
        if (candidate.textEncoding === this.globals.textEncoding && candidate.textBoundary === this.globals.textBoundary) return;
        Object.assign(this.globals, rules);
        for (const widget of this.widgets.values()) if (widget.type === 'byte') {
            Object.assign(widget.settings, rules);
            if (widget.settings.captureMode === 'text') {
                this._bindCapture(widget, widget.capture);
                this._whenReady(widget);
            }
            this.applySettings(widget);
        }
        this.onRulesChange(); this.onChange();
    }

    selectTab(tab) {
        const widget = this.active;
        if (!widget) return;
        const wave = widget.type === 'wave';
        const valid = new Set(widget.type === 'pose' ? ['tab-pose-display', 'tab-pose-channels'] : wave ? ['tab-waveform-config', 'tab-waveform-channels']
            : ['tab-monitor-config', ...(widget.settings.captureMode === 'engine' && ['numeric', 'protocol'].includes(widget.source.kind) ? ['tab-monitor-channels'] : [])]);
        valid.add('tab-widget-export');
        if (!valid.has(tab)) tab = widget.type === 'pose' ? 'tab-pose-display' : wave ? 'tab-waveform-config' : 'tab-monitor-config';
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
        if (widget.type === 'pose') return;
        this.element('plot-response-status').textContent = widget.responseStatus ?? '';
        this.element('plot-response-status').hidden = !widget.responseStatus;
        const response = s.plotContent === 'response', phase = s.plotViewMode === 'phase', db = this._magnitudeUnit(s) === 'db';
        this.element('wrap-response-options').hidden = !response;
        const workspaceSamples = !response && s.connectionSource === 'workspace';
        this.element('plot-workspace-sampling-hint').hidden = !workspaceSamples;
        this.element('plot-recovered-markers-hint').hidden = !workspaceSamples || s.plotViewMode !== 'time';
        this.element('plot-sample-axis-hint').hidden = response || workspaceSamples;
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
        this.element('frame-hex-settings').hidden = s.captureMode !== 'hex';
        this.element('frame-text-boundary-settings').hidden = s.captureMode !== 'text';
        this.element('frame-raw-settings').hidden = s.captureMode !== 'text';
        this.syncByteRecordRule();
        this.element('frame-text-settings').hidden = s.captureMode !== 'text';
        const independent = response && s.plotViewMode === 'time';
        this.element('plot-window-points').max = String(SerialPlotter.Limits.maxPlotWindowPoints);
        const pointsLabel = this.element('plot-window-label');
        pointsLabel.textContent = independent ? '时域采样点数（当前控件）' : '采样点数 ';
        if (!independent) {
            const scope = this.document.createElement('span'); scope.className = 'scope-badge'; scope.textContent = '全局共用';
            pointsLabel.append(scope);
        }
    }

    _commitTitle() {
        const widget = this.active;
        if (!widget || this.binding) return;
        const field = this.element('widget-title'), title = field.value.trim();
        if (!title) { field.value = widget.title; return; }
        if (title === widget.title) return;
        widget.title = title;
        widget.refs[widget.type === 'wave' ? 'waveform-drag-handle' : widget.type === 'pose' ? 'pose-header' : 'monitor-header'].querySelector('span').textContent = title;
        this.element('active-monitor-caption').textContent = title;
        const entry = this.workspace.entries.get(widget.id);
        if (entry) { entry.title = title; entry.handle.setAttribute('aria-label', `${title}: arrow keys move, Shift + arrows resize, Delete removes`); }
        this.onChange();
    }

    _bindInspector() {
        this._listen(this.element('widget-connection-source'), 'change', () => {
            const widget = this.active;
            if (!widget || this.binding) return;
            const id = this.element('widget-connection-source').value, capture = this.captureFor(id);
            if (!capture || widget.capture === capture || id === 'workspace' && widget.type !== 'wave') return;
            try {
                widget.settings = SerialPlotter.WidgetConfig.normalizeWidgetSettings(widget.type,
                    { ...widget.settings, connectionSource: id, engineSource: null }, this.globalsFor(capture));
                this._bindCapture(widget, capture); this.applySettings(widget); this._whenReady(widget);
                this.activate(widget.id); this.onRulesChange(); this.onChange(); this._showError('');
            } catch (error) { this._showError(error.message); }
        });
        this._listen(this.element('widget-engine-source'), 'change', () => {
            if (!this.active || this.binding) return;
            this.active.settings.engineSource = this.element('widget-engine-source').value;
            this.rebindEngineSources(this.active.capture);
        });
        this._listen(this.element('plot-window-points'), 'change', () => {
            try { this.setPlotWindowPoints(this.element('plot-window-points').value); this._showError(''); }
            catch (error) { this._showError(error.message); }
        });
        for (const kind of ['wave', 'byte']) this._listen(this.element(`channel-category-${kind}`), 'change', () => {
            if (!this.active) return;
            this.active.channelCategory = this.element(`channel-category-${kind}`).value;
            this._renderChannels(this.active);
        });
        for (const kind of ['wave', 'byte']) {
            const input = this.element(`channel-search-${kind}`);
            let composing = false;
            const search = () => {
                if (this.channelSearchText === input.value) return;
                this.channelSearchText = input.value;
                if (this.active) this._renderChannels(this.active);
            };
            this._listen(input, 'compositionstart', () => { composing = true; });
            this._listen(input, 'compositionend', () => { composing = false; search(); });
            this._listen(input, 'input', event => { if (!composing && !event.isComposing) search(); });
            this._listen(input, 'change', () => { if (!composing) search(); });
            this._listen(input, 'keydown', event => {
                if (composing || event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return;
                event.preventDefault();
                this.channelView.locateFirst(this.element(kind === 'wave' ? 'channel-config-list' : 'monitor-channel-list'));
            });
        }
        for (const button of this.element('monitor-settings-tabs').querySelectorAll('.tab-btn'))
            this._listen(button, 'click', () => this.selectTab(button.dataset.tab));
        for (const name of ['change', 'blur', 'pointerleave'])
            this._listen(this.element('widget-title'), name, () => this._commitTitle());
        this._listen(this.element('widget-title-tools'), 'pointerleave', () => this._commitTitle());
        this._listen(this.element('widget-delete'), 'click', () => { if (this.active) this.requestRemove(this.activeId); });
        const dialog = this.element('widget-delete-dialog');
        this._listen(this.element('widget-delete-cancel'), 'click', () => this._closeDeleteDialog());
        this._listen(dialog, 'cancel', event => { event.preventDefault(); this._closeDeleteDialog(); });
        this._listen(dialog, 'close', () => { if (!dialog.open) this.pendingDeleteId = null; });
        this._listen(this.element('widget-delete-confirm'), 'click', () => {
            const id = this.pendingDeleteId;
            this._closeDeleteDialog();
            if (id !== null && id !== undefined) this.remove(id);
        });
        for (const [key, id] of Object.entries(this.fieldIds)) this._listen(this.element(id), 'change', () => {
            const widget = this.active;
            if (!widget || widget.type === 'pose' || this.binding) return;
            const field = this.element(id);
            if (key === 'plotTimeXUnit' && field.disabled) return;
            const candidate = { ...widget.settings, [key]: field.type === 'checkbox' ? field.checked : field.value };
            if (key === 'plotTimeXUnit') candidate.plotTimeXUnitExplicit = true;
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
                const next = SerialPlotter.WidgetConfig.normalizeWidgetSettings(widget.type, candidate, this.globalsFor(widget.capture));
                const ruleChanged = widget.type === 'byte' && (key === 'captureMode' || key === 'hexBoundary' && next.captureMode === 'hex');
                widget.settings = next;
                if (key === 'plotPhaseUnit' && widget.pendingViewport)
                    widget.pendingViewport = next[next.plotContent === 'response' ? 'responseViewport' : 'viewport'];
                if (ruleChanged) {
                    this._bindCapture(widget, widget.capture);
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
                widget.settings = SerialPlotter.WidgetConfig.normalizeWidgetSettings('wave', candidate, this.globalsFor(widget.capture));
                this.applySettings(widget); this._syncSections(widget); this.onChange(); this._showError('');
            } catch (error) { this._showError(error.message); }
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
        if (widget.type === 'pose') { this.poseConfigView.render(widget); return; }
        this.channelView.showError(widget, '');
        if (widget.type === 'byte') this.element('channel-filters-byte').hidden = widget.source.kind === 'protocol';
        if (widget.type === 'byte' && widget.source.kind === 'protocol') { this._renderProtocolFields(widget); return; }
        const category = widget.channelCategory ?? 'all', restricted = category !== 'all';
        for (const kind of ['wave', 'byte']) this.element(`channel-search-${kind}`).value = this.channelSearchText;
        this.element(`channel-category-${widget.type}`).value = category;
        if (widget.type === 'wave') this.channelView.render(this.element('channel-config-list'), widget);
        else if (widget.settings.captureMode === 'engine') this.channelView.render(this.element('monitor-channel-list'), widget);
    }

    _renderProtocolFields(widget) {
        const host = this.element('monitor-channel-list'); this.channelView.clear(host);
        const label = this.document.createElement('label'); label.className = 'input-group';
        label.textContent = '显示字段路径（每行一个，空白表示全部；结构路径包含全部子字段，Shift+Enter 换行）';
        const input = this.document.createElement('textarea'); input.rows = 4; input.value = (widget.settings.protocolFieldPaths ?? []).join('\n');
        input.setAttribute('aria-label', '显示结构化字段'); label.append(input);
        const hint = this.document.createElement('p'); hint.className = 'hint-text';
        const paths = new Set();
        for (let index = widget.source.frames.length - 1; index >= Math.max(0, widget.source.frames.length - 16) && paths.size < 80; index--)
            for (const field of widget.source.decodeRecord(index)?.record.flatFields ?? []) { if (paths.size >= 80) break; paths.add(field.path); }
        hint.textContent = paths.size ? `最近记录的字段：${[...paths].join('、')}` : '收到消息后可查看字段路径。未选择数值映射的字段仍可显示和导出。';
        SerialPlotter.bindAutoApply(label, () => {
            const paths = input.value.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
            const next = paths.length ? [...new Set(paths)] : null;
            if (JSON.stringify(next) === JSON.stringify(widget.settings.protocolFieldPaths ?? null)) return;
            widget.settings.protocolFieldPaths = next;
            widget.view.setProtocolOptions({ fieldPaths: widget.settings.protocolFieldPaths }); this.onChange();
        });
        host.append(label, hint);
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
        entries.forEach((entry, index) => {
            const field = target.children[index].children[1];
            if (field.textContent !== entry[1]) field.textContent = entry[1];
        });
    }

    syncData(source, { pendingRaw = false } = {}, capture = this.service) {
        for (const widget of this.widgets.values()) if (widget.capture === capture && (!source || widget.source === source)) {
            if (pendingRaw && (widget.type !== 'byte' || !['hex', 'text'].includes(widget.view?.mode))) continue;
            if (widget.type === 'wave' && widget.settings.plotContent === 'response') continue;
            if (widget.view && widget.view.frames !== widget.source.frames) {
                widget.view.setFrames(widget.source.frames);
                if (widget.type === 'wave' && capture === this.getWorkspaceCapture()) widget.view.setSampleRateHz(widget.source.sampleRate.rate);
                if (widget.type === 'wave' && widget.settings.connectionSource === 'workspace' && widget.settings.plotViewMode === 'time') {
                    const alignment = widget.refs['plot-alignment-status'];
                    alignment.textContent = capture.alignmentLabel; alignment.title = alignment.textContent;
                }
            }
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
            if (widget.type === 'pose') widget.view.setPaused(paused);
            if (!paused) {
                this._cancelViewportRestore(widget); widget.pendingViewport = null;
                widget.view.followLatest?.();
            }
            widget.view.invalidateData();
        }
    }
    appendExtra(record, source, capture = this.service) {
        for (const widget of this.widgets.values()) if (widget.type === 'byte' && widget.capture === capture && (!source || source === widget.source)) {
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
        const count = SerialPlotter.parseIntInRange(value, SerialPlotter.Limits.minPoints,
            SerialPlotter.Limits.maxPlotWindowPoints, '波形监视台内采样点数');
        const capacity = Math.max(count, Number(this.globals.maxPoints));
        SerialPlotter.validateConfig({ plotWindowPoints: count, maxPoints: capacity });
        if (capacity > Number(this.globals.maxPoints)) {
            this.service.setCapacity(capacity);
            for (const { capture } of this.getConnections()) capture.setCapacity(capacity);
            this.getWorkspaceCapture()?.resize(capacity);
            this.globals.maxPoints = String(capacity);
            this.element('max-points').value = String(capacity);
        }
        this.globals.plotWindowPoints = String(count);
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
    _closeDeleteDialog() {
        this.pendingDeleteId = null;
        this.element('widget-delete-dialog').close();
    }
    requestRemove(id) {
        const widget = this.widgets.get(id), dialog = this.element('widget-delete-dialog');
        if (this.disposed || !widget || this.pendingDeleteId != null || dialog.open) return false;
        this.pendingDeleteId = id;
        this.element('widget-delete-message').textContent = `确定删除控件“${widget.title}”吗？`;
        dialog.showModal();
        return true;
    }
    remove(id) {
        const widget = this.widgets.get(id);
        if (!widget) return;
        if (this.pendingDeleteId === id) this._closeDeleteDialog();
        this._cancelViewportRestore(widget);
        for (const cleanup of widget.cleanups ?? []) cleanup();
        widget.disposed = true; widget.visibility?.disconnect(); widget.chromeObserver?.disconnect(); widget.view.dispose(); widget.responseFrames?.dispose();
        widget.capture.releaseSource(widget.source);
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
        this.disposed = true;
        this._closeDeleteDialog();
        this.channelView.dispose();
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        this.displayView.dispose();
        for (const widget of this.widgets.values()) {
            for (const cleanup of widget.cleanups ?? []) cleanup();
            this._cancelViewportRestore(widget);
            widget.disposed = true; widget.visibility?.disconnect(); widget.chromeObserver?.disconnect(); widget.view.dispose(); widget.responseFrames?.dispose(); widget.capture.releaseSource(widget.source);
        }
        this.widgets.clear();
    }
}
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.WidgetController = WidgetController;
if (typeof module !== 'undefined') module.exports = { WidgetController };

/** Display and channel controls for the two scalar analysis widgets. */
(function (root) {
    const S = root.SerialPlotter ??= {};
    const settingsApi = typeof module !== 'undefined' ? require('./analysisSettings').AnalysisSettings : S.AnalysisSettings;
    const bindField = typeof module !== 'undefined' ? require('./autoApply').bindSettingField : S.bindSettingField;
    const ChannelPages = typeof module !== 'undefined' ? require('./channelPages').ChannelPages : S.ChannelPages;
    const { maxAxisSignificantDigits } = typeof module !== 'undefined' ? require('./plotMath') : S;
    const panels = new WeakMap();

    function parseList(text) {
        return text.trim().split(/[\s,，;；]+/u).filter(Boolean).map(token => {
            if (/^-(?:∞|inf(?:inity)?)$/i.test(token)) return '-Infinity';
            if (/^\+?(?:∞|inf(?:inity)?)$/i.test(token)) return 'Infinity';
            return Number(token);
        });
    }
    function displayNumber(value) {
        return value === 'Infinity' ? '+∞' : value === '-Infinity' ? '−∞' : String(value);
    }
    function readNumericInput(input) {
        return input.value.trim() === '' ? NaN : Number(input.value);
    }
    class Inspector {
        constructor(document, display, channels) {
            this.document = document;
            this.display = display;
            this.bindings = channels;
            this.version = 0;
            this.pickers = new Map();
            this.channelState = new Map();
        }
        bind(widget, channels, onUpdate, options) {
            const sameWidget = widget === this.widget;
            if (!sameWidget) { this.resetPickers(); this.pages = new Map(); }
            this.widget = widget;
            this.settings = settingsApi.normalize(widget.type, widget.settings);
            if (!ChannelPages.sameChannels(this.channels, channels)) this.channels = channels;
            this.onUpdate = onUpdate;
            this.options = options;
            this.draw(sameWidget);
        }
        element(tag, className, text) {
            const element = this.document.createElement(tag);
            if (className) element.className = className;
            if (text !== undefined) element.textContent = text;
            return element;
        }
        group(parent, title) {
            const group = this.element('div', 'control-group');
            group.append(this.element('div', 'section-title', title));
            parent.append(group);
            return group;
        }
        checkedAction(parent, action) {
            return (...args) => {
                const pane = this.display.contains(parent) ? this.display : this.bindings;
                if (!pane.contains(parent)) return;
                const error = pane.querySelector('[role="alert"]');
                try {
                    error.hidden = true; error.textContent = '';
                    action(...args);
                } catch (failure) { error.textContent = failure.message; error.hidden = false; }
            };
        }
        field(parent, id, title, type, value, change) {
            const wrap = this.element('div', 'input-group pose-input-group');
            const label = this.element('label', type === 'checkbox' ? 'chk-label' : '', title);
            const options = Array.isArray(type);
            const input = this.element(options ? 'select' : 'input');
            input.id = id; label.setAttribute('for', id);
            if (options) this.fillOptions(input, type);
            else { input.type = type; if (type === 'number') input.step = 'any'; }
            if (type === 'checkbox') {
                label.textContent = ''; label.append(input, this.element('span', '', title)); wrap.append(label);
                input.checked = value;
            } else { input.value = value; wrap.append(label, input); }
            parent.append(wrap);
            if (change) bindField(input, this.checkedAction(wrap, () => {
                const result = type === 'checkbox' ? input.checked : type === 'number'
                    ? readNumericInput(input) : input.value;
                change(result);
            }));
            return input;
        }
        fillOptions(input, options) {
            input.replaceChildren(...options.map(([value, label]) => {
                const option = this.element('option', '', label); option.value = value; return option;
            }));
        }
        button(parent, title, click, id) {
            const button = this.element('button', 'btn btn-secondary', title);
            button.type = 'button'; if (id) button.id = id;
            button.addEventListener('click', this.checkedAction(parent, click));
            parent.append(button);
            return button;
        }
        draw(restoreFocus = true) {
            this.version++;
            const active = this.document.activeElement;
            const focused = restoreFocus && active?.id && (this.display.contains(active) || this.bindings.contains(active));
            const cursor = focused && ['text', 'search'].includes(active.type) ? [active.selectionStart, active.selectionEnd] : null;
            const oldText = focused && active.type === 'text' ? active.value : undefined;
            const openEntry = restoreFocus && [...this.pickers.values()].find(({ picker }) => !picker.popup.hidden);
            this.closePickers();
            for (const parent of [this.display, this.bindings]) {
                const error = this.element('div', 'pose-error'); error.setAttribute('role', 'alert'); error.hidden = true;
                parent.replaceChildren(error);
            }
            const xyDisplay = this.widget.type === 'xy' ? this.group(this.display, '显示内容') : null;
            if (this.options.setWindowPoints) {
                const group = this.group(this.display, '采样窗口');
                const input = this.field(group, this.widget.type + '-window', '采样点数', 'number',
                    this.options.windowPoints, value => this.options.setWindowPoints(value));
                const label = input.parentElement.querySelector('label');
                label.textContent += ' ';
                label.append(this.element('span', 'scope-badge', '全局共用'));
                input.step = '1';
            }
            if (xyDisplay) this.xy(xyDisplay); else this.histogram();
            for (const [id, { wrap, picker }] of this.pickers) {
                if (this.bindings.contains(wrap)) continue;
                this.channelState.set(id, { query: picker.filter.value, page: picker.page });
                picker.dispose();
                this.pickers.delete(id);
            }
            if (openEntry && this.bindings.contains(openEntry.wrap)) openEntry.picker.open();
            if (focused) {
                const target = this.display.querySelector('#' + active.id) ?? this.bindings.querySelector('#' + active.id);
                if (target && !target.disabled) {
                    if (oldText !== undefined) target.value = oldText;
                    target.focus({ preventScroll: true });
                    if (cursor && cursor[0] != null) target.setSelectionRange?.(...cursor);
                }
            }
        }
        update(patch) {
            const settings = settingsApi.normalize(this.widget.type, { ...this.settings, ...patch });
            const version = this.version;
            this.onUpdate(settings);
            if (this.version === version) { this.settings = settings; this.draw(); }
        }
        property(parent, key, title, type) {
            return this.field(parent, this.widget.type + '-' + key, title, type, this.settings[key],
                value => this.update({ [key]: value }));
        }
        waveformSelect(id) {
            const select = this.document.getElementById(id);
            return {
                title: select.parentElement.querySelector('label').textContent.trim(),
                choices: Array.from(select.options, option => [option.value, option.textContent.trim()])
            };
        }
        waveformProperty(parent, key, id) {
            const { title, choices } = this.waveformSelect(id);
            return this.property(parent, key, title, choices);
        }
        axisStrategy(parent, axis, key, mode, change) {
            const { title, choices } = this.waveformSelect('plot-y-scale-mode');
            const axisText = text => axis === 'X' ? text.replace('Y 轴', 'X 轴') : text;
            this.field(parent, this.widget.type + '-' + key, axisText(title),
                choices.map(([value, label]) => [value, axisText(label)]), mode, change);
        }
        axisBounds(parent, axis, key, [min, max], change) {
            const row = this.element('div', 'row');
            parent.append(row);
            const inputs = [['Min', '最小值', min], ['Max', '最大值', max]].map(([edge, label, value]) => {
                const input = this.field(row, this.widget.type + '-' + key + edge, axis + ' 轴' + label,
                    'number', value, () => change(...inputs.map(readNumericInput)));
                input.step = this.document.getElementById('plot-y-min').step;
                return input;
            });
        }
        xyAxisRange(parent, axis, key) {
            const settings = this.settings, autoKey = key + 'Auto';
            this.axisStrategy(parent, axis, autoKey, settings[autoKey] ? 'auto' : 'manual',
                mode => this.update({ [autoKey]: mode === 'auto' }));
            if (!settings[autoKey]) {
                const keys = [key + 'Min', key + 'Max'];
                this.axisBounds(parent, axis, key, keys.map(name => settings[name]),
                    (min, max) => this.update({ [keys[0]]: min, [keys[1]]: max }));
            }
        }
        axisPrecision(parent, axis) {
            this.waveformProperty(parent, axis + 'PrecisionMode', 'plot-' + axis + '-precision-mode');
            const decimal = this.settings[axis + 'PrecisionMode'] === 'decimal';
            const input = this.property(parent, axis + (decimal ? 'DecimalPlaces' : 'SignificantDigits'),
                decimal ? '小数位数' : '有效数字位数', 'number');
            input.min = '0'; input.max = String(maxAxisSignificantDigits); input.step = '1';
            const hint = this.element('span', 'hint-text', decimal ? '科学计数法下设置尾数的小数位数。' : '0 为自动。适用于刻度和悬浮值。');
            hint.id = input.id + '-hint';
            input.setAttribute('aria-describedby', hint.id);
            input.parentElement.append(hint);
            this.waveformProperty(parent, axis + 'NumberNotation', 'plot-' + axis + '-number-notation');
        }
        page(parent, key, length, size, change) {
            const pages = Math.max(1, Math.ceil(length / size));
            const page = Math.max(0, Math.min(this.pages.get(key) ?? 0, pages - 1));
            this.pages.set(key, page);
            if (pages > 1) {
                const choices = Array.from({ length: pages }, (_, i) => [String(i), `第 ${i + 1} / ${pages} 页`]);
                this.field(parent, key + '-page', '轨迹组页码', choices, String(page), value => {
                    this.pages.set(key, Number(value)); change();
                });
            }
            return page * size;
        }
        closePickers() {
            for (const { picker } of this.pickers.values()) picker.close();
        }
        resetPickers() {
            for (const { picker } of this.pickers.values()) picker.dispose();
            this.pickers.clear();
            this.channelState.clear();
        }
        channel(parent, id, title, index, change) {
            let entry = this.pickers.get(id);
            if (entry) parent.append(entry.wrap);
            else {
                const input = this.field(parent, id, title, [], '', value => entry.change(value === '' ? null : Number(value)));
                const picker = new ChannelPages.Single(this.document, input, { filterId: id + '-search', filterLabel: '筛选' + title });
                const state = this.channelState.get(id);
                if (state) { picker.filter.value = state.query; picker.page = state.page; }
                entry = { picker, wrap: input.parentElement };
                this.pickers.set(id, entry);
            }
            entry.change = change;
            if (entry.picker.channels !== this.channels || entry.picker.index !== index) {
                entry.picker.update(this.channels, index, '未绑定');
            }
        }
        xy(display) {
            const trajectory = this.settings.viewMode === 'trajectory';
            this.property(display, 'viewMode', '显示模式', [['trajectory', '李萨如图'],
                ['phase', '相位差频谱图'], ['coherence', '相干度频谱图']]);
            this.waveformProperty(display, 'traceMode', 'plot-trace-mode');
            if (trajectory) {
                this.property(display, 'equalAspect', 'X、Y 轴使用相同单位长度', 'checkbox');
                for (const axis of ['x', 'y']) {
                    const group = this.group(this.display, axis === 'x' ? '横轴设置' : '纵轴设置');
                    this.axisPrecision(group, axis);
                    this.xyAxisRange(group, axis.toUpperCase(), axis);
                }
            } else this.xySpectrum();
            const pairs = this.settings.pairs, size = 4;
            const controls = this.group(this.bindings, 'XY 通道组');
            this.button(controls, '添加通道组', () => {
                this.pages.set('xy-pairs', Math.floor(pairs.length / size)); this.update({ pairs: [...pairs, {}] });
            }, 'xy-add-pair');
            const start = this.page(controls, 'xy-pairs', pairs.length, size, () => this.draw());
            for (let i = start; i < Math.min(start + size, pairs.length); i++) {
                const pair = pairs[i], id = 'xy-' + i + '-', group = this.group(this.bindings, '轨迹 ' + (i + 1));
                const edit = (key, value) => this.update({ pairs: pairs.map((p, j) => j === i ? { ...p, [key]: value } : p) });
                this.channel(group, id + 'x', 'X 通道', pair.x, value => edit('x', value));
                this.channel(group, id + 'y', 'Y 通道', pair.y, value => edit('y', value));
                const actions = this.element('div', 'xy-trace-actions');
                group.append(actions);
                this.field(actions, id + 'color', '颜色', 'color', pair.color, value => edit('color', value));
                this.field(actions, id + 'visible', '显示轨迹', 'checkbox', pair.visible, value => edit('visible', value));
                this.button(actions, '删除此组', () => {
                    this.resetPickers(); this.update({ pairs: pairs.filter((_, j) => i !== j) });
                }, id + 'remove').disabled = pairs.length === 1;
            }
        }
        xySpectrum() {
            const settings = this.settings;
            const xAxis = this.group(this.display, '横轴设置');
            this.axisPrecision(xAxis, 'x');
            this.waveformProperty(xAxis, 'freqXScale', 'plot-freq-x-scale');
            xAxis.append(this.element('p', 'hint-text', '频谱 Hz 按所用数据的采样率换算。对数横轴从 Bin 1 开始。'));

            const yAxis = this.group(this.display, '纵轴设置');
            this.axisPrecision(yAxis, 'y');
            if (settings.viewMode === 'phase') {
                const { title, choices } = this.waveformSelect('plot-phase-unit');
                this.field(yAxis, 'xy-phaseUnit', title, choices, settings.phaseUnit, phaseUnit => {
                        if (phaseUnit === settings.phaseUnit) return;
                        const factor = phaseUnit === 'radians' ? Math.PI / 180 : 180 / Math.PI;
                        this.update({ phaseUnit, phaseYMin: settings.phaseYMin * factor, phaseYMax: settings.phaseYMax * factor });
                    });
                this.property(yAxis, 'phaseUnwrap', '展开相位', 'checkbox');
                yAxis.append(this.element('span', 'hint-text', '取消勾选时折叠至 −180°～180°（−π～π rad）。'));
            }
            this.xyAxisRange(yAxis, 'Y', settings.viewMode + 'Y');

            const fft = this.group(this.display, 'FFT 设置');
            const setOverlap = fftOverlap => {
                if (fftOverlap !== this.settings.fftOverlap) this.update({ fftOverlap });
            };
            const overlap = this.field(fft, 'xy-fftOverlap', '分段重叠率（%）', 'number', settings.fftOverlap, setOverlap);
            overlap.min = '0'; overlap.max = String(settingsApi.maxFftOverlap); overlap.step = '1';
            const slider = this.element('input');
            slider.type = 'range'; slider.id = 'xy-fftOverlap-slider';
            slider.min = overlap.min; slider.max = overlap.max; slider.step = overlap.step; slider.value = overlap.value;
            slider.setAttribute('aria-label', '分段重叠率滑块（%）');
            const field = overlap.parentElement, row = this.element('div', 'fft-overlap-controls');
            row.append(slider, overlap); field.append(row);
            const overlapHint = this.element('p', 'hint-text',
                '重叠率须低于 100%，分段窗口才能向前移动。为控制实时计算开销，本程序上限为 ' + settingsApi.maxFftOverlap + '%。');
            overlapHint.id = 'xy-fftOverlap-hint';
            field.append(overlapHint);
            overlap.setAttribute('aria-describedby', overlapHint.id);
            slider.setAttribute('aria-describedby', overlapHint.id);
            slider.addEventListener('input', () => { overlap.value = slider.value; });
            slider.addEventListener('change', this.checkedAction(field, () => setOverlap(Number(slider.value))));
            overlap.addEventListener('input', () => {
                const value = Number(overlap.value);
                if (overlap.value !== '' && Number.isInteger(value) && value >= 0 && value <= settingsApi.maxFftOverlap)
                    slider.value = overlap.value;
            });
            this.waveformProperty(fft, 'fftWindow', 'plot-fft-window');
            this.property(fft, 'fftRemoveDc', '频域去直流', 'checkbox');
            const size = settingsApi.spectrumSegmentSize(this.options.windowPoints, settings.fftOverlap);
            const segment = this.options.windowPoints ? '每段最多 ' + size + ' 点。' : '';
            fft.append(this.element('p', 'hint-text',
                '每段长度按窗口采样点数和重叠率自动计算。' + segment + '样本不足时自动缩短，至少需凑齐 2 个完整分段。'));
        }
        histogram() {
            const settings = this.settings;
            const binding = this.group(this.bindings, '统计通道');
            this.channel(binding, 'histogram-channel', '输入通道', settings.channel, channel => this.update({ channel }));
            const group = this.group(this.display, '直方图');
            const actions = this.element('div', 'histogram-actions');
            const rowField = (key, label, shortLabel, type) => {
                const input = this.property(actions, key, label, type);
                const caption = input.parentElement.querySelector('label') ?? input.parentElement;
                const text = type === 'checkbox' ? caption.querySelector('span') : caption;
                text.replaceChildren(this.element('span', 'histogram-label-full', label),
                    this.element('span', 'histogram-label-short', shortLabel));
                input.setAttribute('aria-label', label); caption.title = input.title = label;
            };
            rowField('color', '柱形颜色', '颜色', 'color');
            this.axisPrecision(this.group(this.display, '横轴设置'), 'x');
            const yAxis = this.group(this.display, '纵轴设置');
            this.axisPrecision(yAxis, 'y');
            this.property(yAxis, 'scale', '纵轴刻度', [['count', '频数'], ['percent', '百分比（占窗口内全部有限样本）']]);
            this.axisStrategy(yAxis, 'Y', 'yRange', settings.yRange, yRange => this.update({ yRange }));
            if (settings.yRange === 'manual') {
                const bounds = settingsApi.histogramYBounds(settings, this.options.windowPoints);
                this.axisBounds(yAxis, 'Y', 'y', bounds, (min, max) => {
                    this.update(settings.scale === 'percent' ? { yPercentMin: min, yPercentMax: max } :
                        { yCountMin: min, yCountMax: max });
                });
            }
            this.property(group, 'mode', '分组方式', [['fixed', '固定值列表'], ['equal', '等宽区间'], ['edges', '自定义边界']]);
            if (settings.mode === 'fixed') {
                this.field(group, 'histogram-values', '固定值（逗号分隔）', 'text', settings.values.join(', '),
                    value => this.update({ values: parseList(value) }));
                this.property(group, 'match', '匹配规则', [['exact', '精确匹配'], ['nearest', '归入最近指定值']]);
                if (settings.match === 'nearest')
                    this.property(group, 'tieBreak', '等距时取值', [['lower', '取较小值'], ['higher', '取较大值']]);
                group.append(actions);
                return;
            }
            if (settings.mode === 'equal') {
                for (const [key, label] of [['min', '最小边界'], ['max', '最大边界'], ['count', '区间数']]) {
                    const input = this.property(group, key, label, 'number');
                    if (key === 'count') { input.min = 1; input.step = 1; }
                }
            } else {
                this.field(group, 'histogram-edges', '递增边界', 'text',
                    settings.edges.map(displayNumber).join(', '), value => this.update({ edges: parseList(value.replaceAll('−', '-')) }));
            }
            this.property(group, 'closure', '区间开闭', [['leftClosed', '左闭右开 [a, b)'], ['rightClosed', '左开右闭 (a, b]']]);
            if (settings.mode === 'equal' || settings.edges[0] !== '-Infinity')
                rowField('underflow', '统计下溢区间', '下溢', 'checkbox');
            if (settings.mode === 'equal' || settings.edges.at(-1) !== 'Infinity')
                rowField('overflow', '统计上溢区间', '上溢', 'checkbox');
            group.append(actions);
        }
    }
    function render(document, widget, displayPane, channelPane, channels, onUpdate, options = {}) {
        let panel = panels.get(displayPane);
        if (!panel || panel.bindings !== channelPane) {
            if (panel) clear(displayPane);
            panel = new Inspector(document, displayPane, channelPane); panels.set(displayPane, panel);
        }
        panel.bind(widget, channels, onUpdate, options);
    }
    function clear(displayPane) {
        const panel = panels.get(displayPane);
        if (!panel) return;
        panels.delete(displayPane);
        panel.resetPickers();
        panel.display.replaceChildren(); panel.bindings.replaceChildren();
        panel.widget = null; panel.channels = []; panel.onUpdate = null; panel.options = {};
    }
    S.AnalysisInspector = { render, clear, closePickers: displayPane => panels.get(displayPane)?.closePickers() };
    if (typeof module !== 'undefined') module.exports = { AnalysisInspector: S.AnalysisInspector };
})(globalThis);

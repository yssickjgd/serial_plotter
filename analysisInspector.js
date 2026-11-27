/** Display and channel controls for the two scalar analysis widgets. */
(function (root) {
    const S = root.SerialPlotter ??= {};
    const settingsApi = typeof module !== 'undefined' ? require('./analysisSettings').AnalysisSettings : S.AnalysisSettings;
    const bindField = typeof module !== 'undefined' ? require('./autoApply').bindSettingField : S.bindSettingField;
    const ChannelPages = typeof module !== 'undefined' ? require('./channelPages').ChannelPages : S.ChannelPages;
    const { maxAxisSignificantDigits } = typeof module !== 'undefined' ? require('./plotMath') : S;
    const { waveletTimeStrides, waveletMaxFrequencyRows } = typeof module !== 'undefined' ? require('./wavelet') : S;
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
            this.refreshResolution = null;
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
            const content = this.widget.type !== 'histogram' ? this.group(this.display, '显示内容') : null;
            if (this.options.setWindowPoints) {
                const group = this.group(this.display, '采样窗口');
                const input = this.field(group, this.widget.type + '-window', '采样点数', 'number',
                    this.options.windowPoints, value => this.options.setWindowPoints(value));
                const label = input.parentElement.querySelector('label');
                label.textContent += ' ';
                label.append(this.element('span', 'scope-badge', '全局共用'));
                input.step = '1';
            }
            if (this.widget.type === 'xy') this.xy(content);
            else if (this.widget.type === 'wavelet') this.wavelet(content);
            else this.histogram();
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
            this.property(display, 'viewMode', '显示模式', [['trajectory', 'Lissajous 图'], ['gain', '幅度比频谱图'],
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
            if (settings.viewMode === 'gain') {
                const { title, choices } = this.waveformSelect('plot-freq-y-scale');
                const units = { 'amplitude-linear': 'ratio', 'amplitude-log': 'ratio-log', db10: 'db10', db20: 'db' };
                this.property(yAxis, 'gainUnit', title, choices.map(([value, label]) => [units[value], label]));
                yAxis.append(this.element('span', 'hint-text', 'X 为参考输入，Y 为响应输出。参考信号能量过低的频点留空。'));
            } else if (settings.viewMode === 'phase') {
                const { title, choices } = this.waveformSelect('plot-phase-unit');
                this.field(yAxis, 'xy-phaseUnit', title, choices, settings.phaseUnit, phaseUnit => {
                        if (phaseUnit === settings.phaseUnit) return;
                        const factor = phaseUnit === 'radians' ? Math.PI / 180 : 180 / Math.PI;
                        this.update({ phaseUnit, phaseYMin: settings.phaseYMin * factor, phaseYMax: settings.phaseYMax * factor });
                    });
                this.property(yAxis, 'phaseUnwrap', '展开相位', 'checkbox');
                yAxis.append(this.element('span', 'hint-text', '取消勾选时折叠至 −180°～180°（−π～π rad）。'));
            }
            this.xyAxisRange(yAxis, 'Y', settingsApi.spectrumYRangeKey(settings));
            if (settings.viewMode === 'gain' && settings.gainUnit === 'ratio-log') {
                const hint = this.document.getElementById('plot-log-axis-hint').textContent.replace('原幅值', '幅度比');
                yAxis.append(this.element('span', 'hint-text', hint));
            }

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
            const field = overlap.parentElement, row = this.element('div', 'range-number-controls');
            row.append(slider, overlap); field.append(row);
            const overlapHint = this.element('p', 'hint-text',
                '相邻 FFT 窗口复用的样本比例，两路使用相同的分段位置。重叠率须低于 100%，分段窗口才能向前移动。为控制实时计算开销，本程序上限为 ' + settingsApi.maxFftOverlap + '%。');
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
        wavelet(content) {
            const settings = this.settings;
            const basisChoices = settingsApi.waveletBases.map(([key, label]) =>
                [key, label + (settingsApi.waveletCoefficientMode(key) === 'signed' ? '（实数域）' : '（复数域）')]);
            this.property(content, 'basis', '小波基', basisChoices);
            const mode = this.property(content, 'viewMode', '图模式', settingsApi.waveletViews);
            const coefficientMode = settingsApi.waveletCoefficientMode(settings.basis);
            for (const option of mode.options)
                option.disabled = option.value !== 'magnitude' && option.value !== coefficientMode;
            if (coefficientMode === 'signed') {
                const hint = this.element('p', 'hint-text', '有符号系数图中，正值用通道色，负值用互补色，越亮表示绝对值越大。黑白灰通道用白色表示正值、天蓝色表示负值。');
                hint.id = mode.id + '-hint';
                mode.setAttribute('aria-describedby', hint.id);
                content.append(hint);
            }
            this.property(content, 'showEdgeHatching', '显示边缘参考斜纹和高频受限提示带', 'checkbox');
            if (settings.viewMode === 'phase')
                this.property(content, 'phaseUnit', '数值单位', this.waveformSelect('plot-phase-unit').choices);
            const x = this.group(this.display, '横轴设置'), y = this.group(this.display, '纵轴设置');
            this.axisPrecision(x, 'x');
            this.property(x, 'freezeXOnZoom', '缩放冻结横轴', 'checkbox');
            x.append(this.element('p', 'hint-text', '缩放时间范围后，默认随新样点前移。勾选后会停在选中的时间范围。拖动底部滚动条可查看已保留的历史，右键返回实时窗口。'));
            this.axisPrecision(y, 'y');
            const hzScales = this.waveformSelect('plot-freq-x-scale').choices
                .filter(([key]) => key.startsWith('hz-')).map(([key, label]) => [key.slice(3), label]);
            this.property(y, 'frequencyScale', '纵轴刻度', hzScales);
            this.xyAxisRange(y, 'Y', 'y');
            const group = this.group(this.display, '小波设置');
            this.property(group, 'edgeExtension', '时域延拓策略', settingsApi.waveletEdgeExtensions);
            const removeDc = this.property(group, 'removeDc', '频域去直流', 'checkbox');
            const dcHint = this.element('p', 'hint-text', '勾选后，先计算当前分析窗口内有效样点的均值，再从参与变换的样值中减去该均值。');
            dcHint.id = removeDc.id + '-hint';
            removeDc.setAttribute('aria-describedby', dcHint.id);
            group.append(dcHint);
            this.waveletResolution(group);
            const binding = this.group(this.bindings, '小波分析通道');
            this.channel(binding, 'wavelet-channel', '输入通道', settings.channel, channel => this.update({ channel }));
        }
        waveletResolution(group) {
            let previewInput = null;
            const makeSlider = (key, label, numberLabel, validFrom, describe) => {
                const minimum = validFrom - 1;
                const input = this.field(group, 'wavelet-' + key, label, 'range', minimum);
                const field = input.parentElement, row = this.element('div', 'range-number-controls wavelet-resolution-controls');
                const number = this.element('input');
                number.type = 'number'; number.id = input.id + '-number';
                number.min = '0'; number.step = '1';
                number.setAttribute('aria-label', numberLabel); number.title = numberLabel;
                row.append(input, number); field.append(row);
                const output = this.element('output', 'hint-text');
                output.id = input.id + '-value';
                output.setAttribute('for', input.id + ' ' + number.id);
                number.setAttribute('aria-describedby', output.id);
                field.append(output);
                input.min = String(minimum); input.step = '1';
                const show = value => {
                    const text = describe(value);
                    if (output.textContent !== text) {
                        output.textContent = text;
                        input.setAttribute('aria-valuetext', text);
                    }
                };
                const positionSlider = value => {
                    input.value = String(value || minimum);
                    show(value);
                };
                const readSlider = () => Number(input.value) === minimum ? 0 : Number(input.value);
                const valid = value => value === 0 || (Number.isInteger(value) && value >= validFrom &&
                    value <= Number(number.max));
                const commit = value => {
                    previewInput = null;
                    if (!valid(value)) throw new Error(numberLabel + '须为 0（自动）或 ' + validFrom + ' 至 ' + number.max + ' 的整数。');
                    if (key === 'timeColumns' && this.settings.timeStride) this.update({ timeColumns: value, timeStride: 0 });
                    else if (value !== this.settings[key]) this.update({ [key]: value });
                    else this.refreshResolution();
                };
                input.addEventListener('input', () => {
                    previewInput = input;
                    const value = readSlider();
                    number.value = String(value); show(value);
                });
                input.addEventListener('change', this.checkedAction(field, () => commit(readSlider())));
                number.addEventListener('input', () => {
                    previewInput = number;
                    const value = readNumericInput(number);
                    if (valid(value)) positionSlider(value);
                });
                const applyNumber = this.checkedAction(field, () => commit(readNumericInput(number)));
                bindField(number, applyNumber);
                number.addEventListener('blur', () => { if (previewInput === number) applyNumber(); });
                const cancelPreview = () => {
                    if (previewInput !== input) return;
                    previewInput = null;
                    this.refreshResolution?.();
                };
                input.addEventListener('pointercancel', cancelPreview);
                input.addEventListener('blur', cancelPreview);
                return (max, value) => {
                    input.max = String(Math.max(minimum, max));
                    number.max = String(max);
                    number.value = String(value);
                    input.disabled = number.disabled = !max;
                    positionSlider(value);
                };
            };
            let maxRows, maxColumns, snapshot;
            const frequency = makeSlider('frequencyRows', '频率分辨率（尺度 a）', '频率行数', 2,
                rows => {
                    if (!maxRows) return '等待更多样点';
                    const actual = !this.settings.frequencyRows && snapshot?.result.frequencies.length;
                    const mode = rows ? rows + ' 行' : actual ? '自动 · 当前 ' + actual + ' 行' : '自动';
                    return mode + '（最多 ' + maxRows + ' 行）';
                });
            const time = makeSlider('timeColumns', '时间分辨率（平移 b）', '整窗时间列数', 1, columns => {
                const actual = !this.settings.timeColumns && !this.settings.timeStride && snapshot?.result.fullColumns;
                const mode = columns ? '整窗 ' + columns + ' 列' : actual ? '自动 · 当前整窗 ' + actual + ' 列' : '自动';
                const saved = !previewInput && this.settings.timeColumns > maxColumns ? '，已设 ' + this.settings.timeColumns + ' 列' : '';
                return mode + '（最多 ' + maxColumns + ' 列' + saved + '）';
            });
            group.append(this.element('p', 'hint-text', '0 表示自动。时间列数用于整个采样窗口，例如 5000 个样点设为 1200 列，整窗就计算 1200 列。列数等于样点数时逐点计算。'));
            group.append(this.element('p', 'hint-text', '频率行数或时间列数越多，需要处理的系数就越多。分辨率过高时，画面刷新可能变慢或卡顿。实时观察时可先减少频率行数。'));
            this.refreshResolution = () => {
                // Keep thumb positions mapped to the same settings throughout a drag as new samples arrive.
                if (previewInput) return;
                const view = this.widget.view, cwt = view?.wavelet, info = cwt?.resolutionInfo;
                snapshot = cwt?.snapshot?.resolutionKey === cwt?.resolutionKey ? cwt?.snapshot : null;
                maxColumns = info?.count ?? this.options.windowPoints ?? 5000;
                maxRows = waveletMaxFrequencyRows(maxColumns);
                frequency(maxRows, Math.min(maxRows, this.settings.frequencyRows));
                const legacyStep = this.settings.timeStride;
                const legacyColumns = legacyStep ? Math.ceil(maxColumns / Math.min(legacyStep, waveletTimeStrides(maxColumns)[0])) : 0;
                time(maxColumns, Math.min(maxColumns, this.settings.timeColumns || legacyColumns));
            };
            this.refreshResolution();
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
    S.AnalysisInspector = { render, clear, closePickers: displayPane => panels.get(displayPane)?.closePickers(),
        refreshWaveletResolution: (displayPane, widget) => {
            const panel = panels.get(displayPane);
            if (panel?.widget === widget) panel.refreshResolution?.();
        } };
    if (typeof module !== 'undefined') module.exports = { AnalysisInspector: S.AnalysisInspector };
})(globalThis);

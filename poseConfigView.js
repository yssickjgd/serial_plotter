/** One inspector binds to the active pose instance without creating another parser. */
(function (root) {
    const S = root.SerialPlotter;
    const choices = {
        representation: [['euler', 'Euler 角'], ['quaternion', '四元数'], ['matrix', '旋转矩阵']],
        order: ['YPR', 'YRP', 'PYR', 'PRY', 'RYP', 'RPY'].map(v => [v, v]),
        rotation: [['intrinsic', '内旋（机体轴）'], ['extrinsic', '外旋（固定轴）']],
        unit: [['radians', '弧度'], ['degrees', '角度']],
        direction: [['body-to-odom', 'body 相对于 odom'], ['odom-to-body', 'odom 相对于 body']],
        quaternion: [['wxyz', 'wxyz'], ['xyzw', 'xyzw']],
        axes: [['forward', '前'], ['backward', '后'], ['left', '左'], ['right', '右'], ['up', '上'], ['down', '下']]
    };
    const get = (object, path) => path.split('.').reduce((value, key) => value[key], object);
    const set = (object, path, value) => { const keys = path.split('.'), last = keys.pop(); keys.reduce((v, k) => v[k], object)[last] = value; };
    const zDirection = axis => {
        const basis = S.PoseMath.displayBasis(axis), vector = [basis[2], basis[5], basis[8]];
        const index = vector.findIndex(value => value !== 0);
        return [['forward', 'backward'], ['left', 'right'], ['up', 'down']][index][vector[index] > 0 ? 0 : 1];
    };
    class PoseConfigView {
        constructor(document, controller) {
            this.document = document; this.controller = controller; this.fields = new Map(); this.groups = [];
            this.display = document.getElementById('tab-pose-display'); this.channels = document.getElementById('tab-pose-channels');
            this._build();
        }
        _group(parent, title, id, visible = () => true) {
            const group = this.document.createElement('div'); group.className = 'control-group'; if (id) group.id = id;
            const heading = this.document.createElement('div'); heading.className = 'section-title'; heading.textContent = title;
            group.append(heading); parent.append(group); this.groups.push({ group, visible }); return group;
        }
        _field(parent, label, path, options, error, binding = {}) {
            const wrap = this.document.createElement('div'); wrap.className = 'input-group pose-input-group';
            const caption = this.document.createElement('label'); caption.textContent = label;
            const input = this.document.createElement(Array.isArray(options) ? 'select' : 'input');
            input.id = binding.id ?? 'pose-' + path.replaceAll('.', '-'); caption.setAttribute('for', input.id);
            if (Array.isArray(options)) for (const [value, name] of options) {
                const option = this.document.createElement('option'); option.value = value; option.textContent = name; input.append(option);
            }
            else { input.type = options; if (options === 'number') input.step = 'any'; }
            if (options === 'checkbox') {
                caption.className = 'chk-label'; caption.textContent = '';
                const text = this.document.createElement('span'); text.textContent = label;
                caption.append(input, text); wrap.append(caption);
            } else wrap.append(caption, input);
            parent.append(wrap);
            this.fields.set(path, { input, caption, options, binding });
            this.controller._listen(input, 'change', () => {
                const widget = this.controller.active; if (widget?.type !== 'pose' || this.binding) return;
                try {
                    const settings = S.PoseConfig.normalize(widget.settings);
                    const value = options === 'checkbox' ? input.checked : options === 'number' || path.includes('bindings.')
                        ? input.value === '' && path.includes('bindings.') ? null : input.value.trim() === '' ? NaN : Number(input.value) : input.value;
                    if (binding.write) binding.write(settings, value); else set(settings, path, value);
                    widget.settings = S.WidgetConfig.normalizeWidgetSettings('pose', settings, this.controller.globals);
                    this.controller.applySettings(widget); this.render(widget); this.controller.onRulesChange(); this.controller.onChange();
                } catch (failure) { error.textContent = failure.message.includes('有限数') ? '请输入有效的有限数值' : failure.message; error.hidden = false; }
            });
            if (input.tagName === 'SELECT') S.bindSelectWheel(input);
            return input;
        }
        _error(parent, id) {
            const error = this.document.createElement('p'); error.id = id; error.className = 'pose-error'; error.hidden = true;
            parent.append(error); return error;
        }
        _representation(parent, prefix, error, baseVisible) {
            for (const type of ['euler', 'quaternion', 'matrix']) {
                const id = prefix ? 'pose-overlay-' + type : 'pose-input-' + type;
                const title = type === 'euler' ? 'Euler 约定' : type === 'quaternion' ? '四元数约定' : '矩阵约定';
                const group = this._group(parent, (prefix ? '叠加 ' : '') + title, id,
                    s => baseVisible(s) && get(s, prefix + 'representation') === type);
                if (type === 'euler') {
                    this._field(group, '旋转顺序', prefix + 'euler.order', choices.order, error);
                    this._field(group, '旋转轴', prefix + 'euler.rotation', choices.rotation, error);
                    this._field(group, '角度单位', prefix + 'euler.unit', choices.unit, error);
                } else if (type === 'quaternion') {
                    this._field(group, '分量顺序', prefix + 'quaternion.order', choices.quaternion, error);
                    this._field(group, '自动归一化', prefix + 'quaternion.normalize', 'checkbox', error);
                } else this._field(group, '自动单位正交化', prefix + 'matrix.orthonormalize', 'checkbox', error);
            }
        }
        _components(parent, prefix, kind, error, visible) {
            for (const type of ['euler', 'quaternion', 'matrix']) {
                const path = prefix + kind + '.' + type;
                const group = this._group(parent, kind === 'fixed' ? '叠加固定参数' : prefix ? '叠加来源通道' : '姿态来源通道', 'pose-' + path.replaceAll('.', '-'),
                    s => visible(s) && get(s, prefix + 'representation') === type);
                const fields = this.document.createElement('div'); fields.className = type === 'matrix' ? 'pose-matrix-grid' : 'pose-component-grid'; group.append(fields);
                const count = { euler: 3, quaternion: 4, matrix: 9 }[type];
                for (let i = 0; i < count; i++) this._field(fields, '', path + '.' + i, kind === 'fixed' ? 'number' : [], error);
            }
        }
        _overlayComponents() {
            for (const type of ['euler', 'quaternion', 'matrix']) {
                const id = 'pose-overlay-parameters-' + type;
                const group = this._group(this.channels, '叠加参数', id, s => s.overlay.enabled && s.overlay.representation === type);
                const error = this._error(group, id + '-error');
                const count = { euler: 3, quaternion: 4, matrix: 9 }[type];
                for (let i = 0; i < count; i++) {
                    const row = this.document.createElement('div'); row.className = 'pose-overlay-component'; group.append(row);
                    const name = s => S.PoseData.componentLabels({ ...s.overlay, representation: type })[i];
                    this._field(row, '', `overlay.sources.${type}.${i}`, [['fixed', '固定数值'], ['channels', '通道数值']], error, {
                        read: s => S.PoseConfig.componentSource(s.overlay, i, type), caption: s => name(s) + ' 来源'
                    });
                    this._field(row, '', `overlay.fixed.${type}.${i}`, 'number', error, {
                        caption: s => name(s) + ' 固定值',
                        render: (s, input) => { input.parentElement.hidden = S.PoseConfig.componentSource(s.overlay, i, type) !== 'fixed'; }
                    });
                    this._field(row, '', `overlay.bindings.${type}.${i}`, [], error, {
                        caption: s => name(s) + ' 通道',
                        render: (s, input) => { input.parentElement.hidden = S.PoseConfig.componentSource(s.overlay, i, type) !== 'channels'; }
                    });
                }
                group.append(error);
            }
        }
        _build() {
            const input = this._group(this.display, '输入姿态', 'pose-input-settings');
            const inputError = this._error(input, 'pose-input-error');
            this._field(input, '姿态表示', 'representation', choices.representation, inputError);
            this._field(input, '输入方向', 'inputDirection', choices.direction, inputError);
            this._representation(this.display, '', inputError, () => true);
            const body = this._group(this.display, '机体', 'pose-axis-settings'), bodyError = this._error(body, 'pose-cube-error');
            this._field(body, '显示机体模型', 'cubeVisible', 'checkbox', bodyError);
            for (const frame of ['odom', 'body']) {
                const group = this._group(this.display, frame + ' 坐标轴', 'pose-axis-' + frame);
                const axisError = this._error(group, `pose-axes-${frame}-error`);
                this._field(group, '显示坐标轴', `axes.${frame}.visible`, 'checkbox', axisError);
                this._field(group, '显示坐标轴名称', `axes.${frame}.showLabels`, 'checkbox', axisError);
                this._field(group, 'X 正向', `axes.${frame}.x`, choices.axes, axisError);
                this._field(group, 'Y 正向', `axes.${frame}.y`, choices.axes, axisError);
                // Keep the saved handedness field compatible, exposing its equivalent Z direction.
                this._field(group, 'Z 正向', `axes.${frame}.hand`, choices.axes, axisError, {
                    id: `pose-axes-${frame}-z`,
                    read: settings => zDirection(settings.axes[frame]),
                    write: (settings, value) => {
                        const axis = settings.axes[frame];
                        const hand = ['right', 'left'].find(hand => zDirection({ ...axis, hand }) === value);
                        if (!hand) throw new Error('Z 轴必须与 X、Y 轴垂直');
                        axis.hand = hand;
                    },
                    render: (settings, input) => {
                        const allowed = ['right', 'left'].map(hand => zDirection({ ...settings.axes[frame], hand }));
                        for (const option of input.options) option.disabled = !allowed.includes(option.value);
                    }
                });
            }
            const camera = this._group(this.display, '观察视角', 'pose-camera-settings'), cameraError = this._error(camera, 'pose-camera-error');
            const vector = this.document.createElement('div'); vector.className = 'pose-matrix-grid'; camera.append(vector);
            for (let i = 0; i < 3; i++) this._field(vector, 'XYZ'[i], `camera.direction.${i}`, 'number', cameraError);
            const hint = this.document.createElement('p'); hint.className = 'hint-text';
            hint.textContent = '方位向量从机体原点指向观察者，长度不影响图像大小。拖动转动视角，滚轮调整大小；右键恢复视角与最新帧。'; camera.append(hint);
            const overlay = this._group(this.display, '叠加旋转', 'pose-overlay-settings');
            const overlayError = this._error(overlay, 'pose-overlay-error');
            this._field(overlay, '启用叠加旋转', 'overlay.enabled', 'checkbox', overlayError);
            const details = this._group(this.display, '叠加方式', 'pose-overlay-details', s => s.overlay.enabled);
            this._field(details, '姿态表示', 'overlay.representation', choices.representation, overlayError);
            this._field(details, '旋转顺序', 'overlay.order', [['input-first', '先输入、后叠加（A × R）'], ['overlay-first', '先叠加、后输入（R × A）']], overlayError);
            this._representation(this.display, 'overlay.', overlayError, s => s.overlay.enabled);
            const channelError = this._error(this.channels, 'pose-channel-error');
            this._components(this.channels, '', 'bindings', channelError, () => true);
            this._overlayComponents();
        }
        render(widget) {
            if (widget?.type !== 'pose') return;
            this.binding = true; const s = widget.settings;
            const channels = this.controller.channelMeta().filter(channel => channel.signal);
            for (const { group, visible } of this.groups) group.hidden = !visible(s);
            for (const [path, { input, caption, options, binding }] of this.fields) {
                const channelBinding = path.includes('bindings.');
                if (channelBinding) {
                    const values = [['', '请选择通道'], ...channels.map(channel => [String(channel.index), `${S.formatChannelId(channel.index)} ${channel.name}`])];
                    input.replaceChildren(...values.map(([value, text]) => { const option = this.document.createElement('option'); option.value = value; option.textContent = text; return option; }));
                }
                if (binding.caption) caption.textContent = binding.caption(s);
                else if (channelBinding || path.includes('fixed.')) {
                    const source = path.startsWith('overlay.') ? s.overlay : s;
                    caption.textContent = S.PoseData.componentLabels({ ...source, representation: path.split('.').at(-2) })[Number(path.split('.').at(-1))];
                }
                binding.render?.(s, input);
                const value = binding.read ? binding.read(s) : get(s, path);
                if (options === 'checkbox') input.checked = value; else input.value = value === null ? '' : String(value);
            }
            for (const parent of [this.display, this.channels]) for (const error of parent.querySelectorAll('.pose-error')) { error.textContent = ''; error.hidden = true; }
            this.binding = false;
        }
    }
    S.PoseConfigView = PoseConfigView;
    if (typeof module !== 'undefined') module.exports = { PoseConfigView };
})(globalThis);

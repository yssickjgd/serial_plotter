/** One inspector binds to the active pose instance without creating another parser. */
(function (root) {
    const S = root.SerialPlotter;
    const choices = {
        representation: [['euler', 'Euler 角'], ['quaternion', '四元数'], ['matrix', '旋转矩阵']],
        order: ['YPR', 'YRP', 'PYR', 'PRY', 'RYP', 'RPY'].map(v => [v, v]),
        rotation: [['intrinsic', '内旋（机体轴）'], ['extrinsic', '外旋（固定轴）']],
        unit: [['radians', '弧度'], ['degrees', '角度']],
        direction: [['body-to-odom', 'body → odom'], ['odom-to-body', 'odom → body']],
        quaternion: [['wxyz', 'wxyz'], ['xyzw', 'xyzw']],
        axes: [['forward', '前'], ['backward', '后'], ['left', '左'], ['right', '右'], ['up', '上'], ['down', '下']]
    };
    const get = (object, path) => path.split('.').reduce((value, key) => value[key], object);
    const set = (object, path, value) => { const keys = path.split('.'), last = keys.pop(); keys.reduce((v, k) => v[k], object)[last] = value; };
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
        _field(parent, label, path, options, error) {
            const wrap = this.document.createElement('div'); wrap.className = 'input-group pose-input-group';
            const caption = this.document.createElement('label'); caption.textContent = label;
            const input = this.document.createElement(Array.isArray(options) ? 'select' : 'input');
            input.id = 'pose-' + path.replaceAll('.', '-'); caption.setAttribute('for', input.id);
            if (Array.isArray(options)) for (const [value, name] of options) {
                const option = this.document.createElement('option'); option.value = value; option.textContent = name; input.append(option);
            }
            else { input.type = options; if (options === 'number') input.step = 'any'; }
            wrap.append(caption, input); parent.append(wrap);
            this.fields.set(path, { input, caption, options });
            this.controller._listen(input, 'change', () => {
                const widget = this.controller.active; if (widget?.type !== 'pose' || this.binding) return;
                try {
                    const settings = S.PoseConfig.normalize(widget.settings);
                    const value = options === 'checkbox' ? input.checked : options === 'number' || path.includes('bindings.')
                        ? input.value === '' && path.includes('bindings.') ? null : input.value.trim() === '' ? NaN : Number(input.value) : input.value;
                    set(settings, path, value);
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
                const group = this._group(parent, type === 'euler' ? 'Euler 约定' : type === 'quaternion' ? '四元数约定' : '矩阵约定', id,
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
                const group = this._group(parent, kind === 'fixed' ? '固定参数' : prefix ? '叠加来源通道' : '姿态来源通道', 'pose-' + path.replaceAll('.', '-'),
                    s => visible(s) && get(s, prefix + 'representation') === type);
                const fields = this.document.createElement('div'); fields.className = type === 'matrix' ? 'pose-matrix-grid' : 'pose-component-grid'; group.append(fields);
                const count = { euler: 3, quaternion: 4, matrix: 9 }[type];
                for (let i = 0; i < count; i++) this._field(fields, '', path + '.' + i, kind === 'fixed' ? 'number' : [], error);
            }
        }
        _build() {
            const input = this._group(this.display, '输入姿态', 'pose-input-settings');
            const inputError = this._error(input, 'pose-input-error');
            this._field(input, '姿态表示', 'representation', choices.representation, inputError);
            this._field(input, '输入方向', 'inputDirection', choices.direction, inputError);
            this._representation(input, '', inputError, () => true);
            const overlay = this._group(this.display, '叠加旋转', 'pose-overlay-settings');
            const overlayError = this._error(overlay, 'pose-overlay-error');
            this._field(overlay, '启用叠加旋转', 'overlay.enabled', 'checkbox', overlayError);
            const details = this._group(overlay, '叠加方式', 'pose-overlay-details', s => s.overlay.enabled);
            this._field(details, '姿态表示', 'overlay.representation', choices.representation, overlayError);
            this._field(details, '数值来源', 'overlay.source', [['fixed', '固定参数'], ['channels', '通道来源']], overlayError);
            this._field(details, '旋转顺序', 'overlay.order', [['input-first', '先输入、后叠加（A × R）'], ['overlay-first', '先叠加、后输入（R × A）']], overlayError);
            this._representation(details, 'overlay.', overlayError, s => s.overlay.enabled);
            this._components(details, 'overlay.', 'fixed', overlayError, s => s.overlay.enabled && s.overlay.source === 'fixed');
            const axes = this._group(this.display, '坐标轴与机体', 'pose-axis-settings'), axisError = this._error(axes, 'pose-axes-error');
            this._field(axes, '显示机体立方体', 'cubeVisible', 'checkbox', axisError);
            for (const frame of ['odom', 'body']) {
                const group = this._group(axes, frame + ' 坐标轴', 'pose-axis-' + frame);
                this._field(group, '显示坐标轴', `axes.${frame}.visible`, 'checkbox', axisError);
                this._field(group, 'X 正向', `axes.${frame}.x`, choices.axes, axisError);
                this._field(group, 'Y 正向', `axes.${frame}.y`, choices.axes, axisError);
                this._field(group, '手系', `axes.${frame}.hand`, [['right', '右手系'], ['left', '左手系']], axisError);
                const z = this.document.createElement('p'); z.id = 'pose-axis-' + frame + '-z'; z.className = 'hint-text'; group.append(z);
            }
            const camera = this._group(this.display, '观察视角', 'pose-camera-settings'), cameraError = this._error(camera, 'pose-camera-error');
            this._field(camera, '方位角（rad）', 'camera.azimuth', 'number', cameraError);
            this._field(camera, '仰角（rad）', 'camera.elevation', 'number', cameraError);
            this._field(camera, '观察倍率', 'camera.scale', 'number', cameraError);
            const hint = this.document.createElement('p'); hint.className = 'hint-text';
            hint.textContent = '内容区拖动转动视角，滚轮调整倍率；右键恢复视角与最新帧。'; camera.append(hint);
            const channelError = this._error(this.channels, 'pose-channel-error');
            this._components(this.channels, '', 'bindings', channelError, () => true);
            this._components(this.channels, 'overlay.', 'bindings', channelError, s => s.overlay.enabled && s.overlay.source === 'channels');
        }
        render(widget) {
            if (widget?.type !== 'pose') return;
            this.binding = true; const s = widget.settings;
            const channels = this.controller.channelMeta().filter(channel => channel.signal);
            for (const { group, visible } of this.groups) group.hidden = !visible(s);
            for (const [path, { input, caption, options }] of this.fields) {
                const binding = path.includes('bindings.');
                if (binding) {
                    const values = [['', '请选择通道'], ...channels.map(channel => [String(channel.index), `${S.formatChannelId(channel.index)} ${channel.name}`])];
                    input.replaceChildren(...values.map(([value, text]) => { const option = this.document.createElement('option'); option.value = value; option.textContent = text; return option; }));
                }
                if (binding || path.includes('fixed.')) {
                    const source = path.startsWith('overlay.') ? s.overlay : s;
                    caption.textContent = S.PoseData.componentLabels({ ...source, representation: path.split('.').at(-2) })[Number(path.split('.').at(-1))];
                }
                const value = get(s, path); if (options === 'checkbox') input.checked = value; else input.value = value === null ? '' : String(value);
            }
            for (const frame of ['odom', 'body']) {
                const basis = S.PoseMath.displayBasis(s.axes[frame]), v = [basis[2], basis[5], basis[8]];
                const index = v.findIndex(value => value !== 0), name = [['前', '后'], ['左', '右'], ['上', '下']][index][v[index] > 0 ? 0 : 1];
                this.document.getElementById('pose-axis-' + frame + '-z').textContent = 'Z 正向：' + name + '（由 X、Y 和手系确定）';
            }
            for (const parent of [this.display, this.channels]) for (const error of parent.querySelectorAll('.pose-error')) { error.textContent = ''; error.hidden = true; }
            this.binding = false;
        }
    }
    S.PoseConfigView = PoseConfigView;
    if (typeof module !== 'undefined') module.exports = { PoseConfigView };
})(globalThis);

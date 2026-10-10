/** One channel editor for waveform and numeric record widgets. */
class ChannelConfigView {
    constructor(document, controller) {
        this.document = document; this.controller = controller; this.expanded = new Set(); this.drafts = new Map(); this.listeners = new Map();
    }
    clear(list) {
        for (const cleanup of this.listeners.get(list) ?? []) cleanup();
        this.listeners.delete(list); list.replaceChildren();
    }
    dispose() {
        for (const list of [...this.listeners.keys()]) this.clear(list);
        this.expanded.clear(); this.drafts.clear();
    }
    render(list, widget) {
        this.clear(list);
        const help = this.document.getElementById(`channel-help-${widget.type}`);
        if (help) {
            const explanations = [
                ['原始数据', '设备解析出的数值通道。'],
                ['运算通道', '由公式生成，支持加减乘除、diff、int 和 filter。'],
                ['常量数组', '固定数组，可作为 filter 的卷积核。'],
                ['差分方程系统', '可复用的系统方程，支持配置初始状态。']
            ];
            help.replaceChildren(...explanations.map(([title, text]) => {
                const line = this.document.createElement('p'), label = this.document.createElement('strong');
                label.textContent = `${title}：`;
                const description = this.document.createElement('span'); description.textContent = text;
                line.append(label, description); return line;
            }));
        }
        const cleanups = []; this.listeners.set(list, cleanups);
        let draggedNumber = null;
        const listen = (node, event, callback) => {
            node.addEventListener(event, callback); cleanups.push(() => node.removeEventListener(event, callback));
        };
        const document = this.document, controller = this.controller;
        const rows = controller.channelMeta().filter(channel => !widget.channelCategory || widget.channelCategory === 'all' ||
            (channel.definition?.type ?? 'raw') === widget.channelCategory).map(channel => {
            const { index, number, definition } = channel;
            const row = document.createElement('div'); row.className = 'channel-config-row channel-config-main';
            row.dataset.channelNumber = String(number);
            const toggle = document.createElement(definition ? 'button' : 'span');
            toggle.className = definition ? 'channel-toggle' : 'channel-label';
            if (definition) {
                toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(this.expanded.has(number)));
            }
            const color = document.createElement('input'); color.type = 'color'; color.value = channel.color;
            color.title = '通道颜色由所有控件共用';
            const name = document.createElement('input'); name.type = 'text'; name.value = channel.name;
            name.title = '通道名称由所有控件共用';
            const visible = document.createElement('input'); visible.type = 'checkbox';
            visible.checked = controller.channelVisible(widget, index); visible.disabled = !channel.signal;
            visible.title = channel.signal ? '只修改当前控件的可见性' : widget.type === 'wave'
                ? '请在显示方式中选择对应的采样波形或系统响应' : '常量和系统不是逐帧采样数值';
            const details = document.createElement('div'); details.className = 'channel-definition';
            details.hidden = !this.expanded.has(number);
            const error = document.createElement('div'); error.className = 'channel-definition-error';
            error.setAttribute('data-role', 'channel-error'); error.setAttribute('role', 'status'); error.hidden = true;
            const showError = message => { error.textContent = message; error.hidden = !message; };
            if (definition) {
                toggle.draggable = true;
                toggle.title = '拖动 CH 编号调整通道顺序；单击展开配置';
                const clearDrag = () => {
                    draggedNumber = null;
                    for (const row of list.children) row.classList.remove('channel-drop-target', 'channel-dragging');
                };
                listen(toggle, 'dragstart', event => {
                    draggedNumber = number; row.classList.add('channel-dragging');
                    event.stopPropagation();
                    if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('application/x-serial-plotter-channel', String(number));
                    }
                });
                listen(toggle, 'dragend', clearDrag);
                listen(row, 'dragover', event => {
                    if (draggedNumber === null || draggedNumber === number) return;
                    event.preventDefault(); event.stopPropagation();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                    row.classList.add('channel-drop-target');
                });
                listen(row, 'dragleave', event => {
                    if (!row.contains(event.relatedTarget)) row.classList.remove('channel-drop-target');
                });
                listen(row, 'drop', event => {
                    if (draggedNumber === null) return;
                    event.preventDefault(); event.stopPropagation();
                    const from = draggedNumber; clearDrag();
                    try { controller.moveChannel(from, number).catch(error => showError(error.message)); }
                    catch (error) { showError(error.message); }
                });
                cleanups.push(clearDrag);
            }
            const caption = () => {
                toggle.textContent = SerialPlotter.formatChannelId(index) + (definition ? ` ${details.hidden ? '▸' : '▾'}` : '');
                toggle.style.color = visible.checked ? '' : '#999';
            };
            if (definition) listen(toggle, 'click', () => {
                details.hidden = !details.hidden;
                if (details.hidden) this.expanded.delete(number); else this.expanded.add(number);
                toggle.setAttribute('aria-expanded', String(!details.hidden)); caption();
            });
            listen(color, 'input', () => controller.setChannelColor(index, color.value));
            listen(name, 'change', () => controller.setChannelName(index, name.value));
            listen(visible, 'change', () => { controller.setChannelVisible(index, visible.checked); caption(); });
            if (definition) {
                const draft = this.drafts.get(number) ?? definition;
                const expression = document.createElement('textarea'); expression.rows = 2; expression.spellcheck = false;
                expression.value = draft.expression; expression.setAttribute('data-role', 'channel-expression');
                expression.ariaLabel = definition.type === 'formula' ? '通道公式' : definition.type === 'constant' ? '常量数组' : '差分方程';
                expression.placeholder = definition.type === 'formula' ? 'CH01+CH02 或 filter(CH01,CH03)' :
                    definition.type === 'constant' ? '[0]=1,[1]=-2.3' : 'y[n]=x[n]+0.5*y[n-1]';
                const label = document.createElement('label'); label.textContent = expression.ariaLabel; label.append(expression);
                details.append(label);
                let initial;
                if (definition.type === 'system') {
                    initial = document.createElement('textarea'); initial.rows = 2; initial.value = draft.initial ?? '';
                    initial.setAttribute('data-role', 'channel-initial'); initial.placeholder = 'y[-1]=0；有输入延迟时也填写 x[-1]=0';
                    initial.spellcheck = false;
                    const initialLabel = document.createElement('label'); initialLabel.textContent = '初始状态'; initialLabel.append(initial);
                    details.append(initialLabel);
                }
                const update = apply => {
                    const candidate = { ...definition, expression: expression.value };
                    if (initial) candidate.initial = initial.value;
                    this.drafts.set(number, candidate);
                    try {
                        controller.validateChannelDefinition(candidate); showError('');
                        if (apply) {
                            this.drafts.delete(number);
                            const pending = controller.updateChannelDefinition(candidate, { reapply: true });
                            pending.catch(error => showError(error.message));
                        }
                    } catch (error) { this.drafts.set(number, candidate); showError(error.message); }
                };
                for (const input of [expression, initial].filter(Boolean)) {
                    listen(input, 'input', () => update(false)); listen(input, 'change', () => update(false));
                }
                const actions = document.createElement('div'); actions.className = 'channel-definition-actions';
                const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'btn btn-primary';
                apply.textContent = '应用公式'; apply.setAttribute('data-role', 'channel-apply');
                apply.title = '勾选“重建历史数据”时更新历史波形；未勾选时仅影响后续采样';
                listen(apply, 'click', () => update(true));
                const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-danger channel-delete'; remove.textContent = '删除通道';
                listen(remove, 'click', () => {
                    try { controller.removeChannel(number); }
                    catch (error) { showError(error.message); }
                });
                actions.append(apply, remove); details.append(actions);
                if (this.drafts.has(number)) update(false);
            }
            caption(); row.append(toggle, color, name, visible);
            if (definition) row.append(details, error);
            return row;
        });
        list.replaceChildren(...rows);
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.ChannelConfigView = ChannelConfigView;
if (typeof module !== 'undefined') module.exports = { ChannelConfigView };

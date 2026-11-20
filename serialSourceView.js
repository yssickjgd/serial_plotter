/** Serial connection rows share the communication panel's controls and spacing. */
class SerialSourceView {
    constructor(root, { onConnect, onRemove, onEdit }) {
        this.root = root;
        this.onConnect = onConnect;
        this.onRemove = onRemove;
        this.onEdit = onEdit;
        this.rows = new Map();
    }

    add(source) {
        const { id } = source.settings, document = this.root.ownerDocument;
        const section = document.createElement('section');
        section.className = 'control-group';
        const buttons = document.createElement('div');
        buttons.className = 'row';
        const button = (key, label, action) => {
            const node = document.createElement('button');
            node.id = id + '-' + key; node.type = 'button'; node.className = 'btn btn-secondary';
            node.textContent = label; node.addEventListener('click', () => action(source));
            buttons.append(node); return node;
        };
        const connect = button('connect', '连接', this.onConnect), remove = button('remove', '删除', this.onRemove);
        section.append(buttons);
        const field = (key, title, options) => {
            const row = document.createElement('div'), label = document.createElement('label');
            const node = document.createElement(options ? 'select' : 'input');
            row.className = 'input-group'; node.id = id + '-' + key; label.htmlFor = node.id;
            label.textContent = title;
            if (options) for (const [value, label] of options) {
                const option = document.createElement('option'); option.value = value;
                option.textContent = label; node.append(option);
            }
            if (key === 'baudRate') node.inputMode = 'numeric';
            if (key === 'timeOffsetMs') { node.type = 'number'; node.step = '1'; }
            if (key === 'name') node.maxLength = 80;
            node.addEventListener('change', () => this.onEdit(source, key, node.value));
            row.append(label, node); return { row, node };
        };
        const name = field('name', '串口名称'), baud = field('baudRate', '波特率');
        section.append(name.row, baud.row);
        const serialBits = document.createElement('div');
        serialBits.className = 'row';
        const data = field('dataBits', '数据位', [['8', '8'], ['7', '7']]);
        const stop = field('stopBits', '停止位', [['1', '1'], ['2', '2']]);
        serialBits.append(data.row, stop.row); section.append(serialBits);
        const parity = field('parity', '奇偶校验', [['none', '无 (None)'], ['even', '偶校验 (Even)'], ['odd', '奇校验 (Odd)']]);
        section.append(parity.row);
        const offset = field('timeOffsetMs', '接收时间对齐偏移（ms）');
        offset.node.title = '近似对齐。以主连接为参考，正值后移，负值前移。';
        section.append(offset.row);
        const status = document.createElement('span');
        status.id = id + '-status'; status.className = 'hint-text'; status.setAttribute('role', 'status');
        section.append(status); this.root.append(section); this.root.hidden = false;
        this.rows.set(id, { section, connect, remove, status,
            inputs: { name: name.node, baudRate: baud.node, dataBits: data.node, stopBits: stop.node, parity: parity.node, timeOffsetMs: offset.node } });
        this.apply(source); this.refresh(source);
    }

    apply(source) {
        const row = this.rows.get(source.settings.id);
        for (const [key, node] of Object.entries(row.inputs)) node.value = String(source.settings[key]);
    }

    refresh(source) {
        const row = this.rows.get(source.settings.id);
        if (!row) return;
        const { connected, pending, capture, error } = source;
        row.connect.textContent = connected ? '断开连接' : '连接';
        row.connect.disabled = pending; row.remove.disabled = connected || pending;
        for (const [key, node] of Object.entries(row.inputs)) if (!['name', 'timeOffsetMs'].includes(key)) node.disabled = connected || pending;
        const state = pending ? '处理中…' : connected ? '已连接' : '已断开';
        const output = capture.dataEngine?.mode === 'Self_Defined_Frame' ? capture.dataEngine.recordsSource : capture.numericSource;
        const parsed = capture.dataEngine?.mode === 'Raw_Data' ? '' : ' · 解析 ' + output.parser.frameCount.toLocaleString() +
            ' 帧 / 错误 ' + output.parser.failCount.toLocaleString();
        const current = state + ' · RX ' + capture.stats.rxBytes.toLocaleString() + ' B · TX ' + capture.stats.txBytes.toLocaleString() +
            ' B · 保留 ' + capture.baseSource.frames.length.toLocaleString() + ' 条记录' + parsed + (error ? ' · ' + error : '');
        if (row.status.textContent !== current) row.status.textContent = current;
    }

    remove(id) {
        this.rows.get(id)?.section.remove(); this.rows.delete(id);
        this.root.hidden = this.rows.size === 0;
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.SerialSourceView = SerialSourceView;

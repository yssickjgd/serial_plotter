/** Inline command identity, nested drag ordering, and expandable command payloads. */
class CommandSendView {
    constructor({ library, runner, tree, addButton, groupButton, stopButton, status, error, onChange = () => {} }) {
        Object.assign(this, { library, runner, tree, addButton, groupButton, stopButton, status, error, onChange });
        this.document = tree.ownerDocument;
        this.selectedId = null; this.busy = false; this.disposed = false; this.listeners = [];
        this.dragId = null; this.dragIds = new Set(); this.dropInfo = null;
        this.listen(addButton, 'click', () => this.add('command'));
        this.listen(groupButton, 'click', () => this.add('group'));
        this.listen(stopButton, 'click', () => runner.stop());
        this.listen(this.document, 'keydown', event => { if (event.key === 'Escape') this.clearDrag(); });
        this.listen(tree, 'dragover', event => {
            if (!this.dragId || this.busy || event.target !== tree && !this.rootDrop?.contains(event.target)) return;
            event.preventDefault(); this.markDrop(null, null, 'root');
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        });
        this.listen(tree, 'drop', event => {
            if (!this.dragId || this.busy || event.target !== tree && !this.rootDrop?.contains(event.target)) return;
            event.preventDefault();
            const id = this.dragId; this.clearDrag(); this.mutate(() => this.library.move(id));
        });
        this.render();
    }
    listen(node, event, callback) {
        node.addEventListener(event, callback);
        this.listeners.push(() => node.removeEventListener(event, callback));
    }
    element(tag, className, text) {
        const node = this.document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    button(text, action, className = '') {
        const node = this.element('button', `command-button ${className}`, text);
        node.type = 'button'; node.addEventListener('click', action); return node;
    }
    showError(error) {
        if (this.disposed) return;
        this.error.textContent = error.message ?? String(error); this.error.hidden = false;
    }
    mutate(action, rerender = true) {
        if (this.disposed || this.busy) return false;
        try {
            action(); this.error.hidden = true;
            if (rerender) this.render();
            this.onChange(); return true;
        } catch (error) { this.showError(error); return false; }
    }
    focusName(id) {
        const item = this.tree.querySelector(`[data-command-id="${id}"]`);
        item?.scrollIntoView?.({ block: 'nearest' });
        const name = item?.querySelector('.command-name'); name?.focus?.(); name?.select?.();
    }
    add(type, parentId = null) {
        if (this.mutate(() => { this.selectedId = this.library.add(type, parentId); })) this.focusName(this.selectedId);
        return this.selectedId;
    }
    setState(state) {
        if (this.disposed) return;
        this.busy = state.running; this.currentId = state.currentId; this.status.textContent = state.message;
        if (state.running) { this.error.hidden = true; this.clearDrag(); }
        this.stopButton.disabled = !state.running;
        this.addButton.disabled = this.groupButton.disabled = state.running;
        this.syncBusy();
    }
    syncBusy() {
        for (const node of this.tree.querySelectorAll('input, select, textarea, button'))
            node.disabled = this.busy && node.dataset.toggle !== 'true' || node.dataset.unavailable === 'true';
        for (const node of this.tree.querySelectorAll('.command-drag-handle')) node.draggable = !this.busy;
        for (const node of this.tree.querySelectorAll('[data-command-id]'))
            node.classList.toggle('command-sending', this.busy && node.dataset.commandId === this.currentId);
    }
    field(parent, title, field, value, type, id) {
        const label = this.element('label', 'command-field');
        label.appendChild(this.element('span', 'command-field-title', title));
        const input = this.element(type === 'textarea' ? 'textarea' : 'input');
        if (type !== 'textarea') input.type = type;
        else { input.rows = 2; input.spellcheck = false; }
        input.value = value; input.setAttribute('data-field', field); input.setAttribute('aria-label', title);
        const apply = () => {
            const next = type === 'number' ? Number(input.value) : input.value;
            const valid = input.value.trim() !== '' || type !== 'number';
            const saved = valid && this.mutate(() => this.library.update(id, { [field]: next }), false);
            input.setAttribute('aria-invalid', String(!saved));
            if (!valid) this.showError(new Error(`${title}不能为空`));
            if (saved) { this.refreshRow(id); if (field === 'name') this.refreshParentLabels(); }
        };
        input.addEventListener(type === 'textarea' ? 'input' : 'change', apply);
        if (field === 'name') {
            input.maxLength = 120;
            input.addEventListener('keydown', event => {
                if (event.isComposing) return;
                if (event.key === 'Enter') { event.preventDefault(); apply(); input.blur?.(); }
                if (event.key === 'Escape') { input.value = this.library.find(id)?.name ?? value; input.blur?.(); }
            });
        }
        label.appendChild(input); parent.appendChild(label); return input;
    }
    select(parent, title, field, options, value, onChange) {
        const label = this.element('label', 'command-field'), select = this.element('select');
        label.appendChild(this.element('span', 'command-field-title', title));
        select.setAttribute('data-field', field); select.setAttribute('aria-label', title);
        this.fillOptions(select, options, value);
        select.addEventListener('change', () => onChange(select.value));
        label.appendChild(select); parent.appendChild(label);
        globalThis.SerialPlotter.bindSelectWheel?.(select); return select;
    }
    fillOptions(select, options, value) {
        select.replaceChildren();
        for (const [key, text] of options) { const option = this.element('option', '', text); option.value = key; option.title = text; select.appendChild(option); }
        select.value = value;
        select.title = Array.from(select.options).find(option => option.value === value)?.title ?? '';
    }
    parentSelect(row, node, location) {
        const parent = location.parent;
        const select = this.select(row, '所属组', 'parent', [['', '顶层'], ...(parent ? [[parent.id, location.parentPath]] : [])], parent?.id ?? '',
            value => this.mutate(() => this.library.move(node.id, value || null)));
        select.parentElement.classList.add('command-parent');
        // Populate on use, avoiding an N-by-N option list in large trees.
        const populate = () => {
            if (this.busy) return;
            const options = [['', '顶层']];
            const walk = (nodes, path = '') => nodes.forEach(item => {
                if (item.type !== 'group' || item.id === node.id) return;
                const name = path ? `${path} / ${item.name}` : item.name;
                options.push([item.id, name]); walk(item.children, name);
            });
            walk(this.library.nodes);
            this.fillOptions(select, options, this.library.location(node.id)?.parent?.id ?? '');
        };
        for (const event of ['focus', 'pointerdown', 'wheel']) select.addEventListener(event, populate, true);
    }
    runOptions(parent, node) {
        const options = this.element('div', 'command-send-options');
        const repeat = this.field(options, '总次数', 'repeat', node.repeat, 'number', node.id);
        repeat.min = 1; repeat.max = 1000000; repeat.step = 1;
        repeat.title = node.type === 'group' ? '整组执行次数，包含全部子项' : '实际发送总次数，1 表示仅发送一次';
        const interval = this.field(options, '间隔 (s)', 'interval', node.interval, 'number', node.id);
        interval.min = 0; interval.max = 86400; interval.step = .001;
        if (node.type === 'group') interval.title = '组边界间隔；与最后子项的间隔累加，最终完成后不再等待';
        parent.appendChild(options);
    }
    editor(node) {
        const editor = this.element('div', 'command-editor'); editor.id = `command-editor-${node.id}`;
        const content = this.element('div', 'command-content'), heading = this.element('div', 'command-content-heading');
        const title = this.element('label', 'command-content-label', '发送内容');
        title.setAttribute('for', `command-content-${node.id}`); heading.appendChild(title);
        this.select(heading, '格式', 'mode', [['hex', 'Hex'], ['text', '文本（UTF-8）']], node.mode,
            value => { if (this.mutate(() => this.library.update(node.id, { mode: value }), false)) this.refreshRow(node.id); });
        content.appendChild(heading);
        const input = this.field(content, '发送内容', 'content', node.content, 'textarea', node.id);
        input.id = `command-content-${node.id}`; input.placeholder = 'Hex 如 AA 55 0D 0A；文本按原样发送';
        input.parentElement.classList.add('command-content-input'); editor.appendChild(content);
        this.runOptions(editor, node); return editor;
    }
    rowActions(row, node, location) {
        const actions = this.element('div', 'command-row-actions');
        if (node.type === 'group') actions.append(this.button('添加指令', () => this.add('command', node.id)),
            this.button('添加子组', () => this.add('group', node.id)));
        for (const [title, delta] of [['上移', -1], ['下移', 1]]) {
            const button = this.button(title, () => this.mutate(() => this.library.move(node.id, location.parent?.id ?? null, location.index + delta)));
            button.setAttribute('data-command-action', delta < 0 ? 'move-up' : 'move-down');
            button.dataset.unavailable = String(location.index + delta < 0 || location.index + delta >= location.siblings.length);
            actions.appendChild(button);
        }
        actions.appendChild(this.button('复制', () => {
            if (this.mutate(() => { this.selectedId = this.library.duplicate(node.id); })) this.focusName(this.selectedId);
        }));
        const remove = this.button('删除', () => {
            if (this.busy) return;
            const current = this.library.find(node.id);
            const needsConfirmation = current?.type === 'group' ? current.children.length > 0 : current?.content.length > 0;
            if (needsConfirmation && remove.dataset.confirm !== 'true') {
                remove.dataset.confirm = 'true'; remove.textContent = current.type === 'group' ? '确认删除整组' : '确认删除指令'; return;
            }
            this.mutate(() => { this.library.remove(node.id); if (!this.library.find(this.selectedId)) this.selectedId = null; });
        }, 'command-delete');
        actions.appendChild(remove); row.appendChild(actions);
    }
    refreshParentLabels() {
        const paths = new Map();
        const visit = (nodes, prefix = '') => nodes.forEach(node => {
            if (node.type !== 'group') return;
            const path = prefix ? `${prefix} / ${node.name}` : node.name;
            paths.set(node.id, path); visit(node.children, path);
        });
        visit(this.library.nodes);
        for (const select of this.tree.querySelectorAll('[data-field="parent"]')) {
            for (const option of select.options) if (paths.has(option.value)) option.textContent = option.title = paths.get(option.value);
            select.title = paths.get(select.value) ?? '顶层';
        }
    }
    refreshRow(id, row = null, node = this.library.find(id)) {
        row ??= this.tree.querySelector(`[data-command-id="${id}"]`)?.querySelector('.command-row');
        if (!node || !row) return;
        const name = row.querySelector('.command-name');
        if (this.document.activeElement !== name) name.value = node.name;
        name.title = `${node.name}（单击修改名称）`;
        row.querySelector('.command-drag-handle').setAttribute('aria-label', `拖动${node.type === 'group' ? '指令组' : '指令'}：${node.name}`);
        const expanded = node.type === 'group' ? !node.collapsed : this.selectedId === id;
        row.querySelector('.command-disclosure').setAttribute('aria-label', `${expanded ? '收起' : '展开'}${node.type === 'group' ? '指令组' : '指令设置'}：${node.name}`);
        row.querySelector('.command-send').setAttribute('aria-label', `发送${node.type === 'group' ? '指令组' : '指令'}：${node.name}`);
        const meta = row.querySelector('.command-meta');
        meta.textContent = node.type === 'group' ? `${node.children.length} 项` : `${node.mode === 'hex' ? 'Hex' : '文本'} · ${node.repeat} 次 · ${node.interval} s`;
        meta.title = meta.textContent;
    }
    clearDrop() {
        this.dropRow?.classList.remove('command-drop-before', 'command-drop-after', 'command-drop-inside');
        this.rootDrop?.classList.remove('command-drop-inside'); this.dropRow = null; this.dropInfo = null;
    }
    clearDrag() {
        this.clearDrop(); this.dragRow?.classList.remove('command-dragging');
        this.dragRow = null; this.dragId = null; this.dragIds.clear();
        if (this.rootDrop) this.rootDrop.hidden = true;
    }
    markDrop(row, id, placement) {
        this.clearDrop(); this.dropRow = row; this.dropInfo = { id, placement };
        (row ?? this.rootDrop)?.classList.add(`command-drop-${placement === 'root' ? 'inside' : placement}`);
    }
    dragHandle(row, node) {
        const handle = this.button('', () => {}, 'command-drag-handle');
        handle.draggable = true; handle.title = '拖动排序：行边缘插入，组中央移入；底部可移至顶层';
        handle.setAttribute('aria-label', `拖动${node.type === 'group' ? '指令组' : '指令'}：${node.name}`);
        handle.addEventListener('dragstart', event => {
            if (this.busy || this.disposed) { event.preventDefault(); return; }
            this.clearDrag(); this.dragId = node.id; this.dragRow = row;
            const collect = item => { this.dragIds.add(item.id); item.children?.forEach(collect); };
            collect(this.library.find(node.id)); row.classList.add('command-dragging');
            this.rootDrop.hidden = false;
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-serialplotter-command', node.id);
                event.dataTransfer.setDragImage?.(row, 18, 12);
            }
        });
        handle.addEventListener('dragend', () => this.clearDrag());
        const canDrop = () => this.dragId && !this.busy && !this.dragIds.has(node.id);
        const placement = event => {
            const rect = row.getBoundingClientRect(), fraction = rect.height > 0 ? (event.clientY - rect.top) / rect.height : .5;
            return node.type === 'group' && fraction >= .25 && fraction <= .75 ? 'inside' : fraction < .5 ? 'before' : 'after';
        };
        row.addEventListener('dragover', event => {
            if (!this.dragId) return;
            event.stopPropagation();
            if (!canDrop()) { this.clearDrop(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; return; }
            event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            this.markDrop(row, node.id, placement(event));
        });
        row.addEventListener('dragleave', event => { if (!row.contains(event.relatedTarget)) this.clearDrop(); });
        row.addEventListener('drop', event => {
            if (!this.dragId) return;
            event.stopPropagation(); event.preventDefault();
            if (!canDrop()) { this.clearDrag(); return; }
            const id = this.dragId, where = this.dropInfo?.id === node.id ? this.dropInfo.placement : placement(event);
            this.clearDrag(); this.mutate(() => this.library.moveRelative(id, node.id, where));
        });
        return handle;
    }
    render() {
        if (this.disposed) return;
        this.clearDrag();
        const scroll = this.tree.scrollTop, active = this.document.activeElement;
        const focusId = active?.closest?.('.command-item')?.dataset.commandId;
        const focusSelector = active?.dataset.field ? `[data-field="${active.dataset.field}"]`
            : active?.dataset.commandAction ? `[data-command-action="${active.dataset.commandAction}"]` : null;
        const locations = new Map();
        const index = (nodes, parent = null, parentPath = '') => nodes.forEach((node, i) => {
            locations.set(node.id, { parent, parentPath, index: i, siblings: nodes });
            if (node.children) index(node.children, node, parentPath ? `${parentPath} / ${node.name}` : node.name);
        });
        index(this.library.nodes); this.tree.replaceChildren();
        if (!this.library.nodes.length) this.tree.appendChild(this.element('p', 'command-empty', '新建指令或多层指令组；名称可直接修改，拖动行首手柄调整位置。'));
        const walk = (nodes, parent, owner = null) => {
            const list = this.element('ul', 'command-list');
            if (owner) { list.id = `command-children-${owner.id}`; list.hidden = owner.collapsed; }
            if (owner?.collapsed) { parent.appendChild(list); return; }
            for (const node of nodes) {
                const item = this.element('li', 'command-item'); item.setAttribute('data-command-id', node.id);
                item.classList.toggle('command-editing', this.selectedId === node.id);
                const row = this.element('div', 'command-row'); row.appendChild(this.dragHandle(row, node));
                const expanded = node.type === 'group' ? !node.collapsed : this.selectedId === node.id;
                const toggle = () => {
                    if (node.type === 'group') { this.library.update(node.id, { collapsed: !node.collapsed }); this.onChange(); }
                    else this.selectedId = this.selectedId === node.id ? null : node.id;
                    this.render();
                };
                const disclosure = this.button('', toggle, 'command-disclosure');
                disclosure.dataset.toggle = 'true'; disclosure.setAttribute('data-command-action', 'toggle');
                disclosure.setAttribute('aria-expanded', String(expanded));
                if (node.type === 'group' || expanded) disclosure.setAttribute('aria-controls', `command-${node.type === 'group' ? 'children' : 'editor'}-${node.id}`);
                row.append(disclosure, this.element('span', 'command-kind', node.type === 'group' ? '组' : '指令'));
                const name = this.field(row, '名称', 'name', node.name, 'text', node.id);
                name.className = 'command-name'; name.setAttribute('data-command-action', 'name');
                name.parentElement.classList.add('command-name-wrap');
                this.parentSelect(row, node, locations.get(node.id));
                if (node.type === 'group') this.runOptions(row, node);
                row.appendChild(this.element('span', 'command-meta'));
                this.rowActions(row, node, locations.get(node.id));
                const send = this.button(node.type === 'group' ? '发送整组' : '发送', () => {
                    if (this.busy) return;
                    const invalid = item.querySelector('[aria-invalid="true"]');
                    if (invalid) { this.showError(new Error('请先修正本项及子项中标记为红色的输入')); invalid.focus?.(); return; }
                    void this.runner.start(node.id);
                }, 'command-send');
                send.setAttribute('data-command-action', 'send'); row.appendChild(send);
                this.refreshRow(node.id, row, node); item.appendChild(row);
                if (node.type === 'command' && this.selectedId === node.id) item.appendChild(this.editor(node));
                if (node.type === 'group') walk(node.children, item, node);
                list.appendChild(item);
            }
            parent.appendChild(list);
        };
        walk(this.library.nodes, this.tree);
        this.rootDrop = this.element('div', 'command-root-drop', '移至顶层末尾'); this.rootDrop.hidden = true;
        this.tree.appendChild(this.rootDrop); this.syncBusy(); this.tree.scrollTop = scroll;
        if (focusId && focusSelector) {
            const item = this.tree.querySelector(`[data-command-id="${focusId}"]`), target = item?.querySelector(focusSelector);
            (target && !target.disabled ? target : item?.querySelector('.command-name'))?.focus?.({ preventScroll: true });
        }
    }
    dispose() {
        if (this.disposed) return;
        this.clearDrag(); this.disposed = true;
        for (const remove of this.listeners.splice(0)) remove();
        this.tree.replaceChildren();
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.CommandSendView = CommandSendView;
if (typeof module !== 'undefined') module.exports = { CommandSendView };

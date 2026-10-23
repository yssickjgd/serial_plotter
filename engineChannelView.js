/** Global channel editing, independent of the selected widget. */
const engineChannelHelpers = typeof module !== 'undefined'
    ? { ...require('./channelTransform'), ...require('./channelRegistry'), ...require('./channelAutocomplete'), ...require('./reservedNames') } : globalThis.SerialPlotter;

class EngineChannelView {
    constructor({ document, root, controller, getRegistry, onChange = () => {} }) {
        this.document = document; this.root = root; this.controller = controller; this.onChange = onChange;
        this.getRegistry = getRegistry ?? (() => controller.getChannelRegistry?.() ?? new engineChannelHelpers.ChannelRegistry({
            rawCount: Number(controller.globals.channelsCount), definitions: controller.globals.channelDefinitions,
            names: controller.globals.channelNames, channels: controller.globals.channelRegistry
        }));
        this.expanded = new Set(); this.drafts = new Map(); this.errors = new Map(); this.listeners = []; this.rowCleanups = [];
        this.category = 'all'; this.searchText = ''; this.windowSize = 50; this.draggedNumber = null;
        this.rowHeight = 36; this.minimumListHeight = this.rowHeight * 5 + 1;
        this.measuredHeights = new Map(); this.renderedRows = new Map();
        const Observer = document.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
        this.rowObserver = Observer ? new Observer(entries => this.measureRows(entries)) : null;
        this.build(); this.refresh();
    }

    element(tag, className, role) {
        const node = this.document.createElement(tag);
        if (className) node.className = className;
        if (role) node.setAttribute('data-role', role);
        return node;
    }
    listen(target, event, handler, rows = false) {
        target.addEventListener(event, handler);
        (rows ? this.rowCleanups : this.listeners).push(() => target.removeEventListener(event, handler));
    }
    button(text, role, action, className = 'btn btn-secondary') {
        const button = this.element('button', className, role); button.type = 'button'; button.textContent = text;
        this.listen(button, 'click', action, true); return button;
    }
    select(choices, role) {
        const select = this.element('select', '', role);
        for (const [value, text] of choices) {
            const option = this.element('option'); option.value = value; option.textContent = text; select.append(option);
        }
        return select;
    }

    build() {
        this.root.replaceChildren(); this.root.classList.add('engine-channel-view');
        const toolbar = this.element('div', 'engine-channel-toolbar');
        const categories = [['all', '全部通道'], ['raw', '原始数据'], ['constant', '常量数组'], ['system', '差分方程系统'], ['formula', '运算通道']];
        this.categoryInput = this.select(categories, 'engine-channel-category'); this.categoryInput.setAttribute('aria-label', '通道类型筛选');
        this.search = this.element('input', '', 'engine-channel-search'); this.search.type = 'search';
        this.search.placeholder = '搜索 CH 编号或名称'; this.search.setAttribute('aria-label', '搜索通道');
        this.addType = this.select(categories.slice(2), 'engine-channel-add-type'); this.addType.setAttribute('aria-label', '新增通道类型');
        this.addType.value = 'formula';
        this.add = this.element('button', 'btn btn-primary', 'engine-channel-add'); this.add.type = 'button'; this.add.textContent = '新增通道';
        toolbar.append(this.categoryInput, this.search, this.addType, this.add);
        this.status = this.element('div', 'engine-channel-status', 'engine-channel-status'); this.status.setAttribute('role', 'status');
        this.list = this.element('div', 'engine-channel-list', 'engine-channel-list');
        this.list.setAttribute('aria-label', '全局通道');
        const help = this.element('p', 'hint-text');
        help.textContent = '原始数据由引擎映射；运算通道支持名称、CH 编号、历史索引及 DIFF / INT / FILTER。常量数组与差分方程系统用于滤波和系统响应。';
        this.root.append(toolbar, help, engineChannelHelpers.createReservedNamesHelp(this.document, 'channel'), this.status, this.list);
        this.listen(this.categoryInput, 'change', () => {
            this.category = this.categoryInput.value; this.list.scrollTop = 0; this.refresh();
        });
        this.listen(this.search, 'input', () => { this.searchText = this.search.value; this.list.scrollTop = 0; this.refresh(); });
        this.listen(this.list, 'scroll', () => this.renderWindow());
        this.listen(this.add, 'click', () => {
            const type = this.category === 'all' ? this.addType.value : this.category;
            if (type === 'raw') return;
            this.perform(() => this.controller.addChannel(type), null, number => {
                if (Number.isInteger(number)) this.expanded.add(this.keyFor(number));
                this.refresh(); this.scrollToNumber(number);
            });
        });
    }

    keyFor(number) { return this.registry?.get?.(number)?.id ?? number; }
    updateMetadata(index, patch) {
        if (patch.name !== undefined) {
            this.registry = this.getRegistry();
            if (this.searchText) {
                const next = this.filteredChannels();
                if (next.length !== this.channels.length || next.some((channel, at) => channel.number !== this.channels[at].number)) {
                    this.refresh(); return;
                }
            }
        }
        const channel = this.channels.find(channel => channel.index === index);
        if (channel) Object.assign(channel, patch);
        const row = [...this.list.children].find(row => row.dataset.channelNumber === String(index + 1));
        if (!row) return;
        for (const key of ['name', 'color']) if (patch[key] !== undefined) {
            const input = [...row.children].find(child => child.getAttribute('data-role') === `channel-${key}`);
            if (input && input.value !== patch[key]) input.value = patch[key];
            if (key === 'name' && input) input.title = patch[key];
        }
    }
    isExpanded(number) { return this.expanded.has(this.keyFor(number)) || this.expanded.has(number); }
    height(channel) {
        const expanded = Boolean(channel.definition && this.isExpanded(channel.number));
        const cached = this.measuredHeights.get(this.keyFor(channel.number));
        if (cached && cached.expanded === expanded && cached.width === (this.list.clientWidth || 0)) return cached.height;
        // Off-screen rows need an estimate, but rendered rows always size to their contents.
        return expanded ? channel.definition.type === 'system' ? 312 : 224 : this.rowHeight;
    }
    rebuildOffsets() {
        this.offsets = new Float64Array(this.channels.length + 1);
        for (let index = 0; index < this.channels.length; index++) this.offsets[index + 1] = this.offsets[index] + this.height(this.channels[index]);
    }
    firstVisible(scrollTop) {
        let lo = 0, hi = this.channels.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.offsets[mid + 1] <= scrollTop) lo = mid + 1; else hi = mid; }
        return Math.min(lo, Math.max(0, this.channels.length - 1));
    }
    measureRows(entries) {
        if (this.disposed || !this.channels.length) return;
        if (entries.some(entry => entry.target === this.list)) this.renderWindow();
        const scrollTop = this.list.scrollTop || 0, anchor = this.firstVisible(scrollTop);
        const withinRow = scrollTop - this.offsets[anchor];
        let changed = false;
        for (const entry of entries) {
            const channel = this.renderedRows.get(entry.target);
            if (!channel) continue;
            const box = entry.borderBoxSize?.[0] ?? entry.borderBoxSize;
            const actual = Number(box?.blockSize ?? entry.target.getBoundingClientRect?.()?.height);
            if (!Number.isFinite(actual) || actual <= 0) continue;
            const height = Math.max(this.rowHeight, actual), previous = this.height(channel);
            this.measuredHeights.set(this.keyFor(channel.number), { height,
                expanded: Boolean(channel.definition && this.isExpanded(channel.number)), width: this.list.clientWidth || 0 });
            changed ||= Math.abs(previous - height) > .25;
        }
        if (!changed) return;
        this.rebuildOffsets();
        const window = this.renderedWindow;
        if (window?.before) window.before.style.height = `${this.offsets[window.start]}px`;
        if (window?.after) window.after.style.height = `${this.offsets[this.channels.length] - this.offsets[window.end]}px`;
        // Keep the same visible content when a preceding editor or error changes height.
        const nextTop = this.offsets[anchor] + Math.min(withinRow, this.height(this.channels[anchor]) - 1);
        if (Math.abs(nextTop - scrollTop) > .25) this.list.scrollTop = nextTop;
    }

    filteredChannels() {
        const query = String(this.searchText).normalize('NFC').toLocaleLowerCase();
        return this.controller.channelMeta().filter(channel => {
            if (this.category !== 'all' && (channel.definition?.type ?? 'raw') !== this.category) return false;
            const canonical = engineChannelHelpers.formatChannelId(channel.index).toLowerCase();
            return !query || String(channel.name).normalize('NFC').toLocaleLowerCase().includes(query) || canonical.includes(query) ||
                /^ch\d*$/i.test(query) && `ch${channel.number}`.startsWith(query);
        });
    }
    refresh() {
        this.registry = this.getRegistry();
        for (const key of this.measuredHeights.keys()) if (!this.registry.get(key)) this.measuredHeights.delete(key);
        this.derivedOrder = this.controller.globals.channelDefinitions.map(value => value.number).sort((a, b) => a - b);
        this.derivedPositions = new Map(this.derivedOrder.map((number, index) => [number, index]));
        this.channels = this.filteredChannels();
        this.categoryInput.value = this.category;
        this.addType.disabled = this.category !== 'all';
        if (['formula', 'constant', 'system'].includes(this.category)) this.addType.value = this.category;
        this.add.disabled = this.category === 'raw';
        this.add.title = this.category === 'raw' ? '原始数据通道由帧解析生成' : '';
        this.status.textContent = `${this.channels.length} 个通道`;
        this.rebuildOffsets();
        this.renderWindow(true);
    }

    scrollToNumber(number) {
        const index = this.channels.findIndex(channel => channel.number === number);
        if (index >= 0) { this.list.scrollTop = this.offsets[index]; this.renderWindow(); }
    }
    renderWindow(force = false) {
        const scrollTop = this.list.scrollTop || 0;
        const lo = this.firstVisible(scrollTop);
        const windowSize = Math.max(this.windowSize, Math.ceil((this.list.clientHeight || 0) / this.rowHeight) + 8);
        const start = Math.max(0, Math.min(this.channels.length - windowSize, lo - 4));
        const end = Math.min(this.channels.length, start + windowSize), rows = [];
        if (!force && this.renderedWindow?.start === start && this.renderedWindow?.end === end) return;
        this.rowObserver?.disconnect(); this.renderedRows.clear();
        for (const cleanup of this.rowCleanups) cleanup(); this.rowCleanups = [];
        const spacer = height => {
            const node = this.element('div', 'engine-channel-spacer'); node.style.height = `${height}px`;
            node.setAttribute('aria-hidden', 'true'); return node;
        };
        const before = start ? spacer(this.offsets[start]) : null;
        const after = end < this.channels.length ? spacer(this.offsets[this.channels.length] - this.offsets[end]) : null;
        if (before) rows.push(before);
        for (let index = start; index < end; index++) {
            const row = this.renderRow(this.channels[index]);
            this.renderedRows.set(row, this.channels[index]); rows.push(row);
        }
        if (after) rows.push(after);
        if (!this.channels.length) {
            const empty = this.element('p', 'engine-channel-empty'); empty.textContent = '没有符合筛选条件的通道'; rows.push(empty);
        }
        this.renderedWindow = { start, end, before, after };
        this.list.replaceChildren(...rows);
        if (this.rowObserver) {
            this.rowObserver.observe(this.list);
            for (const row of this.renderedRows.keys()) this.rowObserver.observe(row);
        }
        else this.measureRows([...this.renderedRows.keys()].map(target => ({ target })));
    }

    perform(action, errorNode, success = () => this.refresh()) {
        const showError = error => {
            const message = error?.message ?? String(error);
            if (errorNode) {
                if (errorNode.channelKey !== undefined) this.errors.set(errorNode.channelKey, message);
                errorNode.textContent = message; errorNode.hidden = false;
                for (const row of this.list.children) for (const child of row.children)
                    if (errorNode.channelKey !== undefined && child.channelKey === errorNode.channelKey) {
                        child.textContent = message; child.hidden = false;
                    }
            }
            else this.status.textContent = message;
        };
        try {
            const result = action();
            if (result?.then) result.then(value => { success(value); this.onChange(); }, showError);
            else { success(result); this.onChange(); }
        } catch (error) { showError(error); }
    }

    renderRow(channel) {
        const { index, number, definition } = channel, key = this.keyFor(number);
        const row = this.element('div', 'channel-config-row channel-config-main engine-channel-row');
        row.dataset.channelNumber = String(number); row.style.gridTemplateColumns = '78px 22px minmax(0, 1fr) auto';
        row.style.minHeight = `${this.rowHeight}px`; row.style.boxSizing = 'border-box';
        const label = this.element(definition ? 'button' : 'span', definition ? 'channel-toggle' : 'channel-label');
        label.textContent = engineChannelHelpers.formatChannelId(index);
        if (definition) {
            label.type = 'button'; label.draggable = true; label.setAttribute('aria-expanded', String(this.isExpanded(number)));
            label.title = '展开配置；拖动调整顺序';
            this.listen(label, 'click', () => {
                if (this.isExpanded(number)) { this.expanded.delete(key); this.expanded.delete(number); } else this.expanded.add(key);
                this.refresh();
            }, true);
        }
        const color = this.element('input', '', 'channel-color'); color.type = 'color'; color.value = channel.color;
        color.setAttribute('aria-label', `${label.textContent} 颜色`);
        const name = this.element('input', '', 'channel-name'); name.type = 'text'; name.value = channel.name;
        name.setAttribute('aria-label', `${label.textContent} 名称`);
        const error = this.element('div', 'channel-definition-error', 'channel-error'); error.setAttribute('role', 'status');
        error.channelKey = key;
        error.textContent = this.errors.get(key) ?? this.registry?.nameErrors.get(number) ?? ''; error.hidden = !error.textContent;
        this.listen(color, 'input', () => this.perform(() => this.controller.setChannelColor(index, color.value), error, () => {
            channel.color = color.value;
        }), true);
        this.listen(name, 'change', () => {
            const validation = this.registry?.validateName(name.value, number);
            if (validation && !validation.valid) { this.errors.set(key, validation.error); error.textContent = validation.error; error.hidden = false; return; }
            this.perform(() => this.controller.setChannelName(index, validation?.name ?? name.value), error, () => {
                this.errors.delete(key); this.refresh();
            });
        }, true);
        const moves = this.element('div', 'engine-channel-moves');
        if (definition) {
            const order = this.derivedOrder, at = this.derivedPositions.get(number);
            const up = this.button('', 'channel-up', () => this.perform(() => this.controller.moveChannel(number, order[at - 1]), error));
            const down = this.button('', 'channel-down', () => this.perform(() => this.controller.moveChannel(number, order[at + 1]), error));
            for (const [button, title, direction] of [[up, '上移', 'up'], [down, '下移', 'down']]) {
                button.classList.add('reorder-button'); button.title = title; button.setAttribute('aria-label', title);
                const arrow = this.element('span', `move-arrow move-arrow-${direction}`); arrow.setAttribute('aria-hidden', 'true'); button.append(arrow);
            }
            up.disabled = at <= 0; down.disabled = at === order.length - 1; moves.append(up, down);
            this.listen(label, 'dragstart', event => {
                this.draggedNumber = number; event.stopPropagation(); row.classList.add('channel-dragging');
                event.dataTransfer?.setData('application/x-serial-plotter-channel', String(number));
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
            }, true);
            this.listen(label, 'dragend', () => { this.draggedNumber = null; row.classList.remove('channel-dragging'); }, true);
            this.listen(row, 'dragover', event => {
                if (this.draggedNumber === null || this.draggedNumber === number) return;
                event.preventDefault(); event.stopPropagation(); row.classList.add('channel-drop-target');
            }, true);
            this.listen(row, 'dragleave', () => row.classList.remove('channel-drop-target'), true);
            this.listen(row, 'drop', event => {
                if (this.draggedNumber === null) return;
                event.preventDefault(); event.stopPropagation(); const from = this.draggedNumber; this.draggedNumber = null;
                row.classList.remove('channel-drop-target'); this.perform(() => this.controller.moveChannel(from, number), error);
            }, true);
        }
        row.append(label, color, name, moves);
        if (definition && this.isExpanded(number)) row.append(this.renderEditor(channel, error, key));
        row.append(error);
        return row;
    }

    renderEditor(channel, error, key) {
        const { definition, number } = channel, draft = this.drafts.get(key) ?? this.drafts.get(number) ?? definition;
        const details = this.element('div', 'channel-definition'), label = this.element('label');
        label.textContent = definition.type === 'formula' ? '通道公式' : definition.type === 'constant' ? '常量数组' : '差分方程';
        const expression = this.element('textarea', '', 'channel-expression'); expression.rows = 2; expression.spellcheck = false;
        expression.value = draft.expression; expression.placeholder = definition.type === 'formula' ? '温度 + CH00002 或 FILTER(CH00001, CH00003)' :
            definition.type === 'constant' ? '[0]=1,[1]=-2.3' : 'Y[N]=X[N]+0.5*Y[N-1]';
        label.append(expression); details.append(label);
        if (definition.type === 'formula') {
            const autocomplete = engineChannelHelpers.attachChannelAutocomplete(expression, { getRegistry: () => this.getRegistry() });
            this.rowCleanups.push(() => autocomplete.destroy());
        }
        let initial;
        if (definition.type === 'system') {
            const initialLabel = this.element('label'); initialLabel.textContent = '初始状态';
            initial = this.element('textarea', '', 'channel-initial'); initial.rows = 2; initial.spellcheck = false;
            initial.value = draft.initial ?? ''; initial.placeholder = 'Y[-1]=0；有输入延迟时也填写 X[-1]=0';
            initialLabel.append(initial); details.append(initialLabel);
        }
        const update = apply => {
            const candidate = { ...definition, expression: expression.value, ...(initial ? { initial: initial.value } : {}) };
            this.drafts.set(key, candidate);
            try {
                if (definition.type === 'formula') candidate.expression = this.getRegistry().canonicalizeExpression(candidate.expression);
                this.controller.validateChannelDefinition(candidate); this.errors.delete(key); error.hidden = true; error.textContent = '';
                if (apply) this.perform(() => this.controller.updateChannelDefinition(candidate, { reapply: true }), error, () => {
                    this.drafts.delete(key); this.drafts.delete(number); this.refresh();
                });
            } catch (failure) {
                this.errors.set(key, failure.message); error.textContent = failure.message; error.hidden = false;
            }
        };
        for (const input of [expression, initial].filter(Boolean)) {
            this.listen(input, 'input', () => update(false), true); this.listen(input, 'change', () => update(false), true);
        }
        const actions = this.element('div', 'channel-definition-actions');
        const apply = this.button('应用公式', 'channel-apply', () => update(true), 'btn btn-primary');
        const remove = this.button('删除通道', 'channel-delete', () => this.perform(() => this.controller.removeChannel(number), error), 'btn btn-danger channel-delete');
        actions.append(apply, remove); details.append(actions);
        if (!this.errors.has(key) && (this.drafts.has(key) || this.drafts.has(number))) update(false);
        return details;
    }

    dispose() {
        this.disposed = true; this.rowObserver?.disconnect(); this.renderedRows.clear(); this.measuredHeights.clear();
        for (const cleanup of [...this.rowCleanups, ...this.listeners]) cleanup();
        this.listeners = []; this.rowCleanups = []; this.list.replaceChildren(); this.root.replaceChildren(); this.expanded.clear(); this.drafts.clear();
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.EngineChannelView = EngineChannelView;
if (typeof module !== 'undefined') module.exports = { EngineChannelView };

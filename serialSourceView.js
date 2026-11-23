/** Connection overview rows and the shared configuration dialog. */
class SerialSourceView {
    constructor(root, { dialog, onConnect, onBind, onRemove, onSave, onEngine, onSelect }) {
        this.root = root;
        const document = root.ownerDocument, get = id => document.getElementById(id);
        Object.assign(this, { dialog, onConnect, onBind, onRemove, onSave, onEngine, onSelect });
        this.rows = new Map();
        this.formDrafts = new Map();
        this.manager = get('serial-manager-panel');
        this.sourceNav = get('serial-source-nav');
        this.sourceDetails = get('engine-communication');
        this.sourceWorkspace = get('serial-manager-workspace');
        this.compact = document.defaultView?.matchMedia?.('(max-width: 600px)');
        this.path = get('serial-config-path');
        this.engineView = get('data-engine');
        this.enginePanels = [...this.engineView.querySelectorAll('.tab-content')];
        this.enginePositions = new Map();
        this.managerClose = get('serial-manager-close');
        this.managerButton = get('serial-manager-open');
        this.form = get('serial-config-form');
        this.enginePanel = get('connection-engine-panel');
        this.engineBack = get('connection-engine-back');
        this.title = get('serial-config-title');
        this.serialParameters = get('serial-config-parameters');
        this.networkParameters = get('connection-network-parameters');
        this.hostWrap = get('wrap-net-host');
        this.localPortWrap = get('wrap-local-port');
        this.portLabel = get('net-port-label');
        this.lockedNote = get('serial-config-locked');
        this.error = get('serial-config-error');
        this.formStatus = get('serial-config-status');
        this.reset = get('serial-config-reset');
        this.fields = { mode: get('conn-type'), name: get('serial-config-name'),
            baudRate: get('serial-baud'), dataBits: get('serial-data'), stopBits: get('serial-stop'), parity: get('serial-parity'),
            host: get('net-host'), port: get('net-port'), localPort: get('net-local') };
        this.handlers = [
            [this.form, 'submit', event => this.submit(event)],
            [this.fields.mode, 'change', () => this.syncDialog()],
            [this.form, 'input', () => { this.formStatus.textContent = '离开编辑区或按 Enter 应用。'; }],
            [this.reset, 'click', () => {
                this.formDrafts.delete(this.selectedId);
                this.loadForm();
            }],
            [this.compact, 'change', () => {
                if (!this.dialog.open || this.protocolPage) return;
                const { tab } = this.enginePosition();
                if (this.compact.matches && (tab !== 'engine-communication' || this.engineView.contains(document.activeElement)))
                    this.sourceWorkspace.setAttribute('data-show-details', '');
                this.handleTab(tab);
            }],
            [this.managerClose, 'click', () => this.close()],
            [this.engineBack, 'click', () => this.dismiss()],
            [this.dialog, 'keydown', event => {
                // Handle navigation before the browser treats repeated Escape presses as a request to close the modal.
                if (event.key !== 'Escape' || event.defaultPrevented || event.target.closest?.('dialog') !== this.dialog) return;
                event.preventDefault();
                if (!event.repeat) this.dismiss();
            }],
            [this.dialog, 'cancel', event => { event.preventDefault(); this.dismiss(); }],
            [this.dialog, 'close', () => { if (!this.dialog.open) this.showList(); }]
        ];
        globalThis.SerialPlotter.bindAutoApply(this.form, () => this.submit(), (...binding) => this.handlers.push(binding));
        for (const [node, event, listener] of this.handlers) node?.addEventListener?.(event, listener);
    }

    static describe({ mode, baudRate, dataBits, parity, stopBits, host, port, localPort }) {
        if (mode === 'tcp-server') return 'TCP 服务端 · 监听 ' + port;
        if (mode === 'tcp-client') return 'TCP 客户端 · ' + host + ':' + port;
        if (mode === 'udp') return 'UDP · ' + host + ':' + port + ' · 本地 ' + (localPort || port);
        const baud = Number(baudRate).toLocaleString('en-US');
        return '串口 · ' + baud + ' baud · ' + dataBits + ({ none: 'N', even: 'E', odd: 'O' }[parity]) + stopBits;
    }

    showList() {
        if (this.showingOverview && this.dialog.open) {
            this.selectTab('engine-communication');
            return;
        }
        this.rememberEnginePosition();
        this.closeEnginePage();
        this.manager.hidden = false; this.enginePanel.hidden = false;
        this.selectTab('engine-communication');
        if (this.listPosition) {
            this.sourceNav.scrollTop = this.listPosition.nav;
            this.sourceDetails.scrollTop = this.listPosition.details;
        }
    }

    showManager() {
        if (!this.dialog.open) {
            this.dialog.showModal();
            if (this.showingOverview && this.listPosition) this.sourceNav.scrollTop = this.listPosition.nav;
        }
        this.showList();
        this.title.focus();
    }

    setHeading(title, path = '', backLabel = '') {
        this.title.textContent = title;
        this.path.textContent = path; this.path.hidden = !path;
        this.engineBack.hidden = !backLabel;
        this.engineBack.textContent = backLabel;
    }

    showingCompactDetails() {
        return this.compact?.matches && this.sourceWorkspace.hasAttribute('data-show-details');
    }

    get showingOverview() { return this.engineView.classList.contains('engine-overview'); }

    selectTab(tab) {
        const button = this.enginePanel.querySelector('[data-tab="' + tab + '"]');
        button?.click();
        return button;
    }

    handleTab(tab) {
        if (!this.dialog.open || this.protocolPage) return;
        const row = this.rows.get(this.selectedId);
        if (this.showingOverview) {
            if (row && this.enginePage?.sourceId !== this.selectedId) this.onEngine(row.source, tab, false);
            this.setHeading(row ? row.source.settings.name + ' · 通讯' : '通讯来源配置', row ? '通讯来源配置' : '');
            return;
        }
        if (tab === 'engine-communication') {
            const name = row?.source.settings.name;
            const showSource = name && (!this.compact?.matches || this.showingCompactDetails());
            this.setHeading(showSource ? name + ' · 通讯' : '通讯来源配置', showSource ? '通讯来源配置' : '',
                this.showingCompactDetails() ? '返回来源列表' : '');
            return;
        }
        if (!row) return;
        if (this.compact?.matches) this.sourceWorkspace.setAttribute('data-show-details', '');
        if (this.enginePage?.sourceId !== this.selectedId) {
            this.onEngine(row.source, tab);
            return;
        }
        this.setHeading(row.source.settings.name + ' · 数据引擎', '通讯来源配置', '返回通讯');
    }

    rememberList() {
        const nav = this.showingCompactDetails()
            ? this.listPosition?.nav ?? 0 : this.sourceNav.scrollTop;
        this.listPosition = { nav, details: this.sourceDetails.scrollTop };
    }

    selectSource(id) {
        if (!this.rows.has(id)) return;
        if (this.selectedId !== id) {
            if (this.enginePage?.sourceId === this.selectedId) this.rememberEnginePosition();
            this.rememberForm();
            this.selectedId = id;
            this.sourceDetails.scrollTop = 0;
            this.loadForm();
            this.onSelect(this.selectedSource);
        }
        for (const [key, row] of this.rows) {
            row.section.hidden = key !== id;
            if (key === id) row.choice.setAttribute('aria-current', 'true');
            else row.choice.removeAttribute('aria-current');
        }
    }

    revealSource(id) {
        if (!this.dialog.open) this.showManager();
        this.showList();
        this.selectSource(id);
        if (this.compact?.matches) this.sourceWorkspace.setAttribute('data-show-details', '');
        this.handleTab('engine-communication');
        this.fields.name.focus();
    }

    returnToSourceList() {
        this.sourceWorkspace.removeAttribute('data-show-details');
        this.sourceNav.scrollTop = this.listPosition?.nav ?? 0;
        this.handleTab('engine-communication');
        this.rows.get(this.selectedId)?.choice.focus({ preventScroll: true });
    }

    rememberEnginePosition() {
        const position = this.protocolPage?.position ?? this.enginePosition();
        if (this.enginePage && (this.showingOverview || position.tab !== 'engine-communication'))
            this.enginePositions.set(this.enginePage.sourceId, position);
    }

    showEngine(source, onClose) {
        if (!this.dialog.open) this.dialog.showModal();
        this.selectSource(source.settings.id);
        this.rememberList();
        if (this.compact?.matches) this.sourceWorkspace.setAttribute('data-show-details', '');
        this.enginePage = { sourceId: source.settings.id, onClose };
        this.manager.hidden = false; this.enginePanel.hidden = false;
    }

    enginePosition() {
        return {
            tab: this.enginePanels.find(panel => panel.classList.contains('active'))?.id,
            scroll: this.enginePanels.map(panel => panel.scrollTop),
            channelScroll: this.enginePanel.querySelector('.engine-channel-list')?.scrollTop
        };
    }

    restoreEnginePosition(position, focus = false, tab = position?.tab ?? 'engine-parsing') {
        const button = this.selectTab(tab);
        for (const [index, panel] of this.enginePanels.entries()) panel.scrollTop = position?.scroll[index] ?? 0;
        const list = this.enginePanel.querySelector('.engine-channel-list');
        if (list) list.scrollTop = position?.channelScroll ?? 0;
        if (focus && !this.showingOverview) button?.focus({ preventScroll: true });
    }

    showProtocol(opener, onBack) {
        if (!this.enginePage) return;
        const position = this.enginePosition();
        if (this.showingOverview) position.tab = opener?.closest('.tab-content')?.id ?? position.tab;
        this.protocolPage = { opener, onBack, position };
        this.manager.hidden = true; this.enginePanel.hidden = true;
        this.setHeading('协议编辑器 · ' + this.selectedSource.settings.name, '通讯来源 › 数据引擎', '返回数据引擎');
    }

    returnFromProtocol() {
        const page = this.protocolPage;
        if (!page) return;
        this.protocolPage = null;
        this.manager.hidden = false; this.enginePanel.hidden = false;
        this.restoreEnginePosition(page.position);
        page.opener?.focus({ preventScroll: true });
    }

    get selectedSource() { return this.rows.get(this.selectedId)?.source; }

    rememberForm() {
        if (!this.formBaseline || !this.selectedSource) return;
        const changes = Object.fromEntries(Object.entries(this.fields)
            .filter(([key, field]) => field.value !== this.formBaseline[key])
            .map(([key, field]) => [key, field.value]));
        if (Object.keys(changes).length) this.formDrafts.set(this.selectedId, changes);
        else this.formDrafts.delete(this.selectedId);
    }

    clearFormDrafts() {
        this.formDrafts.clear();
        this.loadForm();
    }

    loadForm() {
        const source = this.selectedSource;
        this.form.hidden = !source;
        if (!source) return;
        const changes = this.formDrafts.get(this.selectedId);
        this.formBaseline = Object.fromEntries(Object.keys(this.fields).map(key => [key, String(source.settings[key] ?? '')]));
        for (const [key, field] of Object.entries(this.fields)) field.value = changes?.[key] ?? this.formBaseline[key];
        this.error.hidden = true; this.error.textContent = '';
        this.formStatus.textContent = '离开编辑区或按 Enter 应用。';
        this.syncDialog();
    }

    syncDialog() {
        const source = this.selectedSource;
        if (!source) return;
        const locked = source.connected || source.pending;
        const mode = this.fields.mode.value, serial = mode === 'serial', server = mode === 'tcp-server';
        this.serialParameters.hidden = !serial;
        this.networkParameters.hidden = serial;
        this.hostWrap.hidden = server;
        this.localPortWrap.hidden = mode !== 'udp';
        this.portLabel.textContent = server ? '监听端口' : '远端端口';
        const editableTransport = serial ? ['mode', 'baudRate', 'dataBits', 'stopBits', 'parity'] : ['mode', 'port'];
        if (!serial && !server) editableTransport.push('host');
        if (mode === 'udp') editableTransport.push('localPort');
        for (const [key, field] of Object.entries(this.fields)) {
            const editable = key === 'name' ||
                (!locked && editableTransport.includes(key));
            field.disabled = !editable;
        }
        this.lockedNote.hidden = !locked;
    }

    submit(event) {
        event?.preventDefault();
        const source = this.selectedSource;
        if (!source || !this.dialog.open || this.sourceDetails.hidden) return;
        this.syncDialog();
        const settings = Object.fromEntries(Object.entries(this.fields).filter(([, field]) => !field.disabled)
            .map(([key, field]) => [key, field.value]));
        if (Object.entries(settings).every(([key, value]) => value === this.formBaseline[key])) {
            this.error.hidden = true; this.error.textContent = '';
            return;
        }
        try {
            this.onSave(source, settings);
            this.formDrafts.delete(this.selectedId);
            this.loadForm();
            this.formStatus.textContent = '配置已更新';
            this.handleTab('engine-communication');
        } catch (error) {
            this.error.textContent = error.message;
            this.error.hidden = false;
        }
    }

    dismiss() {
        if (this.protocolPage) { this.protocolPage.onBack(); return; }
        if (this.showingOverview || this.enginePosition().tab === 'engine-communication') {
            if (this.showingCompactDetails()) this.returnToSourceList();
            else this.close();
            return;
        }
        this.showList();
        this.enginePanel.querySelector('[data-tab="engine-communication"]')?.focus({ preventScroll: true });
    }

    close(restoreFocus = true) {
        if (!this.manager.hidden) this.rememberList();
        const wasOpen = this.dialog.open;
        if (wasOpen) {
            this.rememberEnginePosition();
            this.closeEnginePage();
            this.dialog.close();
        }
        this.sourceWorkspace.removeAttribute('data-show-details');
        this.showList();
        if (wasOpen && restoreFocus) this.managerButton.focus();
    }

    closeEnginePage() {
        const page = this.enginePage;
        this.enginePage = this.protocolPage = null;
        page?.onClose();
    }

    dispose() {
        this.close(false);
        for (const [node, event, listener] of this.handlers) node?.removeEventListener?.(event, listener);
        for (const id of this.rows.keys()) this.remove(id);
    }

    add(source) {
        const { id } = source.settings, document = this.root.ownerDocument;
        const prefix = id === 'primary' ? 'serial-primary' : id;
        const section = document.createElement('section');
        section.className = 'serial-source-row'; section.dataset.sourceId = id;
        const navRow = document.createElement('div');
        navRow.className = 'serial-source-nav-row';
        const choice = document.createElement('button');
        choice.type = 'button'; choice.className = 'serial-source-choice';
        choice.setAttribute('aria-controls', prefix + '-details'); section.id = prefix + '-details';
        const choiceName = document.createElement('strong'), choiceState = document.createElement('small');
        choice.append(choiceName, choiceState); navRow.append(choice); this.sourceNav.append(navRow);
        choice.addEventListener('click', () => {
            const tab = this.enginePosition().tab;
            this.selectSource(id);
            if (this.compact?.matches) {
                this.rememberList();
                this.sourceWorkspace.setAttribute('data-show-details', '');
            }
            this.handleTab(tab);
            if (this.compact?.matches) this.selectTab(tab)?.focus({ preventScroll: true });
        });
        const heading = document.createElement('div');
        heading.className = 'serial-source-heading';
        const name = document.createElement('strong'), summary = document.createElement('span');
        name.id = prefix + '-label'; summary.id = prefix + '-summary'; summary.className = 'serial-link-summary';
        heading.append(name, summary);
        section.setAttribute('aria-labelledby', name.id);
        const buttons = document.createElement('div');
        buttons.className = 'serial-source-actions';
        const button = (key, label, action, style = 'secondary', parent = buttons) => {
            const node = document.createElement('button');
            node.id = prefix + '-' + key; node.type = 'button'; node.className = 'btn btn-' + style;
            node.textContent = label; node.addEventListener('click', () => { if (!node.disabled) action(source, node); });
            parent.append(node); return node;
        };
        const bind = button('bind', '绑定端口', this.onBind);
        const connect = button('connect', '连接', this.onConnect, 'primary');
        const remove = id === 'primary' ? null : button('remove', '删除', this.onRemove, 'secondary', navRow);
        if (remove) remove.classList.add('serial-source-remove');
        const navError = document.createElement('p');
        navError.className = 'hint-text is-error serial-source-nav-error'; navError.setAttribute('role', 'status');
        navRow.append(navError);
        const binding = document.createElement('span'), status = document.createElement('span');
        binding.id = prefix + '-binding'; binding.className = 'hint-text serial-source-binding';
        binding.setAttribute('role', 'status');
        status.id = prefix + '-status'; status.className = 'hint-text serial-source-status';
        section.append(heading, binding, buttons, status); this.root.append(section); this.root.hidden = false;
        this.rows.set(id, { source, section, navRow, navError, choice, choiceName, choiceState, name, summary, bind, binding, connect, remove, status });
        this.selectSource(this.selectedId ?? id);
        this.refresh(source);
        return connect;
    }

    refresh(source) {
        const row = this.rows.get(source.settings.id);
        if (!row) return;
        const { connected, pending, capture, error, settings } = source;
        row.connect.textContent = connected ? '断开连接' : '连接';
        const serial = settings.mode === 'serial';
        row.bind.hidden = row.binding.hidden = !serial;
        row.bind.disabled = !serial || connected || pending || source.controlsLocked;
        row.connect.disabled = pending || source.controlsLocked;
        if (row.remove) row.remove.disabled = connected || pending || source.controlsLocked;
        row.bind.textContent = source.hasBinding ? '重新绑定' : '绑定端口';
        const bindingMessage = source.bindingMessage || (source.needsConfirmation ? '同型号端口需要重新确认绑定'
            : source.hasBinding ? '已记录端口绑定' : '待绑定端口');
        if (row.binding.textContent !== bindingMessage) row.binding.textContent = bindingMessage;
        if (row.name.textContent !== settings.name) {
            row.name.textContent = settings.name; row.choiceName.textContent = settings.name;
            row.remove?.setAttribute('aria-label', '删除「' + settings.name + '」');
        }
        row.navError.hidden = !error;
        if (row.navError.textContent !== (error || '')) row.navError.textContent = error || '';
        const summary = SerialSourceView.describe(settings) + (settings.timeOffsetMs ?
            ' · 偏移 ' + (settings.timeOffsetMs > 0 ? '+' : '') + settings.timeOffsetMs + ' ms' : '');
        if (row.summary.textContent !== summary) row.summary.textContent = summary;
        const state = pending ? '处理中…' : connected ? '已连接' : '已断开';
        const choiceState = (serial ? '串口' : settings.mode === 'udp' ? 'UDP' : 'TCP') + ' · ' + state;
        if (row.choiceState.textContent !== choiceState) row.choiceState.textContent = choiceState;
        const output = capture.dataEngine?.mode === 'Self_Defined_Frame' ? capture.dataEngine.recordsSource : capture.numericSource;
        const parsed = capture.dataEngine?.mode === 'Raw_Data' ? '' : ' · 解析 ' + output.parser.frameCount.toLocaleString() +
            ' 帧 / 错误 ' + output.parser.failCount.toLocaleString();
        const current = state + ' · RX ' + capture.stats.rxBytes.toLocaleString() + ' B · TX ' + capture.stats.txBytes.toLocaleString() +
            ' B · 保留 ' + capture.baseSource.frames.length.toLocaleString() + ' 条记录' + parsed + (error ? ' · ' + error : '');
        if (row.status.textContent !== current) row.status.textContent = current;
        if (settings.id === this.selectedId) {
            if (Object.keys(this.fields).some(key => this.formBaseline?.[key] !== String(settings[key] ?? ''))) {
                this.rememberForm();
                this.loadForm();
            } else this.syncDialog();
        }
    }

    remove(id) {
        const row = this.rows.get(id);
        const restoreFocus = row?.navRow.contains(this.root.ownerDocument.activeElement);
        const { tab } = this.enginePosition();
        if (this.enginePage?.sourceId === id) this.closeEnginePage();
        row?.section.remove(); row?.navRow.remove(); this.rows.delete(id); this.enginePositions.delete(id); this.formDrafts.delete(id);
        this.root.hidden = this.rows.size === 0;
        if (this.selectedId === id) {
            this.selectedId = null;
            if (this.rows.size) this.selectSource(this.rows.keys().next().value);
            else this.loadForm();
            this.handleTab(tab);
        }
        if (restoreFocus) this.rows.get(this.selectedId)?.choice.focus({ preventScroll: true });
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.SerialSourceView = SerialSourceView;

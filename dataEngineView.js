/** Global parsing drafts and channel editing remain available in an empty workspace. */
(function(root) {
    class DataEngineView {
        constructor({ document, engine, controller, onChange = () => {}, onApply = () => {}, onTabChange = () => {}, onProtocolOpen, onProtocolClose, onSampleProgress, onSaveProtocolDraft, onSettingsAction, getSourceName, getProtocolReferences = () => [] }) {
            Object.assign(this, { document, engine, controller, onChange, onApply, getProtocolReferences });
            this.listeners = []; this.mappingPage = 0; this.binding = false; this.rebuildDrafts = new WeakMap();
            this.arrayIds = { dataType: 'data-type', endianness: 'endianness', channelsCount: 'channels-count',
                enableHeader: 'chk-header', headerHex: 'frame-header', enableFooter: 'chk-footer', footerHex: 'frame-footer', enableChecksum: 'chk-checksum' };
            this.draft = JSON.parse(JSON.stringify(engine.config.draft ?? engine.serialize())); this.draft.draft = null;
            this.timeoutIds = { idleTimeouts: 'engine-idle-timeout', rawIdleTimeouts: 'engine-raw-idle-timeout' };
            const view = this.el('data-engine'), tabs = [...view.querySelectorAll('.tab-btn')];
            const tabBar = tabs[0].parentNode;
            const desktop = document.defaultView?.matchMedia?.('(min-width: 1680px)');
            tabBar.setAttribute('role', 'tablist');
            const selectTab = button => {
                const overview = Boolean(desktop?.matches);
                view.classList.toggle('engine-overview', overview);
                tabBar.hidden = overview;
                for (const tab of tabs) {
                    const selected = tab === button, panel = this.el(tab.dataset.tab);
                    tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
                    panel.classList.toggle('active', selected); panel.hidden = !overview && !selected;
                    panel.setAttribute('role', overview ? 'region' : 'tabpanel');
                    panel.setAttribute('aria-labelledby', overview ? `${panel.id}-heading` : tab.id);
                }
                onTabChange(button.dataset.tab);
            };
            for (const [index, button] of tabs.entries()) {
                button.id = index === 0 ? 'engine-tab-communication' : `engine-tab-${index - 1}`;
                button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', button.dataset.tab);
                this.listen(button, 'click', () => selectTab(button));
                this.listen(button, 'keydown', event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                    selectTab(tabs[next]); tabs[next].focus?.();
                });
            }
            selectTab(tabs[1]);
            this.listen(desktop, 'change', () => {
                const focused = document.activeElement;
                const focusedPanel = focused?.closest('.tab-content');
                let tab = tabs.find(button => button.classList.contains('active'));
                if (!desktop.matches) {
                    tab = tabs.find(button => button.dataset.tab === focusedPanel?.id) ?? tab;
                }
                selectTab(tab);
                if (desktop.matches && tabBar.contains(focused)) this.el(`${tab.dataset.tab}-heading`).focus({ preventScroll: true });
                if (!desktop.matches && focused?.classList.contains('engine-pane-heading')) tab.focus({ preventScroll: true });
            });
            this.channels = new root.SerialPlotter.EngineChannelView({ document, root: this.el('engine-channel-panel'), controller,
                capture: engine.service, manualMetadata: true,
                onDraft: () => this.status('通道设置待应用'), onChange: () => this.changedChannels() });
            this.editor = new root.SerialPlotter.ProtocolEditorView({ document, root: this.el('protocol-editor-host'),
                embedded: true, onOpen: onProtocolOpen, onClose: onProtocolClose, onSampleProgress,
                onSaveDraft: onSaveProtocolDraft, getSourceName,
                getProtocol: () => this.currentProtocol(), getProtocols: () => this.draft.protocols,
                getWorkerPool: () => this.engine.service.workerPool,
                onLibraryChange: (schemas, selectedId) => this.updateProtocolLibrary(schemas, selectedId),
                getReferences: id => this.protocolReferences(id),
                getEditorState: () => this.engine.config.editorState ?? {},
                onEditorState: state => {
                    const saved = JSON.parse(JSON.stringify(state));
                    this.engine.config.editorState = saved; this.draft.editorState = JSON.parse(JSON.stringify(saved));
                    if (this.engine.config.draft) this.engine.config.draft.editorState = JSON.parse(JSON.stringify(saved));
                    this.onChange();
                },
                onDraft: schema => {
                    if (!this.disposed && this.draft.protocols.some(item => item.id === schema.id)) {
                        this.replaceProtocol(schema); this.markDraft();
                    }
                },
                onApply: async schema => {
                    if (this.disposed || !this.draft.protocols.some(item => item.id === schema.id)) throw new Error('协议已删除或不存在，请重新选择协议');
                    this.replaceProtocol(schema); this.draft.protocolId = schema.id; await this.apply();
                } });
            for (const id of ['engine-mode', 'engine-protocol', 'engine-sync-rate', ...Object.values(this.timeoutIds), ...Object.values(this.arrayIds)])
                this.listen(this.el(id), 'change', () => { if (!this.binding) {
                    if (id === 'engine-mode') {
                        this.collectTimeouts();
                        this.draft.mode = this.el('engine-mode').value;
                        this.renderTimeouts();
                    }
                    this.collect(); this.markDraft(); this.syncVisibility();
                    if (id === 'engine-protocol' || id === 'engine-mode') this.renderMappings();
                } });
            this.listen(this.el('rebuild-history'), 'change', () => {
                this.rebuildDrafts.set(this.engine, this.el('rebuild-history').checked);
                this.status('重建历史设置待应用');
            });
            this.listen(this.el('engine-validate'), 'click', () => onSettingsAction(true));
            this.listen(this.el('engine-apply'), 'click', () => onSettingsAction(false));
            this.listen(this.el('engine-protocol-edit'), 'click', () => this.editor.open(this.currentProtocol() ?? this.draft.protocols[0]));
            this.render();
        }
        el(id) { return this.document.getElementById(id); }
        setEngine(engine) {
            if (engine === this.engine) return;
            this.applyRevision = (this.applyRevision ?? 0) + 1;
            this.editor.close();
            this.engine = engine; this.mappingPage = 0;
            this.channels.setCapture(engine.service);
            this.draft = JSON.parse(JSON.stringify(engine.config.draft ?? engine.serialize()));
            this.draft.draft = null;
            this.el('engine-apply').disabled = false;
            this.render();
        }
        listen(node, name, callback) { node?.addEventListener(name, callback); this.listeners.push(() => node?.removeEventListener(name, callback)); }
        node(tag, text, className) { const node = this.document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
        currentProtocol() { return this.draft.protocols.find(p => p.id === this.draft.protocolId); }
        updateProtocolLibrary(schemas, selectedId) {
            if (this.disposed) return;
            if (!Array.isArray(schemas) || schemas.some(schema => !schema || typeof schema.id !== 'string') ||
                new Set(schemas.map(schema => schema.id)).size !== schemas.length) throw new Error('协议库编号无效或重复');
            this.draft.protocols = JSON.parse(JSON.stringify(schemas));
            this.draft.protocolId = this.draft.protocols.some(schema => schema.id === selectedId) ? selectedId : null;
            this.renderProtocols(); this.renderMappings(); this.markDraft();
        }
        protocolReferences(protocolId) {
            return [...this.draft.mappings.filter(mapping => mapping.protocolId === protocolId ||
                mapping.protocolId === undefined && this.draft.protocols.find(schema => schema.id === protocolId)?.messages.some(message => message.id === mapping.messageId))
                .map(mapping => ({ kind: 'mapping', id: mapping.fieldId ?? mapping.path,
                    label: `${root.SerialPlotter.formatChannelId(mapping.channel)} ← ${mapping.messageId} · ${mapping.path}` })),
            ...this.getProtocolReferences(protocolId)];
        }
        replaceProtocol(schema) {
            const index = this.draft.protocols.findIndex(p => p.id === schema.id);
            if (index < 0) this.draft.protocols.push(schema); else this.draft.protocols[index] = schema;
            this.renderProtocols();
        }
        renderProtocols() {
            const select = this.el('engine-protocol');
            select.replaceChildren(...this.draft.protocols.map(schema => { const option = this.node('option', schema.name ?? schema.id); option.value = schema.id; return option; }));
            if (!this.draft.protocolId) {
                const empty = this.node('option', this.draft.protocols.length ? '请选择协议' : '协议库为空，请新建或添加模板');
                empty.value = ''; select.append(empty);
            }
            select.value = this.draft.protocolId ?? '';
            this.el('engine-protocol-edit').disabled = false;
        }
        render() {
            this.binding = true; this.el('engine-mode').value = this.draft.mode;
            this.renderTimeouts();
            for (const [key, id] of Object.entries(this.arrayIds)) {
                const input = this.el(id); if (input.type === 'checkbox') input.checked = this.draft.array[key]; else input.value = this.draft.array[key];
            }
            this.el('engine-sync-rate').value = this.draft.synchronization.sampleRate;
            this.el('rebuild-history').checked = this.rebuildHistoryDraft();
            this.renderProtocols(); this.syncVisibility(); this.renderMappings(); this.binding = false;
            this.el('engine-applied-mode').textContent = this.engine.mode;
            this.status(this.engine.config.draft ? '草稿待应用' : '当前规则已应用');
        }
        renderTimeouts() {
            for (const [key, id] of Object.entries(this.timeoutIds)) this.el(id).value = this.draft[key][this.draft.mode];
        }
        collectTimeouts() {
            for (const [key, id] of Object.entries(this.timeoutIds)) this.draft[key][this.draft.mode] = this.el(id).value;
        }
        collect() {
            this.draft.mode = this.el('engine-mode').value;
            this.collectTimeouts();
            for (const [key, id] of Object.entries(this.arrayIds)) {
                const input = this.el(id); this.draft.array[key] = input.type === 'checkbox' ? input.checked : input.value;
            }
            this.draft.protocolId = this.el('engine-protocol').value || null;
            this.draft.synchronization.sampleRate = Number(this.el('engine-sync-rate').value);
            return this.draft;
        }
        syncVisibility() {
            this.el('engine-residual-timeout-settings').hidden = this.draft.mode === 'Raw_Data';
            this.el('engine-raw-mode').textContent = { Raw_Data: '原生数据', Data_Array: '数组', Self_Defined_Frame: '自定义帧' }[this.draft.mode];
            this.el('engine-array-settings').hidden = this.draft.mode !== 'Data_Array';
            this.el('engine-protocol-settings').hidden = this.draft.mode !== 'Self_Defined_Frame';
            this.el('engine-protocol-mappings').hidden = this.draft.mode !== 'Self_Defined_Frame';
            this.el('engine-synchronization').hidden = this.draft.mode !== 'Self_Defined_Frame';
            this.el('header-config').hidden = !this.draft.array.enableHeader;
            this.el('footer-config').hidden = !this.draft.array.enableFooter;
        }
        markDraft() {
            this.draftRevision = (this.draftRevision ?? 0) + 1;
            this.engine.config.draft = JSON.parse(JSON.stringify({ ...this.draft, draft: null }));
            this.status('草稿待应用；采集仍使用已应用规则'); this.onChange();
        }
        prepareApply() {
            if (this.draft.mode === 'Self_Defined_Frame' && this.draft.editorState?.navigation?.[this.draft.protocolId]?.unfinishedJson)
                throw new Error('请先在协议编辑器中修正 JSON 草稿');
            const settings = { ...this.collect(), draft: null };
            let required = Number(this.engine.globals.channelsCount);
            if (settings.mode === 'Data_Array') required = Math.max(required, Number(settings.array.channelsCount));
            for (const mapping of settings.mappings) required = Math.max(required, mapping.channel + 1);
            const expansion = this.controller.prepareRawChannelExpansion(required, this.engine.service);
            return { settings, expansion };
        }
        validate() {
            const { settings, expansion } = this.prepareApply();
            return root.SerialPlotter.preflightDataEngine(settings, expansion?.globals ?? this.engine.globals,
                { memoryLimitBytes: this.engine.service.memory.limitBytes }).normalized;
        }
        status(text, error = false) { const status = this.el('engine-status'); status.textContent = text; status.classList.toggle('is-error', error); }
        rebuildHistoryDraft() { return this.rebuildDrafts.get(this.engine) ?? this.engine.globals.rebuildHistory; }
        commitRebuildHistory(engine, rebuild) {
            engine.globals.rebuildHistory = engine.service.rebuildHistory = rebuild;
            if (this.rebuildDrafts.get(engine) === rebuild) this.rebuildDrafts.delete(engine);
        }
        async apply() {
            const revision = this.applyRevision = (this.applyRevision ?? 0) + 1, draftRevision = this.draftRevision ?? 0;
            try {
                const { settings, expansion } = this.prepareApply();
                this.el('engine-apply').disabled = true; this.status('');
                const engine = this.engine, previous = engine.config, rebuild = this.rebuildHistoryDraft();
                const ready = engine.apply(settings, { rebuild, channelExpansion: expansion && {
                    globals: expansion.globals, numberMap: expansion.numberMap,
                    commit: () => this.controller.commitChannelRemap(expansion)
                } });
                if (engine.config !== previous) this.controller.rebindEngineSources(engine.service);
                await ready;
                if (this.disposed || engine.service.disposed) return false;
                this.commitRebuildHistory(engine, rebuild);
                this.controller.rebindEngineSources(engine.service); this.onApply(engine); this.onChange();
                if (revision !== this.applyRevision) return true;
                this.channels.refresh();
                if ((this.draftRevision ?? 0) === draftRevision) {
                    this.engine.config.draft = null; this.draft = this.engine.serialize(); this.render();
                } else { this.markDraft(); this.el('engine-applied-mode').textContent = this.engine.mode; }
                this.onChange();
                return true;
            } catch (error) { if (!this.disposed && revision === this.applyRevision) this.status(error.message, true); throw error; }
            finally { if (!this.disposed && revision === this.applyRevision) this.el('engine-apply').disabled = false; }
        }
        renderMappings() {
            const host = this.el('engine-mappings'), list = this.node('div', undefined, 'engine-mapping-list');
            const title = this.node('div', '字段 → 数值通道', 'section-title');
            title.append(this.node('span', '来源共用', 'scope-badge'));
            const message = this.node('select'), path = this.node('input'), channel = this.node('input');
            const add = this.node('button', '映射'), create = this.node('button', '新建通道并映射');
            path.placeholder = '字段路径，如 position.x / items[0]'; channel.placeholder = 'CH00001';
            path.setAttribute('aria-label', '字段路径'); channel.setAttribute('aria-label', '目标通道编号或名称'); message.setAttribute('aria-label', '来源消息');
            try {
                const compiled = root.SerialPlotter.Protocol.compile(this.currentProtocol());
                for (const item of compiled.messages) { const option = this.node('option', item.name ?? item.id); option.value = item.id; message.append(option); }
            } catch { /* Invalid protocol drafts are edited in the wide editor. */ }
            const action = isNew => {
                try {
                    if (!path.value.trim() || !message.value) throw new Error('请选择消息并输入字段路径');
                    let entry;
                    if (isNew) {
                        let number = Number(this.engine.globals.channelsCount);
                        for (const mapping of this.draft.mappings) number = Math.max(number, mapping.channel + 1);
                        number++;
                        if (number + this.engine.globals.channelDefinitions.length > 65535) throw new Error('通道总数不能超过 65535');
                        entry = { type: 'raw', number };
                    } else entry = this.controller.getChannelRegistry(this.engine.service).resolve(channel.value.trim());
                    if (!entry || entry.type !== 'raw') throw new Error('请选择已有原始字段通道，或新建通道');
                    const mapping = { channel: entry.number - 1, protocolId: this.draft.protocolId,
                        messageId: message.value, path: path.value.trim() };
                    const compiled = root.SerialPlotter.Protocol.compile(this.currentProtocol());
                    const resolved = root.SerialPlotter.resolveProtocolMappingField(compiled, mapping);
                    if (!resolved) throw new Error('字段路径不存在，请在协议编辑器的 Hex 预览中核对');
                    mapping.fieldId = resolved.id;
                    this.draft.mappings = this.draft.mappings.filter(m => m.channel !== mapping.channel || m.messageId !== mapping.messageId);
                    this.draft.mappings.push(mapping); this.renderMappings(); this.channels.refresh(); this.markDraft();
                } catch (error) { this.status(error.message, true); }
            };
            add.type = create.type = 'button'; add.className = create.className = 'btn btn-secondary';
            add.addEventListener('click', () => action(false)); create.addEventListener('click', () => action(true));
            const form = this.node('div', undefined, 'engine-mapping-form'), actions = this.node('div', undefined, 'row');
            actions.append(add, create); form.append(message, path, channel, actions);
            const first = this.mappingPage * 30, mappings = this.draft.mappings.slice(first, first + 30);
            mappings.forEach(mapping => {
                const row = this.node('div', undefined, 'engine-mapping-row');
                const label = this.node('span', `${root.SerialPlotter.formatChannelId(mapping.channel)} ← ${mapping.messageId} · ${mapping.path}`);
                label.title = label.textContent;
                const remove = this.node('button', '移除'); remove.type = 'button'; remove.className = 'btn btn-secondary';
                remove.addEventListener('click', () => { this.draft.mappings.splice(this.draft.mappings.indexOf(mapping), 1); this.renderMappings(); this.markDraft(); });
                row.append(label, remove); list.append(row);
            });
            const previous = this.node('button', '上一页'), next = this.node('button', '下一页');
            previous.className = next.className = 'btn btn-secondary';
            previous.type = next.type = 'button'; previous.disabled = !first; next.disabled = first + 30 >= this.draft.mappings.length;
            previous.addEventListener('click', () => { this.mappingPage--; this.renderMappings(); }); next.addEventListener('click', () => { this.mappingPage++; this.renderMappings(); });
            const pager = this.node('div', undefined, 'sidebar-pager');
            pager.append(previous, this.node('span', `${this.draft.mappings.length} 个映射`), next);
            host.replaceChildren(title, form, list, pager);
            this.renderExpiry();
        }
        renderExpiry() {
            const host = this.el('engine-expiry'); host.replaceChildren();
            for (const channel of new Set(this.draft.mappings.slice(this.mappingPage * 30, this.mappingPage * 30 + 30).map(m => m.channel))) {
                const row = this.node('label', undefined, 'input-group'); row.append(this.node('span', `${root.SerialPlotter.formatChannelId(channel)} 有效期 (s)`));
                const input = this.node('input'); input.type = 'number'; input.min = '0'; input.step = 'any'; input.value = this.draft.synchronization.expiry[channel] ?? 0;
                input.addEventListener('change', () => { this.draft.synchronization.expiry[channel] = Number(input.value); this.markDraft(); }); row.append(input); host.append(row);
            }
        }
        // The channel editor owns row updates; replacing it on every preview
        // removes the input that owns the browser's open native color picker.
        changedChannels() { this.onChange(); }
        dispose() { this.disposed = true; this.applyRevision++; this.listeners.forEach(cleanup => cleanup()); this.channels.dispose(); this.editor.dispose(); }
    }
    root.SerialPlotter ??= {}; root.SerialPlotter.DataEngineView = DataEngineView;
    if (typeof module !== 'undefined') module.exports = { DataEngineView };
})(globalThis);

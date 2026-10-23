/** Global parsing drafts and channel editing remain available in an empty workspace. */
(function(root) {
    class DataEngineView {
        constructor({ document, engine, controller, onChange = () => {}, onApply = () => {}, onLayout = () => {}, getProtocolReferences = () => [] }) {
            Object.assign(this, { document, engine, controller, onChange, onApply, onLayout, getProtocolReferences });
            this.listeners = []; this.mappingPage = 0; this.binding = false;
            this.arrayIds = { dataType: 'data-type', endianness: 'endianness', channelsCount: 'channels-count',
                enableHeader: 'chk-header', headerHex: 'frame-header', enableFooter: 'chk-footer', footerHex: 'frame-footer', enableChecksum: 'chk-checksum' };
            this.draft = JSON.parse(JSON.stringify(engine.config.draft ?? engine.serialize())); this.draft.draft = null;
            const tabs = [...this.el('data-engine').querySelectorAll('.tab-btn')];
            tabs[0].parentNode.setAttribute('role', 'tablist');
            const selectTab = button => {
                for (const tab of tabs) {
                    const selected = tab === button, panel = this.el(tab.dataset.tab);
                    tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
                    panel.classList.toggle('active', selected); panel.hidden = !selected;
                }
                this.onLayout();
            };
            for (const [index, button] of tabs.entries()) {
                button.id = `engine-tab-${index}`; this.el(button.dataset.tab).setAttribute('role', 'tabpanel');
                this.el(button.dataset.tab).setAttribute('aria-labelledby', button.id);
                button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', button.dataset.tab);
                this.listen(button, 'click', () => selectTab(button));
                this.listen(button, 'keydown', event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                    selectTab(tabs[next]); tabs[next].focus?.();
                });
            }
            selectTab(tabs[0]);
            this.channels = new root.SerialPlotter.EngineChannelView({ document, root: this.el('engine-channel-panel'), controller,
                getRegistry: () => controller.getChannelRegistry(), onChange: () => this.changedChannels() });
            const ResizeObserver = document.defaultView?.ResizeObserver ?? root.ResizeObserver;
            if (ResizeObserver) {
                this.layoutObserver = new ResizeObserver(() => { if (!this.disposed) this.onLayout(); });
                // Wrapped controls and font loading can change the space above the list without a window resize.
                const enginePanel = this.el('data-engine');
                for (const node of [enginePanel, enginePanel.children[0], enginePanel.children[1], ...this.channels.root.children])
                    if (node !== this.channels.list) this.layoutObserver.observe(node);
            }
            this.editor = new root.SerialPlotter.ProtocolEditorView({ document, root: this.el('protocol-editor-host'),
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
            for (const id of ['engine-mode', 'engine-protocol', 'engine-sync-rate', ...Object.values(this.arrayIds)])
                this.listen(this.el(id), 'change', () => { if (!this.binding) {
                    this.collect(); this.markDraft(); this.syncVisibility();
                    if (id === 'engine-protocol' || id === 'engine-mode') this.renderMappings();
                } });
            this.listen(this.el('rebuild-history'), 'change', () => {
                engine.globals.rebuildHistory = this.el('rebuild-history').checked;
                engine.service.rebuildHistory = engine.globals.rebuildHistory; this.onChange();
            });
            this.listen(this.el('engine-validate'), 'click', () => { try { this.validate(); this.status('草稿校验通过；应用后生效'); } catch (e) { this.status(e.message, true); } });
            this.listen(this.el('engine-apply'), 'click', () => { void this.apply().catch(() => {}); });
            this.listen(this.el('engine-protocol-edit'), 'click', () => this.editor.open(this.currentProtocol() ?? this.draft.protocols[0]));
            this.render();
        }
        el(id) { return this.document.getElementById(id); }
        minimumHeight() {
            if (!this.channels) return 140;
            const panel = this.el('engine-channels'), engine = this.el('data-engine');
            // Measure inactive controls at the same width, outside the layout, to keep every tab's split identical.
            const probe = panel.hidden || !panel.classList.contains('active');
            if (probe) panel.classList.add('engine-size-probe');
            try {
                const controls = Math.max(0, this.channels.list.getBoundingClientRect().top - panel.getBoundingClientRect().top);
                const style = this.document.defaultView?.getComputedStyle?.(panel);
                return Math.max(140, Math.ceil(engine.children[0].offsetHeight + engine.children[1].offsetHeight +
                    controls + this.channels.minimumListHeight + (parseFloat(style?.paddingBottom) || 0)));
            } finally { if (probe) panel.classList.remove('engine-size-probe'); }
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
            for (const [key, id] of Object.entries(this.arrayIds)) {
                const input = this.el(id); if (input.type === 'checkbox') input.checked = this.draft.array[key]; else input.value = this.draft.array[key];
            }
            this.el('engine-sync-rate').value = this.draft.synchronization.sampleRate;
            this.el('rebuild-history').checked = this.engine.globals.rebuildHistory;
            this.renderProtocols(); this.syncVisibility(); this.renderMappings(); this.binding = false;
            this.el('engine-applied-mode').textContent = this.engine.mode;
            this.status(this.engine.config.draft ? '草稿待应用' : '当前规则已应用');
        }
        collect() {
            this.draft.mode = this.el('engine-mode').value;
            for (const [key, id] of Object.entries(this.arrayIds)) {
                const input = this.el(id); this.draft.array[key] = input.type === 'checkbox' ? input.checked : input.value;
            }
            this.draft.protocolId = this.el('engine-protocol').value || null;
            this.draft.synchronization.sampleRate = Number(this.el('engine-sync-rate').value);
            return this.draft;
        }
        syncVisibility() {
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
        validate() {
            const settings = { ...this.collect(), draft: null };
            let required = Number(this.engine.globals.channelsCount);
            if (settings.mode === 'Data_Array') required = Math.max(required, Number(settings.array.channelsCount));
            for (const mapping of settings.mappings) required = Math.max(required, mapping.channel + 1);
            return root.SerialPlotter.preflightDataEngine(settings, this.controller.previewRawChannels(required),
                { memoryLimitBytes: this.engine.service.memory.limitBytes }).normalized;
        }
        status(text, error = false) { const status = this.el('engine-status'); status.textContent = text; status.classList.toggle('is-error', error); }
        async apply() {
            const revision = this.applyRevision = (this.applyRevision ?? 0) + 1, draftRevision = this.draftRevision ?? 0;
            try {
                const settings = this.validate();
                let required = Number(this.engine.globals.channelsCount);
                if (settings.mode === 'Data_Array') required = Math.max(required, Number(settings.array.channelsCount));
                for (const mapping of settings.mappings) required = Math.max(required, mapping.channel + 1);
                this.controller.ensureRawChannels(required);
                this.el('engine-apply').disabled = true; this.status('正在应用并重建受影响输出…');
                const ready = this.engine.apply(settings); this.controller.rebindEngineSources();
                await ready;
                if (this.disposed || revision !== this.applyRevision) return false;
                this.controller.rebindEngineSources(); this.channels.refresh(); this.onApply();
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
                    } else entry = this.controller.getChannelRegistry().resolve(channel.value.trim());
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
        dispose() { this.disposed = true; this.applyRevision++; this.layoutObserver?.disconnect(); this.listeners.forEach(cleanup => cleanup()); this.channels.dispose(); this.editor.dispose(); }
    }
    root.SerialPlotter ??= {}; root.SerialPlotter.DataEngineView = DataEngineView;
    if (typeof module !== 'undefined') module.exports = { DataEngineView };
})(globalThis);

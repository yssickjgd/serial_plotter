/** Focused protocol editing with visual forms, an editable schema, and source-byte inspection. */
(function (root) {
    'use strict';
    const protocol = () => typeof module !== 'undefined' && module.exports
        ? require('./protocolEngine').Protocol : root.SerialPlotter.Protocol;
    const symbols = () => typeof module !== 'undefined' && module.exports ? require('./reservedNames') : root.SerialPlotter;
    const autocomplete = () => typeof module !== 'undefined' && module.exports ? require('./protocolAutocomplete') : root.SerialPlotter;
    const clone = value => JSON.parse(JSON.stringify(value));
    const fieldTypes = ['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64',
        'float32', 'float64', 'bool', 'enum', 'bytes', 'reserved', 'string', 'struct', 'fixed', 'choice', 'repeat', 'tlv', 'bitfield', 'checksum'];
    const tabs = [['messages', '整帧结构'], ['rules', '规则约束'], ['json', 'JSON']];
    const typeNames = { uint8: '无符号整数 · 1 字节', int8: '有符号整数 · 1 字节', uint16: '无符号整数 · 2 字节', int16: '有符号整数 · 2 字节', uint32: '无符号整数 · 4 字节', int32: '有符号整数 · 4 字节', uint64: '无符号整数 · 8 字节', int64: '有符号整数 · 8 字节', float32: '浮点数 · 4 字节', float64: '浮点数 · 8 字节', bool: '布尔值', enum: '枚举', bytes: '原始字节', reserved: '保留字节', string: '文本', struct: '结构体', fixed: '固定字节', choice: '互斥分支', repeat: '重复段', tlv: 'TLV 段' };
    const model = () => typeof module !== 'undefined' && module.exports ? require('./protocolModel').ProtocolModel : root.SerialPlotter.ProtocolModel;
    const records = () => typeof module !== 'undefined' && module.exports ? require('./protocolRecords') : root.SerialPlotter.ProtocolRecords;
    const messageZh = error => (typeof module !== 'undefined' && module.exports
        ? require('./protocolMessages').protocolMessageZh : root.SerialPlotter.protocolMessageZh)(error);
    typeNames.bitfield = '位段';
    typeNames.checksum = '校验';
    let nextInstance = 0;
    class ProtocolEditorView {
        constructor({ document, root: host, getProtocol, onApply, onDraft, onClose, getProtocols, onLibraryChange, getReferences, getEditorState, onEditorState, getWorkerPool }) {
            Object.assign(this, { document, getProtocol, onApply, onDraft, onClose, getProtocols, onLibraryChange, getReferences, getEditorState, onEditorState, getWorkerPool });
            this.editorState = clone(getEditorState?.() ?? {}); this.editorState.samples ??= {};
            this.history = []; this.future = []; this.collapsed = new Set(); this.leftTab = 'outline'; this.bottomTab = 'layout';
            this.propertyTab = 'basic'; this.pristine = new Map();
            this.host = host ?? document.body;
            this.ownsDialog = this.host.tagName !== 'DIALOG';
            this.dialog = this.ownsDialog ? document.createElement('dialog') : this.host;
            this.dialog.classList.add('protocol-editor');
            this.dialog.setAttribute('aria-modal', 'true');
            this.dialog.setAttribute('aria-label', '自定义协议编辑器');
            this.prefix = 'protocol-editor-' + ++nextInstance;
            this.panels = new Map(); this.tabButtons = new Map(); this.cleanups = []; this.expressionCompletions = [];
            this.disposed = false; this.busy = false; this.opened = false; this.generation = 0;
            this.previewPage = 0; this.bytePage = 0;
            this.activeTab = 'messages'; this.jsonInvalid = false;
            this._build();
            if (this.ownsDialog) this.host.append(this.dialog);
        }
        _node(tag, className = '', text) {
            const node = this.document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }
        _listen(node, name, callback) {
            node.addEventListener(name, callback);
            this.cleanups.push(() => node.removeEventListener(name, callback));
        }
        _button(text, action, callback, className = '') {
            const button = this._node('button', 'protocol-editor-button ' + className, text);
            button.type = 'button';
            if (action) button.setAttribute('data-action', action);
            button.addEventListener('click', () => {
                if (this.disposed || this.busy) return;
                try { callback(); } catch (error) { this._error(error); }
            });
            return button;
        }
        _control(parent, key, title, value, kind, change, choices = []) {
            const label = this._node('label', 'protocol-editor-field');
            if (kind === 'checkbox') label.classList.add('is-checkbox');
            label.append(this._node('span', 'protocol-editor-label', title));
            const input = this._node(kind === 'select' ? 'select' : kind === 'textarea' ? 'textarea' : 'input');
            input.setAttribute('data-control', key); input.setAttribute('aria-label', title);
            if (kind === 'select') {
                const options = choices.map(item => Array.isArray(item) ? item : [item, item]);
                if (value !== undefined && value !== '' && !options.some(item => String(item[0]) === String(value))) options.push([value, value]);
                for (const [optionValue, text] of options) {
                    const option = this._node('option', '', text); option.value = String(optionValue); input.append(option);
                }
            } else if (kind !== 'textarea') input.type = kind === 'checkbox' ? 'checkbox' : 'text';
            else { input.rows = 3; input.spellcheck = false; }
            if (kind === 'checkbox') input.checked = Boolean(value);
            else input.value = value === undefined || value === null ? '' : String(value);
            if (change) input.addEventListener('change', () => {
                if (this.disposed || this.busy) return;
                try { change(kind === 'checkbox' ? input.checked : input.value); input.setAttribute('aria-invalid', 'false'); }
                catch (error) { input.setAttribute('aria-invalid', 'true'); this._error(error); }
            });
            label.append(input); parent.append(label);
            if (kind === 'text' && change && (['frame.lengthFrom', 'field.lengthFrom', 'field.offset', 'field.count', 'field.condition', 'field.selector',
                'field.checksum.start', 'field.checksum.end'].includes(key) || /^branch\.\d+\.expression$/.test(key) ||
                key === 'field.repeatCount' && typeof this.selectedField?.count === 'string')) {
                this.expressionCompletions.push(autocomplete().attachProtocolAutocomplete(input, {
                    container: this.dialog, schema: this.draft, fieldId: this.selectedField?.id, frame: key === 'frame.lengthFrom', property: key
                }));
            }
            return input;
        }
        _controlHelp(input, text) {
            const help = this._node('span', 'hint-text', text);
            help.id = this.prefix + '-help-' + input.getAttribute('data-control').replace(/\./g, '-');
            help.setAttribute('id', help.id);
            input.setAttribute('aria-describedby', help.id); input.parentNode.append(help);
        }
        _build() {
            const header = this._node('header', 'protocol-editor-header');
            const heading = this._node('h2', '', '协议编辑器'); heading.id = this.prefix + '-heading';
            this.dialog.setAttribute('aria-labelledby', heading.id);
            this.libraryHost = this._node('div', 'protocol-edit-actions');
            this.libraryPanel = this._node('div','protocol-edit-panel');
            this.libraryFooter = this._node('div','protocol-template-footer');
            this.libraryPanel.append(this.libraryHost,this.libraryFooter);
            this.applyButton = this._button('应用协议', 'apply', () => { void this.apply(); }, 'btn-primary');
            header.append(heading, this.applyButton, this._button('关闭', 'close', () => this.close()));
            this.workspace = this._node('div', 'protocol-editor-workspace');
            this.leftHost = this._node('aside', 'protocol-editor-components');
            this.leftHost.append(this._node('div','sidebar-section-header config-pane-heading','协议配置'));
            this.selectorHost = this._node('div','protocol-selector');
            const sideNav = this._node('div','protocol-side-tabs'); sideNav.setAttribute('role','tablist'); sideNav.setAttribute('aria-label','协议导航');
            this.leftButtons = new Map();
            for (const [id,title] of [['outline','结构大纲'],['edit','协议与字段编辑']]) {
                const button = this._button(title,null,() => this.selectLeft(id));
                button.setAttribute('data-left-tab',id); button.setAttribute('role','tab');
                button.id=this.prefix + '-left-' + id;button.setAttribute('aria-controls',button.id + '-panel');
                sideNav.append(button);this.leftButtons.set(id,button);
            }
            this.outlineHost = this._node('div','protocol-outline-panel');
            for (const [id,panel] of [['outline',this.outlineHost],['edit',this.libraryPanel]]) {
                panel.id=this.prefix + '-left-' + id + '-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',this.prefix + '-left-' + id);
                const scrolling=id==='edit'?this.libraryHost:panel;
                this._listen(scrolling,'scroll',() => { if (this.draft) this._navigation()[id + 'Scroll'] = scrolling.scrollTop; });
            }
            this.leftHost.append(this.selectorHost,sideNav,this.outlineHost,this.libraryPanel);
            this._listen(sideNav,'keydown',event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault();this.selectLeft(event.key==='Home'?'outline':event.key==='End'?'edit':this.leftTab==='outline'?'edit':'outline');this.leftButtons.get(this.leftTab).focus(); } });
            const center = this._node('main', 'protocol-editor-center');
            const nav = this._node('div', 'protocol-editor-tabs'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', '协议配置');
            const body = this._node('div', 'protocol-editor-body'); this.body = body;
            for (const [id, title] of tabs) {
                const button = this._button(title, null, () => this.selectTab(id));
                button.id = this.prefix + '-tab-' + id; button.setAttribute('role', 'tab'); button.setAttribute('data-tab', id);
                button.setAttribute('aria-controls', this.prefix + '-panel-' + id); nav.append(button); this.tabButtons.set(id, button);
                const panel = this._node('section', 'protocol-editor-panel'); panel.id = this.prefix + '-panel-' + id;
                panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
                this.panels.set(id, panel); body.append(panel);
            }
            center.append(nav, body); this.propertyHost = this._node('aside', 'protocol-editor-properties');
            const centerColumn = this._node('div', 'protocol-editor-center-column');
            this.workspace.append(this.leftHost, this._splitter('left'), centerColumn, this._splitter('right'), this.propertyHost);
            this.bottom = this._node('section', 'protocol-editor-bottom');
            const bottomNav = this._node('div', 'protocol-editor-tabs'); bottomNav.setAttribute('role', 'tablist'); bottomNav.setAttribute('aria-label', '验证与字节');
            this.bottomPanels = new Map(); this.bottomButtons = new Map();
            for (const [id, title] of [['layout', '字节布局'], ['preview', '样例解析'], ['issues', '问题列表']]) {
                const button = this._button(title, null, () => this.selectBottom(id)); button.setAttribute('role', 'tab'); button.setAttribute('data-bottom-tab', id);
                button.id = this.prefix + '-bottom-' + id; button.setAttribute('aria-controls', button.id + '-panel');
                bottomNav.append(button); this.bottomButtons.set(id, button);
                const panel = this._node('div', 'protocol-bottom-panel'); panel.id = button.id + '-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
                this.bottomPanels.set(id, panel);
            }
            this.panels.set('preview', this.bottomPanels.get('preview'));
            this.bottom.append(bottomNav, ...this.bottomPanels.values());
            this.alert = this._node('p', 'protocol-editor-error'); this.alert.setAttribute('role', 'alert');
            this.status = this._node('p', 'protocol-editor-status'); this.status.setAttribute('role', 'status');
            const footer = this._node('footer', 'protocol-editor-footer'); footer.append(this.status, this._node('span', 'hint-text', 'Alt + ↑ / ↓ 移动字段 · Ctrl + Enter 应用'));
            centerColumn.append(center, this._splitter('bottom'), this.bottom);
            this.dialog.append(header, this.workspace, this.alert, footer);
            this._buildDeleteDialog();
            this._listen(nav, 'keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                const index = tabs.findIndex(tab => tab[0] === this.activeTab);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                event.preventDefault(); this.selectTab(tabs[next][0]); this.tabButtons.get(tabs[next][0]).focus();
            });
            this._listen(bottomNav, 'keydown', event => {
                if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                const ids = [...this.bottomButtons.keys()], next = ids[(ids.indexOf(this.bottomTab) + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
                event.preventDefault(); this.selectBottom(next); this.bottomButtons.get(next).focus();
            });
            this._listen(this.dialog, 'keydown', event => {
                event.stopPropagation();
                if (event.key === 'Escape' && (this.dragged || this.draggedBranch)) { event.preventDefault(); this._cancelDrag(); }
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void this.apply(); }
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(event.target?.tagName)) { event.preventDefault(); this._undo(event.shiftKey); }
            });
            this._listen(this.dialog, 'keyup', event => event.stopPropagation());
            this._listen(this.dialog, 'cancel', event => { event.preventDefault(); if (this.dragged || this.draggedBranch) this._cancelDrag(); else this.close(); });
            this._listen(this.dialog, 'close', () => { if (this.opened) this.close(); });
            this._listen(this.propertyHost, 'scroll', () => this.expressionCompletions.forEach(item => item.close()));
            if (this.document.defaultView?.addEventListener) this._listen(this.document.defaultView, 'resize', () => this.expressionCompletions.forEach(item => item.close()));
            this.selectTab('messages'); this.selectBottom(this.editorState.bottomTab ?? 'layout');
            this._applySizes();
        }
        _splitter(side) {
            const node = this._node('div', 'protocol-editor-splitter protocol-splitter-' + side);
            node.setAttribute('role', 'separator'); node.setAttribute('aria-label', side === 'bottom' ? '调整验证区域高度' : side === 'left' ? '调整组件区域宽度' : '调整属性区域宽度');
            node.setAttribute('aria-orientation', side === 'bottom' ? 'horizontal' : 'vertical'); node.tabIndex = 0;
            const resize = delta => {
                const sizes = this.editorState.sizes ??= {}, defaults = { left: 190, right: 300, bottom: 245 };
                const minimum = side === 'bottom' ? 120 : 150, maximum = side === 'bottom' ? 480 : 480;
                sizes[side] = Math.max(minimum, Math.min(maximum, (sizes[side] ?? defaults[side]) + delta));
                this._applySizes(); this._saveState();
            };
            node.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); resize(['ArrowRight', 'ArrowDown'].includes(event.key) ? 16 : -16); } });
            node.addEventListener('pointerdown', event => {
                event.preventDefault(); node.setPointerCapture?.(event.pointerId); let last = side === 'bottom' ? event.clientY : event.clientX;
                const move = next => { const value = side === 'bottom' ? next.clientY : next.clientX; resize((value - last) * (side === 'left' ? 1 : -1)); last = value; };
                const end = () => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', end); node.removeEventListener('pointercancel', end); };
                node.addEventListener('pointermove', move); node.addEventListener('pointerup', end); node.addEventListener('pointercancel', end);
            }); return node;
        }
        _applySizes() {
            const sizes = this.editorState.sizes ?? {};
            for (const [key, fallback] of [['left', 190], ['right', 300], ['bottom', 245]]) {
                const value = Number(sizes[key]) || fallback;
                this.dialog.style.setProperty?.('--protocol-' + key, Math.max(120, Math.min(480, value)) + 'px');
            }
        }
        _saveState() { this.onEditorState?.(clone(this.editorState)); }
        _buildDeleteDialog() {
            this.deleteDialog=this._node('dialog','protocol-delete-dialog');
            const title=this._node('h2','','确认删除');title.id=this.prefix+'-delete-title';this.deleteDialog.setAttribute('aria-labelledby',title.id);
            this.deleteMessage=this._node('p');this.deleteMessage.id=this.prefix+'-delete-message';this.deleteDialog.setAttribute('aria-describedby',this.deleteMessage.id);
            const actions=this._node('div','widget-delete-actions');
            actions.append(this._button('取消','cancel-delete',()=>{this.pendingDelete=null;this.deleteDialog.close();}),this._button('确认删除','confirm-delete',()=>{
                const pending=this.pendingDelete;this.pendingDelete=null;this.deleteDialog.close();
                if(pending&&pending.protocolId===this.draft.id)this._performDelete(pending.kind,pending.id);
            },'btn-danger'));
            this.deleteDialog.append(title,this.deleteMessage,actions);this.dialog.append(this.deleteDialog);
            this._listen(this.deleteDialog,'cancel',event=>{event.preventDefault();event.stopPropagation();this.pendingDelete=null;this.deleteDialog.close();});
            this._listen(this.deleteDialog,'keydown',event=>event.stopPropagation());
        }
        _trackNew(kind,id) {
            const node=kind==='protocol'?this.draft:model().findNode(this.draft,id);
            if(node)this.pristine.set(kind+':'+this.draft.id+':'+id,{kind,id,protocolId:this.draft.id,value:JSON.stringify(node)});
        }
        _checkPristine() {
            for(const [key,item] of this.pristine)if(item.protocolId===this.draft.id){
                const node=item.kind==='protocol'?this.draft:model().findNode(this.draft,item.id);
                if(!node||JSON.stringify(node)!==item.value)this.pristine.delete(key);
            }
        }
        _protocolReferenced(id) {
            const refs=this.getReferences?.(id) ?? [], count=typeof refs==='number'?refs:refs.length;
            if(!count)return false;
            const labels=Array.isArray(refs)?refs.slice(0,10).map((ref,index)=>typeof ref==='string'?ref:ref.label??ref.name??ref.ruleId??'引用 '+(index+1)).join('；'):'';
            this._error(new Error('此协议被 '+count+' 条规则引用，请先解除引用。'+(labels?' 引用位置：'+labels+(count>10?'；另 '+(count-10)+' 处引用':''):'')));return true;
        }
        _requestDelete(kind,id) {
            if(this.busy||this.disposed||this.pendingDelete||!this._hasActiveProtocol())return;
            if(kind==='protocol'&&this._protocolReferenced(id))return;
            const node=kind==='protocol'?this.draft:model().findNode(this.draft,id);if(!node)return;
            this._checkPristine();
            if(this.pristine.has(kind+':'+this.draft.id+':'+id)){this._performDelete(kind,id);return;}
            const ids=new Set();const walk=item=>{if(!item||typeof item!=='object')return;if(item.id)ids.add(item.id);for(const value of Object.values(item))if(value&&typeof value==='object')walk(value);};walk(node);
            let references=[];if(kind!=='protocol')for(const fieldId of ids)references.push(...model().inspectReferences(this.draft,fieldId).filter(ref=>!ids.has(ref.nodeId)));
            this.deleteMessage.textContent='确定删除'+(kind==='protocol'?'协议':kind==='branch'?'分支':'字段')+'“'+(node.name||node.label||node.id)+'”吗？'+
                (ids.size>1?' 将同时移除其中的 '+(ids.size-1)+' 个子项。':'')+
                (references.length?' 有 '+references.length+' 处外部引用；删除后需修正失效引用才能应用。':'')+' 可以撤销。';
            this.pendingDelete={kind,id,protocolId:this.draft.id};this.deleteDialog.showModal();
            this.deleteDialog.querySelector('[data-action="cancel-delete"]')?.focus();
        }
        _librarySnapshot() { this._publish();return {_libraryUndo:true,library:clone(this.library),schema:clone(this.draft),empty:this.emptyLibrary}; }
        _performDelete(kind,id) {
            if(kind==='protocol'){
                if(this._protocolReferenced(id))return;
                const snapshot=this._librarySnapshot();this.history.push(snapshot);this.future=[];
                this.library=this.library.filter(item=>item.id!==id);this.generation++;
                const history=this.history;
                if(this.library.length){this.emptyLibrary=false;this.libraryId=this.library[0].id;this._restoreDraft(this.library[0]);this.history=history;this._renderLibrary();}
                else{this.emptyLibrary=true;this._render();this.onLibraryChange?.([],null);}
            }else if(kind==='branch'||kind==='bit'){
                const key=kind==='branch'?'branches':'bits';
                const owner=this._fieldRows().map(row=>row.field[key]).find(items=>items?.some(node=>node.id===id));
                if(!owner)return;
                this._change(()=>{owner.splice(owner.findIndex(node=>node.id===id),1);this.outlineSelection=null;});
            }else{
                const row=this._fieldRows().find(item=>item.field.id===id);if(!row)return;
                this._change(()=>{row.owner.splice(row.owner.indexOf(row.field),1);this.selectedField=null;this.outlineSelection=null;});
            }
        }
        _navigation() {
            if(!this.editorState.navigation||typeof this.editorState.navigation!=='object'||Array.isArray(this.editorState.navigation))this.editorState.navigation={};
            const all=this.editorState.navigation,id=this.draft.id;
            if(!Object.hasOwn(all,id)||!all[id]||typeof all[id]!=='object'||Array.isArray(all[id]))
                Object.defineProperty(all,id,{value:{closed:[],leftTab:'outline',propertyTab:'basic'},writable:true,configurable:true,enumerable:true});
            if(!Array.isArray(all[id].closed))all[id].closed=[];
            return all[id];
        }
        selectLeft(id) {
            if (!this.leftButtons.has(id)) return;
            const changing=this.leftTab!==id;
            this.leftTab=id;
            for (const [key,button] of this.leftButtons) { button.setAttribute('aria-selected',String(key===id));button.tabIndex=key===id?0:-1; }
            this.outlineHost.hidden=id!=='outline';this.libraryPanel.hidden=id!=='edit';
            if(changing&&this.draft)(id==='outline'?this.outlineHost:this.libraryHost).scrollTop=this._navigation()[id+'Scroll'] ?? 0;
            if (this.draft) { this._navigation().leftTab=id;this._saveState(); }
        }
        _restoreNavigationScroll(state) {
            this.outlineHost.scrollTop=state.outlineScroll ?? 0;
            this.libraryHost.scrollTop=state.editScroll ?? 0;
            if(this.propertyScroll)this.propertyScroll.scrollTop=state.propertyScroll?.[this.propertyTab] ?? 0;
        }
        selectBottom(id) {
            if (!this.bottomPanels.has(id)) return; this.bottomTab = id; this.editorState.bottomTab = id;
            for (const [key, panel] of this.bottomPanels) { panel.hidden = key !== id; this.bottomButtons.get(key).setAttribute('aria-selected', String(key === id)); this.bottomButtons.get(key).tabIndex = key === id ? 0 : -1; }
            this._saveState();
        }
        open(schema = this.getProtocol?.()) {
            if (this.disposed || this.busy) return;
            this.library = clone(this.getProtocols?.() ?? (schema ? [schema?._compiledProtocol ? schema.schema : schema] : []));
            this.emptyLibrary = Boolean(this.getProtocols && !schema && !this.library.length);
            this.draft = clone(schema?._compiledProtocol ? schema.schema : schema ?? {
                id: 'custom', endian: 'little', framing: { header: [170], footer: [13, 10], maxLength: 1048576 },
                command: { offset: 1, type: 'uint8' }, payloadOffset: 2,
                messages: [{ id: 'message1', name: '消息 1', command: 1, fields: [] }]
            });
            try { this.draft = model().toUnified(this.draft); } catch (_) { this.draft = model().normalizeIds(this.draft); }
            this.libraryId = this.draft.id; this.pendingPreset = null;
            if (!this.emptyLibrary && !this.library.some(item => item.id === this.draft.id)) this.library.push(clone(this.draft));
            this.selectedMessage = this.draft.messages?.[0]; this.selectedField = null; this.headerSelected = false; this.framingSelected = false; this.pendingConstraint = null;
            const legacyPayload = this.selectedMessage?.fields?.find(field => field.legacyPayload);
            if (legacyPayload) this.selectedField = legacyPayload.branches?.find(branch => branch.legacyMessage)?.fields?.[0] ?? null;
            this.previewPage = this.bytePage = 0;
            this.previewRecord = null; this.previewBytes = null; this.selectedSpan = null;
            this.sampleHex = ''; this.sampleValues = '{}'; this.sampleId = ''; this.sampleName = ''; this.sampleResults = []; this.jsonInvalid = false;
            this.status.textContent = ''; this.generation++; this.opened = true; this.history = []; this.future = [];
            this.editorState = clone(this.getEditorState?.() ?? this.editorState); this.editorState.samples ??= {};
            this.pristine.clear();this.outlineSelection=null;
            this.leftTab=this._navigation().leftTab === 'edit'?'edit':'outline';this.propertyTab=this._navigation().propertyTab ?? 'basic';
            const navigation=clone(this._navigation());
            this.canvas = null; this.propertyHost.scrollTop = 0; this.body.scrollTop = 0;
            this._render(); this.selectTab('messages'); this.selectBottom(this.editorState.bottomTab ?? 'layout'); this._applySizes();
            if (!this.dialog.open) this.dialog.showModal();
            this._restoreNavigationScroll(navigation);
            this.tabButtons.get('messages').focus();
        }
        close() {
            if (!this.opened) return;
            this.opened = false; this.generation++;
            this.expressionCompletions.forEach(item => item.close());
            if (this.deleteDialog.open) this.deleteDialog.close();this.pendingDelete=null;this._saveState();
            if (this.dialog.open) this.dialog.close();
            this.onClose?.();
        }
        dispose() {
            if (this.disposed) return;
            this.disposed = true; this.close(); this.cleanups.splice(0).forEach(cleanup => cleanup());
            this.expressionCompletions.splice(0).forEach(item => item.destroy());
            if (this.ownsDialog) this.dialog.remove(); else this.dialog.replaceChildren();
        }
        selectTab(id) {
            if (id === 'preview') { this.selectBottom('preview'); return; }
            if (id === 'framing') {
                this.framingSelected = true; this.selectedField = null; id = 'messages';
                if (this.draft) { this.propertyHost.scrollTop = 0; this._renderMessages(); }
            }
            if (!this.panels.has(id) || this.disposed) return;
            this.activeTab = id;
            for (const [key, button] of this.tabButtons) {
                button.setAttribute('aria-selected', String(key === id)); button.tabIndex = key === id ? 0 : -1;
                this.panels.get(key).hidden = key !== id;
            }
            if (this.draft) {
                if (id === 'rules') this._renderRules();
                else if (id === 'messages') this._renderMessages();
            }
        }
        _error(error) {
            if (this.disposed) return;
            this.alert.textContent = messageZh(error); this.alert.hidden = false;
        }
        _validate() {
            try {
                this.compiled = protocol().compile(this.draft);
                this.validationError = null;
                // Fill identities in place so selections and shared structure references remain intact.
                const pending = [[this.draft, this.compiled.schema]];
                while (pending.length) {
                    const [source, canonical] = pending.pop();
                    if (!source || !canonical || typeof source !== 'object' || typeof canonical !== 'object') continue;
                    if (!source.id && canonical.id) source.id = canonical.id;
                    for (const key of Object.keys(source)) if (source[key] && typeof source[key] === 'object') pending.push([source[key], canonical[key]]);
                }
                this.alert.textContent = ''; this.alert.hidden = true;
            } catch (error) { this.compiled = null; this.validationError = error; this._error(error); }
            this.applyButton.disabled = !this.compiled || this.jsonInvalid || this.busy || this.emptyLibrary;
        }
        _change(action) {
            if (this.disposed || this.busy) return;
            if (this.jsonInvalid) throw new Error('请先修复 JSON 草稿，再修改可视化字段');
            const before = clone(this.draft);
            action(); this.history.push(before); if (this.history.length > 100) this.history.shift(); this.future = []; this.generation++;
            this.status.textContent = '草稿已修改，尚未应用';
            this.previewRecord = null; this.selectedSpan = null;
            this._render(); this._checkPristine(); this._publish();
        }
        _expression(value) {
            if (!value.trim()) return undefined;
            const number = Number(value);
            return Number.isFinite(number) ? number : value.trim();
        }
        _number(value, title, optional = false) {
            if (optional && !value.trim()) return undefined;
            const number = Number(value);
            if (!value.trim() || !Number.isFinite(number)) throw new Error(title + '必须是有限数值');
            return number;
        }
        _dataBase(field) { return records().protocolNumberBase(field); }
        _integer(value, title, base = 'dec') { return records().parseProtocolInteger(value, base, title); }
        _integerText(value, base = 'dec') { return records().protocolValueText(value, { displayBase: base }); }
        _setDataBase(field, value) {
            if (!['dec','hex'].includes(value)) throw new Error('请选择十进制或十六进制');
            this._change(() => { field.displayBase = value; });
            if (this.previewBytes && this.compiled) {
                this.previewRecord = protocol().decode(this.previewBytes, this.compiled);
                this._renderPreviewResults();
            }
        }
        _hasActiveProtocol() {
            return !this.emptyLibrary && Boolean(this.draft?.id) && this.libraryId === this.draft.id && this.library.some(item => item.id === this.draft.id);
        }
        _assign(object, key, value) { if (value === undefined || value === '') delete object[key]; else object[key] = value; }
        _hex(value) {
            const text = value.replace(/0x/gi, '').replace(/\s+/g, '');
            if (!/^(?:[\da-f]{2})*$/i.test(text)) throw new Error('Hex 必须由完整的两位十六进制字节组成');
            if (text.length > 2097152) throw new Error('Hex 样例超过 1 MiB');
            return Array.from(text.match(/../g) ?? [], token => parseInt(token, 16));
        }
        _hexText(bytes) { return Array.from(bytes ?? [], value => value.toString(16).padStart(2, '0').toUpperCase()).join(' '); }
        _section(parent, title, className = '') {
            const section = this._node('section', 'protocol-editor-section ' + className);
            section.append(this._node('h3', '', title)); parent.append(section); return section;
        }
        _render() {
            const focus = this.document.activeElement, key = focus?.getAttribute?.('data-control'), start = focus?.selectionStart, end = focus?.selectionEnd;
            const scroll = [this.leftHost, this.propertyHost, this.body, ...this.panels.values()].map(node => [node, node.scrollTop, node.scrollLeft]);
            const editingTop=this.libraryHost.scrollTop;
            const expanded = [...this.dialog.querySelectorAll('details')].map(node => [node.getAttribute('data-detail'), node.open]);
            this._validate(); this._renderLibrary(); this._renderMessages();
            this._renderJson(); this._renderPreview(); this._renderDiagnostics(); this._renderLayout();
            this._renderRules();
            this.libraryHost.scrollTop=editingTop;
            for (const [node, top, left] of scroll) { node.scrollTop = top; node.scrollLeft = left; }
            for (const [id, open] of expanded) { const node = this.dialog.querySelector('[data-detail="' + id + '"]'); if (node) node.open = open; }
            if (key) { const next = [...this.dialog.querySelectorAll('[data-control]')].find(node => node.getAttribute('data-control') === key); next?.focus(); if (typeof start === 'number' && next?.setSelectionRange) { try { next.setSelectionRange(start, end); } catch (_) { /* Selects have no text caret. */ } } }
        }
        _openRule(id) {
            this.selectedRuleId = id; this.selectTab('rules');
            this.propertyHost.scrollTop = 0;
        }
        _addConstraint(type, field = null) {
            this._change(() => {
                const rules = this.draft.rules ??= [], occupied = new Set(rules.map(rule => rule.id));
                for (const row of this._fieldRows()) occupied.add(row.field.id);
                let index = 1; while (occupied.has('rule-' + index)) index++;
                const id = 'rule-' + index;
                const rule = { id, name: type === 'length' ? '长度一致性' : type === 'checksum' ? '校验规则' : '表达式断言',
                    type, enabled: true, stage: 'validation', strength: 'weak', send: 'verify' };
                if (type === 'checksum') {
                    if (field) rule.targetFieldId = field.id;
                    rule.checksum = { type: 'sum', start: 0, end: field ? { fieldId: field.id, edge: 'start' } : 0 };
                } else rule.expression = '';
                rules.push(rule); this.selectedRuleId = id;
            });
            this.selectTab('rules');
        }
        _renderRules() {
            const panel = this.panels.get('rules'); if (!panel || !this.draft) return;
            if (this.activeTab !== 'rules') return;
            this.propertyHost.classList.remove('has-field-inspector');
            this.expressionCompletions.splice(0).forEach(item => item.destroy());
            panel.replaceChildren();
            this._renderLeft(this._fieldRows());
            const toolbar = this._node('div', 'protocol-editor-toolbar');
            for (const [type, label] of [['length', '添加长度验证'], ['checksum', '添加校验'], ['assert', '添加表达式断言']])
                toolbar.append(this._button(label, 'add-rule-' + type, () => this._addConstraint(type)));
            panel.append(toolbar, this._node('p', 'hint-text', '附加检查默认弱规则：失败仍输出数值并标记警告。结构中的长度决定怎样读取字节，规则约束检查读取结果。'));
            const rules = this.draft.rules ?? [];
            const stages = { parsing: '解析阶段', validation: '完整帧验证', both: '两个阶段' };
            for (const rule of rules) {
                const row = this._node('div', 'protocol-constraint-row'); row.setAttribute('data-rule-id', rule.id);
                const button = this._button(rule.name || rule.id, null, () => this._openRule(rule.id));
                button.setAttribute('aria-pressed', String(this.selectedRuleId === rule.id));
                row.append(button, this._node('span', 'hint-text', `${rule.enabled === false ? '已禁用 · ' : ''}${stages[rule.stage ?? 'validation']} · ${rule.strength === 'strong' ? '强规则' : '弱规则'} · ${rule.send === 'fill' ? '自动回填' : '仅验证'}`));
                row.append(this._button('删除', 'delete-rule-' + rule.id, () => this._change(() => {
                    this.draft.rules = rules.filter(item => item !== rule); this.selectedRuleId = null;
                })));
                panel.append(row);
            }
            const legacy = this._fieldRows().filter(row => row.field.type === 'checksum' || model().getLengthBindings(this.draft, row.field.id).length);
            if (legacy.length) {
                const section = this._section(panel, '现有解析规则', 'protocol-legacy-rules');
                section.append(this._node('p', 'hint-text', '保留原协议的边界和校验行为。长度关联用于断帧；旧校验可显式转为独立规则后设置阶段、强弱和回填。'));
                for (const row of legacy) {
                    const line = this._node('div', 'protocol-constraint-row');
                    line.append(this._button(row.path + (row.field.type === 'checksum' ? ' · 校验' : ' · 解析长度关联'), null, () => {
                        this.selectTab('messages'); this._selectField(row.field);
                    }));
                    if (row.field.type === 'checksum') line.append(this._button('转为独立规则', 'convert-rule-' + row.field.id, () => {
                        const candidate = clone(this.draft), field = model().findField(candidate, row.field.id), list = candidate.rules ??= [];
                        let id = 'check-' + field.id; while (list.some(rule => rule.id === id) || model().findNode(candidate, id)) id += '-1';
                        list.push({ id, name: row.path + ' 校验', type: 'checksum', enabled: true,
                            stage: 'both', strength: 'strong', send: 'fill', targetFieldId: field.id,
                            checksum: clone(field.checksum ?? { type: 'sum', start: 0, end: { fieldId: field.id, edge: 'start' } }) });
                        field.type = 'uint' + field.byteLength * 8; delete field.checksum;
                        // Never replace a valid scoped legacy rule with an invalid root-scope rule.
                        try { protocol().compile(candidate); }
                        catch (error) { throw new Error('暂不能直接转换，原校验保持不变。请先将局部覆盖表达式改为明确的字段边界引用：' + error.message); }
                        this._change(() => {
                            this.draft = candidate; this.selectedMessage = candidate.messages[0];
                            this.selectedField = model().findField(candidate, this.selectedField?.id);
                            this.selectedRuleId = id;
                        });
                    }));
                    section.append(line);
                }
            }
            if (this.activeTab !== 'rules') return;
            this.propertyHost.replaceChildren();
            const rule = rules.find(item => item.id === this.selectedRuleId);
            if (!rule) { this.propertyHost.append(this._node('p', 'hint-text', '选择一条规则，或添加长度验证、校验、表达式断言。')); return; }
            const section = this._section(this.propertyHost, '规则属性', 'protocol-constraint-properties');
            const set = (key, value) => this._change(() => { if (value === undefined) delete rule[key]; else rule[key] = value; });
            this._control(section, 'rule.name', '规则名称', rule.name ?? rule.id, 'text', value => set('name', value));
            this._control(section, 'rule.enabled', '启用规则', rule.enabled !== false, 'checkbox', value => set('enabled', value));
            this._control(section, 'rule.stage', '参与阶段', rule.stage ?? 'validation', 'select', value => set('stage', value), Object.entries(stages));
            this._control(section, 'rule.strength', '规则强度', rule.strength ?? 'weak', 'select', value => set('strength', value), [['weak', '弱规则：警告并继续输出'], ['strong', '强规则：失败不输出数值']]);
            const expr = (key, title, value, change) => {
                const input = this._control(section, 'rule.' + key, title, value, 'text', change);
                this.expressionCompletions.push(autocomplete().attachProtocolAutocomplete(input, { container: this.dialog, schema: this.draft, frame: true, constraint: true, property: 'rule.' + key }));
                return input;
            };
            expr('condition', '启用条件（留空始终检查）', rule.condition ?? '', value => set('condition', value.trim() || undefined));
            if (rule.boundaryFallback === undefined && rule.type !== 'checksum') expr('expression', '验证表达式', rule.expression, value => set('expression', value));
            if (rule.boundaryFallback !== undefined) this._control(section, 'rule.boundaryFallback', '表达式用途', rule.boundaryFallback ? 'boundary' : 'verify', 'select', value => set('boundaryFallback', value === 'boundary'), [['verify','仅验证'], ['boundary','解析定界＋验证']]);
            this._control(section, 'rule.send', '发送行为', rule.send ?? 'verify', 'select', value => set('send', value), [['verify', '仅验证'], ['fill', '自动回填并验证']]);
            const rows = this._fieldRows(), integers = rows.filter(row => /^u?int(?:8|16|32|64)$/.test(row.field.type) && row.field.count === undefined);
            if (rule.send === 'fill' || rule.type === 'checksum' || rule.boundaryFallback !== undefined) this._control(section, 'rule.targetFieldId', rule.type === 'checksum' ? '校验值字段' : '值所属字段', rule.targetFieldId ?? '', 'select', value => this._change(() => {
                rule.targetFieldId = value; this._syncLengthValueRule(rule);
            }), [['', '请选择字段'], ...integers.map(row => [row.field.id, row.path])]);
            if ((rule.send === 'fill' || rule.boundaryFallback !== undefined) && rule.type !== 'checksum') expr('value', rule.boundaryFallback !== undefined ? '本字段的值表达式' : '回填值表达式', rule.value ?? '', value => this._change(() => {
                rule.value = value; this._syncLengthValueRule(rule);
            }));
            if (rule.type === 'checksum') {
                const config = rule.checksum ?? {};
                const edit = (key, value) => this._change(() => { (rule.checksum ??= {})[key] = value; });
                this._renderChecksumConfig(section,config,edit,'rule.checksum',model().findField(this.draft,rule.targetFieldId));
            }
            section.append(this._node('p', 'hint-text', '表达式使用整帧字段路径，LEN(payload) 返回实际编码字节数。强规则失败：完整边界可靠时保留错误帧并跳过，不可靠时重新同步。'));
            const related = rows.filter(row => model().inspectReferences(this.draft, row.field.id).some(ref => ref.nodeId === rule.id));
            if (related.length) {
                const links = this._section(this.propertyHost, '关联字段', 'protocol-rule-links');
                for (const row of related) links.append(this._button(row.path, null, () => { this.selectTab('messages'); this._selectField(row.field); }));
            }
        }
        _setFrameLengthExpression(frame, value) {
            const sources = this._fieldRows().map(row => row.field).filter(field => field.role === 'length' &&
                model().inspectReferences(this.draft, field.id).some(reference => reference.nodeId === frame.id &&
                    ['lengthFrom', 'lengthSource.fieldId'].includes(reference.property)));
            delete frame.lengthSource;
            frame.byteLength = 0;
            if (value === null) delete frame.lengthFrom; else frame.lengthFrom = value;
            for (const field of sources) if (!model().getLengthBindings(this.draft, field.id).length &&
                !model().inspectReferences(this.draft, field.id).some(reference => reference.nodeId === frame.id && reference.property === 'lengthFrom'))
                field.role = 'data';
        }
        _renderFrameDetails(panel) {
            const frame = this.draft.messages[0];
            const section = this._section(panel, '整帧属性');
            const source = frame.lengthSource;
            const path = source && this._fieldRows().find(row => row.field.id === source.fieldId)?.path;
            const text = frame.byteLength > 0 ? String(frame.byteLength) : frame.lengthFrom ??
                (path ? `(${path}) * ${source.unit ?? 1} + (${source.adjustment ?? 0})` : '0');
            const owners = this._lengthRuleOwners(frame);
            const input = this._control(section, 'frame.lengthFrom', '整帧长度表达式', text, 'text', source || owners.length ? null : value => this._change(() => {
                this._setFrameLengthExpression(frame, value.trim() === '0' ? null : value.trim());
            }));
            input.readOnly = Boolean(source || owners.length);
            input.placeholder = '0 表示变长；例如：32、data_length + 9、LEN(payload) + 9';
            if (source || owners.length) this._renderLengthSource(section, frame);
            section.append(this._node('p', 'hint-text', '以字节为单位：0 表示变长，按内部字段的长度或边界规则确定；留空非法。正整数或常量运算表示固定长度，如 32、16 + 8；其它表达式的结果必须是正整数，且不超过最大帧长。'));
            section.append(this._node('p', 'hint-text', '可填写 data_length + 9，或用 LEN(payload) 取得可独立确定边界的数据段字节数；不能循环引用 FRAME_LENGTH、REMAINING 等整帧边界变量。'));
            section.append(this._node('p', 'hint-text', '单字段 × 正整数 + 修正量可自动回填；若字段同时控制数量、条件或偏移，或使用其它复杂表达式，需填写对应字段值，发送前会校验实际长度。'));
            section.append(symbols().createReservedNamesHelp(this.document, 'field'));
            this._control(section, 'protocol.name', '协议名称', this.draft.name ?? '', 'text', value => this._change(() => { this.draft.name = value; }));
            this._control(section, 'protocol.endian', '默认字节序', this.draft.endian ?? 'little', 'select', value => this._change(() => { this.draft.endian = value; }), [['little', '小端'], ['big', '大端']]);
            this._control(section, 'framing.maxLength', '最大帧长（字节）', this.draft.framing?.maxLength ?? 1048576, 'text', value => this._change(() => {
                (this.draft.framing ??= {}).maxLength = this._number(value, '最大帧长');
            }));
            const advanced=this._section(panel,'高级设置');advanced.setAttribute('data-frame-advanced','');
            this._control(advanced, 'protocol.id', '协议标识（只读）', this.draft.id, 'text').readOnly = true;
        }
        _lengthRuleOwners(field) {
            return this._fieldRows().filter(row => model().isLengthSource(row.field) &&
                this.ruleUsage.get(row.field.id)?.some(usage => usage.id === field.id));
        }
        _renderLengthSource(parent, field) {
            const linked = model().findField(this.draft, field.lengthSource?.fieldId);
            if (linked) {
                const path = this._fieldRows().find(row => row.field.id === linked.id)?.path ?? linked.name;
                parent.append(this._node('p', 'hint-text', `长度来源：${path}。本段字节数 = 字段数值 × ${field.lengthSource.unit ?? 1} + (${field.lengthSource.adjustment ?? 0})；请在长度字段中修改规则。`),
                    this._button('查看长度字段', 'jump-length-source', () => this._jumpToRule(linked, 'length')));
                return;
            }
            if (field.lengthSource) {
                parent.append(this._node('p', 'protocol-field-error', '长度来源字段已失效；解除失效关联后，请在有效长度字段中重新绑定。'),
                    this._button('解除失效关联', 'remove-invalid-length-source', () => this._change(() => { delete field.lengthSource; field.lengthFrom = ''; })));
                return;
            }
            parent.append(this._node('p', 'hint-text', '长度来源表达式：' + (field.lengthFrom ?? field.length)));
            for (const [index, row] of this._lengthRuleOwners(field).entries()) {
                parent.append(this._button('查看长度字段 · ' + row.path, index ? null : 'jump-length-source', () => this._jumpToRule(row.field, 'length')));
            }
        }
        _replaceLengthDraft(next, sourceId) {
            this._change(() => {
                const messageId = this.selectedMessage?.id;
                this.draft = next; this.selectedMessage = next.messages?.find(item => item.id === messageId);
                this.selectedField = model().findField(next, sourceId);
                if (this.selectedField?.role === 'length' && !model().getLengthBindings(next, sourceId).length &&
                    !this._lengthExpressionReferences(this.selectedField).length) delete this.selectedField.role;
            });
        }
        _syncLengthValueRule(rule) {
            if (rule.boundaryFallback === undefined) return;
            const path = this._fieldRows().find(row => row.field.id === rule.targetFieldId)?.path;
            if (path) rule.expression = `${path} == (${rule.value ?? ''})`;
        }
        _renderLengthValue(parent, field) {
            const rules = (this.draft.rules ?? []).filter(rule => rule.type === 'length' && rule.targetFieldId === field.id && rule.boundaryFallback !== undefined);
            for (const rule of rules) {
                const input = this._control(parent, 'length.value', '本字段的值表达式', rule.value ?? '', 'text', value => this._change(() => {
                    rule.value = value; this._syncLengthValueRule(rule);
                }));
                this.expressionCompletions.push(autocomplete().attachProtocolAutocomplete(input, { container: this.dialog, schema: this.draft, frame: true, constraint: true, property: 'rule.value' }));
                this._control(parent, 'length.usage', '表达式用途', rule.boundaryFallback ? 'boundary' : 'verify', 'select', value => this._change(() => {
                    rule.boundaryFallback = value === 'boundary';
                }), [['verify','仅验证'], ['boundary','解析定界＋验证']]);
                this._control(parent, 'length.send', '发送行为', rule.send ?? 'fill', 'select', value => this._change(() => { rule.send = value; }), [['fill','自动回填并验证'], ['verify','仅验证']]);
                this._renderRuleBehavior(parent, rule, 'length');
                parent.append(this._node('p', 'hint-text', '例如 LEN(payload) + LEN(checksum_0)。结构能确定长度时独立解析；否则按表达式求解单个未知长度。多个未知长度、循环或非唯一解会报错。此处与规则约束编辑同一条规则。'),
                    this._button('查看规则约束', 'jump-length-rule', () => this._openRule(rule.id)));
                if (rule.enabled === false) parent.append(this._node('p', 'hint-text', '此规则已禁用。'));
            }
            const legacyRules = this._fieldConstraintRules(field,'length').filter(rule => rule.boundaryFallback === undefined);
            for (const rule of legacyRules) parent.append(this._node('p','hint-text','旧长度规则：' + (rule.name || rule.id)),
                this._button('查看旧长度规则',null,() => this._openRule(rule.id)));
            if (!rules.length && !legacyRules.length && model().isLengthSource(field)) {
                const add = this._button('添加长度值表达式', 'add-length-value', () => this._change(() => {
                    const list = this.draft.rules ??= [];
                    let id = 'length-value-' + field.id; while (list.some(rule => rule.id === id) || model().findNode(this.draft, id)) id += '-1';
                    const rule = { id, name: field.name + ' 长度值', type: 'length', targetFieldId: field.id, value: '',
                        boundaryFallback: false, enabled: true, stage: 'validation', strength: 'weak', send: 'fill' };
                    this._syncLengthValueRule(rule); list.push(rule);
                }));
                const legacy = model().getLengthBindings(this.draft, field.id).length || this._lengthExpressionReferences(field).length;
                add.disabled = Boolean(legacy); parent.append(add);
                if (legacy) parent.append(this._node('p', 'hint-text', '旧协议的解析关联保持生效。先解除旧关联，再添加长度值表达式；不会自动修改你的分支边界。'));
            }
        }
        _renderLengthTargets(parent, field, inline = false) {
            const section = inline ? this._node('div','protocol-length-targets protocol-constraint-controls') : this._section(parent, '长度关联', 'protocol-length-targets');
            if (inline) parent.append(section);
            section.setAttribute('data-rule-group', 'length');
            const canBind = model().isLengthSource(field);
            this._renderLengthValue(section, field);
            if (!canBind) section.append(this._node('p', 'hint-text', '长度表达式引用本字段或其编码字节数；可跳转查看对应规则。'));
            const bindings = model().getLengthBindings(this.draft, field.id);
            bindings.forEach((binding, index) => {
                const row = this._node('div', 'protocol-length-target'); section.append(row);
                const target = model().findNode(this.draft, binding.targetId);
                row.append(this._button((binding.targetKind === 'message' ? '整帧 · ' : '数据段 · ') + binding.label, null, () => {
                    if (binding.targetKind === 'message') { this.framingSelected = true; this.selectedField = null; this._renderMessages(); }
                    else this._selectField(target);
                }));
                row.append(this._node('p', 'hint-text', `旧解析关联（兼容保留）：目标字节数 = 本字段值 × ${binding.unit} + (${binding.adjustment})。`));
                row.append(this._button('解除绑定', `remove-length-target-${index}`, () =>
                    this._replaceLengthDraft(model().unbindLengthTarget(this.draft, field.id, binding.targetId), field.id)));
            });
            const expressions = this._lengthExpressionReferences(field);
            for (const reference of expressions) {
                const target = model().findNode(this.draft, reference.nodeId);
                section.append(this._button('查看长度表达式 · ' + (target?.name ?? (reference.nodeId === this.draft.messages[0]?.id ? '整帧' : reference.nodeId)), null, () => {
                    if (target?.fields && reference.nodeId === this.draft.messages[0]?.id) {
                        this.framingSelected = true; this.selectedField = null; this._renderMessages();
                    } else if (target) this._selectField(target);
                }));
                if (canBind && target) {
                    const input = this._control(section, 'length.expression.' + target.id, '目标长度表达式 · ' + (target.name ?? '整帧'),
                        target[reference.property], 'text', value => this._change(() => { target[reference.property] = value; }));
                    this.expressionCompletions.push(autocomplete().attachProtocolAutocomplete(input, {
                        container: this.dialog, schema: this.draft, fieldId: target.id,
                        frame: target.id === this.draft.messages[0]?.id, property: 'field.lengthFrom'
                    }));
                }
            }
            if (field.role === 'length' && !bindings.length && !expressions.length) section.append(this._button('清除未关联的长度标记', 'clear-length-role', () => this._change(() => { delete field.role; })));
            return section;
        }
        _renderVariableLength(parent, field) {
            if (field.lengthSource || this._lengthRuleOwners(field).length) { this._renderLengthSource(parent, field); return; }
            const relation = this.compiled?.fieldEntries?.get(field.id)?.field.lengthRelation;
            if (relation) {
                parent.append(this._node('p', 'hint-text', `备用长度来源：${relation.source} 的值表达式。内部结构明确时独立解析，需要剩余字节的分支才使用该边界。`),
                    this._button('查看长度值规则', 'jump-length-value-rule', () => this._openRule(relation.ruleId)));
            }
            parent.append(this._node('p', 'hint-text', '0 字节表示变长；结构体、分支可按内部字段确定。原始数据需独立长度或边界，也可由长度值表达式求解。'));
            const mode = field.lengthSource ? 'field' : field.boundary ? 'boundary' : field.lengthFrom === 'REMAINING' ? 'remaining' : field.lengthFrom === 'contents' ? 'contents' : 'expression';
            this._control(parent, 'field.lengthMode', '长度来源', mode, 'select', value => this._change(() => {
                delete field.length; delete field.lengthFrom; delete field.lengthSource; delete field.boundary;
                if (value === 'boundary') field.boundary = { startFieldId: '', endFieldId: '' };
                else field.lengthFrom = value === 'expression' ? '' : value === 'remaining' ? 'REMAINING' : value;
            }), [['expression', '长度表达式'], ['boundary', '起止固定字节'], ['remaining', '所属有界段剩余字节'], ...(['struct','choice','repeat','tlv'].includes(field.type) ? [['contents', '按内部字段确定']] : [])]);
            parent.append(this._node('p', 'hint-text', '在长度字段的“内容约束 → 长度关联”中填写值表达式，例如 LEN(payload) + LEN(checksum_0)。所属段剩余字节会使用已明确配置的边界。'));
            if (mode === 'expression') this._control(parent, 'field.lengthFrom', '长度表达式（引用已读取字段）', field.lengthFrom ?? field.length ?? '', 'text', value => this._change(() => { field.lengthFrom = value; }));
            if (mode === 'boundary') {
                const fixed = this._fieldRows().filter(row => row.field.type === 'fixed').map(row => [row.field.id, row.path]);
                for (const [key, title] of [['startFieldId', '前侧固定字节（可留空）'], ['endFieldId', '后侧固定字节']])
                    this._control(parent, 'field.boundary.' + key, title, field.boundary[key], 'select', value => this._change(() => { field.boundary[key] = value; }), [['', '未指定'], ...fixed]);
            }
        }
        _renderChecksumCoverage(parent, field) {
            const section = parent;
            const coverage = model().getChecksumCoverage(this.draft, field.id), constraints = model().getConstraintCoverage(this.draft, field.id);
            if (!coverage.length && !constraints.length) return;
            const labels = { full: '完整覆盖', partial: '部分覆盖', unknown: '范围需结合样例确认' };
            const rows = this._fieldRows();
            for (const relation of coverage) {
                const check = rows.find(row => row.field.id === relation.checksumId);
                if (!check) continue;
                const row = this._node('div', 'protocol-relation-row'); row.setAttribute('data-checksum-coverage', relation.checksumId);
                const status = relation.coverage === 'full' ? '完整覆盖' : relation.coverage === 'partial' ? '部分覆盖' : '范围需结合样例确认';
                const path = relation.checksumPath ?? check.path;
                row.append(this._node('p', 'hint-text', `${status}${relation.conditional ? '（条件段内生效）' : ''}：${path}`),
                    this._button('查看校验规则 · ' + path, null, () => this._jumpToRule(check.field, 'checksum')));
                section.append(row);
            }
            for (const relation of constraints) {
                const row = this._node('div', 'protocol-relation-row');
                row.append(this._node('span', 'hint-text', `${relation.ruleName} · ${labels[relation.coverage]}${relation.conditional ? ' · 满足条件时' : ''}`),
                    this._button('查看规则 · ' + relation.ruleName, null, () => this._openRule(relation.ruleId)));
                section.append(row);
            }
        }
        _publish() {
            if (this.emptyLibrary) return;
            const index = this.library.findIndex(item => item.id === this.libraryId || item.id === this.draft.id);
            if (index >= 0) this.library[index] = clone(this.draft); else this.library.push(clone(this.draft));
            this.libraryId = this.draft.id;
            this.onLibraryChange?.(clone(this.library), this.draft.id); this.onDraft?.(clone(this.draft));
        }
        _restoreDraft(value) {
            const changedProtocol=value.id!==this.draft?.id;
            if (value.id !== this.draft?.id) { this.history = []; this.future = []; }
            const selectedId = this.selectedField?.id, messageId = this.selectedMessage?.id;
            try { this.draft = model().toUnified(value); } catch (_) { this.draft = clone(value); }
            this.selectedMessage = this.draft.messages?.find(item => item.id === messageId) ?? this.draft.messages?.[0];
            this.selectedField = this._fieldRows().find(row => row.field.id === selectedId)?.field; this.jsonInvalid = false;
            this.leftTab=this._navigation().leftTab==='edit'?'edit':'outline';this.propertyTab=this._navigation().propertyTab ?? 'basic';
            if(changedProtocol||!this._outlineNodes().some(item=>item.key===this.outlineSelection))this.outlineSelection=null;
            const navigation=clone(this._navigation());
            this.generation++; this.previewRecord = null; this._render();
            if(changedProtocol)this._restoreNavigationScroll(navigation);
            this._publish();
        }
        _undo(redo = false) {
            const source = redo ? this.future : this.history, target = redo ? this.history : this.future;
            if (!source.length) return;
            if(source.at(-1)._libraryUndo){
                const current=this._librarySnapshot(), snapshot=source.pop();target.push(current);
                const history=this.history,future=this.future;
                this.library=clone(snapshot.library);this.emptyLibrary=snapshot.empty;this.libraryId=snapshot.schema.id;
                this._restoreDraft(snapshot.schema);this.history=history;this.future=future;this._renderLibrary();
                this.onLibraryChange?.(clone(this.library),this.emptyLibrary?null:this.draft.id);return;
            }
            if (!this._hasActiveProtocol() || source[source.length - 1].id !== this.draft.id) { this.history = []; this.future = []; this._renderLibrary(); return; }
            target.push(clone(this.draft)); this._restoreDraft(source.pop());
        }
        _renderLibrary() {
            this.libraryHost.replaceChildren();
            this.libraryFooter.replaceChildren();
            this.selectorHost.replaceChildren();
            const entries = this.library.map(item => [item.id, item.name ?? item.id]);
            this._control(this.selectorHost, 'protocol-select', '协议', this.emptyLibrary ? '' : this.draft.id, 'select', id => {
                const schema = this.library.find(item => item.id === id); if (!schema) return;
                this._publish(); this.history = []; this.future = []; this.libraryId = id; this._restoreDraft(schema);
            }, this.emptyLibrary ? [['', '协议库为空']] : entries);
            const create = copy => {
                let index = 1, id; do { id = 'protocol' + index++; } while (this.library.some(item => item.id === id));
                if (copy) { this._publish(); const copied = model().duplicateProtocol(this.library, this.draft.id); this.library = copied.protocols; this.libraryId = copied.protocol.id; this.history = []; this.future = []; this._restoreDraft(copied.protocol); return; }
                let next = { schemaVersion: 3, id, name: '新协议', endian: 'little', framing: { maxLength: 1048576 }, messages: [{ id: id + '.frame', name: '整帧', byteLength: 0, fields: [{ id: id + '.value', name: 'value', type: 'uint8', byteLength: 1 }] }] };
                next.id = id;
                this.emptyLibrary = false; this.library.push(next); this.libraryId = id; this.history = []; this.future = []; this._restoreDraft(next);
                this._trackNew('protocol',this.draft.id);for(const row of this._fieldRows())this._trackNew('field',row.field.id);
            };
            this.libraryHost.append(this._node('div','section-title','协议操作'));
            this.libraryHost.append(this._button('新建协议', 'new-protocol', () => create(false)), this._button('复制协议', 'copy-protocol', () => create(true)), this._button('删除协议', 'delete-protocol', () => this._requestDelete('protocol',this.draft.id)));
            this.libraryHost.append(this._button('导入协议','library-import',() => this.dialog.querySelector('[data-action="import-json"]').click()),this._button('导出协议','library-export',() => this.dialog.querySelector('[data-action="export-json"]').click()));
            const reorder = delta => { this._publish(); const index = this.library.findIndex(item => item.id === this.draft.id); this.library = model().reorderProtocol(this.library, this.draft.id, index + delta); this.onLibraryChange?.(clone(this.library), this.draft.id); this._render(); };
            const before=this._iconButton('up','协议在列表中上移','protocol-up',()=>reorder(-1)),after=this._iconButton('down','协议在列表中下移','protocol-down',()=>reorder(1));
            const index=this.library.findIndex(item=>item.id===this.draft.id);before.disabled=this.emptyLibrary||index<=0;after.disabled=this.emptyLibrary||index<0||index>=this.library.length-1;
            this.libraryHost.append(before,after);
            this.fieldActionHost=this._node('div','protocol-field-actions');this.libraryHost.append(this.fieldActionHost);this._renderFieldActions();
            this.libraryFooter.append(this._button('RoboMaster 模板', 'add-robomaster-template', () => {
                const preset = typeof module !== 'undefined' && module.exports ? require('./robomasterProtocol').RoboMasterProtocol : root.SerialPlotter.RoboMasterProtocol;
                const schema = preset.createSchema(), existing = this.library.find(item => item.id === schema.id);
                this._publish();
                if (existing) {
                    this.emptyLibrary = false; this.libraryId = existing.id; this._restoreDraft(existing);
                    this.pendingPreset = schema; this._renderLibrary(); return;
                }
                if (!existing) this.library.push(schema);
                this.emptyLibrary = false; this.history = []; this.future = []; this._restoreDraft(existing ?? schema);
            }));
            if (this.pendingPreset?.id === this.draft.id && this._hasActiveProtocol()) {
                const latest = this.pendingPreset, prompt = this._node('div','protocol-constraint-confirm');
                prompt.append(this._node('p','hint-text','将用最新默认模板替换此协议草稿；点击应用协议后才影响采集，可撤销。'),
                    this._button('载入最新模板','confirm-latest-template',() => {
                        this.pendingPreset = null;
                        this._change(() => { const selected = this.selectedField?.id; this.draft = clone(latest); this.selectedMessage = this.draft.messages[0]; this.selectedField = model().findField(this.draft,selected); });
                    }), this._button('保留当前配置','cancel-latest-template',() => { this.pendingPreset = null; this._renderLibrary(); }));
                this.libraryHost.append(prompt);
            }
            const undo = this._button('撤销', 'undo', () => this._undo()), redo = this._button('重做', 'redo', () => this._undo(true));
            undo.disabled = !this.history.length; redo.disabled = !this.future.length;
            this.libraryHost.append(undo, redo, this._button('检查', 'check', () => { this._validate(); this._renderDiagnostics(); this.selectBottom('issues'); }));
            if (this.emptyLibrary) for (const action of ['copy-protocol', 'delete-protocol', 'library-export']) this.libraryHost.querySelector('[data-action="' + action + '"]').disabled = true;
            this.applyButton.disabled ||= this.emptyLibrary;
        }
        _renderDiagnostics() {
            const panel = this.bottomPanels.get('issues'); panel.replaceChildren();
            let diagnostics = [];
            if (protocol().analyze) diagnostics = protocol().analyze(this.draft).diagnostics;
            else if (!this.compiled) diagnostics = [{ severity: 'error', message: this.alert.textContent }];
            this.bottomButtons.get('issues').textContent = '问题列表' + (diagnostics.length ? ' (' + diagnostics.length + ')' : '');
            if (!diagnostics.length) panel.append(this._node('p', 'hint-text', '未发现协议结构问题。可用样例验证实际字节。'));
            for (const item of diagnostics.slice(0, 100)) {
                const rows = this._fieldRows();
                const row = rows.find(entry => entry.field.id === item.nodeId) ?? rows.find(entry =>
                    [...(entry.field.branches ?? []), ...(entry.field.bits ?? []), ...(entry.field.headerFields ?? [])].some(child => child.id === item.nodeId));
                const rule = this.draft.rules?.find(rule => rule.id === item.nodeId);
                const target = rule && rows.find(entry => entry.field.id === rule.targetFieldId);
                const message = this._messages().find(entry => entry.message.id === item.nodeId);
                const location = row ? '字段：' + row.path : rule ? '规则：' + (rule.name || rule.id) + (target ? ' · 字段：' + target.path : '')
                    : message ? '整帧：' + (message.message.name || message.message.id) : item.nodeId ? '位置：' + item.nodeId : '协议整体';
                const text=messageZh(item.message);
                const button = this._button((item.severity === 'warning' ? '提示' : '错误') + ' · ' + location + '：' + text, null, () => {
                    if (rule) { this._openRule(rule.id); return; }
                    const contains = node => node && typeof node === 'object' && (node.id === item.nodeId || Object.values(node).some(value => value && typeof value === 'object' && contains(value)));
                    const message = this._messages().find(entry => contains(entry.message));
                    if (message) { this.selectedMessage = message.message; this.headerSelected = false; } else if (contains(this.draft.headerFields)) this.headerSelected = true;
                    if (row) { this._selectField(row.field); this.selectTab('messages'); }
                    else if (message) this.selectTab('framing');
                }, 'protocol-diagnostic');
                button.setAttribute('data-severity', item.severity); button.title = location + '：' + text;
                panel.append(button);
            }
        }
        _fieldWidth(field) {
            if (field.byteLength !== undefined) return field.byteLength > 0 ? field.byteLength : null;
            const type = field.type === 'enum' ? field.baseType ?? 'uint8' : field.type;
            const scalar = /^(?:u?int|float)(8|16|32|64)$/.exec(type);
            if (scalar) return Number(scalar[1]) / 8;
            if (type === 'bool') return 1;
            if (type === 'bitfield') return Number.isSafeInteger(field.byteLength) && field.byteLength > 0 ? field.byteLength : null;
            if (type === 'fixed') return field.bytes?.length ?? 0;
            return typeof field.length === 'number' ? field.length : null;
        }
        _layoutRows() {
            try {
                const source = this.headerSelected ? { ...this.draft, payloadOffset: 0, messages: [{ id: '__header', fields: this.draft.headerFields ?? [] }] } : this.draft;
                return model().layoutSummary(source, this.headerSelected ? '__header' : this.selectedMessage?.id);
            } catch (_) { return []; }
        }
        _renderLayout() {
            const panel = this.bottomPanels.get('layout'); panel.replaceChildren();
            panel.append(this._node('p', 'hint-text', '偏移从 0 开始；卡片宽度不代表字节数。动态长度、条件与分支的实际范围请查看样例解析。'));
            const ruler = this._node('div', 'protocol-byte-ruler'), layout = new Map(this._layoutRows().map(item => [item.id, item]));
            for (const row of this._fieldRows()) {
                const span = layout.get(row.field.id), offset = span?.frameOffset, width = span?.width;
                const cell = this._button((offset == null ? '偏移待定' : '字节 ' + offset) + ' · ' + row.field.name + ' · ' + (width == null ? '动态长度' : width + ' B'), null, () => { this.selectedField = row.field; this._renderMessages(); }, 'protocol-byte-cell');
                cell.setAttribute('data-layout-field', row.field.id ?? row.path); cell.setAttribute('data-byte-offset', offset ?? 'dynamic'); ruler.append(cell);
            } panel.append(ruler);
        }
        _messages() {
            const result = [];
            const visit = (messages, scope, depth = 0) => {
                if (depth > 16 || !Array.isArray(messages)) return;
                for (const message of messages) {
                    if (!message || typeof message !== 'object') continue;
                    const id = message.id ?? scope + '.' + message.command;
                    result.push({ message, id, depth, owner: messages });
                    visit(message.dispatch?.messages, id, depth + 1);
                }
            };
            visit(this.draft.messages, this.draft.id); return result;
        }
        _fields() {
            if (this.headerSelected) return this.draft.headerFields ??= [];
            return this.selectedMessage ? this.selectedMessage.fields ??= [] : [];
        }
        _fieldRows() {
            const result = [];
            const visit = (fields, prefix, depth, refs, branch = null, parent = null) => {
                if (!Array.isArray(fields) || depth > 16 || result.length > 8192) return;
                for (const field of fields) {
                    if (!field || typeof field !== 'object') continue;
                    const path = prefix ? prefix + '.' + field.name : field.name;
                    const row = { field, path, depth, owner: fields, branch, parent }; result.push(row);
                    visit(field.headerFields,path,depth+1,refs,null,row);
                    if (field.type === 'choice' || field.type === 'tlv') {
                        for (const branch of field.branches ?? []) visit(branch.fields, path + '.' + (branch.label ?? branch.id ?? '分支'), depth + 1, refs, branch, row);
                    }
                    if (field.type === 'repeat') visit(field.fields, path, depth + 1, refs, null, row);
                    if (field.type === 'struct') {
                        if (field.ref && !refs.includes(field.ref)) visit(this.draft.structures?.[field.ref], path, depth + 1, [...refs, field.ref], null, row);
                        else if (!field.ref) visit(field.fields, path, depth + 1, refs, null, row);
                    }
                }
            };
            visit(this._fields(), '', 0, []); return result;
        }
        _addField(type, parent = null, after = null) {
            this._change(() => {
                let owner = this._fields();
                if (parent) owner = parent.ref ? (this.draft.structures ??= {})[parent.ref] ??= [] : parent.fields ??= [];
                else if(after)owner=this._fieldRows().find(row=>row.field===after)?.owner ?? owner;
                let number = 1; while (owner.some(field => field.name === 'field' + number)) number++;
                const field = { name: 'field' + number, type };
                field.id = 'field-' + Date.now().toString(36) + '-' + (++nextInstance);
                const scalar = /(?:int|float)(8|16|32|64)$/.exec(type);
                field.byteLength = scalar ? Number(scalar[1]) / 8 : 1;
                if (['struct', 'repeat'].includes(type)) field.fields = [];
                if (['struct','choice','repeat'].includes(type)) { field.byteLength = 0; field.lengthFrom = 'contents'; }
                if (type === 'repeat') field.count = 1;
                if (type === 'fixed') field.bytes = [0];
                if (type === 'bitfield') { field.byteLength = 1; field.bits = []; }
                if (type === 'choice') { field.selector = '0'; field.branches = [{ id: field.id + '.case', equals: 1, fields: [] }]; }
                if (type === 'checksum') { field.byteLength = 2; field.checksum = { type: 'crc16', polynomial: 4129, init: 65535, start: 0, end: { fieldId: field.id, edge: 'start' } }; }
                if (type === 'tlv') Object.assign(field, { byteLength: 0, lengthFrom: 'remaining', until: 'end', headerFields: [{ name: 'tag', type: 'uint8', byteLength: 1 }, { name: 'size', type: 'uint8', byteLength: 1 }], lengthField: 'size', selector: 'tag', branches: [{ id: field.id + '.other', label: '其它类型（保留原始字节）', default: true, fields: [] }] });
                if(after)owner.splice(owner.indexOf(after)+1,0,field);else owner.push(field);
                this.selectedField = field;this.framingSelected=false;this.propertyTab='basic';this._trackNew('field',field.id);
            });
        }
        _pager(parent, page, total, size, prefix, change) {
            const bar = this._node('div', 'protocol-editor-pagination');
            const previous = this._button('上一页', prefix + '-previous', () => change(page - 1)); previous.disabled = page <= 0;
            const next = this._button('下一页', prefix + '-next', () => change(page + 1)); next.disabled = (page + 1) * size >= total;
            bar.append(previous, this._node('span', '', total ? `${page * size + 1}–${Math.min(total, (page + 1) * size)} / ${total}` : '0 / 0'), next);
            parent.append(bar);
        }
        _renderMessages() {
            this.expressionCompletions.splice(0).forEach(item => item.destroy());
            const bodyTop = this.body.scrollTop ?? 0, propertyTop = this.propertyHost.scrollTop ?? 0;
            const focusedBranch = this.document.activeElement?.getAttribute?.('data-branch-drag');
            const branchInProperties = this.propertyHost.contains(this.document.activeElement);
            const canvasFocused = this.canvas?.contains(this.document.activeElement);
            const advancedOpen = this.propertyHost.querySelector('[data-detail="advanced"]')?.open;
            const panel = this.panels.get('messages'); panel.replaceChildren(); this.propertyHost.replaceChildren();
            if (this.emptyLibrary) { panel.append(this._node('h3', '', '还没有协议'), this._node('p', 'hint-text', '在左侧“协议与字段编辑”中新建协议、导入 JSON 或加载模板。')); this.leftTab='edit';this._renderLeft([]);return; }
            if(this.framingSelected)this.outlineSelection=this._outlineNodes()[0]?.key;
            this.selectedMessage = this.draft.messages?.[0]; this.headerSelected = false;
            const rows = this._fieldRows();
            this.constraintUsage = new Map();
            const byPath = new Map();
            const collectRulePaths = (fields, prefix = '', depth = 0) => {
                if (depth > 16) return;
                for (const field of fields ?? []) {
                    const path = prefix + field.name;
                    if (!byPath.has(path)) byPath.set(path, []); byPath.get(path).push(field);
                    const child = field.inline ? prefix : path + '.';
                    collectRulePaths(field.fields ?? this.draft.structures?.[field.ref], child, depth + 1);
                    collectRulePaths(field.headerFields, child, depth + 1);
                    for (const branch of field.branches ?? []) collectRulePaths(branch.fields, child, depth + 1);
                }
            };
            collectRulePaths(this.draft.messages?.[0]?.fields);
            for (const rule of this.draft.rules ?? []) {
                const used = new Set([rule.targetFieldId, rule.checksum?.start?.fieldId, rule.checksum?.end?.fieldId].filter(Boolean));
                for (const source of [rule.expression, rule.value, rule.condition, rule.checksum?.start, rule.checksum?.end]) if (typeof source === 'string') {
                    try { for (const path of protocol().expressionVariables(source)) {
                        const parts = path.replace(/^CURRENT\./, '').replace(/\[\d+\]/g, '').split('.');
                        while (parts.length) { for (const field of byPath.get(parts.join('.')) ?? []) used.add(field.id); parts.pop(); }
                    } } catch (_) { /* Unfinished draft expressions remain editable. */ }
                }
                for (const id of used) {
                    if (!this.constraintUsage.has(id)) this.constraintUsage.set(id, []);
                    this.constraintUsage.get(id).push(rule);
                }
            }
            this.ruleUsage = new Map();
            const addUsage = (sourceId, id, label) => {
                if (!this.ruleUsage.has(sourceId)) this.ruleUsage.set(sourceId, []);
                const items = this.ruleUsage.get(sourceId);
                if (!items.some(item => item.id === id)) items.push({ id, label });
            };
            for (const row of rows) if (row.field.lengthSource) addUsage(row.field.lengthSource.fieldId, row.field.id, row.field.name);
            const frame = this.draft.messages[0];
            if (frame.lengthSource) addUsage(frame.lengthSource.fieldId, frame.id, '整帧');
            for (const input of this.compiled?.frameLengthExpression?.inputs ?? []) addUsage(input.field.id, frame.id, '整帧');
            this._indexLengthExpressions(addUsage);
            if (this.selectedField) this.framingSelected = false;
            if (!this.framingSelected && !rows.some(row => row.field === this.selectedField)) this.selectedField = rows[0]?.field;
            const selectedBranch=this._selectedBranch();
            const breadcrumb = this._node('p', 'protocol-breadcrumb', (this.selectedMessage?.name ?? '公共字段') + ' / ' + (rows.find(row => row.field === this.selectedField)?.path ?? '') + (selectedBranch?' / '+(selectedBranch.label||selectedBranch.id):''));
            panel.append(breadcrumb);
            const list = this._node('div', 'protocol-field-canvas'); panel.append(list); this.canvas = list;
            const layout = new Map(this._layoutRows().map(item => [item.id, item]));
            panel.append(this._node('p', 'protocol-canvas-ruler', '从左向右读取 · 偏移从 0 开始 · 卡片宽度不代表字节数'));
            panel.append(list);
            const frameCard = this._node('section', 'protocol-frame-root'); frameCard.setAttribute('data-frame-root', this.selectedMessage?.id ?? '');
            const selectFrame = this._button('整帧 · ' + (this.selectedMessage?.byteLength ? this.selectedMessage.byteLength + ' 字节' : '变长'), 'select-frame', () => {
                this.framingSelected = true; this.selectedField = null; this.propertyHost.scrollTop = 0; this._renderMessages();
                this.dialog.querySelector('[data-action="select-frame"]')?.focus();
            }, 'protocol-frame-title');
            selectFrame.setAttribute('aria-pressed', String(Boolean(this.framingSelected))); frameCard.append(selectFrame);
            const fieldsHost = this._node('div', 'protocol-frame-fields'); frameCard.append(fieldsHost); list.append(frameCard);
            frameCard.addEventListener('click', event => {
                if (event.target === frameCard || event.target === fieldsHost) selectFrame.click();
            });
            const containers = new Map(), branchHosts = new Map(), hidden = new Set();
            for (const row of rows) {
                const parentRow = row.parent;
                if (parentRow && (hidden.has(parentRow.field) || this.collapsed.has(parentRow.field.id))) { hidden.add(row.field); continue; }
                const card = this._node('div', 'protocol-field-card'); card.setAttribute('data-depth', row.depth); card.setAttribute('data-field-id', row.field.id ?? '');
                card.classList.toggle('is-selected', !this.framingSelected && !selectedBranch && row.field === this.selectedField);
                card.classList.toggle('has-error', this.validationError?.nodeId === row.field.id);
                card.classList.toggle('is-container', ['struct', 'repeat', 'choice', 'tlv'].includes(row.field.type));
                const bar = this._node('div', 'protocol-field-card-bar');
                const handle = this._iconButton('drag', '拖动字段；Alt + 上下键移动', null, () => {}); handle.draggable = true; handle.setAttribute('data-drag-id', row.field.id ?? row.path);
                handle.addEventListener('dragstart', event => { event.stopPropagation(); this._cancelDrag(); this.dragged = row; event.dataTransfer?.setData('text/plain', row.field.id ?? row.path); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; card.classList.add('is-dragging'); });
                handle.addEventListener('dragend', () => this._cancelDrag());
                const name = this._button(row.field.name, null, () => this._selectField(row.field), 'protocol-field-select');
                name.setAttribute('data-field-path', this.compiled?.fieldEntries?.get(row.field.id)?.path ?? row.path); name.setAttribute('aria-pressed', String(!selectedBranch && row.field === this.selectedField));
                name.addEventListener('keydown', event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); this.selectedField = row.field; this._moveSelected(event.key === 'ArrowUp' ? -1 : 1); } });
                const span = layout.get(row.field.id), width = span?.width;
                const meta = this._node('span', 'protocol-field-meta');
                for (const text of [(typeNames[this._fieldDataType(row.field)] ?? row.field.type).split(' · ')[0],
                    width == null ? '长度待定' : width + ' 字节',
                    span?.frameOffset == null ? '整帧偏移待定' : '整帧 ' + span.frameOffset,
                    span?.localOffset == null ? '段内偏移待定' : '段内 ' + span.localOffset])
                    meta.append(this._node('span', 'protocol-field-meta-line', text));
                card.setAttribute('data-byte-offset', span?.frameOffset ?? 'dynamic');
                bar.append(handle, name, meta);
                this._renderUsageHints(bar, row.field);
                if (row.field.condition) bar.append(this._node('span', 'protocol-field-condition', '当 ' + row.field.condition));
                if (['struct', 'repeat', 'choice', 'tlv'].includes(row.field.type)) bar.append(this._button(this.collapsed.has(row.field.id) ? '展开' : '收起', null, () => { if (!this.collapsed.delete(row.field.id)) this.collapsed.add(row.field.id); this._renderMessages(); }, 'protocol-collapse'));
                card.append(bar);
                const children = this._node('div', 'protocol-field-children'); card.append(children); containers.set(row.field, children);
                if (!this.collapsed.has(row.field.id)) for (const branch of row.field.branches ?? []) {
                    const group = this._node('section', 'protocol-branch-canvas'); group.setAttribute('data-branch-id', branch.id);
                    group.classList.toggle('is-selected',branch===selectedBranch);
                    group.setAttribute('role','group');group.setAttribute('aria-label','分支：'+(branch.label||branch.id));group.tabIndex=0;
                    group.addEventListener('click',event=>{
                        if(event.target.closest?.('.protocol-branch-canvas')!==group||event.target.closest?.('.protocol-field-card')!==card||event.target.closest?.('button'))return;
                        event.stopPropagation();this._selectBranch(row.field,branch);
                    });
                    group.addEventListener('keydown',event=>{
                        if(event.target!==group||!['Enter',' '].includes(event.key))return;
                        event.preventDefault();event.stopPropagation();this._selectBranch(row.field,branch);
                        [...this.canvas.querySelectorAll('[data-branch-id]')].find(node=>node.getAttribute('data-branch-id')===branch.id)?.focus({preventScroll:true});
                    });
                    const header = this._node('header', 'protocol-branch-header'), title = this._node('div', 'protocol-branch-heading');
                    title.append(this._node('p', 'protocol-branch-title', branch.label || branch.id || '分支'), this._node('p', 'protocol-branch-rule', this._branchRule(branch, row.field)));
                    header.append(this._branchHandle(row.field, branch, group, this.body), title); group.append(header);
                    const content = this._node('div', 'protocol-branch-fields'); group.append(content);
                    if (!branch.fields?.length) content.append(this._button('添加字段', null, () => this._addField('uint8', branch), 'protocol-branch-empty'));
                    group.addEventListener('dragover', event => { if (!this.dragged) return; event.preventDefault(); event.stopPropagation(); this._clearDrop(); this.dropTarget = { row, owner: branch.fields ??= [], inside: true }; group.classList.add('drop-inside'); this._autoScroll(this.body, event); });
                    group.addEventListener('drop', event => { if (!this.dragged) return; event.preventDefault(); event.stopPropagation(); this._dropField(); });
                    children.append(group); branchHosts.set(branch, content);
                }

                let destination = parentRow && containers.get(parentRow.field) || fieldsHost;
                if (row.branch) destination = branchHosts.get(row.branch) ?? destination;
                destination.append(card);
                card.addEventListener('click', event => {
                    if (this.disposed || this.busy || event.target.closest?.('.protocol-field-card') !== card || event.target.closest?.('button')) return;
                    const branch = event.target.closest?.('.protocol-branch-canvas');
                    if (branch?.closest('.protocol-field-card') === card) return;
                    this._selectField(row.field);
                });
                card.addEventListener('dragover', event => {
                    if (!this.dragged || this.dragged.field === row.field) return; event.preventDefault(); event.stopPropagation();
                    this._clearDrop(); const rect = card.getBoundingClientRect?.();
                    const edge = rect ? Math.min(12, rect.height / 4) : 0;
                    const top = rect && event.clientY < rect.top + edge, bottom = rect && event.clientY > rect.bottom - edge;
                    const middle = rect && !top && !bottom && event.clientX > rect.left + rect.width * .3 && event.clientX < rect.right - rect.width * .3;
                    const inside = middle && ['struct', 'repeat'].includes(row.field.type) && !row.field.ref;
                    const after = rect ? bottom || !top && event.clientX > rect.left + rect.width / 2 : false;
                    this.dropTarget = { row, inside, after }; card.classList.add(inside ? 'drop-inside' : after ? 'drop-after' : 'drop-before');
                    if (top || bottom) card.classList.add(bottom ? 'drop-below' : 'drop-above');
                    this._autoScroll(this.body, event);
                });
                card.addEventListener('drop', event => { if (!this.dragged) return; event.preventDefault(); event.stopPropagation(); if (this.dropTarget) this._dropField(); });
            }
            if (!rows.length) list.append(this._node('p', 'hint-text', '从左侧添加字段，开始定义字节布局。'));
            if (this.framingSelected) this._renderFrameDetails(this.propertyHost);
            else if(selectedBranch)this._renderBranchDetails(this.propertyHost,this.selectedField,selectedBranch);
            else this._renderFieldDetails(this.propertyHost, rows);
            this._arrangeProperties();
            this._renderLeft(rows);
            this.body.scrollTop = bodyTop; this.propertyHost.scrollTop = propertyTop;
            if (advancedOpen !== undefined) { const details = this.propertyHost.querySelector('[data-detail="advanced"]'); if (details) details.open = advancedOpen; }
            if (focusedBranch) {
                const host = branchInProperties ? this.propertyHost : list;
                [...host.querySelectorAll('[data-branch-drag]')].find(node => node.getAttribute('data-branch-drag') === focusedBranch)?.focus({preventScroll:true});
            } else if (canvasFocused) {
                // A branch lives inside its owner card: restore the selected item, not its ancestor.
                // Focus must not override the scroll positions restored above.
                const target=selectedBranch
                    ? [...list.querySelectorAll('[data-branch-id]')].find(node=>node.getAttribute('data-branch-id')===selectedBranch.id)
                    : this.framingSelected ? selectFrame
                    : [...list.querySelectorAll('[data-field-id]')].find(node=>node.getAttribute('data-field-id')===this.selectedField?.id)?.querySelector('[data-field-path]');
                target?.focus({preventScroll:true});
            }
        }
        _iconButton(icon, title, action, callback) {
            const button = this._button('', action, callback, 'protocol-icon-button'); button.setAttribute('aria-label', title); button.setAttribute('title', title);
            const make = tag => this.document.createElementNS ? this.document.createElementNS('http://www.w3.org/2000/svg', tag) : this._node(tag);
            const svg = make('svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('aria-hidden', 'true');
            const path = make('path'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5');
            path.setAttribute('d', icon === 'up' ? 'M4 9l4-4 4 4M8 5v8' : icon === 'down' ? 'M4 7l4 4 4-4M8 3v8' : icon === 'tree-right' ? 'M6 3l5 5-5 5' : icon === 'tree-down' ? 'M3 6l5 5 5-5' : 'M5 3h1M10 3h1M5 8h1M10 8h1M5 13h1M10 13h1'); svg.append(path); button.append(svg); return button;
        }
        _selectField(field, outlineKey = null) {
            if (this.disposed || this.busy) return;
            if(this.selectedField?.id!==field.id||this.framingSelected)this.propertyTab='basic';
            this.selectedField = field; this.framingSelected = false; this.propertyHost.scrollTop = 0;
            if(this.propertyScroll)this.propertyScroll.scrollTop=0;
            this._revealOutline(field.id,outlineKey);this._renderMessages();
        }
        _selectedBranch() {
            if(this.framingSelected||!this.selectedField?.branches)return null;
            return this._outlineNodes().find(item=>item.kind==='branch'&&item.owner===this.selectedField&&item.key===this.outlineSelection)?.node ?? null;
        }
        _selectBranch(field, branch, outlineKey = null) {
            const item=this._outlineNodes().find(node=>node.kind==='branch'&&node.node===branch&&node.owner===field&&(!outlineKey||node.key===outlineKey));
            if(!item)return;
            this.propertyTab='basic';this._selectField(field,item.key);
        }
        _moveSelected(direction) {
            const row = this._fieldRows().find(item => item.field === this.selectedField); if (!row) return;
            this._change(() => { const index = row.owner.indexOf(row.field), target = index + direction; if (target >= 0 && target < row.owner.length) { row.owner.splice(index, 1); row.owner.splice(target, 0, row.field); } });
        }
        _branchRule(branch, field) {
            const text = value => this._integerText(value, this._dataBase(field));
            return branch.default ? '默认分支' : branch.range ? branch.range.map(text).join(' 至 ') : branch.mask ? '& ' + text(branch.mask.mask) + ' = ' + text(branch.mask.value) : branch.expression ?? '= ' + text(branch.equals);
        }
        _autoScroll(host, event) {
            const bounds = host.getBoundingClientRect?.();
            if (bounds) host.scrollTop += event.clientY < bounds.top + 40 ? -18 : event.clientY > bounds.bottom - 40 ? 18 : 0;
        }
        _reorderBranch(field, branch, index) {
            if (index < 0 || index >= field.branches.length) return;
            this._change(() => {
                const selectedId = this.selectedField?.id;
                this.draft = model().reorderBranch(this.draft, field.id, branch.id, index);
                this.selectedField = model().findField(this.draft, selectedId);
            });
        }
        _branchHandle(field, branch, host, scrollHost) {
            const handle = this._iconButton('drag', '拖动分支排序；Alt + 上下键移动', null, () => {});
            handle.draggable = true; handle.setAttribute('data-branch-drag', branch.id);
            handle.addEventListener('dragstart', event => {
                event.stopPropagation(); this._cancelDrag(); this.draggedBranch = { field, branch };
                event.dataTransfer?.setData('text/plain', branch.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; host.classList.add('is-dragging');
            });
            handle.addEventListener('dragend', () => this._cancelDrag());
            handle.addEventListener('keydown', event => {
                if (event.altKey && ['ArrowUp','ArrowDown'].includes(event.key)) {
                    event.preventDefault(); event.stopPropagation(); this._reorderBranch(field, branch, field.branches.indexOf(branch) + (event.key === 'ArrowUp' ? -1 : 1));
                }
            });
            host.addEventListener('dragover', event => {
                if (!this.draggedBranch || this.draggedBranch.field.id !== field.id) return;
                event.stopPropagation(); this._clearDrop(); this.dropTarget = null;
                if (this.draggedBranch.branch.id === branch.id) return;
                event.preventDefault();
                const rect = host.getBoundingClientRect?.(), after = rect ? event.clientY > rect.top + rect.height / 2 : false;
                this.dropTarget = { field, branch, after }; host.classList.add(after ? 'drop-below' : 'drop-above'); this._autoScroll(scrollHost, event);
            });
            host.addEventListener('drop', event => {
                if (!this.draggedBranch || this.draggedBranch.field.id !== field.id) return;
                event.preventDefault(); event.stopPropagation();
                const source = this.draggedBranch, target = this.dropTarget; this._cancelDrag();
                if (!target?.branch || field.id !== source.field.id || target.field.id !== field.id || target.branch.id !== branch.id) return;
                const before = field.branches.indexOf(source.branch), at = field.branches.indexOf(target.branch);
                this._reorderBranch(field, source.branch, at + (target.after ? 1 : 0) - (before < at ? 1 : 0));
            });
            return handle;
        }
        _clearDrop() { for (const node of this.dialog.querySelectorAll('.protocol-field-card, .protocol-branch-canvas, .protocol-branch-editor')) for (const name of ['drop-before', 'drop-after', 'drop-inside', 'drop-above', 'drop-below']) node.classList.remove(name); }
        _cancelDrag() { this.dragged = null; this.draggedBranch = null; this.dropTarget = null; this._clearDrop(); for (const node of this.dialog.querySelectorAll('.is-dragging')) node.classList.remove('is-dragging'); }
        _dropField() {
            const source = this.dragged, target = this.dropTarget; this._cancelDrag(); if (!source || !target || target.row.path.startsWith(source.path + '.') || source.field === target.row.field) return;
            this._change(() => { source.owner.splice(source.owner.indexOf(source.field), 1); const owner = target.owner ?? (target.inside ? target.row.field.fields ??= [] : target.row.owner); const index = target.inside ? owner.length : owner.indexOf(target.row.field) + (target.after ? 1 : 0); owner.splice(index, 0, source.field); this.selectedField = source.field; });
        }
        _renderLeft(rows) {
            if (!this.draft) return;
            const scroll=this.outlineHost.scrollTop;this.outlineHost.replaceChildren();
            const search=this._control(this.outlineHost,'outline-search','搜索字段',this.search ?? '','text');
            this.treeHost=this._node('div','protocol-outline-tree');this.treeHost.setAttribute('role','tree');this.treeHost.setAttribute('aria-label','当前协议结构');
            this.outlineHost.append(this.treeHost);
            search.addEventListener('input',()=>{this.search=search.value;this._renderTree();});
            this._renderTree();this.selectLeft(this.leftTab);this.outlineHost.scrollTop=scroll;
            this._renderFieldActions();
        }
        _outlineNodes() {
            const result=[], frame=this.draft?.messages?.[0];if (!frame||this.emptyLibrary) return result;
            const add=(node,kind,parent,owner,depth)=>{
                if (result.length>=8192 || depth>24) return null;
                const key=(parent?parent.key+'/':'')+node.id;
                const item={node,kind,parent,owner,depth,key,id:node.id,label:kind==='branch'?(node.label || node.id):node.name || node.id,children:[]};
                result.push(item);if(parent)parent.children.push(item);return item;
            };
            const walk=(fields,parent,refs=[])=>{for(const field of fields ?? []){
                const item=add(field,'field',parent,field,parent.depth+1);if(!item)continue;
                if(field.ref && !refs.includes(field.ref))walk(this.draft.structures?.[field.ref],item,[...refs,field.ref]);
                else if(!field.ref)walk(field.fields,item,refs);
                walk(field.headerFields,item,refs);
                for(const branch of field.branches ?? []){const child=add(branch,'branch',item,field,item.depth+1);if(child)walk(branch.fields,child,refs);}
            }};
            const root=add(frame,'frame',null,null,0);walk(frame.fields,root);return result;
        }
        _revealOutline(id, key = null) {
            const nodes=this._outlineNodes(), target=nodes.find(item=>key?item.key===key:item.id===id);if(!target)return;
            this.outlineSelection=target.key;
            this.pendingOutlineReveal=target.key;
            if(!this.search){const closed=new Set(this._navigation().closed);for(let parent=target.parent;parent;parent=parent.parent)closed.delete(parent.key);this._navigation().closed=[...closed];this._saveState();}
        }
        _renderTree() {
            if(!this.treeHost)return;
            this.treeHost.replaceChildren();const nodes=this._outlineNodes(), state=this._navigation(), closed=new Set(state.closed), query=(this.search ?? '').trim().toLowerCase();
            const shown=new Set();
            if(query)for(const item of nodes)if(item.label.toLowerCase().includes(query)||item.key.toLowerCase().includes(query)){for(let node=item;node;node=node.parent)shown.add(node.key);}
            const selected=nodes.find(node=>node.key===this.outlineSelection) ?? nodes.find(node=>node.id===(this.framingSelected?this.draft.messages[0]?.id:this.selectedField?.id));
            this.outlineSelection=selected?.key;this.visibleTree=[];
            const toggle=item=>{if(closed.has(item.key))closed.delete(item.key);else closed.add(item.key);state.closed=[...closed];this._saveState();this._renderTree();};
            const choose=(item,focus=false)=>{
                this.outlineSelection=item.key;
                if(item.kind==='frame'){this.framingSelected=true;this.selectedField=null;this.selectTab('framing');}
                else{if(item.kind==='branch')this._selectBranch(item.owner,item.node,item.key);else this._selectField(item.node,item.key);this.selectTab('messages');}
                if(focus)Array.from(this.treeHost.querySelectorAll('[data-outline-node]')).find(node=>node.getAttribute('data-outline-key')===item.key)?.focus();
            };
            for(const item of nodes){
                let hidden=query?!shown.has(item.key):false;
                if(!query)for(let parent=item.parent;parent;parent=parent.parent)if(closed.has(parent.key))hidden=true;
                if(hidden)continue;
                this.visibleTree.push(item);
                const row=this._node('div','protocol-tree-row');row.setAttribute('role','treeitem');row.setAttribute('data-outline-node',item.id);row.setAttribute('data-outline-key',item.key);
                row.setAttribute('aria-level',String(item.depth+1));row.setAttribute('aria-selected',String(selected===item));row.tabIndex=selected===item?0:-1;
                row.style.setProperty?.('--tree-depth',String(item.depth));
                if(item.children.length){row.setAttribute('aria-expanded',String(query?true:!closed.has(item.key)));const button=this._iconButton(closed.has(item.key)&&!query?'tree-right':'tree-down','展开或折叠 '+item.label,null,()=>toggle(item));button.setAttribute('data-outline-toggle',item.id);button.tabIndex=-1;row.append(button);}
                else row.append(this._node('span','protocol-tree-spacer'));
                const name=this._button(item.label,null,()=>choose(item),'protocol-tree-name');name.tabIndex=-1;name.title=item.key;name.setAttribute('data-outline-id',item.id);row.append(name);
                name.addEventListener('dblclick',()=>{if(item.children.length)toggle(item);});
                row.addEventListener('keydown',event=>{
                    const index=this.visibleTree.findIndex(node=>node.key===item.key);let next;
                    if(event.key==='ArrowDown')next=this.visibleTree[index+1];else if(event.key==='ArrowUp')next=this.visibleTree[index-1];
                    else if(event.key==='Home')next=this.visibleTree[0];else if(event.key==='End')next=this.visibleTree.at(-1);
                    else if(event.key==='ArrowRight'){if(item.children.length&&closed.has(item.key))toggle(item);else next=item.children[0];}
                    else if(event.key==='ArrowLeft'){if(item.children.length&&!closed.has(item.key))toggle(item);else next=item.parent;}
                    else if(event.key==='Enter')next=item;else return;
                    event.preventDefault();event.stopPropagation();if(next)choose(next,true);
                });
                this.treeHost.append(row);
            }
            if(!this.visibleTree.length)this.treeHost.append(this._node('p','hint-text',query?'未找到匹配字段。':'当前协议暂无字段。'));
            if(this.pendingOutlineReveal){Array.from(this.treeHost.querySelectorAll('[data-outline-node]')).find(node=>node.getAttribute('data-outline-key')===this.pendingOutlineReveal)?.scrollIntoView?.({block:'nearest'});this.pendingOutlineReveal=null;}
        }
        _renderFieldActions() {
            if(!this.fieldActionHost)return;
            const field=this.selectedField, row=this._fieldRows().find(item=>item.field===field),branch=this._selectedBranch();
            this.fieldActionHost.replaceChildren(this._node('div','section-title','字段操作'),this._node('p','hint-text','当前目标：'+(row?.path ?? '整帧')+(branch?' / '+(branch.label||branch.id):'')));
            const add=this._button('新建字段','new-field',()=>this._newField(false));
            const child=this._button('新建子字段','new-child-field',()=>this._newField(true));
            const container=field&&['struct','repeat','choice','tlv'].includes(field.type);
            const missingBranch=container&&['choice','tlv'].includes(field.type)&&!field.branches?.length;
            child.disabled=this.emptyLibrary||!container||missingBranch;
            child.title=this.emptyLibrary?'请先新建或选择协议。':!container?'请先选中结构体、重复段、互斥分支或 TLV；普通字段不能包含子字段，顶层添加请用“新建字段”。'
                :missingBranch?'请先添加一个分支，再在该分支内新建子字段。':'在当前结构体、重复段或所选分支内添加字段。';
            add.disabled=this.emptyLibrary;
            const copy=this._button('复制字段','copy-field',()=>this._copyField()), remove=this._button(branch?'删除分支':'删除字段','delete-field-left',()=>{if(branch)this._requestDelete('branch',branch.id);else if(this.selectedField)this._requestDelete('field',this.selectedField.id);});
            copy.disabled=!row||Boolean(branch);remove.disabled=!row;
            this.fieldActionHost.append(add,child,copy,remove);
        }
        _newField(child) {
            const selected=this.selectedField, branch=this._outlineNodes().find(item=>item.key===this.outlineSelection&&item.kind==='branch');
            let parent=child?(branch?.node ?? selected):null;
            if(child&&parent&&!Array.isArray(parent.fields)&&['choice','tlv'].includes(parent.type))parent=parent.branches?.[0];
            if(child&&!parent)throw new Error('请先选中可包含字段的结构体、重复段或具体分支');
            this._addField('uint8',parent,child?null:selected);
            this.propertyTab='basic';this._revealOutline(this.selectedField.id);this._renderMessages();
            this.propertyHost.querySelector('[data-control="field.name"]')?.focus();
        }
        _copyField() {
            const field=this.selectedField;if(!field)return;
            this._change(()=>{this.draft=model().duplicateField(this.draft,field.id);this.selectedMessage=this.draft.messages[0];const source=this._fieldRows().find(row=>row.field.id===field.id);this.selectedField=source?.owner[source.owner.indexOf(source.field)+1] ?? source?.field;});
            this._revealOutline(this.selectedField.id);this._renderMessages();
        }
        selectProperty(id) {
            if(!this.propertyPanels?.has(id))return;
            const positions=this._navigation().propertyScroll ??= {},previous=this.propertyTab;
            if(this.propertyScroll&&previous!==id)positions[previous]=this.propertyScroll.scrollTop;
            this.propertyTab=id;this._navigation().propertyTab=id;
            for(const [key,panel] of this.propertyPanels){panel.hidden=key!==id;const button=this.propertyButtons.get(key);button.setAttribute('aria-selected',String(key===id));button.tabIndex=key===id?0:-1;}
            if(this.propertyScroll&&previous!==id)this.propertyScroll.scrollTop=positions[id] ?? 0;
            this._saveState();
        }
        _arrangeProperties() {
            const field=this.framingSelected?null:this.selectedField, rootSelected=this.framingSelected,branch=this._selectedBranch();
            const sections=[...this.propertyHost.children], previousTop=this.propertyScroll?.scrollTop ?? 0;
            const heading=this._node('div','sidebar-section-header config-pane-heading',rootSelected?'整帧属性':branch?'分支属性':'字段属性');
            if(field)heading.append(this._node('span','scope-badge',branch?'条件分支':this._fieldDataType(field)));
            const titleTools=this._node('div','protocol-property-name');
            const input=this.propertyHost.querySelector('[data-control="'+(branch?'branch.'+field.branches.indexOf(branch)+'.label':field?'field.name':'protocol.name')+'"]');
            if(input){const label=input.parentNode;titleTools.append(input);label.remove();titleTools.append(this._button('删除',branch?'delete-branch':field?'delete-field':'delete-protocol-title',()=>this._requestDelete(branch?'branch':field?'field':'protocol',branch?.id ?? field?.id ?? this.draft.id),'btn-danger'));}
            const nav=this._node('div','protocol-property-tabs');nav.setAttribute('role','tablist');nav.setAttribute('aria-label','属性分类');
            this.propertyPanels=new Map();this.propertyButtons=new Map();const body=this._node('div','protocol-property-scroll');
            for(const [id,title] of [['basic','基础设置'],['advanced','高级设置'],['relations','关联信息']]){
                const button=this._button(title,null,()=>this.selectProperty(id));button.setAttribute('data-property-tab',id);button.setAttribute('role','tab');
                button.id=this.prefix+'-property-'+id;button.setAttribute('aria-controls',button.id+'-panel');
                const panel=this._node('div','protocol-property-panel');panel.id=button.id+'-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);panel.setAttribute('data-property-panel',id);
                this.propertyPanels.set(id,panel);this.propertyButtons.set(id,button);nav.append(button);body.append(panel);
            }
            const basic=this.propertyPanels.get('basic'),advanced=this.propertyPanels.get('advanced'),relations=this.propertyPanels.get('relations');
            for(const section of sections){
                if(section.classList.contains('protocol-field-options')){
                    const details=section.querySelector('[data-detail="advanced"]');
                    if(details){const group=this._section(advanced,'高级设置');for(const node of [...details.children])if(node.tagName!=='SUMMARY')group.append(node);}
                    const references=section.querySelector('.protocol-field-references');if(references)relations.append(references);
                }else if(section.getAttribute('data-frame-advanced')!=null)advanced.append(section);
                else if(section.classList.contains('protocol-checksum-coverage'))relations.append(section);
                else basic.append(section);
            }
            if(!advanced.children.length)this._section(advanced,'高级设置').append(this._node('p','hint-text','当前对象没有其它高级设置。'));
            if(!relations.children.length)this._section(relations,'关联信息').append(this._node('p','hint-text','暂无关联信息。'));
            const first=basic.querySelector('h3');if(first)first.textContent=branch?'分支定义':field?'字段定义':'整帧定义';
            nav.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const ids=[...this.propertyPanels.keys()],index=ids.indexOf(this.propertyTab),next=event.key==='Home'?ids[0]:event.key==='End'?ids.at(-1):ids[(index+(event.key==='ArrowRight'?1:2))%3];this.selectProperty(next);this.propertyButtons.get(next).focus();});
            body.addEventListener('scroll',()=>{this.expressionCompletions.forEach(item=>item.close());(this._navigation().propertyScroll ??= {})[this.propertyTab]=body.scrollTop;});
            this.propertyHost.replaceChildren(heading,titleTools,nav,body);this.propertyHost.classList.add('has-field-inspector');this.propertyScroll=body;body.scrollTop=previousTop;
            this.selectProperty(this.propertyPanels.has(this.propertyTab)?this.propertyTab:'basic');
        }
        _fieldDataType(field) {
            if (field.type === 'enum') return field.baseType ?? 'uint8';
            if (field.type === 'checksum') return 'uint' + field.byteLength * 8;
            return field.type === 'fixed' ? 'bytes' : field.type;
        }
        _fieldStorageRole(field) { return field.expectedBytes || field.type === 'fixed' ? 'fixed' : 'data'; }
        _fieldConstraintRules(field, type, disabled = false) {
            return (this.draft.rules ?? []).filter(rule => rule.targetFieldId === field.id && ['length','checksum'].includes(rule.type) &&
                (!type || rule.type === type) && (disabled || rule.enabled !== false));
        }
        _fieldRole(field) {
            const kinds = new Set(), rules = this._fieldConstraintRules(field);
            if (this._fieldStorageRole(field) === 'fixed') kinds.add('fixed');
            if (field.type === 'checksum') kinds.add('checksum');
            for (const rule of rules) kinds.add(rule.type);
            if (field.contentConstraint !== 'data' && (field.role === 'length' || model().isLengthSource(field) &&
                this.ruleUsage?.get(field.id)?.length)) kinds.add('length');
            if (!kinds.size && ['length','checksum'].includes(field.contentConstraint) && this._fieldConstraintRules(field,field.contentConstraint,true).length) kinds.add(field.contentConstraint);
            if (kinds.size > 1 || rules.length > 1 || field.type === 'checksum' && rules.some(rule => rule.type === 'checksum')) return 'legacy';
            return [...kinds][0] ?? 'data';
        }
        _requestContentConstraint(field, kind) {
            if (kind === this._fieldRole(field)) return;
            if (!this._compatibleRoles(this._fieldDataType(field), this._fieldWidth(field)).some(item => item[0] === kind)) throw new Error('当前数据类型不支持此内容约束');
            if (this._fieldRole(field) !== 'data') {
                this.pendingConstraint = { fieldId: field.id, kind }; this._renderMessages(); return;
            }
            this._setContentConstraint(field.id, kind);
        }
        _setContentConstraint(fieldId, kind) {
            this.pendingConstraint = null;
            this._change(() => {
                const bindings = model().getLengthBindings(this.draft, fieldId);
                if (kind !== 'length') for (const binding of bindings)
                    this.draft = model().unbindLengthTarget(this.draft, fieldId, binding.targetId);
                const field = model().findField(this.draft, fieldId), type = this._fieldDataType(field);
                const fixedBytes = field.bytes ?? field.expectedBytes, framingRole = field.framingRole;
                const legacyLength = kind === 'length' && (bindings.length || field.role === 'length' || this._lengthExpressionReferences(field).length);
                const active = this._fieldConstraintRules(field);
                for (const constraintType of ['length','checksum']) {
                    const previous = active.find(rule => rule.type === constraintType);
                    if (previous) for (const rule of this._fieldConstraintRules(field,constraintType,true)) rule.fieldConstraintPreferred = rule === previous;
                }
                for (const rule of active) rule.enabled = false;
                field.type = field.type === 'enum' ? 'enum' : type; delete field.role; delete field.expectedBytes; delete field.framingRole; delete field.bytes;
                field.contentConstraint = kind;
                if (kind === 'fixed') {
                    const bytes = fixedBytes ?? new Array(field.byteLength).fill(0);
                    if (type === 'bytes') { field.type = 'fixed'; field.bytes = bytes; if (framingRole) field.framingRole = framingRole; }
                    else field.expectedBytes = bytes;
                } else if (legacyLength) field.role = 'length';
                else if (kind === 'length' || kind === 'checksum') {
                    const candidates = this._fieldConstraintRules(field, kind, true);
                    let rule = candidates.find(rule => rule.fieldConstraintPreferred) ?? candidates[0];
                    if (kind === 'checksum' && field.checksum && !rule) field.type = 'checksum';
                    else {
                        if (!rule) {
                            const list = this.draft.rules ??= [];
                            let id = 'field-' + kind + '-' + field.id;
                            while (list.some(item => item.id === id) || model().findNode(this.draft,id)) id += '-1';
                            rule = { id, name: field.name + (kind === 'length' ? ' 长度值' : ' 校验'), type: kind,
                                targetFieldId: field.id, enabled: true, stage: 'validation', strength: kind === 'length' ? 'weak' : 'strong', send: 'fill' };
                            if (kind === 'length') Object.assign(rule, { value: '', boundaryFallback: false });
                            else rule.checksum = { type: 'sum', start: { fieldId: this.draft.messages[0].fields[0].id, edge: 'start' }, end: { fieldId: field.id, edge: 'start' } };
                            list.push(rule);
                        }
                        rule.enabled = true; this._syncLengthValueRule(rule);
                    }
                }
                this.selectedMessage = this.draft.messages[0]; this.selectedField = field;
            });
        }
        _renderRuleBehavior(parent, rule, prefix) {
            const edit = (key,value) => this._change(() => { rule[key] = value; });
            this._control(parent,prefix + '.enabled','启用规则',rule.enabled !== false,'checkbox',value => edit('enabled',value));
            this._control(parent,prefix + '.stage','检查阶段',rule.stage ?? 'validation','select',value => edit('stage',value), [['parsing','解析阶段'],['validation','完整帧验证'],['both','两个阶段']]);
            this._control(parent,prefix + '.strength','验证失败时',rule.strength ?? 'weak','select',value => edit('strength',value), [['weak','警告并继续输出数值（弱规则）'],['strong','不输出数值（强规则）']]);
        }
        _indexLengthExpressions(addUsage) {
            if (!this.compiled?.fieldEntries) return;
            const entries = this.compiled.fieldEntries, paths = new Map(), root = this.compiled.rootMessages[0];
            for (const entry of entries.values()) {
                if (!paths.has(entry.path)) paths.set(entry.path, []);
                paths.get(entry.path).push(entry);
            }
            const parentScope = scope => {
                const owner = entries.get(scope.owner?.id);
                return owner ? { owner: owner.owner, fields: owner.fields, index: owner.index } : null;
            };
            const prefixOf = owner => {
                const entry = entries.get(owner?.id);
                return !entry ? '' : owner.inline ? entry.path.slice(0, -owner.name.length) : entry.path + '.';
            };
            const belongsTo = (source, owner) => {
                for (let entry = source; entry; entry = entries.get(entry.owner?.id)) if (entry === owner) return true;
                return false;
            };
            const index = (source, target) => {
                if (source === undefined || source === 'contents') return;
                let names; try { names = protocol().expressionVariables(source); } catch (_) { return; }
                for (const name of names) {
                    const parts = name.replace(/\[\d+\]/g, '').split('.');
                    let scope = target ? { owner: target.owner, fields: target.fields, index: target.index } : { owner: null, fields: root.fields, index: Infinity };
                    while (parts[0] === 'PARENT') { scope = scope && parentScope(scope); parts.shift(); }
                    const current = parts[0] === 'CURRENT'; if (current) parts.shift();
                    while (scope && parts.length) {
                        const prefix = prefixOf(scope.owner), roots = (paths.get(prefix + parts[0]) ?? []).filter(entry => entry.fields === scope.fields && entry.index < scope.index);
                        if (roots.length) {
                            const candidates = (paths.get(prefix + parts.join('.')) ?? []).filter(entry => roots.some(owner => belongsTo(entry, owner)));
                            if (candidates.length === 1) addUsage(candidates[0].field.id, target?.field.id ?? root.id, target?.field.name ?? '整帧');
                            break;
                        }
                        scope = current ? null : parentScope(scope);
                    }
                }
            };
            index(root.lengthFrom, null);
            for (const entry of entries.values()) if (!entry.field.lengthSource && entry.field.byteLength === 0)
                index(entry.field.lengthFrom ?? entry.field.length, entry);
        }
        _lengthExpressionReferences(field) {
            const refs = model().inspectReferences(this.draft, field.id).filter(reference => ['length', 'lengthFrom'].includes(reference.property) &&
                !(reference.property === 'length' && model().findNode(this.draft, reference.nodeId)?.lengthFrom !== undefined));
            return [...new Map(refs.map(ref => [ref.nodeId + ':' + ref.property, ref])).values()];
        }
        _jumpToRule(field, kind) {
            this._selectField(field);
            const group = this.propertyHost.querySelector(`[data-rule-group="${kind}"]`);
            group?.scrollIntoView?.({ block: 'nearest' });
            (group?.querySelector('input, select, button') ?? group)?.focus?.({ preventScroll: true });
        }
        _renderUsageHints(parent, field) {
            const hints = this._node('div', 'protocol-field-usage');
            for (const rule of this.constraintUsage?.get(field.id) ?? []) {
                const text = `${rule.boundaryFallback ? '长度定界／验证' : rule.stage === 'parsing' ? '解析检查' : rule.stage === 'both' ? '解析／验证' : '附加验证'} · ${rule.name || rule.id}`;
                const button = this._button(text, null, () => rule.targetFieldId === field.id && ['length','checksum'].includes(rule.type) && this._fieldRole(field) !== 'legacy'
                    ? this._jumpToRule(field,rule.type) : this._openRule(rule.id), 'protocol-usage-button');
                button.setAttribute('data-constraint-usage', rule.id); hints.append(button);
            }
            const add = (kind, text, title = text, group = kind) => {
                const button = this._button(text, null, () => this._jumpToRule(field, group), 'protocol-usage-button');
                button.setAttribute('data-field-usage', kind); button.setAttribute('aria-label', field.name + '：' + title + '，编辑对应规则');
                button.title = title; hints.append(button);
            };
            const targets = this.ruleUsage.get(field.id) ?? [];
            if (targets.length) {
                const labels = targets.map(item => item.label);
                // Prefer the concrete segment name when the same source also bounds the whole frame.
                const first = targets.find(item => item.id !== this.draft.messages[0]?.id) ?? targets[0];
                add('length', '长度 → ' + first.label + (targets.length > 1 ? ' 等 ' + targets.length + ' 处' : ''), '长度 → ' + labels.join('、'));
            } else if (field.role === 'length') add('length', '长度 · 未关联');
            if (field.type === 'checksum') {
                const type = field.checksum?.type ?? 'sum', label = ['sum', 'xor'].includes(type) ? type.toUpperCase() + field.byteLength * 8 : type.toUpperCase();
                add('checksum', '校验 · ' + label);
            }
            if (this._fieldRole(field) === 'fixed') {
                const bytes = field.bytes ?? field.expectedBytes ?? [], text = records().protocolBytesText(bytes.slice(0, 3), this._dataBase(field));
                add('fixed', '固定 · ' + text + (bytes.length > 3 ? ' …' : ''), '固定内容：' + records().protocolBytesText(bytes.slice(0, 32), this._dataBase(field)) + (bytes.length > 32 ? ' …' : ''), 'content');
            } else if (field.type === 'reserved') add('reserved', '保留字节', '保留字节', 'content');
            if (hints.children.length) parent.append(hints);
        }
        _supportedDataTypes() {
            // Enum labels and fixed/checksum constraints use the separate content controls.
            return fieldTypes.filter(type => !['enum','fixed','checksum'].includes(type));
        }
        _scalarByteWidth(type) {
            const match=/^(?:u?int|float)(8|16|32|64)$/.exec(type);
            return match?Number(match[1])/8:type==='bool'?1:null;
        }
        _compatibleRoles(type, width) {
            const roles = [['data', '无约束']];
            if (width > 0 && (type === 'bytes' || /^(?:u?int|float)/.test(type) || ['bool', 'bitfield'].includes(type))) roles.push(['fixed', '固定内容']);
            if (/^uint(?:8|16|32)$/.test(type) && this.selectedField?.count === undefined) roles.push(['length','长度关联'], ['checksum','校验值']);
            return roles;
        }
        _editFieldKind(field, type, role) {
            const constraint = this._fieldRole(field);
            const fixedWidth=this._scalarByteWidth(type), nextWidth=fixedWidth ?? field.byteLength;
            if(constraint==='legacy') {
                if(type!==this._fieldDataType(field))throw new Error('请先整理旧版组合约束，再更改数据类型；原配置和引用已保留');
                this._change(()=>{if(fixedWidth!==null){field.byteLength=fixedWidth;delete field.length;}});return;
            }
            if (['length','checksum','legacy'].includes(constraint) && !/^uint(?:8|16|32)$/.test(type))
                throw new Error('请先将内容约束切换为无约束，再更改为不兼容的数据类型');
            role = ['length','checksum','legacy'].includes(role) ? 'data' : role;
            const linked = model().getLengthBindings(this.draft, field.id).length || model().isLengthSource(field) && this._lengthExpressionReferences(field).length;
            if (linked && (role !== 'data' || !/^uint(?:8|16|32)$/.test(type)))
                throw new Error('请先解除此字段的长度关联，再更改数据类型或内容约束');
            const checksum = field.type === 'checksum';
            if (checksum && (role !== 'data' || !/^uint(?:8|16|32)$/.test(type))) throw new Error('请先关闭校验规则，再更改为不兼容的数据类型或内容约束');
            if (role === 'fixed' && field.framingRole && type !== 'bytes' && field.type === 'fixed')
                throw new Error('起始同步和结束分隔使用原始字节，请先取消断帧角色再更改数据类型');
            if(role==='fixed'&&!this._compatibleRoles(type,nextWidth).some(item=>item[0]==='fixed'))
                throw new Error('当前类型不支持固定内容，请先明确修改内容约束；固定字节已保留');
            const fixedBytes = field.bytes ?? field.expectedBytes;
            if (role === 'fixed' && fixedBytes && fixedBytes.length !== nextWidth)
                throw new Error(`所选类型需要 ${nextWidth} 字节，现有固定内容为 ${fixedBytes.length} 字节；请先修改固定内容，原配置已保留`);
            if(fixedWidth!==null&&(field.lengthSource||field.boundary||field.lengthFrom!==undefined&&field.lengthFrom!==''))
                throw new Error('所选类型的字节数固定，请先明确解除现有长度来源或边界配置；原配置和引用已保留');
            if(field.enum&&Object.keys(field.enum).length&&!/^u?int/.test(type)&&!['bool','bitfield'].includes(type))
                throw new Error('当前字段已有枚举标签，所选类型不支持；请先处理枚举配置，原标签已保留');
            if(field.bits?.length&&!/^u?int/.test(type)&&type!=='bitfield')
                throw new Error('当前字段已有位字段，所选类型不支持；请先处理位字段，原配置已保留');
            if((field.fields?.length||field.ref)&&!['struct','repeat'].includes(type))
                throw new Error('当前字段包含子字段或共享结构引用；请先处理这些内容，不能静默删除');
            if(field.branches?.length&&!['choice','tlv'].includes(type))
                throw new Error('当前字段包含分支及子字段；请先处理这些内容，不能静默删除');
            if(field.headerFields?.length&&type!=='tlv')throw new Error('当前字段包含 TLV 头字段，请先处理，原字段引用已保留');
            if(field.until&&!['repeat','tlv'].includes(type))throw new Error('当前字段已有重复至段末的配置，请先明确调整重复方式');
            this._change(() => {
                const before = field.type, numericFixed = role === 'fixed' && type !== 'bytes';
                if(fixedWidth!==null){field.byteLength=fixedWidth;delete field.length;if(field.lengthFrom==='')delete field.lengthFrom;}
                if (field.role === 'length' && !linked && role !== 'data') delete field.role;
                field.type = checksum ? 'checksum' : type === 'bytes' && ['fixed','reserved'].includes(role) ? role : type;
                if (before === 'enum' && /^u?int/.test(type)) { field.type = 'enum'; field.baseType = type; }
                else delete field.baseType;
                if (field.type !== 'fixed') { delete field.bytes; delete field.framingRole; }
                else field.bytes ??= fixedBytes ?? new Array(field.byteLength || 1).fill(0);
                if (!numericFixed) delete field.expectedBytes;
                else field.expectedBytes ??= fixedBytes ?? new Array(field.byteLength || 1).fill(0);
                if (field.type === 'checksum') field.checksum ??= { type: 'sum', start: 0, end: { fieldId: field.id, edge: 'start' } };
                const integer = /^u?int/.test(type) || ['bitfield', 'bool'].includes(type);
                if (!integer) { delete field.bits; delete field.enum; }
                if (!['struct','repeat'].includes(type)) { delete field.fields; delete field.ref; }
                else if (!field.ref) field.fields ??= [];
                if (!['choice','tlv'].includes(type)) { delete field.branches; delete field.selector; delete field.selectorFieldId; }
                else { field.branches ??= []; field.selector ??= 'tag'; }
                if (type !== 'tlv') delete field.headerFields;
                else Object.assign(field, { ...model().createTLVTemplate().messages[0].fields[0], ...field });
                if (!['repeat','tlv'].includes(type)) delete field.until;
                else if (field.count === undefined && !field.until) field.count = 1;
                if (type === 'bitfield') field.bits ??= [];
            });
        }
        _enumKey(text, owner, bitWidth, base = this._dataBase(owner)) {
            const boolean = this._fieldDataType(owner) === 'bool';
            if (boolean && ['true','false'].includes(String(text).trim())) return String(text).trim();
            const key = String(this._integer(text, '枚举值', base)), value = BigInt(key);
            const bits = boolean ? 1 : bitWidth ?? (this._fieldWidth(owner) ?? 1) * 8;
            const signed = owner.type === 'int' || /^int\d/.test(this._fieldDataType(owner));
            const low = signed ? -(1n << BigInt(bits - 1)) : 0n;
            const high = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
            if (value < low || value > high) throw new Error(`枚举值超出 ${low}–${high} 范围`);
            return key;
        }
        _renderEnum(parent, owner, prefix, bitWidth, base = this._dataBase(owner)) {
            const section = this._node('div', 'protocol-enum-editor'); parent.append(section);
            section.append(this._node('h4', '', '枚举标签'));
            const entries = Object.entries(owner.enum ?? {}), numericKey = key => key === 'true' ? '1' : key === 'false' ? '0' : String(this._integer(key, '枚举值'));
            const store = next => this._change(() => { if (next.length) owner.enum = Object.fromEntries(next); else delete owner.enum; });
            entries.forEach(([key, label], index) => {
                const row = this._node('div', 'protocol-enum-row'); section.append(row);
                this._control(row, `${prefix}.${index}.value`, '数值', this._integerText(key, base), 'text', text => {
                    const nextKey = this._enumKey(text, owner, bitWidth, base);
                    if (entries.some(([other], at) => at !== index && numericKey(other) === numericKey(nextKey))) throw new Error('枚举值重复，请使用不同数值');
                    store(entries.map((entry, at) => at === index ? [nextKey, label] : entry));
                });
                this._control(row, `${prefix}.${index}.label`, '标签名称', label, 'text', text => {
                    if (!text.trim()) throw new Error('请填写枚举标签名称');
                    store(entries.map((entry, at) => at === index ? [key, text.trim()] : entry));
                });
                const remove = this._button('删除', `${prefix}.${index}-delete`, () => store(entries.filter((entry, at) => at !== index)));
                remove.setAttribute('aria-label', `删除枚举值 ${this._integerText(key, base)}`); row.append(remove);
            });
            section.append(this._button('添加枚举项', prefix + '-add', () => {
                let value = 0n; const used = new Set(entries.map(([key]) => numericKey(key)));
                while (used.has(String(value))) value++;
                const key = this._enumKey(String(value), owner, bitWidth, 'dec'); store([...entries, [key, '标签 ' + key]]);
            }));
        }
        _renderReferences(parent, field, rows) {
            const names = { length: '长度表达式', lengthFrom: '长度表达式', 'lengthSource.fieldId': '长度来源', count: '数组／重复数量',
                condition: '启用条件', selector: '分支选择', selectorFieldId: '分支选择', expression: '分支条件', lengthField: 'TLV 长度',
                'boundary.startFieldId': '前侧固定字节', 'boundary.endFieldId': '后侧固定字节', 'checksum.start.fieldId': '校验起点', 'checksum.end.fieldId': '校验终点' };
            const references = model().inspectReferences(this.draft, field.id).filter(ref => ref.nodeId !== field.id);
            if (!references.length) return;
            const section = this._section(parent, '被引用位置', 'protocol-field-references'), seen = new Set();
            for (const reference of references) {
                const key = reference.nodeId + ':' + reference.property;
                if (seen.has(key)) continue; seen.add(key);
                const node = model().findNode(this.draft, reference.nodeId); if (!node) continue;
                if ((this.draft.rules ?? []).includes(node)) {
                    const button = this._button(`${node.name || node.id} · ${names[reference.property] ?? reference.property}`, null, () => this._openRule(node.id));
                    button.setAttribute('data-reference-node', node.id); section.append(button); continue;
                }
                const owner = rows.find(row => row.field === node || row.field.branches?.includes(node));
                const label = owner ? owner.field === node ? owner.path : owner.path + ' / ' + (node.label || node.id) : '整帧';
                const button = this._button(`${label} · ${names[reference.property] ?? reference.property}${reference.kind === 'unresolved' ? '（需核对作用域）' : ''}`, null, () => {
                    if (owner) {
                        for (let row = owner.parent; row; row = row.parent) this.collapsed.delete(row.field.id);
                        this._selectField(owner.field);
                        const card = [...this.canvas.querySelectorAll('[data-field-id]')].find(item => item.getAttribute('data-field-id') === owner.field.id);
                        card?.scrollIntoView?.({ block: 'nearest' });
                    } else { this.framingSelected = true; this.selectedField = null; this.propertyHost.scrollTop = 0; this._renderMessages(); }
                    const branchIndex = owner?.field.branches?.indexOf(node) ?? -1;
                    const property = reference.property === 'length' || !owner && reference.property === 'lengthSource.fieldId' ? 'lengthFrom' : reference.property === 'selectorFieldId' ? 'selector' : reference.property;
                    const controlKey = branchIndex >= 0 ? `branch.${branchIndex}.${property}` : `${owner ? 'field' : 'frame'}.${property}`;
                    const control = [...this.propertyHost.querySelectorAll('[data-control]')].find(input => input.getAttribute('data-control') === controlKey);
                    const details = control?.closest('details'); if (details) details.open = true;
                    const propertyPanel=control?.closest('[data-property-panel]');if(propertyPanel)this.selectProperty(propertyPanel.getAttribute('data-property-panel'));
                    control?.scrollIntoView?.({ block: 'nearest' }); control?.focus();
                });
                button.setAttribute('data-reference-node', reference.nodeId); button.setAttribute('data-reference-property', reference.property); section.append(button);
            }
        }
        _renderFieldDetails(parent, rows) {
            const field = this.selectedField, section = this._section(parent, '字段属性', 'protocol-field-details');
            if (!field) { section.append(this._node('p', 'hint-text', '选择字段以编辑参数。')); return; }
            const set = (key, value) => this._change(() => {
                this._assign(field, key, value);
                if (key === 'type') {
                    if (['struct', 'repeat'].includes(value) && !field.ref) field.fields ??= [];
                    if (['choice', 'tlv'].includes(value)) { field.branches ??= []; field.selector ??= 'tag'; }
                    if (value === 'tlv') Object.assign(field, { ...model().createTLVTemplate().messages[0].fields[0], ...field });
                    if (value === 'fixed') field.bytes ??= [0];
                    if (value === 'repeat' && field.count === undefined && !field.until) field.count = 1;
                    if (value === 'enum') field.baseType ??= 'uint8';
                    if (value === 'checksum') field.checksum ??= { type: 'sum', start: 0, end: { fieldId: field.id, edge: 'start' } };
                }
            });
            const dataType = this._fieldDataType(field), role = this._fieldRole(field), widthValue = field.byteLength ?? this._fieldWidth(field) ?? 0;
            const framingMarker = field.type === 'fixed' && Boolean(field.framingRole);
            const supported=this._supportedDataTypes(),matches=supported.includes(dataType),fixedWidth=this._scalarByteWidth(dataType);
            const types = this._control(section, 'field.type', '数据类型', matches ? dataType : '', 'select', value => {
                try {
                    if (!supported.includes(value)) throw new Error('请选择支持的数据类型');
                    this._editFieldKind(field,value,role);
                } catch(error){types.value=matches?dataType:'';throw error;}
            }, [...(!matches ? [['', '请选择支持的数据类型']] : []), ...supported.map(type => [type, typeNames[type] ?? type])]);
            if (!matches) { types.setAttribute('aria-invalid', 'true'); types.children[0].disabled = true; }
            const widthInput=this._control(section,'field.byteLength',fixedWidth!==null?'字节数（由数据类型决定）':'字节数（0 表示变长）',fixedWidth ?? widthValue,'text',value=>{
                if(fixedWidth!==null){widthInput.value=String(fixedWidth);return;}
                this._change(()=>{
                    const width=this._number(value,'字节数');
                    if(field.lengthSource&&width!==0)throw new Error('请先在长度字段处解除绑定，再设置固定字节数');
                    field.byteLength=width;delete field.length;
                    if(width===0&&!field.lengthSource&&!field.boundary&&field.lengthFrom===undefined)field.lengthFrom='';
                });
            });
            widthInput.disabled=fixedWidth!==null;
            if(fixedWidth!==null)widthInput.title='由所选数据类型决定；数组表示每个元素的字节数。';
            if(fixedWidth!==null&&widthValue!==fixedWidth){
                const hint=this._node('p','protocol-field-error',`旧配置字节数为 ${widthValue}，当前类型需要 ${fixedWidth}；原配置尚未改写，请确认按类型修正。`);
                hint.setAttribute('data-control','field.width-conflict');section.append(hint,
                    this._button('按类型修正字节数','fix-field-width',()=>this._editFieldKind(field,dataType,role)));
            }
            if (framingMarker) section.append(this._node('p', 'hint-text', '同步／结束固定字段使用原始字节；取消断帧角色后可改为其它数据类型。'));
            const roles = this._compatibleRoles(dataType, widthValue), roleMatches = roles.some(item => item[0] === role);
            const content = this._section(parent, '内容约束', 'protocol-content-constraints'); content.setAttribute('data-rule-group', 'content');
            this._control(content, 'field.role', '内容约束', role === 'legacy' ? 'legacy' : roleMatches ? role : '', 'select', value => {
                if (!roles.some(item => item[0] === value)) throw new Error('请选择当前类型支持的内容约束');
                this._requestContentConstraint(field, value);
            }, [...(role === 'legacy' ? [['legacy','旧版组合约束（保留原配置）']] : !roleMatches ? [['', '请选择当前类型支持的内容约束']] : []), ...roles]);
            if (role === 'legacy') content.append(this._node('p','hint-text','此字段存在多种旧约束，尚未自动修改。选择一种约束并确认后，只保留所选主约束；其它字段引用保持。'),
                this._button('查看相关规则',null,() => this.selectTab('rules')));
            if (this.pendingConstraint?.fieldId === field.id) {
                const pending = this.pendingConstraint, confirmation = this._node('div','protocol-constraint-confirm');
                confirmation.setAttribute('role','status');
                confirmation.append(this._node('p','hint-text','切换将停用本字段原有的固定内容、长度推导／验证或校验，并停止其自动回填；可能影响断帧。字段及其它引用保留，可撤销。'),
                    this._button('确认切换','confirm-content-constraint',() => this._setContentConstraint(field.id,pending.kind)),
                    this._button('取消','cancel-content-constraint',() => { this.pendingConstraint = null; this._renderMessages(); }));
                content.append(confirmation);
            }
            const radix = this._control(section, 'field.displayBase', '数值进制', this._dataBase(field), 'select', value => this._setDataBase(field, value), [['dec', '十进制'], ['hex', '十六进制']]);
            radix.title = '控制本字段的整数、固定字节、枚举、分支和校验参数；无前缀输入按所选进制解释，0x 明确指定十六进制。结构参数、浮点数和表达式保持原样。';
            if (field.count !== undefined && !['repeat','tlv'].includes(field.type))
                section.append(this._node('p', 'hint-text', '数组字段的字节数表示每个元素的宽度。'));
            if (this.validationError?.nodeId === field.id) {
                const error = this._node('p', 'protocol-field-error', messageZh(this.validationError)); error.setAttribute('role', 'alert'); section.append(error);
            }
            this._control(section, 'field.name', '表达式变量名', field.name, 'text', value => {
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('变量名需以字母或下划线开头，仅含字母、数字、下划线。');
                const renamed = model().renameField(this.draft, field.id, { name: value });
                this._change(() => { this.draft = renamed.protocol; this.selectedMessage = this.draft.messages?.find(item => item.id === this.selectedMessage?.id); this.selectedField = model().findField(this.draft, field.id); });
                if (renamed.references.length) this.status.textContent = '变量名已修改；已更新可确定的表达式，请检查 ' + renamed.references.length + ' 处相关引用';
            });
            section.append(symbols().createReservedNamesHelp(this.document, 'field'));
            const width = this._node('p', 'hint-text', '存储宽度：' + (this._fieldWidth(field) ?? '由内容决定') + (this._fieldWidth(field) === null ? '' : ' 字节')); width.setAttribute('data-control', 'field.width'); section.append(width);
            this._control(section, 'field.endian', '字节序', field.endian ?? '', 'select', value => set('endian', value), [['', '继承协议'], ['little', '小端'], ['big', '大端']]);
            this._control(section, 'field.count', '数组数量 / 表达式', field.count, 'text', value => set('count', this._expression(value)));
            if (role === 'fixed') {
                this._control(content, 'field.bytes', '固定内容（按字节分隔）', records().protocolBytesText(field.bytes ?? field.expectedBytes, this._dataBase(field)), 'text', value => {
                    const bytes = records().parseProtocolBytes(value, this._dataBase(field), '固定内容');
                    if (bytes.length !== widthValue) throw new Error(`固定内容必须为 ${widthValue} 字节`);
                    set(field.type === 'fixed' ? 'bytes' : 'expectedBytes', bytes);
                });
                if (field.type === 'fixed') this._control(content, 'field.framingRole', '断帧角色', field.framingRole ?? '', 'select', value => set('framingRole', value), [['', '仅验证固定字节'], ['sync', '起始同步'], ['end', '结束分隔']]);
            }
            if (field.type === 'string') this._control(section, 'field.encoding', '文本编码', field.encoding ?? 'utf-8', 'text', value => set('encoding', value));
            if (/^u?int/.test(dataType) || ['bool', 'bitfield'].includes(dataType)) this._renderEnum(content, field, 'field.enum');
            if (['repeat', 'tlv'].includes(field.type)) {
                const mode = field.until === 'end' ? 'end' : typeof field.count === 'string' ? 'field' : 'fixed';
                this._control(section, 'field.repeatMode', '重复方式', mode, 'select', value => this._change(() => { delete field.until; delete field.count; if (value === 'end') field.until = 'end'; else field.count = value === 'fixed' ? 1 : 'count'; }), [['fixed', '固定次数'], ['field', '根据字段值'], ['end', '重复至当前段末']]);
                if (mode !== 'end') this._control(section, 'field.repeatCount', mode === 'fixed' ? '重复次数' : '计数字段 / 表达式', field.count, 'text', value => set('count', this._expression(value)));
            }
            if (field.type === 'tlv') {
                field.headerFields ??= [{ name: 'tag', type: 'uint8' }, { name: 'size', type: 'uint8' }];
                for (const [index, title] of [[0, '类型 T'], [1, '长度 L']]) {
                    const entry = field.headerFields[index] ??= { name: index ? 'size' : 'tag', type: 'uint8' };
                    this._control(section, 'tlv.' + index + '.type', title + '宽度', entry.type, 'select', value => this._change(() => { entry.type = value; entry.byteLength = Number(value.slice(4)) / 8; }), [['uint8', '1 字节'], ['uint16', '2 字节'], ['uint32', '4 字节']]);
                    this._control(section, 'tlv.' + index + '.endian', title + '字节序', entry.endian ?? '', 'select', value => this._change(() => { this._assign(entry, 'endian', value); }), [['', '继承协议'], ['little', '小端'], ['big', '大端']]);
                }
                this._control(section, 'field.lengthField', '长度字段变量', field.lengthField ?? 'size', 'text', value => set('lengthField', value));
                this._control(section, 'field.lengthIncludesHeader', 'L 包含 T 和 L 字节', field.lengthIncludesHeader, 'checkbox', value => set('lengthIncludesHeader', value));
                this._control(section, 'field.lengthUnit', '长度单位（字节）', field.lengthUnit ?? 1, 'text', value => set('lengthUnit', this._number(value, '长度单位')));
                this._control(section, 'field.lengthAdjustment', '长度修正（字节）', field.lengthAdjustment ?? 0, 'text', value => set('lengthAdjustment', this._number(value, '长度修正')));
                section.append(this._node('p', 'hint-text', '未知类型保留原始 V；每个条目在自己的长度边界内解析。'));
            }
            if (['struct', 'choice', 'tlv'].includes(field.type)) {
                this._control(section, 'field.leftover', '段内剩余字节', field.leftover ?? 'preserve', 'select', value => set('leftover', value), [['preserve', '保留原始字节'], ['exact', '必须完整消费'], ['padding', '验证填充字节']]);
                if (field.leftover === 'padding') this._control(section, 'field.paddingByte', '填充字节值', this._integerText(field.paddingByte ?? 0, this._dataBase(field)), 'text', value => set('paddingByte', this._integer(value, '填充值', this._dataBase(field))));
            }
            if (field.type === 'tlv') this._control(section, 'field.invalidItem', '非法条目处理', field.invalidItem ?? 'stop', 'select', value => set('invalidItem', value), [['stop', '停止解析'], ['skip', '跳过已知长度条目']]);
            if (['choice', 'tlv'].includes(field.type)) this._renderBranches(section, field, set);
            if (field.type === 'bitfield') this._renderBits(section, field);
            if (role === 'length') this._renderLengthTargets(content, field, true);
            if (role === 'checksum') {
                const check = this._node('div','protocol-checksum-rules protocol-constraint-controls'); check.setAttribute('data-rule-group','checksum'); content.append(check);
                const rule = this._fieldConstraintRules(field,'checksum',true).find(rule => rule.enabled !== false) ??
                    (field.contentConstraint === 'checksum' && this._fieldConstraintRules(field,'checksum',true)[0]);
                if (field.type === 'checksum') this._renderFieldChecksum(check,field);
                else if (rule) {
                    this._renderChecksumConfig(check,rule.checksum ?? {},(key,value) => this._change(() => { (rule.checksum ??= {})[key] = value; }), 'field.checksum',field);
                    this._renderRuleBehavior(check,rule,'field.checksum');
                    this._control(check,'field.checksum.send','发送行为',rule.send ?? 'verify','select',value => this._change(() => { rule.send = value; }),[['fill','自动回填并验证'],['verify','仅验证']]);
                    check.append(this._button('查看规则约束','jump-checksum-rule',() => this._openRule(rule.id)));
                }
            }
            if (field.byteLength === 0) {
                const boundary = this._section(parent,'读取边界','protocol-read-boundary');
                boundary.setAttribute('data-rule-group','length');
                this._renderVariableLength(boundary, field);
            }
            const associations = this._section(parent,'关联信息','protocol-checksum-coverage');
            this._renderChecksumCoverage(associations, field);
            if (this.compiled?.fieldEntries?.get(field.id)?.field.lengthRelation) {
                const relation = this.compiled.fieldEntries.get(field.id).field.lengthRelation;
                associations.append(this._node('p','hint-text','备用长度来源：' + relation.source),
                    this._button('定位长度字段',null,() => { const source = this._fieldRows().find(row => row.path === relation.source); if (source) this._selectField(source.field); }));
            }
            if (role !== 'length') for (const reference of this._lengthExpressionReferences(field)) {
                const target = model().findNode(this.draft,reference.nodeId);
                associations.append(this._node('p','hint-text','被长度表达式引用：' + (target?.name || reference.nodeId)),
                    this._button('定位引用字段',null,() => { if (target?.id === this.draft.messages[0].id) this.selectTab('framing'); else if (target) this._selectField(target); }));
            }
            if (associations.children.length === 1) associations.append(this._node('p','hint-text','暂无关联规则。'));
            const options = this._node('section', 'protocol-editor-section protocol-field-options'); parent.append(options);
            const advanced = this._node('details', 'protocol-field-advanced'); advanced.setAttribute('data-detail', 'advanced'); advanced.append(this._node('summary', '', '高级设置')); options.append(advanced);
            const identity = this._control(advanced, 'field.id', '稳定 ID（只读）', field.id, 'text'); identity.readOnly = true;
            for (const [key, title] of [['offset', '偏移（留空顺序排列）'], ['condition', '可选段 / 启用条件']]) {
                const input=this._control(advanced, 'field.' + key, title, field[key], 'text', value => set(key, this._expression(value)));
                if(key==='condition')this._controlHelp(input,'留空表示始终读取；仅在表达式成立时读取此字段，不成立时不消耗该字段的字节。例如 version >= 2；引用的字段需先被读取。');
            }
            const origin=this._control(advanced, 'field.offsetBase', '偏移起点', field.offsetBase ?? 'segment', 'select', value => set('offsetBase', value), [['segment', '当前子段'], ['frame', '整帧']]);
            this._controlHelp(origin,'字节位置从 0 开始。偏移为 4 时，从所选的当前子段或整帧起点向后 4 字节读取；偏移留空则顺序读取，此选项不生效。');
            if (field.type === 'struct') {
                this._control(advanced, 'field.ref', '共享结构名称', field.ref, 'text', value => set('ref', value));
                if (field.ref) {
                    const count = model().flattenFields(this.draft).filter(item => item.field.ref === field.ref).length;
                    advanced.append(this._node('p', 'protocol-shared-notice', '共享结构：修改会影响 ' + count + ' 处引用。'), this._button('转为独立结构', 'detach-structure', () => this._change(() => { const updated = model().makeStructureIndependent(this.draft, field.id); this.draft = updated; this.selectedMessage = this.draft.messages?.find(item => item.id === this.selectedMessage?.id); this.selectedField = model().findField(this.draft, field.id); })));
                }
            }
            if (field.type !== 'bitfield') this._renderBits(advanced, field);
            this._renderReferences(options, field, rows);
        }
        _renderBranches(parent, field, set) {
            this._control(parent, 'field.selector', '分支选择变量 / 表达式', field.selector ?? '', 'text', value => set('selector', value));
            for (let index = 0; index < (field.branches ?? []).length; index++) this._renderBranchEditor(parent,field,index);
            parent.append(this._button('添加分支', 'add-branch', () => this._change(() => { (field.branches ??= []).push({ id: 'branch-' + Date.now().toString(36) + '-' + (++nextInstance), equals: (field.branches?.length ?? 0) + 1, fields: [] }); })));
        }
        _renderBranchDetails(parent,field,branch) {
            this._renderBranchEditor(parent,field,field.branches.indexOf(branch),true);
            const scope=this._section(parent,'关联信息','protocol-checksum-coverage');
            scope.append(this._node('p','hint-text','所属字段：'+field.name+'；分支选择表达式：'+(field.selector ?? '未设置')+'。匹配值沿用所属字段的'+(this._dataBase(field)==='hex'?'十六进制':'十进制')+'设置。'),
                this._button('打开所属字段','open-branch-parent',()=>this._selectField(field)));
        }
        _renderBranchEditor(parent,field,index,standalone=false) {
            const branch = field.branches[index], section = this._section(parent, '分支 ' + (index + 1), 'protocol-branch-editor');
            section.setAttribute('data-property-branch', branch.id);
            const heading = this._node('div', 'protocol-branch-editor-heading'), title = section.querySelector('h3');
            heading.append(this._branchHandle(field, branch, section, this.propertyHost), title); section.append(heading);
            const mode = branch.default ? 'default' : branch.range ? 'range' : branch.mask ? 'mask' : branch.expression ? 'expression' : 'equals';
            const edit = (key, value) => this._change(() => this._assign(branch, key, value));
            this._control(section, 'branch.' + index + '.label', '分支名称', branch.label, 'text', value => edit('label', value));
            this._control(section, 'branch.' + index + '.mode', '匹配方式', mode, 'select', value => this._change(() => {
                for (const key of ['equals', 'range', 'mask', 'expression', 'default']) delete branch[key];
                if (value === 'default') branch.default = true; else if (value === 'range') branch.range = [0, 1]; else if (value === 'mask') branch.mask = { mask: 255, value: 1 }; else if (value === 'expression') branch.expression = 'tag == 1'; else branch.equals = 1;
            }), [['equals', '等于值'], ['range', '闭区间'], ['mask', '掩码匹配'], ['expression', '条件表达式'], ['default', '默认分支']]);
            if (mode === 'equals') this._control(section, 'branch.' + index + '.equals', '匹配值', this._integerText(branch.equals, this._dataBase(field)), 'text', value => edit('equals', this._integer(value, '匹配值', this._dataBase(field))));
            if (mode === 'range') for (const [position, title] of [[0, '最小值'], [1, '最大值']]) this._control(section, 'branch.' + index + '.range.' + position, title, this._integerText(branch.range[position], this._dataBase(field)), 'text', value => this._change(() => { branch.range[position] = this._integer(value, title, this._dataBase(field)); }));
            if (mode === 'mask') for (const [key, title] of [['mask', '掩码'], ['value', '匹配值']]) this._control(section, 'branch.' + index + '.mask.' + key, title, this._integerText(branch.mask[key], this._dataBase(field)), 'text', value => this._change(() => { branch.mask[key] = this._integer(value, title, this._dataBase(field)); }));
            if (mode === 'expression') this._control(section, 'branch.' + index + '.expression', '匹配表达式', branch.expression, 'text', value => edit('expression', value));
            section.append(this._button('添加分支字段', 'branch-' + index + '-add', () => this._addField('uint8', branch)));
            if(!standalone)section.append(this._button('删除分支', 'branch-' + index + '-delete', () => this._requestDelete('branch',branch.id)));
        }
        _renderBits(parent, field) {
            if (field.type !== 'bitfield' && !/^(?:u?int)/.test(field.type === 'enum' ? field.baseType ?? 'uint8' : field.type)) return;
            const section = this._section(parent, field.type === 'bitfield' ? '位内容' : '位字段', 'protocol-bit-fields');
            const totalBits = (this._fieldWidth(field) ?? 0) * 8;
            section.append(this._node('p', 'hint-text', `总长 ${totalBits} bit；位号从最低有效位 0 开始。保留位不作为数值通道输出。`));
            const bits = field.bits ?? [];
            for (let index = 0; index < bits.length; index++) {
                const bit = field.bits[index], row = this._node('div', 'protocol-bit-row'); section.append(row);
                for (const [key, title] of [['name', '位名称'], ['offset', '最低位'], ['length', '位宽']])
                    this._control(row, `bit.${index}.${key}`, title, bit[key], 'text', value => {
                        const parsed = key === 'name' ? value : this._number(value, title);
                        if (key === 'name') { const conflict = symbols().ReservedNames.error(value, 'field'); if (conflict) throw new Error(conflict); }
                        this._change(() => { bit[key] = parsed; });
                    });
                this._control(row, `bit.${index}.type`, '位类型', bit.type ?? 'uint', 'select', value => this._change(() => {
                    bit.type = value; if (value === 'bool') bit.length = 1;
                }), [['uint', '无符号数值'], ['int', '有符号数值'], ['bool', '单比特开关'], ['reserved', '保留位']]);
                if (bit.type !== 'reserved') this._renderEnum(row, bit, `bit.${index}.enum`, bit.length, this._dataBase(field));
                row.append(this._button('删除位字段', 'delete-bit-' + index, () => this._requestDelete('bit',bit.id)));
            }
            const add = reserved => this._change(() => {
                const bits = field.bits ??= [], ranges = bits.map(bit => ({ start: bit.offset, end: bit.offset + bit.length })).sort((a, b) => a.start - b.start);
                let start = 0, end = totalBits;
                for (const range of ranges) { if (range.start > start) { end = range.start; break; } start = Math.max(start, range.end); }
                if (start >= totalBits || end <= start) throw new Error('位段已经配置完整，请先删除或缩小已有位字段');
                const prefix = reserved ? 'reserved' : 'bit'; let index = 1; while (bits.some(bit => bit.name === prefix + index)) index++;
                bits.push({ name: prefix + index, offset: start, length: reserved ? end - start : 1, type: reserved ? 'reserved' : 'uint' });
            });
            section.append(this._button('添加位字段', 'add-bit', () => add(false)), this._button('添加保留位', 'add-reserved-bit', () => add(true)));
        }
        _renderFieldChecksum(parent, field) {
            const config = field.checksum ?? { type: 'sum', start: 0, end: { fieldId: field.id, edge: 'start' } };
            this._renderChecksumConfig(parent,config,(key,value) => this._change(() => { (field.checksum ??= config)[key] = value; }),'field.checksum',field);
            parent.append(this._node('p','hint-text','旧版字段内校验：接收时验证、发送时自动生成。可在规则约束中显式转为独立规则，以配置阶段、强弱和发送行为。'));
        }
        _renderChecksumConfig(parent, config, edit, prefix, field) {
            const width = this._fieldWidth(field ?? {}) * 8;
            const algorithms = [['sum','求和'],['xor','异或'], ...[8,16,32].filter(bits => bits === width).map(bits => ['crc' + bits,'CRC' + bits])];
            this._control(parent,prefix + '.type','校验算法',config.type ?? 'sum','select',value => edit('type',value),algorithms);
            const fields = this._fieldRows().map(row => [row.field.id,row.path]);
            for (const [key,title] of [['start','覆盖起点'],['end','覆盖终点']]) {
                const value = config[key] ?? (key === 'start' ? 0 : {fieldId:field?.id ?? '',edge:'start'});
                const isField = value && typeof value === 'object';
                this._control(parent,prefix + '.' + key + '.mode',title,isField ? 'field' : 'expression','select',mode =>
                    edit(key,mode === 'field' ? {fieldId: key === 'end' ? field?.id ?? '' : fields[0]?.[0] ?? '',edge:'start'} : 0),[['field','选择字段'],['expression','字节偏移／表达式']]);
                if (isField) {
                    this._control(parent,prefix + '.' + key + '.fieldId',key === 'start' ? '起点字段' : '终点字段',value.fieldId,'select',id => edit(key,{...value,fieldId:id}),[['','请选择字段'],...fields]);
                    const include = key === 'start' ? value.edge !== 'end' : value.edge === 'end';
                    this._control(parent,prefix + '.' + key + '.include',key === 'start' ? '包含起点字段' : '包含终点字段',include,'checkbox',checked =>
                        edit(key,{...value,edge:(key === 'start' ? checked : !checked) ? 'start' : 'end'}));
                } else {
                    const input = this._control(parent,prefix + '.' + key,'字节偏移／表达式',value,'text',next => edit(key,this._expression(next)));
                    if (prefix.startsWith('rule.')) this.expressionCompletions.push(autocomplete().attachProtocolAutocomplete(input,{container:this.dialog,schema:this.draft,frame:true,constraint:true,property:'rule.checksum.' + key}));
                }
            }
            if (String(config.type).startsWith('crc')) {
                const base = this._dataBase(field ?? {});
                for (const [key,title] of [['polynomial','生成多项式'],['init','初始值'],['xorOut','输出异或值']])
                    this._control(parent,prefix + '.' + key,title,this._integerText(config[key] ?? 0,base),'text',value => edit(key,this._integer(value,title,base)));
                for (const [key,title] of [['reflectIn','输入按位反射'],['reflectOut','输出按位反射']])
                    this._control(parent,prefix + '.' + key,title,Boolean(config[key]),'checkbox',value => edit(key,value));
            }
            parent.append(this._node('p','hint-text','包含起点从该字段开头计算；不包含从字段结束计算。包含终点计算到该字段结束；不包含在字段开头停止。校验范围不可包含校验值自身。'));
        }
        _renderJson() {
            const panel = this.panels.get('json'); panel.replaceChildren();
            panel.append(this._node('p', 'hint-text', '整帧协议 JSON 与可视化结构双向同步。可在此设置复用结构、嵌套条件分支和复杂表达式。'));
            const toolbar = this._node('div', 'protocol-editor-toolbar'), file = this._node('input');
            file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
            file.addEventListener('change', async () => {
                const selected = file.files?.[0], generation = this.generation; if (!selected) return;
                try {
                    if (selected.size > 16777216) throw new Error('协议 JSON 文件不能超过 16 MiB');
                    const text = await selected.text();
                    if (!this.disposed && generation === this.generation) this.importJson(text);
                } catch (error) { if (!this.disposed && generation === this.generation) this._error(error); }
                finally { file.value = ''; }
            });
            toolbar.append(this._button('导入 JSON 文件', 'import-json', () => file.click()),
                this._button('导出 JSON 文件', 'export-json', () => {
                    const text = this.exportJson(), urlApi = this.document.defaultView?.URL ?? root.URL;
                    const url = urlApi.createObjectURL(new Blob([text], { type: 'application/json' }));
                    const anchor = this._node('a'); anchor.href = url; anchor.download = `${(this.draft.id || 'protocol').replace(/[\\/:*?"<>|]/g, '_')}.json`;
                    anchor.click(); urlApi.revokeObjectURL(url);
                }), file);
            panel.append(toolbar);
            this.jsonInput = this._control(panel, 'schema-json', '协议 JSON', JSON.stringify(this.draft, null, 2), 'textarea');
            this.jsonInput.rows = 24; this.jsonInput.className = 'protocol-schema-json';
            this.jsonInput.addEventListener('input', () => {
                if (this.disposed || this.busy) return;
                try {
                    const value = JSON.parse(this.jsonInput.value);
                    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('协议必须是 JSON 对象');
                    this.history.push(clone(this.draft)); this.future = []; this.generation++;
                    try { this.draft = model().toUnified(value); } catch (_) { this.draft = value; }
                    this._checkPristine();
                    this.jsonInvalid = false; this.selectedField = null; this.previewRecord = null; this.selectedSpan = null;
                    this.status.textContent = '草稿已修改，尚未应用';
                    this._validate(); this._renderMessages(); this._renderPreview();
                    this._renderLibrary(); this._renderDiagnostics(); this._renderLayout(); this._publish();
                } catch (error) { this.jsonInvalid = true; this.applyButton.disabled = true; this._error(error); }
            });
        }
        importJson(text) {
            const compiled = protocol().compile(model().toUnified(JSON.parse(text)));
            this.history.push(clone(this.draft)); this.future = []; this.generation++; this.emptyLibrary = false;
            if (this.getProtocols) { const imported = model().importProtocol(this.library, compiled.schema); this.library = imported.protocols; this.libraryId = imported.protocol.id; this.draft = imported.protocol; }
            else this.draft = clone(compiled.schema);
            for(const [key,item] of this.pristine)if(item.protocolId===this.draft.id)this.pristine.delete(key);
            this.jsonInvalid = false; this.selectedField = null;
            this.selectedMessage = this.draft.messages[0]; this.previewRecord = null; this.selectedSpan = null;
            this._render(); this.selectTab('json'); this._publish(); this.status.textContent = '协议草稿已导入，尚未应用';
        }
        exportJson() {
            if (this.jsonInvalid) throw new Error('请先修正协议 JSON');
            return JSON.stringify(this.draft, null, 2) + '\n';
        }
        _getSamples() {
            const samples = this.editorState.samples;
            return samples && Object.hasOwn(samples, this.draft.id) && Array.isArray(samples[this.draft.id]) ? samples[this.draft.id] : [];
        }
        _setSamples(samples) {
            if (!this.editorState.samples || typeof this.editorState.samples !== 'object' || Array.isArray(this.editorState.samples)) this.editorState.samples = {};
            Object.defineProperty(this.editorState.samples, this.draft.id, { value: samples, writable: true, configurable: true, enumerable: true });
        }
        _renderPreview() {
            const panel = this.panels.get('preview'); panel.replaceChildren();
            const samples = this._getSamples();
            const sampleTools = this._node('div', 'protocol-sample-toolbar'); panel.append(sampleTools);
            this._control(sampleTools, 'sample-select', '已保存样例', this.sampleId ?? '', 'select', id => {
                const sample = samples.find(item => item.id === id); this.sampleId = id;
                if (sample) { this.sampleName = sample.name; this.sampleHex = sample.hex; this.sampleValues = sample.values ?? '{}'; this.previewMessageId = sample.messageId; this.previewRecord = null; this._renderPreview(); }
            }, [['', '未保存的样例'], ...samples.map(item => [item.id, item.name])]);
            this._control(sampleTools, 'sample-name', '样例名称', this.sampleName ?? '', 'text', value => { this.sampleName = value; });
            sampleTools.append(this._button('保存样例', 'save-sample', () => {
                const name = (this.sampleName ?? '').trim(); if (!name) throw new Error('请先填写样例名称');
                this._hex(this.hexInput.value);
                if (!this.sampleId && samples.length >= 100) throw new Error('每个协议最多保存 100 个样例');
                const sample = { id: this.sampleId || 'sample-' + Date.now().toString(36) + '-' + (++nextInstance), name, hex: this.hexInput.value, values: this.valuesInput.value, messageId: this.previewMessageId };
                const index = samples.findIndex(item => item.id === sample.id); if (index >= 0) samples[index] = sample; else samples.push(sample);
                this._setSamples(samples); this.sampleId = sample.id; this._saveState(); this._renderPreview(); this.status.textContent = '样例已保存';
            }), this._button('删除样例', 'delete-sample', () => {
                this._setSamples(samples.filter(item => item.id !== this.sampleId)); this.sampleId = ''; this._saveState(); this._renderPreview();
            }), this._button('批量解码', 'batch-decode', () => { void this.checkSamples(false); }), this._button('流检查', 'stream-check', () => { void this.checkSamples(true); }));
            const tools = this._node('div', 'protocol-editor-toolbar');
            const candidates = this.compiled?.frameAliases?.size ? [...this.compiled.frameAliases.values()] : this.compiled?.messages;
            const entries = candidates ? candidates.map(message => ({ id: message.id, message })) : this._messages(); panel.append(tools);
            if (!entries.some(entry => entry.id === this.previewMessageId)) this.previewMessageId = entries[0]?.id;
            this._control(tools, 'preview-message', '编码样例的消息类型', this.previewMessageId, 'select', value => { this.previewMessageId = value; }, entries.map(entry => [entry.id, entry.message.name ?? entry.id]));
            this.valuesInput = this._control(panel, 'preview-values', '编码字段值（JSON；精确整数或 Hex 可用字符串）', this.sampleValues, 'textarea', value => { this.sampleValues = value; });
            this.hexInput = this._control(panel, 'preview-hex', '完整样例帧 Hex', this.sampleHex, 'textarea', value => { this.sampleHex = value; });
            const buttons = this._node('div', 'protocol-editor-toolbar');
            buttons.append(this._button('解码 Hex', 'decode', () => this.decode()), this._button('编码样例字段', 'encode', () => this.encode())); panel.append(buttons);
            this.location = this._node('p', 'protocol-preview-location', '选择解码字段，查看对应字节和位。');
            this.location.setAttribute('data-control', 'preview-location'); panel.append(this.location);
            this.byteHost = this._node('div', 'protocol-preview-bytes'); panel.append(this.byteHost);
            this.previewHost = this._node('div', 'protocol-preview-fields'); panel.append(this.previewHost);
            this._renderPreviewResults();
            this.sampleResultsHost = this._node('div', 'protocol-sample-results'); panel.append(this.sampleResultsHost);
            this._renderSampleResults();
        }
        _renderSampleResults() {
            if (!this.sampleResultsHost) return; this.sampleResultsHost.replaceChildren();
            for (const item of (this.sampleResults ?? []).slice(0, 100)) this.sampleResultsHost.append(this._node('p', item.ok ? 'protocol-sample-pass' : 'protocol-sample-fail', item.name + '：' + messageZh(item.message)));
        }
        async checkSamples(stream = false) {
            if (this.disposed || this.jsonInvalid || this.emptyLibrary) return;
            const generation = this.checkGeneration = (this.checkGeneration ?? 0) + 1, editGeneration = this.generation;
            const current = () => !this.disposed && this.opened && generation === this.checkGeneration && editGeneration === this.generation;
            const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
            const samples = stream ? [{ name: this.sampleName || '当前字节流', hex: this.hexInput.value }] : clone(this._getSamples());
            if (!samples.length) { this._error(new Error('请先保存至少一个命名样例')); return; }
            const schema = clone(this.draft); let compiled, pool;
            try { compiled = protocol().compile(schema); pool = this.getWorkerPool?.(); }
            catch (error) { this._error(error); return; }
            if (typeof pool?.runTask !== 'function') pool = null;
            const results = new Array(samples.length); let nextSample = 0;
            this.status.textContent = stream ? '正在检查字节流…' : '正在批量解码…';
            const processNext = async () => {
                while (current() && nextSample < samples.length) {
                    const index = nextSample++, sample = samples[index];
                    // A task boundary lets paint/input run even when the pool uses a local fallback.
                    await yieldTask(); if (!current()) return;
                    try {
                        const bytes = Uint8Array.from(this._hex(sample.hex));
                        if (stream) {
                            let counts;
                            if (pool) counts = await pool.runTask({ kind: 'protocol-stream-check', schema, bytes, chunkSize: 16384 });
                            else {
                                const parser = new (protocol().StreamParser)(compiled, { maxDecodedFields: 32768 });
                                counts = { frames: 0, errors: 0, invalidFrames: 0, pending: 0 };
                                parser.onFrameParsed = record => { counts.frames++; if (record.valid === false) { counts.invalidFrames++; counts.errors++; } };
                                parser.onFrameError = () => { counts.errors++; };
                                for (let offset = 0; offset < bytes.length; offset += 16384) {
                                    await yieldTask(); if (!current()) return;
                                    parser.appendData(bytes.subarray(offset, offset + 16384));
                                }
                                counts.pending = parser.length;
                            }
                            if (!current()) return;
                            const { frames, errors, pending, invalidFrames = 0 } = counts;
                            results[index] = { name: sample.name, ok: frames > 0 && !errors && !pending,
                                message: Math.max(0, frames - invalidFrames) + ' 帧通过 · ' + errors + ' 处异常 · 剩余 ' + pending + ' 字节' };
                        } else {
                            const record = pool ? (await pool.runTask({ kind: 'protocol-decode', schema, records: [bytes], maxDecodedFields: 32768 }))[0]
                                : protocol().decode(bytes, compiled, { maxFields: 32768 });
                            if (!current()) return;
                            if (!record) throw new Error('解析任务未返回样例结果');
                            const warnings = record.warnings ?? [];
                            results[index] = { name: sample.name, ok: record.valid !== false, message: record.valid === false ? warnings.map(item => item.message).join('；') : '通过 · ' + bytes.length + ' 字节 · ' + (record.flatFields?.length ?? 0) + ' 字段' };
                        }
                    } catch (error) {
                        if (!current()) return;
                        results[index] = { name: sample.name, ok: false, message: messageZh(error) };
                    }
                }
            };
            // The shared pool owns CPU reservation and worker lifetime; only fill its configured capacity.
            const capacity = pool ? Math.max(1, Math.floor(pool.workerLimit ?? pool.maxWorkers ?? 1)) : 1;
            await Promise.all(Array.from({ length: Math.min(samples.length, capacity) }, () => processNext()));
            if (!current()) return;
            this.sampleResults = results; this._renderSampleResults(); this.status.textContent = results.filter(item => item.ok).length + ' / ' + results.length + ' 样例通过';
        }
        decode() {
            if (this.disposed || this.busy || this.jsonInvalid) return;
            try {
                this.sampleHex = this.hexInput.value; this.sampleValues = this.valuesInput.value;
                this.previewBytes = Uint8Array.from(this._hex(this.sampleHex));
                this.previewRecord = protocol().decode(this.previewBytes, protocol().compile(this.draft));
                this.previewPage = this.bytePage = 0; this.selectedSpan = null;
                this._validate(); this._renderPreviewResults();
            } catch (error) { this.previewRecord = null; this.selectedSpan = null; this._renderPreviewResults(); this._error(error); }
        }
        encode() {
            if (this.disposed || this.busy || this.jsonInvalid) return;
            try {
                this.sampleValues = this.valuesInput.value;
                const values = JSON.parse(this.sampleValues);
                if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('样例字段值必须是 JSON 对象');
                const bytes = protocol().encode(protocol().compile(this.draft), this.previewMessageId, values, { layout: 'detail' });
                this.sampleHex = this._hexText(bytes); this.hexInput.value = this.sampleHex; this.decode();
            } catch (error) { this._error(error); }
        }
        _valueText(value, field) { return records().protocolValueText(value, field); }
        _renderPreviewResults() {
            this.byteHost.replaceChildren(); this.previewHost.replaceChildren();
            const fields = this.previewRecord?.flatFields ?? [];
            if (this.previewRecord) {
                this.previewHost.append(this._node('p', 'protocol-preview-summary', `${this.previewRecord.messageName ?? this.previewRecord.messageId} · ${this.previewBytes.length} 字节 · ${fields.length} 字段`));
                for (const warning of this.previewRecord.warnings ?? []) this.previewHost.append(this._node('p', 'protocol-preview-warning', messageZh(warning.message)));
                for (const result of this.previewRecord.ruleResults ?? []) {
                    const state = { passed: '通过', failed: '失败', 'not-run': '未执行' }[result.status];
                    const detail = result.actual !== undefined ? ` · 实际 ${String(result.actual)} / 预期 ${String(result.expected)}` : '';
                    const row = this._node('p', 'protocol-rule-result ' + result.status,
                        `${result.name} · ${result.stage === 'parsing' ? '解析阶段' : '完整帧验证'} · ${result.strength === 'strong' ? '强' : '弱'} · ${state}${detail} · ${messageZh(result.message)}`);
                    row.setAttribute('data-rule-result', result.ruleId); this.previewHost.append(row);
                }
                for (const field of fields.slice(this.previewPage * 80, (this.previewPage + 1) * 80)) {
                    const value = this._valueText(field.value, field);
                    const button = this._button(`${field.path} = ${value}${field.label ? ' (' + field.label + ')' : ''}`, null, () => {
                        this.selectedSpan = field; this.bytePage = Math.floor(field.byteOffset / 256); this._renderPreviewResults();
                    }, 'protocol-preview-field');
                    button.setAttribute('data-preview-path', field.path); button.setAttribute('aria-pressed', String(this.selectedSpan === field));
                    button.classList.toggle('is-selected', this.selectedSpan === field); this.previewHost.append(button);
                }
                this._pager(this.previewHost, this.previewPage, fields.length, 80, 'preview', page => { this.previewPage = page; this._renderPreviewResults(); });
            }
            if (this.previewBytes) {
                const byteEnd = Math.min(this.previewBytes.length, (this.bytePage + 1) * 256);
                for (let index = this.bytePage * 256; index < byteEnd; index++) {
                    const selected = this.selectedSpan && index >= this.selectedSpan.byteOffset && index < this.selectedSpan.endByte;
                    const byte = this._button(this._hexText([this.previewBytes[index]]), null, () => {
                        const span = fields.find(field => field.bitOffset === undefined && index >= field.byteOffset && index < field.endByte);
                        this.selectedSpan = span ?? null;
                        if (span) this.previewPage = Math.floor(fields.indexOf(span) / 80);
                        this._renderPreviewResults();
                    }, 'protocol-preview-byte');
                    byte.setAttribute('data-byte-index', index); byte.setAttribute('aria-label', `字节 ${index}: ${this._hexText([this.previewBytes[index]])}`);
                    byte.classList.toggle('is-selected', Boolean(selected));
                    if (selected && this.selectedSpan.bitOffset !== undefined) {
                        const bits = this._node('span', 'protocol-preview-bits');
                        for (let bit = 7; bit >= 0; bit--) {
                            const node = this._node('span', 'protocol-preview-bit', String(this.previewBytes[index] >> bit & 1));
                            node.setAttribute('data-bit-index', bit); node.classList.toggle('is-selected', this._bitSelected(index, bit)); bits.append(node);
                        }
                        byte.append(bits);
                    }
                    this.byteHost.append(byte);
                }
                this._pager(this.byteHost, this.bytePage, this.previewBytes.length, 256, 'bytes', page => { this.bytePage = page; this._renderPreviewResults(); });
            }
            if (this.selectedSpan) {
                const field = this.selectedSpan;
                this.location.textContent = `${field.path} · 字节 ${field.byteOffset}–${field.endByte - 1}` +
                    (field.bitOffset === undefined ? '' : ` · bit ${field.bitOffset}–${field.bitOffset + field.bitLength - 1}`);
            } else this.location.textContent = '选择解码字段，查看对应字节和位。';
        }
        _bitSelected(byteIndex, bitIndex) {
            const field = this.selectedSpan, fields = this.previewRecord?.flatFields ?? [];
            const parentPath = field.path.slice(0, field.path.lastIndexOf('.'));
            const container = fields.find(item => item.path === parentPath && item.bitOffset === undefined);
            let descriptor;
            const find = list => {
                for (const item of list ?? []) { if (item.id === container?.fieldId) descriptor = item; if (item.fields) find(item.fields); if (item.headerFields) find(item.headerFields); for (const branch of item.branches ?? []) find(branch.fields); }
            };
            for (const message of this.compiled?.messages ?? []) find(message.fields);
            find(this.compiled?.headerFields);
            const endian = descriptor?.endian ?? this.draft.endian ?? 'little';
            const logical = container ? (['big', 'be'].includes(endian) ? container.endByte - byteIndex - 1 : byteIndex - container.byteOffset) * 8 + bitIndex
                : Math.floor(field.bitOffset / 8) * 8 + (byteIndex - field.byteOffset) * 8 + bitIndex;
            return logical >= field.bitOffset && logical < field.bitOffset + field.bitLength;
        }
        async apply() {
            if (this.disposed || this.busy || !this.opened || this.jsonInvalid || !this._hasActiveProtocol()) return false;
            this._validate(); if (!this.compiled) return false;
            const generation = this.generation, config = clone(this.draft);
            this.busy = true; this.status.textContent = '正在应用协议…';
            const disabledStates = Array.from(this.dialog.querySelectorAll('input, select, textarea, button'), node => [node, node.disabled]);
            for (const [node] of disabledStates) node.disabled = true;
            try {
                await this.onApply?.(config);
                for(const [key,item] of this.pristine)if(item.protocolId===config.id)this.pristine.delete(key);
                if (!this.disposed && generation === this.generation) this.status.textContent = '协议已应用';
                return true;
            } catch (error) {
                if (!this.disposed && generation === this.generation) { this.status.textContent = '应用失败，草稿已保留'; this._error(error); }
                return false;
            } finally {
                this.busy = false;
                if (!this.disposed) {
                    for (const [node, disabled] of disabledStates) node.disabled = disabled;
                    this.applyButton.disabled = !this.compiled || this.jsonInvalid || !this._hasActiveProtocol();
                }
            }
        }
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = { ProtocolEditorView };
    root.SerialPlotter ??= {}; root.SerialPlotter.ProtocolEditorView = ProtocolEditorView;
})(globalThis);

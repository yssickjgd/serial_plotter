/** Structured send helpers and an embeddable editor.
 *
 * Persisted command binding: {protocolId,messageId,fields,fieldsText?,layout?,
 * sequence?}. Exact integers may be decimal strings. fieldsText retains an
 * unfinished JSON draft; it is parsed and validated before any task starts.
 * ProtocolSendSession({getProtocol,getProtocols}) owns the shared per-protocol
 * sequence and serialized writes. prepare(binding) fixes a schema/field snapshot;
 * preview() never consumes a sequence; send(prepared,sendBytes,isCurrent) commits
 * a sequence only after sendBytes resolves true. A cancelled submitted write
 * still advances if it physically succeeds. Share one session between regular
 * sending and CommandRunner to keep a single sequence history.
 *
 * ProtocolSendView({root,document?,session,getProtocols?,value?,onChange?,onSend?})
 * exposes getCommand(), getDraft(), setValue(), refresh(), preview(), setBusy(),
 * dispose(). All DOM is created inside root; no additional HTML controls needed.
 * getProtocols returns schemas (or compiled protocols). A failed preview sets
 * aria-invalid and blocks sending, while preserving the editable draft.
 */
(function (root) {
    'use strict';
    const Protocol = typeof module !== 'undefined' && module.exports
        ? require('./protocolEngine').Protocol : root.SerialPlotter.Protocol;
    const ByteUtils = typeof module !== 'undefined' && module.exports
        ? require('./byteUtils').ByteUtils : root.SerialPlotter.ByteUtils;
    const numberApi = () => typeof module !== 'undefined' && module.exports ? require('./protocolRecords') : root.SerialPlotter.ProtocolRecords;
    const valueText = (value, field) => numberApi().protocolValueText(value, field);
    const SEND_LIMITS = Object.freeze({ characters: 1048576, entries: 32768, depth: 32 });
    function normalizeProtocolCommand(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('协议指令无效');
        let entries = 0, characters = 0;
        const stack = new Set();
        function json(value, depth = 0) {
            if (++entries > SEND_LIMITS.entries || depth > SEND_LIMITS.depth) throw new Error('协议字段数量或嵌套层级超出限制');
            if (typeof value === 'bigint') value = value.toString();
            if (typeof value === 'string') {
                characters += value.length;
                if (characters > SEND_LIMITS.characters) throw new Error('协议字段内容超出限制');
                return value;
            }
            if (value === null || typeof value === 'boolean') return value;
            if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('协议字段数值无效'); return value; }
            if (value instanceof Uint8Array) {
                if ((entries += value.length) > SEND_LIMITS.entries) throw new Error('协议字段数量超出限制');
                return Array.from(value);
            }
            if (!value || typeof value !== 'object' || stack.has(value)) throw new Error('协议字段必须是无循环的JSON数据');
            stack.add(value);
            let result;
            if (Array.isArray(value)) result = value.map(item => json(item, depth + 1));
            else {
                result = {};
                for (const [key, item] of Object.entries(value)) {
                    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('协议字段包含不安全的key');
                    characters += key.length; result[key] = json(item, depth + 1);
                }
            }
            stack.delete(value); return result;
        }
        const output = { protocolId: input.protocolId ?? '', messageId: input.messageId ?? '', fields: json(input.fields ?? {}) };
        for (const key of ['protocolId', 'messageId']) if (typeof output[key] !== 'string' || output[key].length > 512)
            throw new Error('协议或消息编号无效');
        if (!output.fields || typeof output.fields !== 'object' || Array.isArray(output.fields)) throw new Error('协议字段必须是JSON对象');
        if (input.fieldsText !== undefined) {
            if (typeof input.fieldsText !== 'string' || input.fieldsText.length > SEND_LIMITS.characters) throw new Error('协议字段JSON草稿超出限制');
            output.fieldsText = input.fieldsText;
        }
        if (input.layout !== undefined && input.layout !== '') {
            if (typeof input.layout !== 'string' || input.layout.length > 120) throw new Error('协议布局选项无效');
            output.layout = input.layout;
        }
        if (input.sequence !== undefined) {
            if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.sequence > 0xffffffff) throw new Error('协议初始序号无效');
            output.sequence = input.sequence;
        }
        return output;
    }
    function bindingFields(binding) {
        if (binding.fieldsText === undefined) return binding.fields;
        let fields;
        try { fields = JSON.parse(binding.fieldsText || '{}'); } catch (error) { throw new Error(`字段JSON无效：${error.message}`); }
        return normalizeProtocolCommand({ ...binding, fields }).fields;
    }
    function sequenceModulus(compiled) {
        let modulus = Infinity;
        function visit(fields) {
            for (const field of fields || []) {
                if (field.valueSource === 'SEQ') {
                    const type = field.type === 'enum' ? field.baseType : field.type;
                    modulus = Math.min(modulus, type === 'uint16' ? 65536 : type === 'uint32' ? 4294967296 : 256);
                }
                visit(field.fields); visit(field.headerFields);
                for (const branch of field.branches || []) visit(branch.fields);
            }
        }
        visit(compiled.headerFields);
        for (const message of compiled.messages || []) visit(message.fields);
        return modulus === Infinity ? 256 : modulus;
    }
    function prepareProtocolCommand(input, { getProtocol = () => null, sequence = 0 } = {}) {
        const binding = normalizeProtocolCommand(input);
        if (!binding.protocolId || !binding.messageId) throw new Error('请选择协议和消息');
        const resolved = getProtocol(binding.protocolId);
        if (!resolved) throw new Error(`协议不存在：${binding.protocolId}`);
        const schema = JSON.parse(JSON.stringify(resolved.schema || resolved));
        const compiled = Protocol.compile(schema);
        if (compiled.id !== binding.protocolId) throw new Error('协议编号与绑定不一致');
        if (!compiled.messageById.has(binding.messageId)) throw new Error(`消息不存在：${binding.messageId}`);
        const prepared = { kind: 'protocol', protocolId: binding.protocolId, messageId: binding.messageId,
            fields: bindingFields(binding), layout: binding.layout, compiled, schema: compiled.schema,
            initialSequence: binding.sequence ?? 0, sequenceModulus: sequenceModulus(compiled) };
        prepared.bytes = Protocol.encode(compiled, prepared.messageId, prepared.fields,
            { sequence: sequence % prepared.sequenceModulus, layout: prepared.layout,
                onRuleResults: results => { prepared.ruleResults = results; } });
        return prepared;
    }
    class ProtocolSendSession {
        constructor({ getProtocol = () => null, getProtocols = () => [] } = {}) {
            this.getProtocol = getProtocol; this.getProtocols = getProtocols;
            this.sequences = new Map(); this.pending = null;
        }
        getSequence(protocolId, initial = 0) { return this.sequences.get(protocolId) ?? initial; }
        setSequence(protocolId, sequence) {
            if (typeof protocolId !== 'string' || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff)
                throw new Error('协议序号无效');
            this.sequences.set(protocolId, sequence);
        }
        prepare(binding, { getProtocol = this.getProtocol } = {}) {
            binding = normalizeProtocolCommand(binding);
            return prepareProtocolCommand(binding, { getProtocol,
                sequence: this.getSequence(binding.protocolId, binding.sequence ?? 0) });
        }
        preview(prepared) {
            if (!prepared?.compiled) prepared = this.prepare(prepared);
            return Protocol.encode(prepared.compiled, prepared.messageId, prepared.fields,
                { sequence: this.getSequence(prepared.protocolId, prepared.initialSequence) % prepared.sequenceModulus,
                    layout: prepared.layout, onRuleResults: results => { prepared.ruleResults = results; } });
        }
        send(prepared, sendBytes, isCurrent = () => true) {
            if (!prepared?.compiled) prepared = this.prepare(prepared);
            const write = async () => {
                if (!isCurrent()) return false;
                const sequence = this.getSequence(prepared.protocolId, prepared.initialSequence) % prepared.sequenceModulus;
                const bytes = Protocol.encode(prepared.compiled, prepared.messageId, prepared.fields,
                    { sequence, layout: prepared.layout, onRuleResults: results => { prepared.ruleResults = results; } });
                if (!await sendBytes(bytes, isCurrent)) return false;
                this.sequences.set(prepared.protocolId, (sequence + 1) % prepared.sequenceModulus);
                return true;
            };
            const result = this.pending ? this.pending.then(write) : Promise.resolve().then(write);
            const tail = result.catch(() => {}).then(() => { if (this.pending === tail) this.pending = null; });
            this.pending = tail; return result;
        }
    }
    let nextViewId = 0;
    class ProtocolSendView {
        constructor({ root: host, document = host.ownerDocument, session, getProtocols = null,
            value = {}, onChange = () => {}, onSend = null }) {
            Object.assign(this, { root: host, document, session, getProtocols, onChange, onSend });
            this.value = normalizeProtocolCommand(value); this.listeners = []; this.fieldErrors = new Map();
            this.id = `protocol-send-${++nextViewId}`; this.busy = false; this.disposed = false;
            this.render();
        }
        element(tag, className = '', text) {
            const node = this.document.createElement(tag); if (className) node.className = className;
            if (text !== undefined) node.textContent = text; return node;
        }
        listen(node, type, fn) {
            node.addEventListener(type, fn); this.listeners.push(() => node.removeEventListener(type, fn));
        }
        control(parent, labelText, name, tag = 'input') {
            const label = this.element('label', 'command-field'), title = this.element('span', 'command-field-title', labelText);
            const control = this.element(tag); control.id = `${this.id}-${name}`;
            control.setAttribute('data-control', name); control.setAttribute('aria-label', labelText);
            label.setAttribute('for', control.id); label.append(title, control); parent.appendChild(label);
            return control;
        }
        options(select, entries, value) {
            select.replaceChildren();
            for (const [key, text] of entries) { const option = this.element('option', '', text); option.value = key; select.appendChild(option); }
            select.value = value;
        }
        defaults(fields, input = {}, depth = 0) {
            const target = { ...input };
            if (depth > 16) return target;
            for (const field of fields) {
                let value = target[field.name];
                if (value !== undefined) continue;
                if (field.expectedBytes && field.count === undefined && field.until !== 'end' || field.type === 'checksum' || field.autoFrameLength || field.autoLengthTargets?.length) continue;
                const single = () => field.type === 'struct' ? this.defaults(field.fields, {}, depth + 1)
                    : field.type === 'choice' ? {} : ['repeat', 'tlv'].includes(field.type) ? []
                    : field.type === 'fixed' ? field.bytes ?? []
                    : ['bytes', 'reserved'].includes(field.type) ? [] : field.type === 'string' ? '' : field.type === 'bool' ? false
                        : /^(?:u?int64)$/.test(field.type) ? '0' : field.bits ? { _raw: 0 } : field.default ?? 0;
                if (field.count !== undefined && !['repeat', 'tlv'].includes(field.type)) {
                    let count = 0;
                    try { count = Number(Protocol.evaluateExpression(field.count, target)); } catch { /* Dynamic count awaits its prerequisite. */ }
                    value = Number.isSafeInteger(count) && count >= 0 && count <= 4096 ? Array.from({ length: count }, single) : [];
                } else value = field.until==='end'?[]:single();
                if (['repeat', 'tlv'].includes(field.type) && field.count !== undefined) {
                    let count = 0;
                    try { count = Number(Protocol.evaluateExpression(field.count, target)); } catch { /* The user can finish prerequisites before updating the form. */ }
                    if (Number.isSafeInteger(count) && count >= 0 && count <= 4096)
                        value = Array.from({ length: count }, () => this.defaults(field.type === 'tlv' ? field.headerFields : field.fields, {}, depth + 1));
                }
                target[field.name] = value;
            }
            return target;
        }
        hierarchy(message) { const chain = []; for (let current = message; current; current = current.parent) chain.unshift(current); return chain; }
        expressionContext(target, parentContext = {}) {
            const compiled = this.compiled, schema = compiled.schema;
            const frameLength = compiled.framing.fixedLength;
            const payloadEnd = schema.payloadEnd === undefined ? frameLength - (compiled.framing.footer?.length || 0)
                : schema.payloadEnd < 0 ? frameLength + schema.payloadEnd : schema.payloadEnd;
            const sequence = (this.session?.getSequence(this.value.protocolId, this.value.sequence ?? 0) ?? this.value.sequence ?? 0) % sequenceModulus(compiled);
            const headerNode = compiled.unified && compiled.rootMessages[0].fields.find(field => field.legacyHeader);
            const header = { ...(headerNode ? this.value.fields[headerNode.name] : {}) };
            for (const field of headerNode ? headerNode.fields : compiled.headerFields) if (field.valueSource === 'SEQ') header[field.name] = sequence;
            return { ...this.value.fields, ...parentContext, ...target, PARENT: parentContext, CURRENT: target,
                FRAME_LENGTH: frameLength, PAYLOAD_LENGTH: frameLength === undefined ? undefined : payloadEnd - (schema.payloadOffset || 0),
                HEADER: header, SEQ: sequence };
        }
        initializeFields(message) {
            if (this.compiled.unified) {
                for (const selector of message.selectors ?? []) if (selector.value !== undefined && selector.path !== '0') this.setField(selector.path, selector.value);
                Object.assign(this.value.fields, this.defaults(this.compiled.rootMessages[0].fields, this.value.fields));
                return;
            }
            let target = this.value.fields;
            const chain = this.hierarchy(message);
            for (const [index, part] of chain.entries()) {
                Object.assign(target, this.defaults(part.fields, target));
                const next = chain[index + 1];
                if (next && part.dispatch) {
                    if (next.command !== undefined) target[part.dispatch.field] = next.command;
                    const name = part.dispatch.name || 'content';
                    target[name] ||= {}; target = target[name];
                }
            }
        }
        setField(path, value) {
            const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = this.value.fields;
            for (const name of parts.slice(0, -1)) {
                if (!target[name] || typeof target[name] !== 'object') target[name] = { _raw: target[name] ?? 0 };
                target = target[name];
            }
            target[parts.at(-1)] = value;
        }
        changed() {
            if (this.disposed) return;
            this.onChange(this.getDraft()); this.preview();
        }
        inputField(parent, field, target, key, path, bit = false) {
            const label = field.description ? `${path} · ${field.description}` : path;
            const isArray = field.count !== undefined || field.until==='end', structured = isArray || field.type === 'struct';
            const isBool = !isArray && field.type === 'bool', enumeration = isArray ? null : field.enum;
            const control = this.control(parent, label, `field:${path}`, enumeration ? 'select' : structured ? 'textarea' : 'input');
            control.title = [field.type || (bit ? 'bits' : ''), field.unit, field.description].filter(Boolean).join(' · ');
            if (enumeration) this.options(control, Object.entries(enumeration).map(([value, title]) => [value, `${valueText(value, field)} · ${title}`]), String(target[key] ?? 0));
            else if (isBool) { control.type = 'checkbox'; control.checked = Boolean(target[key]); }
            else if (structured) { control.rows = 2; control.spellcheck = false; control.value = JSON.stringify(target[key] ?? []); }
            else if (['bytes', 'reserved'].includes(field.type)) { control.type = 'text'; control.value = numberApi().protocolBytesText(target[key] || [], numberApi().protocolNumberBase(field)); }
            else { control.type = 'text'; control.value = valueText(target[key] ?? 0, field); }
            if (!structured && !enumeration && !isBool && !['string', 'bytes', 'reserved'].includes(field.type)) control.inputMode = field.displayBase === 'hex' ? 'text' : 'decimal';
            const apply = () => {
                try {
                    let value;
                    if (enumeration) value = /64$/.test(field.baseType || field.type) || bit && field.length > 53 ? control.value : Number(control.value);
                    else if (isBool) value = control.checked;
                    else if (structured) value = JSON.parse(control.value);
                    else if (['bytes', 'reserved'].includes(field.type)) value = numberApi().parseProtocolBytes(control.value, numberApi().protocolNumberBase(field), path);
                    else if (field.type === 'string') value = control.value;
                    else if (/^(?:u?int(?:8|16|32|64)?|bitfield|enum)$/.test(field.type))
                        value = numberApi().parseProtocolInteger(control.value, numberApi().protocolNumberBase(field), path);
                    else {
                        const input = control.value.trim(), signedHex = /^([+-])0x([\da-f]+)$/i.exec(input);
                        value = signedHex ? Number((signedHex[1] === '-' ? -1n : 1n) * BigInt('0x' + signedHex[2])) : Number(input);
                        if (!input || !Number.isFinite(value)) throw new Error(`${path}需填写有效数值`);
                    }
                    this.setField(path, value); this.fieldErrors.delete(path); control.setAttribute('aria-invalid', 'false');
                    delete this.value.fieldsText;
                    this.jsonInput.value = JSON.stringify(this.value.fields, null, 2);
                } catch (error) { this.fieldErrors.set(path, error.message); control.setAttribute('aria-invalid', 'true'); }
                this.changed();
            };
            this.listen(control, enumeration ? 'change' : 'input', apply);
        }
        fields(parent, list, target, prefix = '', depth = 0, parentContext = {}) {
            if (depth > 16) return;
            for (const field of list) {
                const path = prefix ? `${prefix}.${field.name}` : field.name;
                const repeated=field.count !== undefined || field.until === 'end';
                if ((field.type === 'fixed' || field.expectedBytes) && !repeated || field.type === 'checksum' || field.valueSource === 'SEQ' || field.autoFrameLength || field.autoLengthTargets?.length) continue;
                if (field.condition !== undefined) {
                    try { if (!Protocol.evaluateExpression(field.condition, this.expressionContext(target, parentContext))) continue; }
                    catch { continue; }
                }
                if (field.type === 'choice' && !repeated) {
                    if (!field.inline) target[field.name] ||= {};
                    const group = this.element('fieldset', 'protocol-send-segment');
                    group.appendChild(this.element('legend', '', field.name));
                    this.branchFields(group, field, field.inline ? target : target[field.name], field.inline ? prefix : path, depth + 1, target, parentContext);
                    parent.appendChild(group); continue;
                }
                if (['repeat', 'tlv'].includes(field.type)) {
                    this.repeatFields(parent, field, target, path, depth + 1, parentContext); continue;
                }
                if (field.type === 'struct' && field.count === undefined && field.until!=='end') {
                    target[field.name] ||= {};
                    this.fields(parent, field.fields, target[field.name], path, depth + 1, target);
                } else if (field.bits && !repeated) {
                    if (typeof target[field.name] !== 'object') target[field.name] = { _raw: target[field.name] ?? 0 };
                    for (const bit of field.bits) if (bit.type !== 'reserved') this.inputField(parent, { ...bit, displayBase: field.displayBase ?? 'dec', type: bit.type || 'uint' },
                        target[field.name], bit.name, `${path}.${bit.name}`, true);
                } else this.inputField(parent, field, target, field.name, path);
            }
        }
        branchFields(parent, field, target, path, depth, context, parentContext = {}) {
            let selected;
            try {
                const bound = this.compiled?.messageById.get(this.value.messageId)?.selectors?.find(item => item.choiceId === field.id);
                selected = bound ? field.branches.find(item => item.id === bound.branchId) : Protocol.selectBranch(field, this.expressionContext(context, parentContext));
            }
            catch (error) { parent.appendChild(this.element('p', 'command-error', error.message)); return; }
            const info = this.element('div', 'hint-text', selected ? `当前分支：${selected.label || selected.id}` : '无匹配分支');
            parent.appendChild(info);
            if (!selected || selected.default && !selected.fields?.length) {
                target.rawPayload ??= [];
                this.inputField(parent, { name: 'rawPayload', type: 'bytes', description: '未知分支的原始内容' }, target, 'rawPayload', path ? `${path}.rawPayload` : 'rawPayload');
                return;
            }
            Object.assign(target, this.defaults(selected.fields, target, depth));
            this.fields(parent, selected.fields, target, path, depth, context);
        }
        repeatFields(parent, field, target, path, depth, parentContext = {}) {
            if (!Array.isArray(target[field.name])) target[field.name] = [];
            const items = target[field.name], group = this.element('fieldset', 'protocol-send-segment');
            const heading = this.element('legend', '', `${field.name} · ${items.length} 项`);
            group.appendChild(heading);
            const add = this.element('button', 'command-button', '新增项'); add.type = 'button';
            add.setAttribute('data-action', `add-item:${path}`); add.disabled = items.length >= 4096;
            this.listen(add, 'click', () => {
                if (this.busy || items.length >= 4096) return;
                items.push(this.defaults(field.type === 'tlv' ? field.headerFields : field.fields, {}, depth));
                delete this.value.fieldsText; this.render(); this.changed();
            });
            group.appendChild(add);
            for (const [index, value] of items.slice(0, 24).entries()) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
                const row = this.element('fieldset', 'protocol-send-item'), itemPath = `${path}[${index}]`;
                row.appendChild(this.element('legend', '', `[${index}]`));
                const remove = this.element('button', 'command-button', '移除'); remove.type = 'button';
                remove.setAttribute('data-action', `remove-item:${itemPath}`);
                this.listen(remove, 'click', () => {
                    if (this.busy) return;
                    items.splice(index, 1); delete this.value.fieldsText; this.render(); this.changed();
                });
                row.appendChild(remove);
                const itemContext = { ...target, INDEX: index };
                if (field.type === 'tlv') {
                    Object.assign(value, this.defaults(field.headerFields, value, depth));
                    this.fields(row, field.headerFields.filter(header => header.name !== field.lengthField), value, itemPath, depth, itemContext);
                    row.appendChild(this.element('p', 'hint-text', `${field.lengthField}：按最终内容自动计算`));
                    this.branchFields(row, field, value, itemPath, depth, { ...itemContext, ...value }, itemContext);
                } else {
                    Object.assign(value, this.defaults(field.fields, value, depth));
                    this.fields(row, field.fields, value, itemPath, depth, itemContext);
                }
                group.appendChild(row);
            }
            if (items.length > 24) group.appendChild(this.element('p', 'hint-text', '表单显示前 24 项；其余项目可在字段 JSON 中编辑。'));
            parent.appendChild(group);
        }
        render() {
            for (const remove of this.listeners.splice(0)) remove();
            this.root.replaceChildren(); this.fieldErrors.clear(); this.compiled = null;
            const toolbar = this.element('div', 'command-content-heading');
            this.protocolSelect = this.control(toolbar, '协议', 'protocol', 'select');
            this.messageSelect = this.control(toolbar, '消息', 'message', 'select'); this.root.appendChild(toolbar);
            const protocols = (this.getProtocols || this.session?.getProtocols || (() => []))().map(item => item.schema || item);
            if (!this.value.protocolId && protocols.length) this.value.protocolId = protocols[0].id;
            const protocolEntries = protocols.map(item => [item.id, item.name || item.id]);
            if (this.value.protocolId && !protocols.some(item => item.id === this.value.protocolId)) protocolEntries.push([this.value.protocolId, `${this.value.protocolId}（协议不可用）`]);
            this.options(this.protocolSelect, protocolEntries.length ? protocolEntries : [['', '请先在数据引擎添加协议']], this.value.protocolId);
            try {
                const source = this.session?.getProtocol(this.value.protocolId);
                if (source) this.compiled = Protocol.compile(source);
            } catch { /* Preview below displays validation errors in context. */ }
            const messages = this.compiled?.messages || [];
            if (!this.value.messageId && messages.length) this.value.messageId = messages[0].id;
            const messageEntries = messages.map(item => [item.id, `${item.name} · ${item.id}`]);
            if (this.value.messageId && !messages.some(item => item.id === this.value.messageId)) messageEntries.push([this.value.messageId, `${this.value.messageId}（消息不可用）`]);
            this.options(this.messageSelect, messageEntries.length ? messageEntries : [['', '请选择消息']], this.value.messageId);
            this.listen(this.protocolSelect, 'change', () => {
                this.value = { protocolId: this.protocolSelect.value, messageId: '', fields: {} }; this.render(); this.changed();
            });
            this.listen(this.messageSelect, 'change', () => {
                this.value = { ...this.value, messageId: this.messageSelect.value, fields: {} }; delete this.value.fieldsText;
                delete this.value.layout; this.render(); this.changed();
            });
            const message = this.compiled?.messageById.get(this.value.messageId), fields = this.element('div', 'command-content');
            if (message) {
                if (this.value.fieldsText !== undefined) {
                    try { this.value.fields = bindingFields(this.value); } catch { /* Preserve the JSON draft. */ }
                }
                this.initializeFields(message);
                let target = this.value.fields, prefix = '';
                const chain = this.compiled.unified ? [this.compiled.rootMessages[0]] : this.hierarchy(message);
                for (let index = 0; index < chain.length; index++) {
                    const shown = index + 1 < chain.length ? chain[index].fields.filter(field => field.name !== chain[index].dispatch.field)
                        : chain[index].fields;
                    this.fields(fields, shown, target, prefix);
                    if (index + 1 < chain.length) {
                        const name = chain[index].dispatch.name || 'content'; target = target[name]; prefix = prefix ? `${prefix}.${name}` : name;
                    }
                }
                const layoutChain = this.compiled.unified ? [this.compiled.rootMessages[0], ...this.hierarchy(message)] : chain;
                const requiresLayout = layoutChain.some(item => item.requireLayout);
                this.layoutSelect = this.control(toolbar, requiresLayout ? '文档冲突布局' : '布局', 'layout', 'select');
                const layoutEntries = new Map();
                for (const part of layoutChain) for (const [key, value] of Object.entries(part.layouts || {})) layoutEntries.set(key, value.name || key);
                if (!layoutEntries.size) layoutEntries.set('detail', '详细字段定义');
                this.options(this.layoutSelect, [['', requiresLayout ? '请选择详细字段布局' : '默认布局'], ...layoutEntries], this.value.layout || '');
                this.listen(this.layoutSelect, 'change', () => { this.value.layout = this.layoutSelect.value; this.changed(); });
                if (!requiresLayout) this.layoutSelect.parentNode.hidden = true;
            }
            this.root.appendChild(fields);
            if (message && this.hasDynamicFields(message.fields)) {
                const update = this.element('button', 'command-button', '更新条件分支与可选字段'); update.type = 'button';
                update.setAttribute('data-action', 'refresh-branches');
                this.listen(update, 'click', () => { if (!this.busy) { delete this.value.fieldsText; this.render(); this.changed(); } });
                fields.appendChild(update);
            }
            const details = this.element('details', 'command-content'); details.appendChild(this.element('summary', '', '字段 JSON · 复杂结构与数组'));
            this.jsonInput = this.control(details, '字段 JSON（64位整数使用十进制字符串）', 'fields-json', 'textarea');
            this.jsonInput.rows = 4; this.jsonInput.spellcheck = false;
            this.jsonInput.value = this.value.fieldsText ?? JSON.stringify(this.value.fields, null, 2);
            this.listen(this.jsonInput, 'input', () => {
                this.value.fieldsText = this.jsonInput.value; this.fieldErrors.clear();
                try { this.value.fields = bindingFields(this.value); this.jsonInput.setAttribute('aria-invalid', 'false'); }
                catch { this.jsonInput.setAttribute('aria-invalid', 'true'); }
                this.changed();
            });
            this.root.appendChild(details);
            this.previewInput = this.control(this.root, '编码 Hex 预览', 'preview', 'textarea');
            this.previewInput.rows = 2; this.previewInput.readOnly = true; this.previewInput.spellcheck = false;
            this.error = this.element('p', 'command-error'); this.error.setAttribute('data-control', 'error');
            this.error.setAttribute('role', 'alert'); this.error.hidden = true; this.root.appendChild(this.error);
            if (this.onSend) {
                this.sendButton = this.element('button', 'command-button', '发送协议消息'); this.sendButton.type = 'button';
                this.sendButton.setAttribute('data-action', 'send-protocol'); this.root.appendChild(this.sendButton);
                this.listen(this.sendButton, 'click', () => {
                    if (this.busy || !this.preview()) return;
                    Promise.resolve().then(() => this.onSend(this.getCommand())).catch(error => this.showError(error));
                });
            }
            this.preview(); this.setBusy(this.busy);
        }
        getDraft() { return normalizeProtocolCommand(this.value); }
        hasDynamicFields(fields) {
            return fields.some(field => field.condition !== undefined || ['choice', 'repeat', 'tlv'].includes(field.type) ||
                field.fields && this.hasDynamicFields(field.fields));
        }
        getCommand() {
            if (this.fieldErrors.size) throw new Error(this.fieldErrors.values().next().value);
            const value = this.getDraft(); value.fields = bindingFields(value); delete value.fieldsText; return value;
        }
        showError(error) {
            this.error.textContent = error.message || String(error); this.error.hidden = false;
            this.previewInput.value = ''; this.jsonInput.setAttribute('aria-invalid', /JSON/i.test(this.error.textContent) ? 'true' : 'false');
            this.root.setAttribute('aria-invalid', 'true');
            if (this.sendButton) { this.sendButton.disabled = true; this.sendButton.dataset.unavailable = 'true'; }
        }
        preview() {
            if (this.disposed) return null;
            try {
                if (!this.session) throw new Error('请先配置协议发送');
                const prepared = this.session.prepare(this.getCommand()), bytes = this.session.preview(prepared);
                this.previewInput.value = ByteUtils.bytesToHex(bytes); this.error.hidden = true;
                const warnings = prepared.ruleResults?.filter(result => result.status === 'failed' || result.unavailable) ?? [];
                if (warnings.length) { this.error.textContent = '弱规则警告：' + warnings.map(result => result.message).join('；'); this.error.hidden = false; }
                this.root.setAttribute('aria-invalid', 'false');
                this.jsonInput.setAttribute('aria-invalid', 'false');
                if (this.sendButton) { this.sendButton.disabled = this.busy; this.sendButton.dataset.unavailable = 'false'; }
                return bytes;
            } catch (error) { this.showError(error); return null; }
        }
        setValue(value) { this.value = normalizeProtocolCommand(value); this.render(); }
        refresh() { if (!this.disposed) this.render(); }
        setBusy(busy) {
            this.busy = Boolean(busy);
            for (const control of this.root.querySelectorAll('input, select, textarea, button'))
                control.disabled = this.busy || control.dataset.unavailable === 'true';
        }
        dispose() { this.disposed = true; for (const remove of this.listeners.splice(0)) remove(); }
    }
    const exports = { ProtocolSendSession, ProtocolSendView, normalizeProtocolCommand, prepareProtocolCommand };
    root.SerialPlotter ??= {}; Object.assign(root.SerialPlotter, exports);
    if (typeof module !== 'undefined' && module.exports) module.exports = exports;
})(globalThis);

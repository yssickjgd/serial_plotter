/** Protocol expression completion, sharing the channel editor's keyboard and IME behavior. */
(function(root) {
    'use strict';
    const dependencies = () => typeof module !== 'undefined' && module.exports
        ? { ...require('./channelAutocomplete'), ...require('./reservedNames') } : root.SerialPlotter;
    function protocolCompletionRange(input) {
        const value = String(input.value ?? ''), caret = input.selectionStart ?? value.length;
        const text = value.slice(0, caret).match(/[A-Za-z0-9_.]+$/)?.[0] ?? '';
        const selectedEnd = input.selectionEnd ?? caret, suffix = value.slice(selectedEnd).match(/^[A-Za-z0-9_.]*/)?.[0] ?? '';
        const start = caret - text.length, end = selectedEnd + suffix.length;
        return { start, end, query: text, lengthArgument: /\bLEN\s*\(\s*$/.test(value.slice(0, start)),
            hasParenthesis: /^\s*\(/.test(value.slice(end)) };
    }
    function protocolCompletionCatalog(schema, { fieldId, frame, property, constraint = false } = {}) {
        const rootFields = schema.messages?.[0]?.fields ?? [], structures = schema.structures ?? {};
        const children = field => field.ref ? structures[field.ref] ?? [] : field.fields ?? [];
        let visited = 0;
        function locate(fields, parents = [], refs = []) {
            if (parents.length > 16 || visited > 8192) return null;
            for (let index = 0; index < fields.length; index++) {
                const field = fields[index]; visited++;
                const scopes = [...parents, { fields, index }];
                if (field.id === fieldId) return { field, scopes };
                if (field.ref && refs.includes(field.ref)) continue;
                const nextRefs = field.ref ? [...refs, field.ref] : refs;
                const nested = locate(children(field), scopes, nextRefs);
                if (nested) return nested;
                for (const branch of field.branches ?? []) {
                    const branchScopes = field.type === 'tlv' ? [...scopes, { fields: field.headerFields ?? [], index: field.headerFields?.length ?? 0 }] : scopes;
                    const found = locate(branch.fields ?? [], branchScopes, nextRefs);
                    if (found) return found;
                }
            }
            return null;
        }
        const target = frame ? null : locate(rootFields);
        function collect(fields, prefix = '', result = new Map(), refs = [], depth = 0) {
            if (depth > 16 || result.size >= 8192) return result;
            for (const field of fields) {
                if (!field.name || result.size >= 8192) continue;
                const repeated=field.count !== undefined || field.until === 'end' || ['repeat','tlv'].includes(field.type);
                const path = prefix + field.name + (constraint && repeated ? '[0]' : ''), type = field.type === 'enum' ? field.baseType ?? 'uint8' : field.type;
                result.set(path, { label: path, name: type ?? '字段', description: `${path} · ${type ?? '字段'}（区分大小写）`,
                    numeric: /^(?:u?int\d+|float\d+|bool)$/.test(type), value: path });
                for (const bit of field.bits ?? []) if (bit.type !== 'reserved') {
                    const name = path + '.' + bit.name;
                    result.set(name, { label: name, name: '位段', numeric: true, value: name });
                }
                // Repeated values require an index, and mutually exclusive children are not always present.
                if (field.type === 'struct' && !repeated && (!field.ref || !refs.includes(field.ref))) {
                    collect(children(field), field.inline ? prefix : path + '.', result, field.ref ? [...refs, field.ref] : refs, depth + 1);
                }
                if (constraint && (field.type !== 'struct' || repeated)) {
                    if (!field.ref || !refs.includes(field.ref)) collect(children(field), field.inline ? prefix : path + '.', result, field.ref ? [...refs, field.ref] : refs, depth + 1);
                    collect(field.headerFields ?? [], path + '.', result, refs, depth + 1);
                }
                if (constraint) for (const branch of field.branches ?? []) collect(branch.fields ?? [], field.inline ? prefix : path + '.', result, refs, depth + 1);
            }
            return result;
        }
        const values = new Map();
        if (frame) collect(rootFields, '', values);
        else if (target) {
            const scopes = target.scopes, inherited = new Map();
            for (let level = 0; level < scopes.length; level++) {
                const scope = scopes[level], local = collect(scope.fields.slice(0, scope.index));
                for (const [name, item] of local) inherited.set(name, item);
                if (level === scopes.length - 1) {
                    for (const [name, item] of inherited) values.set(name, item);
                    for (const [name, item] of local) values.set('CURRENT.' + name, { ...item, label: 'CURRENT.' + name, value: 'CURRENT.' + name });
                } else {
                    const prefix = 'PARENT.'.repeat(scopes.length - level - 1);
                    for (const [name, item] of inherited) values.set(prefix + name, { ...item, label: prefix + name, value: prefix + name });
                }
            }
            if (target.field.type === 'tlv' && (property === 'field.selector' || /^branch\./.test(property ?? '')))
                collect(target.field.headerFields ?? [], '', values);
        }
        const reserved = dependencies().ReservedNames;
        const functions = reserved.protocolFunctions.map(name => ({ label: name, name: name === 'LEN' ? '编码字节数' : '函数',
            value: name + '()', caretOffset: name.length + 1,
            description: reserved.definitions.find(item => item.names.includes(name))?.description }));
        const variables = reserved.protocolVariables.filter(name => !['PARENT','CURRENT','HEADER'].includes(name) &&
            (!frame || (constraint ? ['TRUE','FALSE','FRAME_LENGTH','PAYLOAD_LENGTH','SEQ','REMAINING'] : ['TRUE','FALSE']).includes(name))).map(name => ({ label: name, name: '内置变量', value: name,
            description: reserved.definitions.find(item => item.names.includes(name))?.description }));
        return { values: [...values.values()], functions, variables };
    }
    function attachProtocolAutocomplete(input, options) {
        const { ChannelAutocomplete } = dependencies(), catalog = protocolCompletionCatalog(options.schema, options);
        let completion;
        const registry = { query(query, { offset, limit }) {
            const range = completion.range;
            const items = range.lengthArgument ? catalog.values : [
                ...catalog.values.filter(item => item.numeric), ...catalog.functions.map(item => range.hasParenthesis
                    ? { ...item, value: item.label, caretOffset: item.label.length } : item), ...catalog.variables
            ];
            const matches = items.filter(item => item.label.startsWith(query));
            return { items: matches.slice(offset, offset + limit), total: matches.length };
        } };
        completion = new ChannelAutocomplete(input, { registry, container: options.container, getRange: protocolCompletionRange,
            explicitShortcut: true, stopPropagation: true, rowHeight: 26, positionPopup(popup, bounds) {
                if (!bounds) return;
                const view = input.ownerDocument.defaultView, width = Math.min(420, Math.max(220, bounds.width)),
                    viewportWidth = view?.innerWidth ?? 1280, viewportHeight = view?.innerHeight ?? 800,
                    actualWidth = Math.min(width, viewportWidth - 16), height = Math.min(completion.total, 8) * 26 + 2;
                const top = bounds.bottom + height <= viewportHeight - 8 ? bounds.bottom : Math.max(8, bounds.top - height);
                Object.assign(popup.style, { position: 'fixed', left: Math.max(8, Math.min(bounds.left, viewportWidth - actualWidth - 8)) + 'px',
                    top: top + 'px', width: actualWidth + 'px', minWidth: '0', maxHeight: Math.max(26, Math.min(height, viewportHeight - top - 8)) + 'px' });
            } });
        completion.popup.classList.add('protocol-autocomplete');
        input.spellcheck = false;
        input.title = [input.title, '表达式区分大小写；↑ / ↓ 选择，Enter / Tab 插入，Esc 关闭，Ctrl + 空格显示提示。'].filter(Boolean).join('\n');
        return completion;
    }
    const api = { protocolCompletionRange, protocolCompletionCatalog, attachProtocolAutocomplete };
    root.SerialPlotter ??= {}; Object.assign(root.SerialPlotter, api);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);

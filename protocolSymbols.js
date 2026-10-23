/** Versioned, lexical migration of protocol expression symbols. */
(function(root) {
    'use strict';
    function createProtocolSymbols(reserved) {
        const aliases = { frameLength: 'FRAME_LENGTH', payloadLength: 'PAYLOAD_LENGTH', remaining: 'REMAINING',
            parentRemaining: 'PARENT_REMAINING', parent: 'PARENT', current: 'CURRENT', header: 'HEADER',
            index: 'INDEX', seq: 'SEQ', sequence: 'SEQUENCE', true: 'TRUE', false: 'FALSE' };
        const functions = { min: 'MIN', max: 'MAX', abs: 'ABS' };
        const expressionKeys = ['offset','count','length','condition','selector','lengthFrom'];
        const pathToken = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*/g;
        function migrate(schema) {
            if (schema.symbolVersion === 2) return { schema, renames: [] };
            if (schema.symbolVersion !== undefined) throw new Error('Unsupported protocol symbolVersion');
            const renames = [], original = new WeakMap(), children = new WeakMap(), dispatchNames = new WeakMap(), visited = new WeakSet(), rewrites = new WeakMap();
            const allScopes = [], definitions = schema.structures || {};
            function register(fields, identityScope, path = '', metadata = false, depth = 0) {
                if (!Array.isArray(fields) || depth > 16) return new Map();
                const map = new Map(), names = new Set(fields.map(field => field?.name)); allScopes.push(map);
                for (const field of fields) {
                    if (!field || typeof field !== 'object') continue;
                    const before = field.name; field.id ||= `${identityScope}.${before}`;
                    let after = before;
                    if (before === 'seq' || before === 'sequence') after = 'rm_' + before;
                    else if (!metadata && reserved.error(before, 'field')) after = 'field_' + before;
                    if (after !== before) {
                        const stem = after; let suffix = 2;
                        while (names.has(after)) after = stem + '_' + suffix++;
                        names.add(after); field.name = after;
                    }
                    const descriptor = { field, before, after, pathBefore: path ? path + '.' + before : before,
                        pathAfter: path ? path + '.' + after : after, children: new Map() };
                    original.set(field, descriptor); map.set(before, descriptor);
                    if (field.bits) descriptor.children = register(field.bits, field.id, descriptor.pathBefore, false, depth + 1);
                    if (field.fields) descriptor.children = register(field.fields, field.id, field.inline ? path : descriptor.pathBefore, metadata, depth + 1);
                    if (field.headerFields) children.set(field, register(field.headerFields, field.id + '.header', descriptor.pathBefore, metadata, depth + 1));
                    for (const [index, branch] of (field.branches || []).entries()) {
                        branch.id ||= `${field.id}.branch${index}`;
                        children.set(branch, register(branch.fields || [], branch.id, field.inline ? path : descriptor.pathBefore, !!branch.legacyUnknown, depth + 1));
                    }
                }
                return map;
            }
            const header = register(schema.headerFields || [], `${schema.id}.header`, 'header');
            const structures = new Map(Object.entries(definitions).map(([name, fields]) => [name, register(fields, `${schema.id}.structures.${name}`)]));
            function registerMessages(messages, scope, path = '') {
                for (const message of messages || []) {
                    message.id ||= `${scope}.${message.command}`;
                    children.set(message, register(message.fields || [], message.id, path));
                    if (message.dispatch) {
                        const dispatch = message.dispatch, before = dispatch.name || 'content';
                        let after = ['seq','sequence'].includes(before) ? 'rm_' + before : reserved.error(before, 'field') ? 'field_' + before : before;
                        if (after !== before) {
                            const occupied = new Set((message.fields || []).map(field => field.name)), stem = after; let suffix = 2;
                            while (occupied.has(after)) after = stem + '_' + suffix++;
                            dispatch.name = after;
                        }
                        dispatchNames.set(dispatch, { before, after });
                        registerMessages(dispatch.messages, message.id, path ? path + '.' + before : before);
                    }
                }
            }
            registerMessages(schema.messages, schema.id);
            for (const map of allScopes) for (const descriptor of map.values()) {
                if (descriptor.field.ref && structures.has(descriptor.field.ref)) descriptor.children = structures.get(descriptor.field.ref);
            }
            function mergeMaps(maps) {
                const merged = new Map();
                for (const map of maps) for (const [name, descriptor] of map || []) {
                    if (!merged.has(name)) { merged.set(name, descriptor); continue; }
                    const previous = merged.get(name), variants = [...(previous.variants || [previous]), descriptor];
                    const entry = { field: previous.field, before: previous.before, after: previous.after,
                        variants, ambiguous: new Set(variants.map(item => item.after)).size > 1 };
                    Object.defineProperty(entry, 'children', { enumerable: true, get: () => mergeMaps(variants.map(item => item.children)) });
                    merged.set(name, entry);
                }
                return merged;
            }
            for (const map of allScopes) for (const descriptor of map.values()) {
                const field = descriptor.field;
                if (field.branches) descriptor.children = mergeMaps([
                    descriptor.children, children.get(field), ...field.branches.map(branch => children.get(branch))
                ]);
            }
            const empty = () => ({ own: new Map(), parent: null, header });
            function find(scope, name, own = false) {
                for (let current = scope; current; current = own ? null : current.parent) {
                    if (current.own.has(name)) return current.own.get(name);
                }
                return null;
            }
            function rewritePath(token, scope) {
                const parts = token.match(/[A-Za-z_$][\w$]*|\[\d+\]/g), out = [];
                let context = scope, descriptor = null, map = null;
                for (let index = 0; index < parts.length; index++) {
                    const part = parts[index];
                    if (part[0] === '[') { out.push(part); continue; }
                    const prefix = out.length && out.at(-1)?.[0] !== '[' ? '.' : out.length ? '.' : '';
                    if (map) descriptor = map.get(part) || null;
                    else descriptor = find(context, part);
                    if (descriptor) {
                        if (descriptor.ambiguous) throw new Error(`Legacy branch field path has ambiguous renames: ${token}`);
                        out.push(prefix + descriptor.after); map = descriptor.children; context = empty();
                    } else if (!map && ['parent','current','header'].includes(part)) {
                        out.push(prefix + aliases[part]);
                        if (part === 'parent') context = context?.parent || empty();
                        else if (part === 'current') context = { ...context, parent: null };
                        else { context = { own: header, parent: null, header }; }
                    } else { out.push(prefix + (!map && aliases[part] || part)); map ||= new Map(); }
                }
                return out.join('');
            }
            function rewrite(source, scope) {
                if (typeof source !== 'string') return source;
                return source.replace(pathToken, (token, offset) => {
                    if (offset > 0 && /[\w.]/.test(source[offset - 1])) return token;
                    if (functions[token] && /^\s*\(/.test(source.slice(offset + token.length))) return functions[token];
                    return rewritePath(token, scope);
                });
            }
            function update(object, key, scope) {
                if (typeof object[key] !== 'string' || key === 'lengthFrom' && object[key] === 'contents') return;
                let cache = rewrites.get(object); if (!cache) { cache = new Map(); rewrites.set(object, cache); }
                const prior = cache.get(key), before = prior?.before ?? object[key], after = rewrite(before, scope);
                if (prior && prior.after !== after) throw new Error(`Legacy shared structure expression has ambiguous scopes: ${before}`);
                cache.set(key, { before, after }); object[key] = after;
            }
            function record(descriptor, beforePrefix, afterPrefix, instancePrefix = '') {
                if (descriptor.before === descriptor.after && beforePrefix === afterPrefix) return;
                const pathBefore = beforePrefix ? `${beforePrefix}.${descriptor.before}` : descriptor.before;
                const pathAfter = afterPrefix ? `${afterPrefix}.${descriptor.after}` : descriptor.after;
                const fieldId = instancePrefix + descriptor.field.id;
                if (!renames.some(item => item.fieldId === fieldId && item.pathBefore === pathBefore && item.pathAfter === pathAfter))
                    renames.push({ fieldId, before: descriptor.before, after: descriptor.after, pathBefore, pathAfter });
            }
            function walk(fields, inherited, beforePrefix = '', afterPrefix = beforePrefix, instancePrefix = '', stack = []) {
                const scope = { own: new Map(), parent: inherited, header };
                for (const field of fields || []) {
                    const descriptor = original.get(field); if (!descriptor) continue;
                    visited.add(field); record(descriptor, beforePrefix, afterPrefix, instancePrefix);
                    for (const key of expressionKeys) if (key !== 'selector' || field.type !== 'tlv') update(field, key, scope);
                    if (field.checksum) for (const key of ['start','end','offset']) update(field.checksum, key, scope);
                    const nextBefore = field.inline ? beforePrefix : beforePrefix ? beforePrefix + '.' + descriptor.before : descriptor.before;
                    const nextAfter = field.inline ? afterPrefix : afterPrefix ? afterPrefix + '.' + descriptor.after : descriptor.after;
                    for (const bit of field.bits || []) record(original.get(bit), nextBefore, nextAfter, instancePrefix);
                    if (field.fields) walk(field.fields, scope, nextBefore, nextAfter, instancePrefix, stack);
                    if (field.ref && structures.has(field.ref) && !stack.includes(field.ref))
                        walk(definitions[field.ref], scope, nextBefore, nextAfter, instancePrefix + field.id + '/', [...stack, field.ref]);
                    if (field.headerFields) walk(field.headerFields, scope, nextBefore, nextAfter, instancePrefix, stack);
                    const branchScope = field.headerFields ? { own: children.get(field), parent: scope, header } : scope;
                    if (field.type === 'tlv') update(field, 'selector', branchScope);
                    if (field.lengthField) field.lengthField = children.get(field)?.get(field.lengthField)?.after ?? field.lengthField;
                    for (const branch of field.branches || []) {
                        update(branch, 'expression', branchScope); update(branch, 'selectorPath', branchScope); update(branch, 'valuePath', scope);
                        walk(branch.fields, branchScope, nextBefore, nextAfter, instancePrefix, stack);
                    }
                    scope.own.set(descriptor.before, descriptor);
                    if (field.legacyHeader) for (const [key, value] of descriptor.children) scope.own.set(key, value);
                }
                return scope;
            }
            const headerScope = walk(schema.headerFields, empty(), 'header');
            // Historical common header seq/sequence fields were auto-filled by name.
            for (const field of schema.headerFields || []) if (['seq','sequence'].includes(original.get(field)?.before)) field.valueSource ||= 'SEQ';
            function legacyHeaderSources(fields) {
                for (const field of fields || []) {
                    if (field.legacyHeader) for (const item of field.fields || []) if (['seq','sequence'].includes(original.get(item)?.before)) item.valueSource ||= 'SEQ';
                    legacyHeaderSources(field.fields);
                    for (const branch of field.branches || []) legacyHeaderSources(branch.fields);
                }
            }
            function walkMessages(messages, inherited, beforePrefix = '', afterPrefix = beforePrefix) {
                for (const message of messages || []) {
                    legacyHeaderSources(message.fields);
                    const scope = walk(message.fields, inherited, beforePrefix, afterPrefix);
                    if (message.dispatch) {
                        update(message.dispatch, 'field', scope); update(message.dispatch, 'offset', scope);
                        const { before, after } = dispatchNames.get(message.dispatch);
                        const pathBefore = beforePrefix ? beforePrefix + '.' + before : before, pathAfter = afterPrefix ? afterPrefix + '.' + after : after;
                        if (pathBefore !== pathAfter) renames.push({ fieldId: message.id + '.dispatch', before, after, pathBefore, pathAfter });
                        walkMessages(message.dispatch.messages, scope, pathBefore, pathAfter);
                    }
                }
            }
            walkMessages(schema.messages, headerScope);
            for (const fields of Object.values(definitions)) if (fields.some(field => !visited.has(field))) walk(fields, empty());
            for (const checksum of schema.checksums || []) for (const key of ['start','end','offset']) update(checksum, key, headerScope);
            schema.symbolVersion = 2; return { schema, renames };
        }
        return { migrate, createFactorySource: () => createProtocolSymbols.toString() };
    }
    const reserved = typeof module !== 'undefined' && module.exports ? require('./reservedNames').ReservedNames : root.SerialPlotter.ReservedNames;
    const ProtocolSymbols = createProtocolSymbols(reserved);
    root.SerialPlotter ??= {}; root.SerialPlotter.ProtocolSymbols = ProtocolSymbols;
    if (typeof module !== 'undefined' && module.exports) module.exports = { ProtocolSymbols };
})(globalThis);

/** Pure editing operations for protocol schemas. IDs identify nodes; names identify wire expressions. */
(function (root) {
    'use strict';
    const clone = value => JSON.parse(JSON.stringify(value));
    const identifier = /^[A-Za-z_$][\w$]*$/;
    const reservedNames = typeof module !== 'undefined' && module.exports ? require('./reservedNames').ReservedNames : root.SerialPlotter.ReservedNames;
    const expressionKeys = new Set(['condition', 'count', 'length', 'lengthFrom', 'offset', 'selector', 'lengthField', 'until', 'expression', 'value', 'checksum.start', 'checksum.end']);
    const wireWidths = { uint8: 1, int8: 1, bool: 1, uint16: 2, int16: 2, uint32: 4,
        int32: 4, float32: 4, uint64: 8, int64: 8, float64: 8 };

    function safeName(value) { return typeof value === 'string' && identifier.test(value) && !reservedNames.error(value, 'field'); }
    function assertName(value) { const conflict = reservedNames.error(value, 'field'); if (conflict) throw new Error(conflict); if (!safeName(value)) throw new Error(`Invalid machine name: ${value}`); }
    function usedIds(protocol) {
        const ids = new Set([protocol.id]);
        visit(protocol, entry => { if (entry.node.id) ids.add(entry.node.id); });
        return ids;
    }
    function freshId(ids, base = 'node') {
        const stem = String(base || 'node').replace(/[^A-Za-z0-9_-]/g, '-') || 'node';
        let number = 1, id = stem;
        while (ids.has(id)) id = `${stem}-${number++}`;
        ids.add(id); return id;
    }
    // The visitor exposes every editable array, including definitions and nested dispatch messages.
    function visit(protocol, callback) {
        function list(array, parentId, depth, kind, path) {
            if (!Array.isArray(array)) return;
            array.forEach((node, index) => {
                if (!node || typeof node !== 'object') return;
                const entry = { node, array, index, parentId, depth, kind, path: [...path, index] };
                callback(entry);
                if (kind === 'message') {
                    list(node.fields, node.id, depth + 1, 'field', [...entry.path, 'fields']);
                    list(node.dispatch?.messages, node.id, depth + 1, 'message', [...entry.path, 'dispatch', 'messages']);
                } else if (kind === 'field') {
                    list(node.fields, node.id, depth + 1, 'field', [...entry.path, 'fields']);
                    list(node.headerFields, node.id, depth + 1, 'field', [...entry.path, 'headerFields']);
                    list(node.branches, node.id, depth + 1, 'branch', [...entry.path, 'branches']);
                    list(node.bits, node.id, depth + 1, 'bit', [...entry.path, 'bits']);
                } else if (kind === 'branch') {
                    list(node.fields, node.id, depth + 1, 'field', [...entry.path, 'fields']);
                }
            });
        }
        list(protocol.headerFields, 'header', 0, 'field', ['headerFields']);
        Object.entries(protocol.structures || {}).forEach(([name, fields]) =>
            list(fields, `structure:${name}`, 0, 'field', ['structures', name]));
        list(protocol.messages, null, 0, 'message', ['messages']);
        list(protocol.rules, null, 0, 'rule', ['rules']);
    }
    function findEntry(protocol, id, kind) {
        if (typeof id !== 'string' || !id) return null;
        let found = null;
        visit(protocol, entry => { if (!found && entry.node.id === id && (!kind || entry.kind === kind)) found = entry; });
        return found;
    }
    function findNode(protocol, id) { return findEntry(protocol, id)?.node ?? null; }
    function findField(protocol, id) { return findEntry(protocol, id, 'field')?.node ?? null; }
    function flattenFields(protocol) {
        const rows = [];
        visit(protocol, entry => {
            if (entry.kind === 'field') rows.push({ field: entry.node, parentId: entry.parentId,
                depth: entry.depth, path: entry.path });
        });
        return rows;
    }
    function normalizeIds(input) {
        const protocol = clone(input), ids = new Set([protocol.id]);
        visit(protocol, entry => {
            const id = entry.node.id;
            if (typeof id !== 'string' || !id || ids.has(id))
                entry.node.id = freshId(ids, entry.node.name || entry.kind);
            else ids.add(id);
        });
        return protocol;
    }
    function parentArray(protocol, parentId) {
        if (parentId === 'header') return protocol.headerFields ||= [];
        if (typeof parentId === 'string' && parentId.startsWith('tlv-header:')) {
            const field = findField(protocol, parentId.slice('tlv-header:'.length));
            if (!field || field.type !== 'tlv') throw new Error(`Unknown TLV header: ${parentId}`);
            return field.headerFields ||= [];
        }
        if (typeof parentId === 'string' && parentId.startsWith('structure:')) {
            const name = parentId.slice('structure:'.length);
            if (!Object.hasOwn(protocol.structures || {}, name)) throw new Error(`Unknown structure: ${name}`);
            return protocol.structures[name];
        }
        const parent = findEntry(protocol, parentId);
        if (!parent || !['message', 'field', 'branch'].includes(parent.kind)) throw new Error(`Unknown field parent: ${parentId}`);
        if (parent.kind === 'field' && !['struct', 'repeat'].includes(parent.node.type))
            throw new Error(`Field cannot contain fields: ${parentId}`);
        return parent.node.fields ||= [];
    }
    function subtreeIds(node) {
        const ids = new Set();
        function walk(value) {
            if (!value || typeof value !== 'object') return;
            if (typeof value.id === 'string') ids.add(value.id);
            for (const [key, child] of Object.entries(value)) if (key !== 'ref') walk(child);
        }
        walk(node); return ids;
    }
    function remapCopy(source, ids) {
        const node = clone(source), mapping = new Map();
        function assign(value) {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value)) { value.forEach(assign); return; }
            if (Object.hasOwn(value, 'id')) {
                const old = value.id;
                const next = freshId(ids, old || value.name || 'node');
                if (typeof old === 'string') mapping.set(old, next);
                value.id = next;
            }
            Object.values(value).forEach(assign);
        }
        function rewrite(value) {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value)) { value.forEach(rewrite); return; }
            for (const [key, child] of Object.entries(value)) {
                if (key !== 'id' && /(?:Id|ID)$/.test(key) && typeof child === 'string' && mapping.has(child))
                    value[key] = mapping.get(child);
                else rewrite(child);
            }
        }
        assign(node); rewrite(node); return node;
    }
    function insertField(input, parentId, index, field) {
        assertName(field?.name);
        const protocol = clone(input), array = parentArray(protocol, parentId);
        if (array.some(item => item.name === field.name)) throw new Error(`Duplicate field name: ${field.name}`);
        const copy = remapCopy(field, usedIds(protocol));
        if (!copy.id) copy.id = freshId(usedIds(protocol), copy.name);
        array.splice(Math.max(0, Math.min(array.length, index)), 0, copy);
        return normalizeIds(protocol);
    }
    function getLengthBindings(protocol, sourceId) {
        if (typeof sourceId !== 'string' || !sourceId) return [];
        const rows = [];
        visit(protocol, entry => {
            if (entry.node.lengthSource?.fieldId === sourceId) rows.push({ targetId: entry.node.id,
                targetKind: entry.kind, label: entry.node.name || entry.node.id,
                unit: entry.node.lengthSource.unit ?? 1, adjustment: entry.node.lengthSource.adjustment ?? 0 });
        });
        return rows;
    }
    function isLengthSource(field) {
        return Boolean(field && /^uint(?:8|16|32)$/.test(field.type === 'enum' ? field.baseType ?? 'uint8' : field.type) &&
            field.count === undefined && field.until === undefined && !field.expectedBytes);
    }
    function lengthTargetError(protocol, source, target) {
        if (!isLengthSource(source?.node)) return '长度源必须是独立的无符号 8、16 或 32 位整数字段';
        if (!target || source.node.id === target.node.id || target.kind !== 'message' &&
            !['bytes','reserved','string','struct','choice','repeat','tlv'].includes(target.node.type)) return '长度目标必须是整帧或可变长度数据段，不能是固定字段或标量';
        if (target.node.lengthSource && target.node.lengthSource.fieldId !== source.node.id) return '该目标已由其它长度字段控制，请先解除原绑定';
        if (!['messages','structures'].includes(source.path[0]) || source.path[0] !== target.path[0] || source.path[1] !== target.path[1])
            return '长度源与目标必须属于同一整帧或同一共享结构';
        if (target.kind === 'message') {
            const layout = layoutSummary(protocol, target.node.id).find(row => row.id === source.node.id);
            if (layout?.frameOffset == null) return '整帧长度源必须具有固定字节位置';
            for (let parent = findEntry(protocol, source.parentId); parent && parent.kind !== 'message'; parent = findEntry(protocol, parent.parentId)) {
                if (parent.kind !== 'field' || parent.node.type !== 'struct' || parent.node.count !== undefined || parent.node.until !== undefined || parent.node.condition !== undefined)
                    return '整帧长度源不能位于条件分支、重复或可选数据段中';
            }
            if (source.node.condition !== undefined) return '整帧长度源不能是可选字段';
            return null;
        }
        // An earlier unconditional structure exposes its scalar children to later siblings.
        // Do not lift a source out of a branch, repeated item or optional segment.
        if (source.node.condition !== undefined) return '长度源不能是可选字段';
        for (let visibleSource = source; visibleSource;) {
            for (let current = target; current; current = findEntry(protocol, current.parentId)) {
                if (current.array === visibleSource.array && visibleSource.index < current.index) return null;
            }
            const parent = findEntry(protocol, visibleSource.parentId);
            if (parent?.kind !== 'field' || parent.node.type !== 'struct' ||
                parent.node.count !== undefined || parent.node.until !== undefined || parent.node.condition !== undefined) break;
            visibleSource = parent;
        }
        return '长度源必须在目标之前读取，不能跨分支或反向引用';
    }
    function getLengthTargets(protocol, sourceId) {
        const source = findEntry(protocol, sourceId, 'field'), rows = [];
        if (!isLengthSource(source?.node)) return rows;
        visit(protocol, target => {
            if (['field','message'].includes(target.kind) && !lengthTargetError(protocol, source, target)) rows.push({ id: target.node.id,
                kind: target.kind, label: target.node.name || target.node.id });
        });
        return rows;
    }
    function bindLengthTarget(input, sourceId, targetId, { unit = 1, adjustment = 0 } = {}) {
        const source = findEntry(input, sourceId, 'field'), target = findEntry(input, targetId);
        const error = lengthTargetError(input, source, target);
        if (error) throw new Error(error);
        if (!Number.isSafeInteger(unit) || unit < 1) throw new Error('长度单位必须为正整数字节数');
        if (!Number.isSafeInteger(adjustment)) throw new Error('长度修正必须为整数字节数');
        const protocol = clone(input), changed = findNode(protocol, targetId);
        changed.byteLength = 0;
        for (const key of ['length', 'lengthFrom', 'boundary']) delete changed[key];
        changed.lengthSource = { fieldId: sourceId, unit, adjustment };
        findField(protocol, sourceId).role = 'length';
        return protocol;
    }
    function unbindLengthTarget(input, sourceId, targetId) {
        const protocol = clone(input), target = findNode(protocol, targetId);
        if (target?.lengthSource?.fieldId !== sourceId) throw new Error('该长度绑定不存在');
        delete target.lengthSource;
        if (findEntry(protocol, targetId)?.kind !== 'message') target.lengthFrom =
            ['struct', 'choice'].includes(target.type) || target.type === 'repeat' && target.count !== undefined ? 'contents' : '';
        if (!getLengthBindings(protocol, sourceId).length) {
            const source = findField(protocol, sourceId);
            if (source?.role === 'length') delete source.role;
        }
        return protocol;
    }
    function removeField(input, id) {
        const protocol = clone(input), entry = findEntry(protocol, id, 'field');
        if (!entry) throw new Error(`Unknown field: ${id}`);
        entry.array.splice(entry.index, 1); return protocol;
    }
    function reorderBranch(input, fieldId, branchId, index) {
        const protocol = clone(input), field = findField(protocol, fieldId);
        if (!field || !['choice','tlv'].includes(field.type)) throw new Error('Unknown branch container: ' + fieldId);
        const branches = field.branches ?? [], before = branches.findIndex(branch => branch.id === branchId);
        if (before < 0) throw new Error('Unknown branch: ' + branchId);
        if (!Number.isInteger(index)) throw new Error('Branch position must be an integer');
        const [branch] = branches.splice(before, 1); branches.splice(Math.max(0, Math.min(branches.length, index)), 0, branch);
        return protocol;
    }
    function moveField(input, id, parentId, index) {
        const protocol = clone(input), entry = findEntry(protocol, id, 'field');
        if (!entry) throw new Error(`Unknown field: ${id}`);
        const targetId = typeof parentId === 'string' && parentId.startsWith('tlv-header:')
            ? parentId.slice('tlv-header:'.length) : parentId;
        if (subtreeIds(entry.node).has(targetId)) throw new Error('Cannot create a field cycle');
        const target = parentArray(protocol, parentId);
        if (target !== entry.array && target.some(item => item.name === entry.node.name))
            throw new Error(`Duplicate field name: ${entry.node.name}`);
        const position = Math.max(0, Math.min(target.length, index));
        entry.array.splice(entry.index, 1);
        target.splice(target === entry.array && entry.index < position ? position - 1 : position, 0, entry.node);
        remapConstraintPaths(input, protocol);
        return protocol;
    }
    function remapConstraintPaths(before, after) {
        const paths = protocol => {
            const result = new Map();
            const walk = (fields, prefix = '', depth = 0) => { if (depth > 16) return; for (const field of fields ?? []) {
                const path = prefix + field.name;
                if (!result.has(field.id)) result.set(field.id, []); result.get(field.id).push(path);
                const next = field.inline ? prefix : path + '.';
                walk(field.fields ?? protocol.structures?.[field.ref], next, depth + 1); walk(field.headerFields, next, depth + 1);
                for (const branch of field.branches ?? []) walk(branch.fields, next, depth + 1);
            } };
            walk(protocol.messages?.[0]?.fields); return result;
        };
        if (!after.rules?.length) return;
        const old = paths(before), next = paths(after), changes = [];
        for (const [id, previous] of old) if (previous.length === 1 && next.get(id)?.length === 1 && previous[0] !== next.get(id)[0])
            changes.push([previous[0], next.get(id)[0]]);
        changes.sort((a, b) => b[0].length - a[0].length);
        for (const rule of after.rules) for (const [owner, key] of [[rule, 'expression'], [rule, 'value'], [rule, 'condition'], [rule.checksum, 'start'], [rule.checksum, 'end']]) {
            if (typeof owner?.[key] !== 'string') continue;
            owner[key] = owner[key].replace(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*/g, token => {
                const prefix = token.startsWith('CURRENT.') ? 'CURRENT.' : '', path = token.slice(prefix.length);
                const plain = path.replace(/\[\d+\]/g, '');
                const change = changes.find(([oldPath]) => plain === oldPath || plain.startsWith(oldPath + '.'));
                if (!change) return token;
                const source = path.split('.'), oldParts = change[0].split('.'), newParts = change[1].split('.'), newPlainParts = [...newParts];
                for (let i = 0; i < oldParts.length; i++) {
                    const indices = source[i].slice(oldParts[i].length);
                    if (!indices) continue;
                    const destination = i === oldParts.length - 1 ? newParts.length - 1 :
                        newPlainParts.findIndex((part, index) => index < newParts.length - 1 &&
                            newPlainParts.slice(0, index + 1).join('.') === oldParts.slice(0, i + 1).join('.'));
                    if (destination < 0) throw new Error('移动会移除规则引用的重复段索引，请先调整规则');
                    newParts[destination] += indices;
                }
                return prefix + [...newParts, ...source.slice(oldParts.length)].join('.');
            });
        }
    }
    function duplicateField(input, id) {
        const protocol = clone(input), entry = findEntry(protocol, id, 'field');
        if (!entry) throw new Error(`Unknown field: ${id}`);
        const copy = remapCopy(entry.node, usedIds(protocol));
        let name = `${entry.node.name}_copy`, number = 2;
        while (entry.array.some(field => field.name === name)) name = `${entry.node.name}_copy${number++}`;
        copy.name = name; copy.label = copy.label ? `${copy.label} copy` : copy.label;
        entry.array.splice(entry.index + 1, 0, copy); return protocol;
    }
    function makeStructureIndependent(input, id) {
        const protocol = clone(input), field = findField(protocol, id);
        if (!field || field.type !== 'struct' || !field.ref || !Object.hasOwn(protocol.structures || {}, field.ref))
            throw new Error(`Unknown shared structure instance: ${id}`);
        const ids = usedIds(protocol);
        field.fields = remapCopy(protocol.structures[field.ref], ids);
        delete field.ref; return protocol;
    }
    function replaceIdentifier(source, before, after, depth = 0, shadowed = false, parentInCurrent = false, strict = false) {
        if (typeof source !== 'string') return source;
        const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const qualifiers = strict ? 'CURRENT|PARENT' : 'CURRENT|PARENT|current|parent';
        const pattern = new RegExp(`(^|[^A-Za-z0-9_$.])(?:(${qualifiers})\\.)?${escaped}(?![A-Za-z0-9_$])`, 'g');
        return source.replace(pattern, (match, prefix, qualifier) => {
            if (qualifier?.toUpperCase() === 'PARENT' && depth !== 1 && !(parentInCurrent && depth === 0) || qualifier?.toUpperCase() === 'CURRENT' && depth !== 0)
                return match;
            if (shadowed && qualifier?.toUpperCase() !== 'PARENT') return match;
            return prefix + (qualifier ? `${qualifier}.` : '') + after;
        });
    }
    function renameField(input, id, changes, external = []) {
        const protocol = clone(input), entry = findEntry(protocol, id, 'field');
        if (!entry) throw new Error(`Unknown field: ${id}`);
        const before = entry.node.name, name = changes.name ?? before;
        assertName(name);
        if (entry.array.some(item => item !== entry.node && item.name === name))
            throw new Error(`Duplicate field name: ${name}`);
        entry.node.name = name;
        if (Object.hasOwn(changes, 'label')) entry.node.label = changes.label;
        const references = inspectReferences(input, id, external);
        function rewrite(value, nodeId, depth, shadowed = false, parentInCurrent = false) {
            if (!value || typeof value !== 'object') return;
            for (const [key, child] of Object.entries(value)) {
                if (expressionKeys.has(key) && typeof child === 'string' && name !== before) {
                    const next = replaceIdentifier(child, before, name, depth, shadowed, parentInCurrent, protocol.symbolVersion >= 2);
                    if (next !== child) {
                        value[key] = next;
                        const reference = references.find(item => item.nodeId === nodeId && item.property === key && item.kind === 'expression');
                        if (reference) Object.assign(reference, { previous: child, value: next });
                        else references.push({ nodeId, property: key, kind: 'expression', previous: child, value: next });
                    }
                } else if (key === 'fields' || key === 'headerFields') rewriteFields(child, depth + 1, shadowed, parentInCurrent);
                else if (key === 'branches' && Array.isArray(child)) child.forEach(branch => rewrite(branch, branch.id, depth, shadowed, parentInCurrent));
            }
        }
        function rewriteFields(fields, depth, inheritedShadow = false, parentInCurrent = false) {
            if (!Array.isArray(fields)) return;
            let shadowed = inheritedShadow;
            for (const field of fields) {
                rewrite(field, field.id, depth, shadowed, parentInCurrent);
                if (field.name === before) shadowed = true;
            }
        }
        rewriteFields(entry.array.slice(entry.index + 1), 0);
        // TLV value fields share the item scope with its already-read header.
        // The owner selector and automatic length binding are consumers too.
        const tlv = findField(protocol, entry.parentId);
        if (tlv?.type === 'tlv' && tlv.headerFields === entry.array) {
            const bindings = { selector: tlv.selector, lengthField: tlv.lengthField };
            rewrite(bindings, tlv.id, 0); Object.assign(tlv, bindings);
            for (const branch of tlv.branches ?? []) {
                if (branch.expression !== undefined) {
                    const condition = { expression: branch.expression }; rewrite(condition, branch.id, 0, false, true);
                    branch.expression = condition.expression;
                }
                rewriteFields(branch.fields, 0, false, true);
            }
        }
        for (const reference of references) if (reference.kind === 'external' && reference.reference.path)
            reference.proposedPath = replacePathEnd(reference.reference.path, before, name);
        for (const reference of qualifiedReferences(input, id, name)) {
            if (reference.kind === 'unresolved') {
                if (!references.some(item => item.kind === 'unresolved' && item.nodeId === reference.nodeId &&
                    item.property === reference.property && item.value === reference.value)) references.push(reference);
                continue;
            }
            const consumer = findNode(protocol, reference.nodeId), nested = reference.property.startsWith('checksum.');
            const property = nested ? reference.property.slice(9) : reference.property, container = nested ? consumer?.checksum : consumer;
            if (!container || typeof container[property] !== 'string') continue;
            const previous = container[property];
            const pattern = /(^|[^A-Za-z0-9_$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)/g;
            container[property] = previous.replace(pattern, (match, prefix, token) =>
                prefix + (reference.replacements[token] || token));
            const found = references.find(item => item.kind === 'expression' &&
                item.nodeId === reference.nodeId && item.property === reference.property);
            if (found) Object.assign(found, { previous: found.previous ?? previous, value: container[property] });
            else references.push({ kind: 'expression', nodeId: reference.nodeId, property: reference.property,
                previous, value: container[property] });
        }
        return { protocol, references };
    }
    function replacePathEnd(path, before, after) {
        if (typeof path !== 'string') return path;
        const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return path.replace(new RegExp(`(^|\\.)${escaped}(\\[\\d+\\])?$`), (_, prefix, index) => prefix + after + (index || ''));
    }
    function hasQualifiedIdentifier(source, before, qualifier) {
        if (typeof source !== 'string') return false;
        const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^A-Za-z0-9_$.])${qualifier}\\.${escaped}(?![A-Za-z0-9_$])`).test(source);
    }
    function qualifiedReferences(protocol, targetId, after) {
        const results = [], target = findField(protocol, targetId);
        if (!target) return results;
        const nameOf = part => /^[A-Za-z_$][\w$]*/.exec(part)?.[0];
        const childFields = field => [
            ...(field.ref ? protocol.structures?.[field.ref] || [] : field.fields || []),
            ...(field.headerFields || []),
            ...(field.branches || []).flatMap(branch => branch.fields || [])
        ];
        function rewriteToken(token, available, current, parent, replacements, ambiguous) {
            const parts = token.split('.');
            const qualifiers = protocol.symbolVersion >= 2 ? ['CURRENT', 'PARENT'] : ['CURRENT', 'PARENT', 'current', 'parent'];
            const qualifier = qualifiers.includes(parts[0]) ? parts.shift() : null;
            if (!parts.some(part => nameOf(part) === target.name)) return token;
            const scope = qualifier?.toUpperCase() === 'CURRENT' ? current : qualifier?.toUpperCase() === 'PARENT' ? parent : available;
            const first = scope.get(nameOf(parts[0]));
            let candidates = first ? [{ field: first, matched: first.id === targetId ? 0 : -1 }] : [];
            for (let index = 1; index < parts.length; index++) {
                const name = nameOf(parts[index]);
                candidates = candidates.flatMap(({ field, matched }) => childFields(field).filter(child => child.name === name)
                    .map(child => ({ field: child, matched: child.id === targetId ? index : matched })));
            }
            const matched = new Set(candidates.map(candidate => candidate.matched));
            if (![...matched].some(index => index >= 0)) return token;
            if (matched.size !== 1 || new Set(candidates.map(candidate => candidate.field.id)).size > 1) { ambiguous.add(token); return token; }
            const index = [...matched][0], suffix = parts[index].slice(target.name.length);
            parts[index] = after + suffix;
            const next = (qualifier ? qualifier + '.' : '') + parts.join('.');
            replacements[token] = next;
            return next;
        }
        function inspect(node, available, current, parent) {
            for (const [property, source] of Object.entries(node)) {
                if (!expressionKeys.has(property) || typeof source !== 'string') continue;
                const replacements = Object.create(null), ambiguous = new Set();
                const pattern = /(^|[^A-Za-z0-9_$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)/g;
                source.replace(pattern, (_, prefix, token) =>
                    prefix + rewriteToken(token, available, current, parent, replacements, ambiguous));
                if (Object.keys(replacements).length) results.push({ kind: 'expression', nodeId: node.id,
                    property, replacements });
                for (const token of ambiguous) results.push({ kind: 'unresolved', nodeId: node.id,
                    property, value: token, reason: 'Ambiguous qualified field path' });
            }
        }
        function fields(fields, inherited = new Map()) {
            const prior = new Map();
            for (const field of fields || []) {
                const available = new Map([...inherited, ...prior]);
                inspect(field, available, prior, inherited);
                if (field.type === 'tlv') {
                    fieldsScan(field.headerFields, available);
                    const itemScope = new Map([...available,
                        ...(field.headerFields || []).map(header => [header.name, header])]);
                    for (const branch of field.branches || []) {
                        inspect(branch, itemScope, new Map(), available);
                        fieldsScan(branch.fields, itemScope);
                    }
                } else {
                    if (!field.ref) fieldsScan(field.fields, available);
                    for (const branch of field.branches || []) {
                        inspect(branch, available, new Map(), inherited);
                        fieldsScan(branch.fields, available);
                    }
                }
                prior.set(field.name, field);
            }
        }
        const fieldsScan = (items, inherited) => fields(items, inherited);
        fields(protocol.headerFields);
        for (const definition of Object.values(protocol.structures || {})) fields(definition);
        function messages(items) {
            for (const message of items || []) {
                if (protocol.schemaVersion >= 3) {
                    const scope = new Map((message.fields || []).map(field => [field.name, field]));
                    inspect(message, scope, scope, new Map());
                }
                fields(message.fields); messages(message.dispatch?.messages);
            }
        }
        messages(protocol.messages);
        const rootScope = new Map((protocol.messages?.[0]?.fields ?? []).map(field => [field.name, field]));
        for (const rule of protocol.rules ?? []) {
            inspect(rule, rootScope, rootScope, new Map());
            if (rule.checksum) inspect({ id: rule.id, 'checksum.start': rule.checksum.start, 'checksum.end': rule.checksum.end }, rootScope, rootScope, new Map());
        }
        return results;
    }
    function inspectReferences(protocol, id, external = []) {
        const target = findField(protocol, id), result = [];
        if (!target) return result;
        const before = target.name;
        const owner = findEntry(protocol, id, 'field');
        function scan(value, nodeId, depth, shadowed = false, parentInCurrent = false) {
            if (!value || typeof value !== 'object') return;
            for (const [key, child] of Object.entries(value)) {
                if (expressionKeys.has(key) && typeof child === 'string') {
                    if (replaceIdentifier(child, before, '', depth, shadowed, parentInCurrent, protocol.symbolVersion >= 2) !== child)
                        result.push({ nodeId, property: key, kind: 'expression' });
                    if (depth > 0 && (hasQualifiedIdentifier(child, before, 'CURRENT') || !(protocol.symbolVersion >= 2) && hasQualifiedIdentifier(child, before, 'current')) ||
                        depth > 1 && (hasQualifiedIdentifier(child, before, 'PARENT') || !(protocol.symbolVersion >= 2) && hasQualifiedIdentifier(child, before, 'parent')))
                        result.push({ nodeId, property: key, kind: 'unresolved', value: child });
                }
                else if (key === 'fields' || key === 'headerFields') scanFields(child, depth + 1, shadowed, parentInCurrent);
                else if (key === 'branches' && Array.isArray(child)) child.forEach(branch => scan(branch, branch.id, depth, shadowed, parentInCurrent));
            }
        }
        function scanFields(fields, depth, inheritedShadow = false, parentInCurrent = false) {
            if (!Array.isArray(fields)) return;
            let shadowed = inheritedShadow;
            for (const field of fields) {
                scan(field, field.id, depth, shadowed, parentInCurrent);
                if (field.name === before) shadowed = true;
            }
        }
        scanFields(owner.array.slice(owner.index + 1), 0);
        const tlv = findField(protocol, owner.parentId);
        if (tlv?.type === 'tlv' && tlv.headerFields === owner.array) {
            scan({ selector: tlv.selector, lengthField: tlv.lengthField }, tlv.id, 0);
            for (const branch of tlv.branches ?? []) {
                if (branch.expression !== undefined) scan({ expression: branch.expression }, branch.id, 0, false, true);
                scanFields(branch.fields, 0, false, true);
            }
        }
        visit(protocol, entry => {
            const references = (object, prefix = '') => {
                for (const [key, value] of Object.entries(object)) {
                    if (/(?:Id|ID)$/.test(key) && key !== 'id' && value === id) result.push({ nodeId: entry.node.id, property: prefix + key, kind: 'node' });
                    else if (value && typeof value === 'object' && !Array.isArray(value) && !['legacyMessage'].includes(key)) references(value, prefix + key + '.');
                }
            };
            references(entry.node);
        });
        external.forEach((reference, index) => {
            if (reference?.protocolId && reference.protocolId !== protocol.id) return;
            const byId = reference?.fieldId === id || reference?.nodeId === id;
            const sameMessage = !reference?.messageId || protocol.messages?.[owner.path[1]]?.id === reference.messageId;
            const byPath = !reference?.fieldId && sameMessage && replacePathEnd(reference?.path, before, '') !== reference?.path;
            if (byId || byPath) result.push({ kind: 'external', index, certainty: byId ? 'id' : 'path',
                proposedPath: reference?.path, reference: clone(reference) });
        });
        for (const reference of qualifiedReferences(protocol, id, target.name)) {
            if (reference.kind === 'unresolved') result.push(reference);
            else if (!result.some(item => item.kind === 'expression' && item.nodeId === reference.nodeId &&
                item.property === reference.property)) result.push({ kind: 'expression', nodeId: reference.nodeId,
                property: reference.property });
        }
        return result;
    }
    function freeze(value) {
        if (value && typeof value === 'object' && !Object.isFrozen(value)) {
            Object.values(value).forEach(freeze); Object.freeze(value);
        }
        return value;
    }
    function createHistory(initial, limit = 100) {
        return freeze({ past: [], present: clone(initial), future: [], limit: Math.max(1, limit) });
    }
    function pushHistory(history, next) {
        return freeze({ past: [...history.past.map(clone), clone(history.present)].slice(-history.limit),
            present: clone(next), future: [], limit: history.limit });
    }
    function undo(history) {
        if (!history.past.length) return freeze(clone(history));
        return freeze({ past: history.past.slice(0, -1).map(clone), present: clone(history.past.at(-1)),
            future: [clone(history.present), ...history.future.map(clone)], limit: history.limit });
    }
    function redo(history) {
        if (!history.future.length) return freeze(clone(history));
        return freeze({ past: [...history.past.map(clone), clone(history.present)].slice(-history.limit),
            present: clone(history.future[0]), future: history.future.slice(1).map(clone), limit: history.limit });
    }
    function uniqueProtocolId(library, requested) {
        const ids = new Set(library.map(protocol => protocol.id));
        return freshId(ids, requested || 'protocol');
    }
    function defaultProtocol(id) {
        return { id, name: 'New protocol', endian: 'little', framing: { fixedLength: 2, maxLength: 65535 },
            command: { offset: 1, type: 'uint8' }, payloadOffset: 2,
            messages: [{ id: `${id}-message`, name: 'Message', command: 1, fields: [] }] };
    }
    function createProtocol(library, template) {
        const protocols = clone(library);
        let protocol;
        if (template) {
            const source = normalizeIds(template), occupied = usedIds(source);
            for (const item of protocols) occupied.add(item.id);
            const id = freshId(occupied, source.id || 'protocol');
            protocol = remapCopy({ ...source, id: undefined }, occupied);
            protocol.id = id;
        } else protocol = defaultProtocol(uniqueProtocolId(protocols, 'protocol'));
        protocols.push(protocol); return { protocols, protocol: clone(protocol) };
    }
    function duplicateProtocol(library, id) {
        const source = library.find(protocol => protocol.id === id);
        if (!source) throw new Error(`Unknown protocol: ${id}`);
        const protocols = clone(library), newId = uniqueProtocolId(protocols, id);
        const ids = usedIds(source); ids.add(newId);
        const protocol = remapCopy({ ...source, id: undefined }, ids);
        protocol.id = newId; protocol.name = `${source.name || id} copy`;
        protocols.push(protocol); return { protocols, protocol: clone(protocol) };
    }
    function deleteProtocol(library, id) {
        const protocols = clone(library), index = protocols.findIndex(protocol => protocol.id === id);
        if (index < 0) throw new Error(`Unknown protocol: ${id}`);
        const [deleted] = protocols.splice(index, 1); return { protocols, deleted };
    }
    function renameProtocol(library, id, name) {
        if (typeof name !== 'string' || !name.trim()) throw new Error('Protocol label is required');
        const protocols = clone(library), protocol = protocols.find(item => item.id === id);
        if (!protocol) throw new Error(`Unknown protocol: ${id}`);
        protocol.name = name.trim(); return protocols;
    }
    function reorderProtocol(library, id, index) {
        const protocols = clone(library), source = protocols.findIndex(item => item.id === id);
        if (source < 0) throw new Error(`Unknown protocol: ${id}`);
        const [protocol] = protocols.splice(source, 1);
        protocols.splice(Math.max(0, Math.min(protocols.length, index)), 0, protocol); return protocols;
    }
    function importProtocol(library, imported) {
        if (!imported || typeof imported !== 'object' || !Array.isArray(imported.messages))
            throw new Error('Invalid imported protocol');
        const protocols = clone(library), source = normalizeIds(imported), id = uniqueProtocolId(protocols, source.id || 'protocol');
        const protocol = id === source.id ? source : remapCopy({ ...source, id: undefined }, usedIds(source));
        protocol.id = id; protocols.push(protocol); return { protocols, protocol: clone(protocol) };
    }
    function toUnified(input) {
        const Protocol = typeof module !== 'undefined' && module.exports ? require('./protocolEngine').Protocol : root.SerialPlotter.Protocol;
        const source = clone(Protocol.compile(input).schema);
        if (source.schemaVersion >= 3) return source;
        const protocol = { ...source, schemaVersion: 3, framing: { maxLength: source.framing?.maxLength ?? 1048576 } };
        for (const key of ['headerFields','command','checksums','payloadOffset','payloadEnd']) delete protocol[key];
        const ids = usedIds(source), id = stem => freshId(ids, source.id + '.' + stem);
        const prefix = source.payloadOffset ?? 0, suffix = source.payloadEnd < 0 ? -source.payloadEnd : source.framing?.footer?.length ?? 0;
        const size = field => wireWidths[field.type === 'enum' ? field.baseType || 'uint8' : field.type] ??
            (field.type === 'bitfield' ? field.byteLength : field.type === 'fixed' ? field.bytes.length : typeof field.length === 'number' ? field.length : null);
        function convert(fields) {
            for (const field of fields) {
                const width = size(field) ?? (field.type === 'struct' ? staticWidth({ ...field, count: undefined }, source) : null);
                field.byteLength = width ?? 0;
                if (field.byteLength === 0) field.lengthFrom = field.length ??
                    (['struct','choice'].includes(field.type) || ['repeat','tlv'].includes(field.type) && field.count !== undefined ? 'contents' : 'REMAINING');
                if (field.fields) convert(field.fields);
                if (field.headerFields) convert(field.headerFields);
                for (const branch of field.branches || []) convert(branch.fields || []);
            }
            return fields;
        }
        const rootId = id('frame'), rootFields = [], headerFields = convert(clone(source.headerFields || []));
        let headerCursor = 0;
        for (const field of headerFields) {
            field.offset ??= headerCursor;
            const width = size(field); headerCursor = typeof field.offset === 'number' && width !== null ? field.offset + width : headerCursor;
        }
        const header = { id: id('header'), name: 'header', label: '公共字段', type: 'struct', byteLength: prefix, fields: headerFields, legacyHeader: true };
        const names = new Set(headerFields.map(field => field.name));
        const name = stem => { let next = stem, index = 1; while (names.has(next)) next = stem + index++; names.add(next); return next; };
        let lengthField, commandField;
        function slot(offset, width, stem, endian) {
            const order = value => ['big','be'].includes(value ?? source.endian) ? 'big' : 'little';
            let field = headerFields.find(item => (item.offset ?? 0) === offset && size(item) === width && order(item.endian) === order(endian));
            if (!field) {
                field = { id: id(stem), name: name(stem), type: 'uint' + width * 8, byteLength: width, offset, ...(endian ? { endian } : {}) };
                if (headerFields.some(item => typeof item.offset === 'number' && item.offset < offset + width && item.offset + size(item) > offset)) field.legacyOverlay = true;
                headerFields.push(field);
            }
            return field;
        }
        if (source.framing?.length) {
            const binding = source.framing.length;
            lengthField = slot(binding.offset, wireWidths[binding.type], 'frame_length', binding.endian);
        }
        if (source.command) commandField = slot(source.command.offset, wireWidths[source.command.type], 'cmd_id', source.command.endian);
        if (source.framing?.header?.length) {
            const bytes = source.framing.header;
            let field = headerFields.find(item => (item.offset ?? 0) === 0 && size(item) === bytes.length);
            if (field) { field.expectedBytes = bytes; field.framingRole = 'sync'; }
            else {
                field = { id: id('sync'), name: name('sync'), label: '起始固定字节', type: 'fixed', byteLength: bytes.length, bytes, framingRole: 'sync', offset: 0 };
                if (headerFields.some(item => (item.offset ?? 0) < bytes.length)) field.legacyOverlay = true;
                headerFields.push(field);
            }
        }
        const suffixFields = [];
        for (const check of source.checksums || []) {
            const width = check.width ?? (Number(String(check.type).replace('crc', '')) || 8), bytes = width / 8;
            const position = check.offset ?? -bytes;
            const checksum = { ...clone(check), width }; delete checksum.offset; delete checksum.id;
            if (checksum.type === 'crc') checksum.type = 'crc' + width;
            const ownId = check.id || id('checksum');
            if (checksum.end === position || checksum.end === undefined) checksum.end = { fieldId: ownId, edge: 'start' };
            if (checksum.start === 0 && prefix) checksum.start = { fieldId: header.id, edge: 'start' };
            if (typeof position === 'number' && position >= 0 && position + bytes <= prefix) {
                const field = slot(position, bytes, 'checksum', check.endian);
                if (typeof checksum.end === 'object' && checksum.end.fieldId === ownId) checksum.end.fieldId = field.id;
                Object.assign(field, { type: 'checksum', byteLength: bytes, checksum }); delete field.bits;
            } else if (typeof position === 'number' && position < 0 && -position <= suffix) {
                suffixFields.push({ id: ownId, name: 'checksum_' + suffixFields.length, type: 'checksum', byteLength: bytes, endian: check.endian, checksum, tailOffset: suffix + position });
            } else {
                rootFields.push({ id: ownId, name: 'checksum_' + rootFields.length, type: 'checksum', byteLength: bytes, endian: check.endian, checksum,
                    legacyOverlay: true, offsetBase: 'frame', offset: typeof position === 'number' && position < 0 ? 'FRAME_LENGTH + (' + position + ')' : position });
            }
        }
        headerFields.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
        if (prefix > 0) rootFields.unshift(header);
        const choiceId = id('commands');
        function branch(message, selector, path = '', siblings = source.messages) {
            const metadata = { ...message }; delete metadata.fields; delete metadata.dispatch;
            const fields = convert(clone(message.fields || []));
            if (message.dispatch) {
                const dispatch = message.dispatch, content = dispatch.name || 'content';
                fields.push({ id: id(message.id + '.content'), name: content, type: 'struct', byteLength: 0, lengthFrom: 'REMAINING', offset: dispatch.offset ?? 0,
                    fields: [{ id: id(message.id + '.branches'), name: 'subcommands', type: 'choice', byteLength: 0, lengthFrom: 'REMAINING', inline: true,
                        selector: dispatch.field, legacyDispatch: true,
                        branches: [...dispatch.messages.map(child => branch(child, path + dispatch.field, path + content + '.', dispatch.messages)),
                            { id: id(message.id + '.unknown'), default: true, legacyUnknown: 'subcommand', fields: [{ id: id('raw'), name: 'rawPayload', type: 'bytes', byteLength: 0, lengthFrom: 'REMAINING' }] }] }] });
            }
            let match = message.commandRange ? { range: message.commandRange } : message.command === undefined ? { default: true } : { equals: message.command };
            const same = siblings.filter(item => item !== message && item.command === message.command);
            if (same.length && message.command !== undefined) {
                const otherLengths = same.map(item => item.length).filter(Number.isSafeInteger);
                const length = message.length !== undefined ? 'REMAINING == ' + message.length : otherLengths.map(value => 'REMAINING != ' + value).join(' && ');
                match = { expression: `(${selector}) == ${message.command}` + (length ? ` && (${length})` : '') };
            }
            return { id: message.id, label: message.name || message.id, ...match, fields, legacyMessage: metadata, selectorPath: selector, valuePath: path };
        }
        const branches = source.messages.map(message => branch(message, commandField ? 'header.' + commandField.name : '0'));
        if (!branches.some(item => item.default)) branches.push({ id: id('unknown'), default: true, legacyUnknown: 'command', fields: [{ id: id('raw'), name: 'rawPayload', type: 'bytes', byteLength: 0, lengthFrom: 'REMAINING' }] });
        const payload = { id: choiceId, name: 'payload', label: '命令数据段', type: 'choice', inline: true, legacyPayload: true,
            byteLength: 0, lengthFrom: `FRAME_LENGTH - ${prefix + suffix}`, selector: commandField ? 'header.' + commandField.name : '0', branches };
        rootFields.splice(prefix > 0 ? 1 : 0, 0, payload);
        if (source.framing?.footer?.length) suffixFields.push({ id: id('end'), name: 'end', label: '结束固定字节', type: 'fixed', byteLength: source.framing.footer.length,
            bytes: source.framing.footer, framingRole: 'end', tailOffset: suffix - source.framing.footer.length });
        suffixFields.sort((a, b) => a.tailOffset - b.tailOffset);
        let cursor = 0;
        for (const field of suffixFields) {
            if (field.tailOffset > cursor) rootFields.push({ id: id('reserved'), name: 'reserved_' + cursor, type: 'reserved', byteLength: field.tailOffset - cursor });
            cursor = field.tailOffset + field.byteLength; delete field.tailOffset; rootFields.push(field);
        }
        if (cursor < suffix) rootFields.push({ id: id('reserved'), name: 'reserved_' + cursor, type: 'reserved', byteLength: suffix - cursor });
        const frame = { id: rootId, name: '整帧', byteLength: source.framing?.fixedLength ?? 0, fields: rootFields, legacyProtocol: true };
        if (!prefix && !source.command && source.messages.length === 1 && !source.messages[0].dispatch) {
            const message = source.messages[0], index = rootFields.indexOf(payload);
            rootFields.splice(index, 1, ...branches[0].fields);
            frame.id = message.id; frame.name = message.name || '整帧';
            for (const key of ['requireLayout','layouts','conflicts','maxLength']) if (message[key] !== undefined) frame[key] = message[key];
            // Older fixed messages implicitly padded their unoccupied tail.
            const used = staticWidth({ type: 'struct', fields: frame.fields }, protocol);
            if (frame.byteLength > 0 && used !== null && used < frame.byteLength)
                frame.fields.push({ id: id('padding'), name: 'legacy_padding', label: '原布局保留字节', type: 'reserved', byteLength: frame.byteLength - used });
        }
        if (lengthField) frame.lengthSource = { fieldId: lengthField.id, unit: source.framing.length.unit ?? 1, adjustment: source.framing.length.adjustment ?? 0 };
        protocol.messages = [frame];
        for (const fields of Object.values(protocol.structures || {})) convert(fields);
        return protocol;
    }
    function staticWidth(field, protocol, stack = []) {
        if(field.until==='end'&&!['repeat','tlv'].includes(field.type))return null;
        let width = wireWidths[field.type === 'enum' ? field.baseType || 'uint8' : field.type];
        if (field.type === 'bitfield') width = Number.isSafeInteger(field.byteLength) && field.byteLength > 0 ? field.byteLength : null;
        if (field.type === 'fixed') width = Array.isArray(field.bytes) ? field.bytes.length : null;
        if (['bytes', 'string', 'reserved'].includes(field.type)) width = Number.isSafeInteger(field.length) ? field.length : null;
        if (field.type === 'struct' || field.type === 'repeat') {
            if (field.ref && stack.includes(field.ref)) return null;
            const children = field.ref ? protocol.structures?.[field.ref] : field.fields;
            if (!Array.isArray(children)) return null;
            let cursor = 0;
            for (const child of children) {
                const childWidth = staticWidth(child, protocol, field.ref ? [...stack, field.ref] : stack);
                if (childWidth === null || child.offset !== undefined && !Number.isSafeInteger(child.offset)) {
                    cursor = null; break;
                }
                cursor = Math.max(cursor, (child.offset ?? cursor) + childWidth);
            }
            width = cursor;
        }
        if (field.type === 'choice' || field.type === 'tlv') width = null;
        if (field.type === 'repeat') width = Number.isSafeInteger(field.length) ? field.length
            : Number.isSafeInteger(field.count) && Number.isSafeInteger(width) ? width * field.count : null;
        else if (Number.isSafeInteger(field.length) && ['struct', 'choice', 'tlv'].includes(field.type)) width = field.length;
        else if (field.count !== undefined) width = Number.isSafeInteger(field.count) && Number.isSafeInteger(width) ? width * field.count : null;
        if (protocol.schemaVersion >= 3 && field.byteLength !== undefined) width = field.byteLength > 0 &&
            (!field.count || typeof field.count === 'number' || ['repeat','tlv'].includes(field.type))
            ? field.byteLength * (typeof field.count === 'number' && !['repeat','tlv'].includes(field.type) ? field.count : 1) : null;
        return Number.isSafeInteger(width) && width >= 0 ? width : null;
    }
    function layoutSummary(protocol, messageId) {
        const message = findEntry(protocol, messageId, 'message');
        if (!message) throw new Error(`Unknown message: ${messageId}`);
        const rows = [];
        function layout(fields, parentId, base, depth) {
            let cursor = 0;
            for (const field of fields || []) {
                const explicit = Number.isSafeInteger(field.offset) ? field.offset : null;
                const localOffset = field.offsetBase === 'frame' && explicit !== null ? explicit - base : explicit ?? cursor;
                const frameOffset = Number.isSafeInteger(base) && Number.isSafeInteger(localOffset) ? base + localOffset : null;
                const width = staticWidth(field, protocol);
                rows.push({ id: field.id, parentId, depth, localOffset, frameOffset, width,
                    offsetLabel: frameOffset === null ? 'dynamic' : `byte ${frameOffset}`,
                    sizeLabel: width === null ? 'dynamic' : `${width} byte${width === 1 ? '' : 's'}` });
                if (Array.isArray(field.fields) && field.type === 'struct' && field.count === undefined)
                    layout(field.fields, field.id, frameOffset, depth + 1);
                for (const branch of field.branches || []) layout(branch.fields, field.id, frameOffset, depth + 1);
                cursor = Number.isSafeInteger(localOffset) && width !== null ? localOffset + width : null;
            }
        }
        layout(message.node.fields, messageId, protocol.payloadOffset ?? 0, 0);
        return rows;
    }
    // Read-only coverage inspection. Symbolic boundaries keep variable segments
    // comparable without inventing their byte length or executing user code.
    function getConstraintCoverage(protocol, targetId) {
        const result = [];
        for (const rule of protocol.rules ?? []) {
            if (rule.type !== 'checksum' || rule.enabled === false) continue;
            const copy = clone(protocol), field = findField(copy, rule.targetFieldId);
            if (!field) continue;
            field.type = 'checksum'; field.checksum = clone(rule.checksum ?? {});
            for (const relation of getChecksumCoverage(copy, targetId).filter(row => row.checksumId === field.id))
                result.push({ ...relation, ruleId: rule.id, ruleName: rule.name || rule.id,
                    conditional: relation.conditional || Boolean(rule.condition) });
        }
        return result;
    }
    function getChecksumCoverage(protocol, targetId) {
        const targetEntry = findEntry(protocol, targetId, 'field');
        if (!targetEntry) return [];
        const message = protocol.messages?.[targetEntry.path[0] === 'messages' ? targetEntry.path[1] : 0];
        if (!message) return [];
        const rows = [], order = new Map(), zero = { base: '', offset: 0 };
        const key = point => JSON.stringify([point.base, point.offset]);
        const shift = (point, amount) => ({ base: point.base, offset: point.offset + amount });
        const before = (a, b) => {
            const from = key(a), to = key(b);
            if (!order.has(from)) order.set(from, new Set());
            order.get(from).add(to);
        };
        const compare = (a, b) => a && b && a.base === b.base ? Math.sign(a.offset - b.offset) : null;
        const atMost = (a, b) => {
            if (!a || !b) return false;
            const diff = compare(a, b); if (diff !== null) return diff <= 0;
            const seen = new Set(), queue = [key(a)], goal = key(b);
            for (let i = 0; i < queue.length; i++) {
                const point = queue[i]; if (point === goal) return true;
                if (seen.has(point)) continue; seen.add(point);
                for (const next of order.get(point) ?? []) queue.push(next);
            }
            return false;
        };
        const compatible = (a, b) => !Object.keys(a).some(id => b[id] !== undefined && a[id] !== b[id]);
        function walk(fields, start, parents = [], branches = {}, repeated = [], refs = []) {
            let cursor = start;
            for (const field of fields ?? []) {
                const path = JSON.stringify([...parents.map(item => item.field.id), field.id]);
                const explicit = field.offset !== undefined;
                const begin = !explicit ? cursor : Number.isSafeInteger(field.offset) && field.offset >= 0
                    ? shift(field.offsetBase === 'frame' ? zero : start, field.offset) : { base: path + ':offset', offset: 0 };
                const row = { field, start: begin, end: null, path, parents, branches, repeated, children: [] };
                rows.push(row);
                parents.at(-1)?.children.push(row);
                let childrenEnd;
                const nested = field.count !== undefined || field.until==='end' || ['repeat','tlv'].includes(field.type) ? [...repeated, field.id] : repeated;
                if (field.fields || field.ref && !refs.includes(field.ref)) childrenEnd = walk(field.ref ? protocol.structures?.[field.ref] : field.fields,
                    begin, [...parents, row], branches, nested, field.ref ? [...refs, field.ref] : refs);
                if (field.headerFields) walk(field.headerFields, begin, [...parents, row], branches, nested, refs);
                for (const branch of field.branches ?? []) walk(branch.fields, begin, [...parents, row],
                    { ...branches, [field.id]: branch.id }, nested, refs);
                const width = staticWidth(field, protocol);
                row.end = Number.isSafeInteger(width) ? shift(begin, width)
                    : field.type === 'struct' && field.count === undefined && field.until === undefined && field.lengthFrom === 'contents' && childrenEnd ? childrenEnd
                        : { base: path + ':end', offset: 0 };
                before(begin, row.end);
                for (const child of row.children) { before(begin, child.start); before(child.end, row.end); }
                if (!explicit) before(cursor, begin);
                cursor = field.condition === undefined ? row.end : { base: path + ':optional-end', offset: 0 };
                if (field.condition !== undefined) { before(begin, cursor); before(cursor, row.end); }
            }
            return cursor;
        }
        const contentEnd = walk(message.fields, zero);
        const frameEnd = message.byteLength > 0 ? shift(zero, message.byteLength) : contentEnd;
        const result = [];
        for (const target of rows.filter(row => row.field.id === targetId)) {
            for (const check of rows.filter(row => row.field.type === 'checksum' && row.field.id !== targetId && compatible(row.branches, target.branches))) {
                const config = check.field.checksum ?? {};
                const resolve = (value, fallback) => {
                    if (value === undefined) return fallback;
                    if (value && typeof value === 'object') {
                        let matches = rows.filter(row => row.field.id === value.fieldId && compatible(row.branches, check.branches));
                        const local = matches.filter(row => row.parents.at(-1) === check.parents.at(-1));
                        if (local.length) matches = local;
                        if (matches.length !== 1) return null;
                        const boundary = matches[0];
                        // A boundary in a repeated item cannot describe an unrelated occurrence.
                        if (boundary.repeated.join('/') !== check.repeated.join('/')) return null;
                        return value.edge === 'end' ? boundary.end : boundary.start;
                    }
                    let offset = value;
                    if (typeof offset === 'string') {
                        try {
                            const engine = typeof module !== 'undefined' && module.exports ? require('./protocolEngine').Protocol : root.SerialPlotter.Protocol;
                            const context = frameEnd.base === '' ? { FRAME_LENGTH: frameEnd.offset } : {};
                            offset = engine.evaluateExpression(offset, context);
                        } catch (_) { return null; }
                    }
                    return Number.isSafeInteger(offset) ? shift(offset < 0 ? frameEnd : zero, offset) : null;
                };
                const start = resolve(config.start, zero), end = resolve(config.end, check.start);
                const repeated = target.repeated.length > 0 || check.repeated.length > 0;
                if (!repeated && (atMost(end, target.start) || atMost(target.end, start))) continue;
                let coverage = 'unknown';
                if (!repeated && atMost(start, target.start) && atMost(target.end, end)) coverage = 'full';
                else if (!repeated && start && end && atMost(start, target.end) && atMost(target.start, end)) coverage = 'partial';
                const conditional = Object.keys(check.branches).some(id => target.branches[id] === undefined) ||
                    [...check.parents.map(row => row.field), check.field].some(field => field.condition !== undefined);
                const identity = check.path + ':' + coverage;
                if (!result.some(row => row.identity === identity)) result.push({ identity, checksumId: check.field.id,
                    checksumPath: [...check.parents.map(row => row.field.name), check.field.name].join('.'), coverage, conditional });
            }
        }
        return result;
    }
    function createTLVTemplate() {
        return normalizeIds({ id: 'tlv-protocol', name: 'TLV protocol', endian: 'little',
            framing: { header: [0xAA], length: { offset: 1, type: 'uint16', adjustment: 3 }, maxLength: 65535 },
            command: { offset: 3, type: 'uint8' }, payloadOffset: 4,
            messages: [{ id: 'tlv-message', name: 'TLV message', command: 1, fields: [
                { id: 'tlv-items', name: 'items', type: 'tlv', until: 'end',
                    headerFields: [{ id: 'tlv-tag', name: 'tag', type: 'uint8' }, { id: 'tlv-size', name: 'size', type: 'uint8' }],
                    lengthField: 'size', lengthIncludesHeader: false, lengthUnit: 1, lengthAdjustment: 0,
                    selector: 'tag', branches: [{ id: 'tlv-known', label: 'Known tag', equals: 1,
                        fields: [{ id: 'tlv-value', name: 'value', type: 'uint8' }] },
                    { id: 'tlv-unknown', label: '其它类型 / 保留原始字节', default: true, fields: [] }] }
            ] }] });
    }
    const ProtocolModel = { normalizeIds, findNode, findField, flattenFields, insertField, removeField,
        moveField, reorderBranch, duplicateField, makeStructureIndependent, renameField, inspectReferences,
        getLengthBindings, getLengthTargets, bindLengthTarget, unbindLengthTarget, isLengthSource,
        createHistory, pushHistory, undo, redo, createProtocol, duplicateProtocol, deleteProtocol,
        renameProtocol, reorderProtocol, importProtocol, layoutSummary, getChecksumCoverage, getConstraintCoverage, createTLVTemplate, toUnified };
    if (typeof module !== 'undefined' && module.exports) module.exports = { ProtocolModel };
    root.SerialPlotter = root.SerialPlotter || {};
    root.SerialPlotter.ProtocolModel = ProtocolModel;
})(typeof globalThis !== 'undefined' ? globalThis : this);

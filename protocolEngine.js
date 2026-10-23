/** Generic binary protocols, shared by classic scripts and CommonJS.
 *
 * compile(JSON schema) validates and returns { schema, id, messages, diagnostics }.
 * Schema: {id,endian,framing:{header,footer,fixedLength,length:{offset,type,
 * adjustment,unit},maxLength},headerFields,command:{offset,type},payloadOffset,
 * payloadEnd,checksums,structures,messages}. Negative byte positions count from
 * frame end; all end positions are exclusive. Length field * unit + adjustment
 * gives the whole frame length; unit defaults to 1 and must divide encoded wire
 * length exactly. Checksum ranges exclude their own storage explicitly.
 * Fields: {id,name,type,endian,offset,count,length,encoding,enum,baseType,ref,
 * fields,bits,condition,default}. Offsets are relative to their containing struct.
 * Structures are arrays of fields. count turns any field into an array. bits are
 * named slices {name,offset,length,type:'bool'|'int'|'uint',enum}. Dynamic count,
 * offset, length and condition expressions accept numbers, field paths,
 * FRAME_LENGTH/PAYLOAD_LENGTH/REMAINING, arithmetic, comparisons, bit operators and
 * MIN/MAX/ABS/LEN; LEN uses encoded field byte spans, never element/string counts.
 * No JavaScript is evaluated. Dispatch is {field,offset,name,messages}
 * and recursively selects a child message by its command (or commandRange).
 * reserved fields behave as bytes with zero padding by default; they retain
 * their Uint8Array and byte span and never expose a numeric value.
 * Version 2 adds fixed {bytes,framingRole:'sync'|'end'}, bounded struct {length},
 * choice {selector,branches:[{equals|range|mask|expression|default,fields}]},
 * repeat {count|until:'end',fields,length?}, and configurable tlv
 * {headerFields,lengthField,lengthIncludesHeader,lengthUnit,lengthAdjustment,
 * selector,branches,count|until:'end',invalidItem:'stop'|'skip'} nodes. A TLV
 * length bounds its entire container; the header's lengthField bounds each V.
 * Unknown TLV V is retained in rawPayload. invalidItem defaults to stop; skip
 * requires a validated item end. Segment leftover is preserve (default), exact,
 * or padding with paddingByte. Bounded repeat container tails live in the
 * parent's _segmentTails[nodeName], keeping item arrays JSON serializable.
 * Offsets use offsetBase:'segment' (default) or
 * 'frame'; PARENT/CURRENT paths and PARENT_REMAINING expose explicit scopes.
 * Fixed framing bindings are derived into compiled.framing, never persisted
 * into canonical schema.framing. label is display text; id remains identity.
 * Version 3 uses messages:[oneWholeFrame] and framing:{maxLength} only. Every
 * field declares byteLength; 0 requires lengthSource:{fieldId,unit,adjustment},
 * lengthFrom (safe expression, REMAINING, or contents for containers), or
 * boundary:{startFieldId?,endFieldId} referring to adjacent fixed fields.
 * Root byteLength/lengthSource/lengthFrom bounds the frame; fixed framing roles derive
 * synchronization/end delimiters. type:checksum stores its own 1/2/4 bytes and
 * checksum:{type,...,start,end} accepts field-ID edges or position expressions.
 * Stable legacy message aliases keep existing send/mapping identities during
 * migration; the canonical new structure has no parallel legacy rule sources.
 *
 * decode(bytes,compiled) returns typed fields, flat path->value values, an ARRAY
 * flatFields of {fieldId,path,value,numeric,byteOffset,endByte,bitOffset?,bitLength?},
 * spans, warnings, known, messageId/name, command, header, rawPayload. uint64/int64
 * are always BigInt. numeric is null when precision cannot safely be retained.
 * Unrecognized tail bytes live in fields._unknownTail; unknown messages preserve
 * fields.rawPayload. Warning entries are {code,message,...}. Bad framing or
 * checksums throw ProtocolError. Valid but short known layouts produce warnings.
 * Any incomplete/ambiguous/boundary failure sets valid:false and suppresses all
 * flatFields.numeric outputs. analyze(schema) returns nonthrowing diagnostics;
 * selectBranch(sourceOrCompiledNode,context) shares exact condition semantics.
 * decode's optional third argument {maxFields} sets a hard output field budget.
 * encode(compiled,messageId,fields,{sequence,layout,header}) returns Uint8Array.
 * Conflicted messages require layout:'detail' (or a declared layout name).
 * StreamParser uses DataParser callback signatures and reports each received byte
 * exactly once as a valid frame or discarded/error byte. Source offsets and
 * timestamps follow each frame's first byte, including across appendData blocks.
 * StreamParser options/properties: deferDecode finds validated boundaries and
 * emits a {deferred:true,...} placeholder after framing and static fixed checks.
 * Dynamic layout validity is resolved in the worker; invalid layouts retain
 * their frame bytes. maxDecodedFields bounds live decoded output.
 * createFactorySource() exposes trusted engine code for embedding in a classic
 * Blob worker; user schemas remain data passed through compile's safe parser.
 */
(function createProtocolEngine(root, codecOverride, reservedOverride, symbolsOverride) {
    'use strict';
    const LEN_CONTEXT = Symbol('protocol-wire-length');
    const RULE_LENGTHS = Symbol('constraint-wire-lengths');
    const LENGTH_BOUNDARY = Symbol('expression-length-boundary');
    const LENGTH_CURSOR = Symbol('expression-length-cursor');
    const textCodec = codecOverride || (typeof module !== 'undefined' && module.exports
        ? require('./textCodec') : root.SerialPlotter?.TextCodec);
    const reservedNames = reservedOverride || (typeof module !== 'undefined' && module.exports
        ? require('./reservedNames').ReservedNames : root.SerialPlotter.ReservedNames);
    const protocolSymbols = symbolsOverride || (typeof module !== 'undefined' && module.exports
        ? require('./protocolSymbols').ProtocolSymbols : root.SerialPlotter.ProtocolSymbols);
    const LIMITS = Object.freeze({ frame: 1024 * 1024, fields: 8192, array: 4096,
        depth: 16, expression: 256, messages: 2048 });
    const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
    const legacyEncodingMaps = new Map();
    const compiledProtocols = new WeakSet();
    const TYPES = Object.freeze({ uint8: [1, 'getUint8', 'setUint8'], int8: [1, 'getInt8', 'setInt8'],
        uint16: [2, 'getUint16', 'setUint16'], int16: [2, 'getInt16', 'setInt16'],
        uint32: [4, 'getUint32', 'setUint32'], int32: [4, 'getInt32', 'setInt32'],
        uint64: [8, 'getBigUint64', 'setBigUint64'], int64: [8, 'getBigInt64', 'setBigInt64'],
        float32: [4, 'getFloat32', 'setFloat32'], float64: [8, 'getFloat64', 'setFloat64'],
        bool: [1, 'getUint8', 'setUint8'] });
    class ProtocolError extends Error {
        constructor(code, message, details = {}) { super(message); this.name = 'ProtocolError';
            this.code = code; Object.assign(this, details); }
    }
    function fail(code, message, details = {}) { throw new ProtocolError(code, message, details); }
    function bytesOf(bytes) {
        if (bytes instanceof Uint8Array) return bytes;
        if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
        return Uint8Array.from(bytes || []);
    }
    function encodeBytes(value, path) {
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return bytesOf(value);
        if (!Array.isArray(value) || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255))
            fail('value', `Invalid byte sequence: ${path}`);
        return Uint8Array.from(value);
    }
    function safeName(name) {
        return typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name) && !FORBIDDEN.has(name);
    }
    function lookup(object, path) {
        if (Object.hasOwn(object, path)) return object[path];
        const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
        let current = object;
        for (const part of parts) {
            if (FORBIDDEN.has(part) || current === null || current === undefined ||
                !Object.hasOwn(Object(current), part)) return undefined;
            current = current[part];
        }
        return current;
    }
    const PRECEDENCE = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
        '==': 6, '!=': 6, '===': 6, '!==': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
        '<<': 8, '>>': 8, '>>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
    function expression(source) {
        if (source === undefined || typeof source === 'number' || typeof source === 'boolean') {
            if (typeof source === 'number' && !Number.isFinite(source)) fail('schema', 'Invalid expression number');
            return { literal: source };
        }
        if (typeof source !== 'string' || source.length > LIMITS.expression)
            fail('schema', 'Expression exceeds safe length limit');
        const tokens = [], pattern = /\s*(0x[\da-f]+|(?:\d+(?:\.\d*)?|\.\d+)|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*|>>>|===|!==|<<|>>|<=|>=|==|!=|&&|\|\||[()+\-*/%<>&^|!~,])/igy;
        let position = 0;
        while (position < source.trimEnd().length) {
            pattern.lastIndex = position;
            const match = pattern.exec(source);
            if (!match) fail('schema', `Unsafe expression: ${source}`);
            const token = match[1];
            if (token.split(/[.\[\]]/).some(part => FORBIDDEN.has(part)))
                fail('schema', `Unsafe expression identifier: ${token}`);
            tokens.push(token); position = pattern.lastIndex;
            if (tokens.length > 128) fail('schema', 'Expression token limit exceeded');
        }
        let index = 0, depth = 0;
        function parse(minimum = 0) {
            if (++depth > 32) fail('schema', 'Expression nesting limit exceeded');
            const token = tokens[index++]; let node;
            if (token === '(') { node = parse(); if (tokens[index++] !== ')') fail('schema', 'Unclosed expression'); }
            else if (['+', '-', '!', '~'].includes(token)) node = { op: token, unary: parse(11) };
            else if (/^(?:\d|\.)/.test(token || '')) node = { literal: !token.includes('.') && !Number.isSafeInteger(Number(token)) ? BigInt(token) : Number(token) };
            else if (/^[A-Za-z_$]/.test(token || '')) {
                if (tokens[index] === '(') {
                    if (!reservedNames.protocolFunctions.includes(token)) fail('schema', `Unsafe expression function: ${token}`);
                    index++; const args = [];
                    if (tokens[index] !== ')') { args.push(parse()); while (tokens[index] === ',') { index++; args.push(parse()); } }
                    if (tokens[index++] !== ')' || args.length < 1 || args.length > 8 || token === 'ABS' && args.length !== 1)
                        fail('schema', 'Invalid expression function arguments');
                    if (token === 'LEN' && (args.length !== 1 || !args[0].variable || reservedNames.protocolVariables.includes(args[0].variable)))
                        fail('expression', 'LEN 需要一个字段或数据段路径，例如 LEN(payload)');
                    node = { fn: token, args };
                } else node = { variable: token };
            } else fail('schema', `Invalid expression: ${source}`);
            while (Object.hasOwn(PRECEDENCE, tokens[index]) && PRECEDENCE[tokens[index]] >= minimum) {
                const op = tokens[index++]; node = { op, left: node, right: parse(PRECEDENCE[op] + 1) };
            }
            depth--; return node;
        }
        const tree = parse();
        if (index !== tokens.length) fail('schema', `Invalid expression: ${source}`);
        return tree;
    }
    function evaluate(tree, context) {
        if (Object.hasOwn(tree, 'literal')) return tree.literal;
        if (tree.lengthChoice) {
            const branch = chooseBranch(tree.lengthChoice, context);
            if (!branch) fail('length-reference', 'LEN 的数据段没有匹配的条件分支');
            return evaluate(branch.lengthTree, context);
        }
        if (tree.variable) {
            if (tree.variable === 'TRUE') return true;
            if (tree.variable === 'FALSE') return false;
            const value = lookup(context, tree.variable);
            if (value === undefined) fail('expression', `Unknown expression identifier: ${tree.variable}`);
            if (!['bigint', 'number', 'boolean'].includes(typeof value)) fail('expression', 'Expression requires a scalar');
            return value;
        }
        if (tree.fn === 'LEN') {
            if (!context[LEN_CONTEXT]) fail('length-reference', 'LEN 需要协议字段的实际编码字节范围，不能按数组元素数或字符数推测');
            return context[LEN_CONTEXT](tree.args[0].variable);
        }
        if (tree.fn) { const args = tree.args.map(arg => evaluate(arg, context));
            if (tree.fn === 'ABS') return args[0] < 0 ? -args[0] : args[0];
            return args.reduce((a, b) => tree.fn === 'MIN' ? (a < b ? a : b) : (a > b ? a : b)); }
        if (tree.unary) {
            const value = evaluate(tree.unary, context);
            return tree.op === '-' ? -value : tree.op === '+' ? value : tree.op === '!' ? !value : ~value;
        }
        let a = evaluate(tree.left, context);
        if (tree.op === '&&' && !a || tree.op === '||' && a) return a;
        let b = evaluate(tree.right, context);
        if (['/', '%'].includes(tree.op) && (b === 0 || b === 0n)) fail('expression', 'Division by zero');
        if (typeof a === 'bigint' || typeof b === 'bigint') {
            if (typeof a !== 'bigint' && Number.isSafeInteger(a)) a = BigInt(a);
            if (typeof b !== 'bigint' && Number.isSafeInteger(b)) b = BigInt(b);
            if (typeof a !== typeof b && !['<','>','<=','>=','==','!=','===','!==','&&','||'].includes(tree.op))
                fail('expression', 'Cannot mix an exact integer with a fractional value');
            if (tree.op === '>>>') fail('expression', 'Unsigned shift is undefined for exact integers');
            if (['/','%'].includes(tree.op) && b === 0n) fail('expression', 'Division by zero');
        }
        switch (tree.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return a / b; case '%': return a % b; case '<<': return a << b;
        case '>>': return a >> b; case '>>>': return a >>> b; case '&': return a & b;
        case '|': return a | b; case '^': return a ^ b; case '==': case '===': return a === b;
        case '!=': case '!==': return a !== b; case '<': return a < b; case '>': return a > b;
        case '<=': return a <= b; case '>=': return a >= b; case '&&': return a && b; case '||': return a || b;
        default: fail('expression', 'Unsupported expression operator');
        }
    }
    function bounded(value, maximum, label, minimum = 0) {
        if (typeof value === 'bigint' && value >= BigInt(minimum) && value <= BigInt(maximum)) value = Number(value);
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
            fail('bounds', `${label} is outside the allowed range ${minimum}–${maximum}`);
        return value;
    }
    function lengthScope(lengths, prefix, parent, fields) {
        const names = new Set(fields.map(field => field.name));
        return path => {
            if (path.startsWith('PARENT.')) {
                if (parent) return parent(path.slice(7));
            } else {
                const current = path.startsWith('CURRENT.'), name = current ? path.slice(8) : path;
                const key = prefix ? prefix + '.' + name : name;
                if (lengths.has(key)) return lengths.get(key);
                if (!current && !names.has(name.split(/[.[]/)[0]) && parent) return parent(name);
            }
            fail('length-reference', `LEN(${path}) 的字段尚未读取、未启用或没有确定的字节范围`);
        };
    }
    function little(field, compiled) {
        const order = field.endian ?? compiled.schema.endian ?? 'little';
        return order === 'little' || order === 'le';
    }
    function baseType(field) { return field.type === 'checksum' ? 'uint' + field.byteLength * 8 : field.type === 'enum' ? field.baseType || 'uint8' : field.type; }
    function scalarWidth(field) { return field.type === 'bitfield' ? field.byteLength : TYPES[baseType(field)]?.[0]; }
    function numeric(value) {
        if (typeof value === 'boolean') return Number(value);
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'bigint') { const num = Number(value); return Number.isSafeInteger(num) ? num : null; }
        return null;
    }
    function cloneJSON(source) {
        let json;
        try { json = JSON.stringify(source); } catch { fail('schema', 'Protocol schema must be JSON serializable'); }
        if (!json || json.length > 2 * LIMITS.frame) fail('schema', 'Protocol schema exceeds size limit');
        return JSON.parse(json);
    }
    function compile(input) {
        if (input && typeof input === 'object' && compiledProtocols.has(input)) return input;
        const { schema, renames: symbolRenames } = migrateSymbols(input?._compiledProtocol === true && input.schema ? input.schema : input);
        if (typeof schema.id !== 'string' || !schema.id.trim()) fail('schema', 'Protocol requires a stable id');
        if (!Array.isArray(schema.messages) || !schema.messages.length) fail('schema', 'Protocol requires messages');
        const compiled = { _compiledProtocol: true, schema, id: schema.id, messages: [], diagnostics: [], unified: schema.schemaVersion >= 3,
            usesLengthFunction: /\bLEN\s*\(/.test(JSON.stringify(schema)),
            messageById: new Map(), layoutWrites: [], symbolRenames, maxLength: schema.framing?.maxLength ?? LIMITS.frame, fieldCount: 0 };
        bounded(compiled.maxLength, LIMITS.frame, 'Frame length limit', 1);
        const framing = schema.framing ||= {};
        compiled.framing = { ...framing };
        for (const key of ['header', 'footer']) {
            if (framing[key] !== undefined && (!Array.isArray(framing[key]) || framing[key].length > 64 ||
                framing[key].some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)))
                fail('schema', `Invalid framing ${key}`);
        }

        if (framing.fixedLength) bounded(framing.fixedLength, compiled.maxLength, 'Fixed frame length', 1);
        function validateScalar(field, label) {
            if (!TYPES[field.type] || !/^uint(?:8|16|32)$/.test(field.type)) fail('schema', `Invalid ${label} type`);
            bounded(field.offset, compiled.maxLength, `${label} offset`);
        }
        if (framing.length) { validateScalar(framing.length, 'Length field');
            bounded(framing.length.unit ?? 1, LIMITS.frame, 'Length unit', 1);
            if (!Number.isSafeInteger(framing.length.adjustment ?? 0)) fail('schema', 'Invalid length adjustment'); }
        if (schema.command) validateScalar(schema.command, 'Command field');
        bounded(schema.payloadOffset ?? 0, compiled.maxLength, 'Payload offset');
        if (schema.payloadEnd !== undefined && (!Number.isSafeInteger(schema.payloadEnd) ||
            Math.abs(schema.payloadEnd) > compiled.maxLength)) fail('schema', 'Invalid payload end');
        if (schema.endian && !['little', 'big', 'le', 'be'].includes(schema.endian)) fail('schema', 'Invalid protocol endian');
        // Save generated identities in canonical JSON so later label/name edits
        // retain mappings. Reusable structure leaves gain an instance prefix.
        const identities = new Set();
        function identity(value, fallback) {
            const id = value || fallback;
            if (typeof id !== 'string' || !id || id.length > 512 || identities.has(id))
                fail('schema', `Invalid or duplicate stable id: ${id}`);
            identities.add(id); return id;
        }
        function stampFields(fields, scope, depth = 0, metadata = false) {
            if (!Array.isArray(fields) || depth > LIMITS.depth) fail('schema', 'Invalid fields or structure nesting limit');
            for (const source of fields) {
                if (!source || typeof source !== 'object') fail('schema', 'Invalid field definition');
                source.id = identity(source.id, `${scope}.${source.name}`);
                const conflict = reservedNames.error(source.name, 'field');
                if (conflict && !(metadata && source.name === 'rawPayload' && source.type === 'bytes')) fail('reserved-name', conflict, { nodeId: source.id });
                if (source.bits) {
                    if (!Array.isArray(source.bits)) fail('schema', 'Invalid bit fields');
                    for (const bit of source.bits) {
                        bit.id = identity(bit.id, `${source.id}.${bit.name}`);
                        const conflict = reservedNames.error(bit.name, 'field');
                        if (conflict) fail('reserved-name', conflict, { nodeId: bit.id });
                    }
                }
                if (source.fields) stampFields(source.fields, source.id, depth + 1);
                if (source.headerFields) stampFields(source.headerFields, `${source.id}.header`, depth + 1);
                if (source.branches) {
                    if (!Array.isArray(source.branches)) fail('schema', 'Invalid branches', { nodeId: source.id });
                    source.branches.forEach((branch, i) => { branch.id = identity(branch.id, `${source.id}.branch${i}`);
                        stampFields(branch.fields || [], branch.id, depth + 1, !!branch.legacyUnknown); });
                }
            }
        }
        function stampMessages(messages, scope, depth = 0) {
            if (!Array.isArray(messages) || depth > LIMITS.depth) fail('schema', 'Invalid nested messages');
            for (const message of messages) {
                message.id = identity(message.id, `${scope}.${message.command}`);
                stampFields(message.fields || [], message.id);
                if (message.dispatch) stampMessages(message.dispatch.messages, message.id, depth + 1);
            }
        }
        stampFields(schema.headerFields || [], `${schema.id}.header`);
        for (const [name, fields] of Object.entries(schema.structures || {})) {
            if (!safeName(name)) fail('schema', 'Invalid structure name');
            stampFields(fields, `${schema.id}.structures.${name}`);
        }
        stampMessages(schema.messages, schema.id);
        function fieldsOf(fields, scope, stack = [], instancePrefix = '', inheritedEndian = schema.endian, metadata = false, instanceReferences = new Map()) {
            if (!Array.isArray(fields)) fail('schema', `Fields must be an array: ${scope}`);
            if (stack.length > LIMITS.depth) fail('schema', 'Structure nesting limit exceeded');
            const names = new Set();
            return fields.map(source => {
                if (++compiled.fieldCount > LIMITS.fields) fail('schema', 'Field count limit exceeded');
                if (!safeName(source.name) || names.has(source.name)) fail('schema', `Invalid or duplicate field name: ${source.name}`);
                const conflict = reservedNames.error(source.name, 'field');
                if (conflict && !(metadata && source.name === 'rawPayload' && source.type === 'bytes')) fail('reserved-name', conflict, { nodeId: source.id });
                names.add(source.name);
                try {
                const field = { ...source, endian: source.endian ?? inheritedEndian, id: `${instancePrefix}${source.id}`, expressions: {} };
                if (source.lengthSource) field.lengthSource = { ...source.lengthSource,
                    fieldId: instanceReferences.get(source.lengthSource.fieldId) ?? source.lengthSource.fieldId };
                if (!TYPES[baseType(field)] && !['bytes', 'reserved', 'string', 'struct', 'choice', 'repeat', 'tlv', 'fixed', 'bitfield'].includes(field.type))
                    fail('schema', `Unsupported field type: ${field.type}`);
                if (field.type === 'bitfield') bounded(field.byteLength, compiled.maxLength, 'Bit group byte length', 1);
                if (field.valueSource !== undefined && (field.valueSource !== 'SEQ' || !/^uint(?:8|16|32)$/.test(baseType(field)) || field.count !== undefined))
                    fail('schema', 'Sequence valueSource requires SEQ and an unsigned scalar', { nodeId: field.id });
                if (field.endian && !['little', 'big', 'le', 'be'].includes(field.endian)) fail('schema', 'Invalid field endian');
                for (const prop of ['offset', 'count', 'length', 'condition']) if (field[prop] !== undefined)
                    field.expressions[prop] = expression(field[prop]);
                if (typeof field.count === 'number') bounded(field.count, LIMITS.array, 'Array count');
                for (const prop of ['offset', 'length']) if (typeof field[prop] === 'number') bounded(field[prop], compiled.maxLength, `Field ${prop}`);
                if (field.ref) {
                    if (stack.includes(field.ref)) fail('schema', `Cyclic structure reference: ${field.ref}`);
                    if (!Object.hasOwn(schema.structures || {}, field.ref)) fail('schema', `Unknown structure: ${field.ref}`);
                    const references = new Map(instanceReferences), prefix = `${field.id}/`;
                    const register = fields => {
                        for (const item of fields || []) {
                            references.set(item.id, prefix + item.id);
                            register(item.fields); register(item.headerFields);
                            for (const branch of item.branches || []) register(branch.fields);
                        }
                    };
                    register(schema.structures[field.ref]);
                    field.fields = fieldsOf(schema.structures[field.ref], field.id, [...stack, field.ref], prefix, field.endian, false, references);
                } else if (['struct', 'repeat'].includes(field.type)) field.fields = fieldsOf(field.fields || [], field.id, [...stack, field.id], instancePrefix, field.endian, false, instanceReferences);
                if (field.leftover && !['preserve','exact','padding'].includes(field.leftover)) fail('schema', 'Invalid leftover policy', { nodeId: field.id });
                if (field.paddingByte !== undefined) bounded(field.paddingByte, 255, 'Padding byte');
                if (field.invalidItem && !['stop','skip'].includes(field.invalidItem)) fail('schema', 'Invalid TLV item failure policy', { nodeId: field.id });
                if (field.offsetBase && !['segment', 'frame'].includes(field.offsetBase)) fail('schema', 'Invalid offset base', { nodeId: field.id });
                if (field.type === 'fixed') {
                    field.bytes = Array.from(encodeBytes(field.bytes, field.name));
                    if (!field.bytes.length) fail('schema', 'Fixed bytes must not be empty', { nodeId: field.id });
                }
                if (field.expectedBytes) field.expectedBytes = Array.from(encodeBytes(field.expectedBytes, field.name));
                if (field.displayBase !== undefined && !['dec','hex'].includes(field.displayBase))
                    fail('schema', 'Number base must be dec or hex', { nodeId: field.id });
                if (field.displayBase === undefined && (['fixed','bytes','reserved'].includes(field.type) || field.expectedBytes)) field.displayBase = 'hex';
                if (field.selector !== undefined) field.selectorExpression = expression(field.selector);
                if (['choice', 'tlv'].includes(field.type)) {
                    field.branches = (field.branches || []).map(branch => ({ ...branch,
                        fields: fieldsOf(branch.fields || [], branch.id, [...stack, field.id], instancePrefix, field.endian, !!branch.legacyUnknown, instanceReferences),
                        expressionTree: branch.expression === undefined ? null : expression(branch.expression) }));
                    validateBranches(field, compiled);
                }
                if (field.type === 'tlv') {
                    field.headerFields = fieldsOf(field.headerFields || [], `${field.id}.header`, [...stack, field.id], instancePrefix, field.endian, false, instanceReferences);
                    if (!safeName(field.lengthField) || !field.headerFields.some(item => item.name === field.lengthField && /^uint(8|16|32)$/.test(baseType(item))))
                        fail('schema', 'TLV lengthField must reference an unsigned header scalar', { nodeId: field.id });
                    bounded(field.lengthUnit ?? 1, LIMITS.frame, 'TLV length unit', 1);
                    if (!Number.isSafeInteger(field.lengthAdjustment ?? 0)) fail('schema', 'Invalid TLV adjustment', { nodeId: field.id });
                }
                if (['repeat', 'tlv'].includes(field.type)) {
                    if (field.until !== undefined && field.until !== 'end' || field.count !== undefined && field.until !== undefined)
                        fail('schema', 'Repeat requires either count or until:end', { nodeId: field.id });
                    if (field.count === undefined && field.until !== 'end') fail('schema', 'Repeat requires a count or until:end', { nodeId: field.id });
                    if (minimumSize(field.type === 'tlv' ? field.headerFields : field.fields) === 0)
                        fail('progress', 'Repeated item must make positive byte progress', { nodeId: field.id });
                }
                if (field.type === 'string' && textCodec) textCodec.normalizeTextEncoding(field.encoding || 'utf-8');
                if (field.bits) {
                    if (!Array.isArray(field.bits) || field.type !== 'bitfield' && !/^u?int(?:8|16|32|64)$/.test(baseType(field))) fail('schema', 'Bit slices require an integer field');
                    const bits = new Set(), ranges = [], totalBits = scalarWidth(field) * 8;
                    field.bits = field.bits.map(bit => {
                        if (!safeName(bit.name) || bits.has(bit.name)) fail('schema', 'Invalid or duplicate bit field name');
                        const conflict = reservedNames.error(bit.name, 'field');
                        if (conflict) fail('reserved-name', conflict, { nodeId: bit.id });
                        bits.add(bit.name); bounded(bit.offset, totalBits - 1, 'Bit offset');
                        bounded(bit.length, totalBits - bit.offset, 'Bit length', 1);
                        if (bit.type !== undefined && !['uint', 'int', 'bool', 'reserved'].includes(bit.type)) fail('schema', 'Invalid bit value type');
                        if (field.type === 'bitfield') {
                            if (bit.type === 'bool' && bit.length !== 1) fail('schema', 'Boolean bit slices require exactly one bit');
                            if (ranges.some(range => bit.offset < range.end && bit.offset + bit.length > range.start))
                                fail('overlap', 'Bit slices overlap', { nodeId: bit.id });
                            ranges.push({ start: bit.offset, end: bit.offset + bit.length });
                        }
                        return { ...bit, id: `${instancePrefix}${bit.id}` };
                    });
                }
                return field;
                } catch (error) { if (error instanceof ProtocolError) error.nodeId ??= source.id; throw error; }
            });
        }
        function messagesOf(messages, scope, depth = 0) {
            if (depth > LIMITS.depth || !Array.isArray(messages)) fail('schema', 'Invalid message dispatch');
            const commands = new Set();
            return messages.map(source => {
                if (compiled.messages.length >= LIMITS.messages) fail('schema', 'Message count limit exceeded');
                const id = source.id || `${scope}.${source.command}`;
                if (typeof id !== 'string' || compiled.messageById.has(id)) fail('schema', `Invalid or duplicate message id: ${id}`);
                if (source.command !== undefined && (!Number.isSafeInteger(source.command) || source.command < 0)) fail('schema', 'Invalid message command');
                const key = `${source.command}:${source.length ?? '*'}`;
                if (source.command !== undefined && commands.has(key)) fail('schema', `Ambiguous message command: ${source.command}`);
                commands.add(key);
                const message = { ...source, id, name: source.name || id, fields: fieldsOf(source.fields || [], id) };
                if (source.length !== undefined) bounded(source.length, compiled.maxLength, 'Message length');
                if (source.maxLength !== undefined) bounded(source.maxLength, compiled.maxLength, 'Message payload limit');
                compiled.messages.push(message); compiled.messageById.set(id, message);
                if (source.dispatch) {
                    const dispatch = source.dispatch;
                    if (!safeName(dispatch.name || 'content') || typeof dispatch.field !== 'string') fail('schema', 'Invalid nested dispatch');
                    const conflict = reservedNames.error(dispatch.name || 'content', 'field');
                    if (conflict) fail('reserved-name', conflict, { nodeId: message.id });
                    message.dispatch = { ...dispatch, offsetExpression: expression(dispatch.offset ?? 0),
                        messages: messagesOf(dispatch.messages, id, depth + 1) };
                    for (const child of message.dispatch.messages) child.parent = message;
                }
                return message;
            });
        }
        compiled.rootMessages = messagesOf(schema.messages, schema.id);
        compiled.headerFields = fieldsOf(schema.headerFields || [], `${schema.id}.header`);
        if (compiled.unified) prepareUnifiedFields(compiled);
        validateLengthRoles(compiled);
        compiled.checksums = (schema.checksums || []).map((source, index) => {
            const config = { ...source, type: source.type || 'crc',
                width: source.width ?? (Number(String(source.type).replace('crc', '')) || 8),
                id: source.id || `checksum${index}` };
            if (!['crc', 'crc8', 'crc16', 'crc32', 'sum', 'xor'].includes(config.type)) fail('schema', 'Unsupported checksum');
            if (!['8', '16', '32'].includes(String(config.width))) fail('schema', 'Checksum width must be 8, 16 or 32');
            if (config.type.startsWith('crc') && config.polynomial === undefined) fail('schema', 'CRC requires a polynomial');
            for (const prop of ['polynomial', 'init', 'xorOut']) if (config[prop] !== undefined &&
                (!Number.isSafeInteger(config[prop]) || config[prop] < 0 || config[prop] >= 2 ** config.width))
                fail('schema', `Invalid checksum ${prop}`);
            for (const prop of ['start', 'end', 'offset']) config[`${prop}Expression`] = expression(config[prop] ?? (prop === 'start' ? 0 : -config.width / 8));
            return config;
        });
        {
            const builtins = new Set(reservedNames.protocolVariables);
            validateFields(compiled.headerFields, builtins, compiled, 0);
            const validateMessages = (messages, inherited) => {
                for (const message of messages) {
                    validateFields(message.fields, inherited, compiled, schema.payloadOffset || 0);
                    if (message.dispatch) validateMessages(message.dispatch.messages, new Set([...inherited, ...message.fields.map(field => field.name)]));
                }
            };
            validateMessages(compiled.rootMessages, new Set([...builtins, ...compiled.headerFields.map(f => f.name)]));
        }
        if (compiled.unified) bindUnifiedFraming(compiled);
        else { bindFraming(compiled); validateAutoWriters(compiled); }
        if (!compiled.unified && !compiled.framing.fixedLength && !compiled.framing.length && !compiled.framing.footer?.length) fail('schema', 'Framing requires fixedLength, length, or footer');
        compileRules(compiled);
        compileLengthRelations(compiled);
        if (compiled.unified) checkStructuralBoundaries(compiled);
        const prepareScan = fields => { for (const field of fields) {
            field.scanWidth = scalarWidth(field);
            if (field.endBytes) field.endTable = delimiterTable(field.endBytes);
            const trees = [...Object.values(field.expressions), field.selectorExpression,
                ...Object.entries(field.checksumConfig ?? {}).filter(([key]) => key.endsWith('Expression')).map(([, value]) => value),
                ...(field.branches ?? []).map(branch => branch.expressionTree)];
            if (!field.expressionBoundaryScope && trees.some(tree => variables(tree).some(name => /\b(?:FRAME_LENGTH|PAYLOAD_LENGTH|REMAINING|PARENT_REMAINING)\b/.test(name)))) compiled.streamFrameContext = true;
            if (field.fields) prepareScan(field.fields);
            if (field.headerFields) prepareScan(field.headerFields);
            for (const branch of field.branches ?? []) prepareScan(branch.fields);
        } };
        for (const message of compiled.rootMessages) prepareScan(message.fields);
        compiled.footerTable = delimiterTable(compiled.framing.footer ?? []);
        compiled.streamPreChecks = [...compiled.checksums, ...(compiled.preChecksums ?? [])].filter(config =>
            [config.start, config.end, config.offset].every(value => Number.isInteger(value) && value >= 0));
        compiledProtocols.add(compiled); return compiled;
    }
    // Validation constraints do not define byte boundaries unless an explicit
    // length-value fallback is enabled. Wire spans provide LEN/checksum ranges.
    function compileRules(compiled) {
        const sources = compiled.schema.rules ?? [];
        if (!Array.isArray(sources) || sources.length > 512) fail('rules', '规则数量不能超过 512');
        if (sources.length && !compiled.unified) fail('rules', '规则约束需要整帧字段结构');
        const ids = new Set(), entries = compiled.fieldEntries ?? new Map();
        const paths = new Map();
        const collectPaths = (fields, prefix = '') => { for (const field of fields) {
            const path = prefix + field.name; paths.set(path, field);
            for (const bit of field.bits ?? []) if (bit.type !== 'reserved') paths.set(path + '.' + bit.name, { ...bit, type: bit.type ?? 'uint', id: field.id });
            const childPrefix = field.inline ? prefix : path + '.';
            if (field.fields) collectPaths(field.fields, childPrefix);
            if (field.headerFields) collectPaths(field.headerFields, childPrefix);
            for (const branch of field.branches ?? []) collectPaths(branch.fields, childPrefix);
        } };
        if (sources.length) collectPaths(compiled.rootMessages[0].fields);
        const checkTree = tree => {
            const inspect = (node, lengthArgument = false) => {
                if (!node) return;
                const name = node.variable;
                if (name) {
                if (['TRUE', 'FALSE', 'FRAME_LENGTH', 'PAYLOAD_LENGTH', 'SEQ', 'SEQUENCE', 'REMAINING'].includes(name)) return;
                const path = name.replace(/^CURRENT\./, '').replace(/\[\d+\]/g, '');
                if (!paths.has(path)) fail('rule-reference', `规则引用不存在的字段：${name}`);
                const field = paths.get(path);
                if (!lengthArgument && !/^(?:u?int\d*|float\d+|bool|enum|bitfield|checksum)$/.test(field.type))
                    fail('rule-reference', `规则数值表达式需要标量；数据段长度请使用 LEN(${name})`);
                }
                for (const child of [node.left, node.right, node.unary, ...(node.args ?? [])]) inspect(child, node.fn === 'LEN');
            };
            inspect(tree);
        };
        const compileRule = source => {
            const rule = { stage: 'validation', strength: 'weak', send: 'verify', enabled: true, ...source };
            if (typeof rule.id !== 'string' || !rule.id || ids.has(rule.id) || entries.has(rule.id) || rule.id === compiled.id || compiled.messageById.has(rule.id)) fail('rules', '规则 ID 缺失或重复');
            if (typeof rule.enabled !== 'boolean') fail('rules', '规则启用状态必须是布尔值');
            ids.add(rule.id);
            if (!['parsing', 'validation', 'both'].includes(rule.stage)) fail('rules', '规则参与阶段无效');
            if (!['strong', 'weak'].includes(rule.strength) || !['verify', 'fill'].includes(rule.send)) fail('rules', '规则强度或发送行为无效');
            if (!['assert', 'length', 'checksum'].includes(rule.type)) fail('rules', '规则类型无效');
            if (rule.enabled === false) return rule;
            const tree = (text, label) => { if (text === undefined || text === '') fail('rules', `${label}不能为空`);
                const result = expression(text); checkTree(result); return result; };
            if (rule.condition !== undefined && rule.condition !== '') rule.conditionTree = tree(rule.condition, '规则启用条件');
            if (rule.type !== 'checksum') rule.tree = tree(rule.expression, '验证表达式');
            if (rule.targetFieldId) {
                rule.target = entries.get(rule.targetFieldId)?.field;
                if (!rule.target || !/^u?int(?:8|16|32|64)$/.test(baseType(rule.target)) || rule.target.count !== undefined)
                    fail('rule-reference', '回填／校验值字段必须是单个整数字段');
            }
            if (rule.boundaryFallback !== undefined) {
                if (typeof rule.boundaryFallback !== 'boolean' || rule.type !== 'length' || !rule.target)
                    fail('rules', '长度值表达式需要整数字段及明确的用途');
                rule.valueTree = tree(rule.value, '本字段的值表达式');
                const path = entries.get(rule.targetFieldId).path;
                rule.tree = expression(`${path} == (${rule.value})`);
            }
            if (rule.type === 'checksum') {
                if (!rule.target || !/^uint(?:8|16|32)$/.test(baseType(rule.target))) fail('rules', '校验值字段必须为 1、2 或 4 字节无符号整数');
                rule.config = { type: 'sum', ...rule.checksum, width: scalarWidth(rule.target) * 8 };
                if (!['crc', 'crc8', 'crc16', 'crc32', 'sum', 'xor'].includes(rule.config.type)) fail('rules', '校验算法无效');
                if (/^crc\d+$/.test(rule.config.type) && Number(rule.config.type.slice(3)) !== rule.config.width) fail('rules', 'CRC 位数必须与校验值字段宽度一致');
                if (rule.config.type.startsWith('crc') && !Number.isSafeInteger(rule.config.polynomial)) fail('rules', 'CRC 需要多项式');
                for (const key of ['polynomial', 'init', 'xorOut']) if (rule.config[key] !== undefined &&
                    (!Number.isSafeInteger(rule.config[key]) || rule.config[key] < 0 || rule.config[key] >= 2 ** rule.config.width)) fail('rules', `校验参数 ${key} 超出存储范围`);
                for (const key of ['start', 'end']) {
                    const value = rule.config[key] ?? (key === 'start' ? 0 : { fieldId: rule.targetFieldId, edge: 'start' });
                    rule.config[key] = value;
                    if (value && typeof value === 'object') {
                        if (!entries.has(value.fieldId) || !['start', 'end'].includes(value.edge)) fail('rule-reference', '校验范围字段引用无效');
                    } else rule.config[key + 'Tree'] = tree(value, '校验范围');
                }
            }
            if (rule.send === 'fill') {
                if (!rule.target) fail('rules', '自动回填需要指定字段');
                if (rule.target.type === 'checksum' || rule.target.autoLengthTargets?.length || rule.target.autoFrameLength || rule.target.valueSource)
                    fail('rule-writer', '回填字段已由现有解析／校验规则自动写入');
                if (rule.target.expectedBytes || [...entries.values()].some(({ field }) =>
                    [...Object.values(field.expressions), field.selectorExpression, ...(field.branches ?? []).map(branch => branch.expressionTree)]
                        .some(tree => ruleValueVariables(tree).some(name => name.split('.').at(-1) === rule.target.name))))
                    fail('rule-writer', '回填字段参与解析路径或字节边界，请保留解析长度绑定或显式输入其值');
                if (rule.type !== 'checksum') rule.valueTree = tree(rule.value, '回填表达式');
            }
            rule.references = [...new Set([rule.tree, rule.valueTree, rule.conditionTree,
                rule.config?.startTree, rule.config?.endTree].flatMap(item => variables(item)))];
            return rule;
        };
        compiled.rules = sources.map(source => {
            try { return compileRule(source); }
            catch (error) { if (error instanceof ProtocolError) error.nodeId ??= source?.id; throw error; }
        });
        const writers = new Map();
        for (const rule of compiled.rules) if (rule.enabled !== false && rule.send === 'fill') {
            if (writers.has(rule.targetFieldId)) fail('rule-writer', '多个规则回填同一字段');
            writers.set(rule.targetFieldId, rule);
        }
        // Value dependencies are ordered before consumers. Checksum byte coverage
        // dependencies are added against actual spans when sending variable frames.
        const ordered = [], visiting = new Set(), visited = new Set();
        const visit = rule => {
            if (visiting.has(rule)) fail('rule-cycle', '自动回填存在循环依赖');
            if (visited.has(rule)) return;
            visiting.add(rule);
            for (const name of ruleValueVariables(rule.valueTree)) {
                const field = paths.get(name.replace(/^CURRENT\./, '').replace(/\[\d+\]/g, ''));
                const owner = writers.get(field?.id); if (owner) visit(owner);
            }
            visiting.delete(rule); visited.add(rule); ordered.push(rule);
        };
        for (const rule of writers.values()) visit(rule);
        compiled.ruleWriters = ordered;
        const staticSpans = compiled.ruleStaticSpans ?? [];
        const staticContext = Object.create(null);
        if (compiled.framing.fixedLength) staticContext.FRAME_LENGTH = staticContext.PAYLOAD_LENGTH = compiled.framing.fixedLength;
        const ranges = new Map(), staticWriters = ordered.filter(rule => staticSpans.some(span => span.fieldId === rule.targetFieldId));
        for (const rule of compiled.rules) if (rule.enabled !== false && rule.type === 'checksum') {
            try {
                const range = ruleChecksumRange(rule, staticSpans, { length: compiled.framing.fixedLength ?? compiled.maxLength }, staticContext);
                if (rule.send === 'fill' && range.start < range.target.endByte && range.end > range.target.byteOffset)
                    fail('rule-writer', '校验回填范围包含自身存储');
                ranges.set(rule, range);
            } catch (error) {
                if (!['expression', 'rule-unavailable', 'length-reference'].includes(error.code)) throw error;
                compiled.diagnostics.push({ severity: 'warning', code: 'rule-dynamic-range', nodeId: rule.id,
                    message: '动态校验覆盖范围与回填依赖将在样例编码时检查' });
            }
        }
        const marked = new Set(), visitingChecks = new Set();
        const orderCheck = rule => {
            if (visitingChecks.has(rule)) fail('rule-cycle', '校验自动回填存在循环依赖');
            if (marked.has(rule)) return;
            visitingChecks.add(rule);
            const range = ranges.get(rule);
            for (const other of staticWriters) if (other !== rule) {
                const span = staticSpans.find(span => span.fieldId === other.targetFieldId);
                if (range && span.byteOffset < range.end && span.endByte > range.start ||
                    ruleValueVariables(rule.valueTree).some(name => ruleReadsStorage(name, span.path))) orderCheck(other);
            }
            visitingChecks.delete(rule); marked.add(rule);
        };
        for (const rule of staticWriters) orderCheck(rule);
    }
    function ruleValueVariables(tree) {
        if (!tree || tree.fn === 'LEN') return [];
        if (tree.variable) return [tree.variable];
        return [tree.left, tree.right, tree.unary, ...(tree.args ?? [])].flatMap(ruleValueVariables);
    }
    function ruleReadsStorage(name, path) {
        name = name.replace(/^CURRENT\./, '');
        return name === path || name.startsWith(path + '.');
    }
    function ruleContext(bytes, spans, compiled, complete = true, cache = null) {
        const values = cache?.values ?? Object.create(null), lengths = spans[RULE_LENGTHS] ?? cache?.lengths ?? new Map();
        const put = (path, value) => { values[path] = value; values['CURRENT.' + path] = value; };
        for (let spanIndex = cache?.spanCount ?? 0; spanIndex < spans.length; spanIndex++) {
            const span = spans[spanIndex];
            lengths.set(span.path, span.endByte - span.byteOffset);
            const width = scalarWidth(span.field), repeated = span.field.count !== undefined;
            if (width) for (let index = 0; index < (repeated ? (span.endByte - span.byteOffset) / width : 1); index++) {
                const path = span.path + (repeated ? `[${index}]` : '');
                const value = scalarRead(bytes, span.field, span.byteOffset + index * width, compiled);
                put(path, value); lengths.set(path, width);
                for (const bit of span.field.bits ?? []) if (bit.type !== 'reserved') {
                    let sliced = BigInt(value) >> BigInt(bit.offset) & (1n << BigInt(bit.length)) - 1n;
                    if (bit.type === 'int' && sliced & 1n << BigInt(bit.length - 1)) sliced -= 1n << BigInt(bit.length);
                    put(path + '.' + bit.name, bit.type === 'bool' ? sliced !== 0n : bit.length <= 53 ? Number(sliced) : sliced);
                    lengths.set(path + '.' + bit.name, Math.ceil((bit.offset % 8 + bit.length) / 8));
                }
                if (span.field.valueSource === 'SEQ') values.SEQ = values.SEQUENCE = value;
            }
        }
        if (complete) { values.FRAME_LENGTH = values.PAYLOAD_LENGTH = bytes.length; values.REMAINING = 0; values.SEQ ??= 0; values.SEQUENCE ??= 0; }
        values[LEN_CONTEXT] = path => {
            const value = lengths.get(path.replace(/^CURRENT\./, ''));
            if (value === undefined) fail('rule-unavailable', `LEN(${path}) 对应字段尚未读取或未启用`);
            return value;
        };
        if (cache) Object.assign(cache, { values, lengths, spanCount: spans.length });
        return values;
    }
    function ruleChecksumRange(rule, spans, bytes, context, instance = null) {
        const target = spans.filter(span => span.fieldId === rule.targetFieldId);
        if (!target.length) fail('rule-unavailable', '校验值字段尚未读取或未启用');
        const selected = instance ?? (target.length === 1 ? target[0] : null);
        if (!selected) fail('rule-reference', '校验值字段有多个实例');
        const scope = selected.path.slice(0, -selected.field.name.length);
        const resolve = key => {
            const ref = rule.config[key];
            if (ref && typeof ref === 'object') {
                const matches = spans.filter(span => span.fieldId === ref.fieldId);
                if (!matches.length) fail('rule-unavailable', '校验范围尚未读取或未启用');
                const local = matches.filter(span => span.path.startsWith(scope));
                const match = local.length === 1 ? local[0] : matches.length === 1 ? matches[0] : null;
                if (!match) fail('rule-reference', '校验范围存在多个实例且无法确定所属段');
                return ref.edge === 'end' ? match.endByte : match.byteOffset;
            }
            return position(rule.config[key + 'Tree'], context, bytes.length);
        };
        const start = resolve('start'), end = resolve('end');
        if (start < 0 || start > end || end > bytes.length) fail('rule-range', '校验覆盖范围超出已读取字节');
        return { start, end, target: selected };
    }
    function evaluateRules(bytes, compiled, spans, stage, { partial = false, done = new Set(), contextCache = null } = {}) {
        const results = [], context = ruleContext(bytes, spans, compiled, !partial, contextCache);
        for (const rule of compiled.rules ?? []) {
            if (done.has(rule.id) || rule.stage !== stage && rule.stage !== 'both') continue;
            const result = { ruleId: rule.id, name: rule.name || rule.id, stage, strength: rule.strength, status: 'not-run' };
            if (rule.enabled === false) { result.message = '规则已禁用'; results.push(result); continue; }
            try {
                if (rule.conditionTree && !evaluate(rule.conditionTree, context)) { result.message = '启用条件不满足'; results.push(result); done.add(rule.id); continue; }
                let passed;
                if (rule.type === 'checksum') {
                    const instances = spans.filter(span => span.fieldId === rule.targetFieldId);
                    if (!instances.length) fail('rule-unavailable', '校验值字段尚未读取或未启用');
                    for (const instance of instances) {
                        const key = rule.id + ':' + instance.path;
                        if (partial && done.has(key)) continue;
                        const range = ruleChecksumRange(rule, spans, bytes, context, instance);
                        const actual = scalarRead(bytes, rule.target, range.target.byteOffset, compiled);
                        const expected = checksum(bytes.subarray(range.start, range.end), rule.config), ok = actual === expected;
                        results.push({ ...result, actual, expected, path: instance.path, status: ok ? 'passed' : 'failed',
                            message: ok ? '通过' : `规则“${result.name}”验证失败：${instance.path}` });
                        done.add(key);
                    }
                    // Repeated fields can produce more instances on the next block.
                    continue;
                } else {
                    passed = Boolean(evaluate(rule.tree, context));
                    if (rule.tree.left && rule.tree.right) {
                        result.actual = evaluate(rule.tree.left, context); result.expected = evaluate(rule.tree.right, context);
                    }
                }
                result.status = passed ? 'passed' : 'failed';
                result.message = passed ? '通过' : `规则“${result.name}”验证失败`;
                done.add(rule.id);
            } catch (error) {
                if (!(error instanceof ProtocolError)) throw error;
                if (partial && ['rule-unavailable', 'expression'].includes(error.code)) continue;
                result.status = 'not-run'; result.message = error.message;
                result.unavailable = true;
            }
            results.push(result);
        }
        return results;
    }
    function applyRuleResults(record, results) {
        record.ruleResults = results;
        for (const result of results) if (result.status === 'failed' || result.unavailable) {
            if (result.strength === 'strong') record.valid = false;
            record.warnings.push({ code: 'rule', severity: result.strength === 'strong' ? 'error' : 'warning',
                ruleId: result.ruleId, stage: result.stage, message: result.message, actual: result.actual, expected: result.expected });
        }
    }
    function fillRuleWrites(bytes, compiled, spans) {
        const layout = scanUnifiedFrame(bytes, compiled, bytes.length);
        const nodes = compiled.ruleWriters.flatMap(rule => {
            const matches = spans.filter(span => span.fieldId === rule.targetFieldId);
            if (!matches.length) {
                if (rule.conditionTree && !evaluate(rule.conditionTree, ruleContext(bytes, spans, compiled))) return [];
                fail('rule-reference', '回填字段缺失或未启用');
            }
            return matches.map(target => ({ rule, target }));
        });
        for (const check of fieldChecksumRanges(compiled, layout.spans, bytes.length))
            nodes.push({ check, target: { field: check.field, fieldId: check.fieldId, path: check.path,
                byteOffset: check.offset, endByte: check.offset + check.config.width / 8 } });
        for (let i = 0; i < nodes.length; i++) for (let j = 0; j < i; j++)
            if (nodes[i].target.byteOffset < nodes[j].target.endByte && nodes[i].target.endByte > nodes[j].target.byteOffset)
                fail('rule-writer', '自动回填存储区域重叠');
        const pending = new Set(nodes), completed = new Set();
        while (pending.size) {
            let progressed = false;
            for (const node of pending) {
                const { rule, target } = node, context = ruleContext(bytes, spans, compiled);
                const valueDependencies = [rule?.valueTree, rule?.conditionTree, rule?.config?.startTree, rule?.config?.endTree].flatMap(ruleValueVariables);
                if (node.check) {
                    const scope = target.path.split('.').slice(0, -1);
                    for (let name of [node.check.config.startExpression, node.check.config.endExpression].flatMap(ruleValueVariables)) {
                        const parts = [...scope];
                        while (name.startsWith('PARENT.')) { parts.pop(); name = name.slice(7); }
                        const explicit = name.startsWith('CURRENT.'); name = name.replace(/^CURRENT\./, '');
                        // Legacy local contexts inherit enclosing values unless CURRENT is explicit.
                        do { valueDependencies.push([...parts, name].join('.')); } while (!explicit && parts.length && parts.pop() !== undefined);
                    }
                }
                if (nodes.some(other => other !== node && !completed.has(other) && valueDependencies.some(name =>
                    ruleReadsStorage(name, other.target.path)))) continue;
                if (rule?.conditionTree && !evaluate(rule.conditionTree, context)) {
                    completed.add(node); pending.delete(node); progressed = true; continue;
                }
                const range = node.check ? fieldChecksumRanges(compiled, scanUnifiedFrame(bytes, compiled, bytes.length).spans, bytes.length)
                    .find(check => check.fieldId === target.fieldId && check.path === target.path)
                    : (rule.type === 'checksum' ? ruleChecksumRange(rule, spans, bytes, context, target) : null);
                if (range && range.start < target.endByte && range.end > target.byteOffset) fail('rule-writer', '校验回填范围包含自身存储');
                if (range && nodes.some(other => other !== node && !completed.has(other) &&
                    other.target.byteOffset < range.end && other.target.endByte > range.start)) continue;
                const value = range ? checksum(bytes.subarray(range.start, range.end), node.check?.config ?? rule.config) : evaluate(rule.valueTree, context);
                scalarWrite(bytes, target.field, target.byteOffset, value, compiled);
                completed.add(node); pending.delete(node); progressed = true;
            }
            if (!progressed) fail('rule-cycle', '自动回填存在循环依赖');
        }
    }
    function migrateSymbols(input) {
        const schema = cloneJSON(input);
        try { return protocolSymbols.migrate(schema); }
        catch (error) { fail('symbol-migration', error.message); }
    }
    function validLengthSource(field) {
        return /^uint(?:8|16|32)$/.test(baseType(field)) && field.count === undefined && !field.expectedBytes;
    }
    function validateLengthRoles(compiled) {
        const fields = [], referenced = new Set();
        function collect(list) {
            for (const field of list || []) {
                fields.push(field);
                if (field.lengthSource) referenced.add(field.lengthSource.fieldId);
                collect(field.fields); collect(field.headerFields);
                for (const branch of field.branches || []) collect(branch.fields);
            }
        }
        collect(compiled.headerFields);
        for (const message of compiled.messages) {
            if (message.lengthSource) referenced.add(message.lengthSource.fieldId);
            if (compiled.unified && message.lengthFrom !== undefined) {
                const names = new Set(variables(expression(message.lengthFrom)).map(name => name.replace(/^CURRENT\./, '')));
                for (const [id, entry] of compiled.fieldEntries) if (names.has(entry.path)) referenced.add(id);
            }
            collect(message.fields);
        }
        for (const field of fields) if (field.role === 'length' && (!validLengthSource(field) || !referenced.has(field.id)))
            fail('length-role', 'Length role requires unsigned scalar storage and at least one lengthSource consumer', { nodeId: field.id });
    }
    function prepareUnifiedFields(compiled) {
        const schema = compiled.schema;
        if (compiled.rootMessages.length !== 1 || schema.command || schema.headerFields?.length || schema.checksums?.length ||
            Object.keys(schema.framing || {}).some(key => key !== 'maxLength')) fail('schema', 'Unified fields require one whole-frame structure and field-based rules');
        const entries = new Map(); compiled.fieldEntries = entries; compiled.fieldChecksums = [];
        function collect(fields, prefix = '', owner = null) {
            fields.forEach((field, index) => {
                const path = prefix ? `${prefix}.${field.name}` : field.name;
                entries.set(field.id, { field, path, fields, index, owner });
                if (field.fields) collect(field.fields, field.inline ? prefix : path, field);
                if (field.headerFields) collect(field.headerFields, path, field);
                for (const branch of field.branches || []) collect(branch.fields, field.inline ? prefix : path, field);
            });
        }
        collect(compiled.rootMessages[0].fields);
        const relationCandidates = new Set();
        const collectRelation = node => {
            if (node.fn === 'LEN') relationCandidates.add(node.args[0].variable.replace(/^CURRENT\./, ''));
            for (const child of [node.left,node.right,node.unary,...(node.args ?? [])]) if (child) collectRelation(child);
        };
        for (const rule of schema.rules ?? []) if (rule.enabled !== false && rule.boundaryFallback === true && rule.value)
            collectRelation(expression(rule.value));
        const root = compiled.rootMessages[0];
        if (root.byteLength === undefined) root.byteLength = 0;
        bounded(root.byteLength, compiled.maxLength, 'Whole frame byte length');
        if (root.byteLength > 0 && root.lengthSource && root.legacyProtocol !== true) fail('length', 'Fixed whole-frame byte length conflicts with lengthSource binding', { nodeId: root.id });
        if (root.lengthFrom !== undefined && (root.byteLength > 0 || root.lengthSource))
            fail('length', 'Whole-frame length expression conflicts with fixed length or lengthSource binding', { nodeId: root.id });
        // A literal zero explicitly requests content-defined framing; empty input is an invalid expression.
        if (root.lengthFrom === 0 || typeof root.lengthFrom === 'string' && root.lengthFrom.trim() === '0') delete root.lengthFrom;
        for (const entry of entries.values()) {
            const { field, fields, index } = entry;
            field.lengthRelationCandidate = relationCandidates.has(entry.path);
            const width = scalarWidth(field);
            if (field.byteLength === undefined) field.byteLength = width ?? (field.type === 'fixed' ? field.bytes.length : typeof field.length === 'number' ? field.length : 0);
            bounded(field.byteLength, compiled.maxLength, 'Field byte length');
            if (field.byteLength > 0 && field.lengthSource) fail('length', 'Fixed field byte length conflicts with lengthSource binding', { nodeId: field.id });
            if (width !== undefined && field.byteLength !== width || field.type === 'fixed' && field.byteLength !== field.bytes.length)
                fail('width', 'Byte length does not match field type or fixed bytes', { nodeId: field.id });
            if (field.byteLength > 0 && !width && field.type !== 'fixed') field.length = field.byteLength;
            else if (field.byteLength === 0) {
                if (width || field.type === 'fixed') fail('width', 'Scalar and fixed fields require a positive byte length', { nodeId: field.id });
                if (field.lengthSource) {
                    const source = entries.get(field.lengthSource.fieldId);
                    if (!source || !validLengthSource(source.field)) fail('reference', 'Length source must reference an unsigned scalar field', { nodeId: field.id });
                    const unit = bounded(field.lengthSource.unit ?? 1, compiled.maxLength, 'Length source unit', 1), adjustment = field.lengthSource.adjustment ?? 0;
                    if (!Number.isSafeInteger(adjustment)) fail('length', 'Invalid length source adjustment', { nodeId: field.id });
                    const owners = owner => { const chain = []; for (let node = owner; node; node = entries.get(node.id)?.owner) chain.unshift(node); return chain; };
                    const from = owners(entry.owner), to = owners(source.owner);
                    let common = 0; while (common < from.length && common < to.length && from[common] === to[common]) common++;
                    const localPath = 'PARENT.'.repeat(from.length - common) +
                        [...to.slice(common).filter(owner => !owner.inline).map(owner => owner.name), source.field.name].join('.');
                    field.length = `(${localPath}) * ${unit} + (${adjustment})`;
                    field.autoLengthSource = source.field; field.autoLengthUnit = unit; field.autoLengthAdjustment = adjustment;
                    source.field.autoLengthTargets ??= []; source.field.autoLengthTargets.push(field.id);
                } else if (field.lengthFrom === 'contents' && ['struct','choice','repeat','tlv'].includes(field.type)) delete field.length;
                else if (field.lengthFrom !== undefined && String(field.lengthFrom).trim()) field.length = field.lengthFrom;
                else if (field.boundary) {
                    const start = entries.get(field.boundary.startFieldId), end = entries.get(field.boundary.endFieldId);
                    if (field.boundary.startFieldId && (!start || start.field.type !== 'fixed' || start.fields !== fields || start.index !== index - 1) ||
                        !end || end.field.type !== 'fixed' || end.fields !== fields || end.index !== index + 1)
                        fail('boundary', 'Variable boundary must reference adjacent independent fixed byte fields', { nodeId: field.id });
                    field.endBytes = end.field.bytes;
                } else if (field.lengthRelationCandidate) field.length = 'REMAINING';
                else fail('length', '0 byte variable fields require a length source or fixed boundary；结构体、分支或定次重复可选择“按内部字段确定”，原始字节须提供独立边界', { nodeId: field.id });
            }
            if (field.length !== undefined) field.expressions.length = expression(field.length);
            else delete field.expressions.length;
            if (field.type === 'checksum') {
                const config = { type: 'sum', ...field.checksum, width: field.byteLength * 8, id: field.id, endian: field.endian };
                if (![8,16,32].includes(config.width) || !['crc','crc8','crc16','crc32','sum','xor'].includes(config.type) || /^crc\d+$/.test(config.type) && Number(config.type.slice(3)) !== config.width) fail('checksum', 'Invalid checksum type or byte width', { nodeId: field.id });
                if (config.type.startsWith('crc') && !Number.isSafeInteger(config.polynomial)) fail('checksum', 'CRC requires a polynomial', { nodeId: field.id });
                for (const key of ['polynomial','init','xorOut']) if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 0 || config[key] >= 2 ** config.width)) fail('checksum', 'Invalid checksum ' + key, { nodeId: field.id });
                for (const key of ['start','end']) {
                    const reference = config[key];
                    if (reference && typeof reference === 'object') {
                        if (!entries.has(reference.fieldId) || !['start','end'].includes(reference.edge ?? 'start')) fail('reference', 'Unknown checksum boundary field', { nodeId: field.id });
                        if (reference.fieldId === field.id && (key === 'start' || reference.edge === 'end')) fail('checksum', 'Checksum range includes its own storage', { nodeId: field.id });
                    } else if (reference !== undefined) config[key + 'Expression'] = expression(reference);
                }
                field.checksumConfig = config; compiled.fieldChecksums.push(field);
            }
        }
        compiled.frameAliases = new Map();
        const selectorPath = field => {
            if (field.selectorFieldId) return entries.get(field.selectorFieldId)?.path;
            if (typeof field.selector !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(field.selector)) return null;
            const direct = [...entries.values()].find(entry => entry.path === field.selector);
            return direct?.path ?? field.selector;
        };
        function aliases(fields, selectors = []) {
            for (const field of fields) {
                for (const branch of field.branches || []) {
                    const chain = branch.legacyMessage ? [...selectors, { path: selectorPath(field) ?? branch.selectorPath, value: branch.equals ?? branch.legacyMessage.command, choiceId: field.id, branchId: branch.id }] : selectors;
                    if (branch.legacyMessage) branch.legacyMessage.id = branch.id;
                    if (branch.legacyMessage) {
                        const alias = { ...branch.legacyMessage, id: branch.id, fields: branch.fields, frameAlias: true, selectors: chain, valuePath: branch.valuePath ?? '', branchId: branch.id };
                        if (selectors.length) alias.parent = compiled.frameAliases.get(selectors.at(-1).branchId);
                        if (compiled.messageById.has(alias.id)) fail('schema', 'Duplicate legacy message identity');
                        compiled.messages.push(alias); compiled.messageById.set(alias.id, alias); compiled.frameAliases.set(alias.id, alias);
                    }
                    aliases(branch.fields, chain);
                }
                if (field.fields) aliases(field.fields, selectors);
            }
        }
        aliases(root.fields);
    }
    function bindUnifiedFraming(compiled) {
        const root = compiled.rootMessages[0], framing = compiled.framing;
        if (root.byteLength) framing.fixedLength = root.byteLength;
        let cursor = 0;
        for (const field of root.fields) {
            if (field.offset !== undefined) cursor = typeof field.offset === 'number' ? field.offset : null;
            if (field.framingRole === 'sync') {
                if (field.type !== 'fixed' || cursor === null || field.condition !== undefined) fail('schema', 'Synchronization requires unconditional fixed bytes at a known position', { nodeId: field.id });
                compiled.sync = { offset: cursor, bytes: field.bytes };
                if (!cursor) framing.header = field.bytes;
            }
            if (field.framingRole === 'end') {
                if (field.type !== 'fixed' || field !== root.fields.at(-1) || field.condition !== undefined) fail('boundary', 'End delimiter must be the final independent fixed field', { nodeId: field.id });
                framing.footer = field.bytes; compiled.fieldFooter = true;
            }
            const width = scalarWidth(field) ?? (field.type === 'fixed' ? field.bytes.length : typeof field.length === 'number' ? field.length : null);
            cursor = cursor === null || width === null || field.condition !== undefined || field.count !== undefined && typeof field.count !== 'number' ? null : cursor + width * (typeof field.count === 'number' ? field.count : 1);
        }
        if (root.lengthFrom === undefined && !framing.fixedLength && cursor !== null && cursor > 0) framing.fixedLength = cursor;
        const staticFields = new Map();
        function locate(fields, base = 0, restricted = false) {
            let at = base;
            for (const field of fields) {
                const before = at;
                if (field.offset !== undefined) at = typeof field.offset === 'number' && base !== null ? (field.offsetBase === 'frame' ? 0 : base) + field.offset : null;
                const optional = restricted || field.condition !== undefined || field.count !== undefined;
                if (at !== null && !optional) staticFields.set(field.id, { field, offset: at });
                if (field.fields) locate(field.fields, at, optional);
                const pattern = field.type === 'fixed' ? field.bytes : field.expectedBytes;
                if (field.framingRole === 'sync' && at !== null && pattern?.length && !optional) {
                    if (compiled.sync && (compiled.sync.offset !== at || String(compiled.sync.bytes) !== String(pattern))) fail('ambiguity', 'Conflicting synchronization fields', { nodeId: field.id });
                    compiled.sync = { offset: at, bytes: pattern }; if (!at) framing.header = pattern;
                }
                const width = scalarWidth(field) ?? (field.type === 'fixed' ? field.bytes.length : typeof field.length === 'number' ? field.length : null);
                at = field.legacyOverlay ? before : at === null || width === null || field.condition !== undefined || field.count !== undefined && typeof field.count !== 'number' ? null : at + width * (typeof field.count === 'number' ? field.count : 1);
            }
        }
        locate(root.fields);
        compiled.preChecksums = [];
        const staticSpans = [...staticFields.values()].map(item => ({ fieldId: item.field.id, field: item.field,
            path: compiled.fieldEntries.get(item.field.id).path, byteOffset: item.offset,
            endByte: item.offset + (scalarWidth(item.field) ?? (item.field.type === 'fixed' ? item.field.bytes.length : typeof item.field.length === 'number' ? item.field.length : 0)), context: {} }));
        if (compiled.schema.rules?.length) compiled.ruleStaticSpans = staticSpans.filter(span => span.endByte > span.byteOffset);
        const knownChecks = staticSpans.filter(span => span.field.type === 'checksum' && ['start','end'].every(key => {
            const value = span.field.checksumConfig[key];
            return value === undefined || typeof value === 'number' && value >= 0 || value && typeof value === 'object' && staticFields.has(value.fieldId);
        }));
        if (knownChecks.length) {
            const relevant = staticSpans.filter(span => span.field.type !== 'checksum' || knownChecks.includes(span));
            for (const node of fieldChecksumRanges(compiled, relevant, framing.fixedLength ?? compiled.maxLength))
                compiled.preChecksums.push({ ...node.config, start: node.start, end: node.end, offset: node.offset });
        }
        // Validate each statically placed branch with its enclosing fields.
        // Mutually exclusive sibling branches must never share a checksum graph.
        const validateConditionalChecksums = (fields, base, inherited) => {
            const scope = new Map(inherited), children = [];
            let at = base;
            for (const field of fields) {
                const before = at;
                if (field.offset !== undefined) at = typeof field.offset === 'number' && base !== null ? (field.offsetBase === 'frame' ? 0 : base) + field.offset : null;
                const certain = at !== null && field.condition === undefined && field.count === undefined;
                if (certain) scope.set(field.id, { field, offset: at });
                if (field.fields) children.push({ fields: field.fields, base: certain ? at : null });
                for (const branch of field.branches || []) children.push({ fields: branch.fields, base: certain ? at : null });
                const width = scalarWidth(field) ?? (field.type === 'fixed' ? field.bytes.length : typeof field.length === 'number' ? field.length : null);
                at = field.legacyOverlay ? before : !certain || width === null ? null : at + width;
            }
            const spans = [...scope.values()].map(item => ({ fieldId: item.field.id, field: item.field,
                path: compiled.fieldEntries.get(item.field.id).path, byteOffset: item.offset,
                endByte: item.offset + (scalarWidth(item.field) ?? (item.field.type === 'fixed' ? item.field.bytes.length : typeof item.field.length === 'number' ? item.field.length : 0)), context: {} }));
            const checks = spans.filter(span => span.field.type === 'checksum' && ['start','end'].every(key => {
                const value = span.field.checksumConfig[key];
                return value === undefined || typeof value === 'number' && (value >= 0 || framing.fixedLength) || value && typeof value === 'object' && scope.has(value.fieldId);
            }));
            if (checks.length) fieldChecksumRanges(compiled, spans.filter(span => span.field.type !== 'checksum' || checks.includes(span)), framing.fixedLength ?? compiled.maxLength);
            for (const child of children) validateConditionalChecksums(child.fields, child.base, scope);
        };
        if (compiled.fieldChecksums.length) validateConditionalChecksums(root.fields, 0, staticFields);
        if (root.lengthSource) {
            const source = staticFields.get(root.lengthSource.fieldId);
            if (!source || !validLengthSource(source.field)) fail('reference', 'Frame length source must be a statically located unsigned field');
            const unit = bounded(root.lengthSource.unit ?? 1, compiled.maxLength, 'Frame length unit', 1), adjustment = root.lengthSource.adjustment ?? 0;
            if (!Number.isSafeInteger(adjustment)) fail('length', 'Invalid frame length adjustment');
            framing.length = { type: baseType(source.field), offset: source.offset, endian: source.field.endian, unit, adjustment };
            source.field.autoFrameLength = true; compiled.frameLengthField = source.field;
        }
        if (root.lengthFrom !== undefined) bindFrameLengthExpression(compiled, root, staticFields);
        compiled.fieldFooter = true;
    }
    function checkStructuralBoundaries(compiled) {
        const framing = compiled.framing, root = compiled.rootMessages[0];
        const needsEnd = (fields, boundedScope = false) => fields.some(field => {
            const dependent = typeof (field.lengthFrom ?? field.length) === 'string' && /\b(?:REMAINING|FRAME_LENGTH|PAYLOAD_LENGTH)\b/.test(field.lengthFrom ?? field.length) || field.until === 'end' && !field.expressions.length;
            const boundedChild = boundedScope || Boolean(field.lengthRelation) || field.byteLength > 0 || Boolean(field.lengthSource || field.boundary) || Boolean(field.lengthFrom && field.lengthFrom !== 'contents' && !dependent);
            return dependent && !boundedScope && !field.lengthRelation || field.fields && needsEnd(field.fields, boundedChild) || (field.branches || []).some(branch => needsEnd(branch.fields, boundedChild));
        });
        compiled.needsEndBoundary = needsEnd(root.fields);
        if (compiled.needsEndBoundary && !framing.fixedLength && !framing.length && !compiled.frameLengthExpression && !framing.footer?.length) fail('boundary', 'Remaining length requires a bounded frame or end delimiter');
    }
    function bindFrameLengthExpression(compiled, root, staticFields) {
        const tree = expandFrameLengths(compiled, expression(root.lengthFrom)), inputs = [];
        for (const variable of new Set(variables(tree))) {
            if (['TRUE', 'FALSE'].includes(variable)) continue;
            const path = variable.replace(/^CURRENT\./, '');
            const entry = [...compiled.fieldEntries.values()].find(item => item.path === path);
            const source = entry && staticFields.get(entry.field.id);
            if (!source || !TYPES[baseType(source.field)] || source.field.type === 'checksum')
                fail('reference', `整帧长度表达式必须引用位置确定的前置数值字段：${variable}`, { nodeId: root.id });
            const end = bounded(source.offset + scalarWidth(source.field), compiled.maxLength, 'Length input position', 1);
            inputs.push({ ...source, variable, end });
        }
        compiled.frameLengthExpression = { tree, inputs, minimum: Math.max(1, ...inputs.map(input => input.end)) };
        if (!inputs.length) compiled.framing.fixedLength = bounded(evaluate(tree, {}), compiled.maxLength, 'Whole frame length', 1);
        // Preserve automatic back-filling for the former field × unit + adjustment rule.
        // General multi-input/nonlinear expressions are validated against explicit send values.
        if (inputs.length === 1 && validLengthSource(inputs[0].field)) {
            const linear = affineLength(tree, inputs[0].variable);
            const source = inputs[0].field;
            const controlsLayout = [...compiled.fieldEntries.values()].some(({ field }) =>
                [field.expressions.count, field.expressions.condition, field.expressions.offset, field.selectorExpression,
                    ...(field.branches ?? []).map(branch => branch.expressionTree)].some(control =>
                    variables(control).some(name => name.split('.').at(-1) === source.name)));
            if (!controlsLayout && linear && Number.isSafeInteger(linear[0]) && linear[0] > 0 && linear[0] <= compiled.maxLength && Number.isSafeInteger(linear[1])) {
                const { field, offset } = inputs[0];
                compiled.framing.length = { type: baseType(field), offset, endian: field.endian, unit: linear[0], adjustment: linear[1] };
                field.autoFrameLength = true; compiled.frameLengthField = field;
            }
        }
    }
    // A value equation is a fallback boundary, not an unconditional segment size.
    // Compile LEN terms once; only a single unresolved byte span may be inverted.
    function compileLengthRelations(compiled) {
        compiled.lengthRelations = [];
        const entries = [...(compiled.fieldEntries?.values() ?? [])];
        const lit = literal => ({ literal }), op = (operator, left, right) => {
            if (Object.hasOwn(left, 'literal') && Object.hasOwn(right, 'literal'))
                return lit(evaluate({ op: operator, left, right }, {}));
            return { op: operator, left, right };
        };
        for (const rule of compiled.rules ?? []) {
            if (!rule.enabled || !rule.boundaryFallback) continue;
            if (rule.conditionTree) fail('length-relation', '解析定界表达式不能有附加启用条件；请在分支结构中限定适用范围', { nodeId: rule.id });
            const unknown = new Map(), source = entries.find(entry => entry.field.id === rule.targetFieldId);
            if (!validLengthSource(source.field)) fail('length-relation', '解析长度值必须来自无符号整数字段', { nodeId: rule.id });
            const expand = node => {
                if (node.fn === 'LEN') {
                    const path = node.args[0].variable.replace(/^CURRENT\./, '');
                    const matches = entries.filter(entry => entry.path === path);
                    if (matches.length !== 1) fail('length-relation', `长度路径必须唯一：${path}`, { nodeId: rule.id });
                    let measured;
                    try { measured = expandFrameLengths(compiled, node); }
                    catch (error) {
                        if (error.code !== 'length-reference' || /循环/.test(error.message)) throw error;
                    }
                    if (measured && !variables(measured).some(name => /^(?:FRAME_LENGTH|PAYLOAD_LENGTH|REMAINING|PARENT_REMAINING)$/.test(name))) return measured;
                    unknown.set(path, matches[0]); return { variable: '__unknownLength' };
                }
                if (node.variable) {
                    const path = node.variable.replace(/^CURRENT\./, '');
                    if (path === source.path) fail('length-relation', '长度表达式不能引用本字段自身，存在循环依赖', { nodeId: rule.id });
                    return { variable: path };
                }
                const result = { ...node };
                for (const key of ['left','right','unary']) if (node[key]) result[key] = expand(node[key]);
                if (node.args) result.args = node.args.map(expand);
                return result;
            };
            const tree = expand(rule.valueTree);
            if (unknown.size > 1) fail('length-relation', '表达式存在多个未知长度，无法唯一求解：' + [...unknown.keys()].join('、'), { nodeId: rule.id });
            if (!unknown.size) continue; // All terms are structural: verification/backfill is sufficient.
            const target = [...unknown.values()][0];
            for (let entry = source; entry; entry = entry.owner && compiled.fieldEntries.get(entry.owner.id))
                if (entry.field.condition !== undefined || entry.field.count !== undefined || ['choice','repeat','tlv'].includes(entry.field.type))
                    fail('length-relation', '解析长度源必须是先前必定读取的唯一数值字段', { nodeId: rule.id });
            for (let entry = target; entry?.owner; entry = compiled.fieldEntries.get(entry.owner.id))
                if (entry.owner.count !== undefined || ['choice','repeat','tlv'].includes(entry.owner.type))
                    fail('length-relation', '无法唯一定位重复或分支内部的长度目标，请引用其所属数据段', { nodeId: rule.id });
            if (target.field.count !== undefined || target.field.condition !== undefined || entries.indexOf(source) >= entries.indexOf(target))
                fail('length-relation', '长度字段必须先于唯一的数据段读取', { nodeId: rule.id });
            for (const name of variables(tree).filter(name => name !== '__unknownLength')) {
                if (['TRUE','FALSE'].includes(name)) continue;
                const input = entries.find(entry => entry.path === name);
                if (!input || entries.indexOf(input) >= entries.indexOf(target) || !TYPES[baseType(input.field)])
                    fail('length-relation', `长度求解依赖未读取的数值或边界：${name}`, { nodeId: rule.id });
            }
            const affine = node => {
                if (!variables(node).includes('__unknownLength')) return [lit(0), node];
                if (node.variable === '__unknownLength') return [lit(1), lit(0)];
                if (node.unary && ['+','-'].includes(node.op)) {
                    const pair = affine(node.unary); return node.op === '+' ? pair : pair.map(item => op('*', lit(-1), item));
                }
                if (!node.left || !node.right) fail('length-relation', '该长度表达式无法唯一求解；未知长度仅支持线性的加减乘除', { nodeId: rule.id });
                const a = affine(node.left), b = affine(node.right), zero = item => item.literal === 0;
                if (['+','-'].includes(node.op)) return [op(node.op,a[0],b[0]), op(node.op,a[1],b[1])];
                if (node.op === '*' && (zero(a[0]) || zero(b[0]))) return zero(a[0])
                    ? [op('*',a[1],b[0]),op('*',a[1],b[1])] : [op('*',a[0],b[1]),op('*',a[1],b[1])];
                if (node.op === '/' && zero(b[0])) return [op('/',a[0],b[1]),op('/',a[1],b[1])];
                fail('length-relation', '该长度表达式无法唯一求解；未知长度不能相乘、作为除数或参与取整', { nodeId: rule.id });
            };
            const [coefficient, constant] = affine(tree);
            if (coefficient.literal === 0) fail('length-relation', '未知长度系数为 0，无法唯一求解', { nodeId: rule.id });
            if (target.field.lengthRelation) fail('length-relation', '多个表达式同时为同一数据段定界', { nodeId: rule.id });
            const localPath = entry => {
                const owners = item => { const result = []; for (let owner = item.owner; owner; owner = compiled.fieldEntries.get(owner.id)?.owner) result.unshift(owner); return result; };
                const from = owners(target), to = owners(entry);
                let shared = 0; while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
                return 'PARENT.'.repeat(from.length - shared) + [...to.slice(shared).filter(owner => !owner.inline).map(owner => owner.name), entry.field.name].join('.');
            };
            const scoped = node => {
                if (node.variable && !['TRUE','FALSE'].includes(node.variable)) {
                    const entry = entries.find(entry => entry.path === node.variable);
                    return { variable: localPath(entry) };
                }
                const result = { ...node };
                for (const key of ['left','right','unary']) if (node[key]) result[key] = scoped(node[key]);
                if (node.args) result.args = node.args.map(scoped);
                return result;
            };
            target.field.lengthRelation = { ruleId: rule.id, source: source.path, localSource: localPath(source), coefficient: scoped(coefficient), constant: scoped(constant) };
            compiled.lengthRelations.push(target.field);
            const unresolved = field => {
                if (field.expressions.length) return variables(field.expressions.length).includes('REMAINING') ? 1 : 0;
                if (field.until === 'end') return 1;
                const sequence = fields => (fields ?? []).reduce((sum, item) => sum + unresolved(item), 0);
                const count = field.type === 'choice' ? Math.max(0,...field.branches.map(branch => sequence(branch.fields))) : sequence(field.fields);
                return count * (field.count === undefined ? 1 : typeof field.count === 'number' ? field.count : 2);
            };
            const fixedWidth = field => {
                let width = scalarWidth(field) ?? (field.type === 'fixed' ? field.bytes.length : typeof field.length === 'number' ? field.length : null);
                if (width === null && field.type === 'struct') width = field.fields.reduce((sum, child) => sum + fixedWidth(child),0);
                if (width === null || field.condition !== undefined || field.offset !== undefined || field.count !== undefined && typeof field.count !== 'number')
                    fail('length-relation', '未知段后的字段长度尚不确定，请为后续段提供独立长度', { nodeId: field.id });
                return width * (field.count ?? 1);
            };
            const mark = (fields, inherited = true) => {
                if (inherited && fields.reduce((sum, field) => sum + unresolved(field),0) > 1)
                    fail('length-relation', '同一数据段内存在多个未知长度，无法唯一求解', { nodeId: rule.id });
                for (const [index,field] of fields.entries()) {
                field.expressionBoundaryScope = inherited;
                if (inherited && unresolved(field)) field.lengthBoundaryTail = fields.slice(index+1).reduce((sum, item) => sum + fixedWidth(item),0);
                field.expressionBoundaryRepeat = inherited && field.until === 'end' && !field.expressions.length;
                const bounded = field.byteLength > 0 || field.lengthSource || field.boundary || field.lengthFrom && !['contents','REMAINING'].includes(field.lengthFrom);
                if (field.fields) mark(field.fields, inherited && !bounded);
                if (field.headerFields) mark(field.headerFields, false);
                for (const branch of field.branches ?? []) mark(branch.fields, inherited && !bounded);
            } };
            mark([target.field]);
        }
    }
    function lengthBoundaryContext(field, local, start, end, compiled) {
        if (field.lengthRelation) {
            const rule = field.lengthRelation;
            local[LENGTH_BOUNDARY] = () => {
                const coefficient = Number(evaluate(rule.coefficient, local)), constant = Number(evaluate(rule.constant, local));
                if (!Number.isFinite(coefficient) || coefficient === 0 || !Number.isFinite(constant))
                    fail('length-relation', '长度表达式无法唯一求解', { nodeId: field.id });
                const length = (Number(lookup(local, rule.localSource)) - constant) / coefficient;
                if (!Number.isSafeInteger(length) || length < 0 || start + length > Math.min(end, compiled.maxLength))
                    fail('length-relation', '长度表达式结果必须是范围内的非负整数字节数', { nodeId: field.id });
                return start + length;
            };
        }
        if (field.lengthBoundaryTail && local[LENGTH_BOUNDARY]) {
            const parentBoundary = local[LENGTH_BOUNDARY];
            local[LENGTH_BOUNDARY] = () => parentBoundary() - field.lengthBoundaryTail;
        }
        local[LENGTH_CURSOR] = start;
        return local;
    }
    function boundaryEvaluationContext(field, local) {
        if (!field.expressionBoundaryScope || !local[LENGTH_BOUNDARY]) return local;
        const result = { ...local };
        Object.defineProperty(result, 'REMAINING', { get() {
            const remaining = local[LENGTH_BOUNDARY]() - local[LENGTH_CURSOR];
            if (remaining < 0) fail('length-relation', '长度表达式边界小于已读取的数据段', { nodeId: field.id });
            return remaining;
        } });
        return result;
    }
    function expandFrameLengths(compiled, tree) {
        const entries = [...compiled.fieldEntries.values()], active = new Set();
        const literal = value => ({ literal: value });
        const operation = (op, left, right) => ({ op, left, right });
        function resolve(path, scope) {
            if (path.startsWith('CURRENT.')) path = path.slice(8);
            while (path.startsWith('PARENT.')) { scope = scope.split('.').slice(0, -1).join('.'); path = path.slice(7); }
            for (let current = scope;; current = current.split('.').slice(0, -1).join('.')) {
                const full = current ? current + '.' + path : path, candidates = entries.filter(entry => entry.path === full);
                if (candidates.length > 1) fail('reference', `LEN 的字段路径存在歧义：${full}`);
                if (candidates.length) return candidates[0];
                if (!current) return null;
            }
        }
        function expand(node, scope = '') {
            if (node.fn === 'LEN') {
                const entry = resolve(node.args[0].variable, scope);
                if (!entry) fail('reference', `LEN 引用了未知字段：${node.args[0].variable}`);
                return measure(entry);
            }
            if (node.variable) return { variable: resolve(node.variable, scope)?.path ?? node.variable };
            const result = { ...node };
            for (const key of ['left', 'right', 'unary']) if (node[key]) result[key] = expand(node[key], scope);
            if (node.args) result.args = node.args.map(arg => expand(arg, scope));
            return result;
        }
        function contents(fields) {
            let cursor = literal(0);
            for (const field of fields) {
                if (field.legacyOverlay) continue;
                const entry = compiled.fieldEntries.get(field.id);
                if (field.offsetBase === 'frame') fail('length-reference', `LEN(${entry.path}) 不能从整帧绝对偏移推测段长度`);
                const offset = field.expressions.offset && expand(field.expressions.offset, entry.path.slice(0, -field.name.length).replace(/\.$/, ''));
                cursor = operation('+', offset ?? cursor, measure(entry));
            }
            return cursor;
        }
        function measure(entry) {
            const field = entry.field;
            if (active.has(field.id)) fail('length-reference', `LEN(${entry.path}) 存在循环长度依赖`);
            for (let owner = entry.owner; owner; owner = compiled.fieldEntries.get(owner.id)?.owner)
                if (!active.has(owner.id) && (owner.condition !== undefined || owner.count !== undefined || ['choice', 'repeat', 'tlv'].includes(owner.type)))
                    fail('length-reference', `LEN(${entry.path}) 的字段不属于唯一确定的段`);
            if (field.condition !== undefined) fail('length-reference', `LEN(${entry.path}) 的段可能未启用，无法独立确定长度`);
            active.add(field.id);
            const scope = entry.path.slice(0, -field.name.length).replace(/\.$/, '');
            let length = scalarWidth(field) !== undefined ? literal(scalarWidth(field))
                : field.type === 'fixed' ? literal(field.bytes.length)
                : field.expressions.length ? expand(field.expressions.length, scope)
                : ['struct', 'repeat'].includes(field.type) && field.until !== 'end' ? contents(field.fields)
                : null;
            if (!length && field.type === 'choice') length = { lengthChoice: {
                id: field.id, selectorExpression: field.selectorExpression && expand(field.selectorExpression, scope),
                branches: field.branches.map(branch => ({ ...branch,
                    expressionTree: branch.expressionTree && expand(branch.expressionTree, scope), lengthTree: contents(branch.fields) }))
            } };
            if (!length) fail('length-reference', `LEN(${entry.path}) 无法独立确定字节数，请先为该段指定长度来源或明确内部结构`);
            if (field.expressions.count && !(field.expressions.length && ['repeat', 'tlv'].includes(field.type)))
                length = operation('*', length, expand(field.expressions.count, scope));
            active.delete(field.id); return length;
        }
        return expand(tree);
    }
    function affineLength(tree, variable) {
        if (Object.hasOwn(tree, 'literal')) return Number.isSafeInteger(Number(tree.literal)) ? [0, Number(tree.literal)] : null;
        if (tree.variable) return tree.variable === variable ? [1, 0] : null;
        if (tree.unary) {
            const value = affineLength(tree.unary, variable);
            return value && ['+', '-'].includes(tree.op) ? value.map(item => tree.op === '-' ? -item : item) : null;
        }
        if (!tree.left || !tree.right) return null;
        const a = affineLength(tree.left, variable), b = affineLength(tree.right, variable);
        if (!a || !b) return null;
        if (tree.op === '+') return [a[0] + b[0], a[1] + b[1]];
        if (tree.op === '-') return [a[0] - b[0], a[1] - b[1]];
        if (tree.op === '*' && (!a[0] || !b[0])) return [a[0] * b[1] + a[1] * b[0], a[1] * b[1]];
        if (tree.op === '/' && !b[0] && b[1]) return a.map(item => item / b[1]);
        return null;
    }
    function boundaryLength(bytes, field, cursor, end) {
        for (let at = cursor; at + field.endBytes.length <= Math.min(end, bytes.length); at++)
            if (field.endBytes.every((byte, index) => bytes[at + index] === byte)) return at - cursor;
        return null;
    }
    function delimiterTable(pattern) {
        const Table = pattern.length > 65535 ? Uint32Array : pattern.length > 255 ? Uint16Array : Uint8Array;
        const table = new Table(pattern.length);
        for (let index = 1, matched = 0; index < pattern.length; index++) {
            while (matched && pattern[index] !== pattern[matched]) matched = table[matched - 1];
            if (pattern[index] === pattern[matched]) matched++;
            table[index] = matched;
        }
        return table;
    }
    function cachedScalar(bytes, field, offset, compiled, layout, work) {
        let values = layout?.scalarValues.get(field);
        if (values?.has(offset)) return values.get(offset);
        if (work) work.scalarReads++;
        const value = scalarRead(bytes, field, offset, compiled);
        if (layout) {
            if (!values) layout.scalarValues.set(field, values = new Map());
            values.set(offset, value);
            layout.scalarCount = (layout.scalarCount ?? 0) + 1;
        }
        return value;
    }
    function scanUnifiedFrame(bytes, compiled, knownEnd = null, work = null) {
        return createUnifiedFrameScan(compiled, knownEnd, work).resume(bytes);
    }
    function referenceReader(source, path) { return () => lookup(source, path); }
    // The generator owns the field/loop stack. Yield only when more bytes are needed;
    // resuming never repeats completed fields, expressions, branch selection or delimiter prefixes.
    function createUnifiedFrameScan(compiled, knownEnd = null, work = null, earlyRules = false) {
        let bytes = new Uint8Array(), minimum = 0, result = null;
        const spans = [], context = { FRAME_LENGTH: knownEnd ?? 0, PAYLOAD_LENGTH: knownEnd ?? 0, SEQ: 0, SEQUENCE: 0 };
        const layout = { spans, scalarValues: new Map(), boundaries: new Map(), scalarCount: 0, contextBytes: 0 };
        const lengths = compiled.usesLengthFunction ? new Map() : null;
        if (lengths) spans[RULE_LENGTHS] = lengths;
        let budget = LIMITS.fields * 4;
        const checkedRules = new Set(), ruleCache = {};
        function* waitFor(end) { while (bytes.length < end) {
            if (earlyRules && compiled.rules?.some(rule => rule.enabled !== false && rule.stage !== 'validation' && !checkedRules.has(rule.id))) {
                const results = evaluateRules(bytes, compiled, spans, 'parsing', { partial: true, done: checkedRules, contextCache: ruleCache });
                const failed = results.find(result => result.strength === 'strong' && result.status === 'failed');
                if (failed) fail('rule', failed.message, { ruleResults: results, boundaryReliable: false });
            }
            yield end;
        } }
        function* boundary(field, cursor, end) {
            let at = cursor, matched = 0;
            const pattern = field.endBytes, table = field.endTable;
            while (at < end) {
                yield* waitFor(at + 1);
                const byte = bytes[at++]; if (work) work.delimiterBytes++;
                while (matched && byte !== pattern[matched]) matched = table[matched - 1];
                if (byte === pattern[matched]) matched++;
                if (matched === pattern.length) {
                    let values = layout.boundaries.get(field);
                    if (!values) layout.boundaries.set(field, values = new Map());
                    const length = at - matched - cursor; values.set(cursor, length); return length;
                }
            }
            fail('boundary', 'Variable field end delimiter is missing', { nodeId: field.id });
        }
        function* walk(fields, target, base, end, prefix, parent = context) {
            let cursor = base;
            const len = lengths && lengthScope(lengths, prefix, parent[LEN_CONTEXT], fields);
            for (const field of fields) {
                const priorCursor = cursor;
                if (--budget < 0) fail('bounds', 'Frame layout field budget exceeded');
                if (work) work.layoutFieldVisits++;
                const local = { ...parent, ...target, PARENT: parent, CURRENT: target, REMAINING: end - cursor, PARENT_REMAINING: parent.REMAINING ?? end - base,
                    SEQ: context.SEQ, SEQUENCE: context.SEQUENCE, [LEN_CONTEXT]: len };
                local[LENGTH_CURSOR] = cursor;
                if (field.expressions.condition && !evaluate(field.expressions.condition, boundaryEvaluationContext(field, local))) continue;
                if (field.expressions.offset) cursor = (field.offsetBase === 'frame' ? 0 : base) + bounded(evaluate(field.expressions.offset, boundaryEvaluationContext(field, local)), compiled.maxLength, 'Field offset');
                const path = prefix ? `${prefix}.${field.name}` : field.name, start = cursor;
                lengthBoundaryContext(field, local, cursor, end, compiled);
                const evaluation = boundaryEvaluationContext(field, local);
                const count = field.expressions.count ? bounded(evaluate(field.expressions.count, evaluation), LIMITS.array, 'Field count') : 1;
                const length = field.endBytes ? yield* boundary(field, cursor, end) : field.expressions.length ? bounded(evaluate(field.expressions.length, evaluation), compiled.maxLength, 'Field length')
                    : field.expressionBoundaryRepeat ? bounded(evaluation.REMAINING, compiled.maxLength, 'Repeat length') : null;
                if (length !== null) yield* waitFor(cursor + length);
                const limit = length === null ? end : cursor + length;
                if (['struct','choice'].includes(field.type)) {
                    const values = [];
                    for (let index = 0; index < count; index++) {
                        const itemEnd = length === null ? end : cursor + length;
                        if (itemEnd > end) fail('boundary', 'Array segment exceeds its container');
                        const branch = field.type === 'choice' ? chooseBranch(field, { ...local, REMAINING: field.expressionBoundaryScope ? local.REMAINING : itemEnd - cursor }) : null;
                        if (field.type === 'choice' && !branch) fail('condition', 'No frame branch matches');
                        const value = field.inline ? target : {}, itemPath = field.count !== undefined ? `${path}[${index}]` : path;
                        const next = yield* walk(branch ? branch.fields : field.fields, value, cursor, itemEnd, field.inline ? prefix : itemPath, { ...local, INDEX: index });
                        lengths?.set(itemPath, (length === null ? next : itemEnd) - cursor);
                        cursor = length === null ? next : itemEnd; values.push(value);
                    }
                    if (!field.inline) target[field.name] = field.count !== undefined ? values : values[0];
                } else if (['repeat','tlv'].includes(field.type)) {
                    const items = [], repeatCount = field.until === 'end' ? LIMITS.array : count;
                    for (let index = 0; index < repeatCount && (field.until !== 'end' || cursor < limit); index++) {
                        const item = {}, at = cursor, itemContext = { ...local, INDEX: index };
                        if (field.type === 'tlv') {
                            const valueStart = yield* walk(field.headerFields, item, cursor, limit, `${path}[${index}]`, itemContext);
                            const itemEnd = (field.lengthIncludesHeader ? cursor : valueStart) + bounded(item[field.lengthField], compiled.maxLength, 'TLV length') * (field.lengthUnit ?? 1) + (field.lengthAdjustment ?? 0);
                            if (itemEnd < valueStart || itemEnd > limit) fail('boundary', 'TLV exceeds its segment');
                            yield* waitFor(itemEnd);
                            const branch = chooseBranch(field, { ...itemContext, ...item });
                            if (branch) yield* walk(branch.fields, item, valueStart, itemEnd, `${path}[${index}]`, itemContext);
                            cursor = itemEnd;
                        } else cursor = yield* walk(field.fields, item, cursor, limit, `${path}[${index}]`, itemContext);
                        if (cursor <= at) fail('progress', 'Repeated segment makes no progress');
                        lengths?.set(`${path}[${index}]`, cursor - at); items.push(item);
                    }
                    target[field.name] = items; if (length !== null) cursor = limit;
                } else {
                    const size = field.scanWidth ?? (field.type === 'fixed' ? field.bytes.length : length);
                    if (size === null) fail('boundary', 'Field has no stream boundary', { nodeId: field.id });
                    yield* waitFor(cursor + size * count);
                    if (field.scanWidth) target[field.name] = field.count !== undefined
                        ? Array.from({ length: count }, (_, index) => cachedScalar(bytes, field, cursor + index * size, compiled, layout, work)) : cachedScalar(bytes, field, cursor, compiled, layout, work);
                    if (lengths && field.count !== undefined) for (let index = 0; index < count; index++) lengths.set(`${path}[${index}]`, size);
                    cursor += size * count;
                }
                if (cursor > end || cursor > compiled.maxLength) fail('boundary', 'Field exceeds its containing segment');
                const span = { fieldId: field.id, field, path, byteOffset: start, endByte: cursor };
                // Only checksum expressions consume a saved context. Retaining each
                // {...target} prefix would keep quadratic memory while a frame waits.
                if (field.type === 'checksum') {
                    const saved = Object.create(null), config = field.checksumConfig;
                    for (const tree of [config.startExpression, config.endExpression]) for (const name of variables(tree)) {
                        if (Object.hasOwn(saved, name)) continue;
                        const parts = name.replace(/\[(\d+)\]/g, '.$1').split('.'), first = parts.shift();
                        // CURRENT/PARENT can expose fields populated later in this
                        // scope. Capture only the referenced owner, not the full local.
                        if (parts.length) Object.defineProperty(saved, name, { enumerable: true,
                            get: referenceReader(lookup(local, first), parts.join('.')) });
                        else saved[name] = lookup(local, name);
                        layout.contextBytes += 96 + name.length * 2;
                    }
                    if (len) saved[LEN_CONTEXT] = len;
                    span.context = saved;
                }
                spans.push(span);
                lengths?.set(path, cursor - start);
                if (field.valueSource === 'SEQ') { context.SEQ = context.SEQUENCE = target[field.name]; parent.SEQ = parent.SEQUENCE = target[field.name]; }
                if (field.legacyHeader && target[field.name]) Object.assign(parent, target[field.name], { HEADER: target[field.name] });
                if (field.legacyOverlay) cursor = priorCursor;
            }
            return cursor;
        }
        const target = {}, execution = walk(compiled.rootMessages[0].fields, target, 0, knownEnd ?? compiled.maxLength, '');
        return { get estimatedMemoryBytes() { return spans.length * 384 + layout.scalarCount * 64 + layout.boundaries.size * 128 + layout.contextBytes + (ruleCache.spanCount ?? 0) * 256; }, resume(input) {
            if (result) return result;
            bytes = input;
            if (bytes.length < minimum) return null;
            context.FRAME_LENGTH = context.PAYLOAD_LENGTH = knownEnd ?? bytes.length;
            const step = execution.next();
            if (!step.done) { minimum = step.value; return null; }
            return result = { ...layout, end: step.value, target };
        } };
    }
    function fieldChecksumRanges(compiled, spans, length) {
        const nodes = spans.filter(span => span.field.type === 'checksum').map(span => {
            const config = span.field.checksumConfig, scope = span.path.slice(0, -span.field.name.length);
            const resolve = (key, fallback) => {
                const reference = config[key];
                if (reference && typeof reference === 'object') {
                    const candidates = spans.filter(item => item.fieldId === reference.fieldId);
                    const selected = candidates.find(item => item.path.startsWith(scope)) ?? (candidates.length === 1 ? candidates[0] : null);
                    if (!selected) fail('reference', 'Checksum boundary is absent or ambiguous', { nodeId: span.fieldId });
                    return reference.edge === 'end' ? selected.endByte : selected.byteOffset;
                }
                return config[key + 'Expression'] ? position(config[key + 'Expression'], { ...span.context, FRAME_LENGTH: length }, length) : fallback;
            };
            return { ...span, config, start: resolve('start', 0), end: resolve('end', span.byteOffset), offset: span.byteOffset };
        });
        for (const node of nodes) if (node.start < 0 || node.end < node.start || node.end > length || node.start < node.endByte && node.offset < node.end)
            fail('checksum', 'Checksum range includes its own storage or is outside the frame', { nodeId: node.fieldId });
        const ordered = [], active = new Set(), done = new Set();
        const visit = node => {
            if (done.has(node)) return;
            if (active.has(node)) fail('checksum', 'Cyclic checksum field dependencies', { nodeId: node.fieldId });
            active.add(node);
            for (const other of nodes) if (other !== node && node.start < other.endByte && other.offset < node.end) visit(other);
            active.delete(node); done.add(node); ordered.push(node);
        };
        nodes.forEach(visit); return ordered;
    }
    function exact(value) {
        if (typeof value === 'string' && /^[-+]?(?:\d+|0x[\da-f]+)$/i.test(value)) return BigInt(value);
        if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('schema', 'Use an integer string for exact branch values');
        return value;
    }
    function equivalent(a, b) { a = exact(a); b = exact(b); return a === b ||
        (typeof a === 'bigint' && Number.isSafeInteger(b) && a === BigInt(b)) ||
        (typeof b === 'bigint' && Number.isSafeInteger(a) && b === BigInt(a)); }
    function branchRange(branch) {
        if (branch.equals !== undefined) return [exact(branch.equals), exact(branch.equals)];
        return branch.range?.map(exact);
    }
    function validateBranches(field, compiled) {
        let defaults = 0;
        const ranges = [];
        for (const branch of field.branches) {
            const modes = ['equals','range','mask','expression'].filter(key => branch[key] !== undefined);
            if (branch.default) defaults++;
            if (defaults > 1 || (branch.default ? modes.length !== 0 : modes.length !== 1))
                fail('ambiguity', 'Each branch requires one condition; only one default is allowed', { nodeId: branch.id });
            if (branch.range && (!Array.isArray(branch.range) || branch.range.length !== 2 || exact(branch.range[0]) > exact(branch.range[1])))
                fail('schema', 'Invalid branch range', { nodeId: branch.id });
            if (modes.length && modes[0] !== 'expression' && !field.selectorExpression)
                fail('schema', 'Branch condition requires a selector', { nodeId: field.id });
            if (branch.mask && (!Object.hasOwn(branch.mask, 'value') || !Object.hasOwn(branch.mask, 'mask')))
                fail('schema', 'Mask condition requires mask and value', { nodeId: branch.id });
            const range = branchRange(branch);
            if (range && ranges.some(previous => range[0] <= previous[1] && previous[0] <= range[1]))
                fail('ambiguity', 'Branch ranges overlap', { nodeId: branch.id });
            if (range) ranges.push(range);
        }
        if (field.branches.some(branch => branch.mask || branch.expression)) compiled.diagnostics.push({
            severity: 'warning', code: 'undecidable-overlap', nodeId: field.id,
            message: 'Branch overlap cannot be proved statically; decoding rejects multiple matches.' });
    }
    function chooseBranch(field, context) {
        context = boundaryEvaluationContext(field, context);
        const selector = field.selectorExpression ? evaluate(field.selectorExpression, context) : undefined;
        const matches = field.branches.filter(branch => {
            if (branch.default) return false;
            if (branch.expressionTree) return !!evaluate(branch.expressionTree, context);
            if (branch.equals !== undefined) return equivalent(selector, branch.equals);
            if (branch.range) return selector >= exact(branch.range[0]) && selector <= exact(branch.range[1]);
            if (branch.mask) return (BigInt(selector) & BigInt(branch.mask.mask)) === BigInt(branch.mask.value);
            return false;
        });
        if (matches.length > 1) fail('ambiguity', 'Multiple conditional branches match', { nodeId: field.id });
        return matches[0] || field.branches.find(branch => branch.default);
    }
    function minimumSize(fields) {
        let total = 0;
        for (const field of fields) {
            if (field.condition !== undefined) continue;
            let width = scalarWidth(field) || (field.type === 'fixed' ? field.bytes.length :
                typeof field.length === 'number' ? field.length : field.type === 'struct' ? minimumSize(field.fields) : 0);
            if (field.count !== undefined) width *= typeof field.count === 'number' ? field.count : 0;
            total = Math.max(total, (typeof field.offset === 'number' ? field.offset : total) + width);
        }
        return total;
    }
    function variables(tree, out = []) {
        if (!tree) return out;
        if (tree.lengthChoice) {
            variables(tree.lengthChoice.selectorExpression, out);
            for (const branch of tree.lengthChoice.branches) { variables(branch.expressionTree, out); variables(branch.lengthTree, out); }
        }
        if (tree.variable) out.push(tree.variable);
        for (const key of ['left','right','unary']) if (tree[key]) variables(tree[key], out);
        for (const arg of tree.args || []) variables(arg, out);
        return out;
    }
    function validateFields(fields, inherited, compiled, base = null) {
        const available = new Set(inherited), ranges = [];
        let cursor = base;
        for (const field of fields) {
            const before = cursor;
            if (field.until === 'end' && field.length === undefined && !field.lengthRelationCandidate && fields.indexOf(field) !== fields.length - 1)
                fail('boundary', 'Repeat-until-end must be the last field or have an explicit segment length', { nodeId: field.id });
            const check = tree => { for (const variable of variables(tree)) {
                const parts = variable.split(/[.[]/), scope = parts[0] === 'PARENT' ? inherited : available, key = ['PARENT','CURRENT'].includes(parts[0]) ? parts[1] : parts[0];
                if (!scope.has(key)) fail('reference', `Expression references an unread or out-of-scope field: ${variable}`, { nodeId: field.id });
            } };
            Object.values(field.expressions).forEach(check);
            if (field.type !== 'tlv') check(field.selectorExpression);
            if (field.type === 'tlv') {
                validateFields(field.headerFields, available, compiled);
                const itemAvailable = new Set([...available, ...field.headerFields.map(item => item.name)]);
                for (const tree of [field.selectorExpression, ...field.branches.map(branch => branch.expressionTree)])
                    for (const variable of variables(tree)) if (!itemAvailable.has(variable.split(/[.[]/)[0]))
                        fail('reference', `Unknown TLV selector: ${variable}`, { nodeId: field.id });
                for (const branch of field.branches) validateFields(branch.fields, itemAvailable, compiled);
            } else {
                for (const branch of field.branches || []) { check(branch.expressionTree); validateFields(branch.fields, available, compiled); }
                if (field.fields) validateFields(field.fields, available, compiled);
            }
            let start = cursor;
            if (field.offset !== undefined) start = typeof field.offset === 'number' ? (field.offsetBase === 'frame' ? 0 : base) === null ? null : (field.offsetBase === 'frame' ? 0 : base) + field.offset : null;
            let size = scalarWidth(field) ?? (field.type === 'fixed' ? field.bytes.length : typeof field.length === 'number' ? field.length : null);
            if (field.count !== undefined && !['repeat','tlv'].includes(field.type)) size = typeof field.count === 'number' && size !== null ? size * field.count : null;
            if (start !== null && size !== null && field.condition === undefined && !field.legacyOverlay) {
                if (compiled.schema.schemaVersion >= 2 && ranges.some(range => start < range.end && start + size > range.start))
                    fail('overlap', 'Independent fields write overlapping bytes', { nodeId: field.id, byteOffset: start, endByte: start + size });
                ranges.push({ start, end: start + size });
                if (base !== null) compiled.layoutWrites.push({ start, end: start + size, field });
            } else if (field.offset !== undefined) compiled.diagnostics.push({ severity: 'warning', code: 'undecidable-overlap', nodeId: field.id, message: 'Dynamic or conditional offset overlap is checked while encoding.' });
            cursor = field.legacyOverlay ? before : start === null || size === null || field.condition !== undefined ? null : start + size;
            available.add(field.name);
            if (field.legacyHeader) for (const child of field.fields || []) available.add(child.name);
        }
    }
    function bindFraming(compiled) {
        const framing = compiled.framing;
        function walk(fields, base, restricted = false) {
            let cursor = base;
            for (const field of fields) {
                if (field.offset !== undefined) cursor = typeof field.offset === 'number' && (field.offsetBase === 'frame' || base !== null) ? (field.offsetBase === 'frame' ? 0 : base) + field.offset : null;
                if (field.framingRole) {
                    if (field.type !== 'fixed' || cursor === null || field.condition !== undefined || restricted || field.count !== undefined)
                        fail('schema', 'Framing bytes require a fixed, unconditional position', { nodeId: field.id });
                    if (field.framingRole === 'sync') {
                        if (compiled.sync && (compiled.sync.offset !== cursor || String(compiled.sync.bytes) !== String(field.bytes)))
                            fail('ambiguity', 'Conflicting synchronization anchors', { nodeId: field.id });
                        compiled.sync = { offset: cursor, bytes: field.bytes };
                        if (!cursor) framing.header = field.bytes.slice();
                    } else if (field.framingRole === 'end') {
                        if (framing.fixedLength && cursor + field.bytes.length !== framing.fixedLength)
                            fail('schema', 'End framing bytes must terminate the frame', { nodeId: field.id });
                        framing.footer = field.bytes.slice(); compiled.fieldFooter = true;
                    } else fail('schema', 'Unknown framing role', { nodeId: field.id });
                }
                const childRestricted = restricted || field.condition !== undefined || field.count !== undefined || ['choice','repeat','tlv'].includes(field.type);
                if (field.fields) walk(field.fields, cursor, childRestricted);
                if (field.headerFields) walk(field.headerFields, cursor, true);
                for (const branch of field.branches || []) walk(branch.fields, cursor, true);
                const size = scalarWidth(field) ?? (field.type === 'fixed' ? field.bytes.length : typeof field.length === 'number' ? field.length : null);
                cursor = cursor === null || size === null || field.count !== undefined ? null : cursor + size;
            }
        }
        walk(compiled.headerFields, 0);
        for (const message of compiled.rootMessages) walk(message.fields, compiled.schema.payloadOffset || 0);
    }
    function checksumOrder(compiled, bytes, context) {
        const nodes = compiled.checksums.map(config => ({ config, ...checksumPositions(config, bytes, context) }));
        const overlaps = (a, b, c, d) => a < d && c < b;
        for (const node of nodes) {
            if (node.start > node.end || node.offset + node.config.width / 8 > bytes.length)
                fail('schema', 'Invalid checksum range or storage', { nodeId: node.config.id });
            if (overlaps(node.start, node.end, node.offset, node.offset + node.config.width / 8))
                fail('dependency', 'Checksum range includes its own storage', { nodeId: node.config.id });
            for (const other of nodes) if (other !== node && overlaps(node.offset, node.offset + node.config.width / 8, other.offset, other.offset + other.config.width / 8))
                fail('overlap', 'Checksum storage overlaps another checksum', { nodeId: node.config.id });
        }
        const result = [], visiting = new Set(), complete = new Set();
        function visit(node) {
            if (complete.has(node)) return;
            if (visiting.has(node)) fail('dependency', 'Cyclic checksum dependencies', { nodeId: node.config.id });
            visiting.add(node);
            for (const other of nodes) if (other !== node && overlaps(node.start, node.end, other.offset, other.offset + other.config.width / 8)) visit(other);
            visiting.delete(node); complete.add(node); result.push(node.config);
        }
        nodes.forEach(visit); return result;
    }
    function validateAutoWriters(compiled) {
        const schema = compiled.schema, framing = compiled.framing, length = framing.fixedLength;
        const staticPosition = value => typeof value === 'number' && (value >= 0 || length) ? value < 0 ? length + value : value : null;
        const writers = [];
        if (framing.header?.length) writers.push({ start: 0, end: framing.header.length, id: 'header', fixedBytes: framing.header });
        if (framing.footer?.length && length) writers.push({ start: length - framing.footer.length, end: length, id: 'footer', fixedBytes: framing.footer });
        for (const [kind, config] of [['length',framing.length],['command',schema.command]]) if (config)
            writers.push({ start: config.offset, end: config.offset + TYPES[config.type][0], id: kind });
        for (const config of compiled.checksums) {
            const offset = staticPosition(config.offset ?? -config.width / 8);
            if (offset !== null) writers.push({ start: offset, end: offset + config.width / 8, id: config.id });
        }
        for (const writer of writers) {
            for (const other of writers) if (other !== writer && writer.start < other.end && other.start < writer.end)
                fail('overlap', 'Automatic writers overlap', { nodeId: writer.id, byteOffset: writer.start, endByte: writer.end });
            if (schema.schemaVersion >= 2) for (const other of compiled.layoutWrites) if (writer.start < other.end && other.start < writer.end) {
                if (writer.fixedBytes && other.start === writer.start && other.end === writer.end && other.field.type === 'fixed' && String(other.field.bytes) === String(writer.fixedBytes)) continue;
                fail('overlap', 'Field overlaps automatic writer storage', { nodeId: other.field.id, byteOffset: other.start, endByte: other.end });
            }
        }
        const decidable = compiled.checksums.every(config => ['start','end','offset'].every(key =>
            staticPosition(config[key] ?? (key === 'start' ? 0 : -config.width / 8)) !== null));
        if (decidable && compiled.checksums.length) {
            const size = length || Math.max(...compiled.checksums.map(config => Math.max(config.end, config.offset + config.width / 8)));
            checksumOrder(compiled, { length: size }, { FRAME_LENGTH: size });
        } else if (compiled.checksums.length) compiled.diagnostics.push({ severity: 'warning', code: 'dynamic-dependency',
            message: 'Checksum positions depend on frame length or fields; dependencies are validated during encoding.' });
    }
    function reflect(value, width) {
        let output = 0n, input = BigInt(value);
        for (let bit = 0; bit < width; bit++) { output = output << 1n | input & 1n; input >>= 1n; }
        return output;
    }
    function checksum(bytes, config) {
        bytes = bytesOf(bytes);
        const width = config.width || Number(String(config.type).replace('crc', '')) || 8;
        if (![8, 16, 32].includes(width)) fail('checksum', 'Unsupported checksum width');
        const mask = (1n << BigInt(width)) - 1n;
        let value = BigInt(config.init ?? 0) & mask;
        if (config.type === 'sum' || config.type === 'xor') {
            for (const byte of bytes) value = config.type === 'sum' ? value + BigInt(byte) & mask : value ^ BigInt(byte);
        } else {
            const reflected = config.reflectIn === true || config.reflected === true;
            const polynomial = reflected ? reflect(config.polynomial, width) : BigInt(config.polynomial);
            const top = 1n << BigInt(width - 1);
            for (const byte of bytes) {
                value ^= BigInt(byte) << BigInt(reflected ? 0 : width - 8);
                for (let bit = 0; bit < 8; bit++) value = reflected
                    ? value & 1n ? value >> 1n ^ polynomial : value >> 1n
                    : value & top ? value << 1n ^ polynomial : value << 1n;
                value &= mask;
            }
            const reflectOut = config.reflectOut ?? reflected;
            if (reflectOut !== reflected) value = reflect(value, width);
        }
        return Number((value ^ BigInt(config.xorOut ?? 0)) & mask);
    }
    function position(tree, context, length) {
        let value = evaluate(tree, context);
        if (value < 0) value += length;
        return bounded(value, length, 'Byte position');
    }
    function scalarRead(bytes, field, offset, compiled) {
        const type = baseType(field), spec = TYPES[type];
        if (type === 'bitfield') {
            if (offset < 0 || offset + field.byteLength > bytes.length) fail('truncated', `Truncated ${field.name}`);
            const part = bytes.subarray(offset, offset + field.byteLength), digits = [];
            for (let index = 0; index < part.length; index++) digits.push(part[little(field, compiled) ? part.length - index - 1 : index].toString(16).padStart(2, '0'));
            const value = BigInt('0x' + digits.join(''));
            return field.byteLength <= 6 ? Number(value) : value;
        }
        if (!spec || offset < 0 || offset + spec[0] > bytes.length) fail('truncated', `Truncated ${field.name || type}`);
        const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)[spec[1]](offset, little(field, compiled));
        return type === 'bool' ? value !== 0 : value;
    }
    function exactInteger(value, name) {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('value', `${name} requires an exact integer string or BigInt`);
        if (typeof value === 'string' && !value.trim() || value === null || value === undefined) fail('value', `Invalid integer: ${name}`);
        try {
            if (typeof value === 'string' && /^[+-]0x[\da-f]+$/i.test(value.trim())) return (value.trim()[0] === '-' ? -1n : 1n) * BigInt(value.trim().slice(1));
            return BigInt(value);
        } catch { fail('value', `Invalid integer: ${name}`); }
    }
    function scalarWrite(bytes, field, offset, input, compiled) {
        const type = baseType(field), spec = TYPES[type];
        if (type === 'bitfield') {
            if (offset < 0 || offset + field.byteLength > bytes.length) fail('bounds', 'Encoded bit group exceeds maximum length');
            const value = exactInteger(input, field.name);
            if (value < 0n || value >= 1n << BigInt(field.byteLength * 8)) fail('value', `Bit group overflow: ${field.name}`);
            const digits = value.toString(16).padStart(field.byteLength * 2, '0');
            for (let index = 0; index < field.byteLength; index++) bytes[offset + (little(field, compiled) ? field.byteLength - index - 1 : index)] = parseInt(digits.slice(index * 2, index * 2 + 2), 16);
            return;
        }
        if (offset < 0 || offset + spec[0] > bytes.length) fail('bounds', 'Encoded frame exceeds maximum length');
        let value = input;
        if (field.enum && typeof value === 'string' && !/^[-+]?(?:\d+|0x[\da-f]+)$/i.test(value.trim())) {
            const entry = Object.entries(field.enum).find(([, label]) => label === value);
            if (!entry) fail('value', `Unknown enum label: ${value}`);
            value = entry[0];
        }
        if (type === 'bool') {
            if (![true, false, 0, 1, '0', '1'].includes(value)) fail('value', `${field.name} requires a boolean`);
            value = value === true || value === 1 || value === '1' ? 1 : 0;
        } else if (type.includes('64') && !type.startsWith('float')) {
            value = exactInteger(value, field.name);
            const bits = BigInt(spec[0] * 8), signed = type.startsWith('int');
            const minimum = signed ? -(1n << bits - 1n) : 0n, maximum = signed ? (1n << bits - 1n) - 1n : (1n << bits) - 1n;
            if (value < minimum || value > maximum) fail('value', `Integer overflow: ${field.name}`);
        } else {
            if (typeof value === 'string' && !value.trim()) fail('value', `Empty numeric value: ${field.name}`);
            value = typeof value === 'string' && /^[+-]0x[\da-f]+$/i.test(value.trim()) ? Number(exactInteger(value, field.name)) : Number(value);
            if (!Number.isFinite(value)) fail('value', `Non-finite value: ${field.name}`);
            if (type === 'float32' && !Number.isFinite(Math.fround(value))) fail('value', `Float32 overflow: ${field.name}`);
            if (!type.startsWith('float')) {
                const bits = spec[0] * 8, signed = type.startsWith('int');
                if (!Number.isInteger(value) || value < (signed ? -(2 ** (bits - 1)) : 0) || value > (signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1))
                    fail('value', `Integer overflow: ${field.name}`);
            }
        }
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)[spec[2]](offset, value, little(field, compiled));
    }
    function framingLength(bytes, compiled) {
        const framing = compiled.framing;
        if (compiled.frameLengthExpression) {
            const rule = compiled.frameLengthExpression;
            if (bytes.length < rule.minimum) return null;
            const context = Object.create(null);
            for (const input of rule.inputs) context[input.variable] = scalarRead(bytes, input.field, input.offset, compiled);
            return bounded(evaluate(rule.tree, context), compiled.maxLength, 'Whole frame length', rule.minimum);
        }
        if (framing.fixedLength) return framing.fixedLength;
        if (framing.length) {
            const field = framing.length;
            if (bytes.length < field.offset + TYPES[field.type][0]) return null;
            return Number(scalarRead(bytes, field, field.offset, compiled)) * (field.unit ?? 1) + (field.adjustment || 0);
        }
        if (compiled.unified) {
            let end = null;
            if (compiled.needsEndBoundary && framing.footer?.length) {
                const start = (compiled.sync?.offset ?? 0) + (compiled.sync?.bytes.length ?? 0);
                for (let at = start; at + framing.footer.length <= bytes.length; at++)
                    if (framing.footer.every((byte, index) => bytes[at + index] === byte)) { end = at + framing.footer.length; break; }
                if (end === null) return null;
            }
            const result = scanUnifiedFrame(bytes, compiled, end);
            return result?.end ?? null;
        }
        const footer = framing.footer;
        const minimum = Math.max(compiled.schema.payloadOffset || 0, framing.header?.length || 0);
        for (let start = minimum; start <= bytes.length - footer.length; start++) {
            if (footer.every((byte, i) => bytes[start + i] === byte)) return start + footer.length;
        }
        return null;
    }
    function checksumPositions(config, bytes, context) {
        return { start: position(config.startExpression, context, bytes.length),
            end: position(config.endExpression, context, bytes.length),
            offset: position(config.offsetExpression, context, bytes.length) };
    }
    function validateFrame(bytes, compiled, framingState = null, work = null) {
        const framing = compiled.framing;
        if (framing.header && !framing.header.every((byte, i) => bytes[i] === byte)) fail('header', 'Invalid frame header');
        if (!bytes.length || bytes.length > compiled.maxLength) fail('length', 'Frame length exceeds limit');
        const expected = framingState?.recheckLength ? framingLength(bytes, compiled) : framingState?.length ?? framingLength(bytes, compiled);
        if (expected === null || expected !== bytes.length) fail('length', 'Frame length does not match framing');
        if (framing.footer && !framing.footer.every((byte, i) => bytes[bytes.length - framing.footer.length + i] === byte))
            fail('footer', 'Invalid frame footer');
        const context = { FRAME_LENGTH: bytes.length };
        if (compiled.sync && !compiled.sync.bytes.every((byte, index) => bytes[compiled.sync.offset + index] === byte)) fail('fixed', 'Invalid synchronization bytes');
        for (const config of compiled.checksums) {
            const { start, end, offset } = checksumPositions(config, bytes, context);
            if (start > end || offset + config.width / 8 > bytes.length) fail('schema', 'Invalid checksum range or storage');
            const expectedSum = checksum(bytes.subarray(start, end), config);
            const actual = scalarRead(bytes, { ...config, type: `uint${config.width}` }, offset, compiled);
            if (expectedSum !== actual) fail('checksum', `Invalid checksum: ${config.id}`);
        }
        let layout = framingState?.layout;
        if (compiled.unified && (compiled.fieldChecksums.length || compiled.rules?.length)) {
            layout ??= scanUnifiedFrame(bytes, compiled, bytes.length, work);
            if (!layout) fail('length', 'Incomplete whole-frame field layout');
            for (const node of fieldChecksumRanges(compiled, layout.spans, bytes.length)) {
                const expected = checksum(bytes.subarray(node.start, node.end), node.config);
                if (cachedScalar(bytes, node.field, node.offset, compiled, layout, work) !== expected) fail('checksum', `Invalid checksum: ${node.fieldId}`, { nodeId: node.fieldId });
            }
        }
        return layout;
    }
    function selectMessage(messages, command, length) {
        const matches = messages.filter(message => message.command === command || message.commandRange &&
            command >= message.commandRange[0] && command <= message.commandRange[1]);
        let candidates = matches.filter(message => message.length === length);
        if (!candidates.length) candidates = matches.filter(message => message.length === undefined);
        if (!candidates.length) candidates = matches;
        if (candidates.length > 1) fail('ambiguity', 'Multiple messages match this command and length', { nodeId: candidates[0].id });
        return candidates[0];
    }
    // Deferred replay checks statically located fixed bytes without constructing
    // typed fields, arrays, text, or numeric outputs. Dynamic layout diagnostics
    // remain the worker decoder's responsibility; invalid layouts retain frames.
    function staticFixedWarnings(bytes, compiled, payloadStart, payloadEnd) {
        const warnings = [];
        let budget = LIMITS.fields * 4;
        function width(field) {
            if (field.condition !== undefined || field.count !== undefined && typeof field.count !== 'number') return null;
            const size = scalarWidth(field) ?? (field.type === 'fixed' ? field.bytes.length :
                typeof field.length === 'number' ? field.length : null);
            return size === null ? null : size * (field.count ?? 1);
        }
        function walk(fields, base, end, prefix) {
            let cursor = base;
            for (const field of fields) {
                if (--budget < 0) return;
                if (field.offset !== undefined) cursor = typeof field.offset === 'number' && (field.offsetBase === 'frame' || base !== null)
                    ? (field.offsetBase === 'frame' ? 0 : base) + field.offset : null;
                const path = prefix ? `${prefix}.${field.name}` : field.name, size = width(field);
                if (cursor !== null && field.condition === undefined && (field.count === undefined || typeof field.count === 'number')) {
                    if (field.type === 'fixed') for (let index = 0; index < (field.count ?? 1) && --budget >= 0; index++) {
                        const offset = cursor + index * field.bytes.length;
                        if (offset < base || offset + field.bytes.length > end || !field.bytes.every((byte, i) => bytes[offset + i] === byte))
                            warnings.push({ severity: 'error', code: offset + field.bytes.length > end ? 'truncated' : 'fixed',
                                message: `Invalid fixed bytes: ${path}`, nodeId: field.id, path, byteOffset: offset, endByte: Math.min(end, offset + field.bytes.length) });
                    }
                    else if (field.type === 'struct' && field.count === undefined)
                        walk(field.fields, cursor, typeof field.length === 'number' ? Math.min(end, cursor + field.length) : end, path);
                }
                cursor = cursor === null || size === null ? null : cursor + size;
            }
        }
        walk(compiled.headerFields, 0, bytes.length, 'header');
        const schema = compiled.schema;
        try {
            const command = schema.command ? scalarRead(bytes, schema.command, schema.command.offset, compiled) : compiled.rootMessages[0].command;
            const message = selectMessage(compiled.rootMessages, command, payloadEnd - payloadStart);
            if (message) walk(message.fields, payloadStart, payloadEnd, '');
        } catch (error) {
            if (!(error instanceof ProtocolError)) throw error;
            warnings.push({ severity: 'error', code: error.code, message: error.message, nodeId: error.nodeId });
        }
        return warnings;
    }
    function decode(bytes, input, { maxFields = LIMITS.fields * 4 } = {}) {
        return decodeFrame(bytesOf(bytes), compile(input), maxFields);
    }
    function decodeFrame(bytes, compiled, maxFields, framingState = null, work = null) {
        const layout = validateFrame(bytes, compiled, framingState, work);
        bounded(maxFields, LIMITS.fields * 4, 'Decoded field limit', 1);
        const schema = { ...compiled.schema, framing: compiled.framing }, payloadStart = schema.payloadOffset || 0;
        const payloadEnd = schema.payloadEnd === undefined ? bytes.length - (compiled.fieldFooter ? 0 : schema.framing.footer?.length || 0)
            : schema.payloadEnd < 0 ? bytes.length + schema.payloadEnd : schema.payloadEnd;
        if (payloadEnd < payloadStart || payloadEnd > bytes.length) fail('length', 'Payload is outside frame');
        const record = { protocolId: compiled.id, messageId: null, messageName: '', name: '', known: false,
            fields: {}, header: {}, values: {}, flatFields: [], spans: [], warnings: [], valid: true,
            rawPayload: bytes.slice(payloadStart, payloadEnd), payloadOffset: payloadStart,
            payloadLength: payloadEnd - payloadStart, frameLength: bytes.length };
        const context = { FRAME_LENGTH: bytes.length, PAYLOAD_LENGTH: record.payloadLength, SEQ: 0, SEQUENCE: 0 };
        function warn(code, message, details = {}) {
            if (!['text-decode','unknown-command','unknown-subcommand','document-conflict','extra-bytes'].includes(code)) record.valid = false;
            record.warnings.push({ severity: record.valid ? 'warning' : 'error', code, message, ...details }); }
        function add(field, path, value, offset, length, extra = {}) {
            if (record.flatFields.length >= maxFields) fail('field-limit', 'Decoded record exceeds its field budget');
            const item = { fieldId: field.id, path, name: field.name, value, numeric: numeric(value),
                byteOffset: offset, endByte: offset + length, type: field.type, ...extra };
            if (field.displayBase !== undefined) item.displayBase = field.displayBase;
            if (field.enum) {
                if (field.type === 'enum') item.baseType = field.baseType;
                const key = typeof value === 'boolean' && !Object.hasOwn(field.enum, String(value)) ? String(Number(value)) : String(value);
                if (Object.hasOwn(field.enum, key)) item.label = field.enum[key];
            }
            record.flatFields.push(item); record.spans.push(item); record.values[path] = value;
        }
        function retainTail(field, target, cursor, end, path) {
            if (cursor >= end) return;
            const raw = bytes.slice(cursor, end); target._unknownTail = raw;
            if (field.leftover === 'exact') fail('boundary', `Segment ${path} was not consumed exactly`);
            if (field.leftover === 'padding') {
                if (raw.some(byte => byte !== (field.paddingByte ?? 0))) fail('padding', `Invalid padding in ${path}`);
            } else warn('extra-bytes', `${end - cursor} unknown segment bytes retained`, { nodeId: field.id, path, byteOffset: cursor, endByte: end });
        }
        let decodedCount = 0;
        const lengths = compiled.usesLengthFunction ? new Map() : null;
        if (lengths) context[LEN_CONTEXT] = lengthScope(lengths, '', null, compiled.rootMessages[0]?.fields ?? []);
        function readFields(fields, target, base, end, prefix, rootContext, strict = false) {
            let cursor = base;
            const len = lengths && lengthScope(lengths, prefix, rootContext[LEN_CONTEXT], fields);
            for (const field of fields) {
                const priorCursor = cursor;
                if (++decodedCount > LIMITS.fields * 4) fail('bounds', 'Decoded field count limit exceeded');
                const local = { ...rootContext, ...target, PARENT: rootContext, CURRENT: target, PARENT_REMAINING: rootContext.REMAINING ?? end - base, REMAINING: Math.max(0, end - cursor),
                    SEQ: context.SEQ, SEQUENCE: context.SEQUENCE, [LEN_CONTEXT]: len };
                const path = prefix ? `${prefix}.${field.name}` : field.name;
                try {
                    if (field.expressions.condition && !evaluate(field.expressions.condition, local)) continue;
                    if (field.expressions.offset) cursor = (field.offsetBase === 'frame' ? 0 : base) + bounded(evaluate(field.expressions.offset, local), compiled.maxLength, 'Field offset');
                    if (cursor < base || cursor > end) fail('boundary', 'Field offset is outside its containing segment');
                    const fieldStart = cursor;
                    lengthBoundaryContext(field, local, cursor, end, compiled);
                    const delimitedLength = field.endBytes ? layout?.boundaries.get(field)?.get(cursor) ?? boundaryLength(bytes, field, cursor, end) : undefined;
                    if (field.endBytes && delimitedLength === null) fail('boundary', 'Variable field end delimiter is missing', { nodeId: field.id });
                    const evaluation = boundaryEvaluationContext(field, local);
                    const fieldLength = delimitedLength ?? (field.expressions.length ? bounded(evaluate(field.expressions.length, evaluation), compiled.maxLength, 'Field length')
                        : field.expressionBoundaryRepeat ? bounded(evaluation.REMAINING, compiled.maxLength, 'Repeat length') : undefined);
                    const container = ['repeat','tlv'].includes(field.type);
                    if (container) {
                        const segmentEnd = fieldLength !== undefined ? cursor + fieldLength : end;
                        if (segmentEnd > end) fail('truncated', `Truncated ${path}`);
                        const items = [], count = field.expressions.count ? bounded(evaluate(field.expressions.count, local), LIMITS.array, 'Repeat count') : LIMITS.array;
                        target[field.name] = items;
                        for (let index = 0; index < count && (field.until !== 'end' || cursor < segmentEnd); index++) {
                            if (++decodedCount > LIMITS.fields * 4) fail('bounds', 'Decoded field count limit exceeded');
                            const start = cursor, item = {}, itemPath = `${path}[${index}]`, itemContext = { ...local, INDEX: index };
                            if (field.type === 'tlv') {
                                const valueStart = readFields(field.headerFields, item, start, segmentEnd, itemPath, itemContext, true);
                                const size = bounded(item[field.lengthField], compiled.maxLength, 'TLV item length');
                                const itemEnd = (field.lengthIncludesHeader ? start : valueStart) + size * (field.lengthUnit ?? 1) + (field.lengthAdjustment ?? 0);
                                if (!Number.isSafeInteger(itemEnd) || itemEnd < valueStart || itemEnd <= start || itemEnd > segmentEnd)
                                    fail('boundary', 'TLV item length escapes its container', { byteOffset: start, endByte: segmentEnd });
                                const branch = chooseBranch(field, { ...itemContext, ...item });
                                if (branch && !(branch.default && !branch.fields.length)) {
                                    const valueEnd = readFields(branch.fields, item, valueStart, itemEnd, itemPath, { ...itemContext, ...item }, field.invalidItem !== 'skip');
                                    retainTail(field, item, valueEnd, itemEnd, itemPath);
                                } else { item.rawPayload = bytes.slice(valueStart, itemEnd); add(field, `${itemPath}.rawPayload`, item.rawPayload, valueStart, itemEnd - valueStart); }
                                cursor = itemEnd;
                            } else cursor = readFields(field.fields, item, start, segmentEnd, itemPath, itemContext, true);
                            if (cursor <= start) fail('progress', 'Repeated item made no byte progress');
                            lengths?.set(itemPath, cursor - start);
                            items.push(item);
                        }
                        if (field.until === 'end' && cursor < segmentEnd) fail('bounds', 'Repeat count limit exceeded');
                        target[field.name] = items;
                        if (fieldLength !== undefined) {
                            if (cursor < segmentEnd) {
                                const tail = {};
                                target._segmentTails ??= {}; target._segmentTails[field.name] = bytes.slice(cursor, segmentEnd);
                                retainTail(field, tail, cursor, segmentEnd, path);
                            }
                            cursor = segmentEnd;
                        }
                        lengths?.set(path, cursor - fieldStart); continue;
                    }
                    const count = field.expressions.count ? bounded(evaluate(field.expressions.count, local), LIMITS.array, 'Array count') : 1;
                    const array = field.count !== undefined, values = [];
                    for (let index = 0; index < count; index++) {
                        if (++decodedCount > LIMITS.fields * 4) fail('bounds', 'Decoded field count limit exceeded');
                        const itemPath = array ? `${path}[${index}]` : path;
                        const start = cursor; let value;
                        if (field.type === 'struct' || field.type === 'choice') {
                            const segmentEnd = fieldLength !== undefined ? cursor + fieldLength : end;
                            if (segmentEnd > end) fail('truncated', `Truncated ${itemPath}`);
                            value = field.inline ? target : {};
                            const branch = field.type === 'choice' ? chooseBranch(field, { ...local, REMAINING: field.expressionBoundaryScope ? local.REMAINING : segmentEnd - cursor }) : null;
                            if (field.type === 'choice' && !branch) fail('condition', `No branch matches ${itemPath}`);
                            if (field.type === 'choice' && field.selectorExpression) record.command ??= evaluate(field.selectorExpression, local);
                            if (branch?.legacyMessage) {
                                const selected = branch.legacyMessage;
                                if (record.messageId && record.messageId !== compiled.rootMessages[0].id) { record.parentMessageId ??= record.messageId; record.subcommand = evaluate(field.selectorExpression, local); }
                                record.messageId = selected.id; record.messageName = record.name = selected.name || selected.id; record.known = true;
                                for (const detail of selected.conflicts || []) warn('document-conflict', detail);
                            } else if (branch?.legacyUnknown === 'command') {
                                record.messageId = `${compiled.id}.unknown.${record.command}`; record.messageName = record.name = `Unknown 0x${Number(record.command || 0).toString(16)}`;
                                record.known = false; warn('unknown-command', record.messageName);
                            } else if (branch?.legacyUnknown === 'subcommand') warn('unknown-subcommand', 'Unknown nested command');
                            cursor = readFields(branch ? branch.fields : field.fields, value, cursor, segmentEnd, field.inline ? prefix : itemPath, { ...local, INDEX: index }, strict);
                            if (fieldLength !== undefined) { retainTail(field, value, cursor, segmentEnd, itemPath); cursor = segmentEnd; }
                            // Unbounded containers end after their selected fields, not at
                            // the enclosing frame end (which can still contain a CRC).
                            const actualLength = cursor - start;
                            if (field.legacyPayload) {
                                record.rawPayload = bytes.slice(start, cursor); record.payloadOffset = start; record.payloadLength = actualLength;
                            }
                            const selected = branch?.legacyMessage;
                            if (selected?.length !== undefined && actualLength !== selected.length)
                                warn('payload-length', 'Payload length differs from the selected layout', { nodeId: branch.id });
                            if (selected?.maxLength !== undefined && actualLength > selected.maxLength)
                                warn('payload-limit', 'Payload exceeds the selected layout limit', { nodeId: branch.id });
                        } else if (field.type === 'fixed') {
                            if (cursor + field.bytes.length > end) fail('truncated', `Truncated ${itemPath}`);
                            value = bytes.slice(cursor, cursor + field.bytes.length);
                            if (!field.bytes.every((byte, index) => value[index] === byte)) fail('fixed', `Invalid fixed bytes: ${itemPath}`);
                            cursor += field.bytes.length; add(field, itemPath, value, start, cursor - start);
                        } else if (field.type === 'bytes' || field.type === 'reserved' || field.type === 'string') {
                            const length = fieldLength ?? end - cursor;
                            if (cursor + length > end) fail('truncated', `Truncated ${path}`);
                            const part = bytes.slice(cursor, cursor + length); cursor += length;
                            if (field.type === 'bytes' || field.type === 'reserved') value = part;
                            else {
                                if (textCodec) {
                                    const decoder = new textCodec.MappedTextDecoder(field.encoding || 'utf-8');
                                    const tokens = [...decoder.write(part, 0), ...decoder.flush()];
                                    value = tokens.map(token => token.text).join('');
                                    if (tokens.some(token => token.invalid)) warn('text-decode', `Invalid text encoding in ${itemPath}`, { path: itemPath });
                                } else value = new TextDecoder(field.encoding || 'utf-8').decode(part);
                                if (field.trimNull !== false) value = value.replace(/\0+$/g, '');
                            }
                            add(field, itemPath, value, start, cursor - start);
                        } else {
                            const width = scalarWidth(field);
                            if (cursor + width > end) fail('truncated', `Truncated ${path}`);
                            value = cachedScalar(bytes, field, cursor, compiled, layout, work); cursor += width;
                            add(field, itemPath, value, start, width);
                            if (field.bits) {
                                for (const bit of field.bits) {
                                    let sliced = BigInt(value) >> BigInt(bit.offset) & (1n << BigInt(bit.length)) - 1n;
                                    if (bit.type === 'int' && sliced & 1n << BigInt(bit.length - 1)) sliced -= 1n << BigInt(bit.length);
                                    const bitValue = bit.type === 'bool' ? sliced !== 0n : bit.length <= 53 ? Number(sliced) : sliced;
                                    const byte = little(field, compiled) ? start + Math.floor(bit.offset / 8)
                                        : start + width - Math.ceil((bit.offset + bit.length) / 8);
                                    add({ ...bit, displayBase: field.displayBase ?? 'dec' }, `${itemPath}.${bit.name}`, bitValue, byte,
                                        Math.ceil(((bit.offset % 8) + bit.length) / 8), { bitOffset: bit.offset, bitLength: bit.length });
                                    if (bit.type === 'reserved') record.flatFields[record.flatFields.length - 1].numeric = null;
                                }
                            }
                        }
                        lengths?.set(itemPath, cursor - start); values.push(value);
                    }
                    lengths?.set(path, cursor - fieldStart);
                    if (!field.inline) target[field.name] = array ? values : values[0];
                    if (field.valueSource === 'SEQ') { context.SEQ = context.SEQUENCE = values[0]; rootContext.SEQ = rootContext.SEQUENCE = values[0]; }
                    if (field.legacyHeader && values[0]) Object.assign(rootContext, values[0], { HEADER: values[0] });
                    if (field.expectedBytes && !field.expectedBytes.every((byte, index) => bytes[fieldStart + index] === byte)) fail('fixed', 'Fixed field content does not match', { nodeId: field.id });
                    if (field.legacyOverlay) cursor = priorCursor;
                } catch (error) {
                    if (!(error instanceof ProtocolError)) throw error;
                    if (error.code === 'field-limit' || strict) throw error;
                    warn(error.code, error.message, { path, nodeId: error.nodeId || field.id, byteOffset: cursor, endByte: end });
                    break;
                }
            }
            return cursor;
        }
        readFields(compiled.headerFields, record.header, 0, bytes.length, 'header', context);
        Object.assign(context, record.header, { HEADER: record.header });
        record.command = schema.command ? cachedScalar(bytes, schema.command, schema.command.offset, compiled, null, work)
            : compiled.rootMessages[0].command;
        const message = selectMessage(compiled.rootMessages, record.command, record.payloadLength);
        if (!message) {
            record.messageId = `${compiled.id}.unknown.${record.command}`;
            record.messageName = record.name = `Unknown 0x${Number(record.command || 0).toString(16)}`;
            record.fields.rawPayload = record.rawPayload;
            warn('unknown-command', record.messageName);
            if (!record.valid) for (const field of record.flatFields) field.numeric = null;
            return record;
        }
        record.known = true;
        function readMessage(selected, target, start, end, prefix) {
            record.messageId = selected.id; record.messageName = record.name = selected.name;
            if (selected.conflicts) for (const detail of selected.conflicts) warn('document-conflict', detail, { messageId: selected.id });
            if (selected.length !== undefined && end - start !== selected.length)
                warn('payload-length', `Expected ${selected.length} payload bytes, received ${end - start}`, { expected: selected.length, actual: end - start });
            if (selected.maxLength !== undefined && end - start > selected.maxLength)
                warn('payload-limit', `Payload exceeds ${selected.maxLength} byte message limit`, { expected: selected.maxLength, actual: end - start });
            let cursor = readFields(selected.fields, target, start, end, prefix, { ...context, ...record.fields });
            if (selected.dispatch) {
                const dispatch = selected.dispatch, subcommand = lookup(target, dispatch.field);
                const childStart = start + bounded(evaluate(dispatch.offsetExpression, { ...context, ...target }), compiled.maxLength, 'Dispatch offset');
                if (childStart > end) { warn('truncated', 'Nested dispatch header is incomplete'); return; }
                record.parentMessageId ??= selected.id; record.subcommand = subcommand;
                const child = selectMessage(dispatch.messages, subcommand, end - childStart);
                const content = dispatch.name || 'content'; target[content] = {};
                if (child) readMessage(child, target[content], childStart, end, prefix ? `${prefix}.${content}` : content);
                else {
                    target[content].rawPayload = bytes.slice(childStart, end);
                    warn('unknown-subcommand', `Unknown subcommand 0x${Number(subcommand || 0).toString(16)}`);
                }
                cursor = end;
            }
            if (cursor < end) {
                target._unknownTail = bytes.slice(cursor, end);
                warn('extra-bytes', `${end - cursor} unknown trailing bytes retained`, { byteOffset: cursor, endByte: end });
            }
        }
        readMessage(message, record.fields, payloadStart, payloadEnd, '');
        if (compiled.rules?.length) applyRuleResults(record, [
            ...evaluateRules(bytes, compiled, layout.spans, 'parsing'),
            ...evaluateRules(bytes, compiled, layout.spans, 'validation')
        ]);
        const headerNode = compiled.unified && compiled.rootMessages[0].fields.find(field => field.legacyHeader);
        if (headerNode) { record.header = record.fields[headerNode.name] ?? {}; delete record.fields[headerNode.name]; }
        if (!record.valid) for (const field of record.flatFields) field.numeric = null;
        return record;
    }
    function encodeText(text, encoding) {
        const name = textCodec ? textCodec.normalizeTextEncoding(encoding || 'utf-8') : (encoding || 'utf-8');
        if (name === 'utf-8') return new TextEncoder().encode(String(text));
        if (name === 'ascii') {
            const chars = [...String(text)];
            if (chars.some(char => char.codePointAt(0) > 127)) fail('encoding', 'ASCII text contains non-ASCII characters');
            return Uint8Array.from(chars.map(char => char.charCodeAt(0)));
        }
        if (name === 'utf-16le' || name === 'utf-16be') {
            const str = String(text), output = new Uint8Array(str.length * 2), view = new DataView(output.buffer);
            for (let i = 0; i < str.length; i++) view.setUint16(i * 2, str.charCodeAt(i), name === 'utf-16le');
            return output;
        }
        // Match the existing textEncoder.js repertoire and codec corrections.
        // Maps are cached per charset; each finite table is built once.
        const pointerBytes = pointer => {
            const fourth = pointer % 10 + 0x30; pointer = Math.floor(pointer / 10);
            const third = pointer % 126 + 0x81; pointer = Math.floor(pointer / 126);
            return [Math.floor(pointer / 10) + 0x81, pointer % 10 + 0x30, third, fourth];
        };
        if (!legacyEncodingMaps.has(name)) {
            const decoder = new TextDecoder(name, { fatal: true, ignoreBOM: true }), map = new Map();
            const add = part => {
                try { const char = decoder.decode(Uint8Array.from(part)); if (char && !map.has(char)) map.set(char, part); }
                catch { /* Invalid sequences do not have an inverse mapping. */ }
            };
            for (let first = 0; first < 256; first++) add([first]);
            if (name === 'windows-1252') {
                const special = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
                for (let index = 0; index < special.length; index++) {
                    map.delete(String.fromCharCode(0x80 + index)); map.set(special[index], [0x80 + index]);
                }
            } else {
                for (let lead = 0x81; lead <= 0xfe; lead++) {
                    if (name === 'shift_jis' && !(lead <= 0x9f || lead >= 0xe0 && lead <= 0xfc)) continue;
                    for (let trail = 0x40; trail <= 0xfe; trail++) {
                        if (trail === 0x7f || name === 'big5' && trail >= 0x7f && trail < 0xa1 ||
                            name === 'shift_jis' && trail > 0xfc) continue;
                        add([lead, trail]);
                    }
                }
                if (name === 'gb18030') {
                    for (let pointer = 0; pointer <= 39419; pointer++) add(pointerBytes(pointer));
                    map.set('€', [0xa2, 0xe3]);
                }
            }
            legacyEncodingMaps.set(name, map);
        }
        const mapping = legacyEncodingMaps.get(name), characters = Array.from(String(text)), result = [];
        for (let index = 0; index < characters.length; index++) {
            let part = index + 1 < characters.length ? mapping.get(characters[index] + characters[index + 1]) : null;
            if (part) index++;
            else part = mapping.get(characters[index]);
            const code = characters[index].codePointAt(0);
            if (!part && name === 'gb18030' && code >= 0x10000) part = pointerBytes(189000 + code - 0x10000);
            if (!part) fail('encoding', `Character cannot be encoded as ${name}: ${characters[index]}`);
            result.push(...part);
        }
        return Uint8Array.from(result);
    }
    function encode(input, messageId, fields = {}, options = {}) {
        const compiled = compile(input), schema = { ...compiled.schema, framing: compiled.framing };
        if (compiled.unified) fields = { ...fields };
        let message = compiled.messageById.get(messageId) || compiled.rootMessages.find(item => item.command === Number(messageId));
        const chosenBranches = new Map();
        if (message?.frameAlias) {
            const assign = (path, value) => { const keys = path.split('.'); let target = fields; for (const key of keys.slice(0, -1)) { target[key] = { ...target[key] }; target = target[key]; } target[keys.at(-1)] = value; };
            for (const selector of message.selectors) {
                chosenBranches.set(selector.choiceId, selector.branchId);
                const value = selector.value ?? options.command;
                if (value !== undefined && selector.path !== '0') assign(selector.path, value);
            }
            if (message.requireLayout && !options.layout) fail('layout', 'Select the legacy document layout explicitly');
            if (options.layout && options.layout !== 'detail' && !message.layouts?.[options.layout]) fail('layout', 'Unknown legacy message layout');
            message = compiled.rootMessages[0];
        }
        const headerNode = compiled.unified && compiled.rootMessages[0].fields.find(field => field.legacyHeader);
        const headerValues = { ...options.header, ...(headerNode ? fields[headerNode.name] : {}) };
        for (const field of headerNode ? headerNode.fields : compiled.headerFields) if (field.valueSource === 'SEQ') headerValues[field.name] = options.sequence ?? 0;
        if (headerNode) fields[headerNode.name] = headerValues;
        let rootMessage = message;
        const selectedChildren = new Map();
        while (rootMessage?.parent) { selectedChildren.set(rootMessage.parent, rootMessage); rootMessage = rootMessage.parent; }
        const data = new Uint8Array(compiled.maxLength), payloadStart = schema.payloadOffset || 0;
        const context = { ...fields, ...options.header, SEQUENCE: options.sequence ?? 0,
            SEQ: options.sequence ?? 0, PAYLOAD_LENGTH: compiled.unified ? compiled.framing.fixedLength ?? 0 : 0,
            FRAME_LENGTH: compiled.framing.fixedLength ?? 0, HEADER: headerValues };
        if (!compiled.unified && compiled.framing.fixedLength) context.PAYLOAD_LENGTH = compiled.framing.fixedLength - payloadStart +
            (schema.payloadEnd < 0 ? schema.payloadEnd : schema.payloadEnd === undefined ? -(compiled.framing.footer?.length || 0) : schema.payloadEnd - compiled.framing.fixedLength);
        let encodedFields = 0;
        const encodedOffsets = new Map(), written = [], fixedOverlays = [];
        const lengths = compiled.usesLengthFunction ? new Map() : null;
        if (lengths) context[LEN_CONTEXT] = lengthScope(lengths, '', null, compiled.rootMessages[0]?.fields ?? []);
        function claim(start, end, field) {
            if ((schema.schemaVersion || 1) < 2 || start === end) return;
            const overlap = written.find(range => start < range.end && end > range.start && !(compiled.unified && (field.legacyOverlay || range.field.legacyOverlay)));
            if (overlap) fail('overlap', 'Independent encoded fields overlap', { nodeId: field.id, byteOffset: start, endByte: end });
            written.push({ start, end, id: field.id, field });
        }
        function automatic(start, end, id, fixedBytes) {
            if ((schema.schemaVersion || 1) < 2) return;
            for (const range of written) if (start < range.end && range.start < end) {
                if (compiled.unified && id === 'length' && range.field.id === compiled.frameLengthField?.id) continue;
                if (compiled.unified && fixedBytes && range.start === start && range.end === end && String(range.field.expectedBytes) === String(fixedBytes)) continue;
                if (fixedBytes && range.start === start && range.end === end && range.field.type === 'fixed' && String(range.field.bytes) === String(fixedBytes)) continue;
                fail('overlap', `Automatic ${id} overwrites a field`, { nodeId: range.id, byteOffset: start, endByte: end });
            }
            written.push({ start, end, id, field: { type: 'automatic' } });
        }
        function resolveValue(target, field, path) {
            if (field.valueSource === 'SEQ') return context.SEQ;
            const direct = lookup(fields, path);
            return direct !== undefined ? direct : target?.[field.name] ?? field.default;
        }
        function writeFields(fieldList, target, base, prefix, end = compiled.maxLength, parentContext = context) {
            const len = lengths && lengthScope(lengths, prefix, parentContext[LEN_CONTEXT], fieldList);
            if (compiled.unified) {
                target = { ...target };
                for (const field of fieldList) if (field.autoLengthTargets?.length || field.autoFrameLength) target[field.name] = 0;
            }
            let cursor = base;
            for (const field of fieldList) {
                const priorCursor = cursor;
                if (++encodedFields > LIMITS.fields * 4) fail('bounds', 'Encoded field count limit exceeded');
                const local = { ...parentContext, ...target, PARENT: parentContext, CURRENT: target, PARENT_REMAINING: parentContext.REMAINING ?? end - base, REMAINING: end - cursor,
                    SEQ: context.SEQ, SEQUENCE: context.SEQUENCE, FRAME_LENGTH: context.FRAME_LENGTH, PAYLOAD_LENGTH: context.PAYLOAD_LENGTH, HEADER: context.HEADER, [LEN_CONTEXT]: len };
                const path = prefix ? `${prefix}.${field.name}` : field.name;
                if (field.expressions.condition && !evaluate(field.expressions.condition, local)) continue;
                if (field.expressions.offset) cursor = (field.offsetBase === 'frame' ? 0 : base) + bounded(evaluate(field.expressions.offset, local), compiled.maxLength, 'Field offset');
                if (cursor < base || cursor > end) fail('boundary', 'Field offset is outside its containing segment', { nodeId: field.id });
                const storage = { field, offset: cursor, path }; encodedOffsets.set(path, storage);
                const unknownFrameLength = !context.FRAME_LENGTH && typeof field.lengthFrom === 'string' && /\b(?:FRAME_LENGTH|PAYLOAD_LENGTH)\b/.test(field.lengthFrom);
                const unboundedRemaining = field.lengthFrom === 'REMAINING' && (parentContext._inferLength || end === compiled.maxLength && !context.FRAME_LENGTH);
                const inferredLength = compiled.unified && (field.autoLengthSource || field.lengthRelationCandidate && field.length === 'REMAINING' || unboundedRemaining || field.lengthFrom === 'contents' || field.legacyPayload || field.endBytes || unknownFrameLength);
                const boundedLength = !inferredLength && field.expressions.length ? bounded(evaluate(field.expressions.length, local), compiled.maxLength, 'Field length') : undefined;
                const rawValue = resolveValue(target, field, path);
                if (['repeat','tlv'].includes(field.type)) {
                    const items = rawValue ?? [], segmentEnd = boundedLength !== undefined ? cursor + boundedLength : end;
                    if (!Array.isArray(items) || items.length > LIMITS.array) fail('value', `Invalid repeat items: ${path}`);
                    if (segmentEnd > end) fail('boundary', 'Repeated segment exceeds its container');
                    const count = field.expressions.count ? bounded(evaluate(field.expressions.count, local), LIMITS.array, 'Repeat count') : items.length;
                    if (count !== items.length) fail('value', `Repeat ${path} requires exactly ${count} items`);
                    for (let index = 0; index < count; index++) {
                        if (++encodedFields > LIMITS.fields * 4) fail('bounds', 'Encoded field count limit exceeded');
                        const start = cursor, itemPath = `${path}[${index}]`, item = items[index], itemContext = { ...local, INDEX: index, _inferLength: inferredLength };
                        if (!item || typeof item !== 'object') fail('value', 'Repeated item requires an object');
                        if (field.type === 'tlv') {
                            const headerTarget = { ...item, [field.lengthField]: 0 };
                            const valueStart = writeFields(field.headerFields, headerTarget, start, itemPath, segmentEnd, itemContext);
                            const branch = chooseBranch(field, { ...itemContext, ...item });
                            if (branch && !(branch.default && !branch.fields.length)) {
                                cursor = writeFields(branch.fields, item, valueStart, itemPath, segmentEnd, { ...itemContext, ...item });
                                if (item._unknownTail) { const raw = encodeBytes(item._unknownTail, itemPath); if (cursor + raw.length > segmentEnd) fail('boundary', 'TLV tail exceeds container'); claim(cursor,cursor+raw.length,field); data.set(raw,cursor); cursor += raw.length; }
                            } else {
                                const raw = encodeBytes(item.rawPayload || [], itemPath);
                                if (valueStart + raw.length > segmentEnd) fail('boundary', 'TLV value exceeds container');
                                claim(valueStart,valueStart+raw.length,field); data.set(raw,valueStart); cursor = valueStart + raw.length;
                            }
                            const length = (cursor - (field.lengthIncludesHeader ? start : valueStart) - (field.lengthAdjustment ?? 0)) / (field.lengthUnit ?? 1);
                            if (!Number.isSafeInteger(length) || length < 0) fail('length', 'TLV length is not representable with its unit and adjustment');
                            const storage = encodedOffsets.get(`${itemPath}.${field.lengthField}`);
                            scalarWrite(data, storage.field, storage.offset, length, compiled);
                        } else cursor = writeFields(field.fields, item, cursor, itemPath, segmentEnd, itemContext);
                        if (cursor <= start) fail('progress', 'Repeated item made no byte progress');
                        lengths?.set(itemPath, cursor - start);
                    }
                    if (boundedLength !== undefined) {
                        if ((field.until === 'end' || field.leftover === 'exact') && cursor !== segmentEnd) fail('length', 'Repeat items do not fill the bounded segment');
                        const tailValue = target?._segmentTails?.[field.name];
                        if (tailValue !== undefined) {
                            const tail = encodeBytes(tailValue, `${path} tail`);
                            if (tail.length !== segmentEnd - cursor) fail('length', 'Repeated segment tail does not fill its remaining bytes');
                            if (field.leftover === 'padding' && tail.some(byte => byte !== (field.paddingByte ?? 0))) fail('padding', 'Invalid repeated segment padding');
                            claim(cursor,segmentEnd,field); data.set(tail,cursor);
                        } else if (cursor < segmentEnd) { claim(cursor,segmentEnd,field); data.fill(field.leftover === 'padding' ? field.paddingByte ?? 0 : 0,cursor,segmentEnd); }
                        cursor = segmentEnd;
                    }
                    storage.endByte = cursor; lengths?.set(path, cursor - storage.offset); continue;
                }
                const count = field.expressions.count ? bounded(evaluate(field.expressions.count, local), LIMITS.array, 'Array count') : 1;
                const array = field.count !== undefined;
                if (array && rawValue !== undefined && (!Array.isArray(rawValue) && !(rawValue instanceof Uint8Array) || rawValue.length !== count))
                    fail('value', `Array ${path} requires exactly ${count} entries`);
                for (let index = 0; index < count; index++) {
                    if (++encodedFields > LIMITS.fields * 4) fail('bounds', 'Encoded field count limit exceeded');
                    const itemPath = array ? `${path}[${index}]` : path;
                    const itemStart = cursor;
                    let value = field.inline ? target : array ? rawValue?.[index] : rawValue;
                    value ??= ['struct','choice'].includes(field.type) ? {} : field.type === 'string' ? '' : ['bytes', 'reserved'].includes(field.type) ? [] : 0;
                    if (field.type === 'struct' || field.type === 'choice') {
                        const segmentEnd = boundedLength !== undefined ? cursor + boundedLength : end;
                        if (segmentEnd > end) fail('boundary', 'Nested segment exceeds its container');
                        const branch = field.type === 'choice' ? chosenBranches.has(field.id) ? field.branches.find(item => item.id === chosenBranches.get(field.id)) : chooseBranch(field, local) : null;
                        if (field.type === 'choice' && !branch) fail('condition', `No branch matches ${itemPath}`);
                        cursor = writeFields(branch ? branch.fields : field.fields, value, cursor, field.inline ? prefix : itemPath, segmentEnd, { ...local, INDEX: index, _inferLength: inferredLength });
                        if (boundedLength !== undefined) {
                            if (field.leftover === 'exact' && cursor !== segmentEnd) fail('boundary', 'Segment was not consumed exactly');
                            if (field.leftover === 'padding' && value?._unknownTail && encodeBytes(value._unknownTail,itemPath).some(byte => byte !== (field.paddingByte ?? 0))) fail('padding', 'Invalid supplied segment padding');
                            if (value?._unknownTail) { const tail = encodeBytes(value._unknownTail,itemPath); if (cursor+tail.length>segmentEnd) fail('boundary','Nested tail exceeds segment'); claim(cursor,cursor+tail.length,field); data.set(tail,cursor); }
                            if (field.leftover === 'exact' && cursor !== segmentEnd && !value?._unknownTail) fail('boundary', 'Segment was not consumed exactly');
                            if (field.leftover === 'padding' && !value?._unknownTail) data.fill(field.paddingByte ?? 0, cursor, segmentEnd);
                            cursor = segmentEnd;
                        }
                    } else if (field.type === 'fixed') {
                        if (cursor + field.bytes.length > end) fail('boundary', 'Fixed bytes exceed container');
                        if (rawValue !== undefined && String(Array.from(encodeBytes(rawValue, path))) !== String(field.bytes)) fail('fixed', 'Supplied fixed bytes do not match the schema');
                        claim(cursor,cursor+field.bytes.length,field);
                        if (compiled.unified && field.legacyOverlay) fixedOverlays.push({ offset: cursor, bytes: field.bytes });
                        else data.set(field.bytes,cursor);
                        cursor += field.bytes.length;
                    } else if (field.type === 'bytes' || field.type === 'reserved' || field.type === 'string') {
                        const part = field.type === 'string' ? encodeText(value, field.encoding) : encodeBytes(value, path);
                        const length = boundedLength ?? part.length;
                        if (part.length > length || cursor + length > end) fail('value', `Field ${path} exceeds its byte length`);
                        claim(cursor,cursor+length,field); data.set(part, cursor); cursor += length;
                    } else {
                        if (field.expectedBytes && rawValue === undefined) value = scalarRead(Uint8Array.from(field.expectedBytes), field, 0, compiled);
                        if (field.bits) {
                            let packed = typeof value === 'object' ? exactInteger(value._raw ?? 0, field.name) : exactInteger(value, field.name);
                            for (const bit of field.bits) {
                                if (bit.type === 'reserved') continue;
                                const bitValue = lookup(fields, `${itemPath}.${bit.name}`) ??
                                    (typeof value === 'object' ? value[bit.name] : undefined);
                                if (bitValue === undefined) continue;
                                let slice = exactInteger(bitValue, bit.name), mask = (1n << BigInt(bit.length)) - 1n;
                                const signed = bit.type === 'int';
                                if (slice < (signed ? -(1n << BigInt(bit.length - 1)) : 0n) || slice > (signed ? (1n << BigInt(bit.length - 1)) - 1n : mask))
                                    fail('value', `Bit field overflow: ${bit.name}`);
                                packed = packed & ~(mask << BigInt(bit.offset)) | (slice & mask) << BigInt(bit.offset);
                            }
                            value = field.type === 'bitfield' || scalarWidth(field) === 8 ? packed : Number(packed);
                        }
                        const width = scalarWidth(field);
                        if (cursor + width > end) fail('boundary', `Field ${itemPath} exceeds its container`);
                        claim(cursor,cursor+width,field); scalarWrite(data, field, cursor, value, compiled); cursor += width;
                        if (field.expectedBytes && !field.expectedBytes.every((byte, index) => data[cursor - width + index] === byte))
                            fail('fixed', 'Supplied synchronization value does not match the fixed bytes', { nodeId: field.id });
                    }
                    lengths?.set(itemPath, cursor - itemStart);
                }
                storage.endByte = cursor; lengths?.set(path, cursor - storage.offset);
                if (field.legacyOverlay) cursor = priorCursor;
            }
            return cursor;
        }
        function writeMessage(selected, target, start, prefix) {
            if (selected.requireLayout && !options.layout) fail('layout', `Message ${selected.id} has conflicting document layouts; select layout: 'detail' explicitly`);
            if (options.layout && options.layout !== 'detail' && !selected.layouts?.[options.layout]) fail('layout', `Unknown layout: ${options.layout}`);
            const chosenChild = selectedChildren.get(selected);
            if (chosenChild?.command !== undefined && safeName(selected.dispatch?.field))
                target = { ...target, [selected.dispatch.field]: chosenChild.command };
            let end = writeFields(selected.fields, target, start, prefix, compiled.unified ? compiled.framing.fixedLength ?? compiled.maxLength : compiled.maxLength);
            if (selected.dispatch) {
                const dispatch = selected.dispatch, content = dispatch.name || 'content';
                const childStart = start + bounded(evaluate(dispatch.offsetExpression, { ...context, ...target }), compiled.maxLength, 'Dispatch offset');
                const child = chosenChild || selectMessage(dispatch.messages, lookup(target, dispatch.field), 0);
                if (child) {
                    // Child message selection can supply the discriminator for a
                    // caller sending by stable child ID.
                    const discriminator = encodedOffsets.get(prefix ? `${prefix}.${dispatch.field}` : dispatch.field);
                    if (chosenChild && child.command !== undefined && discriminator && TYPES[baseType(discriminator.field)]) {
                        scalarWrite(data, discriminator.field, discriminator.offset, child.command, compiled);
                    }
                    end = writeMessage(child, target[content] || target, childStart, prefix ? `${prefix}.${content}` : content);
                } else {
                    const raw = encodeBytes(target[content]?.rawPayload || target.rawPayload || [], 'rawPayload');
                    if (childStart + raw.length > compiled.maxLength) fail('bounds', 'Dispatch payload too large');
                    data.set(raw, childStart); end = childStart + raw.length;
                }
            } else if (selected.length !== undefined) {
                if (end - start > selected.length) fail('value', `Fields exceed message ${selected.id} layout length`);
                end = start + selected.length;
            }
            if (target._unknownTail) {
                const tail = encodeBytes(target._unknownTail, '_unknownTail');
                if (end + tail.length > compiled.maxLength) fail('bounds', 'Unknown tail too large');
                data.set(tail, end); end += tail.length;
            }
            if (selected.maxLength !== undefined && end - start > selected.maxLength)
                fail('length', `Payload exceeds ${selected.maxLength} byte message limit`);
            return end;
        }
        let payloadEnd;
        if (rootMessage) payloadEnd = writeMessage(rootMessage, fields, payloadStart, '');
        else {
            const raw = encodeBytes(fields.rawPayload || [], 'rawPayload');
            if (payloadStart + raw.length > compiled.maxLength) fail('bounds', 'Raw payload too large');
            data.set(raw, payloadStart); payloadEnd = payloadStart + raw.length;
        }
        const trailerLength = schema.payloadEnd < 0 ? -schema.payloadEnd : (compiled.fieldFooter ? 0 : schema.framing.footer?.length || 0);
        let total = schema.framing.fixedLength || payloadEnd + trailerLength;
        bounded(total, compiled.maxLength, 'Encoded frame length', 1);
        if (payloadEnd > total - trailerLength) fail('length', 'Payload exceeds fixed frame length');
        context.FRAME_LENGTH = total; context.PAYLOAD_LENGTH = total - trailerLength - payloadStart;
        writeFields(compiled.headerFields, { ...context, ...options.header }, 0, 'header');
        if (schema.framing.header && !compiled.unified) { automatic(0,schema.framing.header.length,'header',schema.framing.header); data.set(schema.framing.header); }
        for (const overlay of fixedOverlays) data.set(overlay.bytes, overlay.offset);
        if (schema.command) { automatic(schema.command.offset,schema.command.offset+TYPES[schema.command.type][0],'command'); scalarWrite(data, schema.command, schema.command.offset,
            rootMessage?.command ?? options.command ?? Number(String(messageId).split('.').pop()), compiled); }
        if (schema.framing.length) {
            const field = schema.framing.length, wireLength = (total - (field.adjustment || 0)) / (field.unit ?? 1);
            if (!Number.isSafeInteger(wireLength)) fail('length', 'Encoded length is not divisible by the configured length unit');
            automatic(field.offset,field.offset+TYPES[field.type][0],'length'); scalarWrite(data, field, field.offset, wireLength, compiled);
        }
        if (schema.framing.footer && !compiled.unified) { automatic(total-schema.framing.footer.length,total,'footer',schema.framing.footer); data.set(schema.framing.footer, total - schema.framing.footer.length); }
        const result = data.slice(0, total);
        if (compiled.unified) {
            const storage = [...encodedOffsets.values()];
            for (const target of storage.filter(item => item.field.autoLengthSource)) {
                const sourceId = target.field.autoLengthSource.id;
                const scope = target.path.slice(0, -target.field.name.length);
                const candidates = storage.filter(item => item.field.id === sourceId);
                const source = candidates.find(item => item.path.startsWith(scope)) ?? (candidates.length === 1 ? candidates[0] : null);
                if (!source) fail('reference', 'Length source is absent or ambiguous', { nodeId: target.field.id });
                const wireLength = (target.endByte - target.offset - target.field.autoLengthAdjustment) / target.field.autoLengthUnit;
                scalarWrite(result, source.field, source.offset, wireLength, compiled);
            }
            if (compiled.frameLengthExpression && framingLength(result, compiled) !== result.length)
                fail('length', 'Encoded length does not match the whole-frame length expression');
            if (compiled.lengthRelations.length) {
                const spans = storage.map(item => ({ ...item, fieldId: item.field.id, byteOffset: item.offset }));
                if (lengths) spans[RULE_LENGTHS] = lengths;
                // Bootstrap length values from the encoder's actual spans before a
                // receiver scan can use them to select variable-length branches.
                for (const rule of compiled.ruleWriters.filter(rule => rule.boundaryFallback)) {
                    const target = spans.find(span => span.fieldId === rule.targetFieldId);
                    if (!target) fail('rule-reference', '长度回填字段缺失');
                    scalarWrite(result, target.field, target.byteOffset, evaluate(rule.valueTree, ruleContext(result, spans, compiled)), compiled);
                }
            }
            const layout = scanUnifiedFrame(result, compiled, result.length);
            if (!layout || layout.end !== result.length) fail('length', 'Encoded fields do not match the whole-frame boundary');
            for (const node of fieldChecksumRanges(compiled, layout.spans, result.length))
                scalarWrite(result, node.field, node.offset, checksum(result.subarray(node.start, node.end), node.config), compiled);
        }
        for (const config of checksumOrder(compiled, result, context)) {
            const { start, end, offset } = checksumPositions(config, result, context);
            if (start > end || offset + config.width / 8 > total) fail('schema', 'Invalid checksum range or storage');
            automatic(offset,offset+config.width/8,'checksum');
            scalarWrite(result, { ...config, type: `uint${config.width}` }, offset,
                checksum(result.subarray(start, end), config), compiled);
        }
        if (compiled.rules?.length) {
            const spans = [...encodedOffsets.values()].map(item => ({ ...item, fieldId: item.field.id, byteOffset: item.offset }));
            if (lengths) spans[RULE_LENGTHS] = lengths;
            const writers = compiled.ruleWriters;
            fillRuleWrites(result, compiled, spans);
            const checked = decode(result, compiled);
            const failed = checked.ruleResults?.filter(item => item.status === 'failed' || item.unavailable) ?? [];
            if (!checked.valid || failed.some(item => item.strength === 'strong' || writers.some(rule => rule.id === item.ruleId)))
                fail('rule', failed.map(item => item.message).join('；') || '发送帧结构验证失败', { ruleResults: checked.ruleResults });
            if (typeof options.onRuleResults === 'function') options.onRuleResults(checked.ruleResults);
        }
        return result;
    }
    function formatTime(timestamp) {
        const date = new Date(timestamp);
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
    }
    class StreamParser {
        constructor(protocol, { deferDecode = false, maxDecodedFields = LIMITS.fields * 4, trackWork = false } = {}) {
            this.protocol = protocol ? compile(protocol) : null; this.nextByte = 0;
            this.frameCount = 0; this.failCount = 0; this.onFrameParsed = null;
            this.onRawData = null; this.onFrameError = null; this.onCallbackError = null;
            this.storage = new Uint8Array(); this.head = 0; this.tail = 0;
            this.sources = []; this.sourceHead = 0; this.bufferBaseByte = 0; this.candidate = {};
            this.work = trackWork ? { layoutFieldVisits: 0, scalarReads: 0, delimiterBytes: 0, bufferCopiedBytes: 0 } : null;
            this.deferDecode = deferDecode;
            this.maxDecodedFields = bounded(maxDecodedFields, LIMITS.fields * 4, 'Decoded field limit', 1);
        }
        setFormat({ protocol, deferDecode = this.deferDecode, maxDecodedFields = this.maxDecodedFields }) {
            const compiled = compile(protocol);
            bounded(maxDecodedFields, LIMITS.fields * 4, 'Decoded field limit', 1);
            this.protocol = compiled; this.deferDecode = deferDecode === true; this.maxDecodedFields = maxDecodedFields; this.reset();
        }
        get buffer() { return this.pending; }
        get pending() { return this.storage.subarray(this.head, this.tail); }
        get readOffset() { return 0; }
        get writeOffset() { return this.pending.length; }
        get length() { return this.pending.length; }
        get maxFrameBytes() { return this.protocol?.maxLength || LIMITS.frame; }
        get estimatedMemoryBytes() {
            const layout = this.candidate.layout;
            return this.storage.byteLength + this.sources.length * 256 + (this.candidate.scan?.estimatedMemoryBytes ??
                (layout ? layout.spans.length * 384 + layout.scalarCount * 64 + layout.boundaries.size * 128 + layout.contextBytes : 0)) + (this.candidate.ruleScan?.estimatedMemoryBytes ?? 0);
        }
        reset() {
            this.storage = new Uint8Array(); this.head = this.tail = this.sourceHead = 0;
            this.sources = []; this.candidate = {}; this.bufferBaseByte = this.nextByte;
        }
        _append(bytes) {
            const size = this.tail - this.head, needed = size + bytes.length;
            if (this.storage.length - this.tail < bytes.length) {
                if (this.storage.length >= needed) {
                    this.storage.copyWithin(0, this.head, this.tail);
                } else {
                    const capacity = Math.min(this.maxFrameBytes * 2, Math.max(1024, needed, this.storage.length * 2));
                    const next = new Uint8Array(capacity); next.set(this.pending); this.storage = next;
                }
                if (this.work) this.work.bufferCopiedBytes += size;
                this.head = 0; this.tail = size;
            }
            this.storage.set(bytes, this.tail); this.tail += bytes.length;
            if (this.work) this.work.bufferCopiedBytes += bytes.length;
        }
        _notify(callback, ...args) {
            if (!callback) return;
            try { callback(...args); } catch (error) {
                if (this.onCallbackError) this.onCallbackError(error);
                else if (typeof console !== 'undefined') console.error('Protocol callback error:', error);
                throw error;
            }
        }
        _metadata(length) {
            const start = this.bufferBaseByte;
            while (this.sourceHead + 1 < this.sources.length && this.sources[this.sourceHead].endByte <= start) this.sourceHead++;
            if (this.sourceHead > 1024 && this.sourceHead * 2 > this.sources.length) {
                this.sources = this.sources.slice(this.sourceHead); this.sourceHead = 0;
            }
            const source = this.sources[this.sourceHead] || {}, width = source.sourceEndByte - source.sourceStartByte;
            return { byteOffset: start, endByte: start + length, timestamp: source.timestamp ?? Date.now(),
                arrival: source.arrival, order: (source.order || 0) + (width > 0 ? (start - source.sourceStartByte) / width : 0) };
        }
        _consume(length, reason, record) {
            const bytes = this.pending.slice(0, length), metadata = this._metadata(length);
            if (this.work) this.work.bufferCopiedBytes += length;
            this.head += length; if (this.head === this.tail) this.head = this.tail = 0;
            this.bufferBaseByte += length; this.candidate = {};
            if (!this.length) { this.sources = []; this.sourceHead = 0; }
            if (record) {
                this.frameCount++;
                this._notify(this.onFrameParsed, record, formatTime(metadata.timestamp), bytes, metadata.timestamp, metadata);
            } else {
                this.failCount++;
                this._notify(this.onFrameError, reason, formatTime(metadata.timestamp), bytes, metadata);
            }
        }
        flushPending() { if (this.pending.length) this._consume(this.pending.length, 'incomplete'); this.reset(); }
        appendData(data, metadata = {}) {
            if (!this.protocol) fail('schema', 'Set protocol before appending stream bytes');
            data = bytesOf(data); if (!data.length) return;
            const timestamp = Number.isFinite(metadata.timestamp) ? metadata.timestamp : Date.now();
            const byteOffset = Number.isSafeInteger(metadata.byteOffset) ? metadata.byteOffset : this.nextByte;
            if (this.pending.length && byteOffset !== this.nextByte) this.flushPending();
            const source = { ...metadata, timestamp, byteOffset, endByte: byteOffset + data.length,
                sourceStartByte: metadata.sourceStartByte ?? byteOffset,
                sourceEndByte: metadata.sourceEndByte ?? byteOffset + data.length };
            if (!this.pending.length) this.bufferBaseByte = byteOffset;
            this.nextByte = source.endByte; this.sources.push(source);
            this._notify(this.onRawData, data, formatTime(timestamp), source);
            // Bound retained bytes even for callers delivering very large chunks.
            let offset = 0;
            while (offset < data.length) {
                const take = Math.min(this.protocol.maxLength, data.length - offset);
                // One source entry can cover several internally bounded chunks.
                if (!this.sources.length) this.sources.push(source);
                this._append(data.subarray(offset, offset + take)); offset += take; this.processBuffer();
            }
        }
        _footerEnd(start) {
            const state = this.candidate, bytes = this.pending, pattern = this.protocol.framing.footer;
            state.footerAt ??= start; state.footerMatched ??= 0;
            while (state.footerAt < bytes.length) {
                const byte = bytes[state.footerAt++]; if (this.work) this.work.delimiterBytes++;
                while (state.footerMatched && byte !== pattern[state.footerMatched]) state.footerMatched = this.protocol.footerTable[state.footerMatched - 1];
                if (byte === pattern[state.footerMatched]) state.footerMatched++;
                if (state.footerMatched === pattern.length) return state.footerAt;
            }
            return null;
        }
        _frameLength() {
            const compiled = this.protocol, framing = compiled.framing, state = this.candidate, bytes = this.pending;
            if (state.length !== undefined) return state.length;
            if (compiled.frameLengthExpression || framing.fixedLength || framing.length) {
                const length = framingLength(bytes, compiled);
                if (length !== null) state.length = length;
                return length;
            }
            if (!compiled.unified) {
                const end = this._footerEnd(Math.max(compiled.schema.payloadOffset || 0, framing.header?.length || 0));
                if (end !== null) state.length = end;
                return end;
            }
            let end = null;
            if (compiled.needsEndBoundary && framing.footer?.length) {
                end = this._footerEnd((compiled.sync?.offset ?? 0) + (compiled.sync?.bytes.length ?? 0));
                if (end === null) return null;
            }
            // Legacy expressions referring to the unknown whole-frame range retain
            // their established semantics; independent layouts can resume in place.
            if (compiled.streamFrameContext && end === null) {
                const layout = scanUnifiedFrame(bytes, compiled, null, this.work);
                if (!layout) return null;
                state.recheckLength = true; state.length = layout.end; return state.length;
            }
            state.scan ??= createUnifiedFrameScan(compiled, end, this.work, true);
            const layout = state.scan.resume(bytes);
            if (!layout) return null;
            state.layout = layout; state.length = layout.end; state.scan = null;
            return state.length;
        }
        processBuffer() {
            const compiled = this.protocol, header = compiled.sync?.bytes || compiled.framing.header || [], anchorOffset = compiled.sync?.offset || 0;
            while (this.pending.length) {
                if (header.length) {
                    let start = 0;
                    while (start < this.pending.length && !header.every((byte, i) =>
                        start + anchorOffset + i >= this.pending.length || this.pending[start + anchorOffset + i] === byte)) start++;
                    if (start) { this._consume(start, 'noise'); continue; }
                    if (this.pending.length < anchorOffset + header.length) return;
                }
                // Positive-position checksums covering only the header reject a
                // corrupted length immediately instead of waiting for bogus data.
                let invalidHeader = false;
                const checked = this.candidate.checked ??= new Set();
                for (const config of compiled.streamPreChecks) {
                    if (checked.has(config)) continue;
                    if (this.pending.length < Math.max(config.end, config.offset + config.width / 8)) continue;
                    const expected = checksum(this.pending.subarray(config.start, config.end), config);
                    if (expected !== scalarRead(this.pending, { ...config, type: `uint${config.width}` }, config.offset, compiled)) {
                        invalidHeader = true; break;
                    }
                    checked.add(config);
                }
                if (invalidHeader) { this._consume(1, 'checksum'); continue; }
                let length;
                try { length = this._frameLength(); }
                catch (error) { if (!(error instanceof ProtocolError)) throw error; this._consume(1, error.code); continue; }
                if (length === null) {
                    if (this.pending.length >= compiled.maxLength) { this._consume(1, 'length'); continue; }
                    return;
                }
                const minimum = Math.max(anchorOffset + header.length, compiled.schema.payloadOffset || 0) +
                    (compiled.schema.payloadEnd < 0 ? -compiled.schema.payloadEnd : compiled.framing.footer?.length || 0);
                if (!Number.isSafeInteger(length) || length < Math.max(1, minimum) || length > compiled.maxLength) {
                    this._consume(1, 'length'); continue;
                }
                if (this.pending.length < length) {
                    if (compiled.rules?.some(rule => rule.enabled !== false && rule.stage !== 'validation')) {
                        try {
                            this.candidate.ruleScan ??= createUnifiedFrameScan(compiled, length, this.work, true);
                            this.candidate.ruleScan.resume(this.pending);
                        } catch (error) {
                            if (!(error instanceof ProtocolError)) throw error;
                            this._consume(1, error.code); continue;
                        }
                    }
                    return;
                }
                let record;
                try {
                    const candidate = this.pending.subarray(0, length);
                    if (this.deferDecode && !compiled.rules?.length) {
                        validateFrame(candidate, compiled, this.candidate, this.work);
                        const payloadOffset = compiled.schema.payloadOffset || 0;
                        const end = compiled.schema.payloadEnd === undefined ? length - (compiled.fieldFooter ? 0 : compiled.framing.footer?.length || 0)
                            : compiled.schema.payloadEnd < 0 ? length + compiled.schema.payloadEnd : compiled.schema.payloadEnd;
                        if (end < payloadOffset || end > length) fail('length', 'Payload is outside frame');
                        const warnings = staticFixedWarnings(candidate, compiled, payloadOffset, end);
                        record = { deferred: true, valid: warnings.length ? false : undefined, warnings, protocolId: compiled.id, frameLength: length,
                            payloadOffset, payloadLength: end - payloadOffset };
                    } else record = decodeFrame(candidate, compiled, this.maxDecodedFields, this.candidate, this.work);
                }
                catch (error) {
                    if (!(error instanceof ProtocolError)) throw error;
                    this._consume(1, error.code); continue;
                }
                this._consume(length, null, record);
            }
        }
    }
    const Protocol = { compile, decode, encode, checksum, StreamParser, ProtocolError, LIMITS, migrateSymbols,
        analyze: schema => { try { const compiled = compile(schema); return { valid: true, compiled, diagnostics: compiled.diagnostics }; }
            catch (error) { if (!(error instanceof ProtocolError)) throw error; return { valid: false, diagnostics: [{ severity: 'error', code: error.code, message: error.message, nodeId: error.nodeId, byteOffset: error.byteOffset, endByte: error.endByte }] }; } },
        selectBranch: (field, context) => chooseBranch({ ...field, selectorExpression: field.selectorExpression || (field.selector === undefined ? null : expression(field.selector)), branches: (field.branches || []).map(branch => ({ ...branch, expressionTree: branch.expressionTree || (branch.expression === undefined ? null : expression(branch.expression)) })) }, context),
        evaluateExpression: (source, context = {}) => evaluate(expression(source), context),
        expressionVariables: source => [...new Set(variables(expression(source)))],
        createFactorySource: () => `function(root, codec) { const reserved = (${reservedNames.createFactorySource()})(); const symbols = (${protocolSymbols.createFactorySource()})(reserved); return (${createProtocolEngine.toString()})(root, codec, reserved, symbols); }` };
    root.SerialPlotter ??= {}; root.SerialPlotter.Protocol = Protocol;
    if (typeof module !== 'undefined' && module.exports) module.exports = { Protocol };
    return Protocol;
})(globalThis);

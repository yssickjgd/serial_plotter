/** Presentation and export adapters for decoded records; raw bytes remain in FrameBuffer. */
function unwrapProtocolRecord(value) { return value?.record ?? value ?? {}; }

function protocolJsonValue(value) {
    return JSON.stringify(value, (key, item) => typeof item === 'bigint' ? item.toString(10)
        : ArrayBuffer.isView(item) ? Array.from(item) : item);
}

/** Radix affects literal entry and presentation, never the stored wire value. */
function protocolNumberBase(field = {}) {
    return field.displayBase ?? (['fixed','bytes','reserved'].includes(field.type) || field.expectedBytes ? 'hex' : 'dec');
}
function parseProtocolInteger(value, base = 'dec', title = '数值') {
    const text = String(value).trim(), sign = text.startsWith('-') ? -1n : 1n, digits = text.replace(/^[+-]/, '');
    const explicitHex = /^0x[0-9a-f]+$/i.test(digits);
    if (!explicitHex && !(base === 'hex' ? /^[0-9a-f]+$/i : /^\d+$/).test(digits))
        throw new Error(`${title}必须是${base === 'hex' ? '十六' : '十'}进制整数（可用 0x 前缀指定十六进制）`);
    const exact = sign * BigInt(explicitHex ? digits : base === 'hex' ? '0x' + digits : digits);
    return exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : exact.toString();
}
function protocolBytesText(bytes, base = 'hex') {
    return Array.from(bytes ?? [], byte => base === 'hex' ? byte.toString(16).padStart(2, '0').toUpperCase() : String(byte)).join(' ');
}
function parseProtocolBytes(text, base = 'hex', title = '字节序列') {
    const source = String(text).trim();
    if (source.length > 6291456) throw new Error(title + '超过 1 MiB');
    if (base === 'hex') {
        const tokens = source ? source.split(/[\s,]+/) : [], chunks = [];
        let length = 0;
        for (const token of tokens) {
            const match = /^(?:0x)?((?:[0-9a-f]{2})+)$/i.exec(token);
            if (!match) throw new Error(title + '必须由完整的两位十六进制字节组成');
            length += match[1].length / 2;
            if (length > 1048576) throw new Error(title + '超过 1 MiB');
            chunks.push(match[1]);
        }
        return Array.from(chunks.join('').match(/../g) ?? [], token => parseInt(token, 16));
    }
    const tokens = source ? source.split(/[\s,]+/) : [];
    if (tokens.length > 1048576) throw new Error(title + '超过 1 MiB');
    return tokens.map(token => {
        const byte = parseProtocolInteger(token, 'dec', title);
        if (typeof byte !== 'number' || byte < 0 || byte > 255) throw new Error(title + '的每个字节必须在 0–255 范围内');
        return byte;
    });
}

function protocolValueText(value, options = {}) {
    if (['dec','hex'].includes(options.displayBase) && options.type !== 'string' && !/^float/.test(options.baseType ?? options.type ?? '')) {
        if (options.displayBase === 'hex' && (Array.isArray(value) || ArrayBuffer.isView(value))) return '[' + Array.from(value, item => protocolValueText(item, options)).join(', ') + ']';
        if (typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value) ||
            typeof value === 'string' && /^[+-]?(?:\d+|0x[\da-f]+)$/i.test(value.trim())) {
            const text = String(value).trim(), negative = text.startsWith('-');
            const exact = BigInt(text.replace(/^[+-]/, ''));
            if (options.displayBase === 'dec') return (negative ? -exact : exact).toString(10);
            const digits = exact.toString(16).toUpperCase();
            return (negative && digits !== '0' ? '-' : '') + '0x' + digits;
        }
    }
    if (value === null) return 'null';
    if (value === undefined) return '';
    if (typeof value === 'bigint') return value.toString(10);
    if (typeof value === 'object') return protocolJsonValue(value);
    return String(value);
}

function protocolRecordStatus(value) {
    const record = unwrapProtocolRecord(value);
    if (record.status) return String(record.status);
    if (record.error || record.valid === false) return 'error';
    if (record.known === false) return 'unknown';
    return record.warnings?.length ? 'warning' : 'ok';
}

function protocolRecordSummary(value) {
    const record = unwrapProtocolRecord(value), status = protocolRecordStatus(record);
    const labels = { ok: '正常', warning: '警告', error: '错误', unknown: '未知消息' };
    const command = record.command === undefined ? '' : `  命令=${protocolValueText(record.command)}`;
    return `${record.messageName || record.name || record.messageId || '协议记录'}${command}  状态=${labels[status] ?? status}` +
        (record.error ? `  ${record.error.message ?? record.error}` : '');
}

function protocolPathContains(parent, path) {
    return path === parent || path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`);
}

function protocolVisibleFields(value, options = {}) {
    const record = unwrapProtocolRecord(value), paths = options.fieldPaths ?? options.paths ?? null;
    const hidden = options.hiddenPaths ?? [], collapsed = options.collapsedPaths ?? [];
    const selected = options.selectedChannels === undefined || options.selectedChannels === null ? null : new Set(options.selectedChannels);
    const mappings = options.mappings ?? [];
    const fields = [...(record.flatFields ?? [])];
    if (record.known === false && !fields.some(field => field.path === 'rawPayload') && record.rawPayload !== undefined) {
        const byteOffset = record.payloadOffset ?? 0;
        fields.push({ path: 'rawPayload', value: record.rawPayload, numeric: null, byteOffset,
            endByte: byteOffset + (record.rawPayload.length ?? 0) });
    }
    return fields.filter(field => {
        if (paths !== null && !paths.some(path => protocolPathContains(path, field.path))) return false;
        if (hidden.some(path => protocolPathContains(path, field.path))) return false;
        if (collapsed.some(path => field.path !== path && protocolPathContains(path, field.path))) return false;
        if (selected) {
            const channel = field.channel ?? mappings.find(mapping => (!mapping.messageId || mapping.messageId === record.messageId) &&
                (mapping.path === field.path || mapping.fieldId && mapping.fieldId === field.fieldId))?.channel;
            if (!selected.has(channel)) return false;
        }
        return true;
    });
}

/** Arrays occupy restorable JSON cells unless the user explicitly selects an indexed leaf. */
function protocolCsvFields(value, options = {}) {
    const record = unwrapProtocolRecord(value), result = new Map();
    const read = path => {
        const parts = path.split('.'); let current = parts[0] === 'header' ? record : record.fields;
        for (const part of parts) current = current && Object.hasOwn(current, part) ? current[part] : undefined;
        return current;
    };
    for (const field of protocolVisibleFields(record, options)) {
        const index = field.path.indexOf('['), arrayPath = index > 0 ? field.path.slice(0, index) : null;
        const indexed = options.fieldPaths?.some(path => path.includes('[') && protocolPathContains(path, field.path));
        const value = arrayPath && !indexed ? read(arrayPath) : undefined;
        if (Array.isArray(value)) result.set(arrayPath, { path: arrayPath, value });
        else result.set(field.path, field);
    }
    const visit = (object, prefix = '', depth = 0) => {
        if (!object || typeof object !== 'object' || depth > 16 || ArrayBuffer.isView(object)) return;
        for (const [key, item] of Object.entries(object)) {
            const path = prefix ? `${prefix}.${key}` : key;
            if (Array.isArray(item)) {
                const selected = options.fieldPaths === undefined || options.fieldPaths === null || options.fieldPaths.some(parent => protocolPathContains(parent, path));
                if (selected && !(options.hiddenPaths ?? []).some(parent => protocolPathContains(parent, path)))
                    result.set(path, { path, value: item });
            } else visit(item, path, depth + 1);
        }
    };
    visit(record.fields); visit(record.header, 'header');
    return [...result.values()];
}

/** Columns are a stable union of selected paths across the retained snapshot. */
function* structuredCsvChunks(frames, decodeRecord, options = {}) {
    if (!frames.length) return;
    if (typeof decodeRecord !== 'function') throw new TypeError('结构化导出需要协议解码器');
    const rowsPerChunk = options.rowsPerChunk ?? 1024;
    if (!Number.isInteger(rowsPerChunk) || rowsPerChunk < 1) throw new RangeError('每块记录数必须为正整数');
    const count = frames.length, firstOrder = frames.orderAt(0);
    const guard = () => {
        if (frames.orderAt(0) !== firstOrder) throw new Error('导出期间最早帧已被覆盖，请暂停采集后重试');
    };
    const csv = value => {
        const text = protocolValueText(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const paths = options.columnPaths ? [...options.columnPaths] : [], seen = new Set(paths);
    for (let index = 0; !options.columnPaths && index < count; index++) {
        guard();
        const record = unwrapProtocolRecord(decodeRecord(index));
        for (const field of protocolCsvFields(record, options)) if (!seen.has(field.path)) {
            seen.add(field.path); paths.push(field.path);
        }
    }
    guard();
    yield ['Index', ...(options.timestamps ? ['Timestamp'] : []), 'MessageId', 'Message', 'Command', 'Status', 'Warnings', ...paths].map(csv).join(',') + '\r\n';
    for (let start = 0; start < count; start += rowsPerChunk) {
        guard(); const lines = [];
        for (let index = start; index < Math.min(count, start + rowsPerChunk); index++) {
            guard();
            const record = unwrapProtocolRecord(decodeRecord(index));
            const fields = new Map(protocolCsvFields(record, options).map(field => [field.path, field.value]));
            const timestamp = frames.timestampAt?.(index), values = [index];
            if (options.timestamps) values.push(Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '');
            values.push(record.messageId ?? '', record.messageName || record.name || '', record.command ?? '', protocolRecordStatus(record),
                (record.warnings ?? []).map(item => item.message ?? item.code ?? String(item)).join('; '), ...paths.map(path => fields.get(path)));
            lines.push(values.map(csv).join(','));
        }
        yield lines.join('\r\n') + '\r\n';
    }
}

/** Discover columns in bounded slices before streaming rows, keeping the UI responsive. */
async function* structuredCsvChunksAsync(frames, decodeRecord, options = {}) {
    const count = frames.length, firstOrder = frames.orderAt(0), paths = new Set();
    const yieldControl = options.yieldControl ?? (() => new Promise(resolve => setTimeout(resolve, 0)));
    const guard = () => {
        options.check?.();
        if (frames.orderAt(0) !== firstOrder) throw new Error('导出期间最早帧已被覆盖，请暂停采集后重试');
    };
    for (let index = 0; index < count; index++) {
        guard();
        for (const field of protocolCsvFields(decodeRecord(index), options)) paths.add(field.path);
        if (index % 256 === 255) { await yieldControl(); guard(); }
    }
    for (const chunk of structuredCsvChunks(frames, decodeRecord, { ...options, columnPaths: [...paths] })) {
        guard(); yield chunk; await yieldControl(); guard();
    }
}

const ProtocolRecordsApi = { protocolNumberBase, parseProtocolInteger, protocolBytesText, parseProtocolBytes, unwrapProtocolRecord, protocolJsonValue, protocolValueText, protocolRecordStatus,
    protocolRecordSummary, protocolPathContains, protocolVisibleFields, protocolCsvFields, structuredCsvChunks, structuredCsvChunksAsync };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, ProtocolRecordsApi);
globalThis.SerialPlotter.ProtocolRecords = ProtocolRecordsApi;
if (typeof module !== 'undefined') module.exports = ProtocolRecordsApi;

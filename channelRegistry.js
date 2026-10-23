/** Stable channel identity, safe user aliases, and canonical numbered references. */
const channelRegistryFormat = typeof module !== 'undefined' ? require('./channelTransform') : globalThis.SerialPlotter;
const CHANNEL_NAME_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}\p{M}_]*$/u;
const channelRegistryReserved = typeof module !== 'undefined' ? require('./reservedNames').ReservedNames : globalThis.SerialPlotter.ReservedNames;
const CHANNEL_RESERVED_NAMES = new Set([...channelRegistryReserved.channelFunctions, ...channelRegistryReserved.channelVariables]);

function normalizeChannelName(name) { return typeof name === 'string' ? name.normalize('NFC') : ''; }

function channelNameError(name) {
    if (typeof name !== 'string' || !name) return '通道名称不能为空';
    const normalized = normalizeChannelName(name);
    if (!CHANNEL_NAME_IDENTIFIER.test(normalized)) return '名称必须为变量名，不能包含空格、运算符或以数字开头';
    const conflict = channelRegistryReserved.error(normalized, 'channel');
    if (conflict) return conflict;
    return null;
}

/** Scan identifiers without treating exponent digits (1e3) or identifier suffixes as aliases. */
function replaceChannelIdentifiers(text, replace) {
    return String(text).replace(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[\p{L}_][\p{L}\p{N}\p{M}_]*/gu,
        token => /^(?:\d|\.)/.test(token) ? token : replace(token));
}

class ChannelRegistry {
    constructor(options = {}, definitions = [], extra = {}) {
        if (typeof options === 'number') options = { ...extra, rawCount: options, definitions };
        const rawCount = Number(options.rawCount ?? options.channelsCount ?? 1);
        if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 65535) throw new Error('原始通道数量无效');
        this.rawCount = rawCount;
        this.entries = new Map(); this.byId = new Map(); this.aliases = new Map(); this.nameErrors = new Map();
        const previous = new Map((options.channels ?? options.records ?? []).map(entry => [entry.number, entry]));
        const names = options.names ?? options.channelNames ?? [];
        const add = (number, type, definition) => {
            if (!Number.isInteger(number) || number < 1 || number > 65535 || this.entries.has(number))
                throw new Error('通道编号重复、与原始通道冲突或超出范围');
            const old = previous.get(number);
            const id = old?.id ?? definition?.id ?? definition?.channelId ?? `${type === 'raw' ? 'raw' : 'derived'}:${number}`;
            if (this.byId.has(id)) throw new Error('通道稳定 ID 重复');
            const name = names[number - 1] ?? old?.name ?? definition?.name ?? channelRegistryFormat.formatChannelNumber(number);
            const source = old?.source ?? definition?.source ?? (type === 'raw' ? { kind: 'raw', rawIndex: number - 1 } : { kind: type });
            const entry = { id, number, name, type, source: { ...source }, ...(definition ? { definition: { ...definition } } : {}) };
            this.entries.set(number, entry); this.byId.set(id, entry);
        };
        for (let number = 1; number <= rawCount; number++) add(number, 'raw');
        for (const definition of options.definitions ?? options.channelDefinitions ?? []) {
            if (definition.number <= rawCount) throw new Error('运算通道与原始通道冲突');
            add(definition.number, definition.type, definition);
        }
        if (this.entries.size > 65535) throw new Error('通道总数不能超过 65535');
        this._reindexNames();
        if (options.strictNames) this.validateNames();
    }

    _reindexNames() {
        this.aliases.clear(); this.nameErrors.clear();
        const groups = new Map();
        for (const entry of this.entries.values()) {
            if (channelRegistryFormat.parseChannelId(entry.name) === entry.number) continue;
            const name = normalizeChannelName(entry.name), error = channelNameError(entry.name);
            if (error) { this.nameErrors.set(entry.number, error); continue; }
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push(entry);
        }
        for (const [name, entries] of groups) {
            if (entries.length > 1) for (const entry of entries) this.nameErrors.set(entry.number, '通道名称重复（含 Unicode 等价名称）');
            else this.aliases.set(name, entries[0]);
        }
    }

    get(numberOrId) { return typeof numberOrId === 'number' ? this.entries.get(numberOrId) : this.byId.get(numberOrId); }
    resolve(identifier) {
        if (typeof identifier === 'number') return this.entries.get(identifier);
        const number = channelRegistryFormat.parseChannelId(identifier);
        return number !== null ? this.entries.get(number) : this.aliases.get(normalizeChannelName(identifier));
    }

    validateName(name, number) {
        const error = channelNameError(name);
        if (error) return { valid: false, error };
        const normalized = normalizeChannelName(name);
        for (const entry of this.entries.values()) if (entry.number !== number && normalizeChannelName(entry.name) === normalized)
            return { valid: false, error: '通道名称重复（含 Unicode 等价名称）' };
        return { valid: true, name: normalized, error: null };
    }

    validateNames() {
        for (const entry of this.entries.values()) {
            // Automatically generated labels are references, rather than user aliases.
            if (channelRegistryFormat.parseChannelId(entry.name) === entry.number) continue;
            const result = this.validateName(entry.name, entry.number);
            if (!result.valid) throw new Error(`${channelRegistryFormat.formatChannelNumber(entry.number)}: ${result.error}`);
        }
        return true;
    }

    canonicalizeExpression(text, options = {}) {
        return replaceChannelIdentifiers(text, token => {
            const number = channelRegistryFormat.parseChannelId(token), entry = this.resolve(token);
            if (entry) return channelRegistryFormat.formatChannelNumber(entry.number);
            if (number !== null) return channelRegistryFormat.formatChannelNumber(number);
            if (CHANNEL_RESERVED_NAMES.has(token) || options.allowUnknown) return token;
            throw new Error(`通道名称 ${token} 无效、不存在或重复；请使用 CH 编号`);
        });
    }

    rename(numberOrId, name) {
        const entry = this.get(numberOrId);
        if (!entry) throw new Error('通道不存在');
        const result = this.validateName(name, entry.number);
        if (!result.valid) throw new Error(result.error);
        // Bind all saved expressions before removing the old alias.
        this.canonicalizeDefinitions();
        entry.name = result.name;
        if (entry.definition?.name !== undefined) entry.definition.name = result.name;
        this._reindexNames();
        return entry;
    }

    canonicalizeDefinitions() {
        for (const entry of this.entries.values()) if (entry.definition?.type === 'formula')
            entry.definition.expression = this.canonicalizeExpression(entry.definition.expression);
        return this.getDefinitions();
    }

    renumber(numberMap) {
        if (!(numberMap instanceof Map)) numberMap = new Map(Object.entries(numberMap).map(([old, number]) => [Number(old), number]));
        const targets = new Set();
        for (const entry of this.entries.values()) {
            const number = numberMap.get(entry.number) ?? entry.number;
            if (!Number.isInteger(number) || number < 1 || number > 65535 || targets.has(number)) throw new Error('重编号映射无效');
            targets.add(number);
        }
        this.canonicalizeDefinitions();
        const entries = [...this.entries.values()];
        this.entries.clear();
        for (const entry of entries) {
            const oldNumber = entry.number;
            entry.number = numberMap.get(oldNumber) ?? oldNumber;
            if (channelRegistryFormat.parseChannelId(entry.name) === oldNumber) entry.name = channelRegistryFormat.formatChannelNumber(entry.number);
            if (entry.definition) {
                entry.definition.number = entry.number;
                if (entry.definition.type === 'formula') entry.definition.expression = replaceChannelIdentifiers(entry.definition.expression, token => {
                    const old = channelRegistryFormat.parseChannelId(token);
                    return old === null ? token : channelRegistryFormat.formatChannelNumber(numberMap.get(old) ?? old);
                });
            }
            this.entries.set(entry.number, entry);
        }
        this.entries = new Map([...this.entries].sort((a, b) => a[0] - b[0]));
        this._reindexNames();
        return this;
    }

    getChannels() { return [...this.entries.values()]; }
    getDefinitions() { return this.getChannels().filter(entry => entry.definition).map(entry => ({ ...entry.definition })); }
    getNames() {
        const names = [];
        for (const entry of this.entries.values()) names[entry.number - 1] = entry.name;
        return names;
    }
    query(query = '', { limit = 30, offset = 0 } = {}) {
        const result = [], normalized = normalizeChannelName(query).toLocaleLowerCase();
        limit = Math.max(0, Math.min(30, limit)); offset = Math.max(0, offset);
        let total = 0;
        const reference = /^CH\d*$/i.test(normalized);
        for (const entry of this.entries.values()) {
            const canonical = channelRegistryFormat.formatChannelNumber(entry.number);
            const alias = this.aliases.get(normalizeChannelName(entry.name)) === entry;
            if (!normalized || canonical.toLowerCase().includes(normalized) || reference && `ch${entry.number}`.startsWith(normalized) ||
                alias && normalizeChannelName(entry.name).toLocaleLowerCase().includes(normalized)) {
                if (total >= offset && result.length < limit) result.push({ id: entry.id, number: entry.number, name: entry.name, label: canonical,
                    value: alias && !reference ? normalizeChannelName(entry.name) : canonical, aliasAvailable: alias, source: entry.source, type: entry.type });
                total++;
            }
        }
        return { items: result, total };
    }
    complete(query = '', limit = 30, offset = 0) { return this.query(query, { limit, offset }).items; }
    toJSON() {
        return this.getChannels().map(({ id, number, name, type, source }) => ({ id, number, name, type, source: { ...source } }));
    }
}

function resolveChannelExpression(text, options = {}) {
    const registry = options instanceof ChannelRegistry ? options : options.registry ?? new ChannelRegistry(options);
    return registry.canonicalizeExpression(text);
}

const ChannelRegistryApi = { ChannelRegistry, normalizeChannelName, channelNameError, replaceChannelIdentifiers, resolveChannelExpression };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, ChannelRegistryApi);
if (typeof module !== 'undefined') module.exports = ChannelRegistryApi;

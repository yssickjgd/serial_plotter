/** Safe sample-domain expressions. Each stateful node advances exactly once per sample. */
const channelOperationsFormat = typeof module !== 'undefined' ? require('./channelTransform') : globalThis.SerialPlotter;
const channelOperationsRegistry = typeof module !== 'undefined' ? require('./channelRegistry') : globalThis.SerialPlotter;
const channelOperationsSymbols = typeof module !== 'undefined' ? require('./channelSymbols') : globalThis.SerialPlotter;
const channelOperationsReserved = typeof module !== 'undefined' ? require('./reservedNames').ReservedNames : globalThis.SerialPlotter.ReservedNames;
const CHANNEL_LIMIT = 65535;
const CHANNEL_HISTORY_LIMIT = 65536;
// Version 1 accepted names that were added to the shared symbol catalog later.
const LEGACY_CHANNEL_RESERVED_NAMES = new Set(['diff', 'int', 'filter', 'x', 'y', 'n']);
function isLegacyChannelAlias(name) {
    return /^[\p{L}_][\p{L}\p{N}\p{M}_]*$/u.test(name) && !LEGACY_CHANNEL_RESERVED_NAMES.has(name) && !/^CH\d+$/i.test(name);
}

class ChannelExpressionError extends Error {
    constructor(message, number, position) {
        super(`${number ? `${channelOperationsFormat.formatChannelNumber(number)}: ` : ''}${message}${position === undefined ? '' : `（位置 ${position + 1}）`}`);
        this.channelNumber = number;
        this.position = position;
    }
}

class ChannelExpressionParser {
    constructor(text, number, resolveReference) {
        if (typeof text !== 'string' || !text.trim() || text.length > 8192)
            throw new ChannelExpressionError('请输入不超过 8192 字符的表达式', number);
        this.text = text; this.number = number; this.at = 0; this.depth = 0; this.resolveReference = resolveReference;
        if (/\+\+|--/.test(text)) this.fail('请用括号明确相邻正负号');
        this.next();
    }

    fail(message) { throw new ChannelExpressionError(message, this.number, this.at); }
    next() {
        while (/\s/.test(this.text[this.at] ?? '') && this.at < this.text.length) this.at++;
        const rest = this.text.slice(this.at);
        const match = rest.match(/^(?:(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[\p{L}_][\p{L}\p{N}\p{M}_]*|[+\-*/(),\[\]])/u);
        if (!rest) { this.token = ''; return; }
        if (!match) this.fail('无法识别的字符');
        this.token = match[0]; this.at += this.token.length;
    }
    take(token) { if (this.token !== token) this.fail(`需要 ${token}`); this.next(); }
    parse() {
        const node = this.expression();
        if (this.token) this.fail('表达式末尾存在多余内容');
        const pending = [[node, 1]];
        while (pending.length) {
            const [current, depth] = pending.pop();
            if (depth > 64) this.fail('表达式嵌套过深，请拆分为多个运算通道');
            for (const child of current.args ?? [current.left, current.right, current.value].filter(value => typeof value === 'object'))
                pending.push([child, depth + 1]);
        }
        return node;
    }
    expression(min = 0) {
        if (++this.depth > 64) this.fail('括号或函数嵌套过深');
        let left = this.primary();
        while (['+', '-', '*', '/'].includes(this.token)) {
            const operator = this.token, precedence = operator === '+' || operator === '-' ? 1 : 2;
            if (precedence < min) break;
            this.next(); left = { type: 'binary', operator, left, right: this.expression(precedence + 1) };
        }
        this.depth--; return left;
    }
    primary() {
        const token = this.token;
        if (token === '+' || token === '-') {
            this.next(); return { type: 'unary', operator: token, value: this.expression(3) };
        }
        if (token === '(') { this.next(); const node = this.expression(); this.take(')'); return node; }
        if (/^(?:\d|\.)/.test(token)) {
            const value = Number(token); if (!Number.isFinite(value)) this.fail('数值必须有限');
            this.next(); return { type: 'literal', value };
        }
        const aliasNumber = this.resolveReference?.(token);
        if (/^CH\d+$/.test(token) || token === 'X' || token === 'Y' || Number.isInteger(aliasNumber)) {
            this.next(); let index = null;
            if (this.token === '[') {
                this.next(); let sign = 1;
                if (this.token === 'N') {
                    this.next(); index = 0;
                    if (this.token === '-') { this.next(); sign = -1; index = this.integer() * sign; }
                } else {
                    if (this.token === '-') { sign = -1; this.next(); }
                    index = this.integer() * sign;
                }
                this.take(']');
            }
            return { type: 'reference', number: /^CH\d+$/.test(token) ? Number(token.slice(2)) : aliasNumber ?? token, index };
        }
        if (channelOperationsReserved.channelFunctions.includes(token)) {
            this.next(); this.take('('); const args = [this.expression()];
            while (this.token === ',') { this.next(); args.push(this.expression()); }
            this.take(')');
            const count = token === 'DIFF' || token === 'INT' ? 1 : 2;
            if (args.length !== count) this.fail(`${token} 需要 ${count} 个参数`);
            return { type: 'call', name: token, args };
        }
        this.fail('只支持大写 CH 编号、四则运算、DIFF、INT 和 FILTER；FILTER 需要信号与常量数组或系统，顺序不限');
    }
    integer() {
        if (!/^\d+$/.test(this.token) || Number(this.token) > CHANNEL_HISTORY_LIMIT)
            this.fail(`索引必须为整数且不超过 ${CHANNEL_HISTORY_LIMIT}`);
        const value = Number(this.token); this.next(); return value;
    }
}

function parseConstantChannel(text, number) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1048576)
        throw new ChannelExpressionError('请输入常量数组，例如 [0]=1,[1]=-2.3', number);
    const values = text.split(/[,;\n]+/).filter(part => part.trim()).map((part, index) => {
        const match = part.trim().match(/^\[(\d+)\]\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/);
        if (!match) throw new ChannelExpressionError('常量必须为 [索引]=有限数值', number);
        if (Number(match[1]) !== index) throw new ChannelExpressionError('常量索引必须从 0 开始连续且不重复', number);
        const value = Number(match[2]);
        if (!Number.isFinite(value)) throw new ChannelExpressionError('常量必须为有限数值', number);
        return value;
    });
    if (!values.length || values.length > CHANNEL_HISTORY_LIMIT)
        throw new ChannelExpressionError(`常量数组长度需为 1–${CHANNEL_HISTORY_LIMIT}`, number);
    return values;
}

function walkChannelExpression(node, visit) {
    const pending = [node];
    while (pending.length) {
        const current = pending.pop(); visit(current);
        for (const child of current.args ?? [current.left, current.right, current.value].filter(value => typeof value === 'object')) pending.push(child);
    }
}

function compileChannelSystem(definition) {
    const { number } = definition;
    const text = definition.expression.replace(/^\s*Y\[(?:N|0)\]\s*=\s*/, '');
    const ast = new ChannelExpressionParser(text, number).parse(), required = new Set();
    walkChannelExpression(ast, node => {
        if (node.type === 'call') throw new ChannelExpressionError('差分方程内使用 X、Y 和四则运算', number);
        if (node.type !== 'reference') return;
        if (!['X', 'Y'].includes(node.number)) throw new ChannelExpressionError('差分方程使用 X 表示输入、Y 表示输出', number);
        node.index ??= 0;
        if (node.index > 0 || node.number === 'Y' && node.index === 0)
            throw new ChannelExpressionError('系统不允许未来输入或当前输出反馈；请使用 Y[-1] 等历史状态', number);
        for (let i = -1; i >= node.index; i--) required.add(`${node.number}[${i}]`);
    });
    const initial = new Map();
    for (const part of (definition.initial ?? '').split(/[,;\n]+/).filter(value => value.trim())) {
        const match = part.trim().match(/^([XY])\[(-\d+)\]\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/);
        if (!match || !Number.isFinite(Number(match[3]))) throw new ChannelExpressionError('初始状态格式为 Y[-1]=0 或 X[-1]=0，数值必须有限', number);
        const key = `${match[1]}[${Number(match[2])}]`;
        if (!required.has(key) || initial.has(key)) throw new ChannelExpressionError(`初始状态 ${key} 重复或未使用`, number);
        initial.set(key, Number(match[3]));
    }
    for (const key of required) if (!initial.has(key)) throw new ChannelExpressionError(`请明确初始状态 ${key}`, number);
    let inputSize = 0, outputSize = 0;
    for (const key of required) {
        const size = -Number(key.slice(2, -1));
        if (key[0] === 'X') inputSize = Math.max(inputSize, size);
        else outputSize = Math.max(outputSize, size);
    }
    return { ast, initial, inputSize, outputSize };
}

class SampleHistory {
    constructor(size, initial) {
        this.size = size; this.data = null; this.count = 0; this.head = 0; this.initial = initial;
    }
    previous(lag, missing = NaN) {
        if (lag > this.count) return this.initial?.get(lag - this.count) ?? missing;
        return this.data[(this.head - lag + this.size) % this.size];
    }
    push(value) {
        if (!this.size) return;
        this.data ??= new Float64Array(this.size);
        this.data[this.head] = value; this.head = (this.head + 1) % this.size; this.count++;
    }
}

const finiteChannelResult = value => Number.isFinite(value) ? value : NaN;
function evaluateSimpleChannelNode(node, reference) {
    if (node.type === 'literal') return node.value;
    if (node.type === 'reference') return reference(node);
    if (node.type === 'unary') return (node.operator === '-' ? -1 : 1) * evaluateSimpleChannelNode(node.value, reference);
    const a = evaluateSimpleChannelNode(node.left, reference), b = evaluateSimpleChannelNode(node.right, reference);
    return finiteChannelResult(node.operator === '+' ? a + b : node.operator === '-' ? a - b : node.operator === '*' ? a * b : a / b);
}

class ChannelOperations {
    constructor(rawCount, definitions = [], options = {}) {
        if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > CHANNEL_LIMIT || !Array.isArray(definitions) ||
            rawCount + definitions.length > CHANNEL_LIMIT) throw new ChannelExpressionError('原始或总通道数量无效，最多 65535 个');
        if (options.symbolVersion !== undefined && ![1, channelOperationsReserved.version].includes(options.symbolVersion))
            throw new ChannelExpressionError('不支持的通道符号版本');
        this.rawCount = rawCount;
        const legacy = options.symbolVersion !== channelOperationsReserved.version;
        this.entries = new Map(); this.order = []; this.history = new Map(); this.sample = 0;
        this.registry = options.registry ?? null;
        // Evaluators only need aliases, rather than a second full catalog per numeric output.
        const aliases = new Map(), definitionNumbers = new Set(definitions.map(definition => definition?.number));
        const namedChannels = this.registry?.entries?.values() ?? (options.names ?? []).map((name, index) => ({ name, number: index + 1 }));
        if (legacy || !this.registry) for (const { name, number } of namedChannels) {
            const normalized = channelOperationsRegistry.normalizeChannelName(name);
            if (number > rawCount && !definitionNumbers.has(number) || (legacy
                ? !isLegacyChannelAlias(normalized) : channelOperationsRegistry.channelNameError(name))) continue;
            aliases.set(normalized, aliases.has(normalized) ? null : number);
        }
        const resolveAlias = token => aliases.get(channelOperationsRegistry.normalizeChannelName(token));
        this.definitions = definitions.map(definition => legacy
            ? channelOperationsSymbols.migrateChannelDefinition(definition, { resolveLegacyReference: resolveAlias }) : { ...definition });
        const resolveReference = token => legacy ? undefined : this.registry?.resolve(token)?.number ?? resolveAlias(token);
        this.channelCount = rawCount;
        for (const definition of this.definitions) {
            const { number, type, expression } = definition;
            if (!Number.isInteger(number) || number <= rawCount || number > CHANNEL_LIMIT || this.entries.has(number))
                throw new ChannelExpressionError('通道编号重复、与原始通道冲突或超出范围', number);
            if (!['formula', 'constant', 'system'].includes(type) || typeof expression !== 'string')
                throw new ChannelExpressionError('通道类型或表达式无效', number);
            const entry = { definition, dependencies: new Set(), ast: null };
            if (type === 'constant') entry.kernel = parseConstantChannel(expression, number);
            else if (type === 'system') entry.system = compileChannelSystem(definition);
            else {
                entry.ast = new ChannelExpressionParser(expression, number, resolveReference).parse();
                definition.expression = channelOperationsRegistry.replaceChannelIdentifiers(expression, token => {
                    const resolved = /^CH\d+$/.test(token) ? Number(token.slice(2)) : resolveReference(token);
                    return Number.isInteger(resolved) ? channelOperationsFormat.formatChannelNumber(resolved) : token;
                });
            }
            this.entries.set(number, entry);
            this.channelCount = Math.max(this.channelCount, number);
        }
        this.lookbacks = new Map();
        for (const entry of this.entries.values()) if (entry.ast) this._check(entry.ast, entry, false);
        // Kahn's algorithm handles the entire 65535-channel DAG without recursive calls.
        const pending = new Map(), dependents = new Map(), ready = [];
        for (const [number, entry] of this.entries) {
            let count = 0;
            for (const dependency of entry.dependencies) if (dependency > rawCount) {
                count++;
                if (!dependents.has(dependency)) dependents.set(dependency, []);
                dependents.get(dependency).push(number);
            }
            pending.set(number, count);
            if (count === 0) ready.push(number);
        }
        for (let at = 0; at < ready.length; at++) {
            const number = ready[at]; this.order.push(number);
            for (const dependent of dependents.get(number) ?? []) {
                const remaining = pending.get(dependent) - 1;
                pending.set(dependent, remaining);
                if (remaining === 0) ready.push(dependent);
            }
        }
        if (this.order.length !== this.entries.size) {
            const number = [...pending].find(([, remaining]) => remaining > 0)[0];
            throw new ChannelExpressionError('通道依赖存在循环', number);
        }
        for (const [number, size] of this.lookbacks) this.history.set(number, new SampleHistory(size));
    }

    /** Reserve state arrays before the first sample; validation itself stays allocation-light. */
    get requiredMemoryBytes() {
        const histories = new Set(this.history.values()), nodes = [...this.entries.values()].map(entry => entry.ast).filter(Boolean);
        let bytes = 0;
        for (const entry of this.entries.values()) if (entry.kernel) bytes += entry.kernel.length * 8;
        while (nodes.length) {
            const node = nodes.pop();
            for (const state of [node.history, node.inputs, node.outputs]) if (state) histories.add(state);
            for (const child of node.args ?? [node.left, node.right, node.value].filter(value => typeof value === 'object'))
                nodes.push(child);
        }
        for (const state of histories) bytes += state.size * 8;
        return bytes;
    }

    _check(node, entry, parameter) {
        const error = message => { throw new ChannelExpressionError(message, entry.definition.number); };
        if (node.type === 'reference') {
            const other = this.entries.get(node.number);
            if (!Number.isInteger(node.number) || node.number < 1 || node.number > this.rawCount && !other)
                error(`引用的 ${typeof node.number === 'number' ? channelOperationsFormat.formatChannelNumber(node.number) : node.number} 不存在`);
            entry.dependencies.add(node.number);
            if (other?.kernel) {
                if (parameter && node.index === null) return 'constant';
                if (node.index === null) error('常量数组参与标量运算时必须指定索引');
                if (node.index < 0 || node.index >= other.kernel.length) error('常量索引超出数组范围');
            } else if (other?.system) {
                if (parameter && node.index === null) return 'system';
                error('系统须通过 FILTER 与输入信号配合使用');
            } else {
                if ((node.index ?? 0) > 0) error('动态通道不支持未来索引');
                const lag = -(node.index ?? 0);
                if (lag) this.lookbacks.set(node.number, Math.max(this.lookbacks.get(node.number) ?? 0, lag));
            }
            return 'scalar';
        }
        if (node.type === 'call') {
            if (node.name === 'FILTER') {
                const kinds = node.args.map(arg => this._check(arg, entry, true));
                const signalIndex = kinds.indexOf('scalar'), parameterIndex = 1 - signalIndex;
                if (signalIndex < 0 || !['constant', 'system'].includes(kinds[parameterIndex]))
                    error('FILTER 需要一个信号和一个常量数组或系统，参数顺序不限');
                node.signal = node.args[signalIndex]; node.parameter = this.entries.get(node.args[parameterIndex].number);
                if (node.parameter.kernel) node.history = new SampleHistory(node.parameter.kernel.length);
                else {
                    const system = node.parameter.system;
                    const initial = prefix => new Map([...system.initial].filter(([key]) => key[0] === prefix)
                        .map(([key, value]) => [-Number(key.slice(2, -1)), value]));
                    node.inputs = new SampleHistory(system.inputSize, initial('X'));
                    node.outputs = new SampleHistory(system.outputSize, initial('Y'));
                }
            } else this._check(node.args[0], entry, false);
        } else for (const child of [node.left, node.right, node.value].filter(value => typeof value === 'object')) this._check(child, entry, false);
        return 'scalar';
    }

    _evaluate(node, current) {
        if (node.type === 'reference') {
            const entry = this.entries.get(node.number);
            if (entry?.kernel) return entry.kernel[node.index];
            return (node.index ?? 0) === 0 ? current[node.number - 1] : this.history.get(node.number).previous(-node.index);
        }
        if (node.type === 'literal') return node.value;
        if (node.type === 'unary') return finiteChannelResult((node.operator === '-' ? -1 : 1) * this._evaluate(node.value, current));
        if (node.type === 'binary') {
            const a = this._evaluate(node.left, current), b = this._evaluate(node.right, current);
            return finiteChannelResult(node.operator === '+' ? a + b : node.operator === '-' ? a - b : node.operator === '*' ? a * b : a / b);
        }
        const value = this._evaluate(node.signal ?? node.args[0], current);
        if (node.name === 'DIFF') {
            const result = value - (node.previous ?? NaN); node.previous = value; return finiteChannelResult(result);
        }
        if (node.name === 'INT') {
            if (!Number.isFinite(value)) return NaN;
            const result = (node.sum ?? 0) + value;
            if (Number.isFinite(result)) node.sum = result;
            return finiteChannelResult(result);
        }
        if (node.parameter.kernel) {
            const kernel = node.parameter.kernel;
            let result = 0;
            for (let k = 0; k < kernel.length; k++) if (kernel[k] !== 0)
                result += kernel[k] * (k === 0 ? value : node.history.previous(k, 0));
            node.history.push(value); return finiteChannelResult(result);
        }
        const result = evaluateSimpleChannelNode(node.parameter.system.ast, reference => reference.number === 'X'
            ? reference.index === 0 ? value : node.inputs.previous(-reference.index)
            : node.outputs.previous(-reference.index));
        node.inputs.push(value); node.outputs.push(result); return finiteChannelResult(result);
    }

    push(samples, overrides) {
        if (samples.length !== this.rawCount) throw new ChannelExpressionError('采样通道数量不匹配');
        const current = Array(this.channelCount).fill(NaN);
        for (let i = 0; i < this.rawCount; i++) current[i] = finiteChannelResult(samples[i]);
        for (const number of this.order) {
            const entry = this.entries.get(number);
            if (entry.ast) current[number - 1] = overrides?.has(number) ? overrides.get(number) : this._evaluate(entry.ast, current);
        }
        for (const [number, history] of this.history) history.push(current[number - 1]);
        this.sample++; return current;
    }

    adoptUnchanged(previous, affected) {
        for (const [number, entry] of this.entries) if (!affected.has(number) && entry.ast)
            entry.ast = previous.entries.get(number)?.ast ?? entry.ast;
        for (const [number, history] of this.history) if (!affected.has(number) && previous.history.has(number) &&
            previous.history.get(number).size === history.size) this.history.set(number, previous.history.get(number));
        this.sample = previous.sample;
    }

    /** Carry state across a pure channel renumbering; newly parsed references use the new IDs. */
    adoptRenumbered(previous, numberMap) {
        const copyState = (target, source) => {
            for (const key of ['previous', 'sum', 'history', 'inputs', 'outputs'])
                if (Object.hasOwn(source, key)) target[key] = source[key];
            const children = node => node.args ?? [node.left, node.right, node.value].filter(value => typeof value === 'object');
            const oldChildren = children(source);
            children(target).forEach((child, index) => copyState(child, oldChildren[index]));
        };
        for (const [oldNumber, number] of numberMap) {
            const old = previous.entries.get(oldNumber), entry = this.entries.get(number);
            if (old?.ast && entry?.ast) copyState(entry.ast, old.ast);
            const history = previous.history.get(oldNumber);
            if (history && this.history.get(number)?.size === history.size) this.history.set(number, history);
        }
        this.sample = previous.sample;
    }
}

function renumberChannelExpression(text, numberMap) {
    return channelOperationsRegistry.replaceChannelIdentifiers(text, token => {
        const number = channelOperationsFormat.parseChannelId(token);
        return number === null ? token : channelOperationsFormat.formatChannelNumber(numberMap.get(number) ?? number);
    });
}

const ChannelOperationsApi = { ChannelOperations, ChannelExpressionError, CHANNEL_LIMIT, CHANNEL_HISTORY_LIMIT,
    evaluateSimpleChannelNode, renumberChannelExpression, resolveChannelExpression: channelOperationsRegistry.resolveChannelExpression };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, ChannelOperationsApi);
if (typeof module !== 'undefined') module.exports = ChannelOperationsApi;

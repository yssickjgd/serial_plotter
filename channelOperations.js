/** Safe sample-domain expressions. Each stateful node advances exactly once per sample. */
const CHANNEL_LIMIT = 256;
const CHANNEL_HISTORY_LIMIT = 65536;

class ChannelExpressionError extends Error {
    constructor(message, number, position) {
        super(`${number ? `CH${String(number).padStart(2, '0')}: ` : ''}${message}${position === undefined ? '' : `（位置 ${position + 1}）`}`);
        this.channelNumber = number;
        this.position = position;
    }
}

class ChannelExpressionParser {
    constructor(text, number) {
        if (typeof text !== 'string' || !text.trim() || text.length > 8192)
            throw new ChannelExpressionError('请输入不超过 8192 字符的表达式', number);
        this.text = text; this.number = number; this.at = 0; this.depth = 0;
        if (/\+\+|--/.test(text)) this.fail('请用括号明确相邻正负号');
        this.next();
    }

    fail(message) { throw new ChannelExpressionError(message, this.number, this.at); }
    next() {
        while (/\s/.test(this.text[this.at] ?? '') && this.at < this.text.length) this.at++;
        const rest = this.text.slice(this.at);
        const match = rest.match(/^(?:(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|[+\-*/(),\[\]])/);
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
        if (/^CH\d+$/.test(token) || token === 'x' || token === 'y') {
            this.next(); let index = null;
            if (this.token === '[') {
                this.next(); let sign = 1;
                if (this.token === 'n') {
                    this.next(); index = 0;
                    if (this.token === '-') { this.next(); sign = -1; index = this.integer() * sign; }
                } else {
                    if (this.token === '-') { sign = -1; this.next(); }
                    index = this.integer() * sign;
                }
                this.take(']');
            }
            return { type: 'reference', number: token.startsWith('CH') ? Number(token.slice(2)) : token, index };
        }
        if (['diff', 'int', 'filter'].includes(token)) {
            this.next(); this.take('('); const args = [this.expression()];
            while (this.token === ',') { this.next(); args.push(this.expression()); }
            this.take(')');
            const count = token === 'diff' || token === 'int' ? 1 : 2;
            if (args.length !== count) this.fail(`${token} 需要 ${count} 个参数`);
            return { type: 'call', name: token, args };
        }
        this.fail('只支持 CHxx、四则运算、diff、int 和 filter；filter 需要信号与常量数组或系统，顺序不限');
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
    visit(node);
    for (const child of node.args ?? [node.left, node.right, node.value].filter(value => typeof value === 'object'))
        walkChannelExpression(child, visit);
}

function compileChannelSystem(definition) {
    const { number } = definition;
    const text = definition.expression.replace(/^\s*y\[(?:n|0)\]\s*=\s*/, '');
    const ast = new ChannelExpressionParser(text, number).parse(), required = new Set();
    walkChannelExpression(ast, node => {
        if (node.type === 'call') throw new ChannelExpressionError('差分方程内使用 x、y 和四则运算', number);
        if (node.type !== 'reference') return;
        if (!['x', 'y'].includes(node.number)) throw new ChannelExpressionError('差分方程使用 x 表示输入、y 表示输出', number);
        node.index ??= 0;
        if (node.index > 0 || node.number === 'y' && node.index === 0)
            throw new ChannelExpressionError('系统不允许未来输入或当前输出反馈；请使用 y[-1] 等历史状态', number);
        for (let i = -1; i >= node.index; i--) required.add(`${node.number}[${i}]`);
    });
    const initial = new Map();
    for (const part of (definition.initial ?? '').split(/[,;\n]+/).filter(value => value.trim())) {
        const match = part.trim().match(/^([xy])\[(-\d+)\]\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/);
        if (!match || !Number.isFinite(Number(match[3]))) throw new ChannelExpressionError('初始状态格式为 y[-1]=0 或 x[-1]=0，数值必须有限', number);
        const key = `${match[1]}[${Number(match[2])}]`;
        if (!required.has(key) || initial.has(key)) throw new ChannelExpressionError(`初始状态 ${key} 重复或未使用`, number);
        initial.set(key, Number(match[3]));
    }
    for (const key of required) if (!initial.has(key)) throw new ChannelExpressionError(`请明确初始状态 ${key}`, number);
    return { ast, initial, inputSize: Math.max(0, ...[...required].filter(key => key[0] === 'x').map(key => -Number(key.slice(2, -1)))),
        outputSize: Math.max(0, ...[...required].filter(key => key[0] === 'y').map(key => -Number(key.slice(2, -1)))) };
}

class SampleHistory {
    constructor(size, initial) {
        this.size = size; this.data = new Float64Array(size); this.count = 0; this.head = 0; this.initial = initial;
    }
    previous(lag, missing = NaN) {
        if (lag > this.count) return this.initial?.get(lag - this.count) ?? missing;
        return this.data[(this.head - lag + this.size) % this.size];
    }
    push(value) {
        if (!this.size) return;
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
    constructor(rawCount, definitions = []) {
        this.rawCount = rawCount; this.definitions = definitions.map(definition => ({ ...definition }));
        this.entries = new Map(); this.order = []; this.history = new Map(); this.sample = 0;
        if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 50 || !Array.isArray(definitions))
            throw new ChannelExpressionError('原始通道数量无效');
        for (const definition of this.definitions) {
            const { number, type, expression } = definition;
            if (!Number.isInteger(number) || number <= rawCount || number > CHANNEL_LIMIT || this.entries.has(number))
                throw new ChannelExpressionError('通道编号重复、与原始通道冲突或超出范围', number);
            if (!['formula', 'constant', 'system'].includes(type) || typeof expression !== 'string')
                throw new ChannelExpressionError('通道类型或表达式无效', number);
            const entry = { definition, dependencies: new Set(), ast: null };
            if (type === 'constant') entry.kernel = parseConstantChannel(expression, number);
            else if (type === 'system') entry.system = compileChannelSystem(definition);
            else entry.ast = new ChannelExpressionParser(expression, number).parse();
            this.entries.set(number, entry);
        }
        this.channelCount = Math.max(rawCount, ...this.entries.keys());
        this.lookbacks = new Map();
        for (const entry of this.entries.values()) if (entry.ast) this._check(entry.ast, entry, false);
        const visiting = new Set(), visited = new Set();
        const visit = number => {
            if (visited.has(number) || number <= rawCount) return;
            if (visiting.has(number)) throw new ChannelExpressionError('通道依赖存在循环', number);
            visiting.add(number);
            for (const dependency of this.entries.get(number).dependencies) visit(dependency);
            visiting.delete(number); visited.add(number); this.order.push(number);
        };
        for (const number of this.entries.keys()) visit(number);
        for (const [number, size] of this.lookbacks) this.history.set(number, new SampleHistory(size));
    }

    _check(node, entry, parameter) {
        const error = message => { throw new ChannelExpressionError(message, entry.definition.number); };
        if (node.type === 'reference') {
            const other = this.entries.get(node.number);
            if (!Number.isInteger(node.number) || node.number < 1 || node.number > this.rawCount && !other)
                error(`引用的 CH${String(node.number).padStart(2, '0')} 不存在`);
            entry.dependencies.add(node.number);
            if (other?.kernel) {
                if (parameter && node.index === null) return 'constant';
                if (node.index === null) error('常量数组参与标量运算时必须指定索引');
                if (node.index < 0 || node.index >= other.kernel.length) error('常量索引超出数组范围');
            } else if (other?.system) {
                if (parameter && node.index === null) return 'system';
                error('系统须通过 filter 与输入信号配合使用');
            } else {
                if ((node.index ?? 0) > 0) error('动态通道不支持未来索引');
                const lag = -(node.index ?? 0);
                this.lookbacks.set(node.number, Math.max(this.lookbacks.get(node.number) ?? 0, lag));
            }
            return 'scalar';
        }
        if (node.type === 'call') {
            if (node.name === 'filter') {
                const kinds = node.args.map(arg => this._check(arg, entry, true));
                const signalIndex = kinds.indexOf('scalar'), parameterIndex = 1 - signalIndex;
                if (signalIndex < 0 || !['constant', 'system'].includes(kinds[parameterIndex]))
                    error('filter 需要一个信号和一个常量数组或系统，参数顺序不限');
                node.signal = node.args[signalIndex]; node.parameter = this.entries.get(node.args[parameterIndex].number);
                if (node.parameter.kernel) node.history = new SampleHistory(node.parameter.kernel.length);
                else {
                    const system = node.parameter.system;
                    const initial = prefix => new Map([...system.initial].filter(([key]) => key[0] === prefix)
                        .map(([key, value]) => [-Number(key.slice(2, -1)), value]));
                    node.inputs = new SampleHistory(system.inputSize, initial('x'));
                    node.outputs = new SampleHistory(system.outputSize, initial('y'));
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
        if (node.name === 'diff') {
            const result = value - (node.previous ?? NaN); node.previous = value; return finiteChannelResult(result);
        }
        if (node.name === 'int') {
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
        const result = evaluateSimpleChannelNode(node.parameter.system.ast, reference => reference.number === 'x'
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
    return text.replace(/\bCH(\d+)\b/g, (token, digits) => numberMap.has(Number(digits))
        ? `CH${String(numberMap.get(Number(digits))).padStart(2, '0')}` : token);
}

const ChannelOperationsApi = { ChannelOperations, ChannelExpressionError, CHANNEL_LIMIT, CHANNEL_HISTORY_LIMIT,
    evaluateSimpleChannelNode, renumberChannelExpression };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, ChannelOperationsApi);
if (typeof module !== 'undefined') module.exports = ChannelOperationsApi;

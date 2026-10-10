/** Zero-state discrete-system response. This is transfer gain, not a sampled amplitude spectrum. */
const systemSpectrum = typeof module !== 'undefined' ? require('./spectrum') : globalThis.SerialPlotter;
const systemChannels = typeof module !== 'undefined' ? require('./channelOperations') : globalThis.SerialPlotter;

function linearSystemExpression(node) {
    const combine = (left, right, factor = 1) => {
        const terms = new Map(left.terms);
        for (const [key, value] of right.terms) terms.set(key, (terms.get(key) ?? 0) + factor * value);
        return { constant: left.constant + factor * right.constant, terms };
    };
    const scale = (value, factor) => ({ constant: value.constant * factor,
        terms: new Map([...value.terms].map(([key, coefficient]) => [key, coefficient * factor])) });
    if (node.type === 'literal') return { constant: node.value, terms: new Map() };
    if (node.type === 'reference') return { constant: 0, terms: new Map([[`${node.number}:${-(node.index ?? 0)}`, 1]]) };
    if (node.type === 'unary') return scale(linearSystemExpression(node.value), node.operator === '-' ? -1 : 1);
    const left = linearSystemExpression(node.left), right = linearSystemExpression(node.right);
    if (node.operator === '+') return combine(left, right);
    if (node.operator === '-') return combine(left, right, -1);
    if (node.operator === '*') {
        if (left.terms.size && right.terms.size) throw new Error('非线性差分方程不能显示标准频率响应');
        return left.terms.size ? scale(left, right.constant) : scale(right, left.constant);
    }
    if (right.terms.size || right.constant === 0) throw new Error('频率响应要求除数为非零常量');
    return scale(left, 1 / right.constant);
}

function systemCoefficients(entry) {
    if (entry.kernel) return { b: Float64Array.from(entry.kernel), a: Float64Array.of(1) };
    const expression = linearSystemExpression(entry.system.ast);
    if (expression.constant !== 0) throw new Error('含独立偏置的差分方程不能显示标准频率响应');
    const b = new Float64Array(entry.system.inputSize + 1), a = new Float64Array(entry.system.outputSize + 1);
    a[0] = 1;
    for (const [key, value] of expression.terms) {
        if (!Number.isFinite(value)) throw new Error('系统系数必须为有限数值');
        const [kind, delay] = key.split(':');
        if (kind === 'x') b[Number(delay)] += value; else a[Number(delay)] -= value;
    }
    return { b, a };
}

function prepareSystemResponse(entry, count = 1000, gridSize = count) {
    if (!Number.isInteger(count) || count < 2 || count > 65536) throw new RangeError('系统响应采样点数需为 2–65536');
    const samples = entry.kernel ? Float64Array.from(entry.kernel) : new Float64Array(count);
    if (entry.system) for (let i = 0; i < count; i++) {
        const value = systemChannels.evaluateSimpleChannelNode(entry.system.ast, reference => {
            const index = i + (reference.index ?? 0);
            return reference.number === 'x' ? index === 0 ? 1 : 0 : index >= 0 ? samples[index] : 0;
        });
        samples[i] = Number.isFinite(value) ? value : NaN;
    }
    let b, a;
    try { ({ b, a } = systemCoefficients(entry)); }
    catch (error) { return { samples, mags: [], phases: [], fftSize: 0, error: error.message }; }
    const fftSize = systemSpectrum.nextPow2(Math.max(b.length, a.length, gridSize));
    const br = new Float64Array(fftSize), bi = new Float64Array(fftSize);
    const ar = new Float64Array(fftSize), ai = new Float64Array(fftSize);
    br.set(b); ar.set(a);
    systemSpectrum.fftInPlace(br, bi); systemSpectrum.fftInPlace(ar, ai);
    const mags = [], phases = [];
    const denominatorScale = a.reduce((sum, value) => sum + Math.abs(value), 0);
    for (let i = 0; i <= fftSize / 2; i++) {
        const numerator = Math.hypot(br[i], bi[i]), denominator = Math.hypot(ar[i], ai[i]);
        const valid = denominator > denominatorScale * Number.EPSILON * 16;
        mags.push(valid ? numerator / denominator : NaN);
        phases.push(valid && numerator > 0 ?
            (Math.atan2(bi[i], br[i]) - Math.atan2(ai[i], ar[i])) * 180 / Math.PI : NaN);
    }
    const peak = Math.max(...mags.filter(Number.isFinite));
    for (let i = 0; i < phases.length; i++) {
        if (!(mags[i] > peak * 1e-12)) phases[i] = NaN;
        else phases[i] = ((phases[i] + 180) % 360 + 360) % 360 - 180;
    }
    return { samples, mags, phases, fftSize, error: '' };
}

function decibelMagnitude(value, factor = 20) {
    return value > 0 && Number.isFinite(value) ? factor * Math.log10(value) : NaN;
}

function unwrapPhaseDegrees(phases) {
    let previous = null, offset = 0;
    return Array.from(phases, value => {
        if (!Number.isFinite(value)) { previous = null; offset = 0; return NaN; }
        if (previous !== null) offset -= Math.round((value - previous) / 360) * 360;
        previous = value; return value + offset;
    });
}

const SystemResponse = { prepareSystemResponse, decibelMagnitude, unwrapPhaseDegrees };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, SystemResponse);
if (typeof module !== 'undefined') module.exports = SystemResponse;

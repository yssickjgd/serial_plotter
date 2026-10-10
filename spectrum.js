function nextPow2(n) {
    let value = 1;
    while (value < n) value *= 2;
    return value;
}

function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const angle = -2 * Math.PI / len;
        const stepRe = Math.cos(angle);
        const stepIm = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let wRe = 1, wIm = 0;
            for (let j = 0; j < len / 2; j++) {
                const uRe = re[i + j], uIm = im[i + j];
                const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
                const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
                re[i + j] = uRe + vRe;
                im[i + j] = uIm + vIm;
                re[i + j + len / 2] = uRe - vRe;
                im[i + j + len / 2] = uIm - vIm;
                const nextRe = wRe * stepRe - wIm * stepIm;
                wIm = wRe * stepIm + wIm * stepRe;
                wRe = nextRe;
            }
        }
    }
}

const FFT_WINDOWS = ['rectangular', 'hann', 'hamming', 'blackman', 'flatTop'];

function windowCoefficient(type, index, length) {
    if (type === 'rectangular' || length <= 2) return 1;
    const angle = 2 * Math.PI * index / (length - 1);
    if (type === 'hann') return 0.5 - 0.5 * Math.cos(angle);
    if (type === 'hamming') return 0.54 - 0.46 * Math.cos(angle);
    if (type === 'blackman') return 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle);
    return 0.21557895 - 0.41663158 * Math.cos(angle) +
        0.277263158 * Math.cos(2 * angle) - 0.083578947 * Math.cos(3 * angle) +
        0.006947368 * Math.cos(4 * angle);
}

/** Windowed, coherent-gain-corrected one-sided amplitude spectrum. */
function prepareFrequencySeries(values, removeDc = false, windowType = 'hann') {
    if (!FFT_WINDOWS.includes(windowType)) throw new RangeError('FFT 窗函数无效');
    if (values.length < 2) return { mags: [], dominantBin: 0, fftSize: 0 };
    if (!values.some(Number.isFinite)) return { mags: [], dominantBin: 0, fftSize: 0 };
    const fftSize = nextPow2(values.length);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    let mean = 0;
    if (removeDc) {
        let count = 0;
        for (const value of values) if (Number.isFinite(value)) {
            count++;
            mean += (value - mean) / count;
        }
    }
    let windowGain = 0;
    for (let i = 0; i < values.length; i++) {
        const window = windowCoefficient(windowType, i, values.length);
        windowGain += window;
        if (Number.isFinite(values[i])) {
            re[i] = (values[i] - mean) * window;
        }
    }
    fftInPlace(re, im);
    const mags = new Array((fftSize >> 1) + 1);
    const phases = new Array(mags.length);
    let dominantBin = 0, dominantMag = -Infinity;
    for (let i = 0; i < mags.length; i++) {
        const oneSidedFactor = i === 0 || i === fftSize / 2 ? 1 : 2;
        const rawMagnitude = Math.hypot(re[i], im[i]);
        const magnitude = rawMagnitude * oneSidedFactor / windowGain;
        mags[i] = magnitude;
        phases[i] = rawMagnitude > 0 ? Math.atan2(im[i], re[i]) * 180 / Math.PI : NaN;
        if (rawMagnitude > dominantMag) { dominantMag = rawMagnitude; dominantBin = i; }
    }
    const peak = mags[dominantBin];
    for (let i = 0; i < phases.length; i++) if (!(mags[i] > peak * 1e-12)) phases[i] = NaN;
    return { mags, phases, dominantBin, fftSize };
}

if (typeof module !== 'undefined') module.exports = { prepareFrequencySeries, FFT_WINDOWS, fftInPlace, nextPow2 };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.prepareFrequencySeries = prepareFrequencySeries;
globalThis.SerialPlotter.FFT_WINDOWS = FFT_WINDOWS;
globalThis.SerialPlotter.fftInPlace = fftInPlace;
globalThis.SerialPlotter.nextPow2 = nextPow2;

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

/** Hann-windowed magnitude spectrum; frequency is expressed as a sample fraction. */
function prepareFrequencySeries(values, removeDc = false) {
    if (values.length < 2) return { mags: [], dominantBin: 0, fftSize: 0 };
    const fftSize = nextPow2(values.length);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    let mean = 0;
    if (removeDc) {
        let count = 0;
        for (const value of values) if (Number.isFinite(value)) { mean += value; count++; }
        mean /= count || 1;
    }
    for (let i = 0; i < values.length; i++) {
        const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (values.length - 1));
        re[i] = Number.isFinite(values[i]) ? (values[i] - mean) * window : 0;
    }
    fftInPlace(re, im);
    const mags = new Array((fftSize >> 1) + 1);
    let dominantBin = 1, dominantMag = -Infinity;
    for (let i = 0; i < mags.length; i++) {
        const magnitude = Math.hypot(re[i], im[i]) / fftSize;
        mags[i] = magnitude;
        if (i > 0 && magnitude > dominantMag) { dominantMag = magnitude; dominantBin = i; }
    }
    return { mags, dominantBin, fftSize };
}

if (typeof module !== 'undefined') module.exports = { prepareFrequencySeries };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.prepareFrequencySeries = prepareFrequencySeries;

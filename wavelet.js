/** Frequency-domain continuous wavelet analysis with unit response at the center frequency. */
(function (root) {
    const S = root.SerialPlotter ??= {};
    const { fftInPlace, nextPow2 } = typeof module !== 'undefined' ? require('./spectrum') : S;

    function createWaveletFactory(fft, pow2) {
        // Approximate effective support in cycles.
        const bases = {
            morlet: { support: 1.8, complex: true },
            morse: { support: 2.2, complex: true },
            mexicanHat: { support: .85, complex: false }
        };
        function response(basis, ratio) {
            if (basis === 'morse') {
                // Generalized Morse, beta = 20, gamma = 3.
                return Math.exp(20 * (Math.log(ratio) + (1 - ratio ** 3) / 3));
            }
            if (basis === 'morlet') {
                // Center angular frequency 6, with a zero-mean correction.
                return Math.exp(-18 * (ratio - 1) ** 2) * -Math.expm1(-36 * ratio) / -Math.expm1(-36);
            }
            // Negative second derivative of a Gaussian.
            return ratio * ratio * Math.exp(1 - ratio * ratio);
        }
        function highBandStart(basis, nyquist) {
            // Shade centers whose filter retains at least 10% of its peak
            // magnitude at the Nyquist boundary.
            let low = 1, high = 4;
            for (let i = 0; i < 30; i++) {
                const ratio = (low + high) / 2;
                if (response(basis, ratio) >= .1) low = ratio;
                else high = ratio;
            }
            return nyquist / low;
        }
        function supportAtSamples(values, cuts) {
            const distance = new Int32Array(values.length);
            let boundary = -1, cursor = 0;
            for (let i = 0; i < values.length; i++) {
                if (i === cuts[cursor]) { boundary = i - 1; cursor++; }
                if (!Number.isFinite(values[i])) boundary = i;
                distance[i] = i - boundary;
            }
            boundary = values.length; cursor = cuts.length - 1;
            for (let i = values.length - 1; i >= 0; i--) {
                if (i + 1 === cuts[cursor]) { boundary = i + 1; cursor--; }
                if (!Number.isFinite(values[i])) boundary = i;
                distance[i] = Math.min(distance[i], boundary - i);
            }
            return distance;
        }
        function createWaveletProcessor({ values, rate, basis, cuts = [], columnLimit = 768, minimumHop = 1,
            first = 0, last = values.length - 1 }) {
            const profile = bases[basis];
            if (!profile || !(values instanceof Float64Array) || values.length > 65536 ||
                !Number.isFinite(rate) || rate <= 0) throw new RangeError('小波分析参数无效');
            const length = values.length;
            const nyquist = rate / 2, minHz = 2.2 * profile.support * rate / length;
            // Reserve an additional magnitude-only row at Nyquist for a complex
            // basis. The last phase center is one unpadded frequency step lower.
            const maxHz = profile.complex ? nyquist - rate / length : nyquist;
            const octaves = Math.log2(maxHz / minHz);
            const scales = length >= 16 && octaves > 0 ? Math.min(96, Math.max(2, Math.ceil(octaves * (7 + Math.log2(length) / 2)))) : 0;
            const rows = scales + Number(scales > 0 && profile.complex);
            first = Math.max(0, Math.min(length - 1, Math.floor(first)));
            last = Math.max(first, Math.min(length - 1, Math.ceil(last)));
            const hop = pow2(Math.max(minimumHop, (last - first + 1) / Math.max(32, Math.min(1024, columnLimit))));
            first = Math.floor(first / hop) * hop;
            const columns = length ? Math.floor((last - first) / hop) + 1 : 0;
            const output = { first, hop, columns, highBandStart: highBandStart(basis, nyquist), frequencies: new Float64Array(rows),
                magnitude: new Float64Array(rows * columns).fill(NaN),
                phase: profile.complex ? new Float64Array(rows * columns).fill(NaN) : null, peak: 0 };
            const size = rows ? pow2(2 * length) : 0;
            const outSize = size / hop;
            let signalRe, signalIm, rowRe, rowIm, support, row = 0;
            function initialize() {
                support = supportAtSamples(values, cuts);
                signalRe = new Float64Array(size); signalIm = new Float64Array(size);
                for (let i = 0; i < length; i++) if (Number.isFinite(values[i])) signalRe[i] = values[i];
                fft(signalRe, signalIm);
                rowRe = new Float64Array(outSize); rowIm = new Float64Array(outSize);
            }
            function computeRow() {
                const atNyquist = row === rows - 1;
                const hz = atNyquist ? nyquist : row === scales - 1 ? maxHz : minHz * 2 ** (row / (scales - 1) * octaves);
                // At Nyquist the positive and negative frequencies coincide.
                // Use the real response there and count the self-conjugate bin once.
                const complex = profile.complex && !atNyquist;
                output.frequencies[row] = hz;
                const radius = Math.ceil(profile.support * rate / hz);
                rowRe.fill(0); rowIm.fill(0);
                const centerBin = hz * size / rate;
                // Folding the spectrum computes exactly the inverse FFT at
                // every hop-th input position, without decimating the signal.
                for (let bin = 1, end = Math.min(size / 2, Math.ceil(centerBin * 6)); bin <= end; bin++) {
                    const weight = response(basis, bin / centerBin);
                    if (weight < 1e-12) continue;
                    const index = bin % outSize;
                    if (bin === size / 2) rowRe[index] += weight * signalRe[bin];
                    else if (complex) {
                        rowRe[index] += 2 * weight * signalRe[bin];
                        rowIm[index] -= 2 * weight * signalIm[bin];
                    } else {
                        const opposite = (outSize - index) % outSize;
                        rowRe[index] += weight * signalRe[bin]; rowRe[opposite] += weight * signalRe[bin];
                        rowIm[index] -= weight * signalIm[bin]; rowIm[opposite] += weight * signalIm[bin];
                    }
                }
                fft(rowRe, rowIm);
                for (let column = 0; column < columns; column++) {
                    if (support[first + column * hop] <= radius) continue;
                    const i = first / hop + column, index = row * columns + column;
                    const re = rowRe[i], im = -rowIm[i];
                    const magnitude = (complex ? Math.hypot(re, im) : Math.abs(re)) / size;
                    output.magnitude[index] = magnitude;
                    if (magnitude > output.peak) output.peak = magnitude;
                    if (complex && magnitude > 0) output.phase[index] = Math.atan2(im, re);
                }
                row++;
            }
            return {
                step(budget) {
                    if (row >= rows) return true;
                    if (!signalRe) initialize();
                    const count = budget === Infinity ? rows : Math.max(1, Math.floor(budget / size));
                    const end = Math.min(rows, row + count);
                    while (row < end) computeRow();
                    return row === rows;
                },
                result() { return output; }
            };
        }
        return { createWaveletProcessor, waveletSupportsPhase: basis => bases[basis]?.complex === true };
    }

    const api = { ...createWaveletFactory(fftInPlace, nextPow2),
        createWaveletSource: () => '(' + createWaveletFactory.toString() + ')(fftInPlace, nextPow2).createWaveletProcessor' };
    Object.assign(S, api);
    if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

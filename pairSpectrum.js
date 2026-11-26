(function (root) {
    const S = root.SerialPlotter ??= {};
    const { fftInPlace, FFT_WINDOWS, windowCoefficient } = typeof module !== 'undefined' ? require('./spectrum') : S;
    const relativePowerFloor = 1e-12;

    function blockScale(values, start, size, removeDc) {
        const reference = removeDc ? values[start] : 0;
        let peak = 0;
        for (let i = start; i < start + size; i++) {
            const difference = Math.abs(values[i] - reference);
            const magnitude = Number.isFinite(difference) ? difference : Math.max(Math.abs(values[i]), Math.abs(reference));
            peak = Math.max(peak, magnitude);
        }
        return peak;
    }

    function transformBlock(values, start, scale, removeDc, window, real, imaginary) {
        const reference = removeDc ? values[start] : 0;
        let sum = 0;
        for (let i = 0; i < real.length; i++) {
            const value = values[start + i];
            const difference = value - reference;
            real[i] = Number.isFinite(difference) ? difference / scale : value / scale - reference / scale;
            sum += real[i];
        }
        const mean = removeDc ? sum / real.length : 0;
        for (let i = 0; i < real.length; i++) real[i] = (real[i] - mean) * window[i];
        imaginary.fill(0);
        fftInPlace(real, imaginary);
    }

    function spectrumHop(fftSize, overlap) {
        return fftSize - Math.floor(fftSize * overlap / 100);
    }

    function countSpectrumBlocks(segments, fftSize, overlap) {
        const hop = spectrumHop(fftSize, overlap);
        let blocks = 0;
        for (const { x } of segments) {
            if (x.length >= fftSize) blocks += 1 + Math.floor((x.length - fftSize) / hop);
        }
        return blocks;
    }

    /** One-sided Welch phase, coherence and optional H1 magnitude for Y relative to X. */
    function pairSpectrum(segments, { fftSize, fftWindow = 'hann', fftRemoveDc = false, fftOverlap = 50, gainUnit = null }) {
        if (!Number.isInteger(fftSize) || fftSize < 2 || fftSize >= 2 ** 30 || (fftSize & (fftSize - 1)) !== 0) {
            throw new RangeError('FFT 长度必须是 2 的幂');
        }
        if (!FFT_WINDOWS.includes(fftWindow)) throw new RangeError('FFT 窗函数无效');
        if (!Number.isInteger(fftOverlap) || fftOverlap < 0 || fftOverlap > 75) {
            throw new RangeError('FFT 重叠比例必须是 0 至 75 的整数');
        }
        if (![null, 'ratio', 'db10', 'db'].includes(gainUnit)) throw new RangeError('幅度比单位无效');
        const dbFactor = gainUnit === 'db10' ? 10 : gainUnit === 'db' ? 20 : 0;
        const hop = spectrumHop(fftSize, fftOverlap);
        const bins = fftSize / 2 + 1;
        const phase = new Float64Array(bins).fill(NaN);
        const coherence = new Float64Array(bins).fill(NaN);
        const blocks = countSpectrumBlocks(segments, fftSize, fftOverlap);
        const result = { phase, coherence, blocks };
        const gain = gainUnit === null ? null : new Float64Array(bins).fill(NaN);
        if (gain) result.gain = gain;
        if (blocks < 2) return result;

        // A single scale per channel keeps block powers comparable and prevents FFT overflow.
        // With DC removal, measure differences within blocks so discarded offsets cannot set the scale.
        let xScale = 0, yScale = 0;
        for (const { x, y } of segments) {
            for (let start = 0; start + fftSize <= x.length; start += hop) {
                xScale = Math.max(xScale, blockScale(x, start, fftSize, fftRemoveDc));
                yScale = Math.max(yScale, blockScale(y, start, fftSize, fftRemoveDc));
            }
        }
        if (xScale === 0 || yScale === 0 && !gain) return result;

        const window = Float64Array.from({ length: fftSize }, (_, i) => windowCoefficient(fftWindow, i, fftSize));
        const xReal = new Float64Array(fftSize), xImaginary = new Float64Array(fftSize);
        const yReal = new Float64Array(fftSize), yImaginary = new Float64Array(fftSize);
        const xPower = new Float64Array(bins), yPower = new Float64Array(bins);
        const crossReal = new Float64Array(bins), crossImaginary = new Float64Array(bins);
        for (const { x, y } of segments) {
            for (let start = 0; start + fftSize <= x.length; start += hop) {
                transformBlock(x, start, xScale, fftRemoveDc, window, xReal, xImaginary);
                transformBlock(y, start, yScale || 1, fftRemoveDc, window, yReal, yImaginary);
                for (let i = 0; i < bins; i++) {
                    const xr = xReal[i], xi = xImaginary[i], yr = yReal[i], yi = yImaginary[i];
                    xPower[i] += xr * xr + xi * xi;
                    yPower[i] += yr * yr + yi * yi;
                    crossReal[i] += xr * yr + xi * yi;
                    crossImaginary[i] += xr * yi - xi * yr;
                }
            }
        }
        let xPeak = 0, yPeak = 0;
        for (let i = 0; i < bins; i++) {
            xPeak = Math.max(xPeak, xPower[i]);
            yPeak = Math.max(yPeak, yPower[i]);
        }
        const xFloor = xPeak * relativePowerFloor, yFloor = yPeak * relativePowerFloor;
        const scaleRatio = gain ? yScale / xScale : 0;
        const logScaleRatio = gain ? Math.log10(yScale) - Math.log10(xScale) : 0;
        for (let i = 0; i < bins; i++) {
            const yPresent = yPower[i] > yFloor;
            if (xPower[i] <= xFloor || !yPresent && !gain) continue;
            const crossMagnitude = Math.hypot(crossReal[i], crossImaginary[i]);
            if (gain) {
                // Divide the averaged cross-spectrum by input power, then undo the FFT normalization.
                if (crossMagnitude === 0) {
                    if (gainUnit === 'ratio') gain[i] = 0;
                } else {
                    const relative = crossMagnitude / xPower[i];
                    if (dbFactor) gain[i] = dbFactor * (Math.log10(relative) + logScaleRatio);
                    else {
                        const direct = relative * scaleRatio;
                        const ratio = direct > 0 && Number.isFinite(direct) ? direct : 10 ** (Math.log10(relative) + logScaleRatio);
                        if (Number.isFinite(ratio)) gain[i] = ratio;
                    }
                }
            }
            if (!yPresent) continue;
            const normalizedMagnitude = crossMagnitude / Math.sqrt(xPower[i]) / Math.sqrt(yPower[i]);
            coherence[i] = Math.min(1, normalizedMagnitude ** 2);
            if (crossMagnitude > 0) phase[i] = Math.atan2(crossImaginary[i], crossReal[i]);
        }
        return result;
    }

    function createPairSpectrumSource() {
        return `(() => {
            const relativePowerFloor = ${relativePowerFloor};
            ${blockScale}
            ${transformBlock}
            ${spectrumHop}
            ${countSpectrumBlocks}
            ${pairSpectrum}
            return pairSpectrum;
        })()`;
    }

    Object.assign(S, { pairSpectrum, countSpectrumBlocks, createPairSpectrumSource });
    if (typeof module !== 'undefined') module.exports = { pairSpectrum, countSpectrumBlocks, createPairSpectrumSource };
})(globalThis);

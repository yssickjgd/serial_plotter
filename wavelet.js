/** Frequency-domain continuous wavelet analysis with unit response at the center frequency. */
(function (root) {
    const S = root.SerialPlotter ??= {};
    const { fftInPlace, nextPow2 } = typeof module !== 'undefined' ? require('./spectrum') : S;
    const { createAdditionalWaveletFamilies } = typeof module !== 'undefined' ? require('./waveletFamilies') : S;

    function createWaveletFactory(fft, pow2, additionalFamilies) {
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
            if (bases[basis].weight) return nyquist / bases[basis].edgeRatio;
            let low = 1, high = 4;
            for (let i = 0; i < 30; i++) {
                const ratio = (low + high) / 2;
                if (response(basis, ratio) >= .1) low = ratio;
                else high = ratio;
            }
            return nyquist / low;
        }
        const minimumCycles = 2.2;
        const maxWindowPoints = 65536;
        const maxWaveletGridBytes = 384 * 1024 * 1024;
        const waveletContextSamples = count => Math.ceil(count / minimumCycles);
        // Share a 96 MiB cache allowance among the main context and the pool's possible workers.
        const contexts = Math.max(1, (globalThis.navigator?.hardwareConcurrency || 4) - 1);
        const cacheBudget = Math.floor(Math.min(16 * 1048576, 96 * 1048576 / contexts));
        const planBudget = Math.floor(cacheBudget / 2);
        const plans = new Map(), banks = new Map();
        let planBytes = 0, weightBytes = 0;

        function fftPlan(size) {
            const bytes = size * 20 + 128;
            if (bytes > planBudget) return null;
            const cached = plans.get(size);
            if (cached) {
                plans.delete(size); plans.set(size, cached);
                return cached;
            }
            while (planBytes + bytes > planBudget) {
                const oldest = plans.keys().next().value;
                planBytes -= plans.get(oldest).bytes;
                plans.delete(oldest);
            }
            // Unused FFT-plan capacity can hold filter weights. Reclaim it only when
            // a new transform length actually needs a plan.
            while (weightBytes + planBytes + bytes > cacheBudget) {
                const bank = banks.values().next().value;
                if (banks.size > 1) discardOldestBank();
                else {
                    const key = bank.entries.keys().next().value;
                    const removed = bank.entries.get(key).weights.byteLength + 192;
                    bank.entries.delete(key); bank.bytes -= removed; weightBytes -= removed;
                }
            }
            const reverse = new Uint32Array(size), twiddles = new Float64Array(2 * size);
            for (let i = 1, j = 0; i < size; i++) {
                let bit = size >> 1;
                for (; j & bit; bit >>= 1) j ^= bit;
                j ^= bit;
                reverse[i] = j;
            }
            // Use the same stage recurrence as fftInPlace so planned and ordinary FFTs agree.
            for (let half = 1; half < size; half *= 2) {
                const stepRe = Math.cos(-Math.PI / half), stepIm = Math.sin(-Math.PI / half);
                let re = 1, im = 0;
                for (let j = 0; j < half; j++) {
                    const offset = 2 * (half + j);
                    twiddles[offset] = re; twiddles[offset + 1] = im;
                    const next = re * stepRe - im * stepIm;
                    im = re * stepIm + im * stepRe; re = next;
                }
            }
            const plan = { reverse, twiddles, bytes };
            plans.set(size, plan); planBytes += bytes;
            return plan;
        }

        // All three responses cross the existing cutoff once on each side of their peak.
        // Pad the inferred bin bounds and test the two endpoints with the original formula.
        const cutoff = 1e-12;
        for (const [basis, profile] of Object.entries(bases)) {
            for (const rising of [true, false]) {
                let low = rising ? 0 : 1, high = rising ? 1 : 6;
                for (let k = 0; k < 54; k++) {
                    const mid = (low + high) / 2;
                    if ((response(basis, mid) < cutoff) === rising) low = mid;
                    else high = mid;
                }
                if (rising) profile.lowRatio = low;
                else profile.highRatio = high;
            }
        }
        Object.assign(bases, additionalFamilies());

        function discardOldestBank() {
            const oldest = banks.keys().next().value;
            weightBytes -= banks.get(oldest).bytes;
            banks.delete(oldest);
        }

        function filterWeights(run, basis, profile, centerBin) {
            const key = run.bankKey;
            let bank = banks.get(key);
            if (!bank) {
                if (banks.size >= 8) discardOldestBank();
                bank = { entries: new Map(), bytes: 0 };
            } else banks.delete(key);
            banks.set(key, bank);
            const cached = bank.entries.get(centerBin);
            if (cached) return cached;
            // An asymmetric or odd real mother can have a complex Fourier response.
            // Its interior zeros do not bound the filter: higher side lobes may still contribute.
            const components = profile.weight ? 2 : 1;
            let first = Math.max(1, Math.floor(centerBin * (profile.minRatio ?? profile.lowRatio)) - 1);
            let last = Math.min(run.size / 2, Math.ceil(centerBin * (profile.maxRatio ?? profile.highRatio)) + 1);
            if (!profile.weight) {
                last = Math.min(last, Math.ceil(centerBin * 6));
                while (first <= last && response(basis, first / centerBin) < cutoff) first++;
                while (last >= first && response(basis, last / centerBin) < cutoff) last--;
            }
            const count = Math.max(0, last - first + 1), length = count * components, bytes = length * 8 + 192;
            const weightBudget = cacheBudget - planBytes;
            // If a single grid exceeds the allowance, keep its resident kernels through the
            // next pass; allocating and evicting every scale would provide no reuse.
            while (banks.size > 1 && bank.bytes + bytes <= weightBudget && weightBytes + bytes > weightBudget)
                discardOldestBank();
            const retain = weightBytes + bytes <= weightBudget;
            if (!retain && (!run.scratch || run.scratch.length < length)) run.scratch = new Float64Array(pow2(length));
            const weights = retain ? new Float64Array(length) : run.scratch;
            if (profile.weight) {
                const pair = new Float64Array(2);
                for (let i = 0; i < count; i++) {
                    profile.weight((first + i) / centerBin, pair);
                    weights[2 * i] = pair[0];
                    weights[2 * i + 1] = pair[1];
                }
            } else {
                for (let i = 0; i < count; i++) weights[i] = response(basis, (first + i) / centerBin);
            }
            const kernel = { first, last, weights };
            if (retain) {
                bank.entries.set(centerBin, kernel); bank.bytes += bytes; weightBytes += bytes;
            }
            return kernel;
        }

        function waveletMaxFrequencyRows(count) {
            return Number.isSafeInteger(count) && count >= 2 ? pow2(Math.min(maxWindowPoints, count)) / 2 + 1 : 0;
        }
        function largestTimeStride(count) {
            return 2 ** Math.floor(Math.log2(Math.max(1, Math.min(count, maxWindowPoints) - 1)));
        }
        function waveletTimeStrides(count) {
            const strides = [];
            for (let stride = largestTimeStride(count); stride >= 1; stride /= 2) strides.push(stride);
            return strides;
        }

        function waveletColumnSample(result, column) {
            return result.positions ? result.positions[column] : result.first + column * result.hop;
        }

        function inverseOutputStages(size, centers) {
            // In a radix-2 stage of width 2h, output i needs the butterfly at (i mod h).
            // All earlier blocks need the same set of residues. Once dense, they stay dense.
            let needed = centers, stages = null;
            const seen = new Uint8Array(size / 2);
            for (let half = size / 2; half >= 8; half /= 2) {
                seen.fill(0, 0, half);
                let count = 0;
                for (const center of needed) {
                    const j = center & (half - 1);
                    if (!seen[j]) { seen[j] = 1; count++; }
                }
                if (count * 2 >= half) break;
                needed = new Uint32Array(count);
                for (let j = 0, k = 0; j < half; j++) if (seen[j]) needed[k++] = j;
                stages ??= [];
                stages[Math.log2(half)] = needed;
            }
            return stages;
        }

        function countTimeGrid(length, requested, first, last) {
            const fullColumns = Math.min(length, requested);
            if (fullColumns < 2) {
                const center = Math.max(0, Math.round((length - 1) / 2));
                return { first: center, columns: fullColumns, fullColumns, hop: Math.max(1, length),
                    positions: fullColumns ? Int32Array.of(center) : new Int32Array(0) };
            }
            const intervals = fullColumns - 1, span = length - 1;
            const sample = column => Math.round(column * span / intervals);
            // Include the nearest center outside each edge when the requested range cuts between columns.
            let start = Math.floor(first * intervals / span), end = Math.ceil(last * intervals / span);
            if (start < intervals && sample(start + 1) <= first) start++;
            if (end > 0 && sample(end - 1) >= last) end--;
            const columns = end - start + 1;
            const positions = new Int32Array(columns);
            for (let i = 0; i < columns; i++) positions[i] = sample(start + i);
            return { first: positions[0], columns, fullColumns, hop: span / intervals, positions };
        }

        function waveletResolutionGrid({ rate, basis, visibleLength, first = 0, last = visibleLength - 1,
            frequencyRows = 0, frequencyScale = 'log', timeColumns = 0, timeStride = 0, minimumHop = 1, columnLimit = 768 }) {
            const profile = bases[basis];
            if (!profile || !Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(visibleLength) ||
                visibleLength < 0 || visibleLength > maxWindowPoints) throw new RangeError('小波分析参数无效');
            if (!Number.isInteger(frequencyRows) || frequencyRows === 1 || frequencyRows < 0 ||
                frequencyRows > waveletMaxFrequencyRows(maxWindowPoints)) throw new RangeError('小波频率行数无效');
            if (frequencyScale !== 'linear' && frequencyScale !== 'log') throw new RangeError('小波纵轴刻度无效');
            if (!Number.isInteger(timeStride) || timeStride < 0 || timeStride > largestTimeStride(maxWindowPoints)) {
                throw new RangeError('小波时间步长无效');
            }
            if (!Number.isInteger(timeColumns) || timeColumns < 0 || timeColumns > maxWindowPoints) {
                throw new RangeError('小波时间列数无效');
            }
            const nyquist = rate / 2, minHz = minimumCycles * profile.support * rate / visibleLength;
            const maxHz = nyquist - rate / visibleLength;
            const octaves = Math.log2(maxHz / minHz);
            let rows = 0;
            if (visibleLength >= 16 && octaves > 0) {
                const automaticScales = Math.min(96, Math.max(2, Math.ceil(octaves * (7 + Math.log2(visibleLength) / 2))));
                rows = Math.min(waveletMaxFrequencyRows(visibleLength), frequencyRows || automaticScales);
            }
            first = Math.max(0, Math.min(visibleLength - 1, Math.floor(first)));
            last = Math.max(first, Math.min(visibleLength - 1, Math.ceil(last)));
            const hop = timeStride ? Math.min(timeStride, largestTimeStride(visibleLength))
                : pow2(Math.max(minimumHop, (last - first + 1) / Math.max(32, Math.min(1024, columnLimit))));
            const start = Math.floor(first / hop) * hop;
            const time = timeColumns ? countTimeGrid(visibleLength, timeColumns, first, last) : {
                first: start, hop, columns: visibleLength ? Math.floor((last - start) / hop) + 1 : 0,
                fullColumns: Math.ceil(visibleLength / hop), positions: null
            };
            const columns = time.columns;
            const blockWidth = rows * columns > 1024 * 1024 ? 128 : 0;
            const blocksPerRow = blockWidth ? Math.ceil(columns / blockWidth) : 0;
            const bytes = rows * (columns * (profile.complex ? 17 : 10) + blocksPerRow * 16) + (time.positions?.byteLength ?? 0);
            return { ...time, rows, bytes, blockWidth, blocksPerRow, frequencyScale, nyquist, minHz, maxHz, octaves };
        }

        function finiteWaveletRuns(values, cuts) {
            const boundaries = new Set(cuts), runs = [];
            let start = 0;
            for (let i = 0; i <= values.length; i++) {
                const valid = i < values.length && Number.isFinite(values[i]);
                if (valid && !boundaries.has(i)) continue;
                if (i > start) runs.push({ start, end: i });
                start = i + Number(!valid);
            }
            return runs;
        }

        function createWaveletProcessor({ values, rate, basis, cuts = [], removeDc = false, edgeExtension = 'mirror',
            visibleStart = 0, visibleLength = values.length, ...resolution }, range = {}) {
            const profile = bases[basis];
            if (!['mirror', 'zero', 'hold'].includes(edgeExtension)) throw new RangeError('小波时域延拓策略无效');
            if (!(values instanceof Float64Array) || values.length > maxWindowPoints + 2 * waveletContextSamples(maxWindowPoints) ||
                !Number.isSafeInteger(visibleStart) || !Number.isSafeInteger(visibleLength) || visibleStart < 0 ||
                visibleStart + visibleLength > values.length) throw new RangeError('小波分析参数无效');
            const grid = waveletResolutionGrid({ ...resolution, rate, basis, visibleLength });
            const { first, columns, fullColumns, hop, positions, rows: fullRows, bytes, blockWidth, blocksPerRow, nyquist, minHz, maxHz, octaves } = grid;
            if (bytes > maxWaveletGridBytes) throw new RangeError('小波系数网格超过 384 MiB，请缩小时间范围或降低分辨率');
            const { rowStart = 0, rowEnd = fullRows } = range;
            if (!Number.isInteger(rowStart) || !Number.isInteger(rowEnd) || rowStart < 0 || rowEnd > fullRows ||
                rowEnd < rowStart) throw new RangeError('小波频率行范围无效');
            const rows = rowEnd - rowStart;
            const frequencies = Float64Array.from({ length: rows }, (_, i) => {
                const row = rowStart + i;
                if (row === 0) return minHz;
                if (row === fullRows - 1) return maxHz;
                const fraction = row / (fullRows - 1);
                return grid.frequencyScale === 'linear' ? minHz + fraction * (maxHz - minHz) : minHz * 2 ** (fraction * octaves);
            });
            const windowRadius = Math.ceil(profile.support * rate / minHz);
            const radii = Array.from(frequencies, hz => Math.ceil(profile.support * rate / hz));
            const firstCenter = visibleStart + first;
            // A radix-2 FFT can fold only by the power of two that divides the requested stride.
            // Every requested output center also belongs to this finer folded grid.
            const foldHop = Number.isInteger(hop) && fullColumns > 1 ? hop & -hop : 1;
            const centerAt = column => visibleStart + waveletColumnSample(grid, column);
            function columnAtOrAfter(sample) {
                if (!positions) return Math.max(0, Math.min(columns, Math.ceil((sample - firstCenter) / hop)));
                let lo = 0, hi = columns;
                while (lo < hi) {
                    const mid = (lo + hi) >>> 1;
                    if (centerAt(mid) < sample) lo = mid + 1;
                    else hi = mid;
                }
                return lo;
            }
            const runs = rows ? finiteWaveletRuns(values, cuts).flatMap(({ start, end }) => {
                const from = columnAtOrAfter(start), until = columnAtOrAfter(end);
                if (from >= until || end - start < 2) return [];
                return [{ start, end, from, until }];
            }) : [];
            const visibleRuns = runs.map(({ start, end, from, until }) => ({
                start: Math.max(0, start - visibleStart), end: Math.min(visibleLength, end - visibleStart), from, until
            }));
            const output = { first, hop, columns, fullColumns, positions, rowStart, fullRows, frequencies, frequencyScale: grid.frequencyScale,
                highBandStart: highBandStart(basis, nyquist), runs: visibleRuns,
                magnitude: new Float64Array(rows * columns).fill(NaN),
                phase: profile.complex ? new Float64Array(rows * columns).fill(NaN) : null,
                sign: profile.complex ? null : new Int8Array(rows * columns),
                reference: new Uint8Array(rows * columns), peak: 0, minMagnitude: Infinity, blockWidth,
                blockMin: blockWidth ? new Float64Array(rows * blocksPerRow).fill(Infinity) : null,
                blockMax: blockWidth ? new Float64Array(rows * blocksPerRow).fill(-Infinity) : null };
            // Estimate DC from the analysis window only. Keeping the mean relative to its
            // first finite sample preserves small variations on a large sensor offset.
            let dcReference = 0, meanDelta = 0;
            if (removeDc) {
                let count = 0;
                for (let i = visibleStart; i < visibleStart + visibleLength; i++) {
                    const value = values[i];
                    if (!Number.isFinite(value)) continue;
                    if (!count) dcReference = value;
                    count++;
                    meanDelta += (value - dcReference - meanDelta) / count;
                }
            }
            let index = 0, row = 0, active = null;
            function prepareRun(run) {
                const { start, end, from, until } = run;
                const length = end - start, radius = windowRadius;
                // Extend only the support missing after consuming real context. Each
                // side uses at most one run length minus one, including at hard cuts.
                // Manual column counts select from one full-window transform, including after a crop.
                const firstSample = positions ? Math.max(start, visibleStart) : centerAt(from);
                const lastSample = positions ? Math.min(end - 1, visibleStart + visibleLength - 1) : centerAt(until - 1);
                const left = Math.min(length - 1, Math.max(0, radius - (firstSample - start)));
                const right = Math.min(length - 1, Math.max(0, radius - (end - 1 - lastSample)));
                const alignment = ((start - firstCenter - left) % foldHop + foldHop) % foldHop;
                const offset = alignment + left, size = pow2(Math.max(foldHop, 2 * (offset + length + right)));
                const signalRe = new Float64Array(size), signalIm = new Float64Array(size);
                signalRe.set(values.subarray(start, end), offset);
                if (removeDc) {
                    for (let i = offset; i < offset + length; i++) signalRe[i] = signalRe[i] - dcReference - meanDelta;
                }
                if (edgeExtension === 'mirror') {
                    for (let i = 1; i <= left; i++) signalRe[offset - i] = signalRe[offset + i];
                    for (let i = 1; i <= right; i++) signalRe[offset + length - 1 + i] = signalRe[offset + length - 1 - i];
                } else if (edgeExtension === 'hold') {
                    const stop = offset + length;
                    signalRe.fill(signalRe[offset], offset - left, offset);
                    signalRe.fill(signalRe[stop - 1], stop, stop + right);
                }
                fft(signalRe, signalIm, fftPlan(size));
                const outSize = size / foldHop, inversePlan = fftPlan(outSize);
                const centers = new Uint32Array(until - from);
                for (let col = from; col < until; col++) centers[col - from] = (offset + centerAt(col) - start) / foldHop;
                return { ...run, offset, left, right, size, signalRe, signalIm,
                    bankKey: [basis, grid.frequencyScale, visibleLength, fullRows, size].join('/'), inversePlan,
                    reorderedPlan: inversePlan ? { ...inversePlan, reordered: true } : null,
                    centers, stages: inversePlan ? inverseOutputStages(outSize, centers) : null,
                    rowRe: new Float64Array(outSize), rowIm: new Float64Array(outSize) };
            }
            function computeRow(run) {
                const { start, end, offset, left, right, size, signalRe, signalIm, rowRe, rowIm } = run;
                const radius = radii[row], hz = frequencies[row], outSize = rowRe.length;
                const from = Math.max(run.from, columnAtOrAfter(start - left + radius));
                const until = Math.min(run.until, columnAtOrAfter(end + right - radius));
                if (from >= until) return 1;
                const complex = profile.complex;
                const centerBin = hz * size / rate;
                const { first, last, weights } = filterWeights(run, basis, profile, centerBin);
                const mask = outSize - 1, endBin = Math.min(last, size / 2 - 1);
                // Sparse analytic filters can place their bins directly in FFT order,
                // avoiding a permutation of the much larger zero-padded row.
                const repeat = complex && last > 0 && last < outSize / 2 ? outSize / pow2(last + 1) : 1;
                const reordered = repeat > 1 && run.reorderedPlan;
                if (reordered) {
                    // All other slots are overwritten when each seed is expanded in the FFT.
                    for (let i = 0; i < outSize; i += repeat) rowRe[i] = rowIm[i] = 0;
                } else {
                    rowRe.fill(0); rowIm.fill(0);
                }
                if (profile.weight) {
                    // Multiply the positive spectrum by the conjugated mother, then build the
                    // conjugated spectrum used by the forward-FFT implementation of the inverse.
                    const reverse = reordered?.reverse;
                    for (let bin = first; bin <= endBin; bin++) {
                        const j = 2 * (bin - first), wr = weights[j], wi = weights[j + 1];
                        const real = signalRe[bin] * wr - signalIm[bin] * wi;
                        const imag = signalRe[bin] * wi + signalIm[bin] * wr;
                        const index = reverse ? reverse[bin] : bin & mask;
                        if (complex) {
                            rowRe[index] += 2 * real; rowIm[index] -= 2 * imag;
                        } else {
                            const opposite = -bin & mask;
                            rowRe[index] += real; rowRe[opposite] += real;
                            rowIm[index] -= imag; rowIm[opposite] += imag;
                        }
                    }
                } else if (reordered) {
                    const reverse = reordered.reverse;
                    for (let bin = first; bin <= endBin; bin++) {
                        const weight = weights[bin - first], index = reverse[bin];
                        rowRe[index] += 2 * weight * signalRe[bin];
                        rowIm[index] -= 2 * weight * signalIm[bin];
                    }
                } else if (complex) {
                    for (let bin = first; bin <= endBin; bin++) {
                        const weight = weights[bin - first], index = bin & mask;
                        rowRe[index] += 2 * weight * signalRe[bin];
                        rowIm[index] -= 2 * weight * signalIm[bin];
                    }
                } else {
                    for (let bin = first; bin <= endBin; bin++) {
                        const weight = weights[bin - first], index = bin & mask, opposite = -bin & mask;
                        const real = weight * signalRe[bin], imag = weight * signalIm[bin];
                        rowRe[index] += real; rowRe[opposite] += real;
                        rowIm[index] -= imag; rowIm[opposite] += imag;
                    }
                }
                // The Nyquist input bin is its own conjugate and contributes once.
                if (last === size / 2 && first <= last) {
                    const j = (last - first) * (profile.weight ? 2 : 1);
                    rowRe[last & mask] += weights[j] * signalRe[last];
                    if (profile.weight && complex) rowIm[last & mask] -= weights[j + 1] * signalRe[last];
                }
                // A positive-frequency prefix leaves only the first input in each
                // initial bit-reversed group. Its early butterflies simply repeat it.
                fft(rowRe, rowIm, reordered || run.inversePlan, run.stages, repeat);
                const width = blockWidth || columns, gain = 1 / size;
                const firstInterior = (offset + radius) / foldHop, lastInterior = (offset + end - start - 1 - radius) / foldHop;
                for (let column = from; column < until;) {
                    const block = Math.floor(column / width), limit = Math.min(until, (block + 1) * width);
                    let low = Infinity, high = -Infinity;
                    for (; column < limit; column++) {
                        const i = run.centers[column - run.from], index = row * columns + column;
                        const re = rowRe[i], im = -rowIm[i];
                        const magnitude = (complex ? Math.hypot(re, im) : Math.abs(re)) * gain;
                        if (!Number.isFinite(magnitude)) continue;
                        output.magnitude[index] = magnitude;
                        if (!complex) output.sign[index] = Math.sign(re);
                        output.reference[index] = Number(i < firstInterior || i > lastInterior);
                        if (magnitude > high) high = magnitude;
                        if (magnitude < low) low = magnitude;
                        if (complex && magnitude > 0) output.phase[index] = Math.atan2(im, re);
                    }
                    if (high > output.peak) output.peak = high;
                    if (low < output.minMagnitude) output.minMagnitude = low;
                    if (blockWidth) {
                        const index = row * blocksPerRow + block;
                        if (low < output.blockMin[index]) output.blockMin[index] = low;
                        if (high > output.blockMax[index]) output.blockMax[index] = high;
                    }
                }
                return size;
            }
            return {
                step(budget) {
                    let remaining = Math.max(1, budget);
                    while (index < runs.length && remaining > 0) {
                        active ??= prepareRun(runs[index]);
                        remaining -= computeRow(active);
                        if (++row === rows) { row = 0; index++; active = null; }
                    }
                    return index === runs.length;
                },
                result() { return output; }
            };
        }
        return { createWaveletProcessor, waveletContextSamples, maxWaveletWindowPoints: maxWindowPoints,
            waveletResolutionGrid, waveletColumnSample, waveletMaxFrequencyRows, waveletTimeStrides, maxWaveletGridBytes,
            waveletSupportsPhase: basis => bases[basis]?.complex === true };
    }

    const api = { ...createWaveletFactory(fftInPlace, nextPow2, createAdditionalWaveletFamilies),
        createWaveletSource: () => '(' + createWaveletFactory.toString() + ')(fftInPlace, nextPow2, ' +
            createAdditionalWaveletFamilies.toString() + ').createWaveletProcessor' };
    Object.assign(S, api);
    if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

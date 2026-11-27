/** Additional mother wavelets for the continuous frequency-domain transform. */
(function (root) {
    const S = root.SerialPlotter ??= {};

    // Kept self-contained so the worker can use the identical implementation.
    function createAdditionalWaveletFamilies() {
        // All weights are conjugated Fourier transforms for correlation. Real
        // wavelets may have imaginary weights even though their output is real.
        const pi = Math.PI;
        const haarPeak = 1.1655611852072113; // First positive solution of tan(x) = 2x.
        const haarGain = Math.sin(haarPeak) ** 2 / haarPeak;
        function haarWeight(ratio, out) {
            const x = haarPeak * ratio;
            out[0] = 0;
            out[1] = x ? -(Math.sin(x) ** 2) / (x * haarGain) : 0;
        }
        function gaussianWeight(ratio, out) {
            // First derivative of a Gaussian, positive lobe before its center.
            out[0] = 0;
            out[1] = -ratio * Math.exp((1 - ratio * ratio) / 2);
        }
        function shannonWeight(ratio, out) {
            // Analytic Shannon, bandwidth 1 and center 1, rectangular passband.
            out[0] = ratio > .5 && ratio < 1.5 ? 1 : Number(ratio === .5 || ratio === 1.5) / 2;
            out[1] = 0;
        }
        function meyerWeight(ratio, out) {
            // Translate the standard Meyer wavelet's symmetry center to t = 0.
            // Its compact passband then has real weights at positive frequencies.
            out[1] = 0;
            if (ratio <= .5 || ratio >= 2) { out[0] = 0; return; }
            const rising = ratio <= 1;
            const x = rising ? 2 * ratio - 1 : ratio - 1;
            const smooth = x ** 4 * (35 + x * (-84 + x * (70 - 20 * x)));
            const angle = pi * smooth / 2;
            out[0] = rising ? Math.sin(angle) : Math.cos(angle);
        }

        // Synthesis low-pass coefficients, from the db4, sym4 and coif2
        // mathematical filter tables in PyWavelets (_extensions/c/wavelets_coeffs.template.h).
        // The coif2 table there already has unit DC gain.
        const db4 = [
            .2303778133088965, .7148465705529157, .6308807679298589, -.027983769416859854,
            -.18703481171909308, .030841381835560764, .0328830116668852, -.010597401785069032
        ].map(x => x * Math.SQRT1_2);
        const sym4 = [
            .032223100604042702, -.012603967262037833, -.099219543576847216, .29785779560527736,
            .80373875180591614, .49761866763201545, -.02963552764599851, -.075765714789273325
        ].map(x => x * Math.SQRT1_2);
        const coif2 = [
            .011587596738716868, -.029320137983468564, -.04763959031100813, .2730210465347666,
            .5746823938568638, .2948671936956192, -.05408560709171143, -.04202648046077161,
            .016744410163279506, .003967883612962012, -.0012892033561406596, -.0005095053991076441
        ];

        // Orthogonal wavelet families use their continuous mother, with
        // psiHat(f) = G(f/2) phiHat(f/2), phiHat(f) = H(f/2) phiHat(f/2).
        // Center both masks at their support midpoint. The phase of each
        // asymmetric wavelet is preserved, including away from its peak.
        function quadratureMirror(low, center, gain, edgeRatio) {
            const density = 512, tableLimit = 8, midpoint = (low.length - 1) / 2;
            let lowMask, highMask, scaling, mother;
            const part = [0, 0], tail = [0, 0];
            function interpolate(table, frequency, out, gridDensity = density) {
                const point = frequency * gridDensity;
                const i = Math.min(Math.floor(point), table.length / 2 - 2);
                const weight = point - i, at = 2 * i;
                out[0] = table[at] + weight * (table[at + 2] - table[at]);
                out[1] = table[at + 1] + weight * (table[at + 3] - table[at + 1]);
            }
            function multiply(out, re, im) {
                const next = out[0] * re - out[1] * im;
                out[1] = out[1] * re + out[0] * im;
                out[0] = next;
            }
            function maskTable(taps) {
                // Centered masks with half-integer tap locations have period 2.
                // Twice the density gives exact nodes for every half-grid lookup
                // while preparing the scaling-function table.
                const table = new Float64Array(2 * (4 * density + 1));
                for (let i = 0; i <= 4 * density; i++) {
                    const omega = pi * i / density;
                    for (let k = 0; k < taps.length; k++) {
                        const angle = omega * (k - midpoint);
                        table[2 * i] += taps[k] * Math.cos(angle);
                        table[2 * i + 1] += taps[k] * Math.sin(angle);
                    }
                }
                return table;
            }
            function initialize() {
                const high = low.map((_, k) => (k % 2 ? -1 : 1) * low[low.length - 1 - k]);
                lowMask = maskTable(low);
                highMask = maskTable(high);
                scaling = new Float64Array(2 * (tableLimit * density + 1));
                mother = new Float64Array(scaling.length);
                scaling[0] = 1;
                for (let i = 1; i <= tableLimit * density; i++) {
                    const half = i / (2 * density);
                    if (half <= .5) {
                        // Seed the first octave directly. Repeated interpolation
                        // all the way down to DC would bias the passband gain.
                        tail[0] = 1; tail[1] = 0;
                        for (let f = half / 2; f > 1e-12; f /= 2) {
                            let re = 0, im = 0;
                            for (let k = 0; k < low.length; k++) {
                                const angle = 2 * pi * f * (k - midpoint);
                                re += low[k] * Math.cos(angle); im += low[k] * Math.sin(angle);
                            }
                            multiply(tail, re, im);
                        }
                    } else {
                        interpolate(scaling, half, tail);
                    }
                    interpolate(lowMask, half % 2, part, 2 * density);
                    multiply(part, tail[0], tail[1]);
                    scaling[2 * i] = part[0]; scaling[2 * i + 1] = part[1];
                    interpolate(highMask, half % 2, part, 2 * density);
                    multiply(part, tail[0], tail[1]);
                    mother[2 * i] = part[0] / gain; mother[2 * i + 1] = part[1] / gain;
                }
            }
            function weight(ratio, out) {
                if (!mother) initialize();
                let f = ratio * center;
                if (f <= tableLimit) { interpolate(mother, f, out); return; }
                // Reuse the periodic masks at higher frequencies rather than
                // truncating distant sidelobes or allocating an unbounded table.
                f /= 2;
                interpolate(highMask, f % 2, out, 2 * density);
                while (f > tableLimit) {
                    f /= 2;
                    interpolate(lowMask, f % 2, part, 2 * density);
                    multiply(out, part[0], part[1]);
                }
                interpolate(scaling, f, tail);
                multiply(out, tail[0] / gain, tail[1] / gain);
            }
            return { support: center * midpoint, complex: false, minRatio: 0, maxRatio: Infinity, edgeRatio, weight };
        }

        // The center and gain of each orthogonal mother are the maximum of the
        // refinement-product magnitude. edgeRatio is the outer 10%-gain crossing.
        // Haar and the orthogonal families have exact, finite temporal support.
        // Shannon, Gaussian and Meyer use effective radii for the edge warning.
        return {
            db4: quadratureMirror(db4, .69766266, .933827796, 2.10670),
            coif2: quadratureMirror(coif2, .69617462, .939326233, 2.10110),
            sym4: quadratureMirror(sym4, .69766266, .933827796, 2.10670),
            haar: { support: haarPeak / pi, complex: false, minRatio: 0, maxRatio: Infinity, edgeRatio: 9.80089, weight: haarWeight },
            gaus1: { support: 5 / (2 * pi), complex: false, minRatio: 0, maxRatio: 8, edgeRatio: 2.76376, weight: gaussianWeight },
            shannon: { support: 12, complex: true, minRatio: .5, maxRatio: 1.5, edgeRatio: 1.5, weight: shannonWeight },
            meyer: { support: 4, complex: false, minRatio: .5, maxRatio: 2, edgeRatio: 1.75758, weight: meyerWeight }
        };
    }

    S.createAdditionalWaveletFamilies = createAdditionalWaveletFamilies;
    if (typeof module !== 'undefined') module.exports = { createAdditionalWaveletFamilies };
})(globalThis);

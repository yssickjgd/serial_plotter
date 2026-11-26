/** Serialize the geometry and tick labels of a presented waveform frame. */
function renderWaveSvg({ width, height, plotW, plotH, traces, labels, navigation }, options) {
    const { title, fontFamily, lineWidth, markerSize } = options;
    const escape = value => String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const n = value => Number(value.toFixed(3));
    const top = 26, fullHeight = top + height, fullWidth = width + 12;
    const parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + fullWidth + '" height="' + fullHeight +
            '" viewBox="0 0 ' + fullWidth + ' ' + fullHeight + '" font-family="' + escape(fontFamily) + '">',
        '<title>' + escape(title) + '</title>',
        '<rect width="100%" height="100%" fill="#111111"/>',
        '<text x="6" y="19" fill="#eeeeee" font-size="15">' + escape(title) + '</text>',
        '<g transform="translate(6 ' + top + ')">',
        '<defs><clipPath id="wave-plot"><rect width="' + plotW + '" height="' + plotH + '"/></clipPath></defs>'
    ];
    for (const [step, color] of [[20, '#1e1e1e'], [100, '#2e2e2e']]) {
        const grid = [];
        for (let x = 0; x <= plotW; x += step) grid.push('M' + x + ' 0V' + plotH);
        for (let y = 0; y <= plotH; y += step) grid.push('M0 ' + y + 'H' + plotW);
        parts.push('<path fill="none" stroke="' + color + '" d="' + grid.join(' ') + '"/>');
    }
    parts.push('<g clip-path="url(#wave-plot)">');
    for (const { name, color, points, lines = true, dots } of traces) {
        const path = [], markers = [], half = markerSize / 2;
        let move = true;
        for (const { x, y, break: gap, synthetic, recovered } of points) {
            if (!Number.isFinite(x) || !Number.isFinite(y)) { move = true; continue; }
            if (lines) path.push((move || gap ? 'M' : 'L') + n(x) + ' ' + n(y));
            move = false;
            if (!dots || synthetic) continue;
            if (recovered) markers.push('<circle cx="' + n(x) + '" cy="' + n(y) + '" r="' +
                ((markerSize - .75) / 2) + '" fill="none" stroke="' + escape(color) + '" stroke-width=".75"/>');
            else markers.push('<rect x="' + n(x - half) + '" y="' + n(y - half) + '" width="' +
                markerSize + '" height="' + markerSize + '"/>');
        }
        parts.push('<g fill="' + escape(color) + '"><title>' + escape(name) + '</title>');
        if (lines) parts.push('<path fill="none" stroke="' + escape(color) + '" stroke-width="' +
            n(lineWidth) + '" d="' + path.join(' ') + '"/>');
        parts.push(markers.join(''), '</g>');
    }
    for (const { peak, color } of traces) if (peak)
        parts.push('<circle data-spectrum-peak="channel" cx="' + n(peak.x) + '" cy="' + n(peak.y) + '" r="' +
            peak.radius + '" fill="none" stroke="' + escape(color) + '" stroke-width="1.7"/>');
    for (const { x, color, width: strokeWidth } of navigation)
        parts.push('<path d="M' + n(x) + ' 0V' + plotH + '" stroke="' + escape(color) + '" stroke-width="' + strokeWidth + '"/>');
    parts.push('</g>');
    const ticks = ['M0 ' + plotH + 'H' + plotW + 'V0'];
    for (const { text, x, y, vertical, tickX } of labels) {
        if (vertical) ticks.push('M' + plotW + ' ' + n(y) + 'h-4');
        else if (tickX != null) ticks.push('M' + n(tickX) + ' ' + plotH + 'v3');
        parts.push('<text x="' + n(x) + '" y="' + n(y) + '" font-size="10" fill="#aaaaaa" dominant-baseline="' +
            (vertical ? 'central' : 'text-before-edge') + '">' + escape(text) + '</text>');
    }
    parts.push('<path fill="none" stroke="#888" d="' + ticks.join(' ') + '"/></g></svg>');
    return parts.join('');
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.renderWaveSvg = renderWaveSvg;

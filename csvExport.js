/** Export every retained frame without using the plot's display decimation. */
const csvFieldForExport = typeof module !== 'undefined'
    ? require('./plotMath').csvField : globalThis.SerialPlotter.csvField;

function exportFrameCsv(frames, channels) {
    if (!channels.length || !frames.length) return null;
    let csv = ['Index', ...channels.map(ch => csvFieldForExport(ch.name))].join(',') + '\r\n';
    for (let row = 0; row < frames.length; row++) {
        const fields = [row];
        for (let channel = 0; channel < channels.length; channel++)
            fields.push(frames.getValue(channel, row));
        csv += fields.join(',') + '\r\n';
    }
    return csv;
}

if (typeof module !== 'undefined') module.exports = { exportFrameCsv };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.exportFrameCsv = exportFrameCsv;

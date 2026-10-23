/** Node parser throughput only: complete, fragmented and sticky binary frames. */
const { performance } = require('node:perf_hooks');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
function engine(file) {
    if (!file) return require('../protocolEngine').Protocol;
    const context = { module: { exports: {} }, require: createRequire(path.resolve(__dirname, '../protocolEngine.js')),
        Uint8Array, DataView, ArrayBuffer, TextDecoder, TextEncoder, console };
    vm.runInNewContext(readFileSync(file, 'utf8'), context, { filename: file });
    return context.module.exports.Protocol;
}
function schema() {
    return { id: 'stream-benchmark', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 65536 }, messages: [{
        id: 'frame', byteLength: 0, fields: [
            { id: 'sync', name: 'sync', type: 'fixed', bytes: [170,85], byteLength: 2, framingRole: 'sync' },
            { id: 'count', name: 'count', type: 'uint16', byteLength: 2 },
            { id: 'values', name: 'values', type: 'float32', byteLength: 4, count: 'count' },
            { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: 0, end: { fieldId: 'sum' } } }
        ]
    }] };
}
function benchmark(P, name, channels, count, chunkSize) {
    const compiled = P.compile(schema()), values = Array.from({ length: channels }, (_, index) => index / 4);
    const frame = P.encode(compiled, 'frame', { count: channels, values }), bytes = new Uint8Array(frame.length * count);
    for (let index = 0; index < count; index++) bytes.set(frame, index * frame.length);
    let received = 0;
    const parser = new P.StreamParser(compiled, { trackWork: true });
    parser.onFrameParsed = record => {
        if (record.valid !== true || record.fields.values.length !== channels || record.fields.values.at(-1) !== values.at(-1)) throw new Error('Incorrect decoded data');
        received++;
    };
    const start = performance.now();
    for (let offset = 0; offset < bytes.length; offset += chunkSize) parser.appendData(bytes.subarray(offset, offset + chunkSize), { timestamp: 0 });
    const elapsedMs = performance.now() - start;
    if (received !== count || parser.length) throw new Error('Lost or incomplete frames');
    return { name, channels, count, chunkSize, elapsedMs: +elapsedMs.toFixed(2), framesPerSecond: Math.round(count * 1000 / elapsedMs), work: parser.work };
}
function run(file) {
    const P = engine(file);
    benchmark(P, 'warmup', 23, 100, 97);
    return [benchmark(P, 'complete-23ch', 23, 3000, 97), benchmark(P, 'bytewise-23ch', 23, 500, 1),
        benchmark(P, 'bytewise-512ch', 512, 40, 1), benchmark(P, 'sticky-23ch', 23, 3000, 65536)];
}
if (require.main === module) process.stdout.write(JSON.stringify(run(process.argv[2]), null, 2) + '\n');
module.exports = { run };

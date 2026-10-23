const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('protocol error presentation uses Chinese and preserves exact user field paths', () => {
    const { protocolMessageZh } = require('../protocolMessages');
    assert.equal(protocolMessageZh('Unknown expression identifier: header.data_length'), '表达式引用了未知变量：header.data_length');
    assert.equal(protocolMessageZh('Automatic writers overlap'), '自动回填的字节区域重叠');
    assert.equal(protocolMessageZh('Field payload.items[2] exceeds its container'), '字段 payload.items[2] 超出所属数据段');
    assert.equal(protocolMessageZh('变量名 payload 不能与 LEN 重名'), '变量名 payload 不能与 LEN 重名');
    assert.equal(protocolMessageZh('CRC requires a polynomial'), 'CRC 校验必须配置多项式');
    assert.equal(protocolMessageZh('Invalid checksum init'), '校验参数“初始值”无效');
    assert.equal(protocolMessageZh('Length field offset is outside the allowed range 0–100'), '长度字段偏移超出允许范围 0–100');
    assert.equal(protocolMessageZh('0 byte variable fields require a length source or fixed boundary；结构体可按内部字段确定'), '0 字节变长字段需要长度来源或固定字节边界；结构体可按内部字段确定');
});

test('JSON syntax, composite messages and unexpected worker failures remain readable in Chinese', () => {
    const { protocolMessageZh } = require('../protocolMessages');
    assert.match(protocolMessageZh(new SyntaxError('Unexpected token at position 12 (line 2 column 4)')), /JSON.*第 2 行.*第 4 列/);
    assert.equal(protocolMessageZh('Division by zero；Truncated payload'), '除数不能为零；数据不完整：payload');
    assert.match(protocolMessageZh('暂不能转换：Unknown structure: payload'), /暂不能转换：找不到结构体：payload/);
    assert.match(protocolMessageZh(new Error('unrecognized browser failure')), /操作失败/);
    assert.doesNotMatch(protocolMessageZh(new Error('unrecognized browser failure')), /unrecognized browser failure/);
});

test('every built-in English protocol diagnostic has a specific Chinese translation', () => {
    const { protocolMessageZh } = require('../protocolMessages');
    const patterns = [
        /fail\('[^']+',\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')/g,
        /(?:new (?:Error|TypeError|RangeError)|limitError)\((?:'[^']+',\s*)?(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')/g,
        /message:\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')/g,
        /warn\('[^']+',\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')/g
    ];
    for (const file of ['protocolEngine.js','protocolModel.js','protocolSymbols.js','historyWorkers.js']) {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
            let text = match[1].slice(1,-1);
            if (/[\u4e00-\u9fff]/.test(text) || !/[A-Za-z]/.test(text)) continue;
            text = text.replace(/\$\{[^}]+\}/g, token => /minimum/.test(token) ? '0' : /maximum/.test(token) ? '100' : /Number\(/.test(token) ? '12' : 'payload');
            // A few model messages concatenate the node ID after a string literal.
            if (text.endsWith(': ')) text += 'payload';
            if (text === 'Invalid checksum ') text += 'init';
            const translated = protocolMessageZh(text);
            assert.match(translated, /[\u4e00-\u9fff]/, `${file}: ${text}`);
            assert.doesNotMatch(translated, /^操作失败/, `${file}: missing translation for ${text}`);
        }
    }
});

test('range diagnostics translate all built-in parameter labels without altering numeric limits', () => {
    const { protocolMessageZh } = require('../protocolMessages');
    const source=fs.readFileSync(path.join(__dirname,'../protocolEngine.js'),'utf8');
    for(const match of source.matchAll(/bounded\([^\n;]+, '([^']+)'(?:, \d+)?\)/g)) {
        const text=protocolMessageZh(match[1]+' is outside the allowed range 0–65535');
        assert.doesNotMatch(text.replace(/TLV/g,''), /[A-Za-z]/,match[1]);
        assert.match(text,/0–65535/);
    }
});

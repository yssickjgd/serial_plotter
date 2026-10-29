/** User-language symbols: one case-sensitive catalog for validation and help. */
(function(root) {
    'use strict';
    function createReservedNames() {
        const definitions = [
            { names: ['CH00001…CH65535'], category: '通道编号', description: '通道引用；兼容 CH1、CH01 等前导零写法，仅识别大写 CH。', scopes: ['channel','field'], pattern: '^CH\\d+$' },
            { names: ['DIFF'], category: '通道函数', description: '相邻采样点差分，例如 DIFF(CH00001)。', scopes: ['channel','field'] },
            { names: ['INT'], category: '通道函数', description: '按采样点累加积分，例如 INT(CH00001)。', scopes: ['channel','field'] },
            { names: ['FILTER'], category: '通道函数', description: '信号与常量核／差分系统滤波；两参数顺序可互换。', scopes: ['channel','field'] },
            { names: ['X','Y','N'], category: '系统表达式', description: '差分系统的输入、输出及当前采样索引；如 Y[N]=X[N]+0.9*Y[N-1]。', scopes: ['channel','field'] },
            { names: ['FRAME_LENGTH'], category: '协议变量', description: '整帧总字节数，包括同步、长度、校验和结束字段；需要可靠的帧边界。', scopes: ['channel','field'] },
            { names: ['PAYLOAD_LENGTH'], category: '协议变量', description: '解析器确定的载荷范围字节数；具体范围由协议布局决定。', scopes: ['channel','field'] },
            { names: ['REMAINING','PARENT_REMAINING'], category: '协议变量', description: '当前段尚余字节数，以及父级传入的剩余范围；只能在有界范围内使用。', scopes: ['channel','field'] },
            { names: ['CURRENT','PARENT'], category: '协议作用域', description: '当前及父级字段作用域，例如 PARENT.data_length。', scopes: ['channel','field'] },
            { names: ['HEADER'], category: '协议作用域', description: '旧协议公共头字段作用域；真实结构体使用自己的变量名。', scopes: ['channel','field'] },
            { names: ['INDEX'], category: '协议变量', description: '重复字段或 TLV 当前条目的索引，从 0 开始。', scopes: ['channel','field'] },
            { names: ['SEQ'], category: '协议变量', description: '结构化发送的自动序号；字段通过 valueSource: "SEQ" 显式绑定，仅在成功发送后推进。普通字段名称可自行定义。', scopes: ['channel','field'] },
            { names: ['TRUE','FALSE'], category: '协议常量', description: '布尔常量，用于条件表达式。', scopes: ['channel','field'] },
            { names: ['MIN','MAX','ABS'], category: '协议函数', description: '最小值、最大值、绝对值；例如 MIN(data_length, 64)。', scopes: ['channel','field'] },
            { names: ['LEN'], category: '协议函数', description: '返回指定字段或数据段实际编码所占的字节数，如 LEN(payload)；不是数组元素数或字符数，包含该段内的固定内容、校验和填充。普通表达式引用已读取字段，整帧长度表达式只引用可独立确定长度的段，禁止循环依赖。', scopes: ['channel','field'] },
            { names: ['_raw','_unknownTail','_segmentTails','_inferLength','rawPayload'], category: '内部记录键', description: '原始数值、未解释尾字节和内部布局状态；保持既有 JSON 键名，不可用作协议字段。', scopes: ['field'] },
            { names: ['__proto__','prototype','constructor'], category: '安全保护键', description: '对象原型相关键，禁止作为通道或协议标识符。', scopes: ['channel','field'] }
        ].map(item => Object.freeze({ ...item, names: Object.freeze(item.names), scopes: Object.freeze(item.scopes) }));
        const conflict = (name, scope = 'field') => definitions.find(item => item.scopes.includes(scope) &&
            (item.pattern ? new RegExp(item.pattern).test(name) : item.names.includes(name))) ?? null;
        const error = (name, scope = 'field') => {
            const item = conflict(name, scope);
            return item ? `名称 ${name} 与${item.category}保留名称冲突：${item.description}` : null;
        };
        return Object.freeze({ version: 2, definitions: Object.freeze(definitions), conflict, error,
            channelFunctions: Object.freeze(['DIFF','INT','FILTER']), channelVariables: Object.freeze(['X','Y','N']),
            protocolFunctions: Object.freeze(['MIN','MAX','ABS','LEN']),
            protocolVariables: Object.freeze(['TRUE','FALSE','FRAME_LENGTH','PAYLOAD_LENGTH','REMAINING','PARENT_REMAINING','PARENT','CURRENT','HEADER','INDEX','SEQ']),
            createFactorySource: () => createReservedNames.toString() });
    }
    const ReservedNames = createReservedNames();
    function createReservedNamesHelp(document, scope = 'field') {
        const details = document.createElement('details'); details.className = 'reserved-names-help';
        details.setAttribute('data-detail', 'reserved-names-' + scope);
        const summary = document.createElement('summary'); summary.textContent = '保留名称与内置变量'; details.append(summary);
        const help = document.createElement('p'); help.className = 'hint-text';
        help.textContent = '标识符和表达式区分大小写，系统名称使用大写。协议表达式函数：' + ReservedNames.protocolFunctions.join(' / ') + '；通道函数仅用于通道运算。此清单也列出全程序的命名限制，显示标签不受限制。'; details.append(help);
        const list = document.createElement('dl');
        for (const item of ReservedNames.definitions.filter(item => item.scopes.includes(scope))) {
            const term = document.createElement('dt'), text = document.createElement('dd');
            term.textContent = item.names.join(' / '); text.textContent = item.description; list.append(term, text);
        }
        details.append(list); return details;
    }
    root.SerialPlotter ??= {}; Object.assign(root.SerialPlotter, { ReservedNames, createReservedNamesHelp });
    if (typeof module !== 'undefined' && module.exports) module.exports = { ReservedNames, createReservedNamesHelp };
})(globalThis);

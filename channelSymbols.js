/** Upgrade persisted sample expressions without rewriting user channel aliases. */
(function(root) {
    'use strict';
    const format = typeof module !== 'undefined' ? require('./channelTransform') : root.SerialPlotter;
    const legacyFunctions = new Map([['diff', 'DIFF'], ['int', 'INT'], ['filter', 'FILTER']]);
    const identifiers = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[\p{L}_][\p{L}\p{N}\p{M}_]*/gu;

    function migrateChannelDefinition(definition, { resolveLegacyReference } = {}) {
        const migrated = { ...definition };
        if (!['formula', 'system'].includes(migrated.type)) return migrated;
        const system = migrated.type === 'system';
        const migrate = text => typeof text !== 'string' ? text : text.replace(identifiers, (token, at) => {
            const after = text.slice(at + token.length);
            if (!system && resolveLegacyReference && !/^(?:\d|\.)/.test(token) && !/^CH\d+$/.test(token) &&
                !/^\s*\(/.test(after) && !/\[\s*$/.test(text.slice(0, at))) {
                const number = resolveLegacyReference(token);
                if (Number.isInteger(number)) return format.formatChannelNumber(number);
            }
            if (legacyFunctions.has(token) && /^\s*\(/.test(after)) return legacyFunctions.get(token);
            if (system && ['x', 'y', 'n'].includes(token)) return token.toUpperCase();
            if (token === 'n' && /\[\s*$/.test(text.slice(0, at)) && /^\s*(?:-\s*\d+\s*)?\]/.test(after)) return 'N';
            return token;
        });
        migrated.expression = migrate(migrated.expression);
        if (system && Object.hasOwn(migrated, 'initial')) migrated.initial = migrate(migrated.initial);
        return migrated;
    }

    root.SerialPlotter ??= {};
    Object.assign(root.SerialPlotter, { migrateChannelDefinition });
    if (typeof module !== 'undefined' && module.exports) module.exports = { migrateChannelDefinition };
})(globalThis);

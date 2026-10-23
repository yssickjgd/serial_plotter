/** Configuration binding migration. Stable field IDs remain authoritative. */
(function(root) {
    'use strict';
    const clone = value => JSON.parse(JSON.stringify(value));
    const protocol = () => typeof module !== 'undefined' ? require('./protocolEngine').Protocol : root.SerialPlotter.Protocol;
    function migrateSymbolPath(path, renames, fieldId) {
        if (typeof path !== 'string') return path;
        const parts = path.split('.'), bare = parts.map(part => part.replace(/\[\d+\]/g, ''));
        const candidates = renames.filter(row => {
            const before = row.pathBefore.split('.');
            return (!fieldId || row.fieldId === fieldId || before.length < parts.length) && before.length <= parts.length && before.every((name, at) => name === bare[at]);
        }).sort((a,b) => b.pathBefore.length - a.pathBefore.length);
        if (!candidates.length) return path;
        const first = candidates[0], same = candidates.filter(row => row.pathBefore === first.pathBefore);
        if (new Set(same.map(row => row.pathAfter)).size > 1) throw new Error(`旧字段路径 ${path} 存在歧义，请按字段 ID 重新选择`);
        const after = first.pathAfter.split('.');
        return parts.map((part, at) => at < after.length ? after[at] + (part.match(/\[\d+\]/g) ?? []).join('') : part).join('.');
    }
    function migrateEngineSymbols(input) {
        if (!input || typeof input !== 'object') return { settings: input, renamesByProtocol: new Map() };
        const settings = clone(input), renamesByProtocol = new Map();
        if (Array.isArray(settings.protocols)) settings.protocols = settings.protocols.map(schema => {
            const result = protocol().migrateSymbols(schema); renamesByProtocol.set(result.schema.id, result.renames); return result.schema;
        });
        for (const mapping of Array.isArray(settings.mappings) ? settings.mappings : []) {
            const renames = mapping.protocolId ? renamesByProtocol.get(mapping.protocolId) ?? [] : [...renamesByProtocol.values()].flat();
            mapping.path = migrateSymbolPath(mapping.path, renames, mapping.fieldId);
        }
        for (const [protocolId, samples] of Object.entries(settings.editorState?.samples ?? {})) {
            if (!Array.isArray(samples) || !renamesByProtocol.get(protocolId)?.length) continue;
            for (const sample of samples) if (typeof sample?.values === 'string') {
                sample.values = migrateCommandSymbols({ protocolId, fields: {}, fieldsText: sample.values }, renamesByProtocol).fieldsText;
            }
        }
        if (settings.draft) settings.draft = migrateEngineSymbols(settings.draft).settings;
        return { settings, renamesByProtocol };
    }
    function migrateCommandSymbols(binding, renamesByProtocol) {
        if (!binding) return binding;
        const renames = renamesByProtocol.get(binding.protocolId) ?? [];
        if (!renames.length) return binding;
        const result = clone(binding);
        function walk(value, prefix = '') {
            if (!value || typeof value !== 'object') return value;
            if (Array.isArray(value)) return value.map((item, index) => walk(item, `${prefix}[${index}]`));
            const output = {};
            for (const [key, child] of Object.entries(value)) {
                const path = prefix ? prefix + '.' + key : key, nextKey = migrateSymbolPath(path, renames).split('.').at(-1);
                if (Object.hasOwn(output, nextKey)) throw new Error(`迁移后发送字段 ${nextKey} 重复`);
                Object.defineProperty(output, nextKey, { value: walk(child, path), enumerable: true, configurable: true, writable: true });
            }
            return output;
        }
        result.fields = walk(result.fields);
        if (typeof result.fieldsText === 'string') {
            try { result.fieldsText = JSON.stringify(walk(JSON.parse(result.fieldsText)), null, 2); }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; /* Invalid drafts remain editable. */ }
        }
        return result;
    }
    const api = { migrateSymbolPath, migrateEngineSymbols, migrateCommandSymbols };
    root.SerialPlotter ??= {}; Object.assign(root.SerialPlotter, api);
    if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

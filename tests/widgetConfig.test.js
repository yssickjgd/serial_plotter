const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateWorkspaceConfig, validateWorkspaceConfig } = require('../widgetConfig');

test('legacy separate response counts merge by the previously displayed object and save only the shared count', () => {
    for (const [plotContent, expected] of [['samples', '64'], ['response', '128']]) {
        const config = migrateWorkspaceConfig(null);
        delete config.global.plotWindowPoints;
        config.widgets = [{ id: 'wave-1', type: 'wave', title: 'wave', settings: {
            plotContent, plotWindowPoints: '64', plotResponsePoints: '128'
        } }];
        const normalized = validateWorkspaceConfig(config);
        assert.equal(normalized.global.plotWindowPoints, expected);
        assert.equal(Object.hasOwn(normalized.widgets[0].settings, 'plotWindowPoints'), false);
        assert.equal(Object.hasOwn(normalized.widgets[0].settings, 'plotResponsePoints'), false);
        assert.deepEqual(validateWorkspaceConfig(normalized), normalized);
        config.widgets[0].settings.plotResponsePoints = '65537';
        assert.throws(() => validateWorkspaceConfig(config), /采样点数/);
    }
    const flat = migrateWorkspaceConfig({ plotContent: 'response', plotWindowPoints: '64', plotResponsePoints: '128' });
    assert.equal(flat.global.plotWindowPoints, '128');
});

test('global window count takes priority while older multi-wave configurations migrate the first waveform', () => {
    const config = migrateWorkspaceConfig(null);
    delete config.global.plotWindowPoints;
    config.widgets = [
        { id: 'wave-1', type: 'wave', title: 'first', settings: { plotWindowPoints: '64' } },
        { id: 'wave-2', type: 'wave', title: 'second', settings: { plotWindowPoints: '128' } }
    ];
    assert.equal(validateWorkspaceConfig(config).global.plotWindowPoints, '64');
    config.global.plotWindowPoints = '256';
    const result = validateWorkspaceConfig(config);
    assert.equal(result.global.plotWindowPoints, '256');
    assert.ok(result.widgets.every(widget => !Object.hasOwn(widget.settings, 'plotWindowPoints')));
    config.global.plotWindowPoints = '0';
    assert.throws(() => validateWorkspaceConfig(config), /采样点数/);
});

test('fresh workspace is empty; legacy configuration migrates both monitors with independent settings', () => {
    assert.equal(migrateWorkspaceConfig(null).widgets.length, 0);
    const config = migrateWorkspaceConfig({ maxPoints: '5000', channelsCount: '2', channels: [{ name: '轴 X' }],
        captureMode: 'text', plotViewMode: 'frequency', monitorDisplay: { textInvalid: 'escape' } });
    assert.deepEqual(config.widgets.map(widget => widget.type), ['wave', 'byte']);
    assert.equal(config.global.channelNames[0], '轴 X');
    assert.equal(config.widgets[0].settings.plotViewMode, 'frequency');
    assert.equal(config.widgets[1].settings.captureMode, 'text');
    assert.deepEqual(validateWorkspaceConfig(JSON.parse(JSON.stringify(config))), config);
});

test('global derived channels and colors roundtrip and reject conflicting or invalid definitions', () => {
    const config = migrateWorkspaceConfig(null);
    config.global.channelDefinitions = [{ number: 2, type: 'constant', expression: '[0]=1,[1]=2' },
        { number: 3, type: 'formula', expression: 'filter(CH01,CH02)' }];
    config.global.channelColors = ['#ff0000', '#00ff00', '#0000ff'];
    const result = validateWorkspaceConfig(config);
    assert.deepEqual(result.global.channelDefinitions, config.global.channelDefinitions);
    assert.deepEqual(result.global.channelColors, config.global.channelColors);
    assert.deepEqual(validateWorkspaceConfig(JSON.parse(JSON.stringify(result))), result);
    assert.throws(() => validateWorkspaceConfig({ ...config, global: { ...config.global, channelsCount: '2' } }), /冲突/);
    assert.throws(() => validateWorkspaceConfig({ ...config, global: { ...config.global, channelColors: ['red'] } }), /颜色/);
    assert.throws(() => validateWorkspaceConfig({ ...config, global: { ...config.global,
        channelDefinitions: [{ number: 2, type: 'system', expression: 'x[0]+y[-1]', initial: '' }] } }), /初始状态/);
});

test('invalid instance or overlapping layout is rejected before replacing state', () => {
    const config = migrateWorkspaceConfig({});
    config.widgets[1].id = config.widgets[0].id;
    assert.throws(() => validateWorkspaceConfig(config), /重复/);
    const good = migrateWorkspaceConfig({});
    good.workspace.rects = { 'wave-1': { x: 0, y: 0, width: 640, height: 300 },
        'byte-1': { x: 0, y: 200, width: 640, height: 300 } };
    assert.throws(() => validateWorkspaceConfig(good), /重叠/);
});

test('capacity clamps the global wave window while other settings remain independent', () => {
    const config = migrateWorkspaceConfig({ maxPoints: '100' });
    config.widgets.push({ ...config.widgets[0], id: 'wave-2', settings: { plotWindowPoints: '500', plotFftWindow: 'blackman' } });
    const result = validateWorkspaceConfig(config);
    assert.equal(result.global.plotWindowPoints, '100');
    assert.equal(Object.hasOwn(result.widgets[2].settings, 'plotWindowPoints'), false);
    assert.equal(result.widgets[0].settings.plotFftWindow, 'hann');
});

test('import rejects coerced widget identities and malformed send settings before changing input', () => {
    for (const id of [123, null, undefined, '', {}, ['wave-1']]) {
        const config = migrateWorkspaceConfig({}); config.widgets[0].id = id;
        assert.throws(() => validateWorkspaceConfig(config), /编号/);
    }
    for (const title of [123, null, undefined, '', '   ']) {
        const config = migrateWorkspaceConfig({}); config.widgets[0].title = title;
        assert.throws(() => validateWorkspaceConfig(config), /标题/);
    }
    for (const send of [[], 'bad', { mode: 'number' }, { unit: 'ms' }, { interval: '-1' },
        { interval: 'Infinity' }, { interval: '' }, { interval: null }, { interval: true }]) {
        const config = { ...migrateWorkspaceConfig(null), send };
        const before = structuredClone(config);
        assert.throws(() => validateWorkspaceConfig(config), /发送/);
        assert.deepEqual(config, before);
    }
    for (const send of [{ interval: '0', unit: 'hz', mode: 'hex' }, { interval: '0.5', unit: 's', mode: 'text' }])
        assert.deepEqual(validateWorkspaceConfig({ ...migrateWorkspaceConfig(null), send }).send, send);
});

test('unknown config versions and coordinates outside workspace bounds are rejected', () => {
    assert.throws(() => migrateWorkspaceConfig({ version: 3 }), /版本/);
    const config = migrateWorkspaceConfig({});
    config.workspace.rects = { 'wave-1': { x: 0, y: 10000001, width: 640, height: 300 } };
    assert.throws(() => validateWorkspaceConfig(config), /位置/);
});

test('workspace zoom is backward compatible and invalid zoom imports are rejected', () => {
    const config = migrateWorkspaceConfig(null);
    assert.equal(config.workspace.zoom, 1);
    config.workspace.zoom = 1.5;
    assert.equal(validateWorkspaceConfig(config).workspace.zoom, 1.5);
    config.workspace.zoom = 5;
    assert.equal(validateWorkspaceConfig(config).workspace.zoom, 5);
    for (const zoom of [0, -1, 5.1, '1', null, NaN, Infinity]) {
        const bad = { ...config, workspace: { ...config.workspace, zoom } };
        assert.throws(() => validateWorkspaceConfig(bad), /缩放/);
    }
});

test('widget identities cannot shadow shared export source identities', () => {
    for (const id of ['numeric', 'base']) {
        const config = migrateWorkspaceConfig({});
        config.widgets[0].id = id;
        assert.throws(() => validateWorkspaceConfig(config), /编号/);
    }
});

test('response time count validates independently at the minimum shared sampling capacity', () => {
    const config = migrateWorkspaceConfig({ maxPoints: '2', plotWindowPoints: '2' });
    assert.equal(config.widgets[0].settings.plotResponseTimePoints, '2');
    config.widgets[0].settings.plotResponseTimePoints = '65536';
    assert.equal(validateWorkspaceConfig(config).widgets[0].settings.plotResponseTimePoints, '65536');
    for (const count of ['0', '1', '65537', '3.5', Infinity]) {
        config.widgets[0].settings.plotResponseTimePoints = count;
        assert.throws(() => validateWorkspaceConfig(config), /系统响应/);
    }
});

test('invalid global/tool containers and export settings are rejected before import', () => {
    for (const global of ['bad', [], 12]) assert.throws(() => validateWorkspaceConfig({ ...migrateWorkspaceConfig(null), global }));
    for (const tools of ['bad', [], 12]) assert.throws(() => validateWorkspaceConfig({ ...migrateWorkspaceConfig(null), tools }));
    const good = { format: 'csv', direction: 'rx', encoding: 'utf-8', timestamps: true, markers: false, channelIndices: [0] };
    for (const change of [{ format: 'bad' }, { encoding: 'bad' }, { timestamps: 'true' }, { channelIndices: [0, 0] }])
        assert.throws(() => validateWorkspaceConfig({ ...migrateWorkspaceConfig(null), tools: { exportSettings: { ...good, ...change } } }));
    assert.deepEqual(validateWorkspaceConfig({ ...migrateWorkspaceConfig(null), tools: { exportSettings: good } }).tools.exportSettings, good);
});

test('buffer export settings roundtrip independently and malformed profiles are rejected', () => {
    const config = migrateWorkspaceConfig(null);
    config.tools.exportSourceId = 'base';
    config.tools.exportProfiles.base.format = 'binary';
    config.tools.exportProfiles.numeric.formats.csv.timestamps = true;
    assert.deepEqual(validateWorkspaceConfig(JSON.parse(JSON.stringify(config))), config);
    for (const profile of [null, [], { format: 'pdf', formats: {} },
        { format: 'text', formats: { text: { encoding: 'bad' } } },
        { format: 'csv', formats: { csv: { channelIndices: [0, 0] } } }]) {
        assert.throws(() => validateWorkspaceConfig({ ...config, tools: { ...config.tools,
            exportProfiles: { ...config.tools.exportProfiles, numeric: profile } } }));
    }
});

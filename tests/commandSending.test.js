const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandLibrary, normalizeCommands } = require('../commandLibrary');
const { CommandRunner } = require('../commandRunner');

const command = (id, content = 'AA', extra = {}) => ({ id, type: 'command', name: id,
    mode: 'hex', content, repeat: 1, interval: 0, ...extra });
const group = (id, children) => ({ id, type: 'group', name: id, children });

test('nested groups prepare commands in visible order with exact Hex and UTF-8 bytes', () => {
    const library = new CommandLibrary([group('g', [command('a', '00 FF'),
        group('nested', [command('b', '你好', { mode: 'text', repeat: 2, interval: .01 })])]), command('c', 'CC')]);
    const plan = library.prepare('g');
    assert.deepEqual(plan.map(item => item.id), ['a', 'b']);
    assert.deepEqual([...plan[0].bytes], [0, 255]);
    assert.deepEqual([...plan[1].bytes], [...new TextEncoder().encode('你好')]);
    assert.equal(plan[1].repeat, 2);
    assert.equal(plan[1].interval, .01);
    assert.deepEqual(library.prepare('c').map(item => item.id), ['c']);
});

test('moving and reordering nodes preserves nested content and prevents cycles atomically', () => {
    const library = new CommandLibrary([group('g', [group('nested', [command('a')])]), command('b')]);
    assert.throws(() => library.move('g', 'nested'), /自身|子组/);
    library.move('b', 'g', 0);
    assert.deepEqual(library.prepare('g').map(item => item.id), ['b', 'a']);
    library.move('nested', null, 0);
    assert.deepEqual(library.serialize().map(item => item.id), ['nested', 'g']);
    library.remove('nested');
    assert.equal(library.find('a'), null);
    const id = library.add('command', 'g');
    assert.ok(library.find(id));
});

test('drop positions move items before after or inside groups without changing their contents', () => {
    const library = new CommandLibrary([command('a', 'AA'), command('b', 'BB'), command('c', 'CC'),
        group('g', [command('d', 'DD'), group('nested', [])])]);
    library.moveRelative('a', 'b', 'after');
    assert.deepEqual(library.nodes.map(node => node.id), ['b', 'a', 'c', 'g']);
    library.moveRelative('c', 'b', 'before');
    assert.deepEqual(library.nodes.map(node => node.id), ['c', 'b', 'a', 'g']);
    library.moveRelative('a', 'g', 'inside');
    assert.deepEqual(library.find('g').children.map(node => node.id), ['d', 'nested', 'a']);
    assert.equal(library.find('a').content, 'AA');
    library.moveRelative('a', 'd', 'before');
    assert.deepEqual(library.find('g').children.map(node => node.id), ['a', 'd', 'nested']);
    library.moveRelative('d', 'g', 'after');
    assert.equal(library.location('d').parent, null);
    const saved = library.serialize();
    assert.throws(() => library.moveRelative('g', 'nested', 'inside'), /自身|子组/);
    assert.throws(() => library.moveRelative('g', 'a', 'before'), /自身|子组/);
    assert.throws(() => library.moveRelative('b', 'c', 'bad'), /位置/);
    assert.deepEqual(library.serialize(), saved);
    library.moveRelative('g', 'g', 'before');
    assert.deepEqual(library.serialize(), saved);
});

test('groups preserve independent repeat settings and copies receive fresh IDs throughout the subtree', () => {
    const library = new CommandLibrary([group('g', [command('a', 'AA'), group('nested', [command('b', 'BB')])])]);
    assert.equal(library.find('g').repeat, 1);
    assert.equal(library.find('g').interval, 0);
    library.update('g', { repeat: 3, interval: .2 });
    const copyId = library.duplicate('g');
    assert.deepEqual(library.nodes.map(node => node.id), ['g', copyId]);
    const copied = library.find(copyId);
    assert.match(copied.name, /副本/);
    assert.equal(copied.repeat, 3); assert.equal(copied.interval, .2);
    const originals = new Set(['g', 'a', 'nested', 'b']);
    const allIds = [];
    const visit = node => { allIds.push(node.id); node.children?.forEach(visit); };
    visit(copied);
    assert.equal(new Set(allIds).size, 4);
    assert.ok(allIds.every(id => !originals.has(id)));
    library.update(copied.children[0].id, { content: 'CC' });
    assert.equal(library.find('a').content, 'AA');
    const leafCopy = library.duplicate('a');
    assert.equal(library.find('g').children[1].id, leafCopy);
    assert.equal(library.find(leafCopy).content, 'AA');
    assert.throws(() => library.update('g', { repeat: 0 }), /指令/);
    assert.throws(() => library.update('g', { interval: -1 }), /指令/);
    assert.deepEqual(normalizeCommands(library.serialize()), library.serialize());
});

test('invalid drafts can be saved but a whole group is prevalidated before sending anything', async () => {
    const library = new CommandLibrary([group('g', [command('good'), command('bad', 'A')])]);
    const writes = [], errors = [];
    const runner = new CommandRunner({ library, send: async bytes => { writes.push(bytes); return true; },
        getEngine: () => true, onError: error => errors.push(error.message) });
    assert.equal(await runner.start('g'), false);
    assert.deepEqual(writes, []);
    assert.match(errors[0], /bad.*Hex/);
    assert.equal(library.serialize()[0].children[1].content, 'A');
    library.find('bad').content = '';
    assert.throws(() => library.prepare('g'), /bad.*内容/);
});

test('configuration rejects duplicate IDs invalid types huge counts and excessive nesting', () => {
    for (const nodes of [[command('a'), command('a')], [command('a', 'AA', { repeat: 0 })],
        [command('a', 'AA', { interval: Infinity })], [command('a', 'AA', { mode: 'number' })]])
        assert.throws(() => normalizeCommands(nodes), /指令/);
    let deep = command('end');
    for (let i = 0; i < 40; i++) deep = group(`g${i}`, [deep]);
    assert.throws(() => normalizeCommands([deep]), /层/);
    const library = new CommandLibrary([command('a')]), before = library.serialize();
    assert.throws(() => library.replace([command('a'), command('a')]), /指令/);
    assert.deepEqual(library.serialize(), before);
});

test('runner sends repetitions sequentially and waits after a command before its next sibling', async () => {
    const library = new CommandLibrary([group('g', [command('a', 'AA', { repeat: 2, interval: .1 }), command('b', 'BB')])]);
    const writes = [], waits = [];
    const runner = new CommandRunner({ library, getEngine: () => true,
        send: async bytes => { writes.push([...bytes]); return true; },
        schedule(fn, ms) { waits.push(ms); queueMicrotask(fn); return waits.length; }, cancel() {} });
    assert.equal(await runner.start('g'), true);
    assert.deepEqual(writes, [[170], [170], [187]]);
    assert.deepEqual(waits, [100, 100]);
    assert.equal(runner.running, false);
});

test('nested group repetitions multiply execution counts and accumulate boundary intervals without a final wait', async () => {
    const library = new CommandLibrary([{ ...group('g', [command('a', 'AA', { repeat: 2, interval: .01 }),
        { ...group('nested', [command('b', 'BB', { interval: .02 })]), repeat: 2, interval: .03 }]), repeat: 2, interval: .04 }]);
    const writes = [], waits = [], states = [];
    const runner = new CommandRunner({ library, getEngine: () => true,
        send: async bytes => { writes.push([...bytes]); return true; }, onState: state => states.push(state),
        schedule(fn, ms) { waits.push(ms); queueMicrotask(fn); return waits.length; }, cancel() {} });
    assert.equal(await runner.start('g'), true);
    assert.deepEqual(writes, [[170], [170], [187], [187], [170], [170], [187], [187]]);
    assert.deepEqual(waits, [10, 10, 20, 30, 20, 30, 40, 10, 10, 20, 30]);
    assert.equal(states.at(-1).total, 8);
    assert.equal(states.at(-1).sent, 8);
    library.update('g', { repeat: 1000000 });
    library.update('nested', { repeat: 1000000 });
    library.update('b', { repeat: 1000000 });
    assert.throws(() => library.prepareTree('g'), /总发送次数/);
});

test('stopping during a write prevents remaining repetitions and a later task can run', async () => {
    const library = new CommandLibrary([command('a', 'AA', { repeat: 3 })]);
    let finish;
    const writes = [];
    const runner = new CommandRunner({ library, getEngine: () => true,
        send: bytes => { writes.push([...bytes]); return new Promise(resolve => { finish = resolve; }); } });
    const run = runner.start('a');
    await Promise.resolve();
    runner.stop(); finish(true);
    assert.equal(await run, false);
    assert.equal(writes.length, 1);
    runner.send = async bytes => { writes.push([...bytes]); return true; };
    assert.equal(await runner.start('a'), true);
    assert.equal(writes.length, 4);
});

test('stopping a wait settles the task and disconnect or failure aborts the sequence', async () => {
    const library = new CommandLibrary([command('a', 'AA', { repeat: 3, interval: 1 })]);
    let scheduled, cancelled = 0, engine = {};
    const writes = [], errors = [];
    const runner = new CommandRunner({ library, getEngine: () => engine,
        send: async bytes => { writes.push(bytes); return true; },
        schedule(fn) { scheduled = fn; return 7; }, cancel(id) { assert.equal(id, 7); cancelled++; },
        onError: error => errors.push(error.message) });
    const run = runner.start('a');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    runner.stop(); assert.equal(await run, false); assert.equal(cancelled, 1);
    scheduled(); assert.equal(writes.length, 1);
    runner.send = async () => { engine = {}; return true; };
    assert.equal(await runner.start('a'), false);
    assert.equal(errors.length, 1);
    runner.send = async () => false;
    assert.equal(await runner.start('a'), false);
    runner.dispose(); assert.equal(await runner.start('a'), false);
});

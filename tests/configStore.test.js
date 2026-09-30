const test = require('node:test');
const assert = require('node:assert/strict');

test('loading a config does not save intermediate UI state', () => {
    const { ConfigStore } = require('../configStore');
    const original = JSON.stringify({ connType: 'udp', channelsCount: '23' });
    const storage = {
        value: original,
        getItem() { return this.value; },
        setItem(_key, value) { this.value = value; }
    };
    let current = { connType: 'serial', channelsCount: '1' };
    let store;
    store = new ConfigStore({
        storage,
        key: 'config',
        validate: value => value,
        read: () => current,
        apply: value => {
            current = { ...current, connType: value.connType };
            store.save(); // Mirrors a change event fired during UI restoration.
            current = value;
        }
    });

    assert.equal(store.load(), true);
    assert.deepEqual(current, { connType: 'udp', channelsCount: '23' });
    assert.equal(storage.value, original);
    store.save();
    assert.equal(storage.value, original);
});

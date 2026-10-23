/** Small deterministic IndexedDB boundary used by workspace persistence tests. */
function createIndexedDbHarness({ seed, holdWrites = false, openError = null, blocked = false } = {}) {
    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const records = new Map(seed ? Object.entries(seed).map(([key, value]) => [key, clone(value)]) : []);
    const writes = [], connections = [];
    const state = { records, writes, connections, holdWrites, openError, blocked, abortNextWrite: null, failNextRead: null };
    let created = Boolean(seed);
    const later = callback => queueMicrotask(callback);

    function transaction(mode) {
        const pending = new Map();
        let finished = false;
        const tx = {
            mode, error: null,
            objectStore(name) {
                if (name !== 'config') throw new Error('Unexpected object store');
                return {
                    get(key) {
                        const request = {};
                        later(() => {
                            if (state.failNextRead) {
                                request.error = state.failNextRead;
                                state.failNextRead = null;
                                request.onerror?.({ target: request });
                                tx.abort(request.error);
                            } else {
                                request.result = clone(records.get(key));
                                request.onsuccess?.({ target: request });
                                later(() => tx.complete());
                            }
                        });
                        return request;
                    },
                    put(value, key) {
                        const request = {};
                        pending.set(key, clone(value));
                        later(() => {
                            request.result = key;
                            request.onsuccess?.({ target: request });
                            if (state.abortNextWrite) {
                                const error = state.abortNextWrite;
                                state.abortNextWrite = null;
                                later(() => tx.abort(error));
                            } else if (!state.holdWrites) later(() => tx.complete());
                        });
                        return request;
                    }
                };
            },
            complete() {
                if (finished) return;
                finished = true;
                for (const [key, value] of pending) records.set(key, clone(value));
                tx.oncomplete?.({ target: tx });
            },
            abort(error = new Error('Transaction aborted')) {
                if (finished) return;
                finished = true;
                tx.error = error;
                tx.onabort?.({ target: tx });
            }
        };
        if (mode === 'readwrite') writes.push(tx);
        return tx;
    }

    state.indexedDB = {
        open(name, version) {
            if (name !== 'serialplot_workspace' || version !== 1) throw new Error('Unexpected database');
            const request = {};
            later(() => {
                if (state.blocked) { request.onblocked?.({ target: request }); return; }
                if (state.openError) {
                    request.error = state.openError;
                    request.onerror?.({ target: request });
                    return;
                }
                const db = {
                    closed: false,
                    objectStoreNames: { contains: name => name === 'config' && created },
                    createObjectStore(name) {
                        if (name !== 'config') throw new Error('Unexpected object store');
                        created = true;
                    },
                    transaction(name, mode) {
                        if (this.closed) throw new Error('Database is closed');
                        if (name !== 'config') throw new Error('Unexpected object store');
                        return transaction(mode);
                    },
                    close() { this.closed = true; }
                };
                connections.push(db);
                request.result = db;
                if (!created) request.onupgradeneeded?.({ target: request });
                request.onsuccess?.({ target: request });
            });
            return request;
        }
    };
    return state;
}

module.exports = { createIndexedDbHarness };

/** One applied interpretation owns all numeric outputs; widgets only subscribe. */
(function(root) {
    const api = () => typeof module !== 'undefined' ? { ...require('./frameBuffer'), ...require('./computedFrames'),
        ...require('./channelOperations'), ...require('./engineFrames'), ...require('./configValidation'),
        Protocol: require('./protocolEngine').Protocol } : root.SerialPlotter;
    const ARRAY_FIELDS = ['dataType', 'endianness', 'channelsCount', 'enableHeader', 'headerHex', 'enableFooter', 'footerHex', 'enableChecksum'];
    const clone = value => JSON.parse(JSON.stringify(value));
    function protocolWireSignature(schema) {
        const normalize = (value, key = '', kind = '') => {
            if (Array.isArray(value)) {
                const items = value.map(item => normalize(item, '', key === 'messages' ? 'message' : ''));
                return ['messages', 'branches'].includes(key) ? items.sort((a, b) => String(a.id).localeCompare(String(b.id))) : items;
            }
            if (!value || typeof value !== 'object') return value;
            const result = {};
            for (const name of Object.keys(value).sort()) {
                if (['label', 'description', 'editorState', 'samples'].includes(name) || name === 'name' && (kind === 'message' || value === schema)) continue;
                result[name] = normalize(value[name], name);
            }
            return result;
        };
        return JSON.stringify(normalize(schema));
    }
    function mappingField(compiled, mapping) {
        const message = compiled.messageById.get(mapping.messageId); if (!message) return null;
        const candidates = [], escape = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const visit = (fields, start, indexDepth = 0) => {
            for (const field of fields) {
                const repeated = field.count !== undefined || ['repeat', 'tlv'].includes(field.type);
                const path = field.inline ? start.replace(/\\\.$/, '') : start + escape(field.name) + (repeated ? '\\[\\d+\\]' : '');
                const depth = indexDepth + Number(repeated);
                const childPath = field.inline ? start : path + '\\.';
                if (['struct', 'repeat', 'tlv'].includes(field.type)) visit(field.fields ?? field.headerFields ?? [], childPath, depth);
                if (field.branches) for (const branch of field.branches) visit(branch.fields ?? [], childPath, depth);
                if (field.type === 'struct' || field.type === 'repeat' || field.type === 'tlv' || field.type === 'choice') { /* Containers do not map to scalar channels. */ }
                else candidates.push({ field, path: new RegExp(`^${path}$`), depth });
                for (const bit of field.bits ?? []) candidates.push({ field: bit, path: new RegExp(`^${path}\\.${escape(bit.name)}$`), depth });
            }
        };
        const chain = []; for (let current = message.frameAlias ? compiled.rootMessages[0] : message; current; current = current.parent) chain.unshift(current);
        let prefix = '';
        for (const current of chain) {
            visit(current.fields, prefix);
            if (current.dispatch) prefix += `${escape(current.dispatch.name || 'content')}\\.`;
        }
        visit(compiled.headerFields ?? [], 'header\\.');
        const mappedDepth = (mapping.path?.match(/\[\d+\]/g) ?? []).length;
        return candidates.find(({ field, path, depth }) => mapping.fieldId ? field.id === mapping.fieldId && depth === mappedDepth : path.test(mapping.path))?.field ?? null;
    }
    function normalizeDataEngine(input, globals = {}) {
        const defaults = { dataType: 'float32', endianness: 'little', channelsCount: '1', enableHeader: true,
            headerHex: 'AB', enableFooter: false, footerHex: '0D 0A', enableChecksum: false };
        if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('数据引擎配置无效');
        input = (typeof module !== 'undefined' ? require('./configSymbols') : root.SerialPlotter).migrateEngineSymbols(input).settings;
        const s = { mode: 'Data_Array', array: Object.fromEntries(ARRAY_FIELDS.map(key => [key, globals[key] ?? defaults[key]])),
            protocols: [], protocolId: null, mappings: [], synchronization: { sampleRate: 1000, expiry: {} }, editorState: {}, draft: null, ...clone(input ?? {}) };
        if (!s.editorState || typeof s.editorState !== 'object' || Array.isArray(s.editorState) || JSON.stringify(s.editorState).length > 8388608)
            throw new Error('协议编辑器状态或样例超出限制');
        if (s.draft !== null) {
            const draft = s.draft, object = value => value && typeof value === 'object' && !Array.isArray(value);
            if (!object(draft) || !['Raw_Data', 'Data_Array', 'Self_Defined_Frame'].includes(draft.mode) ||
                !object(draft.array) || !ARRAY_FIELDS.every(key => Object.hasOwn(draft.array, key)) ||
                !Array.isArray(draft.protocols) || draft.protocols.some(schema => !object(schema)) ||
                draft.protocolId !== null && typeof draft.protocolId !== 'string' || !Array.isArray(draft.mappings) ||
                draft.mappings.some(mapping => !object(mapping)) || !object(draft.synchronization) || !object(draft.synchronization.expiry))
                throw new Error('数据引擎草稿结构无效');
        }
        if (!['Raw_Data', 'Data_Array', 'Self_Defined_Frame'].includes(s.mode)) throw new Error('数据引擎模式无效');
        api().validateConfig(s.array);
        if (!ARRAY_FIELDS.every(key => Object.hasOwn(s.array, key))) throw new Error('数组解析参数不完整');
        if (!Array.isArray(s.protocols) || !Array.isArray(s.mappings)) throw new Error('协议库或字段映射无效');
        const ids = new Set(), compiledProtocols = [];
        for (const schema of s.protocols) {
            let compiled;
            try { compiled = api().Protocol.compile(schema); }
            catch (error) {
                const identity = schema?.name ? `“${schema.name}”（${schema.id ?? '未命名'}）` : `“${schema?.id ?? '未命名'}”`;
                const range = Number.isInteger(error.byteOffset) && Number.isInteger(error.endByte)
                    ? `字节 [${error.byteOffset}, ${error.endByte})：` : '';
                const reason = error.message === 'Automatic writers overlap' ? '自动写入字段重叠（Automatic writers overlap）' : error.message;
                error.message = `协议${identity}校验失败：${range}${reason}`;
                throw error;
            }
            if (ids.has(compiled.id)) throw new Error('协议编号重复');
            ids.add(compiled.id);
            // Persist the compiler's legacy identities before visual edits can assign
            // new ones. Derived framing remains runtime-only in the saved input.
            const pending = [[schema, compiled.schema]];
            while (pending.length) {
                const [source, canonical] = pending.pop();
                if (!canonical || typeof canonical !== 'object') continue;
                if (!source.id && canonical.id) source.id = canonical.id;
                for (const key of Object.keys(source)) if (source[key] && typeof source[key] === 'object') pending.push([source[key], canonical[key]]);
            }
            compiledProtocols.push(compiled);
        }
        if (s.protocolId !== null && !ids.has(s.protocolId)) throw new Error('当前协议不存在');
        if (s.mode === 'Self_Defined_Frame' && !ids.has(s.protocolId)) throw new Error('请先选择有效的自定义协议');
        const mapped = new Set();
        for (const mapping of s.mappings) {
            if (!mapping || !Number.isInteger(mapping.channel) || mapping.channel < 0 || mapping.channel >= 65535 ||
                typeof mapping.messageId !== 'string' || typeof mapping.path !== 'string' || !mapping.path) throw new Error('通道字段映射无效或重复');
            const owners = compiledProtocols.filter(compiled => compiled.messageById.has(mapping.messageId));
            if (mapping.protocolId === undefined) {
                if (owners.length !== 1) throw new Error('同名命令的字段映射必须明确协议编号');
                mapping.protocolId = owners[0].id;
            }
            if (typeof mapping.protocolId !== 'string' || !ids.has(mapping.protocolId) ||
                mapping.fieldId !== undefined && (typeof mapping.fieldId !== 'string' || !mapping.fieldId)) throw new Error('字段映射的协议或字段 ID 无效');
            const key = `${mapping.protocolId}:${mapping.messageId}:${mapping.channel}`;
            if (mapped.has(key)) throw new Error('通道字段映射无效或重复');
            mapped.add(key);
            const field = compiledProtocols.filter(compiled => compiled.id === mapping.protocolId).map(compiled => mappingField(compiled, mapping)).find(Boolean);
            if (!field || !/^(?:u?int(?:8|16|32|64)?|float(?:32|64)|bool|enum|bitfield|checksum)$/.test(field.type))
                throw new Error('字段映射必须引用已声明的数值或位字段');
            if (Number.isInteger(Number(globals.channelsCount)) && mapping.channel >= Number(globals.channelsCount))
                throw new Error('字段映射超出全局原始通道目录');
        }
        const sync = s.synchronization;
        if (!sync || !Number.isFinite(Number(sync.sampleRate)) || Number(sync.sampleRate) <= 0 || Number(sync.sampleRate) > 1000000 ||
            !sync.expiry || typeof sync.expiry !== 'object' || Array.isArray(sync.expiry)) throw new Error('同步采样率或有效期无效');
        sync.sampleRate = Number(sync.sampleRate);
        for (const [key, value] of Object.entries(sync.expiry)) if (!/^\d+$/.test(key) || Number(key) >= 65535 ||
            !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('通道有效期必须为非负秒数');
        return s;
    }
    function inertParser() {
        return { boundary: 'idle', maxFrameBytes: 1048576, length: 0, frameCount: 0, failCount: 0,
            nextByte: 0, buffer: new Uint8Array(0), readOffset: 0, writeOffset: 0,
            appendData() {}, reset() {}, flushPending() {}, getTypeLength: () => 8 };
    }
    function preflightDataEngine(settings, globals = {}, { memoryLimitBytes } = {}) {
        const normalized = normalizeDataEngine(settings, globals);
        const rawCount = normalized.mode === 'Data_Array' ? Math.max(Number(globals.channelsCount ?? 1), Number(normalized.array.channelsCount))
            : Number(globals.channelsCount ?? normalized.array.channelsCount);
        const engine = new (api().ChannelOperations)(rawCount, globals.channelDefinitions ?? [],
            { names: globals.channelNames ?? [], symbolVersion: globals.symbolVersion });
        const compiled = normalized.mode === 'Self_Defined_Frame' ? api().Protocol.compile(normalized.protocols.find(schema => schema.id === normalized.protocolId)) : null;
        const outputCount = compiled ? compiled.messages.length + 3 : normalized.mode === 'Raw_Data' ? 2 : 1;
        const requiredMemoryBytes = engine.requiredMemoryBytes * outputCount;
        if (memoryLimitBytes !== undefined && (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes < 1)) throw new RangeError('内存预算必须为正整数字节数');
        if (memoryLimitBytes !== undefined && requiredMemoryBytes > memoryLimitBytes) throw new RangeError('运算通道历史状态超过内存预算');
        return { normalized, config: normalized, requiredMemoryBytes, outputCount, rawCount };
    }
    class DataEngine {
        constructor(service, settings, globals, { onChange = () => {}, onProgress = () => {} } = {}) {
            this.service = service; this.globals = globals; this.onChange = onChange; this.onProgress = onProgress;
            this.config = preflightDataEngine(settings, globals, { memoryLimitBytes: service.memory.limitBytes }).normalized; this.arraySource = service.numericSource;
            this.outputs = new Map(); this.managed = new Set(); this.generation = 0; this.cache = new Map();
            this.rebuilding = false; this.running = false; this.disposed = false;
            service.dataEngine = this;
            this.timer = setInterval(() => this.advance(), 16); this.timer.unref?.();
            this._configure();
        }
        get mode() { return this.config.mode; }
        get channelCount() { return Number(this.globals.channelsCount); }
        shouldFeed(source) { return !source.engineManaged && (source !== this.arraySource || this.mode === 'Data_Array'); }
        output(id = null, byte = false) {
            if (this.mode === 'Data_Array') return this.arraySource;
            if (this.mode === 'Raw_Data') return byte ? this.service.baseSource : this.emptySource;
            if (id) return this.outputs.get(id) ?? this.emptySource;
            return byte ? this.recordsSource : this.syncSource;
        }
        choices() {
            if (this.mode !== 'Self_Defined_Frame') return [];
            return [{ id: 'synchronized', name: '全局同步采样表' }, ...this.compiled.messages.map(message =>
                ({ id: `message:${message.id}`, name: message.name ?? message.id }))];
        }
        _source(id, frames, kind = 'numeric', parser = inertParser()) {
            const source = { id: `engine:${id}`, kind, frames, parser, engineManaged: true, refs: 0, persistent: true,
                generation: this.generation, rebuilding: false, progress: null, errors: [], errorBytes: 0, pin: null,
                key: `engine:${id}`, startByte: this.service.history.startByte, ready: Promise.resolve(),
                format: { captureMode: kind === 'protocol' ? 'engine' : 'number', channelsCount: String(this.channelCount), dataType: 'float64' } };
            source.ready = Promise.resolve(source); this.service.sources.add(source); this.managed.add(source); this.outputs.set(id, source);
            if (kind === 'numeric') {
                frames.onChange = () => this.service._safeNotify(this.service.onChange, source);
                frames.onProgress = () => { this.service.memory?.enforce(); this.service._safeNotify(this.service.onProgress, source); };
            }
            return source;
        }
        _numericFrames() {
            const a = api(), frames = new a.ComputedFrames(new a.FrameBuffer(this.channelCount, this.service.capacity),
                this.globals.channelDefinitions ?? [], { names: this.globals.channelNames,
                    symbolVersion: this.globals.symbolVersion, yieldControl: this.service.yieldControl });
            return frames;
        }
        _configure() {
            const a = api();
            for (const source of this.managed) { source.generation++; source.frames.dispose?.(); this.service.sources.delete(source); }
            this.outputs.clear(); this.managed.clear(); this.cache.clear(); this.anchor = null; this.running = false;
            this.preserveRecordsThroughByte = null; this.replayQueue = null; this.replayBatches = null;
            this.service.catalogCount = this.channelCount; this.arraySource.catalogCount = this.channelCount;
            this.arraySource.format.catalogCount = this.channelCount;
            if (this.mode === 'Data_Array') {
                this.service.numericSource = this.arraySource;
                Object.assign(this.arraySource.format, this.config.array, { captureMode: 'number', catalogCount: this.channelCount,
                    isLittleEndian: this.config.array.endianness !== 'big' });
                this.service._restart(this.arraySource, false); return;
            }
            // An inactive interpretation must not pin an invisible old receive prefix.
            this.arraySource.generation++; this.arraySource.parser.reset(); this.arraySource.frames.clear();
            this.arraySource.errors.length = 0; this.arraySource.errorBytes = 0; this.arraySource.pin = null;
            this.arraySource.rebuilding = false; this.arraySource.progress = null; this.arraySource.replayStorage = null;
            this.arraySource.startByte = this.service.history.endByte; this.arraySource.ready = Promise.resolve(this.arraySource);
            this.emptySource = this._source('empty', this._numericFrames());
            if (this.mode === 'Raw_Data') { this.service.numericSource = this.emptySource; return; }
            this.compiled = a.Protocol.compile(this.config.protocols.find(p => p.id === this.config.protocolId));
            const parser = new a.Protocol.StreamParser(); parser.setFormat({ protocol: this.compiled });
            parser.maxDecodedFields = Math.max(1, Math.min(32768, Math.floor(this.service.memory.limitBytes / 2048)));
            const records = new a.FrameBuffer(1, this.service.capacity); records.setRawMode(true);
            this.recordsSource = this._source('records', records, 'protocol', parser);
            parser.nextByte = this.service.history.endByte;
            this.recordsSource.decodeRecord = index => this.decode(index);
            parser.onFrameError = (type, time, bytes, metadata) => this.service._error(this.recordsSource,
                { type, reason: type, time, bytes, ...metadata, kind: 'error' });
            parser.onCallbackError = error => this.service._error(this.recordsSource, error);
            parser.onFrameParsed = (record, time, bytes, timestamp, metadata) => this._record(record, time, bytes, timestamp, metadata);
            const sync = new a.SynchronizedFrames(this.channelCount, this.service.capacity, {
                ...this.config.synchronization, definitions: this.globals.channelDefinitions ?? [], names: this.globals.channelNames,
                symbolVersion: this.globals.symbolVersion,
                resolveFrame: origin => this._resolveOrigin(origin), yieldControl: this.service.yieldControl,
                onProgress: () => { this.service.memory?.enforce(); if (this.syncSource) this.service._safeNotify(this.service.onProgress, this.syncSource); } });
            this.syncSource = this._source('synchronized', sync);
            this.syncSource.sampleRate = { rate: sync.sampleRate, observe() {}, reset() {} };
            for (const message of this.compiled.messages) this._source(`message:${message.id}`, this._numericFrames());
            this.service.numericSource = this.syncSource;
            this._indexMappings();
        }
        _indexMappings() {
            this.mappingsByMessage = new Map();
            for (const mapping of this.config.mappings) {
                if (mapping.protocolId && mapping.protocolId !== this.config.protocolId) continue;
                if (!this.mappingsByMessage.has(mapping.messageId)) this.mappingsByMessage.set(mapping.messageId, []);
                this.mappingsByMessage.get(mapping.messageId).push(mapping);
            }
        }
        _resolveOrigin(origin) {
            const frames = this.recordsSource.frames, index = frames.indexAtOrAfterOrder(origin.order);
            return index >= 0 && frames.orderAt(index) === origin.order ? frames.frameAt(index) : null;
        }
        decode(index) {
            const frame = this.recordsSource.frames.frameAt(index); if (!frame) return null;
            let record = this.cache.get(frame.order);
            if (!record) { record = api().Protocol.decode(frame.bytes, this.compiled,
                { maxFields: Math.max(1, Math.min(32768, Math.floor(this.service.memory.limitBytes / 2048))) }); this._rememberRecord(frame.order, record); }
            return { ...frame, record };
        }
        _recordMemory(record) {
            let bytes = 256 + (record.rawPayload?.byteLength ?? 0);
            for (const field of record.flatFields ?? []) bytes += 128 + field.path.length * 2 + (field.value?.byteLength ?? 0);
            for (const result of record.ruleResults ?? []) bytes += 256 + String(result.name ?? '').length * 2 + String(result.message ?? '').length * 2;
            for (const warning of record.warnings ?? []) bytes += 128 + String(warning.message ?? '').length * 2;
            return bytes;
        }
        _rememberRecord(order, record) {
            const limit = Math.min(16777216, this.service.memory.limitBytes / 16), bytes = this._recordMemory(record);
            while (this.cache.size && (this.cache.size >= 64 || this.estimatedMemoryBytes + bytes > limit)) this.cache.delete(this.cache.keys().next().value);
            if (bytes <= limit) this.cache.set(order, record);
        }
        get estimatedMemoryBytes() {
            let bytes = 0;
            for (const record of this.cache.values()) bytes += this._recordMemory(record);
            for (const entry of this.replayQueue ?? []) bytes += 256 + (entry.bytes?.length ?? 0);
            for (const job of this.replayBatches ?? []) for (const entry of job.batch ?? []) bytes += 256 + entry.bytes.length;
            return bytes;
        }
        clearDecodeCache() { this.cache.clear(); }
        estimateReceiveMemory(byteLength) {
            if (this.mode !== 'Self_Defined_Frame' || this.rebuilding) return 0;
            const framing = this.compiled.schema.framing, minimum = framing.fixedLength ?? Math.max(1, (framing.header?.length ?? 0) + 1);
            const count = Math.ceil((this.recordsSource.parser.length + byteLength) / minimum);
            let bytes = this.recordsSource.frames.estimateAppendMemory(count, byteLength) + byteLength * 4 + count * 512;
            let maximum = 0, messages = 0;
            for (const [id, source] of this.outputs) if (id.startsWith('message:')) {
                const mappings = this.mappingsByMessage.get(id.slice(8))?.length ?? 0;
                maximum = Math.max(maximum, source.frames.estimateAppendMemory(count, 0, 0, mappings)); messages++;
            }
            bytes += maximum * Math.min(messages, count) + this.syncSource.frames.estimateAppendMemory(count);
            return bytes;
        }
        _record(record, time, bytes, timestamp, metadata = {}) {
            const frames = this.recordsSource.frames;
            if (this.preserveRecordsThroughByte === null || metadata.byteOffset >= this.preserveRecordsThroughByte)
                frames.appendRaw(bytes, time, metadata.order, timestamp, metadata);
            this._rememberRecord(metadata.order, record);
            if (record.valid === false) {
                this.recordsSource.parser.failCount++;
                this.service._safeNotify(this.service.onChange, this.recordsSource);
                return;
            }
            const values = new Map();
            const fields = new Map(record.flatFields.map(field => [field.path, field]));
            const fieldIds = new Map();
            for (const field of record.flatFields) if (field.fieldId) {
                if (!fieldIds.has(field.fieldId)) fieldIds.set(field.fieldId, []);
                fieldIds.get(field.fieldId).push(field);
            }
            const messages = [];
            for (let message = this.compiled.messageById.get(record.messageId); message; message = message.parent) messages.unshift(message.id);
            if (!messages.length) messages.push(record.messageId);
            const mappings = messages.flatMap(id => this.mappingsByMessage.get(id) ?? []);
            for (const mapping of mappings) {
                const indexed = path => (path.match(/\[\d+\]/g) ?? []).join('');
                const item = mapping.fieldId ? fieldIds.get(mapping.fieldId)?.find(field => indexed(field.path) === indexed(mapping.path)) : fields.get(mapping.path);
                const value = item?.value;
                values.set(mapping.channel, typeof value === 'bigint'
                    ? value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : NaN
                    : typeof value === 'boolean' ? Number(value) : Number.isFinite(value) ? value : Number.isFinite(item?.numeric) ? item.numeric : NaN);
            }
            for (const id of messages) {
                const source = this.outputs.get(`message:${id}`); if (!source) continue;
                const samples = new Array(this.channelCount).fill(NaN); for (const [channel, value] of values) samples[channel] = value;
                source.frames.append(samples, new Uint8Array(0), time, metadata.order, timestamp, { ...metadata, endByte: metadata.endByte });
                source.parser.frameCount++; this.service._safeNotify(this.service.onChange, source);
            }
            if (record.known !== false) {
                const arrival = metadata.arrival ?? this.service.now();
                this.anchor ??= { arrival, timestamp }; this.running = true;
                const syncTime = this.anchor.timestamp + arrival - this.anchor.arrival;
                this.syncSource.frames.ingest(syncTime, values, { ...metadata, timestamp });
                this.syncSource.parser.frameCount = this.syncSource.frames.next;
                this.service._safeNotify(this.service.onChange, this.syncSource);
            }
            this.service._safeNotify(this.service.onChange, this.recordsSource);
        }
        receive(bytes, stamp) {
            if (this.mode !== 'Self_Defined_Frame' || this.rebuilding || this.disposed) return;
            try { this.recordsSource.parser.appendData(bytes, stamp); }
            catch (error) { this.service._error(this.recordsSource, error); }
        }
        advance() {
            if (!this.running || this.rebuilding || this.service.paused || !this.anchor || this.disposed) return;
            const time = this.anchor.timestamp + this.service.now() - this.anchor.arrival;
            const frames = this.syncSource.frames, ticks = Math.max(1, Math.ceil((time - frames.lastTimestamp) * frames.sampleRate / 1000));
            if (!this.service.memory.enforce(frames.estimateAppendMemory(ticks))) {
                this.running = false; this.anchor = null; frames.stop();
                this.service.memory.blockedReason = '同步采样的运算状态超过内存预算，已安全暂停'; this.service.pause(true); return;
            }
            if (this.syncSource.frames.advance(time)) {
                this.syncSource.parser.frameCount = this.syncSource.frames.next;
                this.service.memory.check(); this.service._safeNotify(this.service.onChange, this.syncSource);
            }
        }
        endStream(stamp = {}) {
            if (this.mode !== 'Self_Defined_Frame' || this.rebuilding && !stamp.replay) return;
            this.recordsSource.parser.flushPending();
            this._finishSampling(stamp);
        }
        _finishSampling(stamp = {}) {
            if (this.anchor) this.syncSource.frames.advance(this.anchor.timestamp + (stamp.arrival ?? this.service.now()) - this.anchor.arrival);
            this.syncSource.frames.stop(); this.running = false; this.anchor = null;
        }
        async apply(settings, { rebuild = this.service.rebuildHistory, force = false } = {}) {
            const next = preflightDataEngine(settings ?? this.config.draft ?? this.config, this.globals,
                { memoryLimitBytes: this.service.memory.limitBytes }).normalized; next.draft = null;
            if (Number(next.array.channelsCount) > this.channelCount) throw new Error('请先扩展全局原始通道目录');
            const previous = this.config;
            const unchangedArray = previous.mode === 'Data_Array' && next.mode === 'Data_Array' && JSON.stringify(previous.array) === JSON.stringify(next.array);
            const selected = config => protocolWireSignature(config.protocols.find(schema => schema.id === config.protocolId));
            const unchangedProtocol = previous.mode === 'Self_Defined_Frame' && next.mode === previous.mode &&
                selected(previous) === selected(next);
            if (!force && (unchangedArray || previous.mode === 'Raw_Data' && next.mode === 'Raw_Data')) {
                this.config = next; this.onChange(this.config); return this.config;
            }
            if (!force && unchangedProtocol) {
                const activeMappings = config => config.mappings.filter(mapping => mapping.protocolId === config.protocolId);
                const rulesChanged = JSON.stringify(activeMappings(previous)) !== JSON.stringify(activeMappings(next)) ||
                    JSON.stringify(previous.synchronization) !== JSON.stringify(next.synchronization);
                this.config = next;
                this.compiled = api().Protocol.compile(next.protocols.find(schema => schema.id === next.protocolId));
                this.recordsSource.parser.protocol = this.compiled; this.clearDecodeCache(); this._indexMappings();
                if (rulesChanged) {
                    this.syncSource.sampleRate.rate = next.synchronization.sampleRate;
                    if (rebuild) {
                        this.syncSource.frames.sampleRate = next.synchronization.sampleRate;
                        this.syncSource.frames.expiry = next.synchronization.expiry;
                        await this.rebuild({ preserveRecords: true });
                    } else this.syncSource.frames.updateSynchronization(next.synchronization, {
                        timestamp: this.anchor ? this.anchor.timestamp + this.service.now() - this.anchor.arrival : NaN });
                }
                this.onChange(this.config); return this.config;
            }
            this.generation++; this.config = next; this.rebuilding = false;
            this.service.channelDefinitions = this.globals.channelDefinitions ?? [];
            this.service.channelNames = this.globals.channelNames ?? [];
            this.arraySource.frames.channelNames = this.service.channelNames;
            this._configure();
            if (next.mode === 'Data_Array') {
                for (const key of ARRAY_FIELDS) if (key !== 'channelsCount') this.globals[key] = next.array[key];
                await this.service.updateNumericFormat(next.array, { rebuild });
            } else if (next.mode === 'Self_Defined_Frame' && rebuild) await this.rebuild();
            this.service._safeNotify(this.service.onChange, null); this.onChange(this.config); return this.config;
        }
        updateChannelDefinitions(definitions, options = {}) {
            const a = api(), sources = [this.arraySource, ...this.managed].filter(source => source.kind === 'numeric');
            const validated = new a.ChannelOperations(this.channelCount, definitions, { names: this.globals.channelNames, symbolVersion: 2 });
            const reserve = validated.requiredMemoryBytes * sources.reduce((total, source) => total + (options.rebuild !== false && source.frames.length ? 2 : 1), 0);
            if (reserve > this.service.memory.limitBytes || !this.service.memory.enforce(reserve)) throw new RangeError('运算通道历史状态超过内存预算');
            this.service.channelNames = this.globals.channelNames; this.service.channelDefinitions = validated.definitions;
            this.globals.channelDefinitions = validated.definitions.map(definition => ({ ...definition }));
            const pending = [];
            for (const source of sources) {
                source.catalogCount = this.channelCount; source.format.catalogCount = this.channelCount;
                source.frames.channelNames = this.globals.channelNames; source.frames.names = this.globals.channelNames;
                pending.push(source.frames.updateDefinitions(validated.definitions, { ...options, rawChannelCount: this.channelCount }));
            }
            return Promise.all(pending);
        }
        rebuild({ preserveRecords = false } = {}) {
            if (this.mode !== 'Self_Defined_Frame') return Promise.resolve();
            const generation = ++this.generation, history = this.service.history, epoch = this.service.epoch;
            const cancelled = () => this.disposed || generation !== this.generation || epoch !== this.service.epoch;
            let cursor = history.startByte, lastBoundaryByte = -Infinity;
            const records = this.recordsSource.frames;
            const parser = this.recordsSource.parser, queue = [], pending = [];
            this.replayQueue = queue; this.replayBatches = pending; parser.deferDecode = true;
            parser.onFrameParsed = (_deferred, time, bytes, timestamp, metadata) => queue.push({ time, bytes, timestamp, metadata });
            this.preserveRecordsThroughByte = preserveRecords && records.length
                ? records.rawByteOffsetAt(records.length - 1) + records.rawBytesAt(records.length - 1).length : null;
            const reset = () => {
                this.cache.clear(); this.anchor = null; this.running = false;
                queue.length = 0; pending.length = 0;
                for (const source of this.managed) {
                    if (!preserveRecords || source.kind !== 'protocol') source.frames.clear();
                    source.parser.reset(); source.parser.nextByte = history.startByte; source.parser.frameCount = 0; source.parser.failCount = 0;
                    source.errors.length = 0; source.errorBytes = 0; source.pin = history.startByte; source.startByte = history.startByte;
                }
                cursor = history.startByte; lastBoundaryByte = -Infinity;
            };
            this.rebuilding = true; reset();
            for (const source of this.managed) { source.rebuilding = true; source.progress = { processedBytes: 0, totalBytes: history.byteLength }; }
            const yieldControl = this.service.yieldControl ?? (() => new Promise(resolve => setTimeout(resolve, 0)));
            const work = (async () => {
                const pool = this.service.workerPool;
                const maxInFlight = Math.max(1, Math.min(pool.workerLimit ?? pool.maxWorkers ?? 1,
                    Math.floor(this.service.memory.limitBytes / 8388608)));
                const maxDecodedFields = Math.max(1, Math.min(65536, Math.floor(this.service.memory.limitBytes / (2048 * maxInFlight))));
                const dispatch = batch => {
                    const promise = pool.runTask({ kind: 'protocol-decode', schema: this.compiled.schema, maxDecodedFields,
                        records: batch.map(entry => ({ bytes: entry.bytes })) });
                    promise.catch(() => {}); return promise;
                };
                const commitBatch = async (batch, promise) => {
                    let decoded;
                    try { decoded = await promise; }
                    catch (error) {
                        if (cancelled()) return;
                        if (error.code === 'protocol-batch-limit' && batch.length > 1) {
                            const middle = Math.floor(batch.length / 2), left = batch.slice(0, middle), right = batch.slice(middle);
                            await commitBatch(left, dispatch(left));
                            if (!cancelled()) await commitBatch(right, dispatch(right));
                            return;
                        }
                        if (error.code === 'protocol-record-limit') {
                            const failure = new RangeError('单条协议记录的结构字段超过内存预算，请减少字段展开或提高预算'); failure.code = error.code; throw failure;
                        }
                        throw error;
                    }
                    if (cancelled()) return;
                    if (!Array.isArray(decoded) || decoded.length !== batch.length) throw new Error('协议任务返回的记录数量不匹配');
                    for (let index = 0; index < batch.length; index++) {
                        const entry = batch[index];
                        if (entry.metadata.byteOffset >= history.startByte) this._record(decoded[index], entry.time, entry.bytes, entry.timestamp, entry.metadata);
                    }
                };
                const commit = async () => {
                    const job = pending[0]; if (!job) return;
                    if (job.boundary) { if (!cancelled()) this._finishSampling(job.boundary); pending.shift(); return; }
                    await commitBatch(job.batch, job.promise);
                    if (cancelled()) return;
                    pending.shift();
                };
                const drain = async (flush = false) => {
                    while (queue.length && !cancelled()) {
                        if (queue[0].boundary) { pending.push(queue.shift()); continue; }
                        const batch = []; let bytes = 0;
                        while (queue.length && !queue[0].boundary && batch.length < 256 &&
                            (!batch.length || bytes + queue[0].bytes.length <= 4194304)) {
                            const entry = queue.shift(); batch.push(entry); bytes += entry.bytes.length;
                        }
                        pending.push({ batch, promise: dispatch(batch) });
                        while (pending.length >= maxInFlight && !cancelled()) await commit();
                    }
                    if (flush) while (pending.length && !cancelled()) await commit();
                };
                try {
                    await yieldControl();
                    let revision = -1;
                    while (!cancelled() && (cursor < history.endByte || revision !== history.revision)) {
                        if (cursor < history.startByte) reset();
                        const stop = history.endByte; revision = history.revision;
                        let worked = 0, started = performance.now();
                        try {
                            const framing = this.compiled.schema.framing;
                            const minimum = framing.fixedLength ?? Math.max(1, (framing.header?.length ?? 0) + 1);
                            for (const chunk of history.readRange(cursor, stop, { maxSliceBytes: Math.min(16384, minimum * 256) })) {
                                if (cancelled()) return;
                                if (chunk.bytes.length) parser.appendData(chunk.bytes, chunk);
                                cursor = chunk.endByte;
                                if (chunk.streamEnded && cursor !== lastBoundaryByte) {
                                    parser.flushPending(); queue.push({ boundary: { arrival: chunk.boundaryArrival ?? chunk.arrival,
                                        timestamp: chunk.boundaryTimestamp ?? chunk.timestamp } });
                                    lastBoundaryByte = cursor;
                                }
                                await drain();
                                if (cancelled()) return;
                                worked += chunk.bytes.length;
                                if (worked >= 65536 || performance.now() - started >= 8) {
                                    const progress = { processedBytes: cursor - history.startByte, totalBytes: history.byteLength };
                                    for (const source of this.managed) { source.progress = progress; this.onProgress(source, progress); }
                                    this.service.memory.enforce(); await yieldControl();
                                    if (cancelled()) return;
                                    if (cursor < history.startByte) break;
                                    worked = 0; started = performance.now();
                                }
                            }
                            await drain(true);
                        } catch (error) {
                            if (cursor < history.startByte) { reset(); continue; }
                            throw error;
                        }
                    }
                    if (cancelled()) return;
                    if (!this.service.paused && this.anchor) {
                        const time = this.anchor.timestamp + this.service.now() - this.anchor.arrival;
                        this.syncSource.frames.advance(time);
                    }
                } finally {
                    if (!cancelled()) {
                        this.rebuilding = false;
                        this.replayQueue = null; this.replayBatches = null; parser.deferDecode = false;
                        parser.onFrameParsed = (record, time, bytes, timestamp, metadata) => this._record(record, time, bytes, timestamp, metadata);
                        this.preserveRecordsThroughByte = null;
                        for (const source of this.managed) { source.rebuilding = false; source.pin = null; source.progress = null; this.onProgress(source, null); }
                        this.service.memory.enforce(); this.service._prune();
                    }
                }
            })();
            for (const source of this.managed) { source.ready = work.then(() => source); source.ready.catch(() => {}); }
            return work;
        }
        clear() {
            this.generation++; this.anchor = null; this.running = false; this.rebuilding = false; this.cache.clear(); this.replayQueue = null; this.replayBatches = null;
            for (const source of this.managed) {
                source.frames.clear(); source.parser.reset(); source.parser.frameCount = 0; source.parser.failCount = 0;
                source.errors.length = 0; source.errorBytes = 0; source.rebuilding = false; source.pin = null;
                if (source.kind === 'protocol') {
                    source.parser.deferDecode = false;
                    source.parser.onFrameParsed = (record, time, bytes, timestamp, metadata) => this._record(record, time, bytes, timestamp, metadata);
                }
            }
        }
        serialize() { return clone(this.config); }
        dispose() { this.disposed = true; this.generation++; clearInterval(this.timer); this.cache.clear(); }
    }
    const result = { DataEngine, normalizeDataEngine, preflightDataEngine, resolveProtocolMappingField: mappingField, ENGINE_ARRAY_FIELDS: ARRAY_FIELDS };
    root.SerialPlotter ??= {}; Object.assign(root.SerialPlotter, result);
    if (typeof module !== 'undefined') module.exports = result;
})(globalThis);

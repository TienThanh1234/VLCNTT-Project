import express from 'express';
import mqtt from 'mqtt';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, createWriteStream } from 'node:fs';
import { STALE_MS, validPayload } from './protocol.js';
import { SpectrumMonitor } from './spectrum.js';

export function createDemo({ url, prefix, logDirectory = 'data', now = Date.now, onTrace = null })
{
    if (!prefix || /[+#]/.test(prefix) || prefix.includes('CHANGE_THIS'))
    {
        throw new Error('Set a unique MQTT_PREFIX in .env first.');
    }
    const app = express();
    const server = createServer(app);
    const allowedOrigin = origin => !origin || /^http:\/\/(localhost|127\.0\.0\.1):(3000|5173)$/.test(origin);
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096,
        verifyClient: (info, done) => done(allowedOrigin(info.origin), 403, 'Origin rejected') });
    const client = mqtt.connect(url, {
        clientId: `rg-be-${randomUUID()}`, reconnectPeriod: 2000,
        clean: true, queueQoSZero: false, connectTimeout: 10000,
        // This handler subscribes explicitly and waits for its SUBACK on every connection.
        resubscribe: false
    });
    mkdirSync(logDirectory, { recursive: true });
    const spectrum = new SpectrumMonitor(logDirectory, now);
    const log = createWriteStream(`${logDirectory}/telemetry-${Date.now()}.jsonl`, { flags: 'a' });
    log.on('error', (error) => console.error('LOG ERROR', error.message));
    const diagnostics = createWriteStream(`${logDirectory}/diagnostics-${Date.now()}.jsonl`, { flags: 'a' });
    diagnostics.on('error', error => console.error('DIAGNOSTICS ERROR', error.message));
    let state = null;
    let stateAt = 0;
    let lastStateReceivedAt = 0;
    let lastAck = null;
    let history = [];
    let accepted = new Map();
    const pending = new Map();
    const commands = new Map();
    const inflight = new Set();
    const retiredBoots = new Set();
    let streams = {};
    let subscribed = false;
    let connection = 0;
    let timing = null;
    const endpoint = new URL(url);
    const mqttConfig = { protocol: endpoint.protocol.replace(':', ''), host: endpoint.hostname,
        port: Number(endpoint.port || (endpoint.protocol === 'mqtts:' ? 8883 : 1883)),
        client_id: client.options.clientId, pid: process.pid };
    const topics = ['state', 'telemetry/vibration', 'telemetry/rpm', 'ack'].map(s => `${prefix}/${s}`);
    const topicTypes = new Map(topics.map((topic, i) => [topic, ['state', 'telemetry/vibration', 'telemetry/rpm', 'ack'][i]]));
    const ingest = { received: 0, accepted: {}, dropped: 0, drop_reasons: {}, last_message: null, last_drop: null };
    let diagnosticBytes = 0;
    const sampledAt = new Map();
    const trace = (stage, details = {}) =>
    {
        const entry = { at: now(), source: 'synthetic', stage, ...details };
        const record = commands.get(details.command_id);
        if (record)
        {
            record.trace.push(entry);
            record.trace = record.trace.slice(-16);
        }
        const line = JSON.stringify(entry) + '\n';
        const length = Buffer.byteLength(line);
        if (diagnostics.writableLength < 1000000 && diagnosticBytes + length <= 4 * 1024 * 1024)
        {
            diagnostics.write(line);
            diagnosticBytes += length;
        }
        if (onTrace)
        {
            onTrace(entry);
        }
        else
        {
            console.info('TRACE', JSON.stringify(entry));
        }
    };
    const sampledTrace = (stage, details, key = stage) => {
        if (!sampledAt.has(key) || now() - sampledAt.get(key) >= 5000) {
            sampledAt.set(key, now());
            trace(stage, details);
        }
    };
    trace('MQTT_CONFIG', { ...mqttConfig, prefix, topics, env_keys: ['MQTT_URL', 'MQTT_PREFIX'], diagnostic_limit_bytes: 4 * 1024 * 1024 });
    const snapshot = () => ({
        broker_connected: client.connected, broker_subscribed: subscribed, prefix, timing,
        mqtt_config: { ...mqttConfig, remote_address: client.stream?.remoteAddress ?? null, remote_port: client.stream?.remotePort ?? null },
        mqtt_ingest: ingest,
        state, state_age_ms: stateAt ? now() - stateAt : null,
        stale: !client.connected || !subscribed || !stateAt || now() - stateAt > STALE_MS,
        last_ack: lastAck, history,
        streams: Object.fromEntries(Object.entries(streams).map(([type, row]) => [type, {
            age_ms: now() - row.received_at,
            stale: !client.connected || now() - row.received_at > STALE_MS
        }]))
    });
    const broadcast = (event) =>
    {
        const text = JSON.stringify(event);
        let sent = 0;
        let skipped = 0;
        for (const socket of wss.clients)
        {
            if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 100000)
            {
                socket.send(text, error =>
                {
                    if (error && event.type === 'ack')
                    {
                        trace('ACK_WS_ERROR', { command_id: event.data.command_id, error: error.message });
                    }
                });
                ++sent;
            }
            else
            {
                ++skipped;
            }
        }
        return { sent, skipped };
    };
    client.on('connect', () =>
    {
        const generation = ++connection;
        subscribed = false;
        trace('MQTT_CONNECTED', { connection, ...mqttConfig, remote_address: client.stream?.remoteAddress ?? null, keepalive_s: client.options.keepalive });
        trace('MQTT_SUBSCRIBE', { topics, qos: 1, connection });
        client.subscribe(topics, { qos: 1 }, (error, grants) =>
        {
            if (generation !== connection || !client.connected)
            {
                return;
            }
            subscribed = !error && grants?.length === 4 && grants.every(grant => grant.qos !== 128);
            trace('MQTT_SUBACK', { connection, ready: subscribed, error: error?.code ?? null, grants });
            broadcast({ type: 'snapshot', data: snapshot() });
        });
        broadcast({ type: 'snapshot', data: snapshot() });
    });
    client.on('error', error => trace('MQTT_ERROR', { error: error.message }));
    client.on('reconnect', () => trace('MQTT_RECONNECT', { connection }));
    const discardCommands = reason =>
    {
        for (const messageId of inflight)
        {
            client.removeOutgoingMessage(messageId);
        }
        inflight.clear();
        for (const [id, record] of pending)
        {
            record.cancelled = reason;
            trace('COMMAND_CANCELLED', { command_id: id, reason });
        }
        pending.clear();
    };
    const invalidate = () =>
    {
        spectrum.reset('MQTT mất kết nối');
        stateAt = 0;
        subscribed = false;
        trace('MQTT_CLOSED', { connection, reason: 'transport_closed_or_broker_disconnect' });
        discardCommands('mqtt_disconnect');
        broadcast({ type: 'snapshot', data: snapshot() });
    };
    client.on('close', invalidate);
    client.on('packetsend', packet =>
    {
        if (packet.cmd === 'publish' && packet.topic === `${prefix}/cmd/motor`)
        {
            inflight.add(packet.messageId);
        }
    });
    client.on('packetreceive', packet =>
    {
        if (packet.cmd === 'puback')
        {
            inflight.delete(packet.messageId);
        }
    });
    client.on('message', (topic, bytes, packet) =>
    {
        const type = topicTypes.get(topic);
        let data;
        const metadata = { topic: topic.slice(0, 256), bytes: bytes.length, qos: packet.qos, retain: !!packet.retain };
        ingest.received++;
        ingest.last_message = { ...metadata, at: now() };
        sampledTrace('MQTT_MESSAGE_RX', metadata, `rx/${type ?? 'unknown'}`);
        const drop = reason => {
            ingest.dropped++;
            const reasonKey = Object.hasOwn(ingest.drop_reasons, reason) || Object.keys(ingest.drop_reasons).length < 32 ? reason : 'other';
            ingest.drop_reasons[reasonKey] = (ingest.drop_reasons[reasonKey] ?? 0) + 1;
            ingest.last_drop = { ...metadata, reason, at: now() };
            const details = {
            ...metadata, type, reason,
            command_id: typeof data?.command_id === 'string' ? data.command_id.slice(0, 64) : null,
            boot_id: typeof data?.boot_id === 'string' ? data.boot_id.slice(0, 64) : null,
            seq: Number.isSafeInteger(data?.seq) ? data.seq : null,
            age_ms: commands.has(data?.command_id) ? now() - commands.get(data.command_id).created_at : null
            };
            // Preserve per-command ACK traces; sample only high-rate telemetry diagnostics.
            if (type === 'ack') trace('ACK_DROP', details);
            else sampledTrace('INGEST_DROP', details, `drop/${type ?? 'unknown'}`);
        };
        if (!type) { drop('unexpected_topic'); return; }
        if (bytes.length > 8192 || packet.retain)
        {
            drop(packet.retain ? 'retained_replay' : 'payload_too_large');
            return;
        }
        try
        {
            data = JSON.parse(bytes.toString());
        }
        catch
        {
            drop('invalid_json');
            return;
        }
        if (type === 'ack')
        {
            trace('ACK_RX', { command_id: typeof data?.command_id === 'string' ? data.command_id.slice(0, 64) : null,
                boot_id: typeof data?.boot_id === 'string' ? data.boot_id.slice(0, 64) : null,
                seq: Number.isSafeInteger(data?.seq) ? data.seq : null,
                t_device_ms: Number.isSafeInteger(data?.t_device_ms) ? data.t_device_ms : null,
                command_t_device_ms: Number.isSafeInteger(data?.command_t_device_ms) ? data.command_t_device_ms : null,
                lease_until_device_ms: Number.isSafeInteger(data?.lease_until_device_ms) ? data.lease_until_device_ms : null,
                bytes: bytes.length, qos: packet.qos });
        }
        // Optional timestamped batches share the vibration topic; legacy packets keep their schema.
        if (type === 'telemetry/vibration' && data?.samples !== undefined)
        {
            if (!client.connected || !subscribed || !stateAt || now() - stateAt > STALE_MS ||
                data.schema_version !== 1 || data.device_id !== 'rg01' || data.boot_id !== state?.boot_id || retiredBoots.has(data.boot_id) ||
                !Number.isFinite(data.samples?.at(-1)?.t_ms) || Math.abs(data.samples.at(-1).t_ms - state.t_device_ms) > STALE_MS)
            {
                drop('batch_wrong_boot_or_stale_state');
                return;
            }
            try { spectrum.ingest(data); } catch (error) { spectrum.reset(error.message); drop(error.message); }
            return;
        }
        if (!validPayload(type, data) || retiredBoots.has(data.boot_id))
        {
            drop(!validPayload(type, data) ? 'invalid_schema_or_payload' : 'retired_boot');
            return;
        }
        if (type !== 'state' && data.boot_id !== state?.boot_id)
        {
            drop('wrong_current_boot');
            return;
        }
        const record = type === 'ack' ? pending.get(data.command_id) : null;
        if (type === 'ack' && (!record || record.boot_id !== data.boot_id || now() - record.created_at > 5000))
        {
            const known = commands.get(data.command_id);
            if (record && record.boot_id === data.boot_id && now() - record.created_at > 5000 && !record.ack_rejection)
            {
                // Diagnostic only: a late ACK must never authorize renew or become an accepted ACK.
                record.ack_rejection = { reason: 'ack_wall_timeout', received_at: now(), age_ms: now() - record.created_at };
            }
            drop(!record ? known?.cancelled ? `command_cancelled_${known.cancelled}` : known?.acked ? 'duplicate_ack' : 'unknown_command' :
                record.boot_id !== data.boot_id ? 'wrong_command_boot' : 'ack_wall_timeout');
            return;
        }
        if (type === 'state' && state && data.boot_id !== state.boot_id)
        {
            spectrum.reset('Thiết bị khởi động lại');
            retiredBoots.add(state.boot_id);
            if (retiredBoots.size > 32)
            {
                retiredBoots.delete(retiredBoots.values().next().value);
            }
            history = [];
            streams = {};
            timing = null;
            lastAck = null;
            discardCommands('boot_changed');
        }
        const key = `${type}/${data.boot_id}`;
        const previous = accepted.get(key);
        if (previous && (data.seq <= previous.seq || ((data.t_device_ms - previous.time) | 0) < 0))
        {
            drop(data.seq <= previous.seq ? 'duplicate_or_old_seq' : 'device_clock_regressed');
            return;
        }
        accepted.set(key, { seq: data.seq, time: data.t_device_ms });
        if (accepted.size > 64)
        {
            accepted.delete(accepted.keys().next().value);
        }
        const event = { type, data, received_at: now() };
        if (type === 'state')
        {
            if (state && state.boot_id === data.boot_id && lastStateReceivedAt)
            {
                const wall = now() - lastStateReceivedAt;
                const device = (data.t_device_ms - state.t_device_ms) >>> 0;
                if (wall > 2000 && device > 0 && wall > device * 5)
                {
                    timing = { wall_gap_ms: wall, device_gap_ms: device, observed_at: now() };
                    trace('TIMING_GAP', { ...timing, reason: 'slow_simulation_pause_or_network_delay_not_distinguished' });
                    event.timing = timing;
                }
            }
            state = data;
            stateAt = now();
            lastStateReceivedAt = now();
            sampledTrace('STATE_ACCEPT', { ...metadata, boot_id: data.boot_id, seq: data.seq, t_device_ms: data.t_device_ms });
        }
        if (type === 'ack')
        {
            lastAck = data;
            record.acked = true;
            record.ack = data;
            record.ack_received_at = event.received_at;
            trace('ACK_ACCEPT', { command_id: data.command_id, boot_id: data.boot_id,
                age_ms: now() - record.created_at, accepted: data.accepted, running: data.running });
            pending.delete(data.command_id);
        }
        if (type.startsWith('telemetry/'))
        {
            streams[type] = event;
            history.push(event);
            history = history.slice(-240);
        }
        if (log.writableLength < 1000000)
        {
            log.write(JSON.stringify(event) + '\n');
        }
        const delivered = broadcast(event);
        ingest.accepted[type] = (ingest.accepted[type] ?? 0) + 1;
        if (type !== 'ack') sampledTrace('WS_BROADCAST', { type, boot_id: data.boot_id, seq: data.seq, ...delivered }, `ws/${type}`);
        if (type === 'ack')
        {
            trace('ACK_WS_SEND', { command_id: data.command_id, ...delivered });
        }
    });
    wss.on('connection', socket => socket.send(JSON.stringify({ type: 'snapshot', data: snapshot() })));
    app.use((req, res, next) =>
    {
        const origin = req.get('origin');
        if (!allowedOrigin(origin))
        {
            return res.status(403).json({ error: 'Origin rejected' });
        }
        next();
    });
    app.use(express.json({ limit: '4kb' }));
    app.get('/api/state', (req, res) => res.json(snapshot()));
    app.get('/api/spectrum', (req, res) => res.json(spectrum.snapshot()));
    app.post('/api/spectrum/config', (req, res) => { spectrum.save(req.body); res.json(spectrum.snapshot()); });
    app.post('/api/spectrum/restore', (req, res) => { spectrum.restore(); res.json(spectrum.snapshot()); });
    app.post('/api/spectrum/calibration', (req, res) => {
        if (req.body?.action === 'confirm_baseline') spectrum.confirmBaseline();
        else spectrum.startCapture(req.body?.action);
        res.json(spectrum.snapshot());
    });
    // Explicit opt-in synthetic demo: analysis only, never publishes a motor command.
    let demoNextTime = 0;
    app.post('/api/spectrum/demo', (req, res) => {
        const { frequency, amplitude, mode = 'steady' } = req.body ?? {};
        if (!Number.isFinite(frequency) || frequency <= 0 || frequency >= 90 || !Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 10 || !['steady','ringdown','forced'].includes(mode)) throw new Error('Thông số demo sai');
        const start = Math.max(now(), demoNextTime);
        demoNextTime = start + 2560;
        for (let offset=0; offset<512; offset+=32) spectrum.ingest({
            source:'synthetic', boot_id:'explicit-demo', seq:start+offset, unit:'m/s2', axis:'ax', quality:'valid',
            sample_rate:200, sensorPosition:'DEMO', rulerLength:300, mode,
            samples:Array.from({length:32},(_,j)=>{const i=offset+j,t=(start+i*5)/1000;return {t_ms:start+i*5,value:amplitude*Math.sin(2*Math.PI*frequency*t)*(mode==='ringdown'?Math.exp(-i/180):1)};})
        });
        res.json(spectrum.snapshot());
    });
    app.get('/api/commands/:id', (req, res) =>
    {
        const record = commands.get(req.params.id);
        res.status(record ? 200 : 404).json(record ?? { error: 'Command not in recent 100 records; inspect diagnostics JSONL' });
    });
    app.post('/api/motor', (req, res) =>
    {
        const { action, duty } = req.body ?? {};
        if (!['start', 'stop', 'renew', 'set_duty'].includes(action) ||
            (action !== 'stop' && (!Number.isFinite(duty) || duty < 0 || duty > 0.8)))
        {
            return res.status(400).json({ error: 'Invalid action or duty (0..0.8)' });
        }
        if (!client.connected || !subscribed)
        {
            return res.status(503).json({ error: 'Broker offline or subscriptions not ready' });
        }
        if (action !== 'stop' && (!stateAt || now() - stateAt > STALE_MS))
        {
            return res.status(409).json({ error: 'Device state missing or stale' });
        }
        const command = {
            schema_version: 1, device_id: 'rg01', source: 'synthetic',
            boot_id: state?.boot_id ?? '', command_id: randomUUID(),
            action, duty: action === 'stop' ? 0 : duty,
            lease_ms: 4000,
            not_after_device_ms: ((state?.t_device_ms ?? 0) + 3000) >>> 0
        };
        const record = { command_id: command.command_id, action, duty: command.duty, boot_id: command.boot_id, created_at: now(), trace: [] };
        pending.set(command.command_id, record);
        commands.set(command.command_id, record);
        trace('COMMAND_TX', { command_id: command.command_id, boot_id: command.boot_id,
            action, duty: command.duty, pwm_requested: Math.round(command.duty * 255), device_deadline_ms: command.not_after_device_ms, lease_ms: command.lease_ms });
        while (commands.size > 100)
        {
            commands.delete(commands.keys().next().value);
        }
        while (pending.size > 100)
        {
            pending.delete(pending.keys().next().value);
        }
        client.publish(`${prefix}/cmd/motor`, JSON.stringify(command), { qos: 1, retain: false }, error =>
        {
            if (error)
            {
                trace('COMMAND_PUBLISH_ERROR', { command_id: command.command_id, error: error.message });
            }
            else
            {
                trace('COMMAND_BROKER_PUBACK', { command_id: command.command_id });
            }
        });
        res.status(202).json({ status: 'sent_waiting_for_device_ack', command_id: command.command_id });
    });
    app.use(express.static('dist'));
    app.use((error, req, res, next) => res.status(400).json({ error: error.message }));
    return {
        server, client,
        async close()
        {
            for (const socket of wss.clients)
            {
                socket.terminate();
            }
            wss.close();
            await client.endAsync(true);
            await new Promise(resolve => log.end(resolve));
            await new Promise(resolve => diagnostics.end(resolve));
            await new Promise(resolve => server.close(resolve));
        }
    };
}

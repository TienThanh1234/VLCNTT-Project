import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { WebSocket } from 'ws';
import { createDemo } from '../server/app.js';

// Isolated namespace only. Never calls /api/motor or publishes commands.
const prefix = `rg-demo/ingest-probe-${randomUUID()}/rg01`;
const url = process.env.MQTT_URL ?? 'mqtt://broker.hivemq.com:1883';
const directory = await mkdtemp(join(tmpdir(), 'rg-public-ingest-'));
const trace = [];
const demo = createDemo({ url, prefix, logDirectory: directory, onTrace: row => { if (trace.length < 30) trace.push(row.stage); } });
const sender = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 10000 });
const abort = AbortSignal.timeout(25000);
let socket;
const onError = () => {};
sender.on('error', onError);
async function until(check) {
    for (let i = 0; i < 150; i++) {
        abort.throwIfAborted();
        if (await check()) return;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('No matching backend event before deadline');
}
try {
    await Promise.all([once(sender, 'connect', { signal: abort }), once(demo.client, 'connect', { signal: abort })]);
    demo.server.listen(0, '127.0.0.1');
    await once(demo.server, 'listening', { signal: abort });
    const base = `http://127.0.0.1:${demo.server.address().port}`;
    const snapshot = async () => (await fetch(`${base}/api/state`, { signal: abort })).json();
    await until(async () => (await snapshot()).broker_subscribed);
    socket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    const messages = [];
    socket.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
    await once(socket, 'open', { signal: abort });
    const envelope = { schema_version: 1, device_id: 'rg01', source: 'synthetic', boot_id: 'isolated-node-fixture', t_device_ms: 1000 };
    const send = (type, data) => sender.publishAsync(`${prefix}/${type}`, JSON.stringify({ ...envelope, ...data }), { qos: 1, retain: false });
    await send('state', { seq: 1, running: false, duty: 0 });
    await until(async () => (await snapshot()).state?.seq === 1);
    await send('telemetry/vibration', { seq: 2, unit: 'm/s2', quality: 'wokwi_i2c', ax: 0, ay: 0, az: 9.80665 });
    await send('telemetry/rpm', { seq: 3, rpm: null, ppr: 1, pulses: 0, quality: 'no_recent_pulses' });
    await send('state', { seq: 4, running: false, duty: 0 });
    await until(async () => (await snapshot()).state?.seq === 4 && messages.some(m => m.type === 'telemetry/rpm') && messages.some(m => m.type === 'telemetry/vibration'));
    const result = await snapshot();
    assert.equal(result.stale, false);
    assert.equal(result.mqtt_ingest.dropped, 0);
    console.log(JSON.stringify({ result: 'PASS', source: 'synthetic isolated Node publisher', prefix, mqtt_config: result.mqtt_config,
        state_seq: result.state.seq, stale: result.stale, streams: Object.keys(result.streams), received: result.mqtt_ingest.received,
        websocket_types: [...new Set(messages.map(m => m.type))], motor_commands_sent: 0 }));
    console.log('LIMIT: verifies public MQTT → backend → REST/WS; does not verify Wokwi/ESP32 or ACK from firmware.');
} catch (error) {
    console.error(JSON.stringify({ result: 'FAIL', code: error.code ?? error.name, reason: 'Public ingest roundtrip unavailable', stages: trace }));
    process.exitCode = 1;
} finally {
    socket?.terminate();
    await sender.endAsync(true);
    await demo.close();
    await rm(directory, { recursive: true, force: true });
}

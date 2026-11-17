import mqtt from 'mqtt';
import { validPayload } from '../server/protocol.js';
import { lookup } from 'node:dns/promises';

// Read-only probe: never publishes on any topic, including cmd/motor.
const prefix = process.env.MQTT_PREFIX;
if (!prefix || /[+#]/.test(prefix)) throw new Error('MQTT_PREFIX missing/invalid');
const broker = new URL(process.env.OBSERVE_URL ?? process.env.MQTT_URL ?? 'mqtt://broker.hivemq.com:1883');
const addresses = await lookup(broker.hostname, { all: true, family: 4 });
await Promise.all(addresses.map(({address}) => new Promise(resolve => {
const target = new URL(broker); target.hostname = address;
const client = mqtt.connect(target.href, { reconnectPeriod: 0, connectTimeout: 10000, resubscribe: false });
let received = 0;
const timer = setTimeout(() => { console.log(JSON.stringify({ stage: 'OBSERVE_DONE', received })); client.end(true); }, 20000);
client.on('error', error => console.log(JSON.stringify({ stage: 'OBSERVE_ERROR', code: error.code ?? 'mqtt_error' })));
client.on('connect', () => {
    console.log(JSON.stringify({ stage: 'OBSERVE_CONNECTED', host: broker.hostname, port: broker.port || 1883, prefix, remote: client.stream.remoteAddress }));
    const namespace = prefix.endsWith('/rg01') ? prefix.slice(0, -5) : prefix;
    client.subscribe(`${namespace}/#`, { qos: 1 }, (error, grants) => console.log(JSON.stringify({ stage: 'OBSERVE_SUBACK', remote:address, ok: !error && grants?.every(g => g.qos !== 128), grants })));
});
client.on('message', (topic, bytes, packet) => {
    received++;
    if (received > 12) return;
    let data;
    try { data = JSON.parse(bytes.toString()); } catch {}
    console.log(JSON.stringify({ stage: 'OBSERVE_RX', remote:address, topic, bytes: bytes.length, qos: packet.qos, retain: packet.retain,
        valid: validPayload(topic.slice(prefix.length + 1), data), boot_id: data?.boot_id, seq: data?.seq,
        source: data?.source, schema_version: data?.schema_version, device_id: data?.device_id,
        t_device_ms: data?.t_device_ms, quality: data?.quality, stop_reason: data?.stop_reason }));
});
client.on('close', () => { clearTimeout(timer); console.log(JSON.stringify({ stage:'OBSERVE_CLOSED',remote:address,received })); resolve(); });
})));

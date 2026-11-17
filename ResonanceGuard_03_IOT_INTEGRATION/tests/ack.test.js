import test from 'node:test';
import assert from 'node:assert/strict';
import { AckBuffer, ControlSession, ConnectionHealth, commandFeedback } from '../web/src/control.js';

const ack = (id = 'command') => ({ command_id: id, boot_id: 'boot', accepted: true, running: true, reason: 'command_accepted_wait_for_rpm', seq: 3 });
const register = (s, id = 'command', at = 1000) => s.register(id, 'start', false, s.epoch, at, 'boot');

test('ACK before HTTP registration is buffered, matched once, and arms only a healthy current session', () => {
    const s = new ControlSession(), inbox = new AckBuffer();
    inbox.put(ack(), s.epoch, 1010);
    assert.equal(s.acknowledge(ack(), true, 1010), null);
    register(s);
    const early = inbox.take('command', s.epoch, 1020);
    assert.ok(s.acknowledge(early, true, 1020));
    assert.equal(s.pending.size, 0);
    assert.equal(s.active, true);
    assert.equal(inbox.take('command', s.epoch, 1020), null);
});

test('ACK after HTTP response completes pending; duplicate ACK cannot toggle state or create a timeout', () => {
    const s = new ControlSession(); register(s);
    assert.ok(s.acknowledge(ack(), true, 1100));
    assert.equal(s.acknowledge(ack(), false, 1200), null);
    assert.equal(s.lastAckDecision, 'duplicate_ack');
    assert.equal(s.active, true);
    assert.equal(s.pending.size, 0);
});

test('true 5-second timeout, rejected ACK, wrong boot and stale connection never arm renew', () => {
    for (const [payload, healthy, now] of [[ack(),true,6001],[ack(),false,1100],[{...ack(),accepted:false},true,1100],[{...ack(),running:false},true,1100],[{...ack(),boot_id:'other'},true,1100]]) {
        const s = new ControlSession(); register(s);
        s.acknowledge(payload, healthy, now);
        assert.equal(s.active, false);
    }
    const s = new ControlSession(); register(s);
    s.disarm();
    assert.equal(s.acknowledge(ack(), true, 1200), null);
    assert.equal(s.active, false);
});

test('disconnect/STOP invalidate delayed HTTP, buffered ACK and recovered ACK; reconnect requires new START', () => {
    const s = new ControlSession(), inbox = new AckBuffer();
    const oldEpoch = s.epoch; inbox.put(ack(), oldEpoch, 1010);
    s.disarm(); inbox.clear();
    assert.equal(s.register('command','start',false,oldEpoch,1000,'boot'),false);
    assert.equal(inbox.take('command',s.epoch,1020),null);
    assert.equal(s.acknowledge(ack(),true,1020),null);
    s.register('renew','renew',true,s.epoch,1030,'boot');
    s.acknowledge(ack('renew'),true,1040);
    assert.equal(s.active,false);
    register(s,'new-start',1050);
    s.acknowledge(ack('new-start'),true,1060);
    assert.equal(s.active,true);
});

test('early ACK buffer has capacity, TTL, epoch isolation and duplicate does not extend TTL', () => {
    const inbox = new AckBuffer();
    for(let i=0;i<100;i++) inbox.put(ack(String(i)),0,1000);
    assert.equal(inbox.rows.size,50);
    assert.equal(inbox.take('0',0,1100),null);
    assert.equal(inbox.take('99',1,1100),null);
    inbox.put(ack('ttl'),0,1000); inbox.put(ack('ttl'),0,5900);
    assert.equal(inbox.take('ttl',0,6001),null);
});

test('GET recovery requires actual timely backend-accepted ACK; PUBACK/trace alone cannot synthesize it', () => {
    const record={command_id:'command',boot_id:'boot',created_at:1000,acked:true,ack:ack(),ack_received_at:1100};
    assert.equal(commandFeedback(record,'command','boot').kind,'ack');
    for(const patch of [{acked:false},{ack:null},{cancelled:'mqtt_disconnect'},{ack_received_at:6001},{ack_received_at:999},{ack:{...ack(),boot_id:'other'}}])
        assert.equal(commandFeedback({...record,...patch},'command','boot').kind,'unknown');
    assert.equal(commandFeedback({...record,command_id:'other'},'command','boot').kind,'unknown');
    assert.equal(commandFeedback({command_id:'command',boot_id:'boot',trace:[{stage:'COMMAND_BROKER_PUBACK'}]},'command','boot').kind,'unknown');
    assert.equal(commandFeedback({command_id:'command',boot_id:'boot',trace:[{stage:'ACK_ACCEPT',accepted:true,running:true}]},'command','boot').kind,'unknown');
    assert.deepEqual(commandFeedback({command_id:'command',boot_id:'boot',ack_rejection:{reason:'ack_wall_timeout',age_ms:7924}},'command','boot'),{kind:'late',age:7924});
});

test('recovered ACK after UI timeout remains diagnostic and cannot arm an expired pending request', () => {
    const s = new ControlSession(); register(s);
    const feedback=commandFeedback({command_id:'command',boot_id:'boot',created_at:1000,acked:true,ack:ack(),ack_received_at:2000},'command','boot');
    assert.equal(feedback.kind,'ack');
    assert.equal(s.acknowledge(feedback.ack,true,6001),null);
    assert.equal(s.active,false);
    s.disarm();assert.equal(s.acknowledge(feedback.ack,true,6100),null);
});

test('health updates in WS callbacks; stale/disconnected state never counts as healthy', () => {
    const health=new ConnectionHealth();health.ws=true;
    health.snapshot({broker_connected:true,broker_subscribed:true,state_age_ms:0},1000);
    assert.equal(health.healthy(1000),true);assert.equal(health.healthy(5001),false);
    health.state(5100);assert.equal(health.healthy(5100),true);
    health.ws=false;assert.equal(health.healthy(5100),false);
});

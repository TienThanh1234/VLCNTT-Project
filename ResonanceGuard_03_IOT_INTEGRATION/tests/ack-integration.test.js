import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqtt from 'mqtt';
import aedes from 'aedes';
import { WebSocket } from 'ws';
import { createDemo } from '../server/app.js';
import { AckBuffer, ControlSession, commandFeedback } from '../web/src/control.js';
import { SpectrumMonitor, analyze } from '../server/spectrum.js';

async function until(check) {for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Timed out');}
async function fixture(t, delayHttpMs = 0) {
    const broker=aedes(), tcp=net.createServer(broker.handle);tcp.listen(0,'127.0.0.1');await once(tcp,'listening');
    const directory=await mkdtemp(join(tmpdir(),'rg-ack-regression-'));
    let wall=1000000;
    const traces=[], prefix='rg-test/ack-local/rg01', url=`mqtt://127.0.0.1:${tcp.address().port}`;
    const demo=createDemo({url,prefix,logDirectory:directory,now:()=>wall,onTrace:r=>traces.push(r)}), peer=mqtt.connect(url,{reconnectPeriod:0});
    let ws;
    t.after(async()=>{ws?.terminate();await peer.endAsync(true);await demo.close();await new Promise(r=>tcp.close(r));await new Promise(r=>broker.close(r));await rm(directory,{recursive:true,force:true});});
    await Promise.all([once(peer,'connect'),once(demo.client,'connect')]);await peer.subscribeAsync(`${prefix}/cmd/motor`);
    demo.server.listen(0,'127.0.0.1');await once(demo.server,'listening');const base=`http://127.0.0.1:${demo.server.address().port}`;
    if (delayHttpMs) demo.server.prependListener('request', (req, res) => {
        if (req.method === 'POST' && req.url === '/api/motor') {
            const end = res.end;
            res.end = function(...args) { setTimeout(() => end.apply(res, args), delayHttpMs); return res; };
        }
    });
    const snapshot=async()=> (await fetch(`${base}/api/state`)).json();await until(async()=>(await snapshot()).broker_subscribed);
    ws=new WebSocket(base.replace('http:','ws:')+'/ws');const events=[];ws.on('message',b=>events.push(JSON.parse(b)));await once(ws,'open');
    const send=(type,data,options={qos:1,retain:false})=>peer.publishAsync(`${prefix}/${type}`,JSON.stringify({schema_version:1,device_id:'rg01',source:'synthetic',boot_id:'boot',t_device_ms:1000,...data}),options);
    const post=async(action='start',duty=.3)=>{const r=await fetch(base+'/api/motor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,duty})});return {...await r.json(),httpStatus:r.status};};
    const record=async id=>(await fetch(`${base}/api/commands/${id}`)).json();
    await send('state',{seq:1,running:false,duty:0});await until(async()=>(await snapshot()).state?.seq===1);
    return {demo,peer,base,send,post,record,snapshot,events,traces,tick:ms=>{wall+=ms;},time:()=>wall};
}

test('local MQTT: ACK may precede HTTP consumption; accepted ACK persists for recovery and repeat is idempotent', {timeout:10000},async t=>{
    const f=await fixture(t, 300), inbox=new AckBuffer(), session=new ControlSession();
    const outgoing=once(f.peer,'message');
    let httpReturned=false;
    const responsePromise=f.post().then(response=>{httpReturned=true;return response;});
    const [,bytes]=await outgoing, command=JSON.parse(bytes);
    assert.equal(command.duty,.3);assert.equal(Math.round(command.duty*255),77);
    await f.send('ack',{seq:2,command_id:command.command_id,accepted:true,running:true,reason:'fixture_ack'});
    await until(()=>f.events.some(r=>r.type==='ack'));
    const event=f.events.find(r=>r.type==='ack');
    assert.equal(httpReturned,false,'real HTTP response must still be delayed when WS ACK arrives');
    inbox.put(event.data,session.epoch,1001);
    const response=await responsePromise;
    assert.equal(response.httpStatus,202);assert.equal(response.command_id,command.command_id);
    session.register(response.command_id,'start',false,session.epoch,1000,'boot');
    assert.ok(session.acknowledge(inbox.take(response.command_id,session.epoch,1002),true,1002));
    assert.equal(session.active,true);
    const saved=await f.record(command.command_id);
    assert.equal(saved.duty,.3);assert.equal(saved.trace.find(r=>r.stage==='COMMAND_TX').pwm_requested,77);
    assert.equal(commandFeedback(saved,command.command_id,'boot').kind,'ack');assert.deepEqual(saved.ack,event.data);
    await f.send('ack',event.data);await until(()=>f.traces.some(r=>r.stage==='ACK_DROP'&&r.reason==='duplicate_ack'));
    assert.equal(f.events.filter(r=>r.type==='ack').length,1);
    assert.equal((await f.record(command.command_id)).ack_received_at,saved.ack_received_at);
    assert.equal(f.traces.filter(r=>r.stage==='COMMAND_TX').length,1);
    const missedWs=new ControlSession();missedWs.register(command.command_id,'start',false,0,1000,'boot');
    missedWs.acknowledge(commandFeedback(saved,command.command_id,'boot').ack,true,1100);
    assert.equal(missedWs.active,true);assert.equal(missedWs.pending.size,0);
});

test('local MQTT: observed 7924ms/9692ms ACKs remain timed out; repeat and PUBACK never authorize renew', {timeout:10000},async t=>{
    const f=await fixture(t);const command=await f.post();
    const payload={seq:2,command_id:command.command_id,accepted:true,running:true,reason:'late_fixture_ack'};
    f.tick(7924);await f.send('ack',payload);await until(()=>f.traces.some(r=>r.stage==='ACK_DROP'));
    f.tick(1768);await f.send('ack',payload);await until(()=>f.traces.filter(r=>r.stage==='ACK_RX').length===2);
    const record=await f.record(command.command_id);
    assert.equal(record.acked,undefined);assert.equal(record.ack,undefined);
    assert.deepEqual(record.ack_rejection,{reason:'ack_wall_timeout',received_at:1007924,age_ms:7924});
    assert.equal(commandFeedback(record,command.command_id,'boot').kind,'late');
    assert.deepEqual(record.trace.filter(r=>r.stage==='ACK_DROP').map(r=>r.age_ms),[7924,9692]);
    assert.equal(record.trace.some(r=>['ACK_ACCEPT','ACK_WS_SEND'].includes(r.stage)),false);
    assert.equal((await f.snapshot()).last_ack,null);
    assert.equal(f.events.filter(r=>r.type==='ack').length,0);
    assert.equal(f.traces.filter(r=>r.stage==='COMMAND_TX').length,1);
});

test('backend reports slow-simulation wall/device gap and only a new state clears stale', {timeout:10000}, async t => {
    const f=await fixture(t);
    f.tick(5158);
    let snapshot=await f.snapshot();
    assert.equal(snapshot.stale,true);
    assert.ok(snapshot.state_age_ms>=5158);
    await f.send('state',{seq:2,t_device_ms:2005,running:false,duty:0});
    await until(async()=>!(await f.snapshot()).stale);
    snapshot=await f.snapshot();
    assert.equal(snapshot.stale,false);
    assert.equal(snapshot.timing.wall_gap_ms,5158);
    assert.equal(snapshot.timing.device_gap_ms,1005);
});

test('local MQTT: ACK after registration, renew/STOP, boot/schema/sequence guards and reconnect remain safe', {timeout:12000},async t=>{
    const f=await fixture(t);let seq=2;
    for(const action of ['start','renew','stop']) {
        const command=await f.post(action);assert.equal(command.httpStatus,202);
        await f.send('ack',{seq:seq++,command_id:command.command_id,accepted:true,running:action!=='stop',reason:'fixture_ack'});
        await until(async()=>(await f.record(command.command_id)).acked===true);
    }
    await f.send('telemetry/vibration',{seq:seq++,ax:0,ay:0,az:9.8,unit:'m/s2',quality:'wokwi_i2c'});
    await f.send('telemetry/rpm',{seq:seq++,rpm:null,ppr:1,pulses:0,quality:'no_recent_pulses'});
    await until(async()=>(await f.snapshot()).history.length===2);
    const other=await f.post();
    await f.send('ack',{seq:seq++,boot_id:'wrong',command_id:other.command_id,accepted:true,running:true,reason:'wrong_boot'});
    await until(()=>f.traces.some(r=>r.stage==='ACK_DROP'&&r.reason==='wrong_current_boot'));
    await f.send('ack',{seq:seq++,source:'measured_live',command_id:other.command_id,accepted:true,running:true,reason:'wrong_source'});
    await until(()=>f.traces.some(r=>r.stage==='ACK_DROP'&&r.reason==='invalid_schema_or_payload'));
    assert.equal((await f.record(other.command_id)).acked,undefined);
    const closed=once(f.demo.client,'close');f.demo.client.stream.destroy();await closed;
    assert.equal((await f.snapshot()).stale,true);
    assert.equal((await f.post()).httpStatus,503);
    await once(f.demo.client,'connect');await until(async()=>(await f.snapshot()).broker_subscribed);
    assert.equal((await f.post()).httpStatus,409);
    await f.send('state',{seq:seq++,t_device_ms:1100,running:false,duty:0});await until(async()=>!(await f.snapshot()).stale);
    const record=await f.record(other.command_id);assert.equal(record.cancelled,'mqtt_disconnect');
    await f.send('state',{seq:0,boot_id:'new-boot',t_device_ms:10,running:false,duty:0});await until(async()=>(await f.snapshot()).state.boot_id==='new-boot');
    assert.equal((await f.snapshot()).last_ack,null);
});

test('FFT 7Hz/RMS and confirmed baseline/config survive restart; synthetic and real remain separate',async t=>{
    const dir=await mkdtemp(join(tmpdir(),'rg-ack-fft-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    const raw=Array.from({length:512},(_,i)=>({t_ms:i*5,value:9.8+2*Math.sin(2*Math.PI*7*i/200)}));
    const result=analyze(raw);assert.ok(Math.abs(result.peak.hz-7)<=result.resolution);assert.ok(Math.abs(result.rms-2/Math.sqrt(2))<.02);
    const config={target:7,tolerance:1,normalMin:0,normalMax:15,normalRms:.3,alertRms:1,alertAmplitude:1,windows:3,cooldown:30,sampleRate:200};
    const monitor=new SpectrumMonitor(dir);monitor.save(config);monitor.startCapture('baseline');
    for(let i=0;i<512;i+=32)monitor.ingest({source:'synthetic',boot_id:'test',seq:i,unit:'m/s2',axis:'ax',mode:'steady',sample_rate:200,quality:'valid',sensorPosition:'tip',rulerLength:300,samples:raw.slice(i,i+32)});
    monitor.confirmBaseline();const reloaded=new SpectrumMonitor(dir);
    assert.deepEqual(reloaded.saved.config,config);assert.equal(reloaded.saved.baseline.raw.length,512);assert.equal(reloaded.saved.baseline.meta.source,'synthetic');
});

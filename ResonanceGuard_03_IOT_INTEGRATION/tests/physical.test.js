import test from 'node:test';
import assert from 'node:assert/strict';
import {physicalError} from '../server/physical-protocol.js';
import {freeDecay,aggregateDecay,compareBaseline} from '../server/analysis.js';
import {PhysicalControl} from '../server/physical-control.js';
const envelope={schema_version:2,device_id:'rg01',source:'measured',data_origin:'physical',boot_id:'test',seq:1,t_device_ms:1000};
test('physical RPM validates period, zero and unknown separately',()=>{
 const d={...envelope,unit:'rpm',ppr:2,pulses:10,period_us:50000,rpm:600,quality:'ok'};
 assert.equal(physicalError('telemetry/rpm',d),null);
 assert.ok(physicalError('telemetry/rpm',{...d,rpm:1200}));
 assert.equal(physicalError('telemetry/rpm',{...d,rpm:0,period_us:null,quality:'stopped'}),null);
 assert.ok(physicalError('telemetry/rpm',{...d,rpm:0,period_us:null,quality:'uninitialized'}));
});
test('free decay estimates known 7 Hz and rejects gap, flat and insufficient repeats',()=>{
 const raw=Array.from({length:1200},(_,i)=>({t_ms:i*5,value:9.8+2*Math.exp(-i/500)*Math.sin(2*Math.PI*7*i/200)}));
 const r=freeDecay(raw);assert.equal(r.valid,true);assert.ok(Math.abs(r.fd_est-7)<.1);
 assert.equal(freeDecay(raw.slice(1)).valid,true);
 assert.equal(freeDecay(raw.map((s,i)=>({...s,t_ms:s.t_ms+(i>500?5:0)}))).valid,false);
 assert.equal(freeDecay(raw.map(s=>({...s,value:9.8}))).valid,false);
 assert.equal(aggregateDecay([r,r,r,r]).fd_est,null);
 assert.ok(aggregateDecay([r,r,r,r,r]).fd_est);
 assert.equal(compareBaseline({fd_est:7,s:.01,u_min:.2},{fd_est:8}).changed,true);
});
test('physical control requires ARM ACK, nonce and live websocket; rejection revokes',()=>{
 let time=1000;const sent=[];
 const c=new PhysicalControl({now:()=>time,state:()=>({boot_id:'test',t_device_ms:1000,safety_ready:true,imu_ok:true}),secure:true,publish:r=>sent.push(r),save:()=>{}});
 const owner=c.socket({readyState:1});
 assert.throws(()=>c.request('start',.2,owner));
 const arm=c.request('arm',0,owner);
 assert.equal(c.acknowledge({...arm,accepted:true,running:false,nonce:'device-generated'}),true);
 const start=c.request('start',.2,owner);assert.equal(start.nonce,'device-generated');assert.equal(start.lease_ms,2000);
 assert.equal(c.acknowledge({...start,nonce:'wrong',accepted:true,running:true}),false);
 assert.equal(c.acknowledge({...start,accepted:false,running:false}),true);
 assert.equal(c.session,null);assert.equal(sent.at(-1).action,'stop');
 time+=2100;c.tick();assert.throws(()=>c.request('arm',0,owner));
});

// Version 2 is the physical instrument contract. Version 1 remains Wokwi-only.
export const id = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v);
const uint = v => Number.isSafeInteger(v) && v >= 0;
const range = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
export function physicalError(type, d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return 'payload';
    for (const [key, value] of Object.entries({schema_version:2, device_id:'rg01', source:'measured', data_origin:'physical'})) if(d[key]!==value) return key;
    if(!id(d.boot_id)) return 'boot_id';
    if(!uint(d.seq)) return 'seq';
    if(!uint(d.t_device_ms)) return 't_device_ms';
    if(type==='state') {
        if(typeof d.running!=='boolean') return 'running';
        if(!range(d.duty,0,.8)||(!d.running&&d.duty!==0)) return 'duty';
        if(!['OFF','ARMED','RUNNING','FAULT'].includes(d.phase)) return 'phase';
        if(d.running!==(d.phase==='RUNNING')) return 'phase/running';
        if(typeof d.safety_ready!=='boolean'||typeof d.imu_ok!=='boolean') return 'safety_ready/imu_ok';
        if(typeof d.stop_reason!=='string'||d.stop_reason.length>100) return 'stop_reason';
    } else if(type==='availability') {
        if(typeof d.online!=='boolean') return 'online';
    } else if(type==='ack') {
        if(!id(d.command_id)||!id(d.session_id)||!id(d.nonce)) return 'command_id/session_id/nonce';
        if(typeof d.accepted!=='boolean'||typeof d.running!=='boolean') return 'accepted/running';
        if(typeof d.reason!=='string'||!d.reason||d.reason.length>100) return 'reason';
    } else if(type==='telemetry/rpm') {
        if(d.unit!=='rpm') return 'unit';
        if(!Number.isInteger(d.ppr)||!range(d.ppr,1,1000)) return 'ppr';
        if(!uint(d.pulses)) return 'pulses';
        if(!['ok','stopped','no_recent_pulses','uninitialized'].includes(d.quality)) return 'quality';
        if(d.quality==='ok') {
            if(!range(d.rpm,.001,10000)||!range(d.period_us,1,60000000)) return 'rpm/period_us';
            if(Math.abs(d.rpm-60000000/d.period_us/d.ppr)>Math.max(.1,d.rpm*.02)) return 'rpm/period_us/ppr';
        } else if(d.quality==='stopped') {
            if(d.rpm!==0||d.period_us!==null) return 'rpm/period_us';
        } else if(d.rpm!==null||d.period_us!==null) return 'rpm/period_us';
    } else if(type==='telemetry/vibration') {
        if(d.unit!=='m/s2') return 'unit';
        if(!['ok','clipping','i2c_error'].includes(d.quality)) return 'quality';
        if(!['ax','ay','az'].every(k=>d.quality==='i2c_error'?d[k]===null:range(d[k],-4*9.80665,4*9.80665))) return 'ax/ay/az';
    } else if(type==='telemetry/vibration_block') {
        if(!id(d.run_id)||!id(d.config_id)) return 'run_id/config_id';
        if(d.unit!=='m/s2') return 'unit';
        if(!uint(d.block_seq)||!uint(d.t0_device_us)) return 'block_seq/t0_device_us';
        if(d.sample_period_us!==5000) return 'sample_period_us';
        if(!Array.isArray(d.samples)||d.samples.length<20||d.samples.length>40) return 'samples.length';
        for(let i=0;i<d.samples.length;i++) if(!Array.isArray(d.samples[i])||d.samples[i].length!==3||!d.samples[i].every(x=>range(x,-4*9.80665,4*9.80665))) return `samples[${i}]`;
        if(!d.quality||!['gap','clipping','fifo_overflow','i2c_error','missing_samples'].every(k=>typeof d.quality[k]==='boolean')) return 'quality';
        if(d.samples.some(s=>s.some(v=>Math.abs(v)>=39))&&!d.quality.clipping) return 'quality.clipping';
        const end=d.t0_device_us+(d.samples.length-1)*d.sample_period_us;
        if(end>d.t_device_ms*1000+5000||d.t_device_ms*1000-end>500000) return 't0_device_us/stale';
    } else return 'topic';
    return null;
}
export const cleanBlock = d => Object.values(d.quality).every(v=>v===false);
export function blockSamples(d, axis='ax') {
    const index=['ax','ay','az'].indexOf(axis);
    return d.samples.map((s,i)=>({t_ms:(d.t0_device_us+i*d.sample_period_us)/1000,value:s[index]}));
}

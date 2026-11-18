import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { id, blockSamples, cleanBlock } from './physical-protocol.js';
import { ALGORITHM_VERSION, freeDecay, aggregateDecay, fitOneX, sweepEvidence, compareBaseline } from './analysis.js';
const fail=m=>{throw Error(m);};
const decode=row=>row?JSON.parse(row.json):null;
export class RunStore {
    constructor(directory,now=Date.now) {
        this.directory=directory;this.now=now;mkdirSync(join(directory,'raw'),{recursive:true});
        this.db=new DatabaseSync(join(directory,'resonanceguard.sqlite'));
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS mechanical_configs(id TEXT PRIMARY KEY,json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,config_id TEXT REFERENCES mechanical_configs(id),status TEXT NOT NULL,json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS analysis_results(id INTEGER PRIMARY KEY,run_id TEXT REFERENCES runs(id),version TEXT NOT NULL,json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS baselines(id TEXT PRIMARY KEY,json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,run_id TEXT,json TEXT NOT NULL);
          INSERT OR IGNORE INTO migrations VALUES(1);
          CREATE TRIGGER IF NOT EXISTS immutable_baseline_update BEFORE UPDATE ON baselines BEGIN SELECT RAISE(ABORT,'baseline immutable'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_baseline_delete BEFORE DELETE ON baselines BEGIN SELECT RAISE(ABORT,'baseline immutable'); END;`);
        for(const row of this.db.prepare("SELECT json FROM runs WHERE status='recording'").all()) {const r=decode(row);r.status='interrupted';r.reason='backend_restart';this.save(r);}
        this.active=null;
    }
    config(c) {
        if(!id(c?.id)||!['ax','ay','az'].includes(c.axis))fail('config.id/axis');
        for(const k of ['operator','sensor_position','mount','motor','power','firmware_version','comparison_group'])if(typeof c[k]!=='string'||!c[k].trim()||c[k].length>200)fail(`config.${k}`);
        for(const k of ['length_mm','width_mm','thickness_mm'])if(!Number.isFinite(c[k])||c[k]<=0)fail(`config.${k}`);
        for(const k of ['load_kg','load_position_mm'])if(!Number.isFinite(c[k])||c[k]<0)fail(`config.${k}`);
        if(c.sample_rate!==200||c.dlpf!==3||c.range_g!==4)fail('config.sensor_settings');
        this.db.prepare('INSERT INTO mechanical_configs VALUES(?,?)').run(c.id,JSON.stringify(c));return c;
    }
    configs(){return this.db.prepare('SELECT json FROM mechanical_configs').all().map(decode);}
    getConfig(key){return decode(this.db.prepare('SELECT json FROM mechanical_configs WHERE id=?').get(key));}
    create(input,state,rpm) {
        if(this.active)fail('another_run_recording');
        const c=this.getConfig(input.config_id);if(!c)fail('config_not_found');
        if(!['free_decay','forced_sweep','monitor'].includes(input.kind))fail('run.kind');
        if(!state||state.source!=='measured')fail('physical_state_required');
        if(input.kind==='free_decay'&&(state.running||rpm?.quality!=='stopped'))fail('motor_and_rotor_must_be_stopped');
        if(!['A','B','A_recovery'].includes(input.stage))fail('run.stage');
        const run={id:randomUUID(),kind:input.kind,config_id:c.id,source:state.source,boot_id:state.boot_id,stage:input.stage,intervention:input.intervention??null,
            status:'recording',started_at:this.now(),algorithm_version:ALGORITHM_VERSION,steps:[],issues:[],reference:input.kind==='forced_sweep'?this.estimate(c.id):null,
            force_assumptions_checked:input.force_assumptions_checked===true,blocks:0};
        this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(run.id,c.id,run.status,JSON.stringify(run));
        writeFileSync(this.rawPath(run.id),JSON.stringify({type:'metadata',run,config:c})+'\n',{flag:'wx'});
        this.active=run;return run;
    }
    rawPath(key){if(!id(key))fail('invalid_run_id');return join(this.directory,'raw',key+'.jsonl');}
    save(r){this.db.prepare('UPDATE runs SET status=?,json=? WHERE id=?').run(r.status,JSON.stringify(r),r.id);}
    list(){return this.db.prepare('SELECT json FROM runs ORDER BY rowid DESC LIMIT 500').all().map(decode);}
    get(key){return decode(this.db.prepare('SELECT json FROM runs WHERE id=?').get(key));}
    rows(key){if(!this.get(key))fail('run_not_found');return readFileSync(this.rawPath(key),'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}
    event(event,runId=this.active?.id??null){this.db.prepare('INSERT INTO events(run_id,json) VALUES(?,?)').run(runId,JSON.stringify(event));}
    command(r){this.db.prepare('INSERT INTO commands VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(r.command_id,JSON.stringify(r));}
    getCommand(key){return decode(this.db.prepare('SELECT json FROM commands WHERE id=?').get(key));}
    ingest(event) {
        const r=this.active;if(!r)return;
        const d=event.data;
        if(d.source!=='measured'||d.boot_id!==r.boot_id){this.issue('source_or_boot_changed');return;}
        if(event.type==='state'&&r.kind==='free_decay'&&d.running)this.issue('motor_running_in_free_decay');
        if(event.type==='telemetry/vibration_block'&&(d.run_id!==r.id||d.config_id!==r.config_id))return;
        appendFileSync(this.rawPath(r.id),JSON.stringify(event)+'\n');
        if(event.type==='telemetry/vibration_block'){
            r.blocks++;if(!cleanBlock(d))this.issue('block_quality');
            this.save(r);
        }
    }
    issue(reason){if(this.active&&!this.active.issues.includes(reason)){this.active.issues.push(reason);this.save(this.active);this.event({type:'quality',reason,at:this.now()});}}
    step(input,deviceTime) {
        const r=this.active;if(r?.kind!=='forced_sweep')fail('forced_sweep_required');
        if(!['up','down'].includes(input.direction)||![1,2].includes(input.repeat))fail('step.direction/repeat');
        if(!Number.isFinite(deviceTime))fail('device_time_required');
        const step={direction:input.direction,repeat:input.repeat,start_ms:deviceTime};
        if(r.steps.length&&deviceTime<=r.steps.at(-1).start_ms)fail('step_time_order');
        r.steps.push(step);this.save(r);this.event({type:'step',...step});return step;
    }
    finish(key) {
        const r=this.active;if(!r||r.id!==key)fail('run_not_recording');
        r.status='completed';r.ended_at=this.now();this.save(r);this.active=null;
        return {run:r,result:this.analyze(key)};
    }
    analyze(key) {
        const r=this.get(key);if(!r||r.status==='recording')fail('completed_run_required');
        const rows=this.rows(key),c=this.getConfig(r.config_id),blocks=rows.filter(e=>e.type==='telemetry/vibration_block');
        const samples=blocks.flatMap(e=>blockSamples(e.data,c.axis));
        const rpms=rows.filter(e=>e.type==='telemetry/rpm').map(e=>({...e.data,t_ms:e.data.t_device_ms}));
        const issues=[...r.issues];
        for(let i=1;i<blocks.length;i++)if(blocks[i].data.block_seq!==blocks[i-1].data.block_seq+1)issues.push('block_gap');
        let result;
        if(issues.length||r.status==='interrupted')result={valid:false,fd_est:null,status:'insufficient_data',reason:issues.join(',')||'interrupted'};
        else if(r.kind==='free_decay')result=freeDecay(samples);
        else if(r.kind==='forced_sweep') {
            const steps=r.steps.map((s,i)=>({...s,...fitOneX(samples.filter(p=>p.t_ms>=s.start_ms&&p.t_ms<(r.steps[i+1]?.start_ms??Infinity)),rpms)}));
            result=sweepEvidence(steps,true,r.reference,r.force_assumptions_checked);
        }else result={valid:samples.length>0,sample_count:samples.length};
        result={...result,algorithm_version:ALGORITHM_VERSION,analyzed_at:this.now(),source:r.source};
        this.db.prepare('INSERT INTO analysis_results(run_id,version,json) VALUES(?,?,?)').run(key,ALGORITHM_VERSION,JSON.stringify(result));return result;
    }
    results(key){return this.db.prepare('SELECT json FROM analysis_results WHERE run_id=? ORDER BY id').all(key).map(decode);}
    estimate(configId,runIds=null) {
        const runs=this.list().filter(r=>r.config_id===configId&&r.kind==='free_decay'&&r.status==='completed'&&(!runIds||runIds.includes(r.id)));
        return {...aggregateDecay(runs.map(r=>this.results(r.id).at(-1))),run_ids:runs.map(r=>r.id)};
    }
    baselines(){return this.db.prepare('SELECT json FROM baselines').all().map(decode);}
    baseline(input) {
        if(!Array.isArray(input.run_ids)||new Set(input.run_ids).size!==input.run_ids.length||input.run_ids.length<5)fail('requires_five_unique_baseline_runs');
        const runs=input.run_ids.map(key=>this.get(key));
        if(runs.some(r=>!r||r.stage!=='A'||r.config_id!==runs[0].config_id))fail('baseline_requires_same_config_A');
        const estimate=this.estimate(runs[0].config_id,input.run_ids);
        if(estimate.count!==runs.length||!estimate.fd_est)fail('baseline_requires_valid_repeatable_runs');
        if(!Number.isFinite(input.u_min)||input.u_min<=0)fail('baseline.u_min');
        const b={id:randomUUID(),version:1,created_at:this.now(),config_id:runs[0].config_id,source:runs[0].source,u_min:input.u_min,...estimate};
        this.db.prepare('INSERT INTO baselines VALUES(?,?)').run(b.id,JSON.stringify(b));return b;
    }
    compare(input) {
        const b=this.baselines().find(b=>b.id===input.baseline_id);if(!b)fail('baseline_not_found');
        if(!Array.isArray(input.run_ids)||input.run_ids.length<5||new Set(input.run_ids).size!==input.run_ids.length)fail('requires_five_unique_comparison_runs');
        const runs=input.run_ids.map(key=>this.get(key));
        if(runs.some(r=>!r||r.config_id!==runs[0].config_id||r.stage!==runs[0].stage||b.run_ids.includes(r.id)))fail('comparison_requires_new_same_stage_runs');
        const config=this.getConfig(runs[0].config_id),base=this.getConfig(b.config_id);
        const allowed=runs[0].stage==='B'&&runs.every(r=>['length_mm','load_kg'].includes(r.intervention)&&r.intervention===runs[0].intervention)?runs[0].intervention:null;
        for(const k of ['comparison_group','axis','sensor_position','mount','motor','power','sample_rate','dlpf','range_g','width_mm','thickness_mm','length_mm','load_kg','load_position_mm'])if(k!==allowed&&config[k]!==base[k])fail('incompatible_config:'+k);
        const estimate=this.estimate(config.id,input.run_ids);
        const previous=this.db.prepare("SELECT json FROM events WHERE run_id=? ORDER BY id DESC LIMIT 1").get('comparison:'+b.id);
        const result=compareBaseline(b,estimate,decode(previous)?.changed===true);
        const values=runs.map(r=>this.results(r.id).at(-1));
        if(result.changed&&!values.slice(-3).every(v=>v?.valid&&Math.abs(v.fd_est-b.fd_est)>result.threshold)){result.changed=false;result.status='awaiting_consecutive_evidence';}
        const row={...result,estimate,baseline_id:b.id,run_ids:input.run_ids,stage:runs[0].stage,intervention:allowed,confounded:runs[0].stage==='A_recovery'&&result.changed===true};
        this.event(row,'comparison:'+b.id);return row;
    }
    close(){this.db.close();}
}

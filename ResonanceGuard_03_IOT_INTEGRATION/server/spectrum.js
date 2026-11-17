import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const fail = message => { throw new Error(message); };
export function analyze(samples, mode = 'steady') {
    const n = samples.length;
    if (![512, 1024].includes(n)) fail('FFT cần 512 hoặc 1024 mẫu');
    if (!samples.every(s => Number.isFinite(s.t_ms) && Number.isFinite(s.value) && Math.abs(s.value) < 39)) fail('Mẫu sai hoặc clipping');
    const dt = (samples[n - 1].t_ms - samples[0].t_ms) / (n - 1);
    const fs = 1000 / dt;
    if (!(fs >= 20 && fs <= 1000) || samples.slice(1).some((s, i) => Math.abs(s.t_ms - samples[i].t_ms - dt) > dt * .1)) fail('Timestamp/gap/nhịp lấy mẫu không hợp lệ');
    const mean = samples.reduce((a, s) => a + s.value, 0) / n;
    const dynamic = samples.map(s => s.value - mean);
    const rms = Math.sqrt(dynamic.reduce((a, x) => a + x*x, 0) / n);
    const re = dynamic.map((x, i) => x * (mode === 'ringdown' ? 1 : .5 - .5*Math.cos(2*Math.PI*i/(n-1))));
    const im = Array(n).fill(0);
    const gain = mode === 'ringdown' ? n : (n-1)/2;
    // Radix-2 Cooley–Tukey, forward DFT sign convention exp(-j 2πkn/N).
    for (let i=1,j=0; i<n; i++) {
        let bit=n>>1;
        for (; j&bit; bit>>=1) j^=bit;
        j^=bit;
        if(i<j) [re[i],re[j]]=[re[j],re[i]];
    }
    for(let size=2;size<=n;size*=2) for(let start=0;start<n;start+=size) for(let j=0;j<size/2;j++) {
        const a=-2*Math.PI*j/size, k=start+j, l=k+size/2;
        const r=re[l]*Math.cos(a)-im[l]*Math.sin(a), v=re[l]*Math.sin(a)+im[l]*Math.cos(a);
        re[l]=re[k]-r; im[l]=im[k]-v; re[k]+=r; im[k]+=v;
    }
    const spectrum=Array.from({length:n/2+1},(_,k)=>({hz:k*fs/n, amplitude:Math.hypot(re[k],im[k])/gain*(k===0||k===n/2?1:2)}));
    const peaks=spectrum.filter((p,k)=>k>0&&k<spectrum.length-1&&p.amplitude>spectrum[k-1].amplitude&&p.amplitude>=spectrum[k+1].amplitude).sort((a,b)=>b.amplitude-a.amplitude).slice(0,8);
    const noise=[...spectrum.slice(1).map(p=>p.amplitude)].sort((a,b)=>a-b)[Math.floor(n/4)];
    return { n, fs, resolution:fs/n, duration:n/fs, nyquist:fs/2, rms, spectrum, peaks, noise,
        peak:peaks[0]??null, fd_est:mode==='ringdown'&&peaks[0]?.amplitude>Math.max(noise*6,1e-6)?peaks[0].hz:null,
        fn_est:null, mode, normalization:mode==='ringdown'?'rectangular; transient amplitude, not steady peak':'Hann; 2|FFT|/sum(w), DC/Nyquist ×1',
        waveform:samples.map((s,i)=>({seconds:(s.t_ms-samples[0].t_ms)/1000,value:dynamic[i]})) };
}

export function validateConfig(c) {
    for(const key of ['target','tolerance','normalMin','normalMax','normalRms','alertRms','alertAmplitude','windows','cooldown','sampleRate']) if(!Number.isFinite(c[key])||c[key]<0) fail(`Cấu hình sai: ${key}`);
    if(c.sampleRate<20||c.sampleRate>1000||c.target<=0||c.tolerance<=0||c.target-c.tolerance<0||c.target+c.tolerance>=c.sampleRate/2||c.normalMin>c.normalMax||c.normalMax>=c.sampleRate/2||c.alertRms<=c.normalRms||c.alertAmplitude<=0||!Number.isInteger(c.windows)||c.windows<1||c.windows>100||c.cooldown>86400) fail('Dải tần/Nyquist/ngưỡng không hợp lệ');
    return c;
}
export class SpectrumMonitor {
    constructor(directory, now=Date.now) {
        this.now=now; this.file=join(directory,'spectrum-config.json'); this.count=0; this.latched=false; this.lastAlert=-Infinity;
        this.saved=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{config:null,baseline:null,previous:null};
        if(this.saved.config) validateConfig(this.saved.config);
        this.alertFile=join(directory,'spectrum-alerts.json');
        this.alerts=existsSync(this.alertFile)?JSON.parse(readFileSync(this.alertFile,'utf8')).slice(-100):[];
        this.seen = new Map();
        this.reset('Chưa có dữ liệu cảm biến');
    }
    persist(file,data) { writeFileSync(file+'.tmp',JSON.stringify(data)); renameSync(file+'.tmp',file); }
    save(config) { validateConfig(config); const next={...this.saved,previous:this.saved.config,config}; this.persist(this.file,next); this.saved=next; this.reset('Cấu hình đã đổi; chờ cửa sổ mới'); }
    restore() { if(!this.saved.previous) fail('Chưa có cấu hình trước'); this.save(this.saved.previous); }
    reset(reason) { this.result={status:'INSUFFICIENT_DATA',reason,evidence:'insufficient_data'}; this.buffer=[]; this.identity=null; this.count=0; this.latched=false; this.at=null; }
    snapshot() {
        const stale=!this.at||this.now()-this.at>4000;
        if(stale) {this.count=0;this.latched=false;}
        return { ...this.result,...(stale?{status:'INSUFFICIENT_DATA',reason:'Chưa có dữ liệu cảm biến mới',rms:null,peak:null,fd_est:null}:{}),stale,config:this.saved.config,baseline:this.saved.baseline,alerts:this.alerts,calibration:this.calibration??null };
    }
    ingest(batch) {
        if(batch && (!(batch.sample_rate>=20 && batch.sample_rate<=1000) || batch.source==='measured_live' && (typeof batch.filter!=='string' || !batch.filter))) fail('Thiếu Fs hoặc cấu hình lọc cảm biến thật');
        if(!batch||!['synthetic','measured_live'].includes(batch.source)||batch.unit!=='m/s2'||!['ax','ay','az'].includes(batch.axis)||!['steady','ringdown','forced'].includes(batch.mode)||typeof batch.boot_id!=='string'||!batch.boot_id||!Number.isSafeInteger(batch.seq)||batch.seq<0||!Number.isFinite(batch.sample_rate)||!Array.isArray(batch.samples)||batch.samples.length<1||batch.samples.length>40||typeof batch.sensorPosition!=='string'||!batch.sensorPosition||!Number.isFinite(batch.rulerLength)||batch.rulerLength<=0||batch.quality!=='valid') fail('Batch/schema không hợp lệ (1–40 mẫu)');
        const identity=JSON.stringify([batch.source,batch.boot_id,batch.axis,batch.mode,batch.sample_rate,batch.sensorPosition,batch.rulerLength,batch.filter??null]);
        const streamKey=JSON.stringify([batch.source,batch.boot_id]);
        const seen=this.seen.get(streamKey);
        if(seen && (batch.seq<=seen.seq || batch.samples[0]?.t_ms<=seen.time)) fail('Batch trùng hoặc sai thứ tự');
        const interrupted=this.identity!==identity||!this.at||this.now()-this.at>4000;
        if(interrupted) {this.reset('Chờ đủ 512 mẫu liên tục');this.identity=identity;this.seq=-1;this.lastTime=null;}
        if(batch.seq<=this.seq) fail('Batch trùng hoặc sai thứ tự');
        const dt=1000/batch.sample_rate;
        let previous=this.lastTime;
        for(const s of batch.samples) {
            if(!Number.isFinite(s.t_ms)||!Number.isFinite(s.value)||Math.abs(s.value)>=39||previous!==null&&Math.abs(s.t_ms-previous-dt)>dt*.1) {this.reset('Mất mẫu/timestamp/clipping');fail('Mất mẫu/timestamp/clipping');}
            previous=s.t_ms;
        }
        this.seq=batch.seq;this.lastTime=previous;this.at=this.now();this.meta={source:batch.source,axis:batch.axis,sensorPosition:batch.sensorPosition,rulerLength:batch.rulerLength,sampleRate:batch.sample_rate,filter:(batch.filter??'synthetic no hardware filter')+'; mean removal',mode:batch.mode};
        this.seen.set(streamKey,{seq:batch.seq,time:previous});
        if(this.seen.size>32) this.seen.delete(this.seen.keys().next().value);
        this.buffer.push(...batch.samples);
        while(this.buffer.length>=512) {
            const raw=this.buffer.splice(0,512), analysis=analyze(raw,batch.mode);
            if(Math.abs(analysis.fs-batch.sample_rate)>batch.sample_rate*.02) fail('Fs khai báo không khớp timestamp');
            this.raw=raw;this.result={...analysis,...this.meta,status:'UNKNOWN',reason:'Chưa cấu hình hoặc baseline không tương đương',evidence:'insufficient_data',at:this.at,quality:'valid'};
            this.classify();
            if(this.capture) this.captureWindow();
        }
        return this.snapshot();
    }
    compatible() {
        const b=this.saved.baseline;
        return b && ['source','axis','sensorPosition','rulerLength','sampleRate','filter'].every(k=>b.meta[k]===this.meta[k]);
    }
    classify() {
        const c=this.saved.config, r=this.result;
        if(!c||!this.compatible()||Math.abs(c.sampleRate-r.fs)>r.fs*.02) {this.count=0;return;}
        if(r.rms>c.normalRms && (!r.peak || r.peak.amplitude<r.noise*6)) {this.count=0;this.latched=false;r.reason='Nhiễu rộng quá mạnh; chưa đủ chất lượng phân loại';return;}
        const near=r.peaks.find(p=>Math.abs(p.hz-c.target)<=c.tolerance&&p.amplitude>Math.max(r.noise*6,1e-6));
        r.referencePeak=near??null;
        const high=near&&r.rms>=c.alertRms&&near.amplitude>=c.alertAmplitude;
        this.count=high?this.count+1:0;
        if(!near||r.rms<c.alertRms*.8||near.amplitude<c.alertAmplitude*.8) this.latched=false;
        r.status=this.count>=c.windows||this.latched?'RESONANCE_ALERT':r.rms>c.normalRms||near||r.peak&&(r.peak.hz<c.normalMin||r.peak.hz>c.normalMax)?'WARNING':'NORMAL';
        r.reason=r.status==='RESONANCE_ALERT'?'Cảnh báo dao động mạnh gần vùng tần số tham chiếu':'Giám sát theo ngưỡng thực nghiệm';
        if(this.count>=c.windows) {
            this.latched=true;
            if(this.now()-this.lastAlert>=c.cooldown*1000) {
                const alert={timestamp:this.now(),source:r.source,frequency:near.hz,reference:c.target,rms:r.rms,threshold:c.alertRms,amplitude:near.amplitude,amplitudeThreshold:c.alertAmplitude,status:r.status,mode:r.mode};
                this.alerts=[alert,...this.alerts].slice(0,100);this.persist(this.alertFile,this.alerts);this.lastAlert=this.now();
            }
        }
    }
    startCapture(kind) {
        if(!['baseline','ringdown'].includes(kind)) fail('Loại hiệu chuẩn sai');
        this.capture=kind; this.calibration={phase:kind,reason:'Đang chờ một cửa sổ mới đủ chất lượng'};
        this.buffer=[];this.count=0;
    }
    captureWindow() {
        const r=this.result;
        if(this.capture==='baseline') {
            if(r.mode!=='steady') {this.calibration={phase:'insufficient_data',reason:'Đo nền ở chế độ xác lập (steady)'};this.capture=null;return;}
            this.pendingBaseline={raw:this.raw,meta:this.meta,fs:r.fs,rms:r.rms,noise:r.noise,spectrum:r.spectrum,quality:r.quality,duration:r.duration,timestamp:this.now()};
            this.calibration={phase:'confirm_baseline',rms:r.rms,reason:'Xác nhận để lưu baseline; chưa ghi đè baseline cũ'};
        } else {
            const b=this.saved.baseline;
            const candidate=r.mode==='ringdown'&&this.compatible()&&r.fd_est&&r.rms>Math.max(b.rms*2,1e-6)?r.fd_est:null;
            this.calibration={phase:candidate?'proposal':'insufficient_data',fd_est:candidate,peaks:r.peaks.map(p=>({...p,harmonicOfCandidate:!!candidate&&p.hz>candidate*1.5&&Math.abs(p.hz/candidate-Math.round(p.hz/candidate))<.08})),suggestion:candidate?{target:candidate,tolerance:r.resolution*2,normalRms:b.rms*2,alertRms:Math.max(b.rms*4,1e-4),alertAmplitude:Math.max(b.noise*12,1e-4),normalMin:0,normalMax:Math.min(r.nyquist-r.resolution,(b.spectrum.reduce((a,p)=>p.amplitude>a.amplitude?p:a).hz+r.resolution*2))}:null,reason:candidate?'Mode ứng viên / fd_est; cần đo lặp và kiểm chu kỳ. Không suy fn hoặc xác nhận cộng hưởng.':'Chưa đủ cơ sở đề xuất: kiểm baseline, ringdown và SNR'};
        }
        this.capture=null;
    }
    confirmBaseline() {
        if(!this.pendingBaseline) fail('Chưa có baseline để xác nhận');
        const next={...this.saved,baseline:this.pendingBaseline};this.persist(this.file,next);this.saved=next;this.pendingBaseline=null;this.calibration={phase:'baseline_saved'};this.reset('Baseline đã lưu; chờ cửa sổ mới');
    }
}

import { analyze } from './spectrum.js';
export const ALGORITHM_VERSION='rg-physical-1';
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
export const deviation=a=>a.length<2?0:Math.sqrt(a.reduce((s,x)=>s+(x-mean(a))**2,0)/(a.length-1));
const rejected=reason=>({valid:false,fd_est:null,reason,algorithm_version:ALGORITHM_VERSION});
export function freeDecay(samples) {
    if(samples.length<1000||samples.length>2001) return rejected('duration_requires_5_to_10_seconds');
    const duration=(samples.at(-1).t_ms-samples[0].t_ms)/1000+.005;
    if(duration<5||duration>10.01) return rejected('duration_requires_5_to_10_seconds');
    if(samples.some((s,i)=>!Number.isFinite(s.value)||Math.abs(s.value)>=39||i&&Math.abs(s.t_ms-samples[i-1].t_ms-5)>.5)) return rejected('gap_clipping_or_invalid_sample');
    const n=samples.length>=1024?1024:512;
    const fft=analyze(samples.slice(0,n),'ringdown');
    const dc=mean(samples.map(s=>s.value));
    const peak=Math.max(...samples.map(s=>Math.abs(s.value-dc)));
    const crossings=[];
    for(let i=1;i<samples.length;i++) {
        const a=samples[i-1].value-dc,b=samples[i].value-dc;
        if(a<=0&&b>0) crossings.push(samples[i-1].t_ms+(-a)/(b-a)*(samples[i].t_ms-samples[i-1].t_ms));
    }
    const periods=crossings.slice(1).map((t,i)=>t-crossings[i]);
    const timeHz=periods.length>=4?1000/mean(periods):null;
    const head=Math.sqrt(mean(samples.slice(0,200).map(s=>(s.value-dc)**2)));
    const tail=Math.sqrt(mean(samples.slice(-200).map(s=>(s.value-dc)**2)));
    if(!fft.fd_est||peak<.001||fft.peak.amplitude<Math.max(fft.noise*6,.001)||tail>=head*.9) return rejected('low_snr_or_not_decaying');
    if(!timeHz||timeHz<1||timeHz>40||deviation(periods)/mean(periods)>.15||Math.abs(timeHz-fft.fd_est)>Math.max(fft.resolution*1.5,timeHz*.05)) return rejected('time_frequency_disagreement');
    return {valid:true,fd_est:timeHz,fft_hz:fft.fd_est,time_hz:timeHz,fs:fft.fs,resolution:fft.resolution,duration,rms:fft.rms,peak,algorithm_version:ALGORITHM_VERSION};
}
export function aggregateDecay(results) {
    const valid=results.filter(r=>r?.valid&&Number.isFinite(r.fd_est));
    if(valid.length<5) return {fd_est:null,reason:'requires_five_valid_runs',count:valid.length};
    const values=valid.map(r=>r.fd_est);
    if(deviation(values)>mean(values)*.05) return {fd_est:null,reason:'poor_repeatability_or_different_modes',count:values.length};
    return {fd_est:mean(values),s:deviation(values),count:values.length,reason:null};
}
// Least squares with a fitted DC intercept, not an FFT-bin approximation.
export function fitOneX(samples, rpmRows) {
    if(samples.length<200||rpmRows.length<3) return {valid:false,reason:'insufficient_step_samples'};
    const matched=samples.map(s=>{
        let best=null, delta=Infinity;
        for(const r of rpmRows) if(Math.abs(r.t_ms-s.t_ms)<delta){best=r;delta=Math.abs(r.t_ms-s.t_ms);}
        return delta<=250&&best?.quality==='ok'?best.rpm:null;
    });
    if(matched.some(r=>!Number.isFinite(r)||r<=0)) return {valid:false,reason:'rpm_missing_stale_or_zero'};
    const rpm=mean(matched), hz=rpm/60, omega=2*Math.PI*hz;
    if(deviation(matched)/rpm>.03) return {valid:false,reason:'rpm_unstable'};
    if(hz>=90||samples.some((s,i)=>!Number.isFinite(s.value)||Math.abs(s.value)>=39||i&&Math.abs(s.t_ms-samples[i-1].t_ms-5)>.5)) return {valid:false,reason:'gap_clipping_or_nyquist'};
    if((samples.at(-1).t_ms-samples[0].t_ms)*hz/1000<20) return {valid:false,reason:'less_than_twenty_cycles'};
    const m=Array.from({length:3},()=>[0,0,0,0]);
    for(const s of samples){const t=(s.t_ms-samples[0].t_ms)/1000,v=[Math.sin(omega*t),Math.cos(omega*t),1];for(let i=0;i<3;i++){for(let j=0;j<3;j++)m[i][j]+=v[i]*v[j];m[i][3]+=v[i]*s.value;}}
    for(let k=0;k<3;k++){
        let p=k;for(let i=k+1;i<3;i++)if(Math.abs(m[i][k])>Math.abs(m[p][k]))p=i;
        [m[k],m[p]]=[m[p],m[k]];
        if(Math.abs(m[k][k])<1e-9)return {valid:false,reason:'singular_fit'};
        const scale=m[k][k];for(let j=k;j<4;j++)m[k][j]/=scale;
        for(let i=0;i<3;i++)if(i!==k){const f=m[i][k];for(let j=k;j<4;j++)m[i][j]-=f*m[k][j];}
    }
    const [b,d,c]=m.map(row=>row[3]), A1=Math.hypot(b,d);
    const residual=Math.sqrt(mean(samples.map(s=>{const t=(s.t_ms-samples[0].t_ms)/1000;return (s.value-b*Math.sin(omega*t)-d*Math.cos(omega*t)-c)**2;})));
    if(A1<.001||A1<3*residual) return {valid:false,reason:'low_1x_snr',rpm,hz,residual};
    return {valid:true,rpm,hz,A1,displacement_m:A1/omega**2,relative_force_response:A1/omega**4,force_normalized:null,reason_force:'eccentric_mass_radius_not_calibrated',b,d,c,residual};
}
export function sweepEvidence(steps, finished=false, reference=null, forceChecked=false) {
    const valid=steps.filter(s=>s.valid);
    if(!reference?.fd_est||valid.length<1) return {status:'insufficient_data',reason:'requires_free_decay_reference_and_valid_steps',steps};
    if(!finished) return {status:'surveying',reason:'sweep_in_progress',steps};
    const peaks=[];
    for(const repeat of [1,2]) for(const direction of ['up','down']) {
        const rows=valid.filter(s=>s.direction===direction&&s.repeat===repeat).sort((a,b)=>a.hz-b.hz);
        if(rows.length<5)return {status:'inconclusive',reason:'requires_five_steps_in_each_direction',steps};
        const peak=rows.reduce((a,b)=>b.relative_force_response>a.relative_force_response?b:a),i=rows.indexOf(peak);
        if(i===0||i===rows.length-1||peak.relative_force_response<1.2*Math.max(rows[0].relative_force_response,rows.at(-1).relative_force_response))return {status:'inconclusive',reason:'peak_without_two_sides_or_prominence',steps};
        peaks.push(peak);
    }
    const repeat=peaks.every(p=>Math.abs(p.hz-reference.fd_est)<=Math.max(reference.s*3,reference.fd_est*.05));
    const supported=repeat&&forceChecked;
    return {status:supported?'supported':'inconclusive',reason:supported?'repeatable_normalized_peak_matches_free_decay':!forceChecked?'force_assumptions_not_checked':'peak_reference_disagreement',steps,peak_hz:supported?mean(peaks.map(p=>p.hz)):null,criteria:'5 steps/direction, 2 repeats, 20% prominence, 5% reference agreement; configurable experimental criteria require hardware validation'};
}
export function compareBaseline(baseline, estimate, previousChanged=false) {
    if(!Number.isFinite(estimate?.fd_est))return {status:'insufficient_data',changed:null,reason:'requires_five_valid_runs'};
    const threshold=Math.max(3*baseline.s,baseline.u_min),delta=Math.abs(estimate.fd_est-baseline.fd_est);
    const changed=delta>(previousChanged?.8:1)*threshold;
    return {status:changed?'changed':'within_threshold',changed,delta,threshold,release_threshold:threshold*.8,interpretation:'vibration_characteristic_change_only'};
}

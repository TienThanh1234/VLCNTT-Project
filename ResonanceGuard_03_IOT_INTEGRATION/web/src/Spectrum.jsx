import React, { useEffect, useState } from 'react';

const fields={target:'Tần số tham chiếu (Hz)',tolerance:'Sai số ± (Hz)',normalMin:'Tần số bình thường min (Hz)',normalMax:'Tần số bình thường max (Hz)',normalRms:'RMS bình thường tối đa (m/s²)',alertRms:'Ngưỡng RMS cảnh báo (m/s²)',alertAmplitude:'Ngưỡng biên độ phổ (m/s²)',windows:'Số cửa sổ liên tiếp',cooldown:'Cooldown (giây)',sampleRate:'Fs dự kiến (Hz)'};
function Plot({points,x,y,label,band,target}) {
    if(!points?.length) return <p>Chưa có dữ liệu cảm biến</p>;
    const xmax=Math.max(...points.map(p=>p[x]),1), ymin=Math.min(0,...points.map(p=>p[y])), ymax=Math.max(1e-6,...points.map(p=>p[y]));
    const path=points.map((p,i)=>`${i?'L':'M'}${p[x]/xmax*600},${160-(p[y]-ymin)/(ymax-ymin)*145}`).join(' ');
    return <><svg viewBox="0 0 600 185" role="img" aria-label={label}>
        {band&&<rect x={Math.max(0,band[0])/xmax*600} width={(band[1]-Math.max(0,band[0]))/xmax*600} height="160" fill="#ff9292" opacity=".15"/>}
        {target&&<path d={`M${target/xmax*600} 0 V160`} stroke="#ff9292"/>}
        <path d={path} stroke="#6ce5cf" fill="none" strokeWidth="1.5"/><text x="0" y="180" fill="currentColor">0</text><text x="500" y="180" fill="currentColor">{xmax.toFixed(2)}</text>
    </svg><p>{label} · Y: {ymin.toFixed(3)} đến {ymax.toFixed(3)} m/s²</p></>;
}
export default function Spectrum() {
    const [data,setData]=useState(null),[form,setForm]=useState({}),[message,setMessage]=useState(''),[online,setOnline]=useState(false);
    const [frequency,setFrequency]=useState('7'),[amplitude,setAmplitude]=useState('0.1'),[mode,setMode]=useState('steady');
    useEffect(()=>{let active=true; const poll=async()=>{try{const response=await fetch('/api/spectrum',{signal:AbortSignal.timeout(3000)});if(!response.ok)throw Error();const d=await response.json();if(active){setData(d);setOnline(true);setForm(old=>Object.keys(old).length?old:d.config??{});}}catch{if(active)setOnline(false);}};poll();const timer=setInterval(poll,1000);return()=>{active=false;clearInterval(timer);};},[]);
    async function post(path,body) {try{const response=await fetch('/api/spectrum/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await response.json();if(!response.ok)throw Error(d.error);setData(d);setOnline(true);setMessage('Đã thực hiện');if(path==='restore')setForm(d.config??{});}catch(e){setMessage(e.message);}}
    const fresh=online&&data&&!data.stale, c=data?.config, status=fresh?data.status:'INSUFFICIENT_DATA';
    return <section><h2>Phân tích phổ dao động (FFT Spectrum)</h2>
        <p className={`spectrum-status ${status}`} role="status">{status} · {fresh?data.reason:'Chưa có dữ liệu cảm biến mới'}</p>
        <p>Nguồn phân tích: <strong>{data?.source==='synthetic'?'TEST / SIMULATED':data?.source==='measured_live'?'MPU6050 · measured_live':'Chưa có'}</strong> · Chất lượng: {fresh?data.quality??'chưa đủ mẫu':'stale'} · Bằng chứng theo phiên: {data?.evidence??'insufficient_data'}</p>
        {fresh&&data.status==='RESONANCE_ALERT'&&<p role="alert" className="spectrum-alert">⚠ Nghi ngờ cộng hưởng · {data.referencePeak?.hz.toFixed(2)} Hz / tham chiếu {c?.target} Hz · RMS {data.rms?.toFixed(3)} m/s² · ngưỡng {c?.alertRms} m/s²</p>}
        <p>Đỉnh FFT: {fresh?data.peak?.hz.toFixed(2)??'—':'—'} Hz · Biên độ: {fresh?data.peak?.amplitude.toFixed(3)??'—':'—'} m/s² · RMS: {fresh?data.rms?.toFixed(3)??'—':'—'} m/s²</p>
        <p>Fs thực: {fresh?data.fs?.toFixed(2)??'—':'—'} Hz · Nyquist: {fresh?data.nyquist?.toFixed(2)??'—':'—'} Hz · Δf: {fresh?data.resolution?.toFixed(3)??'—':'—'} Hz · N: {data?.n??'—'} · T: {data?.duration?.toFixed(3)??'—'} s</p>
        <small>{data?.normalization} · Trục gia tốc có dấu, loại trung bình DC. Đồ thị cũ khi stale chỉ là lịch sử.</small>
        <div className="charts"><div><Plot points={data?.waveform} x="seconds" y="value" label="Gia tốc động · X: thời gian (s)"/></div><div><Plot points={data?.spectrum} x="hz" y="amplitude" label="FFT · X: Frequency (Hz)" target={c?.target} band={c?[c.target-c.tolerance,c.target+c.tolerance]:null}/></div></div>
        <h3>Hiệu chuẩn</h3><p>Giữ cùng trục, vị trí cảm biến, chiều dài thước và bộ lọc. Thu nền trước; xác nhận lưu rồi mới kéo–thả. Không cần chạy motor.</p>
        <div className="buttons"><button onClick={()=>post('calibration',{action:'baseline'})}>Bắt đầu hiệu chuẩn nền</button><button disabled={data?.calibration?.phase!=='confirm_baseline'} onClick={()=>post('calibration',{action:'confirm_baseline'})}>Xác nhận lưu baseline</button><button onClick={()=>post('calibration',{action:'ringdown'})}>Đo kéo–thả / Đo lại</button></div>
        <p>{data?.calibration?.reason??data?.calibration?.phase}</p>
        <p>Baseline đã lưu: {data?.baseline?`${data.baseline.meta.source} · RMS ${data.baseline.rms.toFixed(4)} m/s² · ${new Date(data.baseline.timestamp).toLocaleString()}`:'chưa có'}</p>
        {data?.calibration?.fd_est&&<p>fd_est ứng viên: {data.calibration.fd_est.toFixed(2)} Hz · chưa xác định fn. Các đỉnh: {data.calibration.peaks.map(p=>`${p.hz.toFixed(2)} Hz${p.harmonicOfCandidate?' (nghi hài)':''}`).join(', ')}</p>}
        {data?.calibration?.suggestion&&<button onClick={()=>setForm({...form,...data.calibration.suggestion,sampleRate:data.fs})}>Chấp nhận đề xuất vào biểu mẫu để chỉnh và lưu</button>}
        <h3>Cấu hình giám sát cộng hưởng</h3><form onSubmit={e=>{e.preventDefault();post('config',form);}}><div className="spectrum-fields">{Object.entries(fields).map(([key,label])=><label key={key}>{label}<input required type="number" min="0" step={key==='windows'?'1':'any'} value={form[key]??''} onChange={e=>setForm({...form,[key]:e.target.value===''?'':Number(e.target.value)})}/></label>)}</div><div className="buttons"><button>Lưu cấu hình</button><button type="button" onClick={()=>post('restore',{})}>Khôi phục cấu hình trước</button></div></form>
        <details><summary>Demo FFT · dữ liệu SYNTHETIC, không điều khiển motor</summary><label>Tần số demo (Hz)<input type="number" value={frequency} onChange={e=>setFrequency(e.target.value)}/></label><label>Biên độ demo (m/s²)<input type="number" value={amplitude} onChange={e=>setAmplitude(e.target.value)}/></label><select value={mode} onChange={e=>setMode(e.target.value)}><option value="steady">Xác lập</option><option value="ringdown">Ringdown tổng hợp</option><option value="forced">Cưỡng bức tổng hợp</option></select><button onClick={()=>post('demo',{frequency:Number(frequency),amplitude:Number(amplitude),mode})}>Tạo một cửa sổ TEST / SIMULATED</button></details>
        <p aria-live="polite">{message}</p><h3>Lịch sử cảnh báo</h3><div className="spectrum-history">{data?.alerts?.map(a=><p key={a.timestamp}>{new Date(a.timestamp).toLocaleString()} · {a.source} · {a.mode} · {a.frequency.toFixed(2)} Hz / tham chiếu {a.reference} Hz · RMS {a.rms.toFixed(3)} / ngưỡng {a.threshold} m/s² · {a.status}</p>)}</div>
        <small>Cảnh báo theo ngưỡng thực nghiệm; không xác nhận cộng hưởng vật lý hoặc an toàn kết cấu. FFT forced không suy fn. Chưa có bộ đánh giá sweep để gán supported.</small>
    </section>;
}

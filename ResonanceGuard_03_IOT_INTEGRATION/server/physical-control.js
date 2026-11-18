import { randomUUID } from 'node:crypto';
export function privateBroker(url, username, password, aclConfirmed) {
    const u=new URL(url),h=u.hostname;
    const privateHost=h==='localhost'||/^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h);
    return ['mqtt:','mqtts:'].includes(u.protocol)&&privateHost&&!!username&&!!password&&aclConfirmed===true;
}
export class PhysicalControl {
    constructor({now=Date.now,publish,state,secure,save}){Object.assign(this,{now,publish,state,secure,save});this.session=null;this.pending=new Map();this.sockets=new Map();}
    socket(ws){const key=randomUUID();this.sockets.set(key,{ws,at:this.now()});return key;}
    heartbeat(key){const row=this.sockets.get(key);if(row)row.at=this.now();}
    connected(key){const row=this.sockets.get(key);return row&&row.ws.readyState===1&&this.now()-row.at<=1500;}
    disconnect(key){this.sockets.delete(key);if(this.session?.owner===key)this.revoke('websocket_closed');}
    revoke(reason){const old=this.session;this.session=null;this.pending.clear();if(old)this.send('stop',0,{...old,reason});}
    send(action,duty,session,extra={}) {
        const s=this.state();
        const command={schema_version:2,device_id:'rg01',source:'measured',data_origin:'physical',boot_id:s?.boot_id??session?.boot_id??'',command_id:randomUUID(),
            session_id:session?.id??randomUUID(),nonce:session?.nonce??randomUUID(),command_seq:session?++session.seq:0,
            action,duty,lease_ms:2000,not_after_device_ms:(s?.t_device_ms??0)+1500,...extra};
        const record={...command,created_at:this.now(),trace:[]};this.pending.set(command.command_id,record);this.save(record);this.publish(command);return record;
    }
    request(action,duty,owner) {
        const state=this.state();
        if(action==='stop'){const s=this.session;this.session=null;this.pending.clear();return this.send('stop',0,s);}
        if(!['arm','start','renew','set_duty'].includes(action))throw Error('invalid_action');
        if(!this.secure)throw Error('authenticated_private_broker_and_ACL_required');
        if(!state?.safety_ready||!state?.imu_ok)throw Error('hardware_safety_not_ready');
        if(!this.connected(owner))throw Error('live_control_websocket_required');
        if(!Number.isFinite(duty)||duty<0||duty>.8)throw Error('invalid_duty');
        if(action==='arm') {
            if(this.session||state.running)throw Error('stop_existing_session_before_arm');
            this.session={id:randomUUID(),nonce:randomUUID(),seq:0,owner,boot_id:state.boot_id,phase:'arming',at:this.now()};
        }else {
            const s=this.session;
            if(!s||s.owner!==owner||s.boot_id!==state.boot_id)throw Error('wrong_control_session');
            if(action==='start'&&(s.phase!=='armed'||this.now()-s.at>1500))throw Error('ARM_ACK_required_or_expired');
            if(action!=='start'&&s.phase!=='running')throw Error('START_ACK_required');
            if(this.pending.size)throw Error('previous_command_ACK_pending');
        }
        return this.send(action,action==='arm'?0:duty,this.session);
    }
    acknowledge(ack) {
        const record=this.pending.get(ack.command_id),s=this.session;
        if(!record||record.boot_id!==ack.boot_id||record.session_id!==ack.session_id||this.now()-record.created_at>1500)return false;
        if(record.action!=='arm'&&record.nonce!==ack.nonce)return false;
        this.pending.delete(ack.command_id);
        if(!ack.accepted){this.revoke('device_rejected');return true;}
        if(s&&s.id===ack.session_id){
            if(!this.connected(s.owner)){this.revoke('heartbeat_expired');return false;}
            if(record.action==='arm'){if(ack.running){this.revoke('invalid_arm_ack');return false;}s.nonce=ack.nonce;s.phase='armed';s.at=this.now();}
            else if(record.action==='start'){if(!ack.running){this.revoke('start_not_running');return false;}s.phase='running';s.at=this.now();}
            else if(['renew','set_duty'].includes(record.action)){if(!ack.running){this.revoke('device_off');return false;}s.at=this.now();}
        }
        return true;
    }
    tick(){const s=this.session;if(s&&(!this.connected(s.owner)||this.now()-s.at>2000))this.revoke('heartbeat_or_lease_expired');for(const [key,r] of this.pending)if(this.now()-r.created_at>2000)this.pending.delete(key);}
}

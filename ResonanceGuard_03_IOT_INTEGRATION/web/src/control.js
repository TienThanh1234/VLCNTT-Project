export class ControlSession
{
    active = false;
    epoch = 0;
    pending = new Map();
    lastAckDecision = 'none';
    completed = new Map();

    disarm()
    {
        this.active = false;
        ++this.epoch;
        this.pending.clear();
        this.completed.clear();
    }

    register(id, action, silent, epoch, now = Date.now(), bootId = null)
    {
        if (epoch !== this.epoch)
        {
            return false;
        }
        if (this.pending.has(id) || this.completed.has(id)) return false;
        this.pending.set(id, { action, silent, epoch, at: now, bootId });
        return true;
    }

    acknowledge(ack, healthy, now = Date.now())
    {
        const record = this.pending.get(ack.command_id);
        if (this.completed.has(ack.command_id))
        {
            this.lastAckDecision = 'duplicate_ack';
            return null;
        }
        if (record?.bootId && record.bootId !== ack.boot_id)
        {
            this.lastAckDecision = 'wrong_command_boot';
            return null;
        }
        if (!record || record.epoch !== this.epoch || now - record.at > 5000)
        {
            this.lastAckDecision = !record ? 'no_matching_pending_or_early_ack' :
                record.epoch !== this.epoch ? 'old_control_epoch' : 'ack_wall_timeout';
            return null;
        }
        this.pending.delete(ack.command_id);
        this.completed.set(ack.command_id, true);
        if (this.completed.size > 100) this.completed.delete(this.completed.keys().next().value);
        if (!ack.accepted || !ack.running || !healthy)
        {
            this.active = false;
            this.lastAckDecision = !healthy ? 'matched_but_unhealthy_no_renew' :
                !ack.accepted ? 'device_rejected' : 'device_off';
        }
        else if (record.action === 'start')
        {
            this.active = true;
            this.lastAckDecision = 'start_armed';
        }
        else
        {
            this.lastAckDecision = this.active ? 'matched_active' : 'matched_does_not_arm';
        }
        return record;
    }
}

// ACKs may arrive over WS before fetch('/api/motor') returns the command_id.
export class AckBuffer
{
    rows = new Map();
    put(ack, epoch, now = Date.now())
    {
        this.prune(now);
        if (!ack || typeof ack.command_id !== 'string' || this.rows.has(ack.command_id)) return;
        this.rows.set(ack.command_id, { ack, epoch, at: now });
        while (this.rows.size > 50) this.rows.delete(this.rows.keys().next().value);
    }
    prune(now) { for (const [id, row] of this.rows) if (now - row.at > 5000) this.rows.delete(id); }
    take(id, epoch, now = Date.now())
    {
        this.prune(now);
        const row = this.rows.get(id);
        this.rows.delete(id);
        return row?.epoch === epoch ? row.ack : null;
    }
    clear() { this.rows.clear(); }
}

// Only the actual ACK saved after backend validation can recover a missed WS event.
export function commandFeedback(record, id, bootId)
{
    if (!record || record.command_id !== id || record.boot_id !== bootId) return { kind: 'unknown' };
    const ack = record.ack;
    if (!record.cancelled && record.acked === true && ack?.command_id === id && ack.boot_id === bootId &&
        typeof ack.accepted === 'boolean' && typeof ack.running === 'boolean' &&
        Number.isFinite(record.ack_received_at) && Number.isFinite(record.created_at) &&
        record.ack_received_at >= record.created_at && record.ack_received_at - record.created_at <= 5000)
        return { kind: 'ack', ack };
    const rejection = record.ack_rejection ?? [...(record.trace ?? [])].reverse().find(row => row.stage === 'ACK_DROP');
    if (rejection?.reason === 'ack_wall_timeout') return { kind: 'late', age: rejection.age_ms };
    return { kind: 'unknown' };
}

// Update in WebSocket callbacks, not during a later React render.
export class ConnectionHealth
{
    ws = false;
    broker = false;
    subscribed = false;
    stateAt = 0;

    snapshot(data, now = Date.now())
    {
        this.broker = Boolean(data.broker_connected);
        this.subscribed = data.broker_subscribed !== false;
        this.stateAt = data.state_age_ms == null ? 0 : now - data.state_age_ms;
    }

    state(now = Date.now())
    {
        this.stateAt = now;
    }

    healthy(now = Date.now())
    {
        return this.ws && this.broker && this.subscribed && this.stateAt > 0 && now - this.stateAt <= 4000;
    }
}

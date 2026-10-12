const { pool } = require('./db'), pesapal = require('./pesapal');
async function apply(c, ref, tid, st) {
  const { rows: [o] } = await c.query('SELECT * FROM orders WHERE id::text=$1 FOR UPDATE', [String(ref)]);
  if (!o || o.tracking_id !== tid) return null;
  await c.query('INSERT INTO payments(order_id,tracking_id,status,confirmation_code,raw) VALUES($1,$2,$3,$4,$5)',
    [o.id, tid, st.payment_status_description || 'unknown', st.confirmation_code || null, JSON.stringify(st)]);
  if (o.status === 'paid') return o; // idempotent: duplicate webhooks never extend twice
  const code = Number(st.status_code); let next = o.status;
  if (code === 1) next = Number(st.amount) === Number(o.amount) && st.currency === o.currency ? 'paid' : 'review';
  else if (code === 2 || code === 3) next = 'failed';
  if (next === 'paid') {
    const { rows: [p] } = await c.query('SELECT duration_days FROM plans WHERE id=$1', [o.plan_id]);
    await c.query(`INSERT INTO subscriptions(user_id,plan_id,order_id,starts_at,ends_at)
      SELECT $1,$2,$3,s,s+make_interval(days=>$4) FROM (SELECT greatest(now(),coalesce((SELECT max(ends_at) FROM subscriptions WHERE user_id=$1),now())) s) x
      ON CONFLICT (order_id) DO NOTHING`, [o.user_id, o.plan_id, o.id, p.duration_days]);
    await c.query("UPDATE orders SET status='paid', paid_at=now() WHERE id=$1", [o.id]);
  } else if (next !== o.status) await c.query('UPDATE orders SET status=$2 WHERE id=$1', [o.id, next]);
  return { ...o, status: next };
}
// Ask the gateway (never trust query params / redirects), then settle in one transaction.
async function settle(trackingId) {
  const st = await pesapal.getStatus(trackingId), c = await pool.connect();
  try { await c.query('BEGIN'); const r = await apply(c, st.merchant_reference, trackingId, st); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const subState = s => (!s ? 'none' : new Date(s.ends_at) > new Date() ? 'active' : 'expired');
module.exports = { settle, subState };

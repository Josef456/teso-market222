// Needs a throw-away Postgres: TEST_DATABASE_URL=postgres://... npm test   (skipped otherwise)
const { test, before, after } = require('node:test'), assert = require('node:assert');
const URL_ = process.env.TEST_DATABASE_URL, skip = !URL_;
if (!skip) Object.assign(process.env, { DATABASE_URL: URL_, SESSION_SECRET: 's'.repeat(32), IPN_SECRET: 'ipnsecret', APP_URL: 'http://x', PESAPAL_CONSUMER_KEY: 'k', PESAPAL_CONSUMER_SECRET: 's' });
let app, pool, pesapal, server, base, settle, subState;
before(async () => {
  if (skip) return;
  ({ pool, migrate: global.mig } = require('../src/db')); await require('../src/db').migrate();
  pesapal = require('../src/pesapal'); ({ settle, subState } = require('../src/payments')); app = require('../src/server');
  server = app.listen(0); base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { if (skip) return; server.close(); await pool.end(); });
const client = () => { let cookie = ''; return async (p, o = {}) => { const r = await fetch(base + p, { redirect: 'manual', ...o, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } }); const sc = r.headers.getSetCookie(); if (sc.length) cookie = sc.map(s => s.split(';')[0]).join('; '); return r; }; };
const csrf = async c => (await (await c('/login')).text()).match(/name="_csrf" value="(\w+)"/)[1];
async function mkOrder(email, plan = 1, amount = 20000) {
  const u = (await pool.query("INSERT INTO users(email,name,password_hash) VALUES($1,'T','x') ON CONFLICT (email) DO UPDATE SET name='T' RETURNING id", [email])).rows[0];
  const t = 'trk-' + Math.random(); const o = (await pool.query("INSERT INTO orders(user_id,plan_id,amount,currency,tracking_id) VALUES($1,$2,$3,'UGX',$4) RETURNING id", [u.id, plan, amount, t])).rows[0];
  return { uid: u.id, oid: o.id, t };
}
const gw = (o, extra) => async () => ({ status_code: 1, payment_status_description: 'Completed', amount: 20000, currency: 'UGX', confirmation_code: 'C1', merchant_reference: o.oid, ...extra });

test('registration, logout and login', { skip }, async () => {
  const c = client(), email = `a${Date.now()}@t.co`; let t = await csrf(c);
  let r = await c('/register', { method: 'POST', body: new URLSearchParams({ _csrf: t, name: 'Ann', email, password: 'longenoughpw1' }) });
  assert.equal(r.headers.get('location'), '/dashboard'); assert.match(await (await c('/dashboard')).text(), /Hello, Ann/);
  assert.equal((await c('/register', { method: 'POST', body: new URLSearchParams({ _csrf: 'bad', name: 'x', email, password: 'longenoughpw1' }) })).status, 403); // CSRF
  const c2 = client(); t = await csrf(c2);
  r = await c2('/login', { method: 'POST', body: new URLSearchParams({ _csrf: t, email, password: 'wrong-password' }) }); assert.equal(r.headers.get('location'), '/login');
  r = await c2('/login', { method: 'POST', body: new URLSearchParams({ _csrf: t, email, password: 'longenoughpw1' }) }); assert.equal(r.headers.get('location'), '/dashboard');
});
test('duplicate webhooks activate and extend only once', { skip }, async () => {
  const o = await mkOrder(`b${Date.now()}@t.co`); pesapal.getStatus = gw(o);
  for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/payment/ipn/ipnsecret?OrderTrackingId=${o.t}`)).status, 200);
  assert.equal((await pool.query('SELECT count(*) FROM subscriptions WHERE order_id=$1', [o.oid])).rows[0].count, '1');
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [o.oid])).rows[0].status, 'paid');
  assert.equal((await fetch(`${base}/payment/ipn/wrong?OrderTrackingId=${o.t}`)).status, 404);
});
test('amount mismatch is not marked paid', { skip }, async () => {
  const o = await mkOrder(`c${Date.now()}@t.co`); pesapal.getStatus = gw(o, { amount: 1 });
  await settle(o.t); assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [o.oid])).rows[0].status, 'review');
  assert.equal((await pool.query('SELECT count(*) FROM subscriptions WHERE order_id=$1', [o.oid])).rows[0].count, '0');
});
test('browser redirect alone never marks an order paid', { skip }, async () => {
  const o = await mkOrder(`d${Date.now()}@t.co`); pesapal.getStatus = gw(o, { status_code: 0, payment_status_description: 'Pending' });
  const r = await fetch(`${base}/payment/return?OrderTrackingId=${o.t}&status=paid`); assert.match(await r.text(), /Payment pending/);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [o.oid])).rows[0].status, 'pending');
});
test('renewal extends from expiry; expired state detected', { skip }, async () => {
  const a = await mkOrder(`e${Date.now()}@t.co`); pesapal.getStatus = gw(a); await settle(a.t);
  const b = await pool.query("INSERT INTO orders(user_id,plan_id,amount,currency,tracking_id) VALUES($1,1,20000,'UGX',$2) RETURNING id", [a.uid, 'trk2-' + Math.random()]);
  pesapal.getStatus = gw({ oid: b.rows[0].id }); await settle(b.rows[0].id && (await pool.query('SELECT tracking_id FROM orders WHERE id=$1', [b.rows[0].id])).rows[0].tracking_id);
  const s = (await pool.query('SELECT * FROM subscriptions WHERE user_id=$1 ORDER BY ends_at', [a.uid])).rows;
  assert.equal(s.length, 2); assert.equal(+s[1].starts_at, +s[0].ends_at); assert.equal(subState(s[1]), 'active');
  assert.equal(subState({ ends_at: new Date(Date.now() - 1000) }), 'expired'); assert.equal(subState(undefined), 'none');
});

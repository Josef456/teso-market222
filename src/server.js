require('dotenv').config();
const express = require('express'), session = require('express-session'), PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet'), rateLimit = require('express-rate-limit'), bcrypt = require('bcryptjs'), crypto = require('crypto'), path = require('path');
const { pool, migrate } = require('./db'), pesapal = require('./pesapal'), { settle } = require('./payments'), v = require('./views');
const E = process.env, prod = E.NODE_ENV === 'production', q = (t, p) => pool.query(t, p);
if (!E.SESSION_SECRET || !E.IPN_SECRET) throw new Error('SESSION_SECRET and IPN_SECRET must be set');
const log = (lvl, msg, x = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...x }));
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: { 'form-action': null } } })); // null: allow redirect to gateway after checkout POST
app.use((req, res, n) => { const s = Date.now(); res.on('finish', () => req.path !== '/health' && log('info', 'req', { m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - s })); n(); });
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(path.join(__dirname, '../public'), { maxAge: '1h' }));
app.get('/health', (req, res) => q('SELECT 1').then(() => res.send('ok')).catch(() => res.status(500).send('db down')));
app.use(rateLimit({ windowMs: 60e3, limit: 300, standardHeaders: true }));
const authLimit = rateLimit({ windowMs: 15 * 60e3, limit: 25, standardHeaders: true });
app.use(session({ store: new PgStore({ pool, createTableIfMissing: true }), secret: E.SESSION_SECRET, resave: false, saveUninitialized: false, name: 'teso.sid', cookie: { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 7 * 864e5 } }));
app.use(async (req, res, next) => {
  req.session.csrf ??= crypto.randomBytes(24).toString('hex');
  if (req.session.uid) {
    const { rows: [u] } = await q('SELECT id,email,name,phone,role,disabled FROM users WHERE id=$1', [req.session.uid]);
    if (u && !u.disabled) req.user = u; else delete req.session.uid;
  }
  const flash = req.session.flash; delete req.session.flash;
  res.page = (title, body, code = 200) => res.status(code).send(v.page({ user: req.user, csrf: req.session.csrf, flash }, { title, body }));
  res.view = (fn, ...a) => res.send(fn({ user: req.user, csrf: req.session.csrf, flash }, ...a));
  req.flash = (t, m) => (req.session.flash = { t, m });
  if (req.method === 'POST') {
    const a = Buffer.from(String(req.body?._csrf || '')), b = Buffer.from(req.session.csrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.page('Forbidden', '<div class="wrap"><h1>Session expired</h1><p>Please go back, reload and try again.</p></div>', 403);
  }
  next();
});
const need = (req, res, next) => (req.user ? next() : res.redirect('/login'));
const admin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.page('Forbidden', '<div class="wrap"><h1>Not allowed</h1></div>', 403));
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
const login = (req, uid) => new Promise((ok, no) => { const csrf = crypto.randomBytes(24).toString('hex'); req.session.regenerate(e => { if (e) return no(e); req.session.uid = uid; req.session.csrf = csrf; req.session.save(e2 => (e2 ? no(e2) : ok())); }); });

app.get('/', async (req, res) => { const { rows } = await q('SELECT * FROM plans WHERE active ORDER BY price_ugx'); res.view(v.landing, rows); });
app.get('/login', (req, res) => res.view(v.login));
app.get('/register', (req, res) => res.view(v.register));
app.post('/register', authLimit, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80), email = String(req.body.email || '').trim().toLowerCase(), phone = String(req.body.phone || '').trim().slice(0, 20), pw = String(req.body.password || '');
  if (!name || !emailOk(email) || pw.length < 10 || pw.length > 128) { req.flash('err', 'Enter a name, a valid email and a password of at least 10 characters.'); return res.redirect('/register'); }
  const { rows: [u] } = await q('INSERT INTO users(email,name,phone,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING RETURNING id', [email, name, phone, await bcrypt.hash(pw, 12)]);
  if (!u) { req.flash('err', 'That email is already registered. Try logging in.'); return res.redirect('/register'); }
  await login(req, u.id); res.redirect('/dashboard');
});
app.post('/login', authLimit, async (req, res) => {
  const { rows: [u] } = await q('SELECT * FROM users WHERE email=$1', [String(req.body.email || '').trim().toLowerCase()]);
  const ok = await bcrypt.compare(String(req.body.password || ''), u?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!u || !ok || u.disabled) { req.flash('err', 'Invalid email or password.'); return res.redirect('/login'); }
  await login(req, u.id); res.redirect(u.role === 'admin' ? '/admin' : '/dashboard');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
app.get('/forgot', (req, res) => res.view(v.forgot));
app.post('/forgot', authLimit, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), t = crypto.randomBytes(32).toString('hex');
  const { rowCount } = await q("UPDATE users SET reset_hash=$2, reset_expires=now()+interval '1 hour' WHERE email=$1 AND NOT disabled", [email, crypto.createHash('sha256').update(t).digest('hex')]);
  if (rowCount) {
    const link = `${E.APP_URL}/reset/${t}`;
    if (E.SMTP_HOST) require('nodemailer').createTransport({ host: E.SMTP_HOST, port: +E.SMTP_PORT || 587, auth: E.SMTP_USER ? { user: E.SMTP_USER, pass: E.SMTP_PASS } : undefined })
      .sendMail({ from: E.MAIL_FROM, to: email, subject: 'Reset your Teso Market password', text: `Reset link (valid 1 hour): ${link}` }).catch(e => log('error', 'mail failed', { err: e.message }));
    else log('warn', 'SMTP not configured; reset link not emailed', { link });
  }
  req.flash('ok', 'If that email exists, a reset link has been sent.'); res.redirect('/login');
});
app.get('/reset/:t', (req, res) => res.view(v.reset, req.params.t));
app.post('/reset/:t', authLimit, async (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 10 || pw.length > 128) { req.flash('err', 'Password must be at least 10 characters.'); return res.redirect('/reset/' + req.params.t); }
  const h = crypto.createHash('sha256').update(req.params.t).digest('hex');
  const { rowCount } = await q('UPDATE users SET password_hash=$2, reset_hash=NULL, reset_expires=NULL WHERE reset_hash=$1 AND reset_expires>now()', [h, await bcrypt.hash(pw, 12)]);
  req.flash(rowCount ? 'ok' : 'err', rowCount ? 'Password updated. Please log in.' : 'Reset link is invalid or expired.'); res.redirect('/login');
});

app.get('/dashboard', need, async (req, res) => {
  const [plans, orders, sub] = await Promise.all([
    q('SELECT * FROM plans WHERE active ORDER BY price_ugx'),
    q('SELECT o.*, p.name plan FROM orders o JOIN plans p ON p.id=o.plan_id WHERE o.user_id=$1 ORDER BY o.created_at DESC LIMIT 50', [req.user.id]),
    q('SELECT s.*, p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 ORDER BY s.ends_at DESC LIMIT 1', [req.user.id])]);
  res.view(v.dashboard, { plans: plans.rows, orders: orders.rows, sub: sub.rows[0] });
});
app.post('/account', need, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80); if (!name) { req.flash('err', 'Name is required.'); return res.redirect('/dashboard'); }
  await q('UPDATE users SET name=$2, phone=$3 WHERE id=$1', [req.user.id, name, String(req.body.phone || '').trim().slice(0, 20)]); req.flash('ok', 'Account updated.'); res.redirect('/dashboard');
});
app.post('/account/password', need, authLimit, async (req, res) => {
  const { rows: [u] } = await q('SELECT password_hash FROM users WHERE id=$1', [req.user.id]), pw = String(req.body.password || '');
  if (!(await bcrypt.compare(String(req.body.current || ''), u.password_hash)) || pw.length < 10 || pw.length > 128) { req.flash('err', 'Current password is wrong or the new one is too short.'); return res.redirect('/dashboard'); }
  await q('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await bcrypt.hash(pw, 12)]); req.flash('ok', 'Password changed.'); res.redirect('/dashboard');
});

// ---- Payments ----
app.post('/checkout', need, async (req, res) => {
  const { rows: [p] } = await q('SELECT * FROM plans WHERE id=$1 AND active', [parseInt(req.body.plan, 10) || 0]);
  const cur = req.body.currency === 'USD' ? 'USD' : 'UGX';
  if (!p || (cur === 'USD' && !p.price_usd)) { req.flash('err', 'That plan or currency is not available.'); return res.redirect('/dashboard'); }
  if (!pesapal.configured()) { req.flash('err', 'Payments are not configured yet. The administrator must add the Pesapal credentials.'); return res.redirect('/dashboard'); }
  const { rows: [o] } = await q('INSERT INTO orders(user_id,plan_id,amount,currency) VALUES($1,$2,$3,$4) RETURNING *', [req.user.id, p.id, cur === 'USD' ? p.price_usd : p.price_ugx, cur]); // price is always read from the DB, never from the browser
  try {
    const r = await pesapal.submitOrder({ id: o.id, currency: cur, amount: o.amount, description: `Teso Market ${p.name}`, email: req.user.email, phone: req.user.phone, name: req.user.name });
    await q('UPDATE orders SET tracking_id=$2 WHERE id=$1', [o.id, r.order_tracking_id]);
    res.redirect(303, r.redirect_url);
  } catch (e) {
    log('error', 'submit order failed', { order: o.id, err: e.message }); await q("UPDATE orders SET status='failed' WHERE id=$1", [o.id]);
    req.flash('err', 'Could not start the payment. Please try again later.'); res.redirect('/dashboard');
  }
});
// Browser return: the query string is NOT trusted. We ask the gateway and show what it says.
app.get('/payment/return', async (req, res) => {
  const t = String(req.query.OrderTrackingId || ''); let o = null;
  try { if (t) o = await settle(t); } catch (e) { log('error', 'return verify failed', { err: e.message }); }
  if (!o) { const r = await q('SELECT * FROM orders WHERE tracking_id=$1', [t]); o = r.rows[0] || null; }
  res.view(v.status, o ? o.status : 'pending', o);
});
// Server-to-server webhook (IPN). Secret in path + gateway re-verification.
app.all('/payment/ipn/:secret', async (req, res) => {
  const a = Buffer.from(req.params.secret), b = Buffer.from(E.IPN_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(404);
  const src = { ...req.query, ...(req.body || {}) }, t = String(src.OrderTrackingId || '');
  try { if (t) await settle(t); res.json({ orderNotificationType: src.OrderNotificationType || 'IPNCHANGE', orderTrackingId: t, orderMerchantReference: src.OrderMerchantReference, status: 200 }); }
  catch (e) { log('error', 'ipn failed', { t, err: e.message }); res.status(500).json({ status: 500 }); } // non-200 makes the gateway retry
});
app.get('/invoice/:id', need, async (req, res) => {
  const { rows: [o] } = await q(`SELECT o.*, p.name plan, u.name uname, u.email, s.starts_at, s.ends_at,
    (SELECT confirmation_code FROM payments WHERE order_id=o.id AND confirmation_code IS NOT NULL ORDER BY id DESC LIMIT 1) confirmation_code
    FROM orders o JOIN plans p ON p.id=o.plan_id JOIN users u ON u.id=o.user_id JOIN subscriptions s ON s.order_id=o.id
    WHERE o.id::text=$1 AND o.status='paid' AND ($2 OR o.user_id=$3)`, [req.params.id, req.user.role === 'admin', req.user.id]);
  if (!o) return res.page('Not found', '<div class="wrap"><h1>Invoice not found</h1></div>', 404);
  res.view(v.invoice, o);
});

// ---- Admin ----
const planData = b => [String(b.name || '').trim().slice(0, 60), String(b.description || '').slice(0, 200), parseInt(b.price_ugx, 10), parseInt(b.price_usd, 10) || null, parseInt(b.duration_days, 10)];
const planOk = d => d[0] && d[2] > 0 && d[4] > 0 && (d[3] === null || d[3] > 0);
app.get('/admin', need, admin, async (req, res) => {
  const [plans, users, orders] = await Promise.all([q('SELECT * FROM plans ORDER BY id'), q('SELECT * FROM users ORDER BY id'),
    q('SELECT o.*, p.name plan, u.email, (SELECT count(*) FROM payments WHERE order_id=o.id) events FROM orders o JOIN plans p ON p.id=o.plan_id JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 100')]);
  res.view(v.admin, { plans: plans.rows, users: users.rows, orders: orders.rows });
});
app.post('/admin/plans', need, admin, async (req, res) => {
  const d = planData(req.body); if (!planOk(d)) req.flash('err', 'Invalid plan values.'); else { await q('INSERT INTO plans(name,description,price_ugx,price_usd,duration_days) VALUES($1,$2,$3,$4,$5)', d); req.flash('ok', 'Plan added.'); }
  res.redirect('/admin');
});
app.post('/admin/plans/:id', need, admin, async (req, res) => {
  const d = planData(req.body); if (!planOk(d)) req.flash('err', 'Invalid plan values.'); else { await q('UPDATE plans SET name=$2,description=$3,price_ugx=$4,price_usd=$5,duration_days=$6,active=$7 WHERE id=$1', [parseInt(req.params.id, 10), ...d, !!req.body.active]); req.flash('ok', 'Plan saved.'); }
  res.redirect('/admin');
});
app.post('/admin/users/:id', need, admin, async (req, res) => {
  const id = parseInt(req.params.id, 10); if (id === req.user.id) return res.redirect('/admin');
  if (req.body.act === 'toggle') await q('UPDATE users SET disabled = NOT disabled WHERE id=$1', [id]);
  else if (req.body.act === 'role') await q("UPDATE users SET role = CASE role WHEN 'admin' THEN 'customer' ELSE 'admin' END WHERE id=$1", [id]);
  res.redirect('/admin');
});
app.use((req, res) => res.page('Not found', '<div class="wrap narrow center"><h1>404</h1><p>Page not found.</p><a class="btn" href="/">Home</a></div>', 404));
app.use((err, req, res, next) => { log('error', 'unhandled', { err: err.stack }); res.headersSent ? next(err) : res.page('Error', '<div class="wrap narrow center"><h1>Something went wrong</h1><p>Please try again.</p></div>', 500); });

async function bootstrapAdmin() {
  if (!E.ADMIN_EMAIL || !E.ADMIN_PASSWORD) return;
  await q("INSERT INTO users(email,name,password_hash,role) VALUES($1,'Administrator',$2,'admin') ON CONFLICT (email) DO NOTHING", [E.ADMIN_EMAIL.toLowerCase(), await bcrypt.hash(E.ADMIN_PASSWORD, 12)]);
}
module.exports = app;
if (require.main === module) migrate().then(bootstrapAdmin).then(() => app.listen(E.PORT || 3000, () => log('info', 'listening', { port: E.PORT || 3000, pesapal: pesapal.configured() ? E.PESAPAL_ENV : 'NOT CONFIGURED' }))).catch(e => { console.error(e); process.exit(1); });

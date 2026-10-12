// Pesapal API v3 client. Only file that knows about the gateway.
const E = process.env;
const base = () => (E.PESAPAL_ENV === 'live' ? 'https://pay.pesapal.com/v3' : 'https://cybqa.pesapal.com/pesapalv3');
let tok = { v: null, exp: 0 }, ipn = null;
async function call(p, { method = 'GET', body, auth = true } = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth) h.Authorization = 'Bearer ' + (await token());
  const r = await fetch(base() + p, { method, headers: h, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Pesapal ${p} failed: ${r.status} ${JSON.stringify(j.error || j)}`);
  return j;
}
async function token() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  if (!exports.configured()) throw new Error('Pesapal credentials not configured');
  const j = await call('/api/Auth/RequestToken', { method: 'POST', auth: false, body: { consumer_key: E.PESAPAL_CONSUMER_KEY, consumer_secret: E.PESAPAL_CONSUMER_SECRET } });
  tok = { v: j.token, exp: Date.now() + 4 * 60 * 1000 };
  return tok.v;
}
async function ipnId() {
  if (E.PESAPAL_IPN_ID) return E.PESAPAL_IPN_ID;
  if (ipn) return ipn;
  const j = await call('/api/URLSetup/RegisterIPN', { method: 'POST', body: { url: `${E.APP_URL}/payment/ipn/${E.IPN_SECRET}`, ipn_notification_type: 'GET' } });
  return (ipn = j.ipn_id);
}
exports.configured = () => !!(E.PESAPAL_CONSUMER_KEY && E.PESAPAL_CONSUMER_SECRET);
exports.submitOrder = async o => call('/api/Transactions/SubmitOrderRequest', { method: 'POST', body: {
  id: o.id, currency: o.currency, amount: Number(o.amount), description: o.description.slice(0, 100),
  callback_url: `${E.APP_URL}/payment/return`, notification_id: await ipnId(),
  billing_address: { email_address: o.email, phone_number: o.phone || '', first_name: o.name } } });
// Authoritative status lookup: status_code 1=completed, 2=failed, 3=reversed, 0=invalid/pending
exports.getStatus = t => call('/api/Transactions/GetTransactionStatus?orderTrackingId=' + encodeURIComponent(t));

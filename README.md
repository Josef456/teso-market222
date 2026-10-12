# Teso Market

Subscription platform: landing page, auth, customer dashboard, admin dashboard and Pesapal payments (UGX/USD).
Stack: Node 20+, Express 5, PostgreSQL, server-rendered HTML (no build step).

## Run locally
1. Install Node 20+ and PostgreSQL; `createdb teso_market`.
2. `cp .env.example .env` and fill it in (use long random strings for `SESSION_SECRET` and `IPN_SECRET`).
3. `npm install && npm start` → http://localhost:3000. Migrations run automatically at startup and the admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` is created if missing.

## Pesapal setup (you must do this)
1. Create sandbox keys at https://developer.pesapal.com and put them in `PESAPAL_CONSUMER_KEY` / `PESAPAL_CONSUMER_SECRET` with `PESAPAL_ENV=sandbox`.
2. Register a live merchant account at pesapal.com and complete their business approval. Then set `PESAPAL_ENV=live` with the live keys.
3. `APP_URL` must be the public HTTPS address of the app. Pesapal calls `APP_URL/payment/ipn/<IPN_SECRET>`, and the app registers this IPN URL automatically (or set `PESAPAL_IPN_ID` if you registered it yourself).
4. Testing locally: Pesapal cannot reach `localhost`, so expose it with a tunnel (e.g. `ngrok http 3000`) and set `APP_URL` to the tunnel URL. Without the webhook, the "Check status" link and return page still verify with the gateway.

Until credentials are set, checkout shows "Payments are not configured" and nothing is faked.

## How payment safety works
- Prices come from the database, never the browser. Orders start `pending`.
- Only a gateway status lookup (`GetTransactionStatus`) can mark an order `paid`, from the webhook or the return page. Query strings and redirects are ignored.
- Amount and currency must match the order, otherwise it is flagged `review`.
- Settlement runs in a locked transaction with a unique `subscriptions.order_id`, so duplicate webhooks cannot double-extend.
- Every gateway verification is stored in `payments`. No card data is ever received or stored.

## Deploy on Render
1. Push this folder to GitHub, then Render → New → Blueprint → select the repo (uses `render.yaml`).
2. Fill the prompted variables: `APP_URL` (your final https URL), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, Pesapal keys.
3. **Database persistence:** the blueprint uses Render's free Postgres, which expires after about 30 days. Change `plan:` in `render.yaml` (or upgrade in the dashboard) to a paid plan before real customers use it. Data then survives restarts and redeploys. Sessions are in Postgres too.
4. Custom domain: Render service → Settings → Custom Domains → add `teso.market` (or yours), create the DNS records Render shows, then update `APP_URL`. HTTPS certificates are issued automatically by Render.

## Tests
`TEST_DATABASE_URL=postgres://user:pass@localhost/teso_test npm test` (use a throw-away database). Covers registration/login/CSRF, duplicate webhooks, amount mismatch, redirect-only payments, renewal and expiry. The gateway is stubbed in tests; do a manual sandbox payment too.

## Notes
- Plans renew manually (new period is added after current expiry). Pesapal recurring tokens are not wired in.
- Password-reset emails need SMTP settings; otherwise the link is printed to the server log.
- Seed plans (migration 001) are placeholders. Edit them in /admin.

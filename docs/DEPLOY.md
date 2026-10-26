# Setting up sign-in, payments and a live server

Three parts, in the order you need them:

1. [Sign in with Google and GitHub](#1-sign-in-with-google-and-github) (OAuth)
2. [Host plans with Razorpay](#2-host-plans-with-razorpay)
3. [Putting VoidRun live](#3-putting-voidrun-live) on your own domain with HTTPS

Every setting goes in the root `.env` file (copy `.env.example`). It is ignored
by git, so secrets never get committed. After changing it, restart:
`make up` locally, `make prod-up` on the server.

In the steps below, **ORIGIN** is where people open the site:

| Where | ORIGIN |
|---|---|
| Your laptop (`make up`) | `http://localhost:5173` |
| The live server | `https://your-domain.com` |

---

## 1. Sign in with Google and GitHub

Each provider's button appears once both its client id and secret are set.
Email and password sign-in always works, with or without these.

### Google

1. Open <https://console.cloud.google.com/>, create a project (top bar → *New project*).
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app
   name (VoidRun), your support email and developer email. Scopes: add `openid`,
   `email` and `profile`. While the app is in *Testing*, add your Google account
   under *Test users*; choose *Publish app* when you go live.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type *Web application*:
   - **Authorised JavaScript origins:** `ORIGIN`
   - **Authorised redirect URIs:** `ORIGIN/login/oauth2/code/google`

   You can add both the localhost and the live values to the same client.
4. Copy the client id and secret into `.env`:

   ```
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

### GitHub

1. <https://github.com/settings/developers> → **OAuth Apps → New OAuth App**.
2. **Homepage URL:** `ORIGIN`. **Authorization callback URL:**
   `ORIGIN/login/oauth2/code/github`.

   A GitHub OAuth app has exactly one callback URL, so make one app for
   localhost and another for the live site.
3. **Generate a new client secret**, then put both in `.env`:

   ```
   GITHUB_CLIENT_ID=Ov23li...
   GITHUB_CLIENT_SECRET=...
   ```

### Also set

```
FRONTEND_URL=ORIGIN
```

The API sends the browser back here after a provider sign-in.

**Checking it:** restart, open the sign-in page, and the buttons appear.
If Google says `redirect_uri_mismatch`, the redirect URI in step 3 doesn't
match `ORIGIN/login/oauth2/code/google` exactly. Check for `http` vs `https`, a
missing port, or a trailing slash.

---

## 2. Host plans with Razorpay

Publishing a contest needs an active Host plan. That covers creating a contest
and making it public. Practice, debugging and competing stay free. The plans
are Host Monthly (₹499, 30 days) and Host Yearly (₹4,999, 365 days); change
the prices with `HOST_MONTHLY_PAISE` and `HOST_YEARLY_PAISE` (₹1 = 100 paise).

### Without Razorpay: test payments (the default locally)

With no Razorpay keys, plans are bought through VoidRun's own **test
checkout**. It looks like a payment sheet, the plan starts at once, and no
money moves. Payments made this way are marked **Test** in the payment
history. This is `TEST_PAYMENTS=true`, the local default; you need no account
and no setup. `docker-compose.prod.yml` always turns it off, so a live site
never hands out free plans.

Admins host without a plan: `make make-admin NAME=your-username`, then sign
out and back in. To make hosting free for everyone instead (a private server,
say), set `HOST_PLAN_REQUIRED=false`.

### Real payments: Razorpay in test mode first

Adding Razorpay keys replaces the test checkout with Razorpay's.

1. Sign up at <https://dashboard.razorpay.com/>. You land in **Test mode**
   (toggle at the top); test payments move no real money.
2. **Account & Settings → API Keys → Generate test key.** Copy the
   **Key Id** (starts with `rzp_test_`) and the **Key Secret** (shown once).
3. In `.env`:

   ```
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   ```
4. Restart, open **/pricing**, pick a plan. In Razorpay's checkout use a
   [test card](https://razorpay.com/docs/payments/payments/test-card-details/)
   (e.g. `4111 1111 1111 1111`, any future expiry, any CVV) or the test UPI id
   `success@razorpay`. The page shows *Payment received. Hosting is on*, and
   "Host a contest" works.

### Webhook (recommended)

Checkout reports success to the server, which checks Razorpay's signature. The
webhook is a second, server-to-server confirmation. It still counts the payment
when someone closes the tab right after paying.

1. **Account & Settings → Webhooks → Add new webhook**
   - **URL:** `ORIGIN/api/v1/billing/webhook` (it must be public HTTPS; see
     below for localhost)
   - **Secret:** any long random string (`openssl rand -hex 24`)
   - **Events:** `payment.captured`, `order.paid`, `payment.failed`
2. Put the same secret in `.env`:

   ```
   RAZORPAY_WEBHOOK_SECRET=...
   ```

On your laptop, Razorpay can't reach `localhost`, so give it a temporary public
URL:

```bash
cloudflared tunnel --url http://localhost:5173
```

That prints an `https://….trycloudflare.com` address; use it as the webhook
URL's origin. A payment confirmed both ways extends the plan only once.

### Going live with real money

1. In the dashboard, complete **activation**: business details, PAN, bank
   account. Razorpay reviews it, usually within a few days.
2. Switch to **Live mode**, generate **live keys** (`rzp_live_…`) and add a
   live webhook the same way.
3. Replace the test keys in the server's `.env` and run `make prod-up`.
4. Razorpay asks for a privacy policy, terms and a refund policy on your
   site before activation. Write them for your business.

---

## 2b. Email sign-in codes and "Forgot password"

On the sign-in page, **Email me a code** signs in with a six-digit code, and
**Forgot password?** sets a new password the same way. A code works once, for
ten minutes, and is burned after five wrong guesses; asking for one never
reveals whether an account has that address.

- **Locally** nothing is needed: `make up` starts **Mailpit**, which catches every
  email. Open <http://localhost:8025> to read the codes.
- **Real mail**: set an SMTP server in `.env` (`MAIL_HOST`, `MAIL_PORT`,
  `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM`, and `MAIL_SMTP_AUTH=true`,
  `MAIL_STARTTLS=true`), then `make up`. Gmail: an app password from
  <https://myaccount.google.com/apppasswords>, host `smtp.gmail.com`, port 587.
- **Running the API outside Docker** (`make api`) without `MAIL_HOST`, codes are
  written to the API log instead. Production never does that: without SMTP the
  email options are hidden.

## 3. Putting VoidRun live

On Microsoft Azure? Follow [DEPLOY-AZURE.md](DEPLOY-AZURE.md): the same setup,
click by click, with a free `cloudapp.azure.com` domain.

VoidRun runs well on **one Linux server with Docker**. The judge starts a
sandbox container for every run, so it needs a real Docker host. Platforms like
Vercel, Netlify or Heroku can't run it.

### What you need

- **A server:** Ubuntu 24.04, at least **4 GB RAM / 2 vCPU** (8 GB is
  comfortable for live contests), 40 GB disk. Any provider works: DigitalOcean,
  Hetzner, AWS Lightsail/EC2, Google Cloud, Azure, Linode.
- **A domain**, e.g. `voidrun.example.com`.

### Steps

1. **Point the domain at the server.** At your domain registrar add an **A
   record**: name `voidrun` (or `@` for the bare domain) → the server's public
   IP. Wait until `ping voidrun.example.com` shows that IP.

2. **Open the firewall** for ports **22** (SSH), **80** and **443** only. On
   Ubuntu: `sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable`.
   Also allow them in your provider's cloud firewall if it has one.

3. **Install Docker** on the server:

   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER   # then log out and back in
   sudo apt-get install -y make git
   ```

4. **Get the code** onto the server, e.g. push your repo to GitHub and:

   ```bash
   git clone https://github.com/<you>/<repo>.git voidrun && cd voidrun
   cp .env.example .env
   ```

5. **Fill in `.env`** (`nano .env`). At minimum:

   ```
   DOMAIN=voidrun.example.com
   FRONTEND_URL=https://voidrun.example.com
   JWT_SECRET=<openssl rand -hex 32>
   POSTGRES_PASSWORD=<openssl rand -hex 24>
   ```

   Plus the Google, GitHub and Razorpay values from parts 1 and 2, using
   `https://voidrun.example.com` as ORIGIN. Generate fresh secrets for the
   server. Don't reuse local ones, and replace the old JWT secret that was once
   committed to this repo's history.

6. **Start it:**

   ```bash
   make prod-up
   ```

   This builds the two sandbox images and starts everything with
   `docker-compose.prod.yml`. Caddy gets an HTTPS certificate from Let's Encrypt
   on its own; the first start takes a few minutes. Open
   `https://voidrun.example.com`.

7. **Make yourself admin:** register on the site, then
   `make make-admin NAME=<your username>` and sign in again.

### What the production setup changes

`docker-compose.prod.yml` layers on top of `docker-compose.yml`:

- **Caddy** is the only public service (ports 80/443). It handles HTTPS and
  renewals, and forwards to the web container.
- **PostgreSQL, Redis, Kafka and the API** are not exposed to the internet;
  they only talk to each other on Docker's private network.
- **The stack refuses to start** without `JWT_SECRET`, `POSTGRES_PASSWORD`,
  `FRONTEND_URL` and `DOMAIN`.

### Running it day to day

| Task | Command |
|---|---|
| Deploy a new version | `git pull && make prod-up` |
| Watch the logs | `make prod-logs` |
| Status | `docker compose ps` |
| Stop | `make prod-down` (data is kept) |
| Back up the database | `docker compose exec -T postgres pg_dump -U voidrun voidrun \| gzip > backup-$(date +%F).sql.gz` |
| Restore a backup | `gunzip -c backup.sql.gz \| docker compose exec -T postgres psql -U voidrun voidrun` |

Copy backups off the server, e.g. to object storage, with a daily cron job.
The database is the only thing worth backing up: Redis holds rate-limit
counters and Kafka holds jobs in flight.

### Before inviting people

- [ ] Fresh `JWT_SECRET` and `POSTGRES_PASSWORD` on the server
- [ ] Google consent screen published, redirect URIs use `https://`
- [ ] Razorpay live keys and live webhook (or Razorpay test keys while you trial
      it). Without keys no plan can be bought there, because the built-in test
      checkout is off in production.
- [ ] Privacy policy, terms and refund policy pages
- [ ] Daily database backup copied off the server
- [ ] Only ports 22, 80 and 443 open; SSH with keys, not passwords

### Growing later

One server carries a lot: each live contest gets its own judge pool. When
contests get big, the usual next steps are:

- a managed PostgreSQL (point `DATABASE_URL` at it);
- more worker servers. Run only the `worker` service on extra machines with
  Docker, pointed at the same Kafka and database. Each adds judging capacity,
  and Kafka spreads the jobs. This needs Kafka and PostgreSQL reachable from
  those machines over a private network, and Kafka's advertised listener set
  to that address.

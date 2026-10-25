# Putting VoidRun live on Microsoft Azure

From the code on your laptop to `https://<name>.<region>.cloudapp.azure.com`:
one Azure virtual machine runs the whole stack with Docker. The judge starts a
sandbox container for every run, so it needs a real Docker host (a VM), not
App Service or Container Apps.

**Cost.** A `Standard_B2ms` VM (2 vCPU, 8 GB) is about US$60 a month, `Standard_B2s`
(4 GB) about half that. As a student, *Azure for Students* gives US$100 of credit
with no card: <https://azure.microsoft.com/free/students>. Stop the VM when you
don't need it (step 12).

---

## 1. Push the code to GitHub

On your laptop, in the project folder:

```bash
git status            # check what is included; .env must NOT be listed
git add -A
git commit -m "VoidRun"
git push origin main
```

`.env` (your keys) is ignored by git, so it never leaves your laptop. The only
template is `.env.example` at the root; never put real keys in it.

If the repository is private, the server will need access to clone it. The
simplest is a read-only *deploy key*:

```bash
# on the server, after step 4
ssh-keygen -t ed25519 -f ~/.ssh/github -N ""
cat ~/.ssh/github.pub
```

Paste it at GitHub → your repo → **Settings → Deploy keys → Add deploy key** (read access), then clone with
`GIT_SSH_COMMAND="ssh -i ~/.ssh/github" git clone git@github.com:<you>/<repo>.git voidrun`.

## 2. Create the virtual machine

Azure Portal (<https://portal.azure.com>) → **Virtual machines → Create → Azure virtual machine**.

| Setting | Value |
|---|---|
| Resource group | Create new: `voidrun` |
| Virtual machine name | `voidrun` |
| Region | Closest to your users, e.g. **Central India** |
| Image | **Ubuntu Server 24.04 LTS** |
| Size | **Standard_B2ms** (8 GB), or Standard_B2s (4 GB) to save money |
| Authentication | **SSH public key**, username `azureuser`, "Use existing public key": paste the output of `cat ~/.ssh/id_ed25519.pub` from your Mac |
| Inbound ports | **SSH (22), HTTP (80), HTTPS (443)** |
| Disks | OS disk **64 GB**, Standard SSD |

**Review + create → Create.** It takes a minute or two.

## 3. Give it a fixed address and a free domain name

VM → **Overview → Public IP address** (click the IP):

1. **Configuration → Assignment: Static** → Save, so the address never changes.
2. **DNS name label:** e.g. `voidrun-karthick` → Save.

Your site's address is now `voidrun-karthick.<region>.cloudapp.azure.com`, e.g.
`voidrun-karthick.centralindia.cloudapp.azure.com`, shown as **DNS name** on that page.
This is **DOMAIN** below. (Have your own domain? Add an A record pointing at the
static IP and use that instead.)

## 4. Connect and prepare the server

```bash
ssh azureuser@<DOMAIN>
```

Then, on the server:

```bash
# Docker, Compose, git and make
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
sudo apt-get update && sudo apt-get install -y git make

# 4 GB of swap, so building the images never runs out of memory
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

exit   # log out and back in so the docker group applies
```

```bash
ssh azureuser@<DOMAIN>
docker run --rm hello-world     # should print "Hello from Docker!"
```

## 5. Get the code

```bash
git clone https://github.com/<you>/<repo>.git voidrun     # or the deploy-key command from step 1
cd voidrun
cp .env.example .env
```

## 6. Fill in `.env` on the server

```bash
openssl rand -hex 32   # copy for JWT_SECRET
openssl rand -hex 24   # copy for POSTGRES_PASSWORD
nano .env
```

Set at least:

```
DOMAIN=voidrun-karthick.centralindia.cloudapp.azure.com
FRONTEND_URL=https://voidrun-karthick.centralindia.cloudapp.azure.com
JWT_SECRET=<the first value>
POSTGRES_PASSWORD=<the second value>
```

Use **new** secrets here, not the ones from your laptop. Save with Ctrl+O, Enter, Ctrl+X.

Sign-in and payments (steps 9 and 10) can be added now or later.

## 7. Start it

```bash
make prod-up
```

The first run builds the sandbox images, the API, the worker and the web app
(10–20 minutes), then starts everything. Caddy fetches an HTTPS certificate from
Let's Encrypt by itself. When it prints `live at https://…`, open that address.

If the page doesn't load: `make prod-logs` shows the API, worker and Caddy logs;
`docker compose ps` shows what is running.

## 8. Make yourself the admin

Register on the live site, then on the server:

```bash
make make-admin NAME=<your username>
```

Sign out and back in. Admins can host contests without a plan.

## 9. Sign in with Google and GitHub on the live site

**Google** (<https://console.cloud.google.com/apis/credentials> → your OAuth client):

- Authorised JavaScript origins: add `https://<DOMAIN>`
- Authorised redirect URIs: add `https://<DOMAIN>/login/oauth2/code/google`
- **OAuth consent screen → Publish app**, so anyone can sign in (in *Testing* only test users can).

**GitHub:** a GitHub OAuth app has one callback URL, so create a **second** app
for the live site (<https://github.com/settings/developers> → New OAuth App):

- Homepage URL: `https://<DOMAIN>`
- Authorization callback URL: `https://<DOMAIN>/login/oauth2/code/github`

Put the values in the server's `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`), then `make prod-up`.

## 10. Payments (Host plans)

On the live site the built-in test checkout is always off. Until Razorpay keys
are set, nobody can buy a plan and only admins host. To take payments:

1. Razorpay dashboard → API Keys → generate keys (test keys `rzp_test_…` to try it,
   live keys `rzp_live_…` after account activation).
2. Webhooks → add `https://<DOMAIN>/api/v1/billing/webhook` for `payment.captured`,
   `order.paid`, `payment.failed`, with a secret of your choice.
3. In `.env`: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; then `make prod-up`.

To make hosting free for everyone instead: `HOST_PLAN_REQUIRED=false`.

## 11. Shipping updates

On your laptop: commit and `git push`. Then on the server:

```bash
cd ~/voidrun && git pull && make prod-up
```

Data (users, problems, contests) lives in Docker volumes and survives updates.

## 12. Running it day to day

| Task | How |
|---|---|
| Logs | `make prod-logs` |
| Status | `docker compose ps` |
| Back up the database | `docker compose exec -T postgres pg_dump -U voidrun voidrun \| gzip > backup-$(date +%F).sql.gz` |
| Copy a backup to your Mac | `scp azureuser@<DOMAIN>:voidrun/backup-*.sql.gz .` |
| Save money when idle | Portal → VM → **Stop** (stops billing for compute; the disk and IP stay). **Start** brings it back; run `make prod-up` if anything isn't up. |
| Auto-shutdown each night | VM → **Auto-shutdown** → on, pick a time |
| Watch spending | Portal → **Cost Management → Budgets** → add a monthly budget with an email alert |

### Before inviting people

- [ ] New `JWT_SECRET` and `POSTGRES_PASSWORD` on the server (step 6)
- [ ] Google and GitHub secrets that were ever pasted anywhere public regenerated
- [ ] Google consent screen published; live redirect URIs added
- [ ] A budget alert set in Cost Management
- [ ] A database backup copied off the server

# DEPLOY.md — Deploying app.babylontoolkit.com to AWS

Step-by-step runbook for deploying the Babylon Toolkit App Builder (bolt.diy fork) to AWS per spec/hosting.md: **Lightsail Container Service** for the Remix app, **S3 + CloudFront** for snapshots and the isolated play origin, **SSM Parameter Store** for secrets. Written for staging first; prod is the same steps with different names. Commands use AWS CLI v2 (`aws configure` with an admin profile for one-time setup; CI uses a scoped IAM user).

> Verify current AWS pricing/limits before committing budgets — numbers here are ballpark. Region examples use `us-west-2`; pick the region closest to your users and keep everything in it.

---

## 0. Prerequisites

> **Local development needs NONE of this.** Per SPEC §1.3 principle 0 (build-first), the app runs with `S3_*`/`STRIPE_*`/`ANTHROPIC_API_KEY` unset — storage falls back to a local-filesystem adapter and unconfigured features show clear "not configured" states. Dev secrets, when you do use them, go in **`.env.local`** (gitignored — verify!) pointing at **separate dev buckets**. This runbook is for staging/prod.


- [ ] AWS account access (existing account), AWS CLI v2 installed and configured
- [ ] Docker installed locally (for first manual build) — CI does it thereafter
- [ ] The fork builds locally: `pnpm install && pnpm run build`
- [ ] Supabase project created per env (SPEC Appendix A.3) — you'll need URL + keys
- [ ] Stripe test keys (staging) / live keys (prod, Phase 3)
- [ ] Domain DNS access for babylontoolkit.com (wherever it's managed today)
- [ ] A SECOND registrable domain for the play origin (SPEC §5 isolation — a different domain entirely, not a subdomain; e.g., register a cheap `*-play` domain)

---

## 1. One-time AWS foundation

### 1.1 IAM

Create two identities (Console → IAM):

1. **`btk-ci-deploy` (user, programmatic):** policy allowing Lightsail container push/deploy (`lightsail:PushContainerImage`, `lightsail:CreateContainerServiceDeployment`, `lightsail:GetContainerServices`, `lightsail:GetContainerImages`) — access key goes into GitHub Actions secrets.
2. **`btk-app-runtime` (user or role, programmatic):** least-privilege policy — `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on ONLY the two buckets below, plus `ssm:GetParameter`/`GetParameters` on the `/btk/*` parameter path if reading SSM at boot. Its keys become the app's env credentials.

Never use account-root keys anywhere.

### 1.2 S3 buckets (per env)

```bash
aws s3api create-bucket --bucket btk-snapshots-staging --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2
aws s3api create-bucket --bucket btk-play-builds-staging --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

# Block ALL public access on BOTH (CloudFront reaches play-builds via OAC, never public):
aws s3api put-public-access-block --bucket btk-snapshots-staging \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-public-access-block --bucket btk-play-builds-staging \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Lifecycle policies (Console or CLI): snapshots — expire superseded snapshots per retention config (start: keep last 20 per project, or 90 days); play-builds — none (deleted programmatically on unpublish).

### 1.3 CloudFront play origin (isolated domain)

1. Register/choose the separate play domain (e.g., `btkplay.example`). **Do not use a babylontoolkit.com subdomain** — cookie isolation is the whole point.
2. ACM (in **us-east-1** — CloudFront requires it): request a certificate for `play.<playdomain>` (or apex), validate via DNS.
3. Create a CloudFront distribution:
   - Origin: `btk-play-builds-staging.s3.us-west-2.amazonaws.com` with **Origin Access Control (OAC)** — create OAC, then apply the generated bucket policy S3 suggests (allows only this distribution to read).
   - Alternate domain name: your play host; attach the ACM cert.
   - Default behavior: GET/HEAD only, cache enabled, compress on.
   - No default root object (builds live under `/{shareId}/`).
4. DNS: CNAME/ALIAS the play host → the distribution's `*.cloudfront.net` name.
5. Response headers policy (recommended): add `X-Frame-Options: SAMEORIGIN` off / CSP as desired for game pages; keep permissive CORS OFF here (games are same-origin to this domain).

### 1.4 SSM Parameter Store (secrets, per env)

```bash
aws ssm put-parameter --name /btk/staging/ANTHROPIC_API_KEY --type SecureString --value 'sk-ant-...'
aws ssm put-parameter --name /btk/staging/SUPABASE_URL --type String --value 'https://xxxx.supabase.co'
aws ssm put-parameter --name /btk/staging/SUPABASE_ANON_KEY --type SecureString --value '...'
aws ssm put-parameter --name /btk/staging/SUPABASE_SERVICE_ROLE_KEY --type SecureString --value '...'
aws ssm put-parameter --name /btk/staging/STRIPE_SECRET_KEY --type SecureString --value 'sk_test_...'
aws ssm put-parameter --name /btk/staging/STRIPE_WEBHOOK_SECRET --type SecureString --value 'whsec_...'
aws ssm put-parameter --name /btk/staging/LICENSE_SERVICE_URL --type String --value 'https://...'
aws ssm put-parameter --name /btk/staging/LICENSE_SERVICE_SECRET --type SecureString --value '...'
aws ssm put-parameter --name /btk/staging/SESSION_SECRET --type SecureString --value "$(openssl rand -hex 32)"
aws ssm put-parameter --name /btk/staging/GITHUB_WEBHOOK_SECRET --type SecureString --value "$(openssl rand -hex 32)"
aws ssm put-parameter --name /btk/staging/S3_SNAPSHOTS_BUCKET --type String --value 'btk-snapshots-staging'
aws ssm put-parameter --name /btk/staging/S3_PLAY_BUCKET --type String --value 'btk-play-builds-staging'
aws ssm put-parameter --name /btk/staging/APP_URL --type String --value 'https://staging.app.babylontoolkit.com'
aws ssm put-parameter --name /btk/staging/PLAY_URL --type String --value 'https://play.<playdomain>'

# Sandbox provider (CodeSandbox). The KEY is a platform secret — server-only, never VITE_-prefixed.
aws ssm put-parameter --name /btk/staging/CODESANDBOX_API_KEY --type SecureString --value 'csb_...'
```

#### CodeSandbox tunables (`CODESANDBOX_*`)

All optional — each falls back to the default below, and a nonsensical override is IGNORED rather than
obeyed (`app/lib/.server/sandbox/config.ts`). Every one of them costs money in one direction or the
other, which is why they are config and not constants.

| Variable | Default | What it decides |
|---|---|---|
| `CODESANDBOX_API_KEY` | — | **Required to serve the CodeSandbox provider.** Absent = "not configured": the app runs, the workbench reports it, nothing crashes. Mint at https://codesandbox.io/t/api with all five scopes. |
| `CODESANDBOX_TEMPLATE` | `btk@starter` | The alias each new project forks. ⚠️ **A pin promoted in Settings → Admin → Sandbox template OUTRANKS this** (plan T14) — set it while a pin exists and it is silently ignored. |
| `CODESANDBOX_VM_TIER` | `Nano` | VM size per project (raised from Pico 2026-07-28: `vite build` peaked at 1,958MB of Pico's 2,053MB). **It also sets the billing rate** — `vmUsdPerHourForTier` derives $/hr from this, so raising it is a margin decision, not just a capacity one (Nano $0.149/hr clears every pack and plan at 2.41× worst case; **Micro would put the Pro and Studio packs and ALL plans under the floor**). An unknown name is handled deliberately differently by the two subsystems: the sandbox PROVISIONS Pico (cheapest — the failure that matters is "silently ran everyone on XLarge") while billing PRICES it at the dearest measured tier (the failure that matters there is under-stating cost, which is invisible). Both are the conservative direction for their own side. |
| `CODESANDBOX_HIBERNATION_SECONDS` | `300` | Idle seconds before the VM sleeps. **The main cost lever.** Must be 1–86400; anything else falls back, because obeying `0` would bill all night. |
| `CODESANDBOX_HOST_TOKEN_MINUTES` | `60` | Preview-token life. Capped at 24h: the token is a bearer credential riding in an iframe URL, and expiry is its only mitigation — an operator typo (`60000`) would otherwise mint ~41-day tokens silently. |
| `CODESANDBOX_MAX_CREATES_PER_HOUR` | `20` | Forks one account may start per hour. Bounds a platform-wide provider budget against one runaway loop. |
| `CODESANDBOX_MAX_RUNNING_VMS` | `2` | Concurrently RUNNING sandboxes per account. Never refuses a session — it hibernates the least-recently-touched one to make room. |

`SANDBOX_VM_USD_PER_HOUR` and `SANDBOX_EST_VM_HOURS_PER_KCREDIT` are billing inputs, not provider
config — see `spec/billing.md`. They are asserted against the pack/plan margin floor at test time and
are not read at runtime.

(Lightsail deployments take env vars directly; simplest launch path is injecting these values into the deployment config from CI via `aws ssm get-parameters`. Reading SSM at boot from the app is the later refinement.)

> 🔴 **A variable in the container env only reaches the app if it is NAMED in `worker-configuration.d.ts`.**
> The image starts with `pnpm run dockerstart` → `bindings.sh` → `wrangler pages dev`, and the app runs
> under **workerd, where `process.env` is empty**. `bindings.sh` greps that file for names and forwards
> only those it finds set, as `--binding NAME=value`. MEASURED (2026-07-28): before this was fixed the
> file listed only upstream's provider keys, so a production container would have booted with **no
> Supabase, no Stripe, no S3, no KIE key and no CodeSandbox key** — and because every one of those
> degrades to "not configured" rather than crashing, it would have served happily while being unable to
> bill, authenticate, or open a sandbox.
>
> **Adding an `env(context, 'NEW_VAR')` read means adding the name to `worker-configuration.d.ts`.**
> Listing an unset name costs nothing; omitting a set one is a silent outage.

---

## 2. Lightsail Container Service

### 2.1 Create the service (once per env)

```bash
aws lightsail create-container-service \
  --service-name btk-builder-staging \
  --power micro --scale 1 --region us-west-2
# powers: nano($) → micro → small → medium...; start micro (~$10/mo), bump power before adding nodes
aws lightsail get-container-services --service-name btk-builder-staging   # wait for READY
```

### 2.2 Build & push the image (first time manually; CI thereafter)

> 🔴 **`VITE_SANDBOX_PROVIDER` is a BUILD ARG, not an environment variable.** Vite inlines
> `import.meta.env.VITE_SANDBOX_PROVIDER` into the client bundle and `WORK_DIR` is derived from it, so
> which sandbox runtime a deploy uses is baked into the JavaScript the browser downloads. **Setting it on
> a running container does nothing** except make the server disagree with its own bundle.
>
> **Rollback is "deploy the previous image", never an env flip.** Unset or misspelled builds WebContainer,
> which is the safe direction.

```bash
# CodeSandbox build (what production runs):
docker build --build-arg VITE_SANDBOX_PROVIDER=codesandbox -t btk-builder .

# WebContainer build (omit the arg — this is also the rollback image):
# docker build -t btk-builder .

aws lightsail push-container-image \
  --service-name btk-builder-staging \
  --label app --image btk-builder
# Note the returned image ref, e.g. ":btk-builder-staging.app.7"
```

> ⚠️ **Omitting the arg is only reliable INSIDE Docker.** `.dockerignore` excludes `*.local`, so the image
> build sees no `.env.local` and the build arg is the single source of truth. A build on a developer's
> machine does NOT have that guarantee — Vite loads `.env.local`, so `pnpm build` there silently inherits
> whatever `VITE_SANDBOX_PROVIDER` that file sets (MEASURED while writing this: a "control" build with no
> arg produced a CodeSandbox bundle). To force a value locally, pass it explicitly:
> `VITE_SANDBOX_PROVIDER=webcontainer pnpm build` — a process env var wins over `.env.local`.
>
> **How to tell which one you built** (MEASURED): look for the provider CHUNK, not for a path string.
> A WebContainer build emits `build/client/assets/webcontainer-provider-*.js`; a CodeSandbox build does
> not emit it at all (the flag folds to a constant and Rollup drops the branch), which is also what makes
> "no WebContainer WASM is ever fetched" true by absence rather than merely at runtime.
>
> ⚠️ Do NOT grep for `/home/project` to tell them apart — it appears in BOTH bundles (`SANDBOX_ROOTS`
> lists every root a file map may carry, plus two literals in `Chat.client`). The path strings are not
> discriminating; the chunk is.

### 2.3 Deploy

Create `deployment-staging.json` (CI renders this template with SSM values):

```json
{
  "containers": {
    "app": {
      "image": ":btk-builder-staging.app.7",
      "ports": { "5173": "HTTP" },
      "environment": {
        "NODE_ENV": "production",
        "APP_URL": "https://staging.app.babylontoolkit.com",
        "PLAY_URL": "https://play.<playdomain>",
        "ANTHROPIC_API_KEY": "<from SSM>",
        "SUPABASE_URL": "<from SSM>",
        "SUPABASE_ANON_KEY": "<from SSM>",
        "SUPABASE_SERVICE_ROLE_KEY": "<from SSM>",
        "STRIPE_SECRET_KEY": "<from SSM>",
        "STRIPE_WEBHOOK_SECRET": "<from SSM>",
        "LICENSE_SERVICE_URL": "<from SSM>",
        "LICENSE_SERVICE_SECRET": "<from SSM>",
        "SESSION_SECRET": "<from SSM>",
        "GITHUB_WEBHOOK_SECRET": "<from SSM>",
        "AWS_ACCESS_KEY_ID": "<btk-app-runtime key>",
        "AWS_SECRET_ACCESS_KEY": "<btk-app-runtime secret>",
        "AWS_REGION": "us-west-2",
        "S3_SNAPSHOTS_BUCKET": "btk-snapshots-staging",
        "S3_PLAY_BUCKET": "btk-play-builds-staging",
        "BILLING_ENFORCED": "false",
        "CODESANDBOX_API_KEY": "<from SSM>"
      }
    }
  },
  "publicEndpoint": {
    "containerName": "app",
    "containerPort": 5173,
    "healthCheck": { "path": "/healthz", "successCodes": "200", "intervalSeconds": 10, "timeoutSeconds": 5 }
  }
}
```

```bash
aws lightsail create-container-service-deployment \
  --service-name btk-builder-staging \
  --cli-input-json file://deployment-staging.json
aws lightsail get-container-services --service-name btk-builder-staging   # wait ACTIVE
```

The service gets a URL like `https://btk-builder-staging.xxxx.us-west-2.cs.amazonlightsail.com` — verify `/healthz` there before touching DNS.

> **`/healthz` reports CONFIG PRESENCE ONLY — it never makes a live network call, and that is a
> contract, not an omission** (`app/lib/.server/monitoring/health.ts`). An earlier draft of this line
> asked it to check "DB reachable, S3 credentials valid"; that is exactly the probe the endpoint refuses
> to be, because Lightsail polls it every 10s and a Supabase blip would then cycle containers and start a
> retry storm. Liveness is always `healthy`; each dependency is `ok` (configured) or `degraded` (not),
> and `ready` is true only when every dependency THIS BUILD needs is wired — which is what §9a's
> credential pass keys on. Reachability lives in the rate windows (`sandbox-rates.ts`,
> `failure-rate.ts`), where a sustained failure is an alert instead of a restart.

### 2.4 Custom domain + TLS

```bash
aws lightsail create-certificate \
  --certificate-name btk-staging-cert \
  --domain-name staging.app.babylontoolkit.com --region us-west-2
aws lightsail get-certificates --certificate-name btk-staging-cert
# → add the returned CNAME validation record at your DNS host; wait for ISSUED
aws lightsail update-container-service \
  --service-name btk-builder-staging \
  --public-domain-names '{"btk-staging-cert":["staging.app.babylontoolkit.com"]}'
```

DNS: CNAME `staging.app.babylontoolkit.com` → the Lightsail service hostname. (Prod: same with `app.babylontoolkit.com` / `btk-prod-cert`.)

**Verify the sandbox runtime after DNS:** load the app on the real domain and confirm a project boots.

- **WebContainer images** need cross-origin isolation headers (COOP/COEP) — bolt.diy's server config sets
  them; if a proxy/CDN is ever placed in front, confirm it passes them through untouched.
- **CodeSandbox images do NOT** — the VM is remote, so the app drops COEP entirely (`entry.server.tsx`
  branches on the same build-time flag). Confirm the build is the one you think it is: DevTools →
  Network should show **no `.wasm` fetch for the WebContainer runtime**, and `GET /healthz` should list
  `codesandbox` in `dependencies`. That key is present ONLY on a CodeSandbox build, so its absence is the
  fastest way to catch an image built without the build arg (plan T13).

---

## 3. Webhooks & external registrations (per env)

- [ ] **Stripe:** Dashboard → Webhooks → add `https://staging.app.babylontoolkit.com/api/stripe-webhook` (test mode for staging; the route is `api.stripe-webhook` → `/api/stripe-webhook`, NOT `/api/stripe/webhook`) → copy signing secret into SSM → redeploy.
- [ ] **Supabase Auth:** set Site URL + redirect URLs to the env domain (and OAuth providers' consoles: Google/GitHub redirect URIs).
- [ ] **GitHub doc-sync webhook (Phase 3):** on `babylontoolkit/agent` and `/skills` repos → `https://.../api/admin/webhooks/github`, secret from SSM, push events only.
- [x] **CodeSandbox commercial terms — CONFIRMED by owner 2026-07-29.** VM credits are pre-purchased
      and the plan covers embedding VM previews and reselling that VM time to users. (Original gate:
      the same `spec/licensing.md` StackBlitz reasoning — the runtime is somebody else's product and
      the builder stops without it.) The measured **3,600 requests/hour** API limit stands as the
      capacity number to watch (`spec/sandbox-codesandbox.md` — it bites before concurrency; live
      creation traffic measured ~1% of it).
- [ ] **Promote the sandbox template** (Settings → Admin → Sandbox template) once per environment. A
      fresh deploy forks whatever `btk@starter` points at today; promoting pins it, and until someone
      does, a `csb build --alias` by anyone reaches every new project with no review step (plan T14).

---

## 4. CI/CD (GitHub Actions)

Repo secrets: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (the `btk-ci-deploy` user), `AWS_REGION`.

Pipeline (`.github/workflows/deploy.yml`, sketch):
1. PR → `pnpm typecheck && pnpm test && pnpm build` (+ the brand grep-gate, SPEC §2.5)
2. Merge to `main` → docker build → `aws lightsail push-container-image` (staging) → render deployment JSON (env values via `aws ssm get-parameters --with-decryption`) → `create-container-service-deployment` → poll until ACTIVE → curl `/healthz`
3. Tagged release `v*` → same against `btk-builder` (prod)

Deploy behavior note: Lightsail replaces containers on deploy → in-flight generations abort → client shows retry; ledger auto-refund covers billing (spec/billing.md). Deploy during low traffic.

---

## 5. Ops wiring (Phase 2, alongside first staging deploy)

- [ ] CloudWatch alarms: container service `CPUUtilization`, unhealthy deployment states; billing alarm on the AWS account.
- [ ] Error tracking (Sentry-class) DSN in env; verify a test event from staging.
- [ ] Analytics events flowing from first deploy (SPEC §5A — the funnel history starts now).
- [ ] Supabase backup schedule verified + one restore drill before Phase 3.
- [ ] Uptime monitor on `https://staging.app.../healthz` and the play origin.

---

## 6. Go-live checklist (prod, Phase 3 gate — SPEC A.6)

- [ ] StackBlitz paid plan active + written terms on file (SPEC §6)
- [ ] Stripe LIVE keys in SSM `/btk/prod/*`; live webhook registered
- [ ] ToS/Privacy pages live; play-domain isolation verified (cookies from app domain unreadable on play domain)
- [ ] `BILLING_ENFORCED=true` decision made; grants configured
- [ ] Anthropic Console spend caps set for prod key
- [ ] DNS `app.babylontoolkit.com` → prod service; 200 from `/healthz`; full smoke: signup → verify → new project → generate → share → play on play-domain → purchase (live-mode $1 test) → ledger row

---

## 7. Rollback & domain-migration

- **Bad deploy:** redeploy the previous image label (`aws lightsail create-container-service-deployment` with the prior `:...app.N` ref) — keep the last known-good label in the CI run log.
- **Bad prompt/skills version:** admin rollback endpoint (SPEC §4.3) — no redeploy needed.
- **Domain change (rebrand):** follow the runbook in spec/hosting.md — DNS/cert/env swap + the three tentacles (OAuth redirects, Stripe webhooks, GitHub webhook) + permanent 301.

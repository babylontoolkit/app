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
```

(Lightsail deployments take env vars directly; simplest launch path is injecting these values into the deployment config from CI via `aws ssm get-parameters`. Reading SSM at boot from the app is the later refinement.)

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

```bash
docker build -t btk-builder .          # uses the fork's Dockerfile (production target)
aws lightsail push-container-image \
  --service-name btk-builder-staging \
  --label app --image btk-builder
# Note the returned image ref, e.g. ":btk-builder-staging.app.7"
```

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
        "BILLING_ENFORCED": "false"
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

> `/healthz` must check: DB reachable, active prompt version present, S3 credentials valid (spec/hosting.md). Build it in Phase 2 before first deploy.

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

**Verify WebContainers after DNS:** load the app on the real domain and confirm a project boots. WebContainers needs cross-origin isolation headers (COOP/COEP) — bolt.diy's server config sets them; if a proxy/CDN is ever placed in front, confirm it passes them through untouched.

---

## 3. Webhooks & external registrations (per env)

- [ ] **Stripe:** Dashboard → Webhooks → add `https://staging.app.babylontoolkit.com/api/stripe-webhook` (test mode for staging; the route is `api.stripe-webhook` → `/api/stripe-webhook`, NOT `/api/stripe/webhook`) → copy signing secret into SSM → redeploy.
- [ ] **Supabase Auth:** set Site URL + redirect URLs to the env domain (and OAuth providers' consoles: Google/GitHub redirect URIs).
- [ ] **GitHub doc-sync webhook (Phase 3):** on `babylontoolkit/agent` and `/skills` repos → `https://.../api/admin/webhooks/github`, secret from SSM, push events only.

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

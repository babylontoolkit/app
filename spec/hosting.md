# spec/hosting.md — Hosting & Deployment: AWS (resolves SPEC open question #6)

## Decision

- **App (`app.babylontoolkit.com`): AWS Lightsail Container Service**, deploying the fork's Docker image (bolt.diy ships a Dockerfile). Rationale: the server agent proxy holds long SSE streams through multi-round tool loops (minutes per generation) — an always-on container has no function-duration limits. Lightsail chosen over ECS Fargate to avoid the mandatory ALB cost/ceremony at this scale; migration path to ECS exists if scale demands it. WebContainers are unaffected by host choice (they run in the user's browser).
- **Files: S3 (existing account)** — project snapshots bucket + shared-builds bucket. Supabase's role narrows to **Postgres + Auth + RLS only**; Supabase Storage is not used.
- **Play origin (SPEC §5 isolation requirement): CloudFront distribution over the shared-builds S3 bucket on a SEPARATE registrable domain** (e.g., `btkplay.example` — separate domain, not a subdomain, so user-authored game HTML can never touch app cookies/sessions).
- **DNS:** wherever babylontoolkit.com is managed today (Route 53 optional, not required). `app` → CNAME/ALIAS to the Lightsail container endpoint.
- **AVOID for this app:** Amplify Hosting / Lambda SSR and App Runner — Lambda duration limits and App Runner response-buffering behavior are poor fits for multi-minute SSE. Do not migrate the agent proxy onto them.

## Environments

| Env | Lightsail service | Domain | Notes |
|---|---|---|---|
| staging | `btk-builder-staging` (nano/micro) | `staging.app.babylontoolkit.com` | Behind auth wall (Phase 2). Stripe test mode. Own Supabase project + own S3 prefixes/buckets. |
| prod | `btk-builder` (micro/small) | `app.babylontoolkit.com` | Phase 3+. |

## AWS resources checklist

- Lightsail Container Service per env (power: nano→small as needed; scale = bump power/node count).
- S3: `btk-snapshots-{env}` (private; server-only access) and `btk-play-builds-{env}` (private + CloudFront OAC — never public-listable).
- CloudFront: distribution per env over the play bucket, custom domain (separate registrable domain), default root behavior serving each build under `/{shareId}/`.
- IAM: one deploy user/role for CI (ECR-less Lightsail push permissions) and one runtime role/credentials for the app (scoped: put/get on the two buckets only). Long-term: least-privilege policies; never account-root keys.
- SSM Parameter Store (or Lightsail container env vars) for secrets: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `LICENSE_SERVICE_URL`, `LICENSE_SERVICE_SECRET`, `SESSION_SECRET`, `S3_SNAPSHOTS_BUCKET`, `S3_PLAY_BUCKET`, GitHub webhook secret, admin allowlist.
- CloudWatch alarms: container restarts, 5xx rate; logs shipped to the error-tracking stack (SPEC §5A).

## Deploy steps (Phase 2)

1. Build image in CI (GitHub Actions): `docker build -t btk-builder .`
2. Push to Lightsail: `aws lightsail push-container-image --service-name btk-builder-staging --label app --image btk-builder`
3. Deploy: `aws lightsail create-container-service-deployment` with the container spec (port 5173→80/443 via Lightsail's endpoint, health check on `/healthz`).
4. `/healthz` checks: DB reachable, active prompt version present, S3 credentials valid.
5. Custom domain + TLS: Lightsail-managed certificate for `app.babylontoolkit.com`.
6. Stripe webhook endpoints registered per env (staging = test mode).
7. CI flow: PR → typecheck/tests; merge to `main` → deploy staging; tagged release → deploy prod. AWS creds as repo secrets (the CI IAM user).
8. Play origin: create CloudFront + OAC over the play bucket once; Share flow (§4.8) writes `dist/` to `s3://btk-play-builds-{env}/{shareId}/` and the page is live.

## Storage integration changes (supersedes Supabase Storage mentions in SPEC §4.5.5/§4.8/§4.11)

> **⚠️ SNAPSHOTS ARE NO LONGER THE PROJECT STORE (SPEC §4.5.4b, 2026-07-16).** This document was written when the platform snapshotted every project after every generation; it does not any more. **The user's code lives in their own repo, and their in-progress checkpoints live in their browser** (`local-snapshots.ts`, IndexedDB). `POST /api/projects/:id/snapshots` refuses (405).
>
> Everything below about snapshot ENVELOPES and TRANSPORT is still exactly right — it just has two remaining readers instead of "every project":
>
> 1. the **remix seed** (§4.8) — deposited when an owner publishes, so strangers can remix a game whose repo is private;
> 2. the **dormant `ObjectStore` fallback**, kept behind the storage interface.
>
> The snapshot BUCKET is unaffected and still carries template pins (§4.4) and skill resources (§4.11) under their own prefixes. **Sizing note: the snapshot bucket no longer grows with every generation of every project** — it grows with publishes.

- Snapshots: a JSON envelope of the project file map (binaries carried as base64 entries alongside their true byte `size`) → `snapshots/{projectId}/{snapshotId}.json` in the snapshot bucket; `snapshots.storage_path` stores the key. Server-side access only (runtime IAM role); clients get snapshot contents via the app, never S3 URLs. *(As built, Stage 3 — this supersedes the tar/gzip envelope this doc originally specified. base64 is lossless and the manifest carries true byte counts, so byte integrity below is unaffected; the format is an implementation detail behind the storage interface, and tar remains a valid future swap if snapshot size ever justifies it.)*
- Shared builds: uploaded by the server after the in-WebContainer `npm run build`, to the play bucket under `{shareId}/`.
- Skill resources (§4.11): stored under `s3://btk-snapshots-{env}/skills/{skill}/{version}/...` (same private bucket, server-read-only path).
- Lifecycle policies: prune superseded snapshots per retention config; play builds persist while `share_id` is active, deleted on unpublish.

## Snapshot & build transport (how bytes actually move)

**SDK:** `@aws-sdk/client-s3` (AWS SDK for JS v3), used **server-side only** (`app/lib/.server/storage`) with the `btk-app-runtime` credentials. An AWS key appearing in a client bundle is a critical bug (same rule as the Anthropic platform key).

**Upload (snapshot):** client posts changed project files (from the WebContainer file map — binary bytes read via `FilesStore.readBinaryFile()`, never `dirent.content`, which is always empty when `isBinary`) to a server route → server verifies session + project ownership → serializes the file map → `PutObjectCommand` → `snapshots/{projectId}/{snapshotId}.json` → inserts the `snapshots` row (storage key + manifest) in Postgres.

**Download (resume):** server `GetObjectCommand` → streams the envelope to the client → client base64-decodes binaries back to `Uint8Array` and writes them over the freshly mounted template base in the WebContainer.

**Published builds (share):** server `PutObjectCommand` per file of `dist/` → `s3://btk-play-builds-{env}/{shareId}/` → CloudFront serves it. Objects need correct `ContentType` and, for `.gz.*` assets, `ContentEncoding: gzip` (see the headers policy above).

**Scaling escape hatch — presigned URLs:** proxying every byte through the Lightsail container is simple and safe but makes the app a bandwidth bottleneck for asset-heavy Toolkit projects. When project sizes warrant it, switch to server-issued **presigned S3 URLs**: the server still authorizes (it decides who gets a URL for which key) while the browser transfers directly to/from S3. Build the proxy path first; keep the storage layer behind an interface so this is a swap, not a rewrite.

**BYTE INTEGRITY (required test):** the envelope is built from a `Uint8Array`-faithful file map — binaries base64-encoded from real bytes, never from a UTF-8 string. If any step stringifies content, PNG/GLB/WASM bytes corrupt **silently** — the project looks fine now and returns broken tomorrow. Required regression test: create project → snapshot → restore → assert a known PNG's bytes are byte-identical (hash compare), and that `public/babylon.png` + `public/spinner.png` survive. *(Built: hash-identity in `binary-files.spec.ts`, round-trip + manifest byte counts in `snapshots.spec.ts`.)*

**Local development:** with `S3_*` unset, the storage layer uses a local-filesystem adapter (build-first, SPEC §1.3 principle 0 / §9a) — no AWS account needed to develop. Dev AWS keys, when used, live in `.env.local` (gitignored) and point at **separate dev buckets**, never staging/prod.

## Scaling & ops notes

- SSE concurrency is the sizing driver, not CPU (LLM work happens at Anthropic). Start nano/micro; bump power before adding nodes (sticky sessions not required — app is stateless; anything stateful in the container is a bug).
- Deploys restart containers: in-flight generations abort → client retry affordance; ledger abort/refund rules (spec/billing.md) cover billing. Deploy during low traffic.
- Cost ballpark at beta scale: Lightsail ~$7–15/mo per env + S3/CloudFront cents-to-dollars + Supabase free tier. Verify current AWS pricing before committing budgets.
- Migration path if outgrown: same image to ECS Fargate + ALB; storage/DB unchanged.

## Domain migration runbook (rebrand support — SPEC §2.5)

If the app domain ever changes (e.g., away from app.babylontoolkit.com):
1. DNS: new record → Lightsail endpoint; issue Lightsail-managed TLS cert for the new domain.
2. Env: update `APP_URL` (and `PLAY_URL` if the play domain changes); redeploy. All share links, emails, and meta URLs follow automatically (brand-module rule).
3. **The three tentacles (15 min each; forgetting one silently breaks a flow):**
   a. OAuth redirect URLs — Google console, GitHub OAuth app, AND Supabase Auth URL configuration.
   b. Stripe webhook endpoint URLs (per env) — re-register + new signing secrets into SSM.
   c. GitHub doc-sync webhook URL on the agent/skills repos.
4. Permanent 301 from the old domain → new (tiny CloudFront/redirect rule; keep indefinitely).
5. Update `brand.ts` marketing/domain fields; swap `app/assets/brand/` if the visual identity changes too.

# spec/licensing.md — Licensing & Legal Posture (governs SPEC §6; management workstream)

## bolt.diy (MIT)

Free for all uses including commercial. Obligations: retain the MIT license text and copyright notices for inherited code (keep upstream `LICENSE`; our additions may carry our own headers). `FORK_BASE.md` records provenance. Done by construction — no ongoing action.

## WebContainers (proprietary — StackBlitz)

- **Trigger:** production commercial use serving customers requires licensing. The prototype/POC exemption is about OUR product's lifecycle stage — local dev, staging, internal and acquirer demos are exempt. It is NOT about users making "prototype games": the moment external users are served at app.babylontoolkit.com (free or paid, beta or GA), we are in commercial production use.
- **On-ramp (Phase 3 gate):** paid StackBlitz commercial plan → WebContainer API integration up to 500 sessions/month per their ToS. In place before the first external user. Dev instruments session counts against this cap.
- **Scale (Phase 4):** negotiated commercial license (private pricing) or execute the sandbox swap (spec/sandbox-seam.md).
- **Get in writing (management, start NOW — sales cycles are slow):**
  1. Confirmation of the 500-session/month reading for our beta shape
  2. That charging users credits is covered (expected yes — commercial is commercial)
  3. Session definition/counting methodology
  4. Pricing structure beyond 500 sessions
  Contact: webcontainers.io/enterprise form or hello@stackblitz.com.
- Charging credits requires no *extra* permission beyond the commercial license itself; monetization model is our business decision.

## Anthropic

Commercial API terms via the Console org (Appendix A.1). User prompts/content pass to the API — disclosed in the Privacy Policy (SPEC §5A). We never route end-user traffic through consumer Claude subscriptions (prohibited); platform key only.

## Our outbound terms (before first external user — with SPEC §5A)

- ToS + Privacy Policy live; **users own the games they create**; we take only the hosting/display license needed for shared builds and gallery.
- Asset-pack license text for store assets used in user games (SPEC open question #5).
- Account deletion / data retention reviewed per jurisdiction (SPEC open question #10).

## Acquisition data-room checklist (keep current)

- [ ] MIT notices retained; FORK_BASE.md current
- [ ] StackBlitz plan/license docs + written answers on file
- [ ] Anthropic commercial terms accepted under company org
- [ ] ToS/Privacy versions archived; user-IP clause present
- [ ] Ledger financial records complete (append-only by design)
- [ ] License-service integration documented (no PayPal integration in-platform — validated via our own service)
- [ ] Sandbox-swap plan documented (vendor-dependency mitigation)

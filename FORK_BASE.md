# FORK_BASE.md — Upstream Fork Record

| Field | Value |
|---|---|
| Upstream repo | https://github.com/stackblitz-labs/bolt.diy |
| Upstream license | MIT (retained; see LICENSE) |
| Forked at commit | `<FILL IN: git rev-parse HEAD of upstream at fork time>` |
| Fork date | `<FILL IN>` |
| Fork repo | github.com/babylontoolkit/app-builder (private) |

## Upstream pull log

| Date | Upstream commit pulled to | Notes / conflicts |
|---|---|---|
| — | — | — |

## Pull policy

Per SPEC §2.1/§2.1a: **indefinite pull compatibility** — monthly pulls (and before each phase gate), CI green post-merge, every pull logged above. No divergence cutoff is planned; if one is ever forced, record date, final upstream commit, and reason here with a SPEC change in the same PR.

## Major intentional divergences (keep this list honest — it is the merge map)

- System prompt pipeline replaced (SPEC §4.3)
- Project creation: templates-only (SPEC §4.4)
- Persistence: Supabase hosted layer replaces local-first storage (SPEC §4.5)
- LLM calls moved server-side behind agent proxy + credit gate (SPEC §3, §4.2)
- Provider picker demoted to Settings › Advanced / BYOK (SPEC §2.3)
- Skills runtime added (SPEC §4.11)
- Branding/UX pass (SPEC §2.3, §4.1)

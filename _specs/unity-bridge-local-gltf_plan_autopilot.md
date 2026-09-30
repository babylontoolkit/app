# Auto-pilot run log — unity-bridge-local-gltf

## Run 1 — started 2026-09-29 15:46 · branch btk-sandbox · command: --auto-pilot ALL

Decisions:
- Commit on current branch `btk-sandbox` (not the default branch); the plan's named feature branch is not checked out and switching would carry no benefit.
- Independent streams run concurrently to save wall-clock (owner: "TIME MATTERS"): app-repo phases (sequential among themselves), exporter C# (Phase 3), Agent Reference docs (Phase 4). Each phase still gets its own implementer + independent verifier, ticked only on PASS.
- AgentReference working tree was clean at start (the plan expected `unity-exporter-cli.md` uncommitted — the owner has since committed it); T13 keeps the anonymised examples either way.

Tasks:
- Baseline (app, pre-change): 364 test files, 8004 passed, 2 skipped, 0 failed.
- T10 ⏭️ DEFERRED — permission classifier denied editing `PE/Core/System/BabylonLicense.cs` ("Security Weaken"). Not routed around. Human: approve or hand-apply the three edits in T10 steps 1–4 (only one `CANVAS_TOOLS_OWNERS.IndexOf` use exists, line ~460; the `password24` line ~467), then build + the eval.
- T8 ✅ verified (independent) · 1 attempt · dotnet build 0 errors; curl: single ACAO, CORP, model/gltf+json, OPTIONS 204 + PNA, traversal never 200 (Mono normalises dot segments → 404; ResolveInsideRoot 403 proven for double-encoded/NUL), Range 206 intact · files: WebTools.cs, CanvasToolsInformation.cs, CVPanel.cs, UnityTools_HX.cs (exporter repo, uncommitted per D33)
- T9 ✅ verified (independent) · 1 attempt · already-running keeps port; FirstFreePort → 8889 while 8888 held; dirty-scene guard refused + marker survived; LAN on/off/on · file: BabylonToolkitCliCommands.cs (uncommitted per D33)
- Decision (T9): FirstFreePort made public and reimplemented (connect-probe + bind on IPAddress.Any) — the plan's loopback-bind version returned 8888 while held (SO_REUSEADDR on macOS).
- Owner attention (not caused by this run): `Assets/[Config]/settings.json` BuildWebProject true→false comes from ExportLevel's geometry-only path saving the temporary value to disk (CVTools.cs:178); heals when the Toolkit panel is drawn.
- Plan slip: T8 acceptance "LAN IP refused" contradicts D28 default ON (checked in T9's toggle instead); D29 "real bound port" vs verbatim code reporting the settings port.
- T12 ✅ verified (independent) · 1 attempt · all acceptance greps; 14 steps landed · AgentReference (uncommitted per D33)
- T13 ✅ verified (independent) · 1 attempt · exporter doc 116127 bytes (<120000 after the §14 + §15-symptom-table fallback moves); scripts byte-identical before block deletion; bash -n OK; anonymised examples preserved · AgentReference (uncommitted per D33)
- Decision (T11): §5 temp_override also passes `object=obj` — the plan's form returned CANCELLED on modifier_apply with another object active (verifier reproduced).
- Decision (T13): eval-probe loops use `--result-only` + READY match (the old `| grep -q true` also matched the envelope's success:true).
- T11 ✗ verifier FAIL (attempt 1): §9 quick-reference still carries the broken parent_set-only re-paint recipe → fix sent back to the implementer.
- T14 ✅ verified (independent) · 1 attempt · 33 named cases · app/lib/bridge/*
- T15 ✅ verified (independent) · 1 attempt · migration identical to the plan; ledger reason in step across SQL/TS/specs; PGlite cases pass
- T16 ✅ verified (independent) · 1 attempt · pairing/auth specs; live start returns XXXX-XXXX
- Decision (T14): priceClassOf checks `job` before `script` (the plan's own blender-600 → 4 test requires it).
- Decision (T17): devices revoke also runs settleDropped(dropDevice()) — D13 lists revoke as a refund cause.
- T17 ✗ verifier FAIL (attempt 1): poll-route persistence throttle compares JSON.stringify of stored vs incoming hello — jsonb reorders keys, so production would write bridge_devices on every poll. Fix sent back.
- T11 ✅ verified (fresh verifier, attempt 2) · reweight.py live on Knight (9 meshes, bounds-shift 0, exit 0; .obj → exit 1); §9 quick-ref recipe replaced and run live (max shift 3.6e-15) · AgentReference (uncommitted per D33). Leftover for the owner: a few non-re-paint bpy.ops examples (import/export/select_all) still don't assert FINISHED.
- Phase 4 complete.

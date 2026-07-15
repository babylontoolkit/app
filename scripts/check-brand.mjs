#!/usr/bin/env node
/**
 * Brand grep-gate (SPEC §2.5 rule 4; CLAUDE.md "Branding rule").
 *
 * Fails the build if a bolt.diy / bolt.new / StackBlitz mark, or a HARDCODED product-brand string,
 * appears in a user-facing surface outside the brand module (`app/config/brand.ts`). The point is that
 * the brand lives in exactly one place, so the working name (SPEC open question #18) stays swappable.
 *
 * This is NOT a blanket `grep bolt`: the inherited bolt.diy code is FULL of legitimate, non-user-facing
 * `bolt` tokens that must NOT be touched (pull-compatibility, §2.1a) — `bolt-elements-*` CSS classes,
 * the `boltArtifact`/`boltAction`/`boltFile` stream protocol, the `bolt_theme` localStorage key. Those
 * never match the mark regex below. What the regex CAN hit falls into three legitimate buckets, each
 * allow-listed with a reason:
 *   1. HTTP `User-Agent` identifiers (functional request headers, never rendered).
 *   2. `Copyright (c) StackBlitz` source-file headers (MIT REQUIRES keeping these — §2.3).
 *   3. Hidden / dead inherited paths that our product never routes to (fail-closed upstream routes,
 *      the update checker, the unused chat prompts). Per hide-don't-delete (§2.1a) we keep the code.
 *
 * Anything else is a real regression and fails. To debrand a new user-facing string, route it through
 * `brand` — do not add it to the allow-list.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCAN_DIR = join(ROOT, 'app');

/** The marks we never want in a user-facing surface. */
const MARK = /(bolt\.diy|bolt\.new|stackblitz)/i;

/** The working product name — must never be hardcoded outside the brand module. */
const PRODUCT_NAME = 'Babylon Toolkit App Builder';

/** Files exempt from ALL checks: the brand module itself, and this gate. */
const EXEMPT_FILES = new Set(['app/config/brand.ts']);

/**
 * Files where a mark is legitimate and intentionally retained (hidden/dead upstream paths kept for
 * pull-compatibility per §2.1a). Reason recorded so the list stays honest.
 */
const MARK_ALLOWLIST = new Map([
  ['app/lib/common/prompts/new-prompt.ts', 'inherited Bolt system prompt — replaced by doc-sync; only reachable via fail-closed /api/chat'],
  ['app/lib/common/prompts/discuss-prompt.ts', 'inherited Bolt discuss prompt — same dead path as new-prompt'],
  ['app/lib/api/updates.ts', 'upstream update checker fetching stackblitz-labs/bolt.diy package.json — internal, not rendered'],
  ['app/routes/webcontainer.connect.$id.tsx', 'stackblitz.com editorOrigin fallback — functional WebContainer connect default'],
  ['app/routes/api.bug-report.ts', 'hidden inherited bug-report route (no UI caller; repo is config-driven) — hide-don`t-delete'],
]);

/** Line-level predicates: a matched line is allowed if ANY returns true. */
const LINE_ALLOW = [
  (line) => /user-agent/i.test(line), // HTTP request header identifier
  (line) => /copyright \(c\) stackblitz/i.test(line), // MIT source-header attribution (§2.3)
  (line) => {
    const t = line.trimStart();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'); // code comment
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.spec\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];

for (const file of walk(SCAN_DIR)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (EXEMPT_FILES.has(rel)) continue;

  const allowMark = MARK_ALLOWLIST.has(rel);
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, i) => {
    // Hardcoded product name — never allowed outside the brand module, no exceptions.
    if (line.includes(PRODUCT_NAME)) {
      violations.push({ rel, line: i + 1, text: line.trim(), why: `hardcoded product name "${PRODUCT_NAME}"` });
    }

    if (MARK.test(line)) {
      if (allowMark) return;
      if (LINE_ALLOW.some((p) => p(line))) return;
      violations.push({ rel, line: i + 1, text: line.trim(), why: 'bolt.diy / StackBlitz mark in a user-facing surface' });
    }
  });
}

if (violations.length > 0) {
  console.error(`\n✖ Brand gate: ${violations.length} violation(s) — route these through app/config/brand.ts\n`);
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  — ${v.why}`);
    console.error(`      ${v.text}`);
  }
  console.error('\nIf a hit is a legitimate non-user-facing inherited path, add it to the allow-list in scripts/check-brand.mjs with a reason.\n');
  process.exit(1);
}

console.log('✓ Brand gate: no bolt.diy/StackBlitz marks or hardcoded brand strings in user-facing surfaces.');

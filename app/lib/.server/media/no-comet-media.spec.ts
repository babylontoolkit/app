/**
 * COMET IS NOT A MEDIA GATEWAY — AND THE MEDIA CODE MUST NOT QUIETLY GROW IT BACK (SPEC §4.16,
 * `_specs/media-gateways_plan.md` T1).
 *
 * The owner removed Comet from media on 2026-10-01 (a security issue). It stays a platform (LLM)
 * provider, so its name still appears all over `agent/config.ts`, the price lists and the LLM wire —
 * which is exactly why removing it from media is easy to undo by accident: a copied branch, a
 * "symmetric" record entry, a catalogue someone restores for completeness. Nothing would throw.
 *
 * So this is a DEFAULT-DENY source scan over every media module: no `Comet` / `comet` in code, except
 * the entries below, each with its reason. Comments are stripped first — prose explaining the removal
 * is documentation, not a gateway.
 *
 * ⚠️ The stored-task refusal is deliberately NOT a scan hit: it is keyed on `RETIRED_MEDIA_PROVIDERS`,
 * declared in `agent/config.ts` beside `MEDIA_PROVIDERS` (outside this tree, which is the point — the
 * name lives in one place). It is pinned below by reference instead, so it cannot silently disappear.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEDIA_PROVIDERS, RETIRED_MEDIA_PROVIDERS } from '~/lib/.server/agent/config';
import { retiredMediaGatewayError } from './provider';

const ROOT = process.cwd();

/** The media tree, per the plan: every media module, the agent's media tool and its prompt note. */
const SCAN_DIRS = ['app/lib/media', 'app/lib/.server/media', 'app/components/media'];
const SCAN_FILES = ['app/lib/.server/agent/media-tools.ts', 'app/lib/.server/agent/media-note.ts'];

const IS_SOURCE = /\.tsx?$/;
const IS_SPEC = /\.spec\.tsx?$/;
const COMET = /comet/i;

/**
 * Every sanctioned hit: a file and the exact code line it may contain. A list with reasons, so it is a
 * wall and not a place to append — and every entry must still MATCH something (see the stale-entry
 * test), or a removed line would leave a hole shaped like itself.
 */
const ALLOWED: { file: string; line: RegExp; reason: string }[] = [
  {
    file: 'app/lib/.server/media/provider.ts',
    line: /^\| 'comet-image'$/,
    reason: 'Persisted `MediaEndpoint` value — old task records carry it; nothing creates it.',
  },
  {
    file: 'app/lib/.server/media/provider.ts',
    line: /^\| 'comet-gemini-image'$/,
    reason: 'Persisted `MediaEndpoint` value — old task records carry it; nothing creates it.',
  },
  {
    file: 'app/lib/.server/media/provider.ts',
    line: /^\| 'comet-video'$/,
    reason: 'Persisted `MediaEndpoint` value — old task records carry it; nothing creates it.',
  },
];

/** Block comments, then line comments (whole-line and trailing). Strings with `//` are rare here. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Every code line (trimmed) mentioning `Comet`/`comet`, comments excluded. */
function cometLinesIn(source: string): string[] {
  return stripComments(source)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => COMET.test(line));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);

    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (IS_SOURCE.test(abs) && !IS_SPEC.test(abs)) {
      out.push(abs);
    }
  }

  return out;
}

function repoPath(abs: string): string {
  return relative(ROOT, abs).replace(/\\/g, '/');
}

const FILES = [...SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir))), ...SCAN_FILES.map((file) => join(ROOT, file))];

/** Every hit in the real tree, with whether an allow-list entry covers it. */
const HITS = FILES.flatMap((abs) => {
  const file = repoPath(abs);

  return cometLinesIn(readFileSync(abs, 'utf8')).map((line) => ({
    file,
    line,
    allowed: ALLOWED.some((entry) => entry.file === file && entry.line.test(line)),
  }));
});

describe('no Comet in the media code', () => {
  it('finds no Comet / comet outside the named allow-list', () => {
    const unexplained = HITS.filter((hit) => !hit.allowed).map((hit) => `${hit.file}: ${hit.line}`);

    expect(unexplained, 'Comet is not a media gateway — remove it, or add an entry WITH A REASON').toEqual([]);
  });

  it('every allow-list entry still matches a real line (no stale holes)', () => {
    for (const entry of ALLOWED) {
      expect(
        HITS.some((hit) => hit.file === entry.file && entry.line.test(hit.line)),
        `${entry.file} ${entry.line} matches nothing — delete the entry`,
      ).toBe(true);
    }
  });

  it('the stored-task refusal exists, names Comet, and is the poll path’s ONE source', () => {
    // Not a scan hit (see the header), so pinned by behaviour: Comet records get the refusal sentence.
    expect([...RETIRED_MEDIA_PROVIDERS]).toEqual(['Comet']);
    expect(MEDIA_PROVIDERS).not.toContain('Comet' as never);
    expect(retiredMediaGatewayError({ provider: 'Comet' })).toBe(
      'Comet is no longer a media gateway; this render was refunded.',
    );

    // CONTROL: a live gateway's record is not refused.
    expect(retiredMediaGatewayError({ provider: 'KIE' })).toBeNull();
    expect(retiredMediaGatewayError({ provider: 'FAL' })).toBeNull();
    expect(retiredMediaGatewayError({})).toBeNull();
  });
});

describe('the scanner (controls)', () => {
  it('read a real tree — the files the plan names are in scope, and specs are not', () => {
    const scanned = new Set(FILES.map(repoPath));

    expect(scanned.size).toBeGreaterThan(10);

    for (const file of [
      'app/lib/.server/media/provider.ts',
      'app/lib/.server/media/service.ts',
      'app/lib/media/image-capabilities.ts',
      'app/lib/media/provider-defaults.ts',
      'app/lib/media/output-format.ts',
      'app/components/media/MediaPanel.tsx',
      'app/lib/.server/agent/media-tools.ts',
      'app/lib/.server/agent/media-note.ts',
    ]) {
      expect(scanned, `${file} was not scanned`).toContain(file);
    }

    expect([...scanned].filter((file) => IS_SPEC.test(file))).toEqual([]);
  });

  it('finds a planted Comet string in code', () => {
    expect(cometLinesIn("const provider = 'Comet';")).toEqual(["const provider = 'Comet';"]);
    expect(cometLinesIn('case "comet":\n  return new X();')).toEqual(['case "comet":']);
    expect(cometLinesIn('export const CometMediaProvider = 1;')).toHaveLength(1);
  });

  it('ignores Comet in comments, block and line', () => {
    expect(cometLinesIn('/* Comet was removed */\nconst x = 1;')).toEqual([]);
    expect(cometLinesIn('const x = 1; // Comet was removed')).toEqual([]);
    expect(cometLinesIn('// Comet\nconst y = 2;')).toEqual([]);
  });

  it('allows a persisted endpoint value only in provider.ts', () => {
    const covered = (file: string, line: string) =>
      ALLOWED.some((entry) => entry.file === file && entry.line.test(line));

    expect(covered('app/lib/.server/media/provider.ts', "| 'comet-image'")).toBe(true);
    expect(covered('app/lib/.server/media/service.ts', "| 'comet-image'")).toBe(false);
    expect(covered('app/lib/.server/media/provider.ts', "return 'comet-image';")).toBe(false);
  });
});

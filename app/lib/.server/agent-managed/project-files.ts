/**
 * `project_read`, `project_list`, `project_grep` — answered on the SERVER, over the turn's text view of
 * the project (`_specs/managed-agents-engine_plan.md` D3, T5).
 *
 * The browser sends the project's file map with every request (`body.files`), and the legacy tool
 * loop's `WorkspaceOverlay` puts this turn's writes on top of it. Reading from that view needs no
 * browser hop: a read is answered in microseconds instead of a relay round trip, and the model reads
 * its own writes (the overlay is updated only after the browser confirms a write landed).
 *
 * Same rules as `read_file` (`agent/file-tools.ts`): project-relative paths, a binary file is never
 * returned as text, a generated/vendored/minified file is not readable (`isOpaqueToModel`), and a
 * missing path answers with near-matches. Every result is bounded and a truncation SAYS so — a model
 * handed a silently shortened listing reads it as the whole project.
 *
 * Never throws: every refusal is a sentence the model can act on.
 */
import { resolveFile, suggestPaths } from '~/lib/.server/agent/file-tools';
import type { WorkspaceOverlay } from '~/lib/.server/agent/workspace-tools';
import type { FileMap } from '~/lib/.server/llm/constants';
import { isSandboxAbsolutePath, toProjectRelativePath } from '~/lib/common/sandbox-paths';
import { isOpaqueToModel } from '~/lib/context/opaque-files';

/** Lines returned by one `project_read` when the model names no limit. */
export const READ_DEFAULT_LINES = 2000;

/** Characters one `project_read` may return before it truncates (and says so). */
export const READ_MAX_CHARS = 100_000;

/** One line of a read is cut here — a minified line can be megabytes. */
export const READ_MAX_LINE_CHARS = 2000;

export const LIST_MAX_ENTRIES = 1500;
export const GREP_MAX_MATCHES = 200;
export const GREP_MAX_LINE_CHARS = 300;

/** Directories that are never the project's source — the listing skips them. */
const SKIPPED_DIRS = ['node_modules/', '.git/', 'dist/', '.codesandbox/'];

export interface ProjectView {
  files: FileMap;
  overlay: WorkspaceOverlay;
}

/** Normalise a path argument, or return a refusal. Shared by all three tools. */
function vetReadPath(raw: unknown, tool: string, required: boolean): { rel: string } | { refusal: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return required
      ? { refusal: `${tool} needs a "path" — a project-relative path such as src/pages/Home.tsx.` }
      : { rel: '' };
  }

  const trimmed = raw.trim();

  if (trimmed.startsWith('/') && !isSandboxAbsolutePath(trimmed)) {
    return {
      refusal: `"${trimmed}" is outside the project. Project paths are relative (e.g. src/pages/Home.tsx); the Agent Reference under /workspace/agent is read with the built-in read tool.`,
    };
  }

  let rel = toProjectRelativePath(trimmed);

  while (rel.startsWith('./')) {
    rel = rel.slice(2);
  }

  rel = rel.replace(/\/+$/, '');

  if (rel.split('/').some((segment) => segment === '..')) {
    return { refusal: `"${trimmed}" is not a valid project path.` };
  }

  return { rel };
}

/** Every project-relative TEXT-or-binary file path in the view: the request's map plus this turn's writes. */
export function projectPaths(view: ProjectView): string[] {
  const paths = new Set<string>();

  for (const [key, dirent] of Object.entries(view.files)) {
    if (dirent?.type === 'file') {
      paths.add(toProjectRelativePath(key));
    }
  }

  for (const written of view.overlay.writes) {
    paths.add(written);
  }

  return [...paths].filter((p) => p && !SKIPPED_DIRS.some((dir) => p.startsWith(dir) || p.includes(`/${dir}`))).sort();
}

function inDirectory(path: string, dir: string): boolean {
  return !dir || path === dir || path.startsWith(`${dir}/`);
}

function isBinaryInView(view: ProjectView, rel: string): boolean {
  if (view.overlay.wrote(rel)) {
    return false;
  }

  return Boolean(resolveFile(view.files, rel)?.dirent.isBinary);
}

export function projectRead(view: ProjectView, input: Record<string, unknown>): { text: string; isError: boolean } {
  const vetted = vetReadPath(input.path ?? input.file_path, 'project_read', true);

  if ('refusal' in vetted) {
    return { text: vetted.refusal, isError: true };
  }

  const rel = vetted.rel;
  const content = view.overlay.read(rel);

  if (content === undefined) {
    const hit = resolveFile(view.files, rel);

    if (hit?.dirent.isBinary) {
      return {
        text: `"${rel}" is a binary file (${hit.dirent.size ?? 0} bytes) and cannot be read as text. Reference it by path in your code.`,
        isError: true,
      };
    }

    const near = suggestPaths(view.files, rel);

    return {
      text: near.length
        ? `No file at "${rel}". Did you mean: ${near.join(', ')}?`
        : `No file at "${rel}". Use project_list to see the project's files.`,
      isError: true,
    };
  }

  if (!view.overlay.wrote(rel) && isOpaqueToModel(rel)) {
    return {
      text: `"${rel}" is generated, vendored or minified (${content.length} bytes) — there is no correct edit to it and it is deliberately not readable. Leave it alone.`,
      isError: true,
    };
  }

  if (content === '') {
    return { text: `${rel} is empty.`, isError: false };
  }

  const lines = content.split('\n');
  const offset = Math.max(1, Number.isFinite(Number(input.offset)) ? Math.floor(Number(input.offset)) : 1);
  const limit = Math.max(
    1,
    Number.isFinite(Number(input.limit)) ? Math.floor(Number(input.limit)) : READ_DEFAULT_LINES,
  );

  if (offset > lines.length) {
    return { text: `${rel} has ${lines.length} lines; offset ${offset} is past the end.`, isError: true };
  }

  const out: string[] = [];
  let chars = 0;
  let last = offset - 1;

  for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
    const raw = lines[i];
    const line = raw.length > READ_MAX_LINE_CHARS ? `${raw.slice(0, READ_MAX_LINE_CHARS)}…(line truncated)` : raw;
    const numbered = `${String(i + 1).padStart(6, ' ')}\t${line}`;

    if (chars + numbered.length > READ_MAX_CHARS && out.length > 0) {
      break;
    }

    out.push(numbered);
    chars += numbered.length + 1;
    last = i + 1;
  }

  const more =
    last < lines.length
      ? `\n…(${lines.length - last} more lines — read again with offset ${last + 1} to continue)`
      : '';

  return { text: out.join('\n') + more, isError: false };
}

export function projectList(view: ProjectView, input: Record<string, unknown>): { text: string; isError: boolean } {
  const vetted = vetReadPath(input.path, 'project_list', false);

  if ('refusal' in vetted) {
    return { text: vetted.refusal, isError: true };
  }

  const all = projectPaths(view).filter((p) => inDirectory(p, vetted.rel));

  if (all.length === 0) {
    return {
      text: vetted.rel ? `No files under "${vetted.rel}".` : 'The project has no files in this request.',
      isError: Boolean(vetted.rel),
    };
  }

  const shown = all.slice(0, LIST_MAX_ENTRIES).map((p) => (isBinaryInView(view, p) ? `${p} [binary]` : p));
  const more = all.length > shown.length ? `\n…(${all.length - shown.length} more — list a subdirectory)` : '';

  return { text: shown.join('\n') + more, isError: false };
}

export function projectGrep(view: ProjectView, input: Record<string, unknown>): { text: string; isError: boolean } {
  if (typeof input.pattern !== 'string' || !input.pattern) {
    return { text: 'project_grep needs a "pattern" — a JavaScript regular expression.', isError: true };
  }

  let regex: RegExp;

  try {
    regex = new RegExp(input.pattern);
  } catch (error) {
    return { text: `Invalid regular expression: ${(error as Error).message}`, isError: true };
  }

  const vetted = vetReadPath(input.path, 'project_grep', false);

  if ('refusal' in vetted) {
    return { text: vetted.refusal, isError: true };
  }

  const matches: string[] = [];
  let truncated = false;

  for (const path of projectPaths(view)) {
    if (
      !inDirectory(path, vetted.rel) ||
      isBinaryInView(view, path) ||
      (!view.overlay.wrote(path) && isOpaqueToModel(path))
    ) {
      continue;
    }

    const content = view.overlay.read(path);

    if (!content) {
      continue;
    }

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i])) {
        continue;
      }

      if (matches.length >= GREP_MAX_MATCHES) {
        truncated = true;
        break;
      }

      const line = lines[i].length > GREP_MAX_LINE_CHARS ? `${lines[i].slice(0, GREP_MAX_LINE_CHARS)}…` : lines[i];
      matches.push(`${path}:${i + 1}: ${line}`);
    }

    if (truncated) {
      break;
    }
  }

  if (matches.length === 0) {
    return { text: `No matches for /${input.pattern}/${vetted.rel ? ` under ${vetted.rel}` : ''}.`, isError: false };
  }

  return {
    text:
      matches.join('\n') +
      (truncated ? `\n…(stopped at ${GREP_MAX_MATCHES} matches — narrow the pattern or path)` : ''),
    isError: false,
  };
}

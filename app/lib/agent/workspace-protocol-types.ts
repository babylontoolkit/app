/**
 * The workspace relay's shared contract (tool-loop plan D1–D8, D20).
 *
 * Client-safe: no secrets, no server imports. The server tools (`.server/agent/workspace-tools.ts`)
 * emit `workspace-tool-call` data parts; the browser executor (`agent-workspace/executor.ts`) runs
 * them in the user's sandbox and POSTs the result to `/api/agent/tool-result`.
 */
export type WorkspaceOp = 'write' | 'run' | 'check';
export interface WorkspaceWriteParams {
  path: string;
  content: string;
} // project-relative
export interface WorkspaceRunParams {
  command: string;
}
export interface WorkspaceCheckParams {
  gameMode?: string;
  sceneUrl?: string;
}
export interface WorkspaceToolCallPart {
  type: 'workspace-tool-call';
  generationId: string;
  toolCallId: string;
  op: WorkspaceOp;
  params: WorkspaceWriteParams | WorkspaceRunParams | WorkspaceCheckParams;
}
export interface WorkspaceWriteResult {
  ok: true;
}
export interface WorkspaceRunResult {
  exitCode: number;
  output: string;
  packageJson?: string;
}
export interface GameCheckResult {
  ok: boolean;
  typecheck: { ok: boolean; errors: string[] } | 'unavailable';

  /** Why `typecheck` is `'unavailable'` (e.g. tsc read 0 lines of TypeScript) — never set on a verdict. */
  typecheckReason?: string;
  home: { errors: string[] };
  play: { errors: string[]; hasScene: boolean; meshes: number; ready: boolean } | null;
  screenshot: { base64: string; mimeType: string } | null;
}
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface AgentTodosPart {
  type: 'agent-todos';
  generationId: string;
  items: TodoItem[];
}
export interface AgentWorkspaceSummary {
  writes: string[]; // first-write order, unique
  commands: Array<{ command: string; exitCode: number }>;
  todos: TodoItem[];
  lastCheck: { ok: boolean; errors: string[] } | null; // ≤10 errors × 300 chars
}
export const WORKSPACE_WRITE_TIMEOUT_MS = 30_000;
export const WORKSPACE_RUN_TIMEOUT_MS = 300_000;

/*
 * Above the check's worst case: typecheck 120 s + home (nav 15 s + 3 s) + play (nav 15 s + scene poll
 * 25 s + one re-navigation 15 s) + screenshot ≈ 195 s. The relay must never give up before the check.
 */
export const WORKSPACE_CHECK_TIMEOUT_MS = 240_000;
export const RUN_OUTPUT_TAIL_CHARS = 12_000;
export const CHECK_MAX_ERRORS = 30;
export const CHECK_ERROR_MAX_CHARS = 300;
export const TYPECHECK_TIMEOUT_MS = 120_000;

/*
 * `/play` is POLLED for the scene rather than probed once after a fixed settle (T9 fix loop): right
 * after the agent's edits Vite is still re-transforming modules, the scene can take longer than 8 s,
 * and a single probe reported "No Babylon scene was created" on a working game — a false failure that
 * spent a whole breaker run. The minimum settle keeps frame-one runtime errors in the collection window.
 */
export const PLAY_SCENE_POLL_MS = 500;
export const PLAY_MIN_SETTLE_MS = 3_000;
export const PLAY_SCENE_DEADLINE_MS = 25_000;
export const HOME_SETTLE_MS = 3_000;
export const PREVIEW_NAV_READY_MS = 15_000;
export const NAV_STATE_STORE_KEY = '__bt_nav_state'; // mirrors starter src/babylon/system/platform.tsx:61
export const DISALLOWED_RUN_SCRIPTS = ['dev', 'preview'] as const;

/**
 * The managed agent's CUSTOM tool definitions (`_specs/managed-agents-engine_plan.md` D3, T3).
 *
 * Definitions only — the dispatcher that answers `agent.custom_tool_use` is T5's (and T8's for media).
 * Two rules shape this file:
 *
 * 1. **Argument names are the legacy tools' names.** The dispatcher passes `input` straight into
 *    today's executes (`workspace-tools.ts` write_file/edit_file/run_command/check_game/update_todos,
 *    `preview-tools.ts`, `media-tools.ts`, `file-tools.ts` read_file), so a renamed argument here would
 *    reach an execute that does not read it — a silently empty write, not an error. `tools.spec.ts`
 *    pins the names.
 * 2. **The array is hashed** (provisioning skips an unchanged agent, `provision.ts`), so it is a
 *    constant with a fixed order and fixed key order, and NOTHING gateway-dependent may appear in it:
 *    the legacy media descriptions name the active gateway's default model, which would make the agent
 *    definition change whenever `MEDIA_PROVIDER` does. Here the model is simply "leave unset for the
 *    default" and the dispatcher resolves it at call time.
 *
 * Paths are PROJECT-RELATIVE (`src/pages/Home.tsx`). The `project_` prefix is what keeps the user's
 * project apart from the Agent Reference, which the agent reads with the built-in read/glob/grep under
 * `/workspace/agent` (D4, D12).
 */
import type { BetaManagedAgentsCustomToolParams } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import { SOUND_MODELS } from '~/lib/media/provider-defaults';

/**
 * The per-second effect length the managed `duration` text quotes — read from the catalogue, never
 * typed, so the two cannot drift. A constant of the code, so the provisioned text stays deterministic.
 */
const FAL_EFFECT_SECONDS = SOUND_MODELS.FAL.effectSeconds ?? { min: 0.5, max: 22, default: 5 };

type JsonSchema = Record<string, unknown>;

const str = (description: string): JsonSchema => ({ type: 'string', description });
const int = (description: string): JsonSchema => ({ type: 'integer', description });
const num = (description: string): JsonSchema => ({ type: 'number', description });
const bool = (description: string): JsonSchema => ({ type: 'boolean', description });

function custom(
  name: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): BetaManagedAgentsCustomToolParams {
  return {
    type: 'custom',
    name,
    description,
    input_schema: { type: 'object', properties, required },
  };
}

const PATH = 'Project-relative path, e.g. src/pages/Home.tsx';

export const MANAGED_CUSTOM_TOOLS: readonly BetaManagedAgentsCustomToolParams[] = Object.freeze([
  custom(
    'project_list',
    "List the files in the user's game project as project-relative paths. Pass `path` to list one directory.",
    { path: str('Optional project-relative directory, e.g. src/scripts') },
  ),
  custom(
    'project_read',
    "Read a file from the user's game project. Returns numbered lines; use offset/limit for long files.",
    {
      path: str(PATH),
      offset: int('1-based line to start from (optional)'),
      limit: int('Number of lines to return (optional)'),
    },
    ['path'],
  ),
  custom(
    'project_write',
    "Create a file, or replace a whole file, in the user's game project. Pass the COMPLETE file content — " +
      'never a fragment or a placeholder. Prefer project_edit to change part of an existing file. Text ' +
      'files only: images, audio and video come from the generate_* tools.',
    { path: str(PATH), content: str('The complete file content') },
    ['path', 'content'],
  ),
  custom(
    'project_edit',
    'Change part of an existing project file by replacing an exact string. `old_string` must match the ' +
      'file EXACTLY (whitespace and indentation included) and be unique in it — include surrounding lines, ' +
      'or pass `replace_all: true` to change every occurrence. Read the file first.',
    {
      path: str(PATH),
      old_string: str('The exact text to replace'),
      new_string: str('The replacement text'),
      replace_all: bool('Replace every occurrence (default false)'),
    },
    ['path', 'old_string', 'new_string'],
  ),
  custom(
    'project_grep',
    "Search the user's game project with a JavaScript regular expression. Returns file:line matches.",
    { pattern: str('JavaScript regular expression'), path: str('Optional project-relative directory to search') },
    ['pattern'],
  ),
  custom(
    'project_run',
    "Run an npm command in the project's sandbox and get its exit code and output. Allowed: " +
      '`npm install <pkg>` and `npm run <script>` (e.g. `npm run build`). Never `npm run dev` or ' +
      '`npm run preview` — the dev server is already running and the preview updates on its own.',
    { command: str('e.g. npm install @babylonjs/loaders') },
    ['command'],
  ),
  custom(
    'check_game',
    'Verify the game actually works: type-checks the project, loads the landing page, and — when you pass ' +
      '`gameMode` — enters /play with that registered GameMode, checks a Babylon scene was created, collects ' +
      'runtime errors and returns a screenshot. Call it after you change files, fix what it reports, and call ' +
      'it again until it passes. Your turn is not done until it passes.',
    {
      gameMode: str('The registered GameMode class to play, e.g. KartRacerMode'),
      sceneUrl: str('Optional scene URL to load with the GameMode'),
    },
  ),
  custom(
    'update_todos',
    'Replace your todo list for this turn — the user sees it as a live checklist. Call it with every step ' +
      'before your first write, then as you go: exactly one item `in_progress` while you work on it, ' +
      '`completed` as soon as it is done.',
    {
      items: {
        type: 'array',
        description: 'The whole list, in order',
        items: {
          type: 'object',
          properties: {
            content: str('What this step does'),
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    ['items'],
  ),
  custom(
    'evaluate_in_game',
    'Run a JavaScript expression inside the RUNNING game in the preview and return its value — how you ' +
      'verify something works rather than inferring it from the code. `await` is supported; several ' +
      'statements need an explicit `return`. The project is ESM, so nothing is on `window`: reach the scene ' +
      'through the Babylon core module the page already loaded, by its exact URL: ' +
      "`const core = await import(performance.getEntriesByType('resource').map(e => e.name)" +
      ".find(n => n.includes('/@babylonjs/core/index.js') || n.includes('@babylonjs_core.js'))); " +
      'const scene = core.EngineStore.LastCreatedScene; return scene.meshes.length;`. To import a project ' +
      "module use its served path WITH the extension, e.g. `await import('/src/scripts/GemPickup.ts')`. " +
      'Large objects are truncated, so ask one narrow question.',
    { expression: str('A JavaScript expression, e.g. scene.meshes.length') },
    ['expression'],
  ),
  custom(
    'capture_game_screenshot',
    'Capture the current game frame and SEE it (a downscaled JPEG). `blank: true` means every sampled pixel ' +
      'is one colour; a blank frame is NOT proof the game renders nothing — check get_game_errors and ' +
      'inspect the scene with evaluate_in_game before concluding anything.',
    {},
  ),
  custom(
    'get_game_errors',
    'Uncaught exceptions and unhandled promise rejections thrown by the running game, newest last, with ' +
      'stack traces. Check this FIRST when a game looks broken — a runtime crash does not fail the build.',
    {},
  ),
  custom('get_game_console', 'Console output from the running game (log/info/warn/error/debug), newest last.', {
    level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'], description: 'Filter to one level.' },
  }),
  custom(
    'generate_image',
    'Generate an image with the built-in AI image generator and save it into the project under ' +
      'public/assets/generated/. Returns the path to reference in code right away; the render finishes in ' +
      'the background — never wait or poll. Costs the user credits. Use for textures, sprites, backgrounds, ' +
      'logos, UI art.',
    {
      prompt: str('What to generate. Detailed and style-specific works best.'),
      model: str('Image model. Leave unset for the default.'),
      resolution: str('1K, 2K or 4K. Default 2K. 1K is cheaper; 4K costs more.'),
      aspect_ratio: str('e.g. 16:9, 1:1, 9:16, 4:3. Default 16:9.'),
      transparent: bool(
        'Set true when the art must sit OVER other content with nothing behind it (a logo over a hero, an ' +
          'emblem, a sprite, a UI icon): it is cut out into a real RGBA PNG for a couple of extra credits. ' +
          'Never ask for a transparent background in the prompt text — the generator paints a fake ' +
          'checkerboard; this flag is the only thing that produces real transparency.',
      ),
      output_format: str('png or jpg. Normally leave unset — opaque art defaults to jpg, transparent art is png.'),
      file_name: str('Preferred file name (without extension).'),
    },
    ['prompt'],
  ),
  custom(
    'generate_video',
    'Generate a video clip with the built-in AI video generator and save it into the project under ' +
      'public/assets/generated/. Returns the path to reference right away; renders take minutes and finish ' +
      'in the background. Expensive (hundreds of credits) — only when the user asked for video.',
    {
      prompt: str('What happens in the video.'),
      model: str('Video model. Leave unset for the default.'),
      mode: str('Quality mode, where the model has one. Leave unset for the default.'),
      sound: bool('Generate audio with the video. Default false.'),
      duration_seconds: num('Clip length in seconds. Default 5.'),
      resolution: str('Output resolution, where the model has a choice. Leave unset for the default.'),
      aspect_ratio: str('16:9, 9:16 or 1:1. Default 16:9.'),
      file_name: str('Preferred file name (without extension).'),
    },
    ['prompt'],
  ),
  custom(
    'generate_sound',
    'Generate a sound effect, a line of speech, or a music track and save it into the project under ' +
      'public/assets/generated/ as an MP3. Costs the user credits. kind=sound_effect (default) for gameplay ' +
      'audio — jumps, pickups, engines, impacts, UI clicks, ambience. kind=speech for spoken lines. ' +
      'kind=music only when the user asked for music (several times the price of an effect). Pass ONLY the ' +
      'fields that belong to the chosen kind. Renders happen in the background: reference the returned path now.',
    {
      prompt: str(
        'Effects: describe the sound (max 500 chars). Speech: the exact words (max 5000). Music: describe the track (max 3000).',
      ),
      kind: str('sound_effect (default), speech, or music.'),
      model: str('Leave unset for the default.'),
      file_name: str('Preferred file name (without extension).'),
      loop: bool('Effects only: make it loopable (ambience, engines).'),
      tempo: num('Effects only: requested BPM, 1-300.'),
      key: str('Effects only: musical key such as C or Am. Omit for any.'),
      voice: str('Speech only: ElevenLabs voice name or id.'),
      stability: num('Speech only: 0-1.'),
      similarity_boost: num('Speech only: 0-1.'),
      speech_style: num('Speech only: style exaggeration, 0-1.'),
      speed: num('Speech only: 0.7-1.2.'),
      language_code: str('Speech only, turbo 2.5 model only: two-letter ISO 639-1 code.'),
      instrumental: bool('Music only: no vocals. Default true.'),
      custom_mode: bool('Music only: exact lyrics/style mode; needs style+title.'),
      style: str('Custom music only: genre/mood.'),
      title: str('Custom music only: track title.'),
      negative_tags: str('Custom music only: styles to avoid.'),
      vocal_gender: str('Custom vocal music only: m or f.'),

      // Gateway-neutral on purpose: the managed agent is provisioned once, for every media gateway.
      duration: num(
        `Seconds. Effects, where the gateway prices them per second: ${FAL_EFFECT_SECONDS.min}-` +
          `${FAL_EFFECT_SECONDS.max}, default ${FAL_EFFECT_SECONDS.default}. ` +
          'Custom music on a Suno gateway (V5_5 only): 10-360.',
      ),
    },
    ['prompt'],
  ),

  /*
   * The project's MCP tools (§4.14, `_specs/managed-only_plan.md` D4). TWO constant tools rather than one
   * custom tool per MCP tool: the agent's tool list is hashed and fixed per rung, and a per-project list
   * would mean an idle-session update and a cold cache on every turn. The dispatcher resolves `mcp_call` by
   * (server, tool) exactly and relays it to the user's sandbox; the servers themselves validate arguments.
   */
  custom(
    'mcp_list_tools',
    "List the MCP tools running in the user's sandbox for this project, with each tool's server, " +
      'description and input schema. Call it when the user mentions an MCP tool or the turn message says ' +
      'MCP tools are available.',
    {},
  ),
  custom(
    'mcp_call',
    "Run one of the project's MCP tools in the user's sandbox and get its result. Pass the EXACT server and " +
      "tool names from mcp_list_tools — two servers may expose the same tool name — and the tool's arguments " +
      'as an object matching its input schema.',
    {
      server: str('The MCP server that owns the tool, exactly as mcp_list_tools reports it'),
      tool: str('The tool name, exactly as mcp_list_tools reports it'),
      arguments: { type: 'object', description: "The tool's arguments, matching its input schema" },
    },
    ['server', 'tool'],
  ),
]);

export const MANAGED_CUSTOM_TOOL_NAMES: readonly string[] = Object.freeze(MANAGED_CUSTOM_TOOLS.map((t) => t.name));

/**
 * The built-in toolset (D4): everything off except read/glob/grep, which the agent uses on the Agent
 * Reference mounted under `/workspace/agent`. bash/write/edit stay DISABLED so nothing the model writes
 * can land anywhere but the project (SPEC §5).
 */
export const MANAGED_BUILTIN_TOOLSET = Object.freeze({
  type: 'agent_toolset_20260401' as const,
  default_config: { enabled: false },
  configs: [
    { name: 'read' as const, enabled: true },
    { name: 'glob' as const, enabled: true },
    { name: 'grep' as const, enabled: true },
  ],
});

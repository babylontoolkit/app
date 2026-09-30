/**
 * Unity Bridge operation validation — shape checks and the path wall (D20).
 *
 * Spec: `_specs/unity-bridge-local-gltf_spec.md` B4/B6/B7.
 *
 * The Desktop Agent carries a CommonJS port of tiers/validate in `lib/bridge/policy.js` (D3) — change
 * both, and both test tables, together.
 *
 * The model uses Unity-project-relative paths only: absolute, home-relative, drive-letter and `..` paths
 * are refused here AND again on the user's machine.
 */
import { BRIDGE_MAX_CAPTURE_PX, type BridgeOperation } from './protocol';

export const PATH_PARAMS = new Set(['output', 'folder', 'save_path', 'file', 'outputPath']);

/**
 * Param keys a `unity.command` may never carry (D41): they name the Unity CLI's own options, so a model
 * could otherwise turn a parameter into `--yes` or re-point `--project-path`. The helper also passes
 * every param after `--`, where the CLI stops reading options. `timeout` and `format` are NOT here: real
 * commands declare them (`eval`, `run_tests`, `get_serialized_fields`), and after `--` they reach the
 * command, never the CLI.
 */
export const RESERVED_PARAM_KEYS = new Set([
  'yes',
  'project-path',
  'non-interactive',
  'result-only',
  'detach',
  'project',
]);

const MAX_SOURCE_CHARS = 200_000;
const MAX_CLI_ARG_CHARS = 512;
const MAX_BLENDER_PATHS = 32;
const COMMAND_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SCRIPT_ENTRY = /^[A-Za-z_][\w.]*\.[A-Za-z_]\w*$/;

/**
 * A Unity project folder name inside the helper's projects folder (D54). Never a path; never contains '..';
 * never ends in a dot or a space (Windows silently rewrites those, so the folder would not be the one named).
 */
export const PROJECT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_-])?$/;

const PROJECT_ACTIONS = new Set(['list', 'open', 'create']);

export function isValidProjectName(name: unknown): boolean {
  return typeof name === 'string' && PROJECT_NAME.test(name) && !name.includes('..');
}

/** true for '/x', '\\x', '~/x', 'C:\\x', 'C:/x', or any value with a '..' path segment. */
export function isUnsafePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~')) {
    return true;
  }

  // A drive root or a drive path ('C:', 'C:/x', 'C:\\x') — never any 'x:' prefix ('t:Texture' is a search).
  if (/^[A-Za-z]:([\\/]|$)/.test(value)) {
    return true;
  }

  return value.split(/[\\/]/).some((segment) => segment === '..');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

function isIntegerIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function checkSource(source: unknown): string | null {
  if (typeof source !== 'string' || source.length === 0) {
    return 'The script source is empty — pass the full script text.';
  }

  if (source.length > MAX_SOURCE_CHARS) {
    return `The script source is ${source.length} characters; the limit is ${MAX_SOURCE_CHARS}.`;
  }

  return null;
}

function checkPathList(label: string, list: unknown): string | null {
  if (!Array.isArray(list) || list.length > MAX_BLENDER_PATHS || list.some((item) => typeof item !== 'string')) {
    return `${label} must be a list of at most ${MAX_BLENDER_PATHS} Unity-project-relative paths.`;
  }

  const unsafe = (list as string[]).find(isUnsafePath);

  if (unsafe !== undefined) {
    return `${label} contains "${unsafe}" — use a Unity-project-relative path (no leading /, \\, ~, drive letter or "..").`;
  }

  return null;
}

/** null when valid, else a sentence for the model. */
export function validateOperation(op: BridgeOperation): string | null {
  switch (op.kind) {
    case 'unity.command': {
      if (typeof op.name !== 'string' || !COMMAND_NAME.test(op.name)) {
        return 'The command name must be a lower-case Unity command name such as "set_transform" — call unity_list_commands to see them.';
      }

      if (!isPlainObject(op.params)) {
        return 'The command params must be a JSON object.';
      }

      for (const [key, value] of Object.entries(op.params)) {
        if (!PARAM_KEY.test(key)) {
          return `The command parameter name "${key}" is not valid — use the parameter names unity_list_commands shows.`;
        }

        if (RESERVED_PARAM_KEYS.has(key)) {
          return `The command parameter "${key}" is not allowed — it is reserved for the Unity Bridge itself.`;
        }

        if (PATH_PARAMS.has(key) && typeof value === 'string' && isUnsafePath(value)) {
          return `The "${key}" path "${value}" is not allowed — use a Unity-project-relative path (for scratch output, .bridge/out/…).`;
        }
      }

      return null;
    }

    case 'unity.cli': {
      if (!Array.isArray(op.args)) {
        return 'The Unity CLI arguments must be a list of strings.';
      }

      for (const arg of op.args) {
        if (typeof arg !== 'string' || arg.length > MAX_CLI_ARG_CHARS) {
          return `Every Unity CLI argument must be a string of at most ${MAX_CLI_ARG_CHARS} characters.`;
        }

        if (arg.includes('\0')) {
          return 'A Unity CLI argument may not contain a NUL character.';
        }

        if (isUnsafePath(arg)) {
          return `The Unity CLI argument "${arg}" is not allowed — use a Unity-project-relative path.`;
        }
      }

      return null;
    }

    case 'unity.script': {
      const sourceError = checkSource(op.source);

      if (sourceError) {
        return sourceError;
      }

      if (typeof op.entry !== 'string' || !SCRIPT_ENTRY.test(op.entry)) {
        return 'The script entry must be a static method written as Class.Method (for example "BridgeScript.Run").';
      }

      return null;
    }

    case 'unity.capture': {
      if (!isIntegerIn(op.width, 64, BRIDGE_MAX_CAPTURE_PX) || !isIntegerIn(op.height, 64, BRIDGE_MAX_CAPTURE_PX)) {
        return `The capture width and height must be whole numbers between 64 and ${BRIDGE_MAX_CAPTURE_PX}.`;
      }

      return null;
    }

    case 'blender.script': {
      const sourceError = checkSource(op.source);

      if (sourceError) {
        return sourceError;
      }

      const inputsError = checkPathList('inputs', op.inputs);

      if (inputsError) {
        return inputsError;
      }

      const outputsError = checkPathList('outputs', op.outputs);

      if (outputsError) {
        return outputsError;
      }

      if (!isIntegerIn(op.timeoutSeconds, 10, 3600)) {
        return 'The Blender timeoutSeconds must be a whole number between 10 and 3600.';
      }

      return null;
    }

    case 'devserver.start': {
      if (op.port !== undefined && !isIntegerIn(op.port, 1025, 65535)) {
        return 'The dev server port must be a whole number between 1025 and 65535.';
      }

      return null;
    }

    case 'unity.project': {
      if (typeof op.action !== 'string' || !PROJECT_ACTIONS.has(op.action)) {
        return 'unity_project action must be list, open or create.';
      }

      if (op.action === 'list') {
        return null;
      }

      if (op.name === undefined || op.name === null || op.name === '') {
        return `unity_project needs a project name for ${op.action}.`;
      }

      // `open` may name the projects folder too — `<folder>/<name>` — when a name exists in more than one (D55).
      const parts =
        op.action === 'open' && typeof op.name === 'string' && op.name.split('/').length === 2
          ? op.name.split('/')
          : [op.name];

      if (!parts.every(isValidProjectName)) {
        return `The Unity project name "${op.name}" is not valid — use letters, numbers, spaces, dots, dashes or underscores.`;
      }

      return null;
    }

    default:
      return null;
  }
}

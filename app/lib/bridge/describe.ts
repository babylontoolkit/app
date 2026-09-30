/**
 * The exact operation a Unity Bridge consent prompt shows (plan T25 step 4: "the Consent dialog shows the exact
 * command"). The tool label (`unity_cli projects clean`, `unity_command delete_gameobject`) names the TOOL, not
 * what will run — a person asked "allow this?" must see the command line itself, including its parameters.
 *
 * Pure and client-safe. Long renderings are cut at {@link MAX_OPERATION_TEXT} characters with an ellipsis.
 */
import type { BridgeOperation } from './protocol';

/** A consent prompt is read, not scrolled: cap the rendering (the full op still runs as sent). */
export const MAX_OPERATION_TEXT = 200;

function cap(text: string): string {
  return text.length > MAX_OPERATION_TEXT ? text.slice(0, MAX_OPERATION_TEXT - 1) + '…' : text;
}

/** One CLI token: bare when it is plain, quoted when it has whitespace or quotes, JSON for non-strings. */
function token(value: unknown): string {
  if (typeof value === 'string') {
    return /^[^\s"']+$/.test(value) ? value : JSON.stringify(value);
  }

  return JSON.stringify(value) ?? String(value);
}

function firstLine(source: string): string {
  return (
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

export function describeOperation(op: BridgeOperation): string {
  switch (op.kind) {
    case 'unity.cli':
      return cap(['unity', ...op.args.map(token)].join(' '));
    case 'unity.command': {
      const params = Object.entries(op.params ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `--${key} ${token(value)}`);

      return cap(['unity command', op.name, ...params].join(' '));
    }
    case 'unity.script':
      return cap(`C# script ${op.entry}\n${firstLine(op.source)}`);
    case 'blender.script':
      return cap(`Blender script\n${firstLine(op.source)}`);
    case 'unity.list':
      return cap(op.query ? `unity command --query ${token(op.query)}` : 'unity command');
    case 'unity.capture':
      return `capture the ${op.view === 'scene' ? 'Scene' : 'Game'} view (${op.width}×${op.height})`;
    case 'unity.editor':
      return `${op.action} the Unity Editor`;
    case 'devserver.start':
      return op.port !== undefined ? `start the dev server on port ${op.port}` : 'start the dev server';
    case 'devserver.status':
      return 'dev server status';
    case 'unity.project':
      return cap(op.name ? `${op.action} Unity project ${token(op.name)}` : `${op.action} Unity projects`);
    default:
      return '';
  }
}

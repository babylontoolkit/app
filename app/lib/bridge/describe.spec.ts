import { describe, expect, it } from 'vitest';
import { describeOperation, MAX_OPERATION_TEXT } from './describe';

describe('describeOperation — the exact operation a consent prompt shows (T25 step 4)', () => {
  it('unity.cli → unity <args…>, not the tool label', () => {
    expect(describeOperation({ kind: 'unity.cli', args: ['projects', 'clean'] })).toBe('unity projects clean');
    expect(describeOperation({ kind: 'unity.cli', args: ['install', '6000.5.10f1', '--module', 'webgl'] })).toBe(
      'unity install 6000.5.10f1 --module webgl',
    );
  });

  it('unity.command → unity command <name> --k v …, with the parameters (strings bare or quoted, others as JSON)', () => {
    expect(
      describeOperation({
        kind: 'unity.command',
        name: 'delete_gameobject',
        params: { target: '/Level/Old Crate', includeChildren: true, ids: [1, 2] },
      }),
    ).toBe('unity command delete_gameobject --target "/Level/Old Crate" --includeChildren true --ids [1,2]');
    expect(describeOperation({ kind: 'unity.command', name: 'save_all', params: {} })).toBe('unity command save_all');
  });

  it('a long rendering is cut at ~200 characters with an ellipsis', () => {
    const text = describeOperation({ kind: 'unity.command', name: 'set_text', params: { text: 'x'.repeat(500) } });

    expect(text.length).toBe(MAX_OPERATION_TEXT);
    expect(text.startsWith('unity command set_text --text ')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
  });

  it('scripts → the entry and the first line of the source', () => {
    expect(
      describeOperation({ kind: 'unity.script', entry: 'Fix.Run', source: '\n  using UnityEditor;\nclass Fix {}' }),
    ).toBe('C# script Fix.Run\nusing UnityEditor;');
    expect(
      describeOperation({
        kind: 'blender.script',
        source: 'import bpy\nbpy.ops.wm.save()',
        inputs: [],
        outputs: [],
        timeoutSeconds: 60,
      }),
    ).toBe('Blender script\nimport bpy');
  });
});

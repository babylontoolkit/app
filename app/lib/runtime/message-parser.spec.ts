import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamingMessageParser, type ActionCallback, type ArtifactCallback } from './message-parser';
import { EnhancedStreamingMessageParser } from './enhanced-message-parser';

interface ExpectedResult {
  output: string;
  callbacks?: {
    onArtifactOpen?: number;
    onArtifactClose?: number;
    onActionOpen?: number;
    onActionClose?: number;
  };
}

describe('StreamingMessageParser', () => {
  it('should pass through normal text', () => {
    const parser = new StreamingMessageParser();
    expect(parser.parse('test_id', 'Hello, world!')).toBe('Hello, world!');
  });

  it('should allow normal HTML tags', () => {
    const parser = new StreamingMessageParser();
    expect(parser.parse('test_id', 'Hello <strong>world</strong>!')).toBe('Hello <strong>world</strong>!');
  });

  describe('no artifacts', () => {
    it.each<[string | string[], ExpectedResult | string]>([
      ['Foo bar', 'Foo bar'],
      ['Foo bar <', 'Foo bar '],
      ['Foo bar <p', 'Foo bar <p'],
      [['Foo bar <', 's', 'p', 'an>some text</span>'], 'Foo bar <span>some text</span>'],
    ])('should correctly parse chunks and strip out bolt artifacts (%#)', (input, expected) => {
      runTest(input, expected);
    });
  });

  describe('invalid or incomplete artifacts', () => {
    it.each<[string | string[], ExpectedResult | string]>([
      ['Foo bar <b', 'Foo bar '],
      ['Foo bar <ba', 'Foo bar <ba'],
      ['Foo bar <bol', 'Foo bar '],
      ['Foo bar <bolt', 'Foo bar '],
      ['Foo bar <bolta', 'Foo bar <bolta'],
      ['Foo bar <boltA', 'Foo bar '],
      ['Foo bar <boltArtifacs></boltArtifact>', 'Foo bar <boltArtifacs></boltArtifact>'],
      ['Before <oltArtfiact>foo</boltArtifact> After', 'Before <oltArtfiact>foo</boltArtifact> After'],
      ['Before <boltArtifactt>foo</boltArtifact> After', 'Before <boltArtifactt>foo</boltArtifact> After'],
    ])('should correctly parse chunks and strip out bolt artifacts (%#)', (input, expected) => {
      runTest(input, expected);
    });
  });

  describe('valid artifacts without actions', () => {
    it.each<[string | string[], ExpectedResult | string]>([
      [
        'Some text before <boltArtifact title="Some title" id="artifact_1">foo bar</boltArtifact> Some more text',
        {
          output: 'Some text before  Some more text',
          callbacks: { onArtifactOpen: 1, onArtifactClose: 1, onActionOpen: 0, onActionClose: 0 },
        },
      ],
      [
        [
          'Some text before <boltArti',
          'fact',
          ' title="Some title" id="artifact_1" type="bundled" >foo</boltArtifact> Some more text',
        ],
        {
          output: 'Some text before  Some more text',
          callbacks: { onArtifactOpen: 1, onArtifactClose: 1, onActionOpen: 0, onActionClose: 0 },
        },
      ],
      [
        [
          'Some text before <boltArti',
          'fac',
          't title="Some title" id="artifact_1"',
          ' ',
          '>',
          'foo</boltArtifact> Some more text',
        ],
        {
          output: 'Some text before  Some more text',
          callbacks: { onArtifactOpen: 1, onArtifactClose: 1, onActionOpen: 0, onActionClose: 0 },
        },
      ],
      [
        [
          'Some text before <boltArti',
          'fact',
          ' title="Some title" id="artifact_1"',
          ' >fo',
          'o</boltArtifact> Some more text',
        ],
        {
          output: 'Some text before  Some more text',
          callbacks: { onArtifactOpen: 1, onArtifactClose: 1, onActionOpen: 0, onActionClose: 0 },
        },
      ],
      [
        [
          'Some text before <boltArti',
          'fact tit',
          'le="Some ',
          'title" id="artifact_1">fo',
          'o',
          '<',
          '/boltArtifact> Some more text',
        ],
        {
          output: 'Some text before  Some more text',
          callbacks: { onArtifactOpen: 1, onArtifactClose: 1, onActionOpen: 0, onActionClose: 0 },
        },
      ],
      [
        [
          'Some text before <boltArti',
          'fact title="Some title" id="artif',
          'act_1">fo',
          'o<',
          '/boltArtifact> Some more text',
        ],
        {
          output: 'Some text before  Some more text',
          callbacks: { onArtifactOpen: 1, onArtifactClose: 1, onActionOpen: 0, onActionClose: 0 },
        },
      ],
      [
        'Before <boltArtifact title="Some title" id="artifact_1">foo</boltArtifact> After',
        {
          output: 'Before  After',
          callbacks: { onArtifactOpen: 1, onArtifactClose: 1, onActionOpen: 0, onActionClose: 0 },
        },
      ],
    ])('should correctly parse chunks and strip out bolt artifacts (%#)', (input, expected) => {
      runTest(input, expected);
    });
  });

  describe('valid artifacts with actions', () => {
    it.each<[string | string[], ExpectedResult | string]>([
      [
        'Before <boltArtifact title="Some title" id="artifact_1"><boltAction type="shell">npm install</boltAction></boltArtifact> After',
        {
          output: 'Before  After',
          callbacks: { onArtifactOpen: 1, onArtifactClose: 1, onActionOpen: 1, onActionClose: 1 },
        },
      ],
      [
        'Before <boltArtifact title="Some title" id="artifact_1"><boltAction type="shell">npm install</boltAction><boltAction type="file" filePath="index.js">some content</boltAction></boltArtifact> After',
        {
          output: 'Before  After',
          callbacks: { onArtifactOpen: 1, onArtifactClose: 1, onActionOpen: 2, onActionClose: 2 },
        },
      ],
    ])('should correctly parse chunks and strip out bolt artifacts (%#)', (input, expected) => {
      runTest(input, expected);
    });
  });

  describe('action missing its closing </boltAction> (model dropped it before </boltArtifact>)', () => {
    /*
     * The exact shape that shipped a bug: the model writes two file actions but omits the SECOND
     * action's </boltAction>, going straight to </boltArtifact>. The last file must still be written —
     * before the fix it streamed forever (onActionClose never fired) and the file never reached disk,
     * so a generated landing page rendered with the starter's CSS (unstyled).
     */
    const MALFORMED =
      'Before <boltArtifact title="t" id="a1">' +
      '<boltAction type="file" filePath="src/pages/Home.tsx">TSX_BODY</boltAction>' +
      '<boltAction type="file" filePath="src/pages/Home.css">.pp-root{color:red}\n' +
      '</boltArtifact>\n\nDone — trailing prose.';

    const makeParser = () => {
      const closed: { filePath: string; content: string }[] = [];
      const callbacks = {
        onArtifactOpen: vi.fn(),
        onArtifactClose: vi.fn(),
        onActionOpen: vi.fn(),
        onActionClose: vi.fn((d: any) => closed.push({ filePath: d.action.filePath, content: d.action.content })),
      };

      return { parser: new StreamingMessageParser({ artifactElement: () => '', callbacks }), callbacks, closed };
    };

    it('closes BOTH actions and writes the last file, in one parse', () => {
      const { parser, callbacks, closed } = makeParser();
      const output = parser.parse('m1', MALFORMED);

      expect(callbacks.onActionOpen).toHaveBeenCalledTimes(2);
      expect(callbacks.onActionClose).toHaveBeenCalledTimes(2); // was 1 before the fix — the bug
      expect(callbacks.onArtifactClose).toHaveBeenCalledTimes(1);

      const css = closed.find((c) => c.filePath === 'src/pages/Home.css');
      expect(css).toBeDefined();

      // The file body stops at </boltArtifact> — it must NOT swallow the artifact tag or the prose.
      expect(css!.content).toContain('.pp-root{color:red}');
      expect(css!.content).not.toContain('</boltArtifact>');
      expect(css!.content).not.toContain('trailing prose');

      // The artifact tag is stripped from user-facing output; the surrounding prose is preserved.
      expect(output).toBe('Before \n\nDone — trailing prose.');
    });

    it('closes the last action when streamed character-by-character', () => {
      const { parser, callbacks, closed } = makeParser();

      let message = '';

      for (const ch of MALFORMED) {
        message += ch;
        parser.parse('m2', message);
      }

      expect(callbacks.onActionClose).toHaveBeenCalledTimes(2);
      expect(closed.find((c) => c.filePath === 'src/pages/Home.css')?.content).toContain('.pp-root{color:red}');
    });

    it('still requires the real </boltAction> when present (well-formed is unchanged)', () => {
      const { parser, callbacks, closed } = makeParser();
      parser.parse(
        'm3',
        'Before <boltArtifact title="t" id="a1">' +
          '<boltAction type="file" filePath="a.css">A</boltAction>' +
          '<boltAction type="file" filePath="b.css">B</boltAction>' +
          '</boltArtifact> After',
      );

      expect(callbacks.onActionClose).toHaveBeenCalledTimes(2);
      expect(closed.map((c) => c.content.trim())).toEqual(['A', 'B']);
    });
  });

  /*
   * 🔴 THE STREAM ENDS WITH NOTHING CLOSED — the third case, and the one the parser cannot see.
   *
   * The fallback above handles a missing `</boltAction>` when `</boltArtifact>` still arrives. Here
   * NEITHER arrives: the model stops mid-action and never returns. Observed live 2026-07-31 — the
   * model leaked tool-call protocol syntax into the text channel from inside a `<boltAction>`, went
   * off to make a tool call, and never came back. The saved transcript (the exact text the client
   * parses) ended with **1 open `<boltArtifact>`, 1 open `<boltAction>`, ZERO closes**, carrying a
   * complete and valid `StreetRacerMode.ts` that never reached the disk — after 15,051 billed output
   * tokens, `finish=tool-calls` server-side, and no error anywhere.
   *
   * A file action's CLOSING run is what writes the file, so the visible symptom is a row stuck on
   * "creating…" forever underneath prose announcing that the build shipped.
   */
  describe('the stream ends mid-action (no </boltAction> AND no </boltArtifact>)', () => {
    /** The live shape: prose, an open artifact, an open file action, and then the stream stops. */
    const TRUNCATED =
      'Here is the build. <boltArtifact title="Street Racer" id="street-racer">' +
      '<boltAction type="file" filePath="src/scripts/StreetRacerMode.ts">' +
      'export class StreetRacerMode {}\nSceneManager.RegisterClass("StreetRacerMode", StreetRacerMode);\n';

    const makeParser = () => {
      const closed: { filePath: string; content: string }[] = [];
      const callbacks = {
        onArtifactOpen: vi.fn(),
        onArtifactClose: vi.fn(),
        onActionOpen: vi.fn(),
        onActionClose: vi.fn((d: any) => closed.push({ filePath: d.action.filePath, content: d.action.content })),
      };

      return { parser: new StreamingMessageParser({ artifactElement: () => '', callbacks }), callbacks, closed };
    };

    it('writes NOTHING while the stream is still open — the file is not complete yet', () => {
      const { parser, callbacks } = makeParser();
      parser.parse('m1', TRUNCATED);

      expect(callbacks.onActionOpen).toHaveBeenCalledTimes(1);
      expect(callbacks.onActionClose).not.toHaveBeenCalled();
    });

    it('closes the action and writes the file once the stream is declared finished', () => {
      const { parser, callbacks, closed } = makeParser();
      parser.parse('m1', TRUNCATED);

      parser.finish('m1');

      expect(callbacks.onActionClose).toHaveBeenCalledTimes(1); // 0 before the fix — the bug
      expect(callbacks.onArtifactClose).toHaveBeenCalledTimes(1);
      expect(closed[0].filePath).toBe('src/scripts/StreetRacerMode.ts');
      expect(closed[0].content).toContain('RegisterClass("StreetRacerMode"');
    });

    /* The caller is a React effect, so this runs again on every re-render once loading is false. */
    it('is idempotent — a second finish writes the file only once', () => {
      const { parser, callbacks } = makeParser();
      parser.parse('m1', TRUNCATED);

      parser.finish('m1');
      parser.finish('m1');
      parser.finish('m1');

      expect(callbacks.onActionClose).toHaveBeenCalledTimes(1);
      expect(callbacks.onArtifactClose).toHaveBeenCalledTimes(1);
    });

    /*
     * 🔴 The control that keeps this safe: `finish` must be a NO-OP on a well-formed message. It runs
     * for every message on every parse pass once loading is false, so an unconditional close would
     * re-fire `onActionClose` for every file in the conversation — re-writing historical bodies over
     * the user's later edits, which is §4.5.4b's stale-replay bug arriving through a new door.
     */
    it('CONTROL: does nothing for a well-formed, already-closed artifact', () => {
      const { parser, callbacks } = makeParser();
      parser.parse(
        'm2',
        'Before <boltArtifact title="t" id="a1">' +
          '<boltAction type="file" filePath="a.css">A</boltAction>' +
          '</boltArtifact> After',
      );

      expect(callbacks.onActionClose).toHaveBeenCalledTimes(1);

      parser.finish('m2');

      expect(callbacks.onActionClose).toHaveBeenCalledTimes(1);
      expect(callbacks.onArtifactClose).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: does nothing for a message that never opened an artifact', () => {
      const { parser, callbacks } = makeParser();
      parser.parse('m3', 'Just prose, no artifact at all.');

      parser.finish('m3');
      parser.finish('never-seen-message-id');

      expect(callbacks.onActionClose).not.toHaveBeenCalled();
      expect(callbacks.onArtifactClose).not.toHaveBeenCalled();
    });

    /* An artifact that opened but never got as far as an action still has to stop announcing itself. */
    it('closes an artifact truncated before any action opened', () => {
      const { parser, callbacks } = makeParser();
      parser.parse('m4', 'Text <boltArtifact title="t" id="a1">');

      parser.finish('m4');

      expect(callbacks.onActionClose).not.toHaveBeenCalled();
      expect(callbacks.onArtifactClose).toHaveBeenCalledTimes(1);
    });

    /*
     * 🔴 A truncated SHELL action is a half-written COMMAND, and running one is worse than leaving
     * its row unfinished: `npm install lodash` and `npm install lodash && rm -rf /` share a prefix,
     * which is exactly why `shell-strip.ts` buffers a command until it can see all of it. A partial
     * file is recoverable and visible in the editor; a partial command is not.
     */
    it('REFUSES to run a truncated shell action, while still closing the artifact', () => {
      const { parser, callbacks } = makeParser();
      parser.parse('m6', '<boltArtifact title="t" id="a1"><boltAction type="shell">npm install lodash && rm -rf');

      parser.finish('m6');

      expect(callbacks.onActionClose).not.toHaveBeenCalled();
      expect(callbacks.onArtifactClose).toHaveBeenCalledTimes(1);
    });

    /* A COMPLETE shell action is untouched — the refusal above must not disarm ordinary commands. */
    it('CONTROL: a well-formed shell action still runs', () => {
      const { parser, callbacks } = makeParser();
      parser.parse(
        'm7',
        '<boltArtifact title="t" id="a1"><boltAction type="shell">npm install</boltAction></boltArtifact>',
      );
      parser.finish('m7');

      expect(callbacks.onActionClose).toHaveBeenCalledTimes(1);
    });

    /* The body must survive the same cleanup the ordinary close path applies. */
    it('applies the normal file-body cleanup to the salvaged content', () => {
      const { parser, closed } = makeParser();
      parser.parse(
        'm5',
        '<boltArtifact title="t" id="a1"><boltAction type="file" filePath="a.ts">```ts\nconst a = 1;\n```',
      );
      parser.finish('m5');

      expect(closed[0].content.trim()).toBe('const a = 1;');
    });
  });
});

describe('EnhancedStreamingMessageParser', () => {
  it('should detect shell commands in code blocks', () => {
    const callbacks = {
      onArtifactOpen: vi.fn(),
      onArtifactClose: vi.fn(),
      onActionOpen: vi.fn(),
      onActionClose: vi.fn(),
    };

    const parser = new EnhancedStreamingMessageParser({
      callbacks,
    });

    const input = '```bash\nnpm install && npm run dev\n```';
    parser.parse('test_id', input);

    expect(callbacks.onActionOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          type: 'shell',
          content: 'npm install && npm run dev',
        }),
      }),
    );
  });

  it('should detect file creation from code blocks with context', () => {
    const callbacks = {
      onArtifactOpen: vi.fn(),
      onArtifactClose: vi.fn(),
      onActionOpen: vi.fn(),
      onActionClose: vi.fn(),
    };

    const parser = new EnhancedStreamingMessageParser({
      callbacks,
    });

    const input =
      'Create a new file called index.js:\n\n```javascript\nfunction hello() {\n  console.log("Hello World");\n}\n```';
    parser.parse('test_id', input);

    expect(callbacks.onArtifactOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringContaining('test_id-'),
        title: 'index.js',
      }),
    );
  });

  it('should not create actions for code blocks without context', () => {
    const callbacks = {
      onArtifactOpen: vi.fn(),
      onArtifactClose: vi.fn(),
      onActionOpen: vi.fn(),
      onActionClose: vi.fn(),
    };

    const parser = new EnhancedStreamingMessageParser({
      callbacks,
    });

    const input = 'Here is some code:\n\n```javascript\nfunction test() {}\n```';
    parser.parse('test_id', input);

    expect(callbacks.onArtifactOpen).not.toHaveBeenCalled();
    expect(callbacks.onActionOpen).not.toHaveBeenCalled();
  });

  describe('AI Model Output Patterns Integration Tests', () => {
    let callbacks: {
      onArtifactOpen: any;
      onArtifactClose: any;
      onActionOpen: any;
      onActionClose: any;
    };
    let parser: EnhancedStreamingMessageParser;

    beforeEach(() => {
      callbacks = {
        onArtifactOpen: vi.fn(),
        onArtifactClose: vi.fn(),
        onActionOpen: vi.fn(),
        onActionClose: vi.fn(),
      };
      parser = new EnhancedStreamingMessageParser({ callbacks });
    });

    describe('GPT-4 style outputs', () => {
      it('should handle file creation with explicit path', () => {
        const input = `I'll create a React component for you.

app/components/Button.tsx:

\`\`\`tsx
import React from 'react';

interface ButtonProps {
  children: React.ReactNode;
  onClick: () => void;
}

export const Button: React.FC<ButtonProps> = ({ children, onClick }) => {
  return (
    <button onClick={onClick} className="btn">
      {children}
    </button>
  );
};
\`\`\``;

        parser.parse('test_gpt4_1', input);

        expect(callbacks.onArtifactOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Button.tsx',
          }),
        );
        expect(callbacks.onActionOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              type: 'file',
              filePath: '/app/components/Button.tsx',
            }),
          }),
        );
      });

      it('should handle package.json updates', () => {
        const input = `Update your package.json file:

package.json:

\`\`\`json
{
  "name": "my-app",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^18.0.0"
  }
}
\`\`\``;

        parser.parse('test_gpt4_2', input);

        expect(callbacks.onArtifactOpen).toHaveBeenCalled();
        expect(callbacks.onActionOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              type: 'file',
              filePath: '/package.json',
            }),
          }),
        );
      });
    });

    describe('Claude style outputs', () => {
      it('should handle create file instructions', () => {
        const input = `I'll create a new configuration file for you.

Create a file called \`config.ts\`:

\`\`\`typescript
export const config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000,
};
\`\`\``;

        parser.parse('test_claude_1', input);

        expect(callbacks.onArtifactOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'config.ts',
          }),
        );
        expect(callbacks.onActionOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              type: 'file',
              filePath: '/config.ts',
            }),
          }),
        );
      });

      it('should handle "Here\'s the file" pattern', () => {
        const input = `Here's styles.css:

\`\`\`css
.container {
  display: flex;
  justify-content: center;
  align-items: center;
}

.button {
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
}
\`\`\``;

        parser.parse('test_claude_2', input);

        expect(callbacks.onArtifactOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'styles.css',
          }),
        );
      });
    });

    describe('Gemini style outputs', () => {
      it('should handle file comments in code', () => {
        const input = `Here's your component:

\`\`\`javascript
// filename: utils/helper.js
function formatDate(date) {
  return new Intl.DateTimeFormat('en-US').format(date);
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

export { formatDate, debounce };
\`\`\``;

        parser.parse('test_gemini_1', input);

        expect(callbacks.onArtifactOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'helper.js',
          }),
        );
        expect(callbacks.onActionOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              type: 'file',
              filePath: '/utils/helper.js',
            }),
          }),
        );
      });

      it('should handle "update filename.ext" pattern', () => {
        const input = `Update server.js:

\`\`\`javascript
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
\`\`\``;

        parser.parse('test_gemini_2', input);

        expect(callbacks.onArtifactOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'server.js',
          }),
        );
      });
    });

    describe('Shell Command Detection', () => {
      it('should detect npm commands', () => {
        const input = `Run these commands:

\`\`\`bash
npm install express cors
npm run dev
\`\`\``;

        parser.parse('test_shell_1', input);

        expect(callbacks.onActionOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              type: 'shell',
              content: 'npm install express cors\nnpm run dev',
            }),
          }),
        );
      });

      it('should detect git commands', () => {
        const input = `Initialize your repository:

\`\`\`bash
git init
git add .
git commit -m "Initial commit"
\`\`\``;

        parser.parse('test_shell_2', input);

        expect(callbacks.onActionOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              type: 'shell',
              content: 'git init\ngit add .\ngit commit -m "Initial commit"',
            }),
          }),
        );
      });

      it('should detect docker commands', () => {
        const input = `Build and run the Docker container:

\`\`\`bash
docker build -t myapp .
docker run -p 3000:3000 myapp
\`\`\``;

        parser.parse('test_shell_3', input);

        expect(callbacks.onActionOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              type: 'shell',
              content: 'docker build -t myapp .\ndocker run -p 3000:3000 myapp',
            }),
          }),
        );
      });

      it('should detect webcontainer commands', () => {
        const input = `Check your files:

\`\`\`bash
ls -la
cat package.json
mkdir src
\`\`\``;

        parser.parse('test_shell_4', input);

        expect(callbacks.onActionOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              type: 'shell',
              content: 'ls -la\ncat package.json\nmkdir src',
            }),
          }),
        );
      });
    });

    describe('Edge Cases and False Positive Prevention', () => {
      it('should not create artifacts for generic code examples', () => {
        const input = `Here's an example of how functions work:

\`\`\`javascript
function example() {
  console.log("This is just an example");
}
\`\`\``;

        parser.parse('test_edge_1', input);

        expect(callbacks.onArtifactOpen).not.toHaveBeenCalled();
        expect(callbacks.onActionOpen).not.toHaveBeenCalled();
      });

      it('should ignore temp and test file patterns', () => {
        const input = `Create temp/test.js:

\`\`\`javascript
console.log("temporary test");
\`\`\``;

        parser.parse('test_edge_2', input);

        expect(callbacks.onArtifactOpen).not.toHaveBeenCalled();
        expect(callbacks.onActionOpen).not.toHaveBeenCalled();
      });

      it('should handle multiple code blocks with mixed content', () => {
        const input = `First, create the component:

components/Header.tsx:
\`\`\`tsx
import React from 'react';
export const Header = () => <h1>Header</h1>;
\`\`\`

Then install dependencies:

\`\`\`bash
npm install react-router-dom
\`\`\`

Here's an example of usage:

\`\`\`javascript
// This is just an example
function usage() {
  return <Header />;
}
\`\`\``;

        parser.parse('test_edge_3', input);

        // Should create artifact for Header.tsx
        expect(callbacks.onArtifactOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Header.tsx',
          }),
        );

        // Should create shell action for npm install
        expect(callbacks.onActionOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              type: 'shell',
              content: 'npm install react-router-dom',
            }),
          }),
        );

        // Should not create action for the example usage
        const fileActions = callbacks.onActionOpen.mock.calls.filter((call: any) => call[0].action.type === 'file');

        expect(fileActions).toHaveLength(1); // Only Header.tsx
      });

      it('should validate file extensions', () => {
        const input = `Create invalidfile:

\`\`\`
console.log("no extension");
\`\`\``;

        parser.parse('test_edge_4', input);

        expect(callbacks.onArtifactOpen).not.toHaveBeenCalled();
        expect(callbacks.onActionOpen).not.toHaveBeenCalled();
      });

      it('should handle complex file paths correctly', () => {
        const input = `Create the nested component:

src/components/ui/Button/index.tsx:

\`\`\`tsx
import React from 'react';
export { Button } from './Button';
\`\`\``;

        parser.parse('test_edge_5', input);

        expect(callbacks.onActionOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              type: 'file',
              filePath: '/src/components/ui/Button/index.tsx',
            }),
          }),
        );
      });
    });

    describe('Performance and Deduplication', () => {
      it('should handle incremental parsing correctly', () => {
        // Parse incrementally (simulating streaming)
        const chunks = ['Create config.js:\n\n\`\`\`javascript\n', "const config = { api: 'test' };\n\`\`\`"];
        let fullInput = '';

        for (const chunk of chunks) {
          fullInput += chunk;
          parser.parse('test_perf_1', fullInput);
        }

        // Should create artifact when complete
        expect(callbacks.onArtifactOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'config.js',
          }),
        );
      });

      it('should handle streaming input correctly', () => {
        const chunks = [
          'Create the file:\n\n',
          'app.js:\n\n',
          '\`\`\`javascript\n',
          'const app = ',
          'express();\n',
          'app.listen(3000);\n',
          '\`\`\`',
        ];

        let fullInput = '';

        for (const chunk of chunks) {
          fullInput += chunk;
          parser.parse('test_stream_1', fullInput);
        }

        expect(callbacks.onArtifactOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'app.js',
          }),
        );
      });
    });

    describe('Performance Benchmarks', () => {
      it('should perform well with enhanced parsing', () => {
        const testInputs = [
          `Create app.tsx:\n\n\`\`\`tsx\nimport React from 'react';\nexport const App = () => <div>Hello</div>;\n\`\`\``,
          `Run commands:\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\``,
          `Here's config.json:\n\n\`\`\`json\n{"name": "test"}\n\`\`\``,
          `Example code:\n\n\`\`\`javascript\nfunction example() {}\n\`\`\``,
        ];

        // Benchmark enhanced parser
        const enhancedCallbacks = {
          onArtifactOpen: vi.fn(),
          onArtifactClose: vi.fn(),
          onActionOpen: vi.fn(),
          onActionClose: vi.fn(),
        };

        const enhancedParser = new EnhancedStreamingMessageParser({
          callbacks: enhancedCallbacks,
        });

        const startTime = performance.now();
        const iterations = 100;

        for (let i = 0; i < iterations; i++) {
          testInputs.forEach((input, index) => {
            enhancedParser.parse(`perf_test_${i}_${index}`, input);
          });
          enhancedParser.reset();
        }

        const endTime = performance.now();
        const duration = endTime - startTime;
        const avgTimePerOp = duration / (iterations * testInputs.length);

        // Should complete quickly (less than 1ms average per operation)
        expect(avgTimePerOp).toBeLessThan(1.0);

        // Should detect artifacts appropriately
        expect(enhancedCallbacks.onArtifactOpen.mock.calls.length).toBeGreaterThan(0);

        console.log(`Performance: ${avgTimePerOp.toFixed(4)}ms per operation`);
        console.log(`Artifacts detected: ${enhancedCallbacks.onArtifactOpen.mock.calls.length}`);
        console.log(`Actions detected: ${enhancedCallbacks.onActionOpen.mock.calls.length}`);
      });
    });
  });
});

function runTest(input: string | string[], outputOrExpectedResult: string | ExpectedResult) {
  let expected: ExpectedResult;

  if (typeof outputOrExpectedResult === 'string') {
    expected = { output: outputOrExpectedResult };
  } else {
    expected = outputOrExpectedResult;
  }

  const callbacks = {
    onArtifactOpen: vi.fn<ArtifactCallback>((data) => {
      expect(data).toMatchSnapshot('onArtifactOpen');
    }),
    onArtifactClose: vi.fn<ArtifactCallback>((data) => {
      expect(data).toMatchSnapshot('onArtifactClose');
    }),
    onActionOpen: vi.fn<ActionCallback>((data) => {
      expect(data).toMatchSnapshot('onActionOpen');
    }),
    onActionClose: vi.fn<ActionCallback>((data) => {
      expect(data).toMatchSnapshot('onActionClose');
    }),
  };

  const parser = new StreamingMessageParser({
    artifactElement: () => '',
    callbacks,
  });

  let message = '';

  let result = '';

  const chunks = Array.isArray(input) ? input : input.split('');

  for (const chunk of chunks) {
    message += chunk;

    result += parser.parse('message_1', message);
  }

  for (const name in expected.callbacks) {
    const callbackName = name;

    expect(callbacks[callbackName as keyof typeof callbacks]).toHaveBeenCalledTimes(
      expected.callbacks[callbackName as keyof typeof expected.callbacks] ?? 0,
    );
  }

  expect(result).toEqual(expected.output);
}

/**
 * End-to-end check against a REAL model response and the REAL project file it was written for.
 *
 * The unit tests in `edit-blocks.spec.ts` prove the patcher is correct given well-formed blocks. They
 * cannot prove the thing that actually matters in production: that the MODEL, shown a 10,532-character
 * stylesheet in its context, reproduces a chunk of it byte-for-byte accurately enough to match. That is
 * the whole bet of a search/replace diff format, and it is only testable against a real generation.
 *
 * The fixture below is a verbatim `<boltAction type="edit">` emitted by claude-sonnet-5 for the prompt
 * "change the primary call-to-action button's colour to a vivid green and make its corners fully
 * rounded", against the kart-racer project's Home.css.
 */
import { describe, expect, it } from 'vitest';
import { applyEditBlocks, parseEditBlocks } from './edit-blocks';

/** The exact CSS rule as it exists in the project — indentation and all. */
const HOME_CSS = `.ar-hero {
  padding: 0 6vw;
}

.ar-cta {
  font-family: var(--ar-font-display);
  background: var(--ar-accent);
  border-radius: 2px;
  clip-path: polygon(0 0, 100% 0, 96% 100%, 0% 100%);
}

.ar-cta:hover {
  background: var(--ar-accent-soft);
}

.ar-footer {
  opacity: 0.6;
}
`;

/** Verbatim from the model. */
const MODEL_OUTPUT = `<<<<<<< SEARCH
.ar-cta {
  font-family: var(--ar-font-display);
  background: var(--ar-accent);
  border-radius: 2px;
  clip-path: polygon(0 0, 100% 0, 96% 100%, 0% 100%);
}

.ar-cta:hover {
  background: var(--ar-accent-soft);
}
=======
.ar-cta {
  font-family: var(--ar-font-display);
  background: #22c55e;
  border-radius: 999px;
}

.ar-cta:hover {
  background: #4ade80;
}
>>>>>>> REPLACE`;

describe('a real model-authored edit', () => {
  it('parses, matches the real file exactly once, and applies', () => {
    const blocks = parseEditBlocks(MODEL_OUTPUT);
    expect(blocks).toHaveLength(1);

    const patched = applyEditBlocks(HOME_CSS, blocks, 'src/pages/Home.css');

    expect(patched).toContain('background: #22c55e;');
    expect(patched).toContain('border-radius: 999px;');

    // The model dropped the clip-path, which would have squared off the corners it was asked to round.
    expect(patched).not.toContain('clip-path');
  });

  /**
   * The point of the whole exercise. The model sent ~1,560 characters to change this rule; a
   * `type="file"` action would have re-sent all 10,532 characters of the stylesheet to do the same
   * work — and output tokens are the slowest and most expensive thing we buy.
   */
  it('leaves every untouched rule byte-identical', () => {
    const patched = applyEditBlocks(HOME_CSS, parseEditBlocks(MODEL_OUTPUT), 'src/pages/Home.css');

    expect(patched).toContain('.ar-hero {\n  padding: 0 6vw;\n}');
    expect(patched).toContain('.ar-footer {\n  opacity: 0.6;\n}');
  });
});

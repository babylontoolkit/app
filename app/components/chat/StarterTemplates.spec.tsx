// @vitest-environment jsdom
/**
 * THE OTHER SIDE OF THE `/git?url=` CONTRACT (T8).
 *
 * `GitUrlImport.spec.tsx` asserts what the ROUTE reads — `searchParams.get('url')`, forwarded to the
 * shared import module with no branch. Nothing asserted what the LINK writes, and a two-sided contract
 * that only one side pins is how a rename silently breaks a link: `StarterTemplates` is a plain `<a>`
 * with a hand-built query string, so renaming the param, dropping the `.git` suffix, or making the URL
 * relative would leave both files individually "correct" and every starter template dead. The route
 * would receive no `url` and bounce to `/`, which reads as a template that does not exist.
 *
 * The assertion is deliberately made THROUGH the same reader the route uses (`new URL` +
 * `searchParams.get`) rather than against the literal string — the property is "the route can read the
 * repository back out", not "the template string looks like this".
 *
 * ⚠️ NOT asserted here: that each `githubRepo` names a real `owner/repo`. One inherited entry in
 * `STARTER_TEMPLATES` (`bolt-sveltekit-template`) carries no owner, so its link points at
 * `https://github.com/bolt-sveltekit-template.git`, which cannot resolve. That is an upstream DATA
 * defect in `app/utils/constants.ts`, not a defect in this contract, and pinning it here would fail the
 * suite for a reason this file is not about.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import StarterTemplates from './StarterTemplates';
import { STARTER_TEMPLATES } from '~/utils/constants';

describe('a starter template is a link to the /git import route', () => {
  it('builds a href the /git route can read the repository back out of', () => {
    render(<StarterTemplates />);

    const links = screen.getAllByRole('link');
    expect(links.length).toBe(STARTER_TEMPLATES.length);

    for (const [index, link] of links.entries()) {
      const href = link.getAttribute('href') ?? '';

      // Resolved exactly as a browser would, so a relative path or a renamed param cannot pass.
      const url = new URL(href, 'http://localhost');
      expect(url.pathname).toBe('/git');

      const repo = url.searchParams.get('url');
      expect(repo).toBe(`https://github.com/${STARTER_TEMPLATES[index].githubRepo}.git`);

      /*
       * Absolute and `.git`-suffixed: the route hands this string to the server unchanged, and the
       * `.git` suffix is what `projectNameFromRepo` strips to name the project.
       */
      expect(repo?.startsWith('https://github.com/')).toBe(true);
      expect(repo?.endsWith('.git')).toBe(true);
    }
  });
});

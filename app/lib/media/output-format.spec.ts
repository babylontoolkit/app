import { describe, expect, it } from 'vitest';
import { resolveImageOutputFormat } from './output-format';

describe('resolveImageOutputFormat', () => {
  it('honours an explicit choice, whatever the hints say', () => {
    // Explicit png even for photographic art; explicit jpg even for a logo.
    expect(resolveImageOutputFormat('png', { prompt: 'a sunset over mountains' })).toBe('png');
    expect(resolveImageOutputFormat('jpg', { fileName: 'company-logo', prompt: 'transparent logo' })).toBe('jpg');
  });

  it('normalises casing/whitespace on the explicit choice', () => {
    expect(resolveImageOutputFormat('  PNG ')).toBe('png');
    expect(resolveImageOutputFormat('JPG')).toBe('jpg');
  });

  it('defaults unspecified photographic art to jpg (the size win that prevents the freeze)', () => {
    expect(resolveImageOutputFormat(undefined, { prompt: 'a race car on an asphalt track' })).toBe('jpg');
    expect(resolveImageOutputFormat('', { fileName: 'hero-background' })).toBe('jpg');
    expect(resolveImageOutputFormat(undefined)).toBe('jpg');
  });

  it('falls back to png for unspecified transparency-needing art (alpha safety)', () => {
    expect(resolveImageOutputFormat(undefined, { fileName: 'street-logo-wordmark' })).toBe('png');
    expect(resolveImageOutputFormat(undefined, { prompt: 'a cut-out character sprite' })).toBe('png');
    expect(resolveImageOutputFormat(undefined, { prompt: 'game icon with transparency' })).toBe('png');
    expect(resolveImageOutputFormat(undefined, { fileName: 'team-emblem' })).toBe('png');
  });

  it('treats a non-png/jpg explicit value as unspecified rather than trusting it', () => {
    expect(resolveImageOutputFormat('webp', { prompt: 'a photographic scene' })).toBe('jpg');
    expect(resolveImageOutputFormat('gif', { fileName: 'emblem' })).toBe('png');
  });
});

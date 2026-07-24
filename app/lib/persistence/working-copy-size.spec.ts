import { describe, expect, it } from 'vitest';
import type { FileMap } from '~/lib/stores/files';
import {
  DEFAULT_CLIENT_WORKING_COPY_MAX_MB,
  estimateSerializedBytes,
  withinWorkingCopyBudget,
} from './working-copy-size';

const MB = 1024 * 1024;

function binary(size: number): FileMap[string] {
  return { type: 'file', content: '', isBinary: true, size, isLocked: false };
}

function text(content: string): FileMap[string] {
  return { type: 'file', content, isBinary: false, isLocked: false };
}

describe('estimateSerializedBytes', () => {
  it('counts a binary as its base64-inflated size (the freeze was underestimating this)', () => {
    const files: FileMap = { '/home/project/public/hero.png': binary(30 * MB) };
    const estimate = estimateSerializedBytes(files);

    // ~30MB × 4/3 base64 × JSON headroom — comfortably above the raw byte count, never below.
    expect(estimate).toBeGreaterThan(30 * MB);
    expect(estimate).toBeGreaterThan(38 * MB);
  });

  it('counts text by its content length and folders as ~free', () => {
    const files: FileMap = {
      '/home/project/src/a.ts': text('x'.repeat(1000)),
      '/home/project/src': { type: 'folder' },
    };

    // Path + structure overhead is small; the 1000 chars dominate.
    expect(estimateSerializedBytes(files)).toBeGreaterThanOrEqual(1000);
    expect(estimateSerializedBytes(files)).toBeLessThan(1200);
  });

  it('ignores undefined dirents (deleted keys)', () => {
    const files: FileMap = { '/home/project/gone.ts': undefined };
    expect(estimateSerializedBytes(files)).toBe(0);
  });
});

describe('withinWorkingCopyBudget', () => {
  it('passes a small project and fails a media-bloated one at the default budget', () => {
    const small: FileMap = { '/home/project/src/main.ts': text('hello') };
    expect(withinWorkingCopyBudget(small)).toBe(true);

    // Eight big PNGs — the shape that froze the tab — must be over budget.
    const bloated: FileMap = {};

    for (let i = 0; i < 8; i++) {
      bloated[`/home/project/public/assets/generated/img-${i}.png`] = binary(20 * MB);
    }

    expect(estimateSerializedBytes(bloated)).toBeGreaterThan(DEFAULT_CLIENT_WORKING_COPY_MAX_MB * MB);
    expect(withinWorkingCopyBudget(bloated)).toBe(false);
  });

  it('honours an explicit override', () => {
    const files: FileMap = { '/home/project/public/hero.png': binary(10 * MB) };
    expect(withinWorkingCopyBudget(files, 5 * MB)).toBe(false);
    expect(withinWorkingCopyBudget(files, 100 * MB)).toBe(true);
  });

  it('disables the gate (never blocks all saves) on a non-positive or non-finite limit', () => {
    const files: FileMap = {};

    for (let i = 0; i < 20; i++) {
      files[`/home/project/public/img-${i}.png`] = binary(50 * MB);
    }

    expect(withinWorkingCopyBudget(files, 0)).toBe(true);
    expect(withinWorkingCopyBudget(files, Number.NaN)).toBe(true);
    expect(withinWorkingCopyBudget(files, Number.POSITIVE_INFINITY)).toBe(true);
  });
});

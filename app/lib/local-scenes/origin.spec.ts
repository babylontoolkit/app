// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLocalSceneServer, saveLocalSceneServer } from './origin';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('local scene server origin', () => {
  it('save then read round-trips per project id', () => {
    saveLocalSceneServer('p1', 'http://localhost:8888');
    saveLocalSceneServer('p2', 'http://localhost:9999');

    expect(readLocalSceneServer('p1')).toBe('http://localhost:8888');
    expect(readLocalSceneServer('p2')).toBe('http://localhost:9999');
    expect(localStorage.getItem('bt_local_scene_server:p1')).toBe('http://localhost:8888');
  });

  it('save(id, null) removes it', () => {
    saveLocalSceneServer('p1', 'http://localhost:8888');
    saveLocalSceneServer('p1', null);

    expect(readLocalSceneServer('p1')).toBeNull();
  });

  it('a throwing localStorage → read returns null, save does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(readLocalSceneServer('p1')).toBeNull();
    expect(() => saveLocalSceneServer('p1', 'http://localhost:8888')).not.toThrow();
    expect(() => saveLocalSceneServer('p1', null)).not.toThrow();
  });
});

import { expect } from '@open-wc/testing';
import {
  LEGACY_STORAGE_PREFIX,
  STORAGE_PREFIX,
  migrateLegacyStorage,
} from '../legacy-storage.ts';

/** Minimal in-memory Storage so tests never touch the real localStorage. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  } as Storage;
}

describe('migrateLegacyStorage', () => {
  it('uses the expected prefixes', () => {
    expect(LEGACY_STORAGE_PREFIX).to.equal('leviathan-');
    expect(STORAGE_PREFIX).to.equal('gitnado-');
  });

  it('copies every leviathan-* key to gitnado-* and removes the old key', () => {
    const storage = memoryStorage({
      'leviathan-settings': '{"theme":"dark"}',
      'leviathan-graph-zoom': '1.5',
      'leviathan-recent-commands': '["a"]',
    });

    const migrated = migrateLegacyStorage(storage);

    expect(migrated).to.equal(3);
    expect(storage.getItem('gitnado-settings')).to.equal('{"theme":"dark"}');
    expect(storage.getItem('gitnado-graph-zoom')).to.equal('1.5');
    expect(storage.getItem('gitnado-recent-commands')).to.equal('["a"]');
    expect(storage.getItem('leviathan-settings')).to.be.null;
    expect(storage.getItem('leviathan-graph-zoom')).to.be.null;
    expect(storage.getItem('leviathan-recent-commands')).to.be.null;
    expect(storage.length).to.equal(3);
  });

  it('never overwrites an existing gitnado-* value', () => {
    const storage = memoryStorage({
      'leviathan-settings': 'old',
      'gitnado-settings': 'new',
    });

    const migrated = migrateLegacyStorage(storage);

    expect(migrated).to.equal(0);
    expect(storage.getItem('gitnado-settings')).to.equal('new');
    expect(storage.getItem('leviathan-settings')).to.be.null;
  });

  it('leaves unrelated keys untouched', () => {
    const storage = memoryStorage({
      'some-other-app': 'x',
      leviathan: 'no-dash-suffix',
      'gitnado-already': 'y',
    });

    expect(migrateLegacyStorage(storage)).to.equal(0);
    expect(storage.getItem('some-other-app')).to.equal('x');
    expect(storage.getItem('leviathan')).to.equal('no-dash-suffix');
    expect(storage.getItem('gitnado-already')).to.equal('y');
    expect(storage.length).to.equal(3);
  });

  it('is a no-op on empty storage and idempotent afterwards', () => {
    const storage = memoryStorage({ 'leviathan-a': '1' });
    expect(migrateLegacyStorage(storage)).to.equal(1);
    expect(migrateLegacyStorage(storage)).to.equal(0);
    expect(storage.getItem('gitnado-a')).to.equal('1');
    expect(migrateLegacyStorage(memoryStorage())).to.equal(0);
  });

  it('returns 0 when storage enumeration throws', () => {
    const storage = {
      get length(): number {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(migrateLegacyStorage(storage)).to.equal(0);
  });

  it('skips a key whose write fails and keeps its legacy value for next launch', () => {
    const base = memoryStorage({ 'leviathan-a': '1', 'leviathan-b': '2' });
    const storage = {
      ...base,
      get length() {
        return base.length;
      },
      key: base.key,
      getItem: base.getItem,
      removeItem: base.removeItem,
      setItem: (k: string, v: string) => {
        if (k === 'gitnado-a') throw new Error('quota');
        base.setItem(k, v);
      },
    } as Storage;

    expect(migrateLegacyStorage(storage)).to.equal(1);
    expect(base.getItem('leviathan-a')).to.equal('1');
    expect(base.getItem('gitnado-a')).to.be.null;
    expect(base.getItem('gitnado-b')).to.equal('2');
    expect(base.getItem('leviathan-b')).to.be.null;
  });

  it('works against the real localStorage', () => {
    localStorage.setItem('leviathan-test-key', 'real');
    localStorage.removeItem('gitnado-test-key');
    try {
      expect(migrateLegacyStorage()).to.be.at.least(1);
      expect(localStorage.getItem('gitnado-test-key')).to.equal('real');
      expect(localStorage.getItem('leviathan-test-key')).to.be.null;
    } finally {
      localStorage.removeItem('gitnado-test-key');
      localStorage.removeItem('leviathan-test-key');
    }
  });
});

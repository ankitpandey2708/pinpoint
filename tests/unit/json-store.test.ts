import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../../src/storage/json-store';

interface Widget {
  id: string;
  name: string;
  count?: number;
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pinpoint-store-'));
  file = join(dir, 'widgets.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('JsonStore', () => {
  it('initializes to an empty list when the file does not exist', async () => {
    const store = new JsonStore<Widget>(file);
    expect(await store.list()).toEqual([]);
  });

  it('inserts and reads a record back', async () => {
    const store = new JsonStore<Widget>(file);
    const inserted = await store.insert({ id: 'w1', name: 'alpha' });
    expect(inserted.name).toBe('alpha');
    expect(await store.get('w1')).toEqual({ id: 'w1', name: 'alpha' });
    expect(await store.list()).toHaveLength(1);
  });

  it('updates an existing record by merging a patch', async () => {
    const store = new JsonStore<Widget>(file);
    await store.insert({ id: 'w1', name: 'alpha', count: 1 });
    const updated = await store.update('w1', { count: 2 });
    expect(updated).toEqual({ id: 'w1', name: 'alpha', count: 2 });
  });

  it('rejects duplicate ids on insert', async () => {
    const store = new JsonStore<Widget>(file);
    await store.insert({ id: 'w1', name: 'alpha' });
    await expect(store.insert({ id: 'w1', name: 'beta' })).rejects.toThrow(/exists/i);
  });

  it('throws when updating a missing record', async () => {
    const store = new JsonStore<Widget>(file);
    await expect(store.update('nope', { name: 'x' })).rejects.toThrow(/not found/i);
  });

  it('serializes concurrent writes without losing records', async () => {
    const store = new JsonStore<Widget>(file);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.insert({ id: `w${i}`, name: `n${i}` })),
    );
    const all = await store.list();
    expect(all).toHaveLength(25);
    const ids = new Set(all.map((w) => w.id));
    expect(ids.size).toBe(25);
  });

  it('ignores a leftover temp file from an interrupted write', async () => {
    const store = new JsonStore<Widget>(file);
    await store.insert({ id: 'w1', name: 'alpha' });
    // Simulate a crash after writing the temp file but before rename.
    await writeFile(join(dir, 'widgets.json.tmp-999-abcd'), '{ this is: not valid json', 'utf8');
    expect(await store.list()).toEqual([{ id: 'w1', name: 'alpha' }]);
  });

  it('writes via a temp file and leaves no temp files behind after success', async () => {
    const store = new JsonStore<Widget>(file);
    await store.insert({ id: 'w1', name: 'alpha' });
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes('.tmp-'))).toEqual([]);
    // File contains formatted JSON.
    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('\n');
    expect(JSON.parse(raw)).toHaveLength(1);
  });
});

import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, basename, join } from 'node:path';

/**
 * Generic append/update JSON collection persisted as a formatted JSON array.
 * Mutations are serialized through an in-process promise chain and written with
 * a temp-file-then-rename strategy so an interrupted write cannot corrupt the
 * committed file. Record contents are never logged.
 */
export class JsonStore<T extends { id: string }> {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async list(): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const trimmed = raw.trim();
    if (trimmed === '') return [];
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed as T[];
  }

  async get(id: string): Promise<T | undefined> {
    const all = await this.list();
    return all.find((r) => r.id === id);
  }

  async insert(record: T): Promise<T> {
    return this.enqueue(async () => {
      const all = await this.list();
      if (all.some((r) => r.id === record.id)) {
        throw new Error(`record with id "${record.id}" already exists`);
      }
      all.push(record);
      await this.persist(all);
      return record;
    });
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    return this.enqueue(async () => {
      const all = await this.list();
      const idx = all.findIndex((r) => r.id === id);
      if (idx === -1) {
        throw new Error(`record with id "${id}" not found`);
      }
      const merged = { ...all[idx], ...patch, id } as T;
      all[idx] = merged;
      await this.persist(all);
      return merged;
    });
  }

  /** Chain a mutation onto the queue so writes never interleave. */
  private enqueue<R>(task: () => Promise<R>): Promise<R> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even if a task rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(records: T[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = join(
      dirname(this.filePath),
      `${basename(this.filePath)}.tmp-${process.pid}-${randomUUID()}`,
    );
    const data = JSON.stringify(records, null, 2);
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.filePath);
  }
}

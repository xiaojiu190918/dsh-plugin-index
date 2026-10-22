/** On-disk cache so hourly rebuilds stay inside GitHub/npm budgets. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class Cache {
  constructor(path, ttlMs) {
    this.path = path;
    this.ttlMs = ttlMs;
    this.data = { entries: {} };
    this.dirty = false;
  }

  static async open(path, { ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    const cache = new Cache(path, ttlMs);
    try {
      cache.data = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      cache.data = { entries: {} };
    }
    return cache;
  }

  get(key) {
    const hit = this.data.entries[key];
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) return undefined;
    return hit.value;
  }

  set(key, value) {
    this.data.entries[key] = { at: Date.now(), value };
    this.dirty = true;
    return value;
  }

  async flush() {
    if (!this.dirty) return;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    this.dirty = false;
  }
}

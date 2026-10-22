/** npm registry access: packument, bounded tarball inspection, downloads. */

import { gunzipSync } from 'node:zlib';
import { getBuffer, getJson } from './net.mjs';

export const REGISTRY = process.env.DSH_INDEX_REGISTRY ?? 'https://registry.npmjs.org';

export function encodeName(name) {
  return name.startsWith('@') ? name.replace('/', '%2F') : name;
}

export async function packument(name) {
  return await getJson(`${REGISTRY}/${encodeName(name)}`, { timeoutMs: 30000 });
}

export async function searchKeyword(keyword, { from = 0, size = 250, timeoutMs = 30000 } = {}) {
  const url = `${REGISTRY}/-/v1/search?text=keywords:${encodeURIComponent(keyword)}&size=${String(size)}&from=${String(from)}`;
  const body = await getJson(url, { timeoutMs });
  return {
    total: body.total ?? 0,
    objects: (body.objects ?? []).map((object) => ({
      name: object.package?.name,
      version: object.package?.version,
      description: object.package?.description ?? '',
      keywords: object.package?.keywords ?? [],
      links: object.package?.links ?? {},
      publisher: object.package?.publisher ?? {},
      date: object.package?.date ?? null,
      downloads: object.downloads ?? {},
      updated: object.updated ?? null,
    })),
  };
}

export async function searchText(text, { from = 0, size = 250 } = {}) {
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(text)}&size=${String(size)}&from=${String(from)}`;
  const body = await getJson(url, { timeoutMs: 30000 });
  return {
    total: body.total ?? 0,
    objects: (body.objects ?? []).map((object) => ({
      name: object.package?.name,
      version: object.package?.version,
      description: object.package?.description ?? '',
      links: object.package?.links ?? {},
      publisher: object.package?.publisher ?? {},
      date: object.package?.date ?? null,
    })),
  };
}

export async function monthlyDownloads(name) {
  try {
    const body = await getJson(`https://api.npmjs.org/downloads/point/last-month/${encodeName(name)}`, {
      timeoutMs: 15000,
      retries: 1,
    });
    return Number(body.downloads ?? 0);
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* tarball inspection: the only trustworthy answer to "is this really a bundle?" */
/* ------------------------------------------------------------------ */

function tarString(buffer, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buffer[end] !== 0) end += 1;
  return buffer.toString('utf8', offset, end);
}

function octal(buffer, offset, length) {
  const text = tarString(buffer, offset, length).trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Parse ustar entries until `wanted` is found. Handles the long-name and pax
 * extensions npm emits for deep paths.
 */
export function readTarEntries(buffer, { maxEntries = 10000 } = {}) {
  const entries = [];
  let offset = 0;
  let pendingName = null;
  for (let index = 0; index < maxEntries; index += 1) {
    if (offset + 512 > buffer.length) break;
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const fullName = prefix ? `${prefix}/${name}` : name;

    if (typeflag === 'L') {
      pendingName = buffer.toString('utf8', dataStart, dataEnd).replace(/\0+$/u, '');
    } else if (typeflag === 'x') {
      const text = buffer.toString('utf8', dataStart, dataEnd);
      const match = /\d+ path=([^\n]+)\n/u.exec(text);
      if (match) pendingName = match[1];
    } else if (typeflag === '0' || typeflag === '\0') {
      const entryName = pendingName ?? fullName;
      pendingName = null;
      entries.push({
        name: entryName,
        size,
        content: () => buffer.subarray(dataStart, dataEnd),
      });
      if (entries.length >= maxEntries) break;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export async function inspectTarball(name, version, { maxBytes, maxEntries = 10000, meta } = {}) {
  const packumentValue = meta ?? (await packument(name));
  const manifest = packumentValue.versions?.[version];
  if (!manifest) throw new Error(`version ${version} not found for ${name}`);
  const tarballUrl = manifest.dist?.tarball;
  if (!tarballUrl) throw new Error(`no tarball for ${name}@${version}`);

  const compressed = await getBuffer(tarballUrl, { maxBytes: maxBytes ?? 32 * 1024 * 1024 });
  let tar;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw Object.assign(new Error('tarball decompresses beyond 256 MiB'), { code: 'TOO_LARGE' });
    throw error;
  }
  const entries = readTarEntries(tar, { maxEntries });
  const byName = new Map(entries.map((entry) => [entry.name.replace(/^package\//u, ''), entry]));

  const pkgEntry = byName.get('package.json');
  if (!pkgEntry) throw new Error('tarball has no package.json');
  const pkg = JSON.parse(pkgEntry.content().toString('utf8'));

  return {
    manifest,
    pkg,
    tarballUrl,
    compressedBytes: compressed.byteLength,
    unpackedBytes: tar.byteLength,
    entryCount: entries.length,
    files: [...byName.keys()],
    has: (path) => byName.has(path),
    read: (path) => byName.get(path)?.content().toString('utf8'),
    dist: {
      integrity: manifest.dist?.integrity ?? null,
      shasum: manifest.dist?.shasum ?? null,
      unpublished: false,
    },
  };
}

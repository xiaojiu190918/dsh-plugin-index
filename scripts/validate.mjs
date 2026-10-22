/**
 * Post-build verification. Runs after build.mjs and is also the CI gate:
 * a document that the official reader would reject must never ship.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import { parseMarketIndex, useSemver } from './lib/format.mjs';

useSemver(semver);

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');
const SITE = join(ROOT, 'site');
const BASE = process.env.INDEX_BASE_URL ?? 'https://example.github.io/dsh-plugin-index/index.json';
const DOCS = [['index.json'], ['reviewed', 'index.json'], ['staging', 'index.json']];

const problems = [];
const notes = [];

async function officialValidator() {
  try {
    const mod = await import('@deepseek-ai/dsh-plugin-market-index');
    return mod;
  } catch {
    return null;
  }
}

const official = await officialValidator();
notes.push(official ? 'official validator: available (cross-checked)' : 'official validator: not installed (mirror only)');

for (const segments of DOCS) {
  const path = join(SITE, ...segments);
  const raw = await readFile(path, 'utf8');
  const bytes = Buffer.byteLength(raw);
  const url = new URL(segments.join('/'), BASE).href;
  const document = JSON.parse(raw);

  let parsed;
  try {
    parsed = parseMarketIndex(document, url);
  } catch (error) {
    problems.push(`${segments.join('/')}: mirror rejected ${error.path} — ${error.reason}`);
    continue;
  }
  if (official) {
    try {
      official.parseMarketIndex(document, url);
    } catch (error) {
      problems.push(`${segments.join('/')}: official validator rejected ${error.path ?? '?'} — ${error.reason ?? error.message}`);
    }
  }

  // invariants our own pipeline must hold, beyond format validity
  const names = new Set();
  let previousQuality = Infinity;
  let previousName = '';
  for (const plugin of parsed.plugins) {
    if (names.has(plugin.name)) problems.push(`${segments.join('/')}: duplicate ${plugin.name}`);
    names.add(plugin.name);
    if (plugin.metadata.sortKeys.quality === undefined) problems.push(`${segments.join('/')}: ${plugin.name} has no quality sortKey`);
    else if (plugin.metadata.sortKeys.quality > previousQuality) problems.push(`${segments.join('/')}: order breaks quality sort at ${plugin.name}`);
    else if (plugin.metadata.sortKeys.quality === previousQuality && plugin.name < previousName) {
      problems.push(`${segments.join('/')}: tie not ordered by name at ${plugin.name}`);
    }
    previousQuality = plugin.metadata.sortKeys.quality ?? previousQuality;
    previousName = plugin.name;

    for (const version of plugin.versions) {
      if (version.source.type === 'npm') continue;
      if (!/^[0-9a-f]{40}$/u.test(version.source.commit)) problems.push(`${segments.join('/')}: ${plugin.name} git commit not pinned`);
    }
    if (plugin.icon && !plugin.icon.startsWith('data:')) {
      const iconPath = join(SITE, ...segments.slice(0, -1), decodeURIComponent(new URL(plugin.icon).pathname.split('/').pop()));
      try {
        await stat(join(SITE, 'icons', iconPath.split(/[\\/]/u).pop()));
      } catch {
        problems.push(`${segments.join('/')}: ${plugin.name} icon missing on disk`);
      }
    }
  }

  if (parsed.plugins.length === 0 && segments[0] === 'index.json') problems.push('index.json: empty listing');
  if (bytes > 8 * 1024 * 1024) notes.push(`${segments.join('/')}: ${(bytes / 1024 / 1024).toFixed(2)} MiB — large document, consider splitting by category`);

  notes.push(`${segments.join('/')}: ${String(parsed.plugins.length)} plugins, ${(bytes / 1024).toFixed(1)} KiB, ${url}`);
}

for (const note of notes) console.log(`note  ${note}`);
for (const problem of problems) console.log(`FAIL  ${problem}`);
console.log(problems.length === 0 ? 'validate: OK' : `validate: ${String(problems.length)} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);

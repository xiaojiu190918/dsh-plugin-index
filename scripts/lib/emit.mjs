/** Materialize the site: index.json, staging/index.json, icons, manifest, revocations. */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function slug(name) {
  return name
    .replace(/^@/u, '')
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase()
    .slice(0, 80);
}

function hue(name) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) % 360;
  return hash;
}

/** Deterministic, privacy-preserving icon: no remote image host learns the user's IP. */
export function iconSvg(name, { size = 96 } = {}) {
  const letters = name
    .replace(/^@/u, '')
    .split(/[/\-_.]/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2) || 'D';
  const base = hue(name);
  const from = `hsl(${String(base)} 70% 52%)`;
  const to = `hsl(${String((base + 40) % 360)} 70% 38%)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}" viewBox="0 0 ${String(size)} ${String(size)}" role="img" aria-label="${escapeXml(name)}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
  <rect width="${String(size)}" height="${String(size)}" rx="22" fill="url(#g)"/>
  <text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="${String(Math.round(size * 0.38))}" font-weight="600" fill="#fff">${escapeXml(letters)}</text>
</svg>
`;
}

function escapeXml(text) {
  return text.replace(/[<>&"']/gu, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[char]);
}

export async function writeSite({ siteDir, documents, manifest, previousDigests = {} }) {
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(join(siteDir, 'icons'), { recursive: true });
  await mkdir(join(siteDir, 'staging'), { recursive: true });

  const icons = new Set();
  for (const document of documents) {
    for (const plugin of document.document.plugins) {
      icons.add(plugin.name);
    }
  }
  for (const name of icons) {
    await writeFile(join(siteDir, 'icons', `${slug(name)}.svg`), iconSvg(name), 'utf8');
  }

  const digests = {};
  for (const document of documents) {
    const path = join(siteDir, ...document.path);
    await mkdir(join(path, '..'), { recursive: true });
    const text = `${JSON.stringify(document.document, null, 2)}\n`;
    await writeFile(path, text, 'utf8');
    digests[document.path.join('/')] = { sha256: sha256(text), bytes: Buffer.byteLength(text), plugins: document.document.plugins.length };
  }

  const changed = Object.entries(digests).filter(([path, value]) => previousDigests[path]?.sha256 !== value.sha256).map(([path]) => path);

  const manifestText = `${JSON.stringify(
    {
      schema: 'dsh-plugin-index/manifest@1',
      generatedAt: new Date().toISOString(),
      dshBaseline: manifest.baseline,
      tool: { name: 'dsh-plugin-index', version: manifest.toolVersion },
      documents: digests,
      changed,
      stats: manifest.stats,
      sources: manifest.sources,
    },
    null,
    2,
  )}\n`;
  await writeFile(join(siteDir, 'manifest.json'), manifestText, 'utf8');

  if (manifest.revocations.length > 0) {
    await writeFile(join(siteDir, 'revocations.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), entries: manifest.revocations }, null, 2)}\n`, 'utf8');
  }
  return { digests, changed };
}

export async function readPreviousDigests(siteDir) {
  try {
    const manifest = JSON.parse(await readFile(join(siteDir, 'manifest.json'), 'utf8'));
    return manifest.documents ?? {};
  } catch {
    return {};
  }
}

/**
 * Candidate discovery.
 *
 * Order of trust, cheapest first:
 *   1. `seeds` — hand-picked package names, always kept.
 *   2. npm keyword search, sliced — the only high-recall surface that is stable
 *      and free (no auth, no 1,000-result cap when sliced by term).
 *   3. npm full-text check for scopes we care about.
 *   4. GitHub topic search — supplementary recall only; it must re-verify the
 *      manifest anyway, so it never decides admission by itself.
 *   5. Meta-index ingest — optional third-party format-1 indexes as feeders.
 *
 * Output: data/corpus.json { generatedAt, candidates: { name: { sources, firstSeen, lastSeen } } }
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { searchKeyword, searchText } from './lib/npm.mjs';
import { hasToken, searchRepos } from './lib/github.mjs';
import { getJson } from './lib/net.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');
const DATA = join(ROOT, 'data');

/** Terms that thicken the keyword slices: npm search has no deep pagination. */
const SLICE_TERMS = ['dsh', 'plugin', 'bundle', 'agent', 'skill', 'tool', 'mcp', 'ui', 'web', 'terminal', 'market'];

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function addCandidate(corpus, name, source) {
  if (!name) return;
  const entry = (corpus.candidates[name] ??= { sources: [], firstSeen: new Date().toISOString() });
  if (!entry.sources.includes(source)) entry.sources.push(source);
  entry.lastSeen = new Date().toISOString();
}

async function npmSweep(sources, corpus, log) {
  for (const keyword of sources.npmKeywords ?? []) {
    const pages = [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000].slice(0, 8);
    let seen = 0;
    for (const from of pages) {
      try {
        const page = await searchKeyword(keyword, { from, size: 250 });
        if (page.objects.length === 0) break;
        for (const object of page.objects) addCandidate(corpus, object.name, `npm:keywords:${keyword}`);
        seen += page.objects.length;
        if (from + page.objects.length >= page.total) break;
      } catch (error) {
        log(`npm keyword ${keyword} from=${String(from)} failed: ${error.message}`);
        break;
      }
    }
    log(`npm keywords:${keyword} -> ${String(seen)} rows`);
  }

  // Thicker slices: `text` supports multiple terms; `keywords:` cannot be combined
  // with free text, so use plain text and let the manifest gate filter noise.
  for (const term of SLICE_TERMS) {
    for (const from of [0, 250, 500]) {
      try {
        const page = await searchText(`dsh ${term}`, { from, size: 250 });
        for (const object of page.objects) addCandidate(corpus, object.name, `npm:text:dsh+${term}`);
      } catch (error) {
        log(`npm text "dsh ${term}" from=${String(from)} failed: ${error.message}`);
        break;
      }
    }
  }

  for (const scope of sources.npmScopes ?? []) {
    try {
      const page = await searchText(scope, { from: 0, size: 250 });
      for (const object of page.objects) addCandidate(corpus, object.name, `npm:scope:${scope}`);
      log(`npm scope ${scope} -> ${String(page.objects.length)} rows (total ${String(page.total)})`);
    } catch (error) {
      log(`npm scope ${scope} failed: ${error.message}`);
    }
  }
}

async function githubSweep(sources, corpus, log) {
  if (!sources.github?.repoNameSearch) return;
  if (!hasToken()) {
    log('GitHub sweep skipped: no GITHUB_TOKEN (search is 10 req/min unauthenticated and repos over the cap are unreachable)');
    return;
  }
  const queries = ['topic:dsh-plugin archived:false fork:false', 'topic:dsh-bundle archived:false fork:false', 'dsh-plugin in:name archived:false'];
  for (const query of queries) {
    for (let page = 1; page <= 10; page += 1) {
      try {
        const result = await searchRepos(query, { page, perPage: 100 });
        if (result.items.length === 0) break;
        for (const item of result.items) addCandidate(corpus, `repo:${item.fullName}`, `github:${query}`);
        if (page * 100 >= result.total) break;
      } catch (error) {
        log(`github "${query}" page ${String(page)} failed: ${error.message}`);
        break;
      }
    }
  }
}

async function metaIndexSweep(sources, corpus, log) {
  for (const url of sources.metaIndexes ?? []) {
    try {
      const document = await getJson(url, { timeoutMs: 30000, retries: 1 });
      if (document.format !== 1 || !Array.isArray(document.plugins)) {
        log(`meta index ${url} is not format 1; ignored`);
        continue;
      }
      for (const plugin of document.plugins) addCandidate(corpus, plugin.name, `meta:${new URL(url).host}`);
      log(`meta index ${url} -> ${String(document.plugins.length)} plugins`);
    } catch (error) {
      log(`meta index ${url} failed: ${error.message}`);
    }
  }
}

async function main() {
  const sources = await readJson(join(DATA, 'sources.json'), {});
  const previous = await readJson(join(DATA, 'corpus.json'), { candidates: {} });
  const corpus = { generatedAt: new Date().toISOString(), candidates: previous.candidates ?? {} };
  const lines = [];
  const log = (line) => {
    lines.push(line);
    console.log(line);
  };

  for (const name of sources.seeds ?? []) addCandidate(corpus, name, 'seed');
  await npmSweep(sources, corpus, log);
  await githubSweep(sources, corpus, log);
  await metaIndexSweep(sources, corpus, log);

  const candidates = Object.entries(corpus.candidates).filter(([name]) => !name.startsWith('repo:'));
  const repoCandidates = Object.entries(corpus.candidates).filter(([name]) => name.startsWith('repo:'));

  // `repo:` entries are recorded for the git lane and never treated as npm names.
  const output = {
    generatedAt: corpus.generatedAt,
    counts: { packages: candidates.length, repos: repoCandidates.length },
    candidates: Object.fromEntries(candidates.sort(([left], [right]) => left.localeCompare(right))),
    repos: Object.fromEntries(repoCandidates.sort(([left], [right]) => left.localeCompare(right))),
  };
  await mkdir(dirname(join(DATA, 'corpus.json')), { recursive: true });
  await writeFile(join(DATA, 'corpus.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await writeFile(join(DATA, 'discover.log'), `${lines.join('\n')}\n`, 'utf8');
  console.log(`corpus: ${String(candidates.length)} packages, ${String(repoCandidates.length)} repos`);
}

await main();

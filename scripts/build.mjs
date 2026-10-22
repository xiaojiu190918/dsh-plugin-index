/**
 * Build the published site.
 *
 * Fail-closed pipeline per candidate:
 *   packument → dsh.bundle marker → tarball proof (patch exists, no install scripts)
 *   → hard gates → score → document
 * Any violated hard gate removes the candidate and records why in data/build-report.json.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import semver from 'semver';
import { parseMarketIndex, marketInstallTarget, useSemver } from './lib/format.mjs';
import { inspectTarball, monthlyDownloads, packument } from './lib/npm.mjs';
import { parseRepo, repoMeta, resolveCommit, hasToken } from './lib/github.mjs';
import { checkGates } from './lib/gates.mjs';
import { scorePlugin } from './lib/score.mjs';
import { Cache } from './lib/state.mjs';
import { iconSvg, readPreviousDigests, sha256, slug, writeSite } from './lib/emit.mjs';

const run = promisify(execFile);
useSemver(semver);

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');
const DATA = join(ROOT, 'data');
const SITE = join(ROOT, 'site');
const CACHE_DIR = join(ROOT, '.cache');
const BASELINE = process.env.DSH_BASELINE ?? '0.2.1';
const INDEX_BASE_URL = process.env.INDEX_BASE_URL ?? 'https://example.github.io/dsh-plugin-index/index.json';
const TOOL_VERSION = '0.1.0';

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const cache = await Cache.open(join(CACHE_DIR, 'state.json'), { ttlMs: 6 * 60 * 60 * 1000 });

function slim(meta) {
  const latest = meta['dist-tags']?.latest;
  const versions = {};
  for (const [version, manifest] of Object.entries(meta.versions ?? {})) {
    versions[version] = {
      dsh: manifest.dsh ?? null,
      engines: manifest.engines ?? null,
      scripts: manifest.scripts ?? null,
      deprecated: manifest.deprecated ?? null,
      license: manifest.license ?? null,
      description: manifest.description ?? null,
      keywords: manifest.keywords ?? null,
      author: manifest.author ?? null,
      homepage: manifest.homepage ?? null,
      repository: manifest.repository ?? null,
      peerDependencies: manifest.peerDependencies ?? null,
      dist: { integrity: manifest.dist?.integrity ?? null, attestations: manifest.dist?.attestations ?? null, tarball: manifest.dist?.tarball ?? null },
    };
  }
  return {
    name: meta.name,
    distTags: meta['dist-tags'] ?? {},
    latest,
    time: meta.time ?? {},
    publisher:
      meta._npmUser?.name ??
      meta.versions?.[latest]?._npmUser?.name ??
      (meta.maintainers ?? [])
        .map((maintainer) => (typeof maintainer === 'string' ? maintainer : maintainer?.name))
        .filter(Boolean)[0] ??
      null,
    maintainers: (meta.maintainers ?? []).map((maintainer) => (typeof maintainer === 'string' ? maintainer : maintainer?.name)).filter(Boolean),
    hasReadme: typeof meta.readme === 'string' && meta.readme.trim() !== '',
    modified: meta.time?.modified ?? null,
    versions,
  };
}

async function getPackument(name) {
  const key = `pkg:${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const meta = slim(await packument(name));
  cache.set(key, meta);
  return meta;
}

async function getRepoReport(repo, meta) {
  const key = `repo:${repo.owner}/${repo.repo}`;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const info = await repoMeta(repo);
    cache.set(key, info);
    return info;
  } catch (error) {
    return { error: error.message };
  }
}

/** Bounded concurrency: fast enough for hourly refresh, polite enough for the registry. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function truncate(text, max) {
  const value = String(text).trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function displayTitle(name) {
  const base = name.replace(/^@[^/]+\//u, '').replace(/^dsh-(?:plugin-)?/u, '');
  return base
    .split(/[-_.]/u)
    .filter(Boolean)
    .map((part) => (part.length <= 3 && part === part.toUpperCase() ? part : part[0].toUpperCase() + part.slice(1)))
    .join(' ')
    .trim() || name;
}

function categorize(keywords, categories) {
  const lowered = keywords.map((keyword) => String(keyword).toLowerCase());
  for (const [id, category] of Object.entries(categories)) {
    if (id.startsWith('$')) continue;
    if ((category.keywords ?? []).some((keyword) => lowered.includes(keyword))) return id;
  }
  return undefined;
}

function normalizeRepository(value) {
  if (!value) return null;
  const url = typeof value === 'string' ? value : value.url;
  const repo = parseRepo(url);
  if (!repo) return null;
  const directory = typeof value === 'object' && typeof value.directory === 'string' ? value.directory.replace(/^\.\//u, '') : undefined;
  return { url: `https://github.com/${repo.owner}/${repo.repo}`, ...(directory ? { directory } : {}), repo };
}

function authorOf(pkg, meta) {
  const value = pkg.author;
  const clean = (text) => text.replace(/<[^>]*>/u, '').replace(/\([^)]*\)/u, '').trim();
  const candidate =
    typeof value === 'string' && value.trim()
      ? clean(value)
      : value && typeof value === 'object' && typeof value.name === 'string' && value.name.trim()
        ? value.name.trim()
        : null;
  // CI publishes often stamp `author: GitHub Actions`; the npm account is the better signal.
  if (candidate && !/github[\s-]?actions|^ci$/iu.test(candidate)) return candidate;
  return meta.publisher ?? candidate ?? 'unknown';
}

function pickVersions(meta, maxVersions) {
  const listed = [];
  for (const [version, manifest] of Object.entries(meta.versions)) {
    if (!semver.valid(version)) continue;
    const patch = manifest.dsh?.bundle?.patch;
    if (!patch) continue;
    const engine = manifest.engines?.dsh;
    if (engine !== undefined && (typeof engine !== 'string' || semver.validRange(engine) === null)) continue;
    listed.push({ version, publishTimestamp: Math.floor(Date.parse(meta.time[version] ?? 0) / 1000), engine, manifest });
  }
  listed.sort((left, right) => semver.rcompare(left.version, right.version));
  return listed.slice(0, maxVersions);
}

async function resolveNpm(name, context) {
  const meta = await getPackument(name);
  if (!meta.latest) return { skip: 'no-dist-tags' };
  const versions = pickVersions(meta, context.limits.maxVersionsPerPlugin);
  if (versions.length === 0) return { skip: 'not-a-bundle' };

  const latest = versions[0];
  let tarball;
  try {
    tarball = await inspectTarball(name, latest.version, { meta: { versions: { [latest.version]: latest.manifest } }, maxBytes: context.limits.maxTarballBytes, maxEntries: context.limits.maxTarEntries });
  } catch (error) {
    return { skip: 'tarball-unreadable', detail: error.message };
  }

  const pkg = tarball.pkg;
  if (pkg.name !== name) return { skip: 'name-mismatch' };
  if (semver.valid(pkg.version) === null) return { skip: 'invalid-version' };

  const repository = normalizeRepository(pkg.repository ?? latest.manifest.repository);
  const repoReport = repository ? await getRepoReport(repository.repo, meta) : null;
  const downloads = await monthlyDownloads(name);
  const major = semver.major(latest.version);
  const reviewed = context.reviewed[name] && context.reviewed[name].major === major ? context.reviewed[name] : undefined;

  const report = {
    repoFullName: repository ? `${repository.repo.owner}/${repository.repo.repo}` : null,
    repoMatchesPackage: Boolean(repository),
    publisher: meta.publisher,
    license: pkg.license ?? latest.manifest.license ?? null,
    archived: Boolean(repoReport?.archived),
    stars: repoReport?.stars ?? 0,
    pushedAt: repoReport?.pushedAt ?? null,
    hasProvenance: Boolean(latest.manifest.dist?.attestations),
    hasReadme: meta.hasReadme,
    monthlyDownloads: downloads,
    latestPublish: meta.time?.[latest.version] ?? null,
    manifestDeprecated: latest.manifest.deprecated ?? null,
    clientUi: Boolean(pkg.dsh?.client),
    major,
  };

  const gates = checkGates({
    name,
    version: latest.version,
    pkg,
    tar: tarball,
    report,
    policy: { ...context.limits, ...context.policy },
    blocklist: context.blocklist,
    reviewed,
    source: { type: 'npm' },
  });
  if (!gates.ok) return { skip: 'gate', failures: gates.failures, warnings: gates.warnings };

  const score = scorePlugin({ pkg, manifest: latest.manifest, report, tar: tarball, labels: gates.labels, baseline: BASELINE, semver });

  return {
    name,
    pkg,
    meta,
    versions,
    report,
    gates,
    score,
    repository,
    author: authorOf(pkg, meta),
    downloads,
    reviewed: Boolean(reviewed),
    source: { type: 'npm' },
  };
}

async function resolveGit(fullName, context) {
  const [owner, repoName] = fullName.split('/');
  const url = `https://github.com/${owner}/${repoName}`;
  let commit;
  try {
    const { stdout } = await run('git', ['ls-remote', url, 'HEAD'], { timeout: 30000 });
    commit = /^([0-9a-f]{40})\s/u.exec(stdout)?.[1];
  } catch {
    return { skip: 'git-unreachable' };
  }
  if (!commit) return { skip: 'git-unreachable' };

  const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repoName}/${commit}/package.json`, {
    headers: { 'user-agent': 'dsh-plugin-index/0.1' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) return { skip: 'no-package-json' };
  const pkg = await response.json();
  if (!pkg.dsh?.bundle?.patch) return { skip: 'not-a-bundle' };

  const patches = Array.isArray(pkg.dsh.bundle.patch) ? pkg.dsh.bundle.patch : [pkg.dsh.bundle.patch];
  for (const patch of patches) {
    const path = String(patch).replace(/^\.\//u, '');
    const patchResponse = await fetch(`https://raw.githubusercontent.com/${owner}/${repoName}/${commit}/${path}`, {
      headers: { 'user-agent': 'dsh-plugin-index/0.1' },
      signal: AbortSignal.timeout(20000),
    });
    if (!patchResponse.ok) return { skip: 'missing-bundle-patch' };
  }

  const recorded = cache.get(`commit:${fullName}:${commit}`);
  let date = recorded?.date;
  if (!date && hasToken()) {
    const resolved = await resolveCommit({ owner, repo: repoName }, commit).catch(() => null);
    date = resolved?.date ?? null;
    cache.set(`commit:${fullName}:${commit}`, { date });
  }
  if (!date) return { skip: 'no-commit-date' };

  const info = (await getRepoReport({ owner, repo: repoName })) ?? { stars: 0 };
  const reviewed = context.reviewed[pkg.name] && context.reviewed[pkg.name].commit === commit ? context.reviewed[pkg.name] : undefined;
  const report = {
    repoFullName: fullName,
    repoMatchesPackage: true,
    publisher: owner,
    license: pkg.license ?? null,
    archived: Boolean(info.archived),
    stars: info.stars ?? 0,
    pushedAt: info.pushedAt ?? null,
    hasProvenance: false,
    hasReadme: true,
    monthlyDownloads: 0,
    latestPublish: date,
    manifestDeprecated: null,
    clientUi: Boolean(pkg.dsh?.client),
    major: semver.major(String(pkg.version ?? '0.0.0')) || 0,
  };

  const gates = checkGates({
    name: pkg.name,
    version: pkg.version,
    pkg,
    tar: { compressedBytes: 0, entryCount: 0, has: () => true, read: () => '', files: [] },
    report,
    policy: { ...context.limits, ...context.policy },
    blocklist: context.blocklist,
    reviewed,
    source: { type: 'git' },
  });
  if (!gates.ok) return { skip: 'gate', failures: gates.failures, warnings: gates.warnings };

  const score = scorePlugin({ pkg, manifest: null, report, tar: { entryCount: 0 }, labels: gates.labels, baseline: BASELINE, semver });
  return {
    name: pkg.name,
    pkg,
    meta: null,
    versions: [{ version: pkg.version, publishTimestamp: Math.floor(Date.parse(date) / 1000), engine: pkg.engines?.dsh, manifest: null }],
    report,
    gates,
    score,
    repository: { url, repo: { owner, repo: repoName } },
    author: authorOf(pkg, { publisher: owner }),
    downloads: 0,
    reviewed: Boolean(reviewed),
    source: { type: 'git', url, commit, path: pkg.dsh?.bundle?.path },
  };
}

function pluginDocument(resolved, context, iconPrefix) {
  const { name, pkg, meta, versions, repository, author, downloads, score, gates, reviewed, source } = resolved;
  const i18n = context.i18n[name] ?? {};
  const keywords = (pkg.keywords ?? []).map(String).slice(0, 12);
  const category = categorize(keywords, context.categories);
  const versionDocs = versions.map((entry) => ({
    version: entry.version,
    publishTimestamp: entry.publishTimestamp,
    source:
      source.type === 'npm'
        ? { type: 'npm' }
        : { type: 'git', url: source.url, commit: source.commit, ...(source.path ? { path: source.path } : {}) },
    ...(entry.engine ? { engines: { dsh: entry.engine } } : {}),
  }));
  const latest = versions[0];
  const repoUrl = repository ? `https://github.com/${repository.repo.owner}/${repository.repo.repo}` : null;
  const homepage = /^https?:\/\//u.test(pkg.homepage ?? '') ? pkg.homepage : repoUrl;
  const englishDescription = truncate(pkg.description ?? 'DSH plugin bundle', 300);
  const zhDescription = i18n.description;
  const document = {
    name,
    title: { en: displayTitle(name), ...(i18n.title ? { zh: i18n.title } : {}) },
    description: { en: englishDescription, ...(zhDescription ? { zh: zhDescription } : {}) },
    icon: `${iconPrefix}${slug(name)}.svg`,
    author,
    metadata: {
      ...(category ? { category } : {}),
      keywords,
      labels: gates.labels.filter((label) => context.labels[label]),
      sortKeys: {
        quality: score.total,
        downloads,
        stars: resolved.report.stars ?? 0,
        updated: latest.publishTimestamp,
      },
    },
    ...(meta?.distTags?.latest && versions.some((entry) => entry.version === meta.distTags.latest)
      ? { 'dist-tags': { latest: meta.distTags.latest } }
      : {}),
    versions: versionDocs,
  };
  if (homepage) document.homepage = homepage;
  if (repoUrl) {
    document.repository = { url: repoUrl, ...(repository.directory ? { directory: repository.directory } : {}) };
  }
  return document;
}

async function main() {
  const sources = await readJson(join(DATA, 'sources.json'), {});
  const categories = await readJson(join(DATA, 'categories.json'), {});
  const blocklist = await readJson(join(DATA, 'blocklist.json'), {});
  const reviewed = await readJson(join(DATA, 'reviewed.json'), {});
  const i18n = await readJson(join(DATA, 'i18n.json'), {});
  const corpus = await readJson(join(DATA, 'corpus.json'), { candidates: {}, repos: {} });

  const context = {
    limits: sources.limits ?? {},
    policy: sources.policy ?? {},
    categories,
    labels: {
      reviewed: { title: { en: 'Reviewed', zh: '已复核' } },
      auto: { title: { en: 'Automated gates', zh: '自动门禁' } },
      official: { title: { en: 'DeepSeek', zh: '官方' } },
      provenance: { title: { en: 'Provenance', zh: '来源证明' } },
      'git-source': { title: { en: 'Git source', zh: 'Git 源' } },
      'no-engines': { title: { en: 'No dsh range', zh: '未声明 dsh 范围' } },
      'archived-upstream': { title: { en: 'Archived upstream', zh: '上游已归档' } },
      deprecated: { title: { en: 'Deprecated', zh: '已弃用' } },
      ui: { title: { en: 'Web UI', zh: '网页界面' } },
      'install-scripts-reviewed': { title: { en: 'Install scripts reviewed', zh: '安装脚本已复核' } },
    },
    reviewed,
    i18n,
    blocklist,
  };

  const report = { generatedAt: new Date().toISOString(), considered: 0, accepted: [], rejected: [], missing: [] };
  const resolved = [];

  const names = Object.keys(corpus.candidates ?? {}).slice(0, Number(process.env.DSH_MAX_CANDIDATES ?? context.limits.maxCandidates ?? 400));
  let done = 0;
  await mapLimit(names, Number(process.env.DSH_CONCURRENCY ?? 6), async (name) => {
    try {
      const result = await resolveNpm(name, context);
      if (result.skip) report.rejected.push({ name, ...result });
      else resolved.push(result);
    } catch (error) {
      report.rejected.push({ name, skip: 'error', detail: error.message });
    }
    done += 1;
    if (done % 25 === 0) {
      console.log(`progress ${String(done)}/${String(names.length)} accepted=${String(resolved.length)}`);
      await cache.flush();
    }
    return null;
  });
  report.considered = names.length;

  const repoLimit = context.policy.gitLane?.maxRepos ?? 0;
  if (repoLimit > 0) {
    const repos = Object.keys(corpus.repos ?? {}).slice(0, repoLimit);
    for (const key of repos) {
      const fullName = key.replace(/^repo:/u, '');
      try {
        const result = await resolveGit(fullName, context);
        if (result.skip) report.rejected.push({ name: fullName, ...result });
        else resolved.push(result);
      } catch (error) {
        report.rejected.push({ name: fullName, skip: 'error', detail: error.message });
      }
    }
  }

  for (const item of resolved) {
    const labels = new Set(item.gates.labels);
    if (item.reviewed) labels.add('reviewed');
    else labels.add('auto');
    item.gates.labels = [...labels];
  }

  const byName = new Map();
  for (const item of resolved) {
    const existing = byName.get(item.name);
    if (!existing || existing.score.total < item.score.total) byName.set(item.name, item);
  }
  const accepted = [...byName.values()].sort((left, right) => right.score.total - left.score.total || left.name.localeCompare(right.name));
  report.accepted = accepted.map((item) => ({ name: item.name, score: item.score, version: item.versions[0].version, labels: item.gates.labels, warnings: item.gates.warnings }));

  const documents = [
    {
      path: ['index.json'],
      iconPrefix: 'icons/',
      document: {
        format: 1,
        title: { en: 'DSH Plugin Index', zh: 'DSH 插件索引' },
        description: {
          en: 'Self-hosted authoritative index: npm-first discovery, fail-closed gates, deterministic quality ranking.',
          zh: '自建权威索引：npm 优先发现、失败即拒绝的门禁、确定性质量排序。',
        },
        metadata: {
          categories: Object.fromEntries(Object.entries(categories).filter(([id]) => !id.startsWith('$')).map(([id, value]) => [id, { title: value.title }])),
          labels: context.labels,
          sortKeys: {
            quality: { title: { en: 'Quality', zh: '质量分' }, order: 'desc' },
            downloads: { title: { en: 'Downloads', zh: '月下载' }, order: 'desc' },
            stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' },
            updated: { title: { en: 'Updated', zh: '更新时间' }, order: 'desc' },
          },
        },
        plugins: accepted.map((item) => pluginDocument(item, context, 'icons/')),
      },
    },
  ];

  const reviewedOnly = accepted.filter((item) => item.reviewed);
  documents.push({
    path: ['reviewed', 'index.json'],
    iconPrefix: '../icons/',
    document: {
      ...documents[0].document,
      title: { en: 'DSH Plugin Index — Reviewed', zh: 'DSH 插件索引 · 已复核' },
      description: { en: 'Only entries with a human review bound to the current major version.', zh: '仅包含绑定当前 major 版本的人工复核条目。' },
      plugins: reviewedOnly.map((item) => pluginDocument(item, context, '../icons/')),
    },
  });

  // Quarantine: unreviewed entries that are weak on their own merits, or carry a
  // soft risk that a reviewer should look at before the default listing shows them.
  const SOFT_RISK = new Set(['no-license', 'archived-repo', 'deprecated', 'no-repository']);
  const staged = accepted.filter(
    (item) => !item.reviewed && (item.score.total < 62 || item.gates.warnings.some((warning) => SOFT_RISK.has(warning.code))),
  );
  documents.push({
    path: ['staging', 'index.json'],
    iconPrefix: '../icons/',
    document: {
      ...documents[0].document,
      title: { en: 'DSH Plugin Index — Staging', zh: 'DSH 插件索引 · 观察池' },
      description: { en: 'Passed every hard gate but scored low or carries unresolved soft warnings.', zh: '通过全部硬门，但分数偏低或带有未解决的软风险。' },
      plugins: staged.map((item) => pluginDocument(item, context, '../icons/')),
    },
  });

  for (const entry of documents) {
    parseMarketIndex(entry.document, new URL(entry.path.join('/'), INDEX_BASE_URL).href);
  }

  const previousDigests = await readPreviousDigests(SITE);
  const previousIndex = await readJson(join(SITE, 'index.json'), null);
  const previousNames = new Set((previousIndex?.plugins ?? []).map((plugin) => plugin.name));
  const currentNames = new Set(accepted.map((item) => item.name));
  const revocations = [...previousNames]
    .filter((name) => !currentNames.has(name))
    .map((name) => ({ name, reason: 'no-longer-passes-gates', at: new Date().toISOString() }));

  const stats = {
    candidates: names.length,
    accepted: accepted.length,
    reviewed: reviewedOnly.length,
    staging: staged.length,
    rejected: report.rejected.length,
    topRejections: Object.entries(
      report.rejected.reduce((accumulator, item) => {
        accumulator[item.skip] = (accumulator[item.skip] ?? 0) + 1;
        return accumulator;
      }, {}),
    )
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8),
  };

  await writeSite({
    siteDir: SITE,
    documents,
    previousDigests,
    manifest: {
      baseline: BASELINE,
      toolVersion: TOOL_VERSION,
      stats,
      sources: { npmRegistry: 'https://registry.npmjs.org', githubToken: hasToken(), corpusGeneratedAt: corpus.generatedAt },
      revocations: revocations.filter(Boolean),
    },
  });

  await mkdir(DATA, { recursive: true });
  await writeFile(join(DATA, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await cache.flush();
  console.log(JSON.stringify({ stats, indexSha256: sha256(JSON.stringify(documents[0].document)) }, null, 2));
}

await main();

/** GitHub as provenance/audit surface (not as the primary discovery surface). */

import { getJson } from './net.mjs';

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

export function hasToken() {
  return BOOLEAN_TOKEN();
}
function BOOLEAN_TOKEN() {
  return TOKEN !== '';
}

function headers() {
  return TOKEN ? { authorization: `Bearer ${TOKEN}`, 'x-github-api-version': '2022-11-28' } : {};
}

/** Accepts npm-style repository URLs, git+https, ssh and `owner/repo` shorthands. */
export function parseRepo(input) {
  if (!input) return null;
  const text = typeof input === 'string' ? input : input?.url;
  if (!text) return null;
  const cleaned = text
    .replace(/^git\+/u, '')
    .replace(/^git@github\.com:/u, 'https://github.com/')
    .replace(/^github:/u, 'https://github.com/')
    .replace(/\.git$/u, '')
    .replace(/#.*$/u, '');
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/u.exec(cleaned);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/u, '') };
}

export async function repoMeta({ owner, repo }) {
  const body = await getJson(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: headers(),
    timeoutMs: 20000,
    retries: 1,
  });
  return {
    fullName: body.full_name,
    stars: body.stargazers_count ?? 0,
    forks: body.forks_count ?? 0,
    openIssues: body.open_issues_count ?? 0,
    archived: Boolean(body.archived),
    disabled: Boolean(body.disabled),
    pushedAt: body.pushed_at,
    createdAt: body.created_at,
    license: body.license?.spdx_id ?? null,
    defaultBranch: body.default_branch ?? 'HEAD',
    htmlUrl: body.html_url,
    topics: body.topics ?? [],
  };
}

export async function resolveCommit({ owner, repo }, ref) {
  const body = await getJson(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: headers(),
    timeoutMs: 20000,
    retries: 1,
  });
  return {
    sha: body.sha,
    date: body.commit?.committer?.date ?? body.commit?.author?.date ?? null,
  };
}

export async function fileAt({ owner, repo }, ref, path, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-plugin-index/0.1' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) return null;
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) return null;
  return text;
}

export async function searchRepos(query, { page = 1, perPage = 100 } = {}) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${String(perPage)}&page=${String(page)}&sort=updated&order=desc`;
  const body = await getJson(url, { headers: headers(), timeoutMs: 20000, retries: 1 });
  return {
    total: body.total_count ?? 0,
    items: (body.items ?? []).map((item) => ({
      fullName: item.full_name,
      stars: item.stargazers_count ?? 0,
      pushedAt: item.pushed_at,
      description: item.description ?? '',
      topics: item.topics ?? [],
    })),
  };
}

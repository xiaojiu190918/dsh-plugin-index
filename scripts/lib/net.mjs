/** Minimal HTTP helpers: timeouts, bounded bodies, retry/backoff, per-host pacing. */

import { setDefaultResultOrder } from 'node:dns';

// Windows hosts often advertise an IPv6 default route that blackholes; prefer IPv4
// so registry/GitHub calls do not burn their timeout on unreachable addresses.
setDefaultResultOrder('ipv4first');

const UA = 'dsh-plugin-index/0.1 (+https://github.com/your-name/dsh-plugin-index)';

export class RateLimiter {
  constructor({ minGapMs = 0 } = {}) {
    this.minGapMs = minGapMs;
    this.next = new Map();
  }
  async take(host) {
    if (!this.minGapMs) return;
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + this.minGapMs);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

const limiter = new RateLimiter({ minGapMs: 60 });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getJson(url, { headers = {}, timeoutMs = 20000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const host = new URL(url).host;
    await limiter.take(host);
    let response;
    try {
      response = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    } catch (error) {
      lastError = error;
    }
    if (response) {
      if (response.ok) return await response.json();
      const body = (await response.text()).slice(0, 300);
      if (response.status === 404) {
        const error = new Error(`HTTP 404 ${url}${body ? ` — ${body}` : ''}`);
        error.status = 404;
        throw error;
      }
      lastError = new Error(`HTTP ${response.status} ${url} — ${body}`);
      if (response.status !== 429 && response.status < 500) {
        errorExit(lastError);
      }
      const retryAfter = Number(response.headers.get('retry-after') ?? '0');
      await sleep(Math.max(retryAfter * 1000, 400 * 2 ** attempt));
      continue;
    }
    await sleep(400 * 2 ** attempt);
  }
  errorExit(lastError ?? new Error(`request failed: ${url}`));
}

function errorExit(error) {
  throw error;
}

export async function getBuffer(url, { headers = {}, timeoutMs = 60000, maxBytes = 32 * 1024 * 1024, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await onceBuffer(url, { headers, timeoutMs, maxBytes });
    } catch (error) {
      lastError = error;
      if (error.code === 'TOO_LARGE') throw error;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function onceBuffer(url, { headers, timeoutMs, maxBytes }) {
  await limiter.take(new URL(url).host);
  const response = await fetch(url, {
    headers: { 'user-agent': UA, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${url}`);
    error.status = response.status;
    throw error;
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    const error = new Error(`body too large: ${declared} > ${maxBytes} (${url})`);
    error.code = 'TOO_LARGE';
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      const error = new Error(`body exceeded ${maxBytes} bytes (${url})`);
      error.code = 'TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

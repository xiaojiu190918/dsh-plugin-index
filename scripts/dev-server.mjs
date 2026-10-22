/**
 * 本地预览服务器：把 site/ 当成一个真实索引源对外提供，用于在 DSH 里
 * 不依赖 GitHub Pages 先走通「添加索引源 → 发现 → 安装」闭环。
 *
 *   node scripts/dev-server.mjs [port]
 *
 * 只读 site/ 目录，拒绝路径穿越，仅监听 127.0.0.1。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'), 'site');
const PORT = Number(process.argv[2] ?? 8787);
const TYPES = { '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/u, '');
  const target = join(ROOT, path);
  if (!target.startsWith(ROOT)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      response.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`index source ready: http://127.0.0.1:${String(PORT)}/index.json`);
  console.log('粘贴到 DSH：插件 → 发现 → 索引源 → 添加');
});

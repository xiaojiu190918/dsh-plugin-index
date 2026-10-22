# 设计：为什么这样建

## 1. 约束先行（都是实测/读源码得到的，不是猜测）

| 事实 | 对设计的强制影响 |
|---|---|
| DSH 的索引只是**静态 JSON**，读取端用 `@deepseek-ai/dsh-plugin-market-index` 严格校验，任何一条违规**整份索引被拒** | 生成器必须自带同一套校验，且 CI 必须用官方包交叉验证；不允许「差不多能读」 |
| 读取端**拒绝重定向**、单次抓取 **15 s**、body ≤128 MB、成功文档**缓存 10 分钟** | 索引必须部署在最终 URL（不能短链）；单文档要小；发布频率高于 10 分钟没有意义 |
| `official` 标签、`author`、评分都是**市场自述**，不是 DSH 验证；索引**无签名** | 权威性只能来自「我们自己的门禁 + 可追溯来源 + git 历史」，所以本仓库把这些全部留痕 |
| 包名可冒充 `@deepseek-ai/dsh-*`（Git 源尤其） | 展示层不承诺身份；npm 源以 tarball package.json 为准，git 源固定 commit |
| 远程 icon 由浏览器直连，**泄露用户 IP** | 图标一律本地生成（同源 SVG），不引用第三方图片域名 |
| GitHub search 每次最多 1,000 条、认证 30 次/分；npm search `from` 超过约 5,000 会绕回、且会 429 | 发现用「多词切片」而不是深翻页；GitHub 只作补充召回 |
| 2026-10 实测：`topic:dsh-plugin` 约 21.7k 仓库，但 npm 上真正声明 `dsh.bundle` 的只有约 7k | topic 是高召回低精度，**必须回源校验**，永远不能直接入索引 |

## 2. 流水线

```
sources.json ──┬─→ npm 关键词切片（4 组）           ┐
               ├─→ npm 全文切片（11 组）            │  discover.mjs
               ├─→ GitHub topic / name search*      │  → data/corpus.json（只存名字+来源，不存结论）
               ├─→ 第三方 format-1 索引（可选进料）  ┘
               └─→ 手工 seeds

corpus ─→ 每个候选：
  packument（含全部版本清单）
    └─ 无 dsh.bundle → 直接拒（不下载 tarball，省带宽）
  tarball 实测：解包 → package.json + patch 文件存在 → 安装脚本检查
  GitHub 仓库画像：stars / pushed_at / archived / license
  npm 月下载量、provenance 证明
    ↓
  硬门（失败即剔除，记录原因）
    ↓
  确定性评分 0–100
    ↓
  生成三份文档：index.json / reviewed/index.json / staging/index.json
    ↓
  format 1 自校验 + 官方包交叉校验 + 不变量检查（排序、重复、图标存在）
    ↓
  site/manifest.json（SHA-256、统计、来源快照）+ revocations.json
```

\* GitHub 召回需要 `GITHUB_TOKEN`。无 token 时**自动跳过**而不是用匿名配额硬撑——匿名核心 REST 只有 60 次/小时，会把构建拖成不确定性。

## 3. 关键决策

### 3.1 npm 优先，Git 只做兜底

安装一个 Git 源时 pnpm 会在本机执行仓库的 `prepare`，等于把你的构建环境交给第三方脚本，且每次都拉全仓；npm tarball 是发布者构建好的不可变成品，配合 `integrity` 与（若有的）provenance 可校验。所以：

- 同一插件同时存在于 npm 与 Git 时，**只收 npm 版本**；
- Git 通道只处理「仓库声明了 `dsh.bundle` 但没发 npm」的项目，且 commit 必须是 40 位 SHA（format 1 强制）；
- Git 通道发现 `prepare`/`prepack`/`prepublishOnly` 脚本 → 默认硬拒（除非有对应的复核记录）。

### 3.2 分类/榜单是「索引级声明」，不是插件自述

`metadata.categories`、`labels`、`sortKeys` 都在索引根上声明，插件只能引用。这让我们能保证：

- UI 的筛选/排序选项稳定（不会因为某个插件乱写 keyword 出现新分类）；
- `quality`/`downloads`/`stars`/`updated` 四个排序键都由生成器计算，插件无法自封高分；
- 同分时按包名排序，结果完全确定。

### 3.3 图标本地生成

同源 `icons/<slug>.svg`：确定性（名字 → 色相 + 首字母），不联网、不泄露 IP、不依赖第三方 CDN 存活。代价是「不是真 logo」——这是刻意的隐私取舍，需要真图标时再人工补 `icon` 覆盖。

### 3.4 三份文档，而不是一份

- `index.json`：默认安装源，策略是「宽进严出」——过门禁就能进，质量分排序，标签区分 `reviewed` / `auto`。
- `reviewed/index.json`：只信人工复核。适合「只装我审过的」这种严格模式。
- `staging/index.json`：过门禁但分数低或带软风险。它存在是为了**不把观察池悄悄塞进主索引**，也不直接丢弃线索。

## 4. 新鲜度

- **cron 每小时 17 分**（GitHub Actions 最短 5 分钟粒度，但 DSH 只缓存 10 分钟、npm 生态的发布粒度也远低于此，更高频只是在浪费 API 配额）。
- **增量**：`.cache/state.json` 缓存 packument（6 h）、仓库画像（6 h）、commit 时间；命中就不重复请求。
- **只发布变化**：`manifest.json.changed` 记录哪些文档 digest 变了；内容没变时 `git diff --cached --quiet` 直接跳过提交与部署。
- **发现面滚动**：每轮都重新扫 npm 关键词/全文切片；GitHub topic 有 token 时每轮刷新，没有则跳过并在日志里写明。
- **可达性**：如果 npm search 触发 429，单个切片失败不会中断整轮——失败切片记日志，下一小时再补。

## 5. 已知边界（诚实清单）

- 官方格式无签名，本索引的「权威」是**流程权威**，不是密码学权威。要更强保证，下一步是给 `index.json` 附 detached signature（Ed25519），但 DSH 当前不验证签名，收益有限。
- 安全审查是**启发式**：安装脚本、体积、license、provenance、仓库一致性。**没有做代码级审计**；`reviewed` 标签代表「有人读过这个 major 版本的源码」，不代表无漏洞。
- npm 是唯一发布面时，发布者可以随时 `npm unpublish`/覆盖（虽然受限）；索引按版本 pin，但历史版本可能消失。
- GitHub 仓库画像依赖 API 与 token；无 token 的部署会退化成「只靠 npm 元数据」，评分里的 stars/archived 会缺失（已用默认值处理，不会崩）。

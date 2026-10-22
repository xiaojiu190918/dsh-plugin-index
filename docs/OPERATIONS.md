# 运维手册

## 首次部署

1. 在本仓库 Settings → Pages，Source 选 **GitHub Actions**。
2. 确认 Actions 有默认 `GITHUB_TOKEN` 权限（Settings → Actions → General → Workflow permissions 选 *Read and write*）。
3. 手动跑一次 `index` workflow（Actions → index → Run workflow）。
4. 部署完成后索引地址是 `https://<owner>.github.io/<repo>/index.json`。把它填进 DSH 的「添加索引源」。

> **必须用最终地址**。DSH 拒绝重定向，短链/301 会直接失败；`github.io` 本身不重定向，可用。

## 定时与预算

- cron：`17 * * * *`（每小时 17 分）。DSH 缓存索引 10 分钟，再快没有收益。
- 每轮请求预算（认证 token 下）：npm search 约 60–80 次、packument ≤400 次、GitHub 核心 API ≤80 次。远低于限额。
- `GITHUB_TOKEN` 缺失时：GitHub 召回自动跳过，Git 通道为空，评分缺 stars/archived（用默认值），索引仍然可用。

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `validate: FAIL ... mirror rejected` | 生成逻辑写坏了格式 | 不要绕过；修 `build.mjs`/`gates.mjs`，本地 `npm test` |
| npm search 大量 429 | 无 `Retry-After`，只能退避 | 已内置指数退避；若持续，减少 `sources.json` 里的切片词或把 cron 降到每 2 小时 |
| `git ls-remote` 超时 | 网络/代理 | Git 通道是可选的；失败只跳过该仓库 |
| `SetNamedSecurityInfoW ... grantWrite` | Windows 沙箱初始化失败（与索引无关） | 换执行策略或修复工作区 ACL；不影响 Linux CI |
| Pages 打开 404 | Pages Source 不是 GitHub Actions，或部署 job 失败 | 看 deploy job 日志；重跑 |
| DSH 里添加索引报 `fetch-failed` | URL 有重定向、非 http(s)、或带查询串 | 换最终 URL |

## 回滚

`site/` 是提交进仓库的产物，回滚就是 `git revert` 对应提交后重跑部署；或者直接 `git checkout <旧commit> -- site` 再 push。索引没有服务端状态，回滚是原子的。

## 本地调试

```bash
node scripts/build.mjs            # 用现有 corpus 重建
node scripts/validate.mjs         # 校验 + 不变量
node --test test/format.test.mjs  # 单测
```

想只测几个包：临时把 `data/sources.json.limits.maxCandidates` 改小，或手工写 `data/corpus.json` 的 `candidates`。

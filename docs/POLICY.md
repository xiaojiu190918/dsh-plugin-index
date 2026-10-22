# 准入与评分策略

本文件是 `scripts/lib/gates.mjs` 与 `scripts/lib/score.mjs` 的人话版本。**改策略必须先改本文件**，再改代码，CI 会跑单测。

## 一、硬门（任一失败即不收录）

| 代码 | 条件 | 为什么 |
|---|---|---|
| `invalid-name` | 不是合法 npm 包名，或长度 >214 | format 1 会整份拒绝 |
| `blocklisted-name/repo/publisher` | 命中 `data/blocklist.json` | 人工拉黑 |
| `not-a-bundle` | 发布版 `package.json` 没有 `dsh.bundle.patch` | 装了也不会激活任何层，不是插件 |
| `missing-bundle-patch` | `dsh.bundle.patch` 指向的文件在 tarball/仓库中不存在 | 声明与产物不一致，典型打包事故 |
| `invalid-bundle-patch` | patch 路径含 `..`、绝对路径或非法段 | 防路径穿越 |
| `unsupported-manifest-version` | `dsh.manifestVersion` 存在且 ≠ 1 | 未来格式，当前读取器不认 |
| `install-scripts` | 发布版带 `preinstall`/`install`/`postinstall` | 安装即执行任意代码，默认不可接受 |
| `git-lifecycle-scripts` | Git 源带 `prepare`/`prepack`/`prepublishOnly` | pnpm 装 Git 源时会在本机执行 |
| `tarball-too-large` | 压缩包 > 32 MiB | 攻击面与可用性 |
| `too-many-entries` | tarball 文件数 > 10 000 | 同上 |
| `workspace-range` | `engines.dsh` 是 `workspace:` 范围 | 发布产物不可能有效 |
| `no-license` | 无 license 且 `policy.requireLicense=true`（默认关） | 法务可控 |
| `archived-repo` | 仓库归档且 `policy.blockArchivedRepo=true`（默认关） | 默认只降级不拒绝 |

硬门失败会写进 `data/build-report.json`，并在下一次构建时若该名称已在索引中，自动写 `site/revocations.json`。

## 二、软风险（收录但打标签/降分/进观察池）

| 代码 | 处理 |
|---|---|
| `no-license` | 降分；默认不进观察池 |
| `archived-repo` | 标签 `archived-upstream` |
| `deprecated` | 标签 `deprecated`，npm 已弃用的版本不进入版本列表 |
| `no-engines` | 标签 `no-engines`：没声明 `engines.dsh`，兼容性只能由读取端兜底 |
| `suspicious-bundle-patch` | patch 里没有任何 loader 指令，人工抽查 |
| `install-scripts-reviewed` | 安装脚本存在但已有复核记录（`installScriptsApproved`） |
| 评分 < 55 且未复核 | 进 `staging/index.json` |

## 三、评分（0–100，确定性）

| 维度 | 权重 | 计算 |
|---|---|---|
| 兼容性 | 20 | `engines.dsh` 合法且覆盖基线版本（`DSH_BASELINE`，默认 `0.2.1`）→20；声明了但不覆盖→8；没声明→10；非法→0 |
| 维护度 | 20 | 最近发布 ≤30 天 20 / ≤60 天 18 / ≤90 天 16 / ≤180 天 11 / ≤365 天 5 / 更早 0 |
| 安全面 | 20 | 无安装脚本 +8；文件数 <2000 +4；有 license +4；有 provenance +4 |
| 来源可信 | 15 | npm provenance +8；仓库与包声明一致 +4；仓库未归档 +3 |
| 采用度 | 15 | `log10(月下载+1)/5 × 16` 封顶 15 |
| 文档 | 10 | 描述 >20 字 +4；有 readme +3；有关键词 +3 |

> 数值刻意保守：一个刚发布、无下载、无 provenance 但完全合规的插件大约落在 40–55 分，不足以进主索引前排；这正是「质量优先」的体现。

## 四、「复核」是什么意思

`data/reviewed.json` 的每条记录绑定：

```json
{ "@scope/pkg": { "by": "github:name", "at": "2026-10-22T00:00:00Z",
                  "major": 1, "artifact": "sha512-...", "notes": "读了源码：无外联..." } }
```

- **粒度是 major**：同一 major 内的 minor/patch 自动继承复核；跨 major 失效，退回 `auto`/观察池。
- **复核不是安全认证**：它表示「有人读过这个 major 的源码并记录了结论」。漏洞、供应链投毒仍可能发生。
- 变更 `reviewed.json` 必须走 PR 并由 CODEOWNERS 中的人批准。

## 五、下架与拉黑

1. 立即下架：把包名/仓库/发布者加入 `data/blocklist.json`，下一次构建即消失，并出现在 `site/revocations.json`。
2. 上游事故：npm `unpublish`/`deprecate` 会让版本列表自然变化；构建按当前 packument 重算。
3. 误杀恢复：从 blocklist 移除，历史保留在 git。

## 六、上报问题

发现恶意包/仿冒包：开 issue，标题 `security: <包名>`，附证据（npm 页面、commit、行为描述）。不要在这个仓库里贴可执行 PoC。

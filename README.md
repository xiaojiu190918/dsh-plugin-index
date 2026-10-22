# dsh-plugin-index

面向 DeepSeek Harness 的**自建、可审计的插件市场索引**（format 1 静态 JSON）。它是「权威源」而不是「又一个聚合站」：发现面尽量宽（npm + GitHub + 可选第三方进料），**准入面失败即拒绝**，排序由确定性评分决定，所有判定可复现。

数据来源、门禁、评分、复核台账、下架记录全部在本仓库里，`git log` 就是审计轨迹。

## 这个索引怎么用

1. DSH → **插件 → 发现 → 索引源 → 添加**
2. 粘贴索引地址（必须是你部署后的**最终 URL**，DSH 拒绝 301/302）：

| 用途 | 地址 | 说明 |
|---|---|---|
| 主索引（默认装这个） | `https://<你>.github.io/dsh-plugin-index/index.json` | 通过全部硬门的插件，按质量分排序 |
| 仅人工复核 | `https://<你>.github.io/dsh-plugin-index/reviewed/index.json` | 只含 `data/reviewed.json` 里有复核记录的条目 |
| 观察池 | `https://<你>.github.io/dsh-plugin-index/staging/index.json` | 过门禁但分数低/有未解决软风险，默认不给装 |

> 索引本身不安装任何东西。真正安装仍走 `plugin_manager`，仍需你逐次批准；插件以你的权限运行。

## 它凭什么算「权威」

- **只列真插件**：候选必须回源到 npm tarball 或 GitHub 仓库，亲自读到 `dsh.bundle.patch` 指向的文件存在——不是看 keyword、不是看 topic。
- **失败即拒绝**：任何硬门违规直接剔除并写入 `data/build-report.json`；不存在「先上架再观察」的自动通道。
- **确定性**：同样的输入永远得到同样的 `index.json`（评分是纯函数，排序有明确 tie-break），所以「为什么这个插件排第一」可复算。
- **可追溯**：每条记录都能追到 npm 包名+版本、或 GitHub 仓库+40 位 commit；索引内容与 `site/manifest.json` 的 SHA-256 绑定。
- **可下架**：`data/blocklist.json` + `site/revocations.json`，下架原因留在历史里。

## 快速开始（本地）

```bash
npm install --legacy-peer-deps
npm test                 # format 1 校验器镜像的单元测试
node scripts/discover.mjs   # 抓候选（npm keyword 切片 + GitHub topic，需 GITHUB_TOKEN 才走 GitHub）
node scripts/build.mjs      # 过门禁、评分、生成 site/
node scripts/validate.mjs   # 用官方校验器交叉验证
```

输出：`site/index.json`、`site/reviewed/index.json`、`site/staging/index.json`、`site/icons/*.svg`、`site/manifest.json`、`site/revocations.json`，以及 `data/build-report.json`（每个被拒候选的原因）。

## 目录

```
data/           人工维护的配置（唯一需要 review 的写入口）
  sources.json    发现来源与限额
  categories.json 分类表（索引级声明）
  reviewed.json   人工复核台账（包名 + major + 复核时的 sha512）
  blocklist.json  拒绝/下架名单
  i18n.json       中文展示文案补充
scripts/         pipeline（零业务依赖，仅 semver）
  discover.mjs    候选召回
  build.mjs       回源校验 → 门禁 → 评分 → 生成
  validate.mjs    官方校验器交叉验证 + 不变量检查
  lib/            format 镜像、HTTP、npm、GitHub、门禁、评分、渲染
site/            GitHub Pages 产物（CI 提交）
docs/            DESIGN / POLICY / OPERATIONS
```

## 运维

- CI：`.github/workflows/index.yml`，**每小时 17 分**重建；`GITHUB_TOKEN` 自动注入，没有额外密钥。
- 首次部署：仓库 Settings → Pages → Source 选 **GitHub Actions**；然后把 README 顶部的 `<你>` 换成实际账号，索引地址即 `https://<你>.github.io/<仓库名>/index.json`。
- 详细规则见 [docs/DESIGN.md](docs/DESIGN.md)、[docs/POLICY.md](docs/POLICY.md)、[docs/OPERATIONS.md](docs/OPERATIONS.md)。

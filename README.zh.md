# @ljwei-stak/dsh-compositor

[English](README.md) | 中文

DeepSeek Harness（DSH Desktop / dsh CLI）插件：让 Harness 的 Agent 直接创建和编辑 [Compositor](https://github.com/robbietilton/Compositor) 图像项目（`.comp`）。

Compositor 是 macOS 上的开源图像编辑器；`.comp` 项目是「PNG 图层文件夹 + `manifest.json`」，任何能写文件的东西（包括 AI agent）都可以直接构建，Compositor 打开时画布会随写入实时刷新。本插件把这套能力交给 Harness 的 Agent，并且**不冻结任何格式知识**——所有格式规则都在运行时从你本地同步的 Compositor git 仓库解析，上游更新后 `git pull` 即可，插件自动跟上。

## 兼容性设计（为什么 git pull 就够了）

- **文档即真相**：blend mode 列表、adjustment kind 列表、最高 manifest 版本、各类数值限制，全部实时解析自仓库里的 `docs/writing-comp-files.md` 和 `docs/project-format.md`；解析失败才退回内置副本，且结果里标注来源（`docs` / `fallback`）。
- **前向兼容**：manifest 版本比仓库文档新时（上游刚发新版本、你还没 pull），所有版本门槛检查自动降级为警告，绝不阻塞新格式的合法项目。
- **附加字段忽略**：格式历史（v1–v13）是纯增量演进的，校验器只检查文档声明过的规则，未知新字段一律放行。
- **缓存随 mtime 失效**：文档缓存按修改时间判断，`git pull` 后的下一次调用立即读到新文档。

## Agent 工具（8 个）

| 工具 | 作用 |
|---|---|
| `compositor_repo` | 报告本地 checkout 状态：git commit、文档解析结果、blend mode / adjustment kind / 版本上限 / 限制值 |
| `compositor_docs` | 读取 checkout 里的两份格式文档原文（writing / format / both） |
| `compositor_validate` | 按照文档规则全面校验一个 .comp：命名规则、blend mode 拼写、组树（环/深度/连续性）、剪贴蒙版链、adjustment 数值范围、版本门槛、图片格式、包限制、未引用文件 |
| `compositor_manifest` | 紧凑读取 manifest（每层一行的栈摘要；小文件返回全量；layerIndex 取单层） |
| `compositor_write_manifest` | 安全写入：自动补 layer id（UUID）、规范 imageFile/maskFile 命名、先校验后**原子写入**（临时文件 + rename，正在打开的 Compositor 永远不会读到半个 manifest）；校验失败拒绝写入并返回问题清单 |
| `compositor_layer_png` | 生成图层 PNG / 蒙版 PNG（纯色、线性/径向渐变），命名严格遵循 `<id>.png` / `<id>.mask.png`；纯 Node 实现，无原生依赖 |
| `compositor_preview` | 无需 Mac：把图层栈拍平成 PNG（变换、不透明度、图层/文件夹蒙版、剪贴蒙版、全部 24 种混合模式）；adjustment 图层与图层效果不渲染、明确列入 `skipped`。需要可选依赖 sharp |
| `compositor_clean` | 删除 manifest 不再引用的图片和过期的 QuickLook 文件夹（文档要求每次改动后删除，否则 Finder 预览是旧图）；默认 dry-run |

## 使用方式

这个插件没有面板界面——工具属于 Agent。在 DSH 对话里直接提需求即可，例如：

> 读一下 compositor_docs，然后创建一个 1920×1080 的霓虹夜景 `.comp` 项目，完成后给我预览图。

Agent 会读文档、生成图层 PNG、原子写入 manifest、渲染预览图，全程不需要 Mac。在 Mac 上用 Compositor 打开该项目的人，会看到画布约 0.3 秒内刷新。

## 安装

npm 安装、DSH Desktop 插件管理器安装，或对任何非 desktop profile：

```sh
dsh plugin --profile <name> add @ljwei-stak/dsh-compositor
```

`desktop` profile 被 dsh CLI 保留（插件管理要走 Desktop 的插件管理器），所以手工安装：

```sh
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm add @ljwei-stak/dsh-compositor
```

然后在该 profile 的 `package.json` 的 `dsh.profile.bundles` 数组里加一项 `"@ljwei-stak/dsh-compositor"`（profile 会热加载；没生效就重启 DSH Desktop）。

从源码安装（开发者）：仓库里 `npm pack`，然后在 profile 目录 `pnpm add <tgz 路径>`。

装好后把 `repoDir` 设置指向你本地的 Compositor 仓库克隆（默认值是作者的路径，首次使用请改成你自己的，例如 `D:\code\Compositor`）。

## 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `repoDir` | 作者的 checkout 路径 | 你本地的 Compositor git 仓库路径（格式知识的唯一来源） |
| `agentTools` | `true` | 注册 compositor_* 工具 |
| `previewEnabled` | `true` | 启用 compositor_preview |
| `docsMaxChars` | `200000` | compositor_docs 单次返回字符上限 |

sharp 未安装时 `compositor_preview` 会明确报告，其余工具全部可用（零依赖）。

## 开发

```sh
npm test        # node --test tests/
```

插件代码 MIT。`.comp` 格式知识属于 Compositor 仓库（MIT，Robbie Tilton），本插件运行时读取、不复制分发。

## 许可

MIT — 见 [LICENSE](LICENSE)。

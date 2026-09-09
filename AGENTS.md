# Repository Guidelines

ShimWeave 是独立的浏览器媒体兼容运行时，Plex 是首个站点适配器；Gateway 的 `control-v1` 是可选媒体源协议，legacy 302 可独立接入。当前支持与限制见 [README](README.md)，架构与后续能力条件见 [架构设计](docs/architecture.md)，性能证据见 [性能基线](docs/performance.md)。当前阶段旁路或尚未实现的路径不等于永久否决后续设计。

恢复工作时，读取当前任务实际引用的记录及必要设计、证据。没有记录时依据当前上下文继续；新的恢复记录可保存到 `.workbench/records/`。

## 项目结构与职责

- `apps/chrome-extension/` 是 Chrome MV3 宿主，负责权限、站点注册、Worker、浏览器内媒体传输和生命周期；Service Worker 不承载长时间播放。
- `packages/contracts/` 保存跨上下文稳定协议和媒体能力模型，不依赖浏览器或媒体引擎。
- `packages/core/` 负责能力驱动的播放规划、会话和调度策略。
- `packages/io-fetch/` 负责严格 Range 读取、调度和有界缓存。
- `packages/engine-mediabunny/` 是可替换的媒体引擎实现。
- `packages/adapter-plex/` 拥有 Plex 页面与协议接入、私有 Shaka Hook、原生播放器桥和 timeline；格式能力决策归核心。
- `tests/` 保存跨模块契约测试，`assets/brand/` 保存可编辑品牌源文件。
- 架构与性能边界位于 `docs/`，临时计划和验证材料放在已忽略的 `.workbench/`。

## 构建与验证

使用 Node 22 和 pnpm 11。常用命令：

```sh
corepack pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm package:extension
actionlint .github/workflows/*.yml
```

`build` 编译全部工作区，`test` 使用 Vitest，`package:extension` 生成本地扩展 ZIP。代码改动运行相关测试和类型检查；工作流改动运行 `actionlint`。媒体热路径改动按影响测量吞吐、首帧、Seek、CPU 和内存，对照既有性能预算。纯文档改动检查内容、相对链接和 `git diff --check`。

播放验证沿实际页面走完受影响的起播、Seek 后续播、切集、退出和错误呈现，并关联原生 video/时间轴、Worker/MSE、控制请求与 CDN Range。`seeked` 或控制接口成功不代表媒体继续推进；失败与退出还需确认资源释放。分别验证原生旁路、legacy 302 和可选 `control-v1`，只对实测格式、设备和路径作兼容结论。

## 编码与测试

TypeScript 使用严格模式、两空格缩进和单引号，并通过 Biome 格式化。公开协议、能力决策、缓存与取消语义需要简短注释，语言沿用相邻代码。测试文件使用 `*.test.ts`；没有固定覆盖率门槛，但变更过的契约必须覆盖能力矩阵、取消、快速切换、多会话或失败降级等相关边界。

## 架构与性能约束

媒体字节从源站/CDN 直达浏览器，Gateway 或 NAS 不充当额外媒体中继，也不使用扩展消息的 Base64 通道。Range 读取校验 `206` 与 `Content-Range`，缓存有界，取消与背压贯穿 Fetch、Worker 和 MSE。核心按媒体事实与实际播放路径的能力证据判断，未知字段保留未知，网络或取消失败不写成格式不支持。

优先原生播放，其次转封装，再按需转换音频。成熟容器和编解码能力交给可替换引擎，站点语义、调度、缓存和失败策略由项目维护。Plex 接管保留同一个原生 video、控制栏、时间轴和队列；私有 Hook 留在适配器内，接管失败释放资源并恢复原链路。当前本地媒体和原生可播路径旁路，不创建额外 Worker、探测或 Range 请求。

## 提交与文档

提交使用 Conventional Commits，例如 `feat: add range scheduler`。PR 应说明用户影响、涉及的架构边界和验证结果；可见界面变化附截图，性能路径附测量结果。README 面向用户，架构细节进入 `docs/`。CHANGELOG 面向用户说明可见能力与限制，不堆砌内部类名或实现步骤。禁止提交真实媒体地址、Token、Cookie、私有域名或未脱敏抓包。

发布版本必须同步 `VERSION`、根包、扩展包和 Manifest，并在中文 CHANGELOG 中增加同版本日期节。正式测试、打包、Tag 和 GitHub Release 由 CI 完成。

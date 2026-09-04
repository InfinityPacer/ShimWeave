# Repository Guidelines

## 项目结构与职责

- `apps/chrome-extension/` 是 Chrome MV3 宿主，只负责权限、站点注入、播放器界面与浏览器生命周期。
- `packages/contracts/` 保存跨上下文稳定协议和媒体能力模型，不依赖浏览器或媒体引擎。
- `packages/core/` 负责能力驱动的播放规划、会话和调度策略。
- `packages/io-fetch/` 负责严格 Range 读取、调度和有界缓存。
- `packages/engine-mediabunny/` 是可替换的媒体引擎实现。
- `packages/adapter-plex/` 只处理 Plex 页面和协议接入，不实现格式判断。
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

`build` 编译全部工作区，`test` 使用 Vitest，`package:extension` 生成本地扩展 ZIP。提交前至少运行与改动相关的测试和类型检查；工作流改动还需运行 `actionlint`。媒体热路径改动应提供可复现的吞吐、首帧、Seek、CPU 和内存结果。

## 编码与测试

TypeScript 使用严格模式、两空格缩进和单引号，并通过 Biome 格式化。公开协议、能力决策、缓存与取消语义需要简短注释，语言沿用相邻代码。测试文件使用 `*.test.ts`；没有固定覆盖率门槛，但变更过的契约必须覆盖能力矩阵、取消、快速切换、多会话或失败降级等相关边界。

## 架构与性能约束

媒体字节只能从源站进入浏览器，不得经过 Gateway、NAS 或扩展消息的 Base64 通道。核心逻辑按能力判断，不按客户端名称堆叠特判。第三方库只承载成熟的容器和编解码原语；站点语义、调度、缓存和失败策略由项目维护，并通过接口保持实现可替换。

## 提交与文档

提交使用 Conventional Commits，例如 `feat: add range scheduler`。PR 应说明用户影响、涉及的架构边界和验证结果；可见界面变化附截图，性能路径附测量结果。README 面向用户，架构细节进入 `docs/`。CHANGELOG 面向用户说明可见能力与限制，不堆砌内部类名或实现步骤。禁止提交真实媒体地址、Token、Cookie、私有域名或未脱敏抓包。Push、PR、发布和扩展商店操作必须获得维护者确认。

发布版本必须同步 `VERSION`、根包、扩展包和 Manifest，并在中文 CHANGELOG 中增加同版本日期节。正式测试、打包、Tag 和 GitHub Release 由 CI 完成。

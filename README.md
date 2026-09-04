# ShimWeave

ShimWeave 是一个运行在浏览器端的媒体兼容层。它通过可插拔站点适配器接收播放意图，
直接从媒体源读取 Range 数据，并在播放设备本地完成格式探测、转封装和必要的音频转码。

项目的首个宿主是 Chrome Manifest V3 扩展，首个站点适配器是 Plex。核心运行时不依赖
Plex、具体 CDN 或单一媒体引擎，后续可以复用于其他媒体服务器和网页播放器。

## 核心边界

- 媒体数据保持 `媒体源/CDN → 浏览器`，不经过 NAS、Gateway 或云端中继。
- 优先原生播放，其次仅转封装，再其次只转码浏览器不支持的音频。
- 视频默认保持原始编码，不以浏览器软件转码 4K 视频作为常规能力。
- 格式决策基于实际容器、轨道和浏览器能力，不维护无限增长的客户端名称特判。
- 站点适配器只负责会话接入、播放控制和观看状态，不参与媒体格式实现。

## 目前支持

- Chrome 120 及以上版本中的 Plex Web。
- 支持普通 302 STRM；配合 Plex Gateway 时，可在播放过程中持续获取有效的临时媒体地址。
- 继续使用 Plex 原生播放器、控制栏、时间轴、续播、拖动进度和上下集切换。
- 浏览器直接读取媒体源 Range 数据，并在本地完成 MKV 转封装。
- 浏览器无法直接播放 AC3、EAC3 或 DTS 时，在本地转换为 AAC。
- 已验证 4K HEVC HDR10；实际表现仍取决于操作系统、浏览器和硬件解码能力。
- 本地媒体和浏览器原生可播内容保持 Plex 原行为。
- 已知不兼容格式会停止播放并显示对应错误及已识别的音视频格式。

当前仍是开发预览。TrueHD、内嵌字幕和部分 Dolby Vision 组合尚不支持，HDR/DV 的实际表现取决于
片源、操作系统、浏览器和硬件解码能力。目前只提供 Plex 适配器，尚未上架 Chrome Web Store。

## 开发

```sh
corepack pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## 安装

当前需要通过 GitHub Release 手动安装：

1. 下载 `shimweave-X.Y.Z.zip`，解压到不会被清理或移动的固定目录。
2. 打开 `chrome://extensions`，启用“开发者模式”。
3. 选择“加载已解压的扩展程序”，选择刚才解压的目录。
4. 重新加载已经打开的 Plex Web 标签页。

更新版本时，下载并解压新的安装包，替换原目录内容，然后在扩展管理页点击“重新加载”。

从源码构建：

```sh
corepack pnpm install
pnpm build
pnpm package:extension
```

未打包扩展位于 `apps/chrome-extension/dist/`，本地 ZIP 位于 `artifacts/`。正式安装包、校验文件和
中文发布说明会在新版本发布时由 GitHub 自动生成。

ShimWeave 只接管 Plex Web 无法直接播放的 STRM 整文件媒体源，媒体数据始终由浏览器直接向
源站或 CDN 获取。

卸载扩展即可移除运行时和浏览器本地能力缓存。

## 与 Plex Gateway 配合

ShimWeave 不依赖 [Plex Gateway](https://github.com/InfinityPacer/plex-gateway)。两者配合时，
Gateway 只负责确认播放权限，并为浏览器提供当前有效的媒体地址；实际视频和音频仍由源站或
CDN 直接发送到浏览器。没有安装 Plex Gateway 时，只要 Plex 返回普通 302 媒体地址，
ShimWeave 仍可工作。

## 权限说明

- 扩展需要访问所有网站，因为自托管 Plex 和媒体 CDN 的域名无法提前固定。
- 只有识别为 Plex Web 且正在播放的标签页会进入兼容流程；扩展不会扫描其他网页或读取媒体
  响应正文。
- 播放状态所需的媒体身份和 Plex 凭据只保留在当前 Chrome 会话中，关闭浏览器后会被清除。

架构说明见 [docs/architecture.md](docs/architecture.md)，浏览器媒体管线基线见
[docs/performance.md](docs/performance.md)，用户可见变化见 [CHANGELOG.md](CHANGELOG.md)。

本项目是独立社区项目，与 Plex、Mediabunny 等相关项目的官方团队无关，也未获得其认可或赞助。

## 许可证

GPL-3.0-only，详见 [LICENSE](LICENSE)。

Copyright (C) 2026 InfinityPacer

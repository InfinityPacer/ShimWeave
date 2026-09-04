# ShimWeave 架构设计

## 目标与不变量

ShimWeave 是浏览器端媒体兼容运行时，不是媒体服务器、CDN 代理或 Plex 专用补丁。

以下约束不可被实现便利性打破：

1. 媒体字节保持 `源站/CDN → 播放设备浏览器`，不经过 Gateway、NAS 或云端中继。
2. 原生播放优先于转封装，转封装优先于音频转码；常规路径不做 4K 视频软件转码。
3. 格式决策只依据媒体事实和运行时能力，不依据客户端名称建立维护不完的特判矩阵。
4. 站点、浏览器宿主、媒体引擎和编解码扩展均通过接口隔离。
5. 快速切换、Seek、关闭页面和权限撤销必须取消旧会话并释放 Fetch、Worker、Decoder 与 MSE。

## 运行结构

```text
Host Site
  └─ Site Adapter
       ├─ 识别播放意图
       ├─ 取得媒体候选与站点会话
       ├─ 原生可播路径完整旁路
       ├─ 不兼容路径连接站点播放器适配桥
       └─ 读取页面时间轴并维护站点播放状态

Browser Media Runtime
  ├─ Session Controller
  ├─ Capability Probe
  ├─ Playback Planner
  ├─ MediaSourceProvider
  ├─ Media Output
  └─ Dedicated Media Worker
       ├─ Privileged Range ByteSource
       ├─ Range Scheduler / Memory Cache
       ├─ Media Engine Provider
       ├─ Optional Codec Providers
       └─ Fragment Output / Backpressure

Adapter-private Player Bridge
  ├─ 保留宿主原生 video、UI、时间轴和播放队列
  ├─ Plex 仅在 adapter-plex 内连接内置 Shaka
  └─ Shaka 释放原数据面后，由 ShimWeave MSE 复用同一个 video
```

媒体管线运行在浏览器内的扩展运行时及其 Dedicated Worker 中。MV3 Service Worker 只负责权限、
站点注册、会话路由和扩展生命周期，不承载长时间播放。`chrome.runtime` 消息只传递播放意图、
状态与错误，不传递媒体块。

extension-origin Dedicated Worker 在源站授权后直接执行跨域 Range Fetch。浏览器运行时将
SharedWorker 租约端口交给 Dedicated Worker，源媒体字节不返回 Gateway；可播放 fragment 通过
transferable `ArrayBuffer` 交给浏览器内 MSE。Plex 路径调用内置 Shaka 的 `unload(false)` 释放
当前媒体数据面，但不分离 Player 与原生 `<video>`；ShimWeave 随后在同一个 `<video>` 上挂载 MSE。
媒体块不得经过 Base64、高频 extension messaging 或页面消息。

## 模块边界

| 模块 | 职责 | 禁止承担 |
| --- | --- | --- |
| `contracts` | 跨上下文 DTO、媒体描述、能力与错误模型 | DOM、Chrome API、具体引擎类型 |
| `core` | 能力探测汇总、播放规划、会话状态和调度策略 | 站点名称判断、容器解析 |
| `io-fetch` | 严格 HTTP Range、206 与 Content-Range 校验 | 站点凭据、媒体规划、重试风暴 |
| `engine-mediabunny` | 容器解析、随机读取、转封装和音频 codec provider 装配 | Plex 协议、权限 UI |
| `adapter-plex` | Plex 页面接入、Part/会话解析、私有播放器 Hook、原生播放桥和 timeline | 格式能力决策、媒体字节处理、其他站点接入 |
| `chrome-extension` | MV3 权限、站点注册、Worker、浏览器内媒体传输和构建产物 | Gateway 代理、远程执行代码 |

后续站点适配器只实现统一 Adapter SDK，并按需提供 `MediaSourceProvider`。核心不得引用 Plex
URL、字段或产品名称。媒体引擎通过 `MediaEngineProvider` 接收统一 `ByteSource`，并以
`MediaEngineSession` 暴露媒体描述、codec 准备、分片流、取消和关闭语义。Chrome host 只负责源站
解析、Range 调度和会话资源，不构造具体引擎类型；Mediabunny 是默认实现，但不是宿主契约。
Range、媒体事实、能力模型、播放规划和 MSE 生命周期均为站点无关能力；后续接入 Emby 等服务时
新增 adapter 和 provider，不修改 Plex Hook。

### 站点适配器激活

浏览器宿主先用已注册的 SiteAdapterManifest 计算可能匹配页面，再由站点私有 watcher 提供实际
站点证据。URL pattern 可以重叠；同一文档最终只能由一个 adapter 认领，后到的 adapter 不得覆盖
已有绑定。Plex 只有观察到自身 webpack runtime 后才进入握手，因此普通 `/web/` 页面不会因为
路径相似而启用 Plex DNR 或安装 Plex Hook。

激活状态依次为 `prepared → watcher-ready → activating → active`。页面侧先安装运行时消息监听器
和 MAIN watcher，后台再以 `tabId + adapterId + documentId` 校验当前顶层文档并原子更新 session
DNR。网络事件与页面消息只接受 active 文档；DNR 更新失败回滚至 watcher-ready，并进行有界重试。
这样 `source-available` 不会早于页面监听器，也不会发给相同 tabId 中已经离开的旧文档。

顶层导航开始时暂停旧文档的网络接管，提交后建立新 prepared 文档；导航失败只恢复仍可见的旧
文档。History 与 fragment 导航保留同一 documentId 的 active 状态。MV3 Service Worker 恢复时
逐标签重建当前文档候选、清理过期 session DNR，并要求现有内容脚本重新握手；单个标签恢复失败
不会阻断其他标签。新增 Emby 等 adapter 只增加自己的 manifest、私有识别和桥接实现，不修改
Plex Hook、媒体引擎或格式规划。

## 播放规划

规划器按下列顺序选择成本最低的可行路径：

1. `native`：容器、视频、音频均由浏览器原生支持。
2. `remux`：视频和音频编码可用，仅将 MKV 等容器转为 fragmented MP4。
3. `remux-audio-transcode`：视频原码复制，将 AC3、EAC3 或 DTS 在浏览器内转为 AAC。
4. `unsupported`：视频编码、DRM、菜单或其他能力不满足，返回可解释错误，不请求服务端转码。

媒体事实必须携带可用于解码决策的精确配置，包括 codec parameter string、Profile、Level、
位深、色度、分辨率、帧率、HDR 静态信息、Dolby Vision Profile，以及音频采样率和声道布局。
缺失字段保持未知，不能从单一 codec 名称推导为已支持。

能力快照保留证据来源、播放路径和适用配置，并按层验证：

1. `MediaSource.isTypeSupported()` 只证明候选容器与 codec 组合可交给 MSE。
2. `VideoDecoder.isConfigSupported()` 只验证真正由 WebCodecs 解码视频的候选路径；当前 MSE
   原码转封装不经过 WebCodecs，否定结果不能跨路径否决 MSE。
3. `MediaCapabilities.decodingInfo()` 补充 `supported`、`smooth` 与 `powerEfficient` 证据。
4. 真实样本成功或确定性的格式、解码、追加失败形成按运行时、引擎、精确配置和媒体指纹
   失效的本机能力缓存。网络、配额和取消错误不写成“不支持”。

这些证据不做多数投票：先匹配同一播放路径和精确配置，再由同源真实样本覆盖 API 猜测；
API 冲突且没有样本时返回待验证，而不是猜测支持或不支持。品牌或 User-Agent 只能用于
站点接入和诊断，不能改变媒体规划。

Mediabunny 及官方 codec 扩展固定同一版本，并动态加载：

- `mediabunny@1.55.5`
- `@mediabunny/ac3@1.55.5`
- `@mediabunny/dts@1.55.5`
- `@mediabunny/aac-encoder@1.55.5`

容器解析、时间戳、B-frame、fragmented MP4、音画同步和 codec WASM 不自行重写。项目自行
维护能力规划、调度、缓存、失败策略、UI 和站点语义。

Mediabunny 公共 Track API 用于 codec string、编码与显示尺寸、码率、采样率、声道数和色彩
字段。AVC、HEVC、AV1 与 VP9 的 Profile、Level 由标准 codec string 解析，HEVC 位深和色度
可由复制后的 `hvcC` 补足。Matroska 额外使用独立的只读轨道头解析器补充
`BlockAdditionMapping` 中的 Dolby Vision 配置、Mastering Display、MaxCLL、MaxFALL 和
`DefaultDuration` 标称帧率；读取限制为文件头与 SeekHead 指向位置各最多 512 KiB，不扫描
Cluster。其他容器缺少直接帧率字段时，使用 Mediabunny 以 256 个包为目标统计时间戳；为处理
编码重排可能读取少量额外包，失败时保留未知，不阻塞转封装。PQ 即使带静态亮度字段也只标记为
`hdr-unknown`，因为这些事实不能排除 HDR10+。

当前仍无法可靠确认 Dolby Vision RPU/EL/BL 是否被输出链使用，也没有解析 HDR10+ 动态元数据、
Atmos/JOC、DTS:X 或精确声道布局；这些字段保持未知，不能由单个 HDR 布尔值推导。识别出
Dolby Vision 配置只说明媒体事实已知，不代表浏览器或转封装输出已经正确呈现 Dolby Vision。

AC3、EAC3 或 DTS 只有在原音轨的 MSE 候选被当前能力证据否决后才进入 AAC 降级。规划器、
能力键、Worker 协议和媒体引擎共享同一确定输出：AAC-LC、2.0、48 kHz、192 kbps。Player
展示转换后的实际输出配置，不把输入多声道音轨误报为输出能力；该降级会丢失对象音频和环绕
声道，因此不能替代原音轨直放。

## 数据面与性能

`ByteSource.read({ start, end }, signal)` 必须返回准确的半开区间，并拒绝源站把 Range 静默
退化为整文件 `200`。调度器使用播放头、索引、Seek 和预取四类优先级，同一范围合并请求，
探测阶段的相邻顺序读取由 512 KiB 起步并指数增长到 4 MiB，随机跳转恢复小窗口；进入媒体
转换后使用 4 MiB 对齐块，使音视频轨交错和跨块读取仍复用相同缓存任务。快速切换时新会话立即
取消旧会话。

`FetchRangeSource` 只接受与请求完全一致的 `206` 和 `Content-Range`，协议错误会主动取消
响应体，避免错误的 `200` 继续下载整片。`sourceId` 是稳定的不透明内容身份，不使用短期
签名 URL。Range Broker 管理单媒体源的覆盖读取共享，以及受 16 MiB 和 256 条双重约束
的 LRU。一个执行上下文内的所有 Broker 共享 Range Scheduler；默认总并发 6、单源并发
2、等待任务 256。队列满时 Seek、播放和索引读取可依次淘汰尚未执行的较低优先级任务，
正在执行的请求不被强制抢占。Range Session 在快速切换时同步广播取消并等待自己持有的
源释放，不会关闭其他播放会话或共享调度器。跨标签协调由 SharedWorker 统一分配租约，
每个 Dedicated Worker 在自己的上下文执行 I/O；SharedWorker 租约消息不得携带媒体字节
或签名 URL。

Mediabunny `CustomSource` 接入时使用 `maxCacheSize: 0` 和 `prefetchProfile: 'none'`，让
Range Broker 保持唯一的缓存和预取决策权。其读取回调没有逐请求取消参数，因此 Seek 和
快速切换必须先停止旧转换、输出与 MSE；建立阶段取消、不可中止读取或失败状态会销毁并重建
Input，健康输入可以保留同一 Range 会话和缓存。不能使用会触发视频转码的
`Conversion.trim` 冒充 HEVC 原码流 Seek。

媒体引擎以 fragmented MP4 输出到 Dedicated Worker 的有界启动缓冲。MIME 确认后，媒体块
使用 transferable `ArrayBuffer` 直接交给 Player Frame；每块只有在 `SourceBuffer.updateend`
后才 ACK，Worker 的下一次写入因此自然等待浏览器消费。音视频轨在进入复用器时最多相差
1 秒媒体时间，避免慢轨使快轨编码包在内部无界积存。MSE 同时使用媒体时间和压缩字节预算：
默认只保留播放点后 90 秒、前 30 秒，并以 128 MiB 作为已追加媒体的近似字节上限。常规清理
保留至少 30 秒解码历史；字节压力下只淘汰已完全播放的 fMP4 分片，并至少保留当前分片和一个
前向分片，使高码率内容能够继续推进到下一安全清理点。SourceBuffer 不提供真实字节占用，
账本按已完成 append 的媒体区间估算；抵达续播目标、单个大分片和必要前向分片均可超出预算，
因此 128 MiB 是主动背压软阈值，不是浏览器配额声明。若 append 触发
`QuotaExceededError`，先强制清理安全旧缓冲并只重试一次。仍失败时返回明确错误，不依赖
浏览器自动回收。

媒体读取或解封装失败后，Dedicated Worker 会销毁已进入失败状态的媒体输入并在同一全局
调度器下重建输入会话。正常播放和 Seek 不走重建路径；重试不会创建额外的跨标签并发池。

对需要 Gateway 协商的源，`FetchRangeSource` 不保存短期 CDN URL。每个 Range 先向固定控制
端点发送 Range 与会话 bearer，读取无响应体的临时 URL 描述，再创建一条只含 `Accept` 和
`Range` 的媒体请求。bearer 不放入 URL，也不随重定向发送到 CDN。CDN 返回 403 时，同一
媒体会话只有一个恢复 leader 重新执行一次控制交换；其他请求等待该结果，播放器、能力规划、
媒体描述、MSE 和时间轴均不重建。响应尺寸变化或 Range 协议错误立即终止，不能混用缓存。

第一版性能预算是验收目标，不是当前交付事实：

| 指标 | 目标 |
| --- | --- |
| 已有原生能力的额外接管成本 | p95 小于 50 ms |
| 热能力缓存播放规划 | p95 小于 5 ms |
| 首个可播放 fragment | p95 小于 2 s，不含源站自身延迟 |
| Seek 到继续播放 | p95 小于 2 s，不含源站自身延迟 |
| JS 主线程长任务 | 播放热路径不出现超过 50 ms 的持续阻塞 |
| 内存 | 使用 90 秒/30 秒时间窗口与 128 MiB 近似字节预算，禁止整片驻留 |

已验证基线和测量边界见 [performance.md](performance.md)。

媒体缓存首先使用 Worker 内有界 LRU。真实样本能力缓存使用 256 条内存 LRU 和 IndexedDB：
L1 命中不等待数据库，L2 只在需要真实样本裁决时读取。缓存键包含 schema、runtime、engine、
精确输出配置和稳定媒体指纹；配置或身份变化立即失效。180 天保留期只回收长期未访问记录，
活跃记录每小时最多后台续期一次。持久化不保存完整影片或短期签名 CDN URL。

AC3、DTS 和 AAC codec 构建为扩展包内独立 chunk。Worker 只有在规划选择音频转换时，才按
输入音轨加载 AC3/EAC3 或 DTS decoder，并在浏览器没有原生 AAC encoder 时加载 AAC encoder；
普通 AAC、原生播放和纯转封装不会加载这些包。

浏览器媒体运行时使用单会话播放状态机执行规划结果。媒体描述、规划、Worker 建流和输出挂载
共享同一代次；新播放会先撤销旧代次，迟到描述、分片或样本不能覆盖当前媒体。规划选择的
音视频轨道 ID 必须传到媒体引擎，不能在转封装时重新回退到容器主轨。首帧、连续播放与 Seek
恢复分别形成样本证据；网络、配额和用户取消只影响当前会话，不写成格式不支持。

MSE 可在关键帧处将输出分片重建为从零开始的局部时间轴，但 Player、站点进度和能力证据的
唯一外部时间域是原媒体绝对时间。Player 使用 `SourceBuffer.timestampOffset` 恢复分片的原时间，
再将播放点定位到请求时间；例如关键帧在 970 秒、目标在 973 秒时，页面始终看到 973 秒，
不得暴露 3 秒的局部时间。

缓冲区内 Seek 由 MSE 直接完成。缓冲区外 Seek 由播放状态机停止当前 MSE 和分片流，复用同一
Dedicated Worker、Range 会话和有界缓存，从最终目标附近的关键帧重建。连续 Seek 不排队执行每个
中间目标，尚未建流的旧目标被最新目标替换。`seeked` 事件本身不构成成功证据，只有新时间轴
完成定位且媒体时间继续推进后才记录 `seek-resume`。

未指定音轨时优先选择容器声明的默认轨，其次才是第一音轨。Player 直接使用同一
`MediaDescriptor` 返回的轨道 ID 提供音轨切换，切换时从当前绝对时间重建媒体流，因此不依赖
站点私有轨道 ID。浏览器原生文件路径无法保证选择容器内指定音轨，因此明确选轨后必须走
媒体引擎可控的转封装路径；没有选择意图时仍优先原生播放。未指定字幕表示字幕关闭，不得
自动选择第一条字幕。Plex STRM 元数据可能
只有容器流索引而没有 Plex Stream ID；在没有可验证映射时不得根据顺序猜测 Plex 选轨。
调用方明确指定的音轨无法匹配时必须拒绝执行，不能回退默认轨。字幕选择事实、字幕负载和
容器轨道是三个不同契约：站点给出的 Stream ID 不能按顺序猜成容器 Track ID，轨道元数据也不
代表媒体引擎能够读取 cue。Mediabunny 1.55.5 只能从输入读取视频和音频轨道，现有 WebVTT
`SubtitleSource` 属于输出原语，不能用于提取 MKV/MP4 内嵌字幕。因此当前引擎不得声明支持内嵌
字幕，也不得宣称支持尚未验证的 PGS、VobSub 或 ASS/SSA。

字幕后续使用独立输入适配器和渲染器：外挂 WebVTT 可直接解析，SRT 先做确定性 WebVTT 归一化；
cue 统一使用原媒体绝对时间，Seek 或快速切换时按播放代次取消旧加载并重建目标时间窗。字幕加载
不进入视频分片背压链路，也不延迟首个视频分片。未选择字幕时视频照常起播；明确选择但无法唯一
映射、解析或渲染时必须给出字幕不可用提示，不能猜测其他轨道或静默显示错误字幕。

## 兼容性边界

- HEVC、AV1 和 HDR 取决于 Chrome、操作系统、GPU 与具体 codec configuration。
- Dolby Vision 必须按真实 Profile 和平台验证，不能因为 HEVC 可解码就宣称支持。
- AC3/EAC3/DTS 转 AAC 会丢失 Atmos 或 DTS:X 对象信息。
- TrueHD、PGS、VobSub、ASS/SSA、蓝光菜单、DRM/EME 不列入首版承诺。
- 字幕采用独立输入与渲染接口，外挂 WebVTT/SRT 优先；内嵌字幕要等输入引擎具备可靠 cue
  读取能力后再接入，字幕失败不终止已经建立的视频会话。
- 浏览器无法处理的视频返回明确限制，不把流量回退到 Gateway 或 NAS。

## 站点接管与 Gateway 边界

Plex adapter 是 ShimWeave 的首个接入实现。它负责监听页面播放意图、解析媒体选择、读取
初始续播位置，并把不兼容媒体接入 Plex 已有的 Shaka Player。ShimWeave 不创建第二套可见播放器，
Plex 原生 video、控制栏、时间轴、播放队列、上一集和下一集保持唯一事实源。适配桥只向内容
脚本报告必要的会话状态；内容脚本使用不透明回写句柄把事件交给 MV3 Service Worker，
由后台向 Plex `/:/timeline` 回写。Plex Token 只从已经获准播放的 `start.mpd` 请求中提取并
保存在 `chrome.storage.session` 的浏览器会话内存中，不进入 iframe、DOM、页面消息、回写 URL、
磁盘持久存储、CDN 或媒体引擎。该会话区默认不暴露给内容脚本，并使短生命周期 MV3 Worker
重启后仍能恢复当前播放绑定。

持续播放按 10 秒墙钟周期回写，暂停、播放结束和原生会话关闭立即入队。每个播放句柄的请求
严格串行，终态一旦进入队列便拒绝后续迟到事件；后台只对网络错误和服务端错误重试一次。
每次请求最多等待 5 秒。回写不等待在播放、Range 或 MSE 路径上，失败只影响 Plex 续播状态，
不中断当前媒体；关闭回写通过消息响应保持 Worker 存活，直到终态成功或完成一次有限重试。
播放结束以 `stopped` 和完整媒体时长交给 Plex，由 Plex 继续执行自己的观看状态规则。

### Plex 原生播放器接管决策

Plex Web 的 UI 与播放状态仍由 Plex 原生播放器拥有，ShimWeave 只替换已经确认不兼容的媒体
数据面。适配器通过结构和能力发现当前页面的 Shaka Player；接管成立后调用 `unload(false)`，
保留 Player、同一个 `<video>`、控制栏、完整时间轴和播放队列，再由 ShimWeave MSE 向该
`<video>` 供应浏览器可消费的分片。扩展不创建 Overlay、iframe 或第二播放器，也不让 Shaka
消费一套伪造的动态 DASH。

接管判断只使用请求/响应结构、媒体事实和运行时能力，不使用 Plex Web 版本或客户端名称。
本地媒体、正常 MPD 与 Plex 已能原生播放的响应完全旁路。私有 webpack/Shaka Hook 只属于
Plex 专属适配层；识别、认领或 MSE 挂载失败时必须释放扩展资源并恢复 Plex 原链路，不能留下
半接管会话。冷恢复可能需要等待远端关键帧与首个分片，接管准备使用 30 秒有界窗口，不能用
短于真实冷启动的固定门槛取消仍在推进的媒体流。该桥接方式不进入通用核心，也不约束未来
Emby 等站点适配器。

接管已经进入稳定播放后仍可能收到浏览器硬件解码器的晚发失败。此时扩展必须先终止 Worker、
MSE 和状态回写句柄，再通过当前 Shaka Player 的原生错误事件显示媒体错误；同一页面会话内将
该内容身份标记为不再接管，让用户重试时回到 Plex 原链路。该标记不跨页面持久化，也不能把
网络、取消或配额错误写成永久格式结论。

能力规划若在接管进入 ready 之前就确认无可用播放路径，必须立即释放 Worker、MSE 与
直链状态，并在当前页面会话内阻止同一媒体再次接管。确定性的格式或解码失败通过当前 Shaka
Player 的原生媒体错误事件进入 Plex 错误弹窗，再由独立呈现契约补充已确认的视频和音频格式；
错误码必须与失败类别一致，未知字段省略，不能把网络或探测失败伪装成格式不支持。同一媒体
重试可以复用确定性结论并重新开启一个短呈现窗口，新的 `sourceKey` 必须立即清除旧结论。

错误呈现器只改写 Plex 已创建且错误码吻合的正文，不创建 Overlay 或第二套弹窗。DOM 观察器
只在短呈现窗口内查询弹窗，成功改写后立即休眠，并且必须保持幂等；相同文本不得重复写入，
否则自身变更会形成 MutationObserver 微任务回路并阻塞页面。用户可理解的提示不得扩大格式
支持面，也不得改变 Plex 原生弹窗生命周期和按钮行为。

### Plex 本地媒体接管边界

当前版本不接管 Plex 本地媒体。Plex 已能 Direct Play 时没有替换价值；Direct Stream 只由服务端
无损换封装、通常开销很低，自动接管反而会复制 Plex 已具备的能力。Plex 正常返回的转码 MPD 也
保持原样，ShimWeave 不以“本地媒体播放失败”作为接管信号。

只有在用户明确启用浏览器本地兼容处理，并同时满足以下条件时，本地接管才有潜在价值：

1. Plex 的播放决策需要视频转码，但原因仅是容器、音频或可由浏览器独立处理的字幕限制；原视频
   编码、分辨率、位深、帧率和动态范围已被浏览器能力模型确认可用。
2. adapter 能从 Plex 授权响应取得唯一 Part 及支持 Range 的原始字节端点，不读取 Plex 数据库，
   不猜测服务器文件路径，也不向页面世界暴露 Token。
3. ShimWeave 只做转封装或音频转换即可得到兼容输出；需要修改视频编码、分辨率或码率时继续交给
   Plex Transcoder，浏览器端不做 4K 视频软件转码。

该能力若实现，必须是默认关闭的独立 `plex-local-part` `MediaSourceProvider`，不能复用 STRM 302
判定，也不能改变当前本地媒体零接管门禁。它只能减少 Plex 的计算负担，不能减少本地媒体从
Plex/NAS 源站到浏览器的字节流量。

ShimWeave 与 Gateway 是两个可独立部署、独立演进的产品。Plex 接管先按响应语义做二次分流，
而不是把 Gateway 能力当作前置条件：

1. 本地媒体的正常 MPD 和 Plex 已选择的原生 Direct Play 完全旁路，不安装媒体替代会话，
   不启动 Dedicated Worker，也不做媒体探测。
2. 只有 Plex STRM 的 `start.mpd` 响应明确 302 到整文件时，扩展才可通过 legacy 302 provider
   自行接管；未满足这一结构事实时保持 Plex 原行为。
3. Gateway 明确返回 `control-v1` 时，可通过 control provider 接管。该协议是减少临时 URL
   暴露和统一续签的可选优化，不是 ShimWeave 播放能力的运行依赖。

legacy 302 与 `control-v1` 通过可注册的 `MediaSourceProvider` 归一为同一个站点无关
`MediaSourceDescriptor`。一次播放只能由一个 provider 认领；没有 provider、多个 provider
同时认领或结果不完整时，必须完整回退 Plex，不建立部分 ShimWeave 会话。provider 只负责把
站点响应转换为媒体源描述。Host、Dedicated Worker 和播放运行时只消费通用直连或受控 Range
访问方式，不得把 Plex、Gateway 或客户端字段带入 Range、媒体引擎、能力模型和播放规划。

Plex 私有 webpack/Shaka 接入只允许存在于 `adapter-plex`。Hook 通过模块结构和所需能力识别目标，
不得硬编码 webpack 模块 ID；页面版本变化、识别失败或必要能力缺失时，必须保持原播放器请求、
状态和错误处理链完整，不建立 ShimWeave 媒体替代会话。站点私有 Hook 不得进入通用 adapter SDK，
未来 Emby 等适配器也不得复用或修改 Plex Hook。

`adapter-plex` 拥有页面世界协议、Shaka 发现器和 Hook 控制器。Chrome 应用中的
`plex-native-main.ts` 只负责实例化这些组件并连接 `window.postMessage` 生命周期，不包含 Plex
模块识别、播放裁决或错误策略。后续站点使用各自独立入口，不能通过修改 Plex Hook 接入。

在可选 `control-v1` 路径中，扩展以版本化请求头声明能力。Gateway 仅在已有 Direct Play Grant、
准确 Media/Part 和当前 Plex 授权都成立时返回控制描述。描述包含稳定内容身份、固定同源控制路径
及独立 bearer；bearer 只进入控制请求头。Gateway 每次通过上游解析服务获取临时 URL 后仍只返回
控制描述，媒体字节保持 CDN 直达浏览器。

Chrome `requestId` 将一次 `start.mpd` 的开始和响应关联起来，播放分组只包含 Plex origin、
metadata path 和 Media/Part 索引，不包含会在 Direct Stream 与 Transcode 回退间变化的
Plex session，也不包含 Token。更新的跨 Part 请求会使旧响应失效；同一 Part 的重试与回退在
当前原生播放会话正常运行期间合并，会话出错、关闭、页面卸载或切换 Part 后再次播放才建立新会话。该
关联不依赖 MV3 Service Worker 内的自增状态，因此 Worker 重启不会让旧响应获得更高代次。
状态回写句柄另行绑定创建它的标签页、主 frame 与页面 origin；来自其他标签页、子 frame 或
旧页面代次的消息不能复用该句柄。被页面合并的重复建流会立即释放未采用句柄，页面卸载、刷新
或关闭时会提交当前终态。后台最多保留 64 个未释放句柄，并清理长期未活动绑定。

ShimWeave 与 Gateway 是独立产品。Gateway 可以提供媒体源发现协议，但扩展不得依赖其页面注入、
播放器实现或媒体中继；没有 Gateway 时，站点适配器仍可通过其他 provider 接入整文件媒体源。

上述边界必须由回归门禁共同保护：本地正常 MPD、原生 Direct Play、legacy 302、`control-v1`
分别有独立用例，并验证 provider 与站点适配器互斥。任一接管失败都应证明 Plex 原链路仍可运行；
性能用例还应证明本地和原生可播路径没有创建 Worker、媒体探测或额外 Range I/O。Plex 接管路径
必须继续使用同一个原生 video，并在 Shaka `unload(false)` 后由 ShimWeave MSE 接管数据面；不得
挂载可见 iframe、Overlay、第二播放器或替代 DASH。门禁不得按客户端名称建立特判矩阵，只能使用
请求/响应结构、媒体事实和运行时能力。

## 发布边界

动态 CDN 域名无法预先枚举，因此扩展需要 HTTP/HTTPS 主机访问权限。运行时只访问当前播放会话
明确产生的媒体地址，不扫描无关页面，也不加载远程执行代码。公开产物不得包含凭据、私有地址、
抓包或本机路径。

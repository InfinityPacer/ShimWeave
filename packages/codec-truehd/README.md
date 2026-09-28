# @shimweave/codec-truehd

在浏览器或 Worker 内把 Dolby TrueHD（Matroska `A_TRUEHD`）解码为平面 Float32 PCM。WASM 只包含 FFmpeg 的 `truehd` 解码器，随包内联在 `wasm/truehd-wasm.mjs`，不加载远程代码、不发起网络请求，胶水代码不使用 eval，只需要 CSP 允许 `'wasm-unsafe-eval'`。

```ts
import { createTrueHdDecoder } from '@shimweave/codec-truehd';

const decoder = await createTrueHdDecoder({ channels: 2 });
for (const audio of decoder.decode(blockPayload)) {
  // audio.planes[channel]: Float32Array，audio.numberOfFrames 帧，audio.sampleRate Hz
}
decoder.flush(); // Seek 后调用，之后从带 major sync 的访问单元继续
decoder.close();
```

- `channels: 2 | 6` 让解码器直接取流内的双声道或 5.1 呈现子流，不做自行混音；`8` 解出最完整的呈现（Atmos 的空间对象子流不解码）。流内没有对应呈现时，以 `numberOfChannels` 为准。
- `decode` 接受 Matroska Block 负载原样输入，一个负载可含多个完整访问单元，同包内格式不变的访问单元合并为一段输出。major sync 之前的访问单元不产生输出，损坏的访问单元跳过并计入 `corruptUnits`。
- 同一执行上下文共享一个 WASM 实例，每个解码器持有自己的 C 上下文，`close` 释放它；WASM 线性内存增长后不会收缩。

## 构建产物

`wasm/truehd-wasm.mjs` 由 `scripts/build-wasm.sh` 在固定摘要的 `emscripten/emsdk:6.0.10` 容器里从 FFmpeg 9.0.2 官方源码包（脚本内校验 SHA-256）构建，随仓库提交，日常 `pnpm build` 不需要 Docker。改动 `native/bridge.c`、FFmpeg 或 Emscripten 版本时运行：

```sh
pnpm --filter @shimweave/codec-truehd build:wasm
```

测试夹具 `src/fixtures/sine-5.1.mkv` 是 `scripts/build-fixture.sh` 用 FFmpeg 生成的合成正弦信号。FFmpeg 的 TrueHD 编码器最多支持 5.1，且把双声道呈现写成 FL/FR 原样，因此 7.1、Atmos 与 Dolby 矩阵下混只能用真实片源在本地验证。`scripts/bench.mjs` 测量解码实时倍率。

## 许可

WASM 产物包含 FFmpeg 的 libavcodec 与 libavutil，按 GNU LGPL 2.1 或更高版本授权，许可全文见 [wasm/COPYING.LGPLv2.1](wasm/COPYING.LGPLv2.1)。对应源码为 FFmpeg 9.0.2 官方发布包，配合 `native/bridge.c` 与 `scripts/build-wasm.sh` 可完整重建。

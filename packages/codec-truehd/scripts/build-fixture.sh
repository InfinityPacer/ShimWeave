#!/usr/bin/env bash
# 用本机 ffmpeg 生成合成 TrueHD 测试夹具：0.5 秒、48 kHz、5.1(side)，每个声道一个已知频率的正弦波。
# 夹具只含合成信号，随仓库提交；重新生成需要带 truehd 编码器的 ffmpeg。
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ffmpeg_bin="${FFMPEG:-ffmpeg}"

# 声道顺序 FL FR FC LFE SL SR，频率与测试中的 CHANNEL_TONES 保持一致。
expr='0.25*sin(2*PI*500*t)|0.25*sin(2*PI*700*t)|0.25*sin(2*PI*1000*t)|0.25*sin(2*PI*60*t)|0.25*sin(2*PI*1300*t)|0.25*sin(2*PI*1700*t)'

"$ffmpeg_bin" -hide_banner -loglevel error -y \
  -f lavfi -i "aevalsrc=exprs=${expr}:channel_layout=5.1(side):sample_rate=48000:duration=0.5" \
  -c:a truehd -strict -2 -map_metadata -1 -fflags +bitexact -flags:a +bitexact \
  -f matroska "$package_root/src/fixtures/sine-5.1.mkv"

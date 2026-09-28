/*
 * ShimWeave TrueHD 解码桥：只暴露 libavcodec truehd 解码器的最小接口。
 *
 * 输入是 Matroska Block 负载，其中可能连续放着多个 TrueHD 访问单元。桥在这里按
 * 访问单元头部的长度字段逐个切分后送入解码器，使一个损坏的访问单元只丢弃它自己，
 * 不连带同一 Block 里后续的访问单元。输出统一转换为平面 Float32。
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/log.h"
#include "libavutil/opt.h"

typedef struct {
  AVCodecContext *codec_ctx;
  AVPacket *packet;
  AVFrame *frame;
  uint8_t *input;
  int input_capacity;
  int input_size;
  int input_offset;
  float *output;
  int output_capacity;
  int output_channels;
  int output_samples;
  int output_rate;
  char layout[64];
} TrueHdContext;

static void release(TrueHdContext *ctx) {
  if (!ctx) return;
  av_frame_free(&ctx->frame);
  av_packet_free(&ctx->packet);
  avcodec_free_context(&ctx->codec_ctx);
  free(ctx->input);
  free(ctx->output);
  free(ctx);
}

/* channels 为 2 或 6 时请求解码器只解对应的呈现子流；其它值解出流内最大的呈现。 */
EMSCRIPTEN_KEEPALIVE
TrueHdContext *thd_open(int channels) {
  /* 错误通过返回码交给调用方；逐单元的警告写到控制台会在损坏流上刷屏。 */
  av_log_set_level(AV_LOG_QUIET);

  const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_TRUEHD);
  if (!codec) return NULL;

  TrueHdContext *ctx = calloc(1, sizeof(TrueHdContext));
  if (!ctx) return NULL;

  ctx->codec_ctx = avcodec_alloc_context3(codec);
  ctx->packet = av_packet_alloc();
  ctx->frame = av_frame_alloc();
  if (!ctx->codec_ctx || !ctx->packet || !ctx->frame) {
    release(ctx);
    return NULL;
  }

  AVDictionary *options = NULL;
  if (channels == 2) av_dict_set(&options, "downmix", "stereo", 0);
  if (channels == 6) av_dict_set(&options, "downmix", "5.1", 0);
  int ret = avcodec_open2(ctx->codec_ctx, codec, &options);
  av_dict_free(&options);
  if (ret < 0) {
    release(ctx);
    return NULL;
  }

  return ctx;
}

/* 返回可写入 size 字节 Block 负载的缓冲区，并把读取位置复位到开头。 */
EMSCRIPTEN_KEEPALIVE
uint8_t *thd_input(TrueHdContext *ctx, int size) {
  if (size > ctx->input_capacity) {
    uint8_t *next = realloc(ctx->input, size);
    if (!next) return NULL;
    ctx->input = next;
    ctx->input_capacity = size;
  }
  ctx->input_size = size;
  ctx->input_offset = 0;
  return ctx->input;
}

static int convert_frame(TrueHdContext *ctx) {
  AVFrame *frame = ctx->frame;
  int channels = frame->ch_layout.nb_channels;
  int samples = frame->nb_samples;
  int needed = channels * samples;

  if (needed > ctx->output_capacity) {
    float *next = realloc(ctx->output, (size_t)needed * sizeof(float));
    if (!next) return AVERROR(ENOMEM);
    ctx->output = next;
    ctx->output_capacity = needed;
  }

  /* mlpdec 只输出交错的 S16 或 S32（24 位样本左对齐），这里按满幅换算为平面浮点。 */
  if (frame->format == AV_SAMPLE_FMT_S32) {
    const int32_t *src = (const int32_t *)frame->data[0];
    for (int ch = 0; ch < channels; ch++) {
      float *dst = ctx->output + (size_t)ch * samples;
      for (int i = 0; i < samples; i++) dst[i] = src[i * channels + ch] * (1.0f / 2147483648.0f);
    }
  } else if (frame->format == AV_SAMPLE_FMT_S16) {
    const int16_t *src = (const int16_t *)frame->data[0];
    for (int ch = 0; ch < channels; ch++) {
      float *dst = ctx->output + (size_t)ch * samples;
      for (int i = 0; i < samples; i++) dst[i] = src[i * channels + ch] * (1.0f / 32768.0f);
    }
  } else {
    return AVERROR_PATCHWELCOME;
  }

  ctx->output_channels = channels;
  ctx->output_samples = samples;
  ctx->output_rate = frame->sample_rate;
  if (av_channel_layout_describe(&frame->ch_layout, ctx->layout, sizeof(ctx->layout)) < 0) {
    ctx->layout[0] = '\0';
  }
  return 0;
}

/*
 * 解码输入缓冲区中的下一个访问单元。
 * 返回 2 表示产出一帧（用 thd_frame_* 读取），1 表示该单元没有输出（例如尚未遇到 major sync），
 * 0 表示输入已耗尽，负数是该单元的 AVERROR，调用方可以继续调用以处理后续单元。
 */
EMSCRIPTEN_KEEPALIVE
int thd_next(TrueHdContext *ctx) {
  int remaining = ctx->input_size - ctx->input_offset;
  if (remaining <= 0) return 0;

  const uint8_t *unit = ctx->input + ctx->input_offset;
  /* 访问单元头：4 位校验半字节 + 12 位长度（以 16 位字计）。长度不可信时把剩余部分整体交给解码器判定。 */
  int length = remaining;
  if (remaining >= 4) {
    int declared = ((unit[0] << 8 | unit[1]) & 0xfff) * 2;
    if (declared >= 4 && declared <= remaining) length = declared;
  }
  ctx->input_offset += length;

  int ret = av_new_packet(ctx->packet, length);
  if (ret < 0) return ret;
  memcpy(ctx->packet->data, unit, length);

  ret = avcodec_send_packet(ctx->codec_ctx, ctx->packet);
  av_packet_unref(ctx->packet);
  if (ret < 0) return ret;

  ret = avcodec_receive_frame(ctx->codec_ctx, ctx->frame);
  if (ret == AVERROR(EAGAIN)) return 1;
  if (ret < 0) return ret;

  ret = convert_frame(ctx);
  av_frame_unref(ctx->frame);
  return ret < 0 ? ret : 2;
}

EMSCRIPTEN_KEEPALIVE
int thd_frame_channels(TrueHdContext *ctx) { return ctx->output_channels; }

EMSCRIPTEN_KEEPALIVE
int thd_frame_samples(TrueHdContext *ctx) { return ctx->output_samples; }

EMSCRIPTEN_KEEPALIVE
int thd_frame_rate(TrueHdContext *ctx) { return ctx->output_rate; }

/* 平面按声道连续排列，第 ch 个声道从 output + ch * samples 开始；下次 thd_next 前有效。 */
EMSCRIPTEN_KEEPALIVE
float *thd_frame_data(TrueHdContext *ctx) { return ctx->output; }

EMSCRIPTEN_KEEPALIVE
const char *thd_frame_layout(TrueHdContext *ctx) { return ctx->layout; }

/* TrueHD 解码器没有延迟输出，复位只清空跨访问单元的状态，之后需从 major sync 重新开始。 */
EMSCRIPTEN_KEEPALIVE
void thd_reset(TrueHdContext *ctx) {
  ctx->input_size = 0;
  ctx->input_offset = 0;
  avcodec_flush_buffers(ctx->codec_ctx);
}

EMSCRIPTEN_KEEPALIVE
void thd_close(TrueHdContext *ctx) { release(ctx); }

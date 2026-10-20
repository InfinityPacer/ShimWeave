import { describe, expect, it } from 'vitest';
import { LeadingPictureFilter, type OrderedVideoPacket } from './leading-pictures.js';

const key = (timestamp: number): OrderedVideoPacket => ({ timestamp, type: 'key' });
const delta = (timestamp: number): OrderedVideoPacket => ({ timestamp, type: 'delta' });

/** 按解码顺序喂入，返回实际写出的呈现时间。 */
const run = (packets: readonly OrderedVideoPacket[]): number[] => {
  const filter = new LeadingPictureFilter<OrderedVideoPacket>();
  const emitted = packets.flatMap((packet) => filter.push(packet));
  return [...emitted, ...filter.flush()].map((packet) => packet.timestamp);
};

describe('LeadingPictureFilter', () => {
  it('封闭 GOP 原样输出，B 帧重排不受影响', () => {
    expect(
      run([key(0), delta(0.3), delta(0.1), delta(0.2), key(0.4), delta(0.7), delta(0.5)]),
    ).toEqual([0, 0.3, 0.1, 0.2, 0.4, 0.7, 0.5]);
  });

  it('输出起点是开放 GOP 关键帧时丢弃它的前导图像', () => {
    // CRA 在 1.0，解码顺序上紧跟呈现更早的 RASL 0.92/0.88/0.96，之后才是尾随图像。
    expect(run([key(1), delta(0.92), delta(0.88), delta(0.96), delta(1.17), delta(1.08)])).toEqual([
      1, 1.17, 1.08,
    ]);
  });

  it('中途开放 GOP 的前导图像晚于上一 GOP 时保留，连续播放不丢帧', () => {
    expect(
      run([
        key(0),
        delta(0.83),
        delta(0.75),
        delta(0.79),
        key(1),
        delta(0.92),
        delta(0.88),
        delta(1.17),
      ]),
    ).toEqual([0, 0.83, 0.75, 0.79, 1, 0.92, 0.88, 1.17]);
  });

  it('中途前导图像早于上一 GOP 已写出的图像时整体丢弃，复用器不再拒绝', () => {
    // 上一 GOP 已写出 0.875；本 GOP 的前导图像 0.834 早于它，同一关键帧的其余前导图像一并丢弃。
    expect(
      run([
        key(0),
        delta(0.875),
        delta(0.75),
        key(1),
        delta(0.917),
        delta(0.834),
        delta(0.958),
        delta(1.167),
      ]),
    ).toEqual([0, 0.875, 0.75, 1, 1.167]);
  });

  it('输入在前导图像中结束时按同一规则释放', () => {
    expect(run([key(0), delta(0.5), key(1), delta(0.9)])).toEqual([0, 0.5, 1, 0.9]);
    expect(run([key(1), delta(0.9)])).toEqual([1]);
  });

  it('前导图像超过等待上限时直接裁决，不无界积压', () => {
    const filter = new LeadingPictureFilter<OrderedVideoPacket>();
    filter.push(key(0));
    filter.push(delta(0.01));
    filter.push(key(100));
    const released: number[] = [];
    for (let index = 1; index <= 65; index += 1) {
      released.push(...filter.push(delta(index)).map((packet) => packet.timestamp));
    }
    expect(released).toHaveLength(65);
    expect(filter.push(delta(66)).map((packet) => packet.timestamp)).toEqual([66]);
  });
});

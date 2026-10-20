export interface OrderedVideoPacket {
  readonly timestamp: number;
  readonly type: 'key' | 'delta';
}

interface GopState<T> {
  readonly keyTimestamp: number;
  /** 关键帧之前已写出包的最大呈现时间，复用器要求本 GOP 不早于它。 */
  readonly maxTimestampBeforeKey: number;
  readonly isStart: boolean;
  decision: 'pending' | 'keep' | 'drop';
  readonly held: T[];
}

/** 前导图像数量受解码器重排深度约束，超过时不再等待，直接按已收集的包裁决。 */
const MAX_HELD_LEADING_PICTURES = 64;

/**
 * 按解码顺序过滤开放 GOP 的前导图像，使输出满足 MediaBunny MP4 复用器的 GOP 时间戳约束。
 *
 * 开放 GOP 的随机访问点（HEVC CRA、带恢复点的 H.264 I 帧）之后，解码顺序上可能紧跟呈现时间
 * 更早的前导图像，它们可以引用该关键帧之前的图像。两种情况下丢弃该关键帧的全部前导图像：
 * - 输出起点的关键帧：之前的参考图像不在输出里，前导图像无法正确解码，时间也早于新时间轴零点；
 * - 中途关键帧的前导图像早于已写出图像的最大呈现时间：复用器按 GOP 推导解码时间，无法写入。
 * 编码规范保证非前导图像不引用前导图像，所以丢弃后其余图像仍可正确解码；其余情况原样输出。
 */
export class LeadingPictureFilter<T extends OrderedVideoPacket> {
  private maxEmittedTimestamp = Number.NEGATIVE_INFINITY;
  private gop: GopState<T> | undefined;

  /** 返回本包到达后可以按顺序写出的包；被丢弃或仍需等待的前导图像不返回。 */
  push(packet: T): T[] {
    if (packet.type === 'key' || !this.gop) {
      const released = this.emit(this.decide());
      this.gop = {
        keyTimestamp: packet.timestamp,
        maxTimestampBeforeKey: this.maxEmittedTimestamp,
        isStart: this.gop === undefined,
        decision: 'pending',
        held: [],
      };
      released.push(...this.emit([packet]));
      return released;
    }

    const gop = this.gop;
    if (packet.timestamp < gop.keyTimestamp && gop.decision === 'pending') {
      gop.held.push(packet);
      return gop.held.length > MAX_HELD_LEADING_PICTURES ? this.emit(this.decide()) : [];
    }
    const released = this.decide();
    // 解码顺序异常时仍不能把早于上一 GOP 的包交给复用器。
    if (packet.timestamp < gop.keyTimestamp && this.mustDrop(gop, packet)) {
      return this.emit(released);
    }
    released.push(packet);
    return this.emit(released);
  }

  /** 输入结束时释放仍在等待裁决的前导图像。 */
  flush(): T[] {
    return this.emit(this.decide());
  }

  private decide(): T[] {
    const gop = this.gop;
    if (gop?.decision !== 'pending') return [];
    const drop = gop.isStart || gop.held.some((packet) => this.mustDrop(gop, packet));
    gop.decision = drop ? 'drop' : 'keep';
    const released = drop ? [] : [...gop.held];
    gop.held.length = 0;
    return released;
  }

  private mustDrop(gop: GopState<T>, packet: OrderedVideoPacket): boolean {
    return gop.isStart || gop.decision === 'drop' || packet.timestamp < gop.maxTimestampBeforeKey;
  }

  private emit(packets: T[]): T[] {
    for (const packet of packets) {
      this.maxEmittedTimestamp = Math.max(this.maxEmittedTimestamp, packet.timestamp);
    }
    return packets;
  }
}

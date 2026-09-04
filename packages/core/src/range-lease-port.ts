export interface RangeLeaseMessageEvent {
  readonly data: unknown;
}

/** RangeLeasePort 是 MessagePort 的最小可替换子集，协议消息不得携带媒体字节。 */
export interface RangeLeasePort {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: RangeLeaseMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: RangeLeaseMessageEvent) => void): void;
  start?(): void;
  close?(): void;
}

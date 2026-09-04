export const RANGE_LEASE_PROTOCOL = 'shimweave-range-lease-v1' as const;

interface RangeLeaseTaskMessage {
  protocol: typeof RANGE_LEASE_PROTOCOL;
  taskId: string;
}

export interface RangeLeaseHelloMessage {
  protocol: typeof RANGE_LEASE_PROTOCOL;
  type: 'hello';
}

export interface RangeLeaseRequestMessage extends RangeLeaseTaskMessage {
  type: 'request';
  /** 稳定的不透明内容身份；不得传递签名 URL。 */
  sourceId: string;
  priority: number;
}

export interface RangeLeasePromoteMessage extends RangeLeaseTaskMessage {
  type: 'promote';
  priority: number;
}

export interface RangeLeaseCancelMessage extends RangeLeaseTaskMessage {
  type: 'cancel';
}

export interface RangeLeaseReleaseMessage extends RangeLeaseTaskMessage {
  type: 'release';
}

export interface RangeLeaseDisconnectMessage {
  protocol: typeof RANGE_LEASE_PROTOCOL;
  type: 'disconnect';
}

export type RangeLeaseClientMessage =
  | RangeLeaseHelloMessage
  | RangeLeaseRequestMessage
  | RangeLeasePromoteMessage
  | RangeLeaseCancelMessage
  | RangeLeaseReleaseMessage
  | RangeLeaseDisconnectMessage;

export interface RangeLeaseGrantedMessage extends RangeLeaseTaskMessage {
  type: 'granted';
}

export interface RangeLeaseReadyMessage {
  protocol: typeof RANGE_LEASE_PROTOCOL;
  type: 'ready';
}

export type RangeLeaseRejectionCode =
  | 'queue_full'
  | 'preempted'
  | 'request_expired'
  | 'lease_expired'
  | 'coordinator_closed'
  | 'invalid_request'
  | 'cancelled';

export interface RangeLeaseRejectedMessage extends RangeLeaseTaskMessage {
  type: 'rejected';
  code: RangeLeaseRejectionCode;
  limit?: number;
  taskPriority?: number;
  incomingPriority?: number;
}

export type RangeLeaseHostMessage =
  | RangeLeaseReadyMessage
  | RangeLeaseGrantedMessage
  | RangeLeaseRejectedMessage;

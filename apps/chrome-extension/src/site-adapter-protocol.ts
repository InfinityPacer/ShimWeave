export const SITE_ADAPTER_ACTIVATE_MESSAGE = 'shimweave:site-adapter-activate' as const;
export const SITE_ADAPTER_REACTIVATE_MESSAGE = 'shimweave:site-adapter-reactivate' as const;

export interface SiteAdapterActivateMessage {
  readonly type: typeof SITE_ADAPTER_ACTIVATE_MESSAGE;
  readonly adapterId: string;
}

export interface SiteAdapterActivateResponse {
  readonly activated: boolean;
  readonly adapterId?: string;
}

export interface SiteAdapterReactivateMessage {
  readonly type: typeof SITE_ADAPTER_REACTIVATE_MESSAGE;
  readonly adapterId: string;
}

export const isSiteAdapterActivateMessage = (
  value: unknown,
): value is SiteAdapterActivateMessage => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    !('adapterId' in value)
  ) {
    return false;
  }
  return (
    value.type === SITE_ADAPTER_ACTIVATE_MESSAGE &&
    typeof value.adapterId === 'string' &&
    value.adapterId.length > 0 &&
    value.adapterId.length <= 128
  );
};

export const isSiteAdapterReactivateMessage = (
  value: unknown,
): value is SiteAdapterReactivateMessage => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    !('adapterId' in value)
  ) {
    return false;
  }
  return (
    value.type === SITE_ADAPTER_REACTIVATE_MESSAGE &&
    typeof value.adapterId === 'string' &&
    value.adapterId.length > 0 &&
    value.adapterId.length <= 128
  );
};

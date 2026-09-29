/**
 * 生成 RFC 4122 v4 格式的随机标识，用于会话、通知等跨上下文消息。
 *
 * 不用 `crypto.randomUUID`：它只在安全上下文可用，以 `http://<局域网地址>:32400/web`
 * 打开的 Plex Web 不是安全上下文，页面与内容脚本里都没有它。`getRandomValues` 在两种
 * 上下文都可用。
 */
export const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

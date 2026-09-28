/**
 * 把容器里的文本字幕负载归一为 WebVTT cue 文本。输出只保留 <i>、<b>、<u> 与换行，
 * 其余标签去掉、字符全部转义，渲染端按 cue 文本解析，不会把字幕当作 HTML。
 */
export interface NormalizedSubtitleText {
  text: string;
  placement?: 'top';
}

export type TextSubtitleFormat = 'srt' | 'webvtt';

type KeptTag = 'i' | 'b' | 'u';

const KEPT_TAGS: ReadonlySet<string> = new Set<KeptTag>(['i', 'b', 'u']);
const TAG_PATTERN = /<(\/\s*)?([a-zA-Z][a-zA-Z0-9]*)(?:[\s.][^<>]*)?>/g;
/** SRT 里常见的 ASS 覆盖标记，例如 {\an8}、{\i1}；只识别置顶位置，其余丢弃。 */
const OVERRIDE_PATTERN = /\{\\[^{}]*\}/g;
const TOP_ALIGNMENT_PATTERN = /\\an[789](?![0-9])/;

export const normalizeSubtitleText = (
  raw: string,
  format: TextSubtitleFormat,
): NormalizedSubtitleText | undefined => {
  let source = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let placement: 'top' | undefined;
  source = source.replace(OVERRIDE_PATTERN, (block) => {
    if (TOP_ALIGNMENT_PATTERN.test(block)) placement = 'top';
    return '';
  });
  // 从 ASS 转换来的 SRT 常把硬换行写成字面量 \N。
  source = source.replace(/\\N/g, '\n');

  const decode = format === 'webvtt' ? decodeWebVttEntities : (text: string) => text;
  const lines: string[] = [];
  // 跨行的 <i> 等标签在每行末尾关闭、下一行重新打开，丢弃空行时嵌套仍然成立。
  let open: KeptTag[] = [];
  for (const line of source.split('\n')) {
    const rendered = renderLine(line, open, decode);
    open = rendered.open;
    if (visibleText(rendered.text).trim() !== '') lines.push(rendered.text.trimEnd());
  }
  if (lines.length === 0) return undefined;
  const text = lines.join('\n');
  return placement ? { text, placement } : { text };
};

const renderLine = (
  line: string,
  carried: readonly KeptTag[],
  decode: (text: string) => string,
): { text: string; open: KeptTag[] } => {
  const open = [...carried];
  let output = open.map((tag) => `<${tag}>`).join('');
  let cursor = 0;
  for (const match of line.matchAll(TAG_PATTERN)) {
    output += escapeCueText(decode(line.slice(cursor, match.index)));
    cursor = match.index + match[0].length;
    const name = match[2]?.toLowerCase() ?? '';
    if (!KEPT_TAGS.has(name)) continue;
    const tag = name as KeptTag;
    if (match[1] === undefined) {
      open.push(tag);
      output += `<${tag}>`;
      continue;
    }
    const index = open.lastIndexOf(tag);
    if (index === -1) continue;
    // 关闭时先关掉更内层的标签再重新打开，保证输出始终正确嵌套。
    const inner = open.splice(index);
    output += closeTags(inner);
    const reopened = inner.slice(1);
    open.push(...reopened);
    output += reopened.map((item) => `<${item}>`).join('');
  }
  output += escapeCueText(decode(line.slice(cursor)));
  output += closeTags(open);
  return { text: output, open };
};

const closeTags = (tags: readonly KeptTag[]): string =>
  [...tags]
    .reverse()
    .map((tag) => `</${tag}>`)
    .join('');

const visibleText = (text: string): string => text.replace(/<\/?[ibu]>/g, '');

const escapeCueText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const decodeWebVttEntities = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lrm;/g, '‎')
    .replace(/&rlm;/g, '‏')
    .replace(/&amp;/g, '&');

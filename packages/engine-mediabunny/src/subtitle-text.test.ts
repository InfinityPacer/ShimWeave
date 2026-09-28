import { describe, expect, it } from 'vitest';
import { normalizeSubtitleText } from './subtitle-text.js';

describe('normalizeSubtitleText', () => {
  it('保留换行并统一 CRLF，去掉空行与行尾空白', () => {
    expect(normalizeSubtitleText('﻿第一行  \r\n\r\n第二行\r第三行\n', 'srt')).toEqual({
      text: '第一行\n第二行\n第三行',
    });
  });

  it('保留 i、b、u 标签，去掉 font 等其他标签', () => {
    expect(
      normalizeSubtitleText('<I>斜体</I> <font color="#ffff00">黄色</font> <b >粗</ b>', 'srt'),
    ).toEqual({ text: '<i>斜体</i> 黄色 <b>粗</b>' });
  });

  it('转义尖括号与 & 字符，不让文本变成标签或实体', () => {
    expect(normalizeSubtitleText('a < b && c > d <script>x</script>', 'srt')).toEqual({
      text: 'a &lt; b &amp;&amp; c &gt; d x',
    });
    expect(normalizeSubtitleText('<img src=x onerror=alert(1)>文本', 'srt')).toEqual({
      text: '文本',
    });
  });

  it('跨行标签逐行闭合，交错关闭时保持正确嵌套', () => {
    expect(normalizeSubtitleText('<i>第一行\n第二行</i>', 'srt')).toEqual({
      text: '<i>第一行</i>\n<i>第二行</i>',
    });
    expect(normalizeSubtitleText('<i><b>x</i>y</b>', 'srt')).toEqual({
      text: '<i><b>x</b></i><b>y</b>',
    });
    expect(normalizeSubtitleText('</i>未打开', 'srt')).toEqual({ text: '未打开' });
  });

  it('识别 {\\an8} 置顶并去掉其他覆盖标记与字面量 \\N', () => {
    expect(normalizeSubtitleText('{\\an8}{\\i1}上方\\N第二行', 'srt')).toEqual({
      text: '上方\n第二行',
      placement: 'top',
    });
    expect(normalizeSubtitleText('{\\an2}底部', 'srt')).toEqual({ text: '底部' });
  });

  it('只有标签或空白的负载返回 undefined', () => {
    expect(normalizeSubtitleText('<i> </i>\n\n', 'srt')).toBeUndefined();
    expect(normalizeSubtitleText('{\\an8}', 'srt')).toBeUndefined();
  });

  it('WebVTT 负载先解码实体再转义，去掉 c 与 v 标签', () => {
    expect(normalizeSubtitleText('<v 张三>你好 &amp; <c.yellow>再见</c> &lt;3', 'webvtt')).toEqual({
      text: '你好 &amp; 再见 &lt;3',
    });
  });
});

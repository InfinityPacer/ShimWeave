import { describe, expect, it } from 'vitest';
import { parseSidecarSubtitles } from './sidecar-subtitles.js';

describe('外挂字幕文件解析', () => {
  it('解析 SRT：带 BOM 与 CRLF、置顶标记与样式标签，跳过时间不合法的块', () => {
    const srt = [
      '﻿1',
      '00:00:03,000 --> 00:00:04,000',
      '{\\an8}<font color="#fff">上方</font>',
      '',
      '2',
      '00:00:01,000 --> 00:00:02,500',
      '<i>斜体</i>',
      '第二行 & 符号',
      '',
      '3',
      '00:00:05,000 --> 00:00:04,000',
      '倒序',
      '',
      '4',
      '00:61:00,000 --> 00:62:00,000',
      '越界',
      '',
      '5',
      '01:00:00.5 --> 01:00:01,250',
      '一小时',
      '',
    ].join('\r\n');

    expect(parseSidecarSubtitles(srt, 'srt')).toEqual([
      { startSeconds: 1, endSeconds: 2.5, text: '<i>斜体</i>\n第二行 &amp; 符号' },
      { startSeconds: 3, endSeconds: 4, text: '上方', placement: 'top' },
      { startSeconds: 3600.5, endSeconds: 3601.25, text: '一小时' },
    ]);
  });

  it('解析 WebVTT：跳过文件头与 NOTE、STYLE 块，接受不带小时的时间与 cue 设置', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE 注释',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'intro',
      '00:01.000 --> 00:02.000 align:start line:0',
      '&lt;你好&gt;',
      '',
      '00:00:03.000 --> 00:00:04.000',
      '第二句',
    ].join('\n');

    expect(parseSidecarSubtitles(vtt, 'webvtt')).toEqual([
      { startSeconds: 1, endSeconds: 2, text: '&lt;你好&gt;' },
      { startSeconds: 3, endSeconds: 4, text: '第二句' },
    ]);
  });

  it('SRT 台词中的空行之后仍属于上一句，时间不合法的块连同续行一起跳过', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:02,000',
      '第一行',
      '',
      '空行之后',
      '',
      '2',
      '00:00:03,000 --> 00:00:02,000',
      '倒序',
      '',
      '倒序的续行',
      '',
      '3',
      '00:00:04,000 --> 00:00:05,000',
      '第三句',
    ].join('\n');

    expect(parseSidecarSubtitles(srt, 'srt')).toEqual([
      { startSeconds: 1, endSeconds: 2, text: '第一行\n空行之后' },
      { startSeconds: 4, endSeconds: 5, text: '第三句' },
    ]);
  });

  it('SRT 句与句之间隔着多个空行（含 CRLF 与空白行）时仍逐句解析，末尾孤立的序号不并入', () => {
    const srt = [
      '',
      '1',
      '00:00:01,000 --> 00:00:02,000',
      '第一句',
      '',
      '',
      '2',
      '00:00:03,000 --> 00:00:04,000',
      '第二句',
      '  ',
      '',
      '',
      '3',
      '00:00:05,000 --> 00:00:06,000',
      '第三句',
      '',
      '续行',
      '',
      '',
      '4',
      '',
    ].join('\r\n');

    expect(parseSidecarSubtitles(srt, 'srt')).toEqual([
      { startSeconds: 1, endSeconds: 2, text: '第一句' },
      { startSeconds: 3, endSeconds: 4, text: '第二句' },
      { startSeconds: 5, endSeconds: 6, text: '第三句\n续行' },
    ]);
  });

  it('WebVTT cue 之后的 NOTE、STYLE、REGION 块不并入台词', () => {
    const vtt = [
      'WEBVTT',
      '',
      'REGION',
      'id:bottom width:40%',
      '',
      '00:00:01.000 --> 00:00:02.000',
      '第一句',
      '',
      'NOTE 中途注释',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      '00:00:03.000 --> 00:00:04.000',
      '第二句',
      '',
      'NOTE 结尾注释',
    ].join('\n');

    expect(parseSidecarSubtitles(vtt, 'webvtt')).toEqual([
      { startSeconds: 1, endSeconds: 2, text: '第一句' },
      { startSeconds: 3, endSeconds: 4, text: '第二句' },
    ]);
  });

  it('不是字幕的文本得到空列表', () => {
    expect(parseSidecarSubtitles('not subtitles', 'srt')).toEqual([]);
    expect(parseSidecarSubtitles('', 'webvtt')).toEqual([]);
  });
});

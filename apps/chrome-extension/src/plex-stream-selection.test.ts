import { describe, expect, it, vi } from 'vitest';
import {
  fetchPlexStreamSelection,
  fetchPlexSubtitleFile,
  isPlexStreamSelectionMessage,
  isPlexSubtitleFileMessage,
  PLEX_STREAM_SELECTION_MESSAGE,
  PLEX_SUBTITLE_FILE_MAX_BYTES,
  PLEX_SUBTITLE_FILE_MESSAGE,
} from './plex-stream-selection.js';

const context = {
  origin: 'https://plex.example.test:32400',
  metadataPath: '/library/metadata/42',
  ratingKey: '42',
  token: 'secret-token',
  clientParameters: [],
};

const body = {
  MediaContainer: {
    Metadata: [
      {
        Media: [
          {
            Part: [
              {
                Stream: [
                  { streamType: 2, index: 1, codec: 'truehd' },
                  { streamType: 2, index: 2, codec: 'ac3', selected: true, languageTag: 'en' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe('Plex 音轨选择消息', () => {
  it('只接受带播放会话句柄和非负位置的消息', () => {
    const valid = {
      type: PLEX_STREAM_SELECTION_MESSAGE,
      reportId: 'report_id_1234567890',
      mediaIndex: 0,
      partIndex: 0,
    };
    expect(isPlexStreamSelectionMessage(valid)).toBe(true);
    expect(isPlexStreamSelectionMessage({ ...valid, reportId: 'short' })).toBe(false);
    expect(isPlexStreamSelectionMessage({ ...valid, mediaIndex: -1 })).toBe(false);
    expect(isPlexStreamSelectionMessage({ ...valid, partIndex: 1.5 })).toBe(false);
  });

  it('后台用请求头携带 Token 读取元数据并返回选择', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

    const selection = await fetchPlexStreamSelection(context, 0, 0, fetcher as typeof fetch);

    expect(selection).toEqual({ audio: { ordinal: 1, codec: 'ac3', language: 'en' } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('secret-token');
    expect(init.headers).toMatchObject({ 'X-Plex-Token': 'secret-token' });
    expect(init.credentials).toBe('omit');
  });

  it('请求失败或响应异常时返回标记读取失败的空选择', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('network');
    });
    const denied = vi.fn(async () => new Response('', { status: 401 }));
    const garbage = vi.fn(async () => new Response('not json', { status: 200 }));

    expect(await fetchPlexStreamSelection(context, 0, 0, failing as typeof fetch)).toEqual({
      readFailed: true,
    });
    expect(await fetchPlexStreamSelection(context, 0, 0, denied as typeof fetch)).toEqual({
      readFailed: true,
    });
    expect(await fetchPlexStreamSelection(context, 0, 0, garbage as typeof fetch)).toEqual({
      readFailed: true,
    });
  });
});

describe('Plex 外挂字幕文件', () => {
  it('只接受会话句柄与字幕文件地址', () => {
    const valid = {
      type: PLEX_SUBTITLE_FILE_MESSAGE,
      reportId: 'report_id_1234567890',
      key: '/library/streams/20',
    };
    expect(isPlexSubtitleFileMessage(valid)).toBe(true);
    expect(isPlexSubtitleFileMessage({ ...valid, key: '/library/metadata/42' })).toBe(false);
    expect(isPlexSubtitleFileMessage({ ...valid, key: '/library/streams/20/../../x' })).toBe(false);
    expect(isPlexSubtitleFileMessage({ ...valid, reportId: 'short' })).toBe(false);
  });

  it('要求 Plex 转成 UTF-8，用请求头携带 Token 读取，按 UTF-8 解码', async () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n你好\n';
    const fetcher = vi.fn(async () => new Response(new TextEncoder().encode(srt), { status: 200 }));

    expect(
      await fetchPlexSubtitleFile(context, '/library/streams/20', fetcher as typeof fetch),
    ).toEqual({ text: srt });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://plex.example.test:32400/library/streams/20?encoding=utf-8');
    expect(init.headers).toMatchObject({ 'X-Plex-Token': 'secret-token' });
    expect(init.credentials).toBe('omit');
  });

  it('Plex 没能转换的 GBK、Big5 字幕按编码不受支持返回，零星坏字节的 UTF-8 照常解码', async () => {
    const read = async (bytes: readonly number[]) =>
      fetchPlexSubtitleFile(
        context,
        '/library/streams/20',
        vi.fn(async () => new Response(Uint8Array.from(bytes), { status: 200 })),
      );
    const ascii = (text: string) => Array.from(new TextEncoder().encode(text));
    const cue = (index: number, text: string) =>
      ascii(`${index}\n00:00:01,000 --> 00:00:02,000\n${text}\n\n`);

    // 「你好世界」的 GBK 与 Big5 字节。
    const gbk = [...cue(1, ''), 0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7, 0x0a];
    const big5 = [...cue(1, ''), 0xa7, 0x41, 0xa6, 0x6e, 0xa5, 0x40, 0xac, 0xc9, 0x0a];
    expect(await read(gbk)).toEqual({ unreadable: true });
    expect(await read(big5)).toEqual({ unreadable: true });

    // 两百句英文里只有一句是 GBK 的「中文」：替换字符不到全文的 0.1%，仍按编码不受支持返回。
    const english = Array.from({ length: 200 }, (_, i) => cue(i + 1, `line ${i + 1}`)).flat();
    expect(await read([...english, ...cue(201, ''), 0xd6, 0xd0, 0xce, 0xc4, 0x0a])).toEqual({
      unreadable: true,
    });

    // 只有一句的小文件里一个坏字节，替换字符占全文约 3%，照常显示。
    const tiny = await read([...cue(1, 'hi'), 0xff, 0x0a]);
    expect(tiny.text).toContain('hi');
    // 中文 UTF-8 字幕里夹着几个坏字节，替换字符只占非 ASCII 字符的一小部分，照常显示。
    const chinese = Array.from({ length: 9 }, (_, i) => cue(i + 1, `第 ${i + 1} 句你好`)).flat();
    const stray = await read([...chinese, 0xff, 0xfe, 0xff, 0xfe, 0xff, 0x0a]);
    expect(stray.text).toContain('第 9 句你好');
    expect(stray.unreadable).toBeUndefined();
  });

  it('失败、地址不对或超出大小上限时返回空应答', async () => {
    const failed = vi.fn(async () => new Response('', { status: 404 }));
    expect(await fetchPlexSubtitleFile(context, '/library/streams/20', failed)).toEqual({});
    const rejected = vi.fn(async () => {
      throw new TypeError('network');
    });
    expect(await fetchPlexSubtitleFile(context, '/library/streams/20', rejected)).toEqual({});
    const never = vi.fn(async () => new Response('x'));
    expect(await fetchPlexSubtitleFile(context, '/library/parts/20', never)).toEqual({});
    expect(never).not.toHaveBeenCalled();
    const huge = vi.fn(
      async () => new Response(new Uint8Array(PLEX_SUBTITLE_FILE_MAX_BYTES + 1), { status: 200 }),
    );
    expect(await fetchPlexSubtitleFile(context, '/library/streams/20', huge)).toEqual({});
  });
});

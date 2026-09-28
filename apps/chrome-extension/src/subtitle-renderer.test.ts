import { describe, expect, it } from 'vitest';
import { TextTrackSubtitleRenderer } from './subtitle-renderer.js';

class FakeCue {
  line: number | 'auto' = 'auto';
  snapToLines = true;

  constructor(
    readonly startTime: number,
    readonly endTime: number,
    readonly text: string,
  ) {}
}

class FakeTextTrack {
  mode: TextTrackMode = 'disabled';
  readonly list: FakeCue[] = [];

  get cues(): FakeCue[] {
    return [...this.list];
  }

  addCue(cue: FakeCue): void {
    this.list.push(cue);
  }

  removeCue(cue: FakeCue): void {
    this.list.splice(this.list.indexOf(cue), 1);
  }
}

class FakeDocument {
  readonly styles: { attribute: string; textContent: string }[] = [];
  readonly head = {
    append: (style: { attribute: string; textContent: string }) => this.styles.push(style),
  };

  querySelector(selector: string) {
    return selector.startsWith('style[') && this.styles.length > 0 ? this.styles[0] : null;
  }

  createElement() {
    return {
      attribute: '',
      textContent: '',
      setAttribute(name: string) {
        this.attribute = name;
      },
    };
  }
}

class FakeMediaElement {
  readonly ownerDocument = new FakeDocument();
  readonly textTracks = new EventTarget();
  readonly created: { kind: string; label: string; language: string; track: FakeTextTrack }[] = [];
  readonly attributes = new Set<string>();

  addTextTrack(kind: string, label: string, language: string): FakeTextTrack {
    const track = new FakeTextTrack();
    this.created.push({ kind, label, language, track });
    return track;
  }

  setAttribute(name: string): void {
    this.attributes.add(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

const create = (media = new FakeMediaElement()) => ({
  media,
  renderer: new TextTrackSubtitleRenderer({
    mediaElement: media as unknown as HTMLMediaElement,
    language: 'chi',
    createCue: FakeCue as unknown as typeof VTTCue,
  }),
});

describe('TextTrackSubtitleRenderer', () => {
  it('在 video 上建立显示中的字幕轨并注入限定作用域的样式', () => {
    const { media } = create();
    const created = media.created[0];

    expect(created).toMatchObject({ kind: 'subtitles', label: 'ShimWeave', language: 'chi' });
    expect(created?.track.mode).toBe('showing');
    expect(media.attributes.has('data-shimweave-subtitles')).toBe(true);
    expect(media.ownerDocument.styles[0]?.textContent).toContain(
      'video[data-shimweave-subtitles]::cue',
    );
  });

  it('按绝对时间添加 cue，置顶 cue 放在第一行，重复 cue 只添加一次', () => {
    const { media, renderer } = create();
    renderer.add([
      { startSeconds: 973, endSeconds: 975, text: '<i>斜体</i>\n第二行' },
      { startSeconds: 976, endSeconds: 978, text: '上方', placement: 'top' },
      { startSeconds: 973, endSeconds: 975, text: '<i>斜体</i>\n第二行' },
    ]);
    const cues = media.created[0]?.track.list ?? [];

    expect(cues.map((cue) => [cue.startTime, cue.endTime, cue.text])).toEqual([
      [973, 975, '<i>斜体</i>\n第二行'],
      [976, 978, '上方'],
    ]);
    expect(cues[1]?.line).toBe(0);
    expect(cues[0]?.line).toBe('auto');
  });

  it('新代次清空旧 cue，销毁后停用字幕轨并复用同一条轨道', () => {
    const { media, renderer } = create();
    renderer.add([{ startSeconds: 1, endSeconds: 2, text: '旧' }]);
    renderer.reset();
    expect(media.created[0]?.track.list).toEqual([]);
    renderer.add([{ startSeconds: 1, endSeconds: 2, text: '旧' }]);
    expect(media.created[0]?.track.list).toHaveLength(1);

    renderer.dispose();
    expect(media.created[0]?.track.mode).toBe('disabled');
    expect(media.created[0]?.track.list).toEqual([]);
    expect(media.attributes.has('data-shimweave-subtitles')).toBe(false);
    renderer.add([{ startSeconds: 3, endSeconds: 4, text: '晚到' }]);
    expect(media.created[0]?.track.list).toEqual([]);

    create(media);
    expect(media.created).toHaveLength(1);
    expect(media.created[0]?.track.mode).toBe('showing');
    expect(media.ownerDocument.styles).toHaveLength(1);
  });

  it('站点脚本关闭字幕轨时有限次数地恢复显示', () => {
    const { media } = create();
    const track = media.created[0]?.track;
    if (!track) throw new Error('track missing');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      track.mode = 'disabled';
      media.textTracks.dispatchEvent(new Event('change'));
    }
    expect(track.mode).toBe('disabled');
    track.mode = 'disabled';
    const fresh = create(new FakeMediaElement());
    const freshTrack = fresh.media.created[0]?.track;
    if (!freshTrack) throw new Error('track missing');
    freshTrack.mode = 'hidden';
    fresh.media.textTracks.dispatchEvent(new Event('change'));
    expect(freshTrack.mode).toBe('showing');
  });
});

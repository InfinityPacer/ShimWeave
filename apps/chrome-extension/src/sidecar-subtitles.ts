import type { SubtitleCue } from '@shimweave/contracts';
import {
  normalizeSubtitleText,
  type TextSubtitleFormat,
} from '@shimweave/engine-mediabunny/subtitle-text';

const SRT_TIMING =
  /^\s*(\d+:)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+:)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

/**
 * 把外挂字幕文件解析为按开始时间排序的 cue。时间是原媒体时间；文本与内嵌字幕一样归一为
 * WebVTT cue 文本。时间行不合法的块整块跳过，不影响其余字幕。
 *
 * SRT 台词里可能出现空行，空行之后、下一个时间行之前的文字仍属于上一句。WebVTT 的空行
 * 结束 cue，之后没有时间行的块是 NOTE、STYLE、REGION 或文件头，不并入台词。
 */
export const parseSidecarSubtitles = (text: string, format: TextSubtitleFormat): SubtitleCue[] => {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues: SubtitleCue[] = [];
  let pending: PendingCue | undefined;
  const finish = (): void => {
    if (!pending) return;
    const normalized = normalizeSubtitleText(pending.lines.join('\n'), format);
    if (normalized) cues.push({ ...pending.timing, ...normalized });
    pending = undefined;
  };
  const blocks = source.trimEnd().split(/\n(?:[ \t]*\n)+/);
  for (const [blockIndex, block] of blocks.entries()) {
    const lines = block.split('\n');
    while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    // SRT 的时间行前最多一行序号；没有时间行的块在 SRT 里是上一句的续行，
    // 文件末尾只剩一个序号的块是没写完的下一句，不并入。
    if (timingIndex < 0 || timingIndex > 1) {
      const danglingIndex =
        blockIndex === blocks.length - 1 &&
        lines.length === 1 &&
        /^\s*\d+\s*$/.test(lines[0] ?? '');
      if (format === 'srt' && pending && !danglingIndex) pending.lines.push(...lines);
      continue;
    }
    finish();
    const timing = parseTiming(lines[timingIndex] ?? '');
    if (timing) pending = { timing, lines: lines.slice(timingIndex + 1) };
  }
  finish();
  return cues.sort((left, right) => left.startSeconds - right.startSeconds);
};

interface CueTiming {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

interface PendingCue {
  readonly timing: CueTiming;
  readonly lines: string[];
}

const parseTiming = (line: string): CueTiming | undefined => {
  const timing = SRT_TIMING.exec(line);
  if (!timing) return undefined;
  const startSeconds = timestamp(timing[1], timing[2], timing[3], timing[4]);
  const endSeconds = timestamp(timing[5], timing[6], timing[7], timing[8]);
  if (startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds) {
    return undefined;
  }
  return { startSeconds, endSeconds };
};

const timestamp = (
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
  fraction: string | undefined,
): number | undefined => {
  const parsedMinutes = Number(minutes);
  const parsedSeconds = Number(seconds);
  if (parsedMinutes > 59 || parsedSeconds > 59) return undefined;
  const parsedHours = hours ? Number(hours.slice(0, -1)) : 0;
  const milliseconds = Number((fraction ?? '0').padEnd(3, '0'));
  const value = parsedHours * 3600 + parsedMinutes * 60 + parsedSeconds + milliseconds / 1000;
  return Number.isFinite(value) ? value : undefined;
};

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
 */
export const parseSidecarSubtitles = (text: string, format: TextSubtitleFormat): SubtitleCue[] => {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues: SubtitleCue[] = [];
  for (const block of source.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    // WebVTT 的 NOTE、STYLE、REGION 块与文件头没有时间行；SRT 的时间行前最多一行序号。
    if (timingIndex < 0 || timingIndex > 1) continue;
    const timing = SRT_TIMING.exec(lines[timingIndex] ?? '');
    if (!timing) continue;
    const startSeconds = timestamp(timing[1], timing[2], timing[3], timing[4]);
    const endSeconds = timestamp(timing[5], timing[6], timing[7], timing[8]);
    if (startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds) {
      continue;
    }
    const normalized = normalizeSubtitleText(lines.slice(timingIndex + 1).join('\n'), format);
    if (!normalized) continue;
    cues.push({ startSeconds, endSeconds, ...normalized });
  }
  return cues.sort((left, right) => left.startSeconds - right.startSeconds);
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

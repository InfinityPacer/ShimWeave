// 测量 TrueHD 解码的实时倍率：node scripts/bench.mjs <truehd.mkv> [2|6|8]
// 需先 pnpm build；输入文件可用 build-fixture.sh 的参数生成更长的合成样本，不要提交。
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny';
import { createTrueHdDecoder } from '../dist/index.js';

const [path, channelArg = '6'] = process.argv.slice(2);
if (!path) throw new Error('usage: node scripts/bench.mjs <truehd.mkv> [2|6|8]');

const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
const track = await input.getPrimaryAudioTrack();
const packets = [];
for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet.data);
input.dispose();

const decoder = await createTrueHdDecoder({ channels: Number(channelArg) });
const started = process.hrtime.bigint();
let frames = 0;
let sampleRate = 0;
let channels = 0;
for (const packet of packets) {
  for (const audio of decoder.decode(packet)) {
    frames += audio.numberOfFrames;
    sampleRate = audio.sampleRate;
    channels = audio.numberOfChannels;
  }
}
const seconds = Number(process.hrtime.bigint() - started) / 1e9;
decoder.close();

const media = frames / sampleRate;
console.log(
  `${packets.length} packets, ${channels} ch @ ${sampleRate} Hz, ${media.toFixed(2)} s media in ${seconds.toFixed(3)} s, ${(media / seconds).toFixed(1)}x realtime`,
);

import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Procedural, royalty-free electronic placeholders. No external packages or API keys.
const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, 'assets/audio/placeholders');
const sampleRate = 48_000;
const sounds = [
  'ui-tap','ui-back','ui-open','ui-close','ui-select','ui-toggle','ui-confirm','ui-error','ui-copy','ui-enter-game',
  'notification','match-found','room-join','room-ready','transaction-ok','message-send','message-received',
  'connection-warning','connection-restored','card-shuffle','card-deal','card-pick','card-place','hand-submit',
  'timer-tick','card-reveal','compare-win','compare-loss','compare-draw','special-score','slam','full-sweep',
  'foul','special-hand','round-win','round-loss',
];

const profiles = {
  tap: { f: 880, end: 660, dur: .075, wave: 'sine' },
  back: { f: 620, end: 390, dur: .105, wave: 'sine' },
  open: { f: 440, end: 880, dur: .16, wave: 'triangle' },
  close: { f: 780, end: 420, dur: .14, wave: 'triangle' },
  select: { f: 660, end: 990, dur: .095, wave: 'sine' },
  toggle: { f: 510, end: 760, dur: .12, wave: 'square' },
  confirm: { f: 523.25, end: 783.99, dur: .22, wave: 'sine', notes: [523.25, 659.25, 783.99] },
  error: { f: 330, end: 190, dur: .23, wave: 'triangle', notes: [330, 246.94] },
  copy: { f: 1150, end: 1450, dur: .09, wave: 'sine' },
  enter: { f: 392, end: 784, dur: .3, wave: 'triangle', notes: [392, 523.25, 784] },
  notify: { f: 740, end: 988, dur: .24, wave: 'sine', notes: [740, 988] },
  found: { f: 523.25, end: 1046.5, dur: .34, wave: 'triangle', notes: [523.25, 659.25, 783.99, 1046.5] },
  room: { f: 440, end: 660, dur: .18, wave: 'sine', notes: [440, 554.37, 659.25] },
  transaction: { f: 523.25, end: 880, dur: .28, wave: 'sine', notes: [523.25, 659.25, 880] },
  message: { f: 690, end: 900, dur: .11, wave: 'sine' },
  warning: { f: 520, end: 360, dur: .28, wave: 'triangle', notes: [520, 360] },
  restored: { f: 392, end: 783.99, dur: .32, wave: 'sine', notes: [392, 523.25, 783.99] },
  shuffle: { f: 420, end: 1150, dur: .38, wave: 'noise' },
  deal: { f: 1250, end: 520, dur: .105, wave: 'noise' },
  pick: { f: 580, end: 850, dur: .07, wave: 'sine' },
  place: { f: 760, end: 460, dur: .1, wave: 'noise' },
  submit: { f: 440, end: 880, dur: .27, wave: 'triangle', notes: [440, 587.33, 880] },
  tick: { f: 900, end: 900, dur: .055, wave: 'square' },
  reveal: { f: 360, end: 1000, dur: .23, wave: 'noise' },
  win: { f: 523.25, end: 1046.5, dur: .38, wave: 'sine', notes: [523.25, 659.25, 783.99, 1046.5] },
  loss: { f: 440, end: 220, dur: .36, wave: 'triangle', notes: [440, 349.23, 261.63] },
  draw: { f: 440, end: 554.37, dur: .24, wave: 'sine', notes: [440, 554.37] },
  special: { f: 659.25, end: 1318.51, dur: .42, wave: 'triangle', notes: [659.25, 783.99, 987.77, 1318.51] },
  slam: { f: 110, end: 880, dur: .58, wave: 'noise', notes: [110, 220, 440, 880] },
  sweep: { f: 392, end: 1568, dur: .8, wave: 'triangle', notes: [392, 523.25, 659.25, 783.99, 1046.5, 1568] },
  foul: { f: 500, end: 135, dur: .38, wave: 'square', notes: [500, 320, 135] },
};
const keyProfile = {
  'ui-tap':'tap','ui-back':'back','ui-open':'open','ui-close':'close','ui-select':'select','ui-toggle':'toggle',
  'ui-confirm':'confirm','ui-error':'error','ui-copy':'copy','ui-enter-game':'enter','notification':'notify',
  'match-found':'found','room-join':'room','room-ready':'confirm','transaction-ok':'transaction','message-send':'message',
  'message-received':'notify','connection-warning':'warning','connection-restored':'restored','card-shuffle':'shuffle',
  'card-deal':'deal','card-pick':'pick','card-place':'place','hand-submit':'submit','timer-tick':'tick',
  'card-reveal':'reveal','compare-win':'win','compare-loss':'loss','compare-draw':'draw','special-score':'special',
  'slam':'slam','full-sweep':'sweep','foul':'foul','special-hand':'special','round-win':'win','round-loss':'loss',
};

function waveValue(kind, phase, noise) {
  if (kind === 'square') return Math.sign(Math.sin(phase));
  if (kind === 'triangle') return (2 / Math.PI) * Math.asin(Math.sin(phase));
  if (kind === 'noise') return noise;
  return Math.sin(phase);
}

function render(profile, seed) {
  const count = Math.ceil(profile.dur * sampleRate);
  const samples = Buffer.alloc(count * 2);
  let phase = 0;
  let rng = seed >>> 0;
  const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return (rng / 0x80000000) - 1; };
  const notes = profile.notes ?? [profile.f];
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    const progress = t / profile.dur;
    const notePos = progress * notes.length;
    const noteIndex = Math.min(notes.length - 1, Math.floor(notePos));
    const noteFrac = notePos - noteIndex;
    const next = notes[Math.min(notes.length - 1, noteIndex + 1)];
    const freq = notes[noteIndex] + (next - notes[noteIndex]) * noteFrac;
    phase += 2 * Math.PI * freq / sampleRate;
    const attack = Math.min(1, t / .008);
    const release = Math.min(1, (profile.dur - t) / Math.min(.075, profile.dur * .4));
    const decay = Math.exp(-t * (profile.wave === 'noise' ? 5 : 3.8));
    const env = Math.max(0, attack * release * decay);
    let value = waveValue(profile.wave, phase, rand());
    if (profile.wave === 'noise') value = value * .65 + Math.sin(phase) * .35;
    // Brief metallic overtone gives the placeholders a light electronic/game UI character.
    value = (value + Math.sin(phase * 2.01) * .18) * env * .28;
    samples.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
  }
  return samples;
}

function wav(samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

await mkdir(output, { recursive: true });
const manifest = [];
for (let i = 0; i < sounds.length; i++) {
  const id = sounds[i];
  const wavPath = path.join(output, `${id}.wav`);
  const webmPath = path.join(output, `${id}.webm`);
  const pcm = render(profiles[keyProfile[id]], 0x51A0 + i);
  await writeFile(wavPath, wav(pcm));
  const encoded = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-i',wavPath,'-c:a','libopus','-b:a','32k','-application','audio','-vbr','on',webmPath], { encoding: 'utf8' });
  if (encoded.status !== 0) throw new Error(`ffmpeg failed for ${id}: ${encoded.stderr}`);
  manifest.push({ id, placeholder: true, source: `assets/audio/placeholders/${id}.wav`, runtime: `assets/audio/placeholders/${id}.webm`, codec: 'Opus', channels: 1, sample_rate: sampleRate, duration_seconds: Number((pcm.length / 2 / sampleRate).toFixed(3)), replace_with_ai_final: true });
}
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify({ type: 'temporary-electronic-placeholders', generated_by: 'tools/audio-placeholders/generate.mjs', sounds: manifest }, null, 2)}\n`);
await writeFile(path.join(output, 'README.md'), `# 临时电子音占位素材\n\n由内置 Node.js 合成脚本生成，不调用 AI 服务或外部素材。所有文件都是临时占位音，不代表最终美术/声音风格。\n\n- ${sounds.length} 个音效 ID 与 docs/07_assets/游戏音效设计与资源清单.md 对齐。\n- WAV 为 48 kHz、单声道、16-bit PCM；WebM 为 32 kbps Opus，供快速集成测试。\n- 重新生成：在仓库根目录运行 node tools/audio-placeholders/generate.mjs（需要本机 ffmpeg 支持 libopus）。\n- 最终 AI 音效制作完成后按相同 ID 替换，并更新清单/哈希；不要把占位音当成最终发布素材。\n`);
console.log(`Generated ${sounds.length} temporary electronic placeholders at ${path.relative(root, output)}`);

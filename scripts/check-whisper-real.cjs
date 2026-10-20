// 用打包进软件的真 whisper.cpp 和模型，从中文文件夹里识别一段中文录音（和装在「AI短剧助手」里时一样）。
// Windows 的 whisper-cli 是 MSVC 编译的，把路径当 UTF-8，中文 Windows 传 GBK：以前装好后本地字幕识别必失败。
// 没有打包好的组件时跳过；打包机上设 REQUIRE_WHISPER=1 必须跑。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const whisper = require('../src/native/whisper');
const { runtime } = require('../src/native/video-structure/runtime');

const root = path.resolve(__dirname, '..');
const found = whisper.checkWhisper({ projectRoot: root });
const speechDir = path.join(runtime({}).models, 'sherpa-onnx-paraformer-zh-small-2024-03-09', 'test_wavs');
const sample = fs.existsSync(speechDir) ? fs.readdirSync(speechDir).find((name) => name.endsWith('.wav')) : null;
if (!found.available || !sample) {
  if (process.env.REQUIRE_WHISPER === '1') {
    console.error(
      `whisper.cpp or the speech sample is missing: ${JSON.stringify(found).slice(0, 300)} sample=${sample}`,
    );
    process.exit(1);
  }
  console.log('SKIP real whisper (bundled whisper.cpp or speech sample not here)');
  process.exit(0);
}

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-real-'));
  const install = path.join(base, 'AI短剧助手', 'resources', 'models');
  const episode = path.join(base, '真千金驭夫入局', '原剧');
  fs.mkdirSync(install, { recursive: true });
  fs.mkdirSync(episode, { recursive: true });
  const model = path.join(install, path.basename(found.modelPath));
  fs.copyFileSync(found.modelPath, model);
  const audio = path.join(episode, '第001集音频.wav');
  fs.copyFileSync(path.join(speechDir, sample), audio);
  const started = Date.now();
  const text = await whisper.transcribeAudio(
    audio,
    { language: 'zh' },
    { projectRoot: root, whisper_model_path: model, whisper_binary_path: found.binaryPath },
  );
  assert.ok(text && text.trim().length > 0, 'recognised some text');
  console.log(
    `PASS real whisper on ${process.platform} with Chinese model and audio paths (${Math.round((Date.now() - started) / 1000)} s): ${text.slice(0, 40)}`,
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

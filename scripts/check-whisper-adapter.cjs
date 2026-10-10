// Offline adapter check. Uses a tiny fake whisper.cpp executable; no network
// and no real model are required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { transcribeAudio, checkWhisper, cleanTranscript } = require('../src/native/whisper');

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hongguo-whisper-check-'));
  try {
    const model = path.join(root, 'ggml-tiny.bin');
    await fsp.writeFile(model, Buffer.alloc(4096, 1));
    const fakeScript = path.join(root, 'fake-whisper.js');
    await fsp.writeFile(fakeScript, String.raw`const fs = require('node:fs');
const args = process.argv.slice(2);
const i = args.indexOf('-of');
const prefix = i >= 0 ? args[i + 1] : '';
if (prefix) fs.writeFileSync(prefix + '.txt', '[00:00:00.000 --> 00:00:01.000]\n你好，这是本地识别。\n');
process.stdout.write('system_info: fake\n');
`);
    const fake = path.join(root, process.platform === 'win32' ? 'whisper-cli.cmd' : 'whisper-cli');
    const fakeContent = process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-whisper.js" %*\r\n`
      : String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const i = args.indexOf('-of');
const prefix = i >= 0 ? args[i + 1] : '';
if (prefix) fs.writeFileSync(prefix + '.txt', '[00:00:00.000 --> 00:00:01.000]\n你好，这是本地识别。\n');
process.stdout.write('system_info: fake\n');
`;
    await fsp.writeFile(fake, fakeContent, { mode: 0o755 });
    const audio = path.join(root, 'audio.wav');
    await fsp.writeFile(audio, Buffer.alloc(4096, 2));

    const status = checkWhisper({ whisper_binary_path: fake, whisper_model_path: model, projectRoot: root });
    assert.equal(status.available, true);
    const text = await transcribeAudio(audio, { language: 'zh' }, { whisper_binary_path: fake, whisper_model_path: model, projectRoot: root });
    assert.equal(text, '你好，这是本地识别。');
    assert.equal(cleanTranscript('[00:01.000 --> 00:02.000] 台词'), '台词');

    const missing = checkWhisper({ projectRoot: path.join(root, 'missing') });
    assert.equal(missing.available, false);
    assert.ok(missing.message.includes('不会自动调用 OpenAI'));
    console.log('PASS whisper adapter local execution and missing-resource guard');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

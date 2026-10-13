const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prepareRuntime, transcribeToSrt } = require('../src/native/faster-whisper');
const { parseSrt } = require('../src/native/srt');

function selfTest(runtime, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.command, ['--self-test', '--model', runtime.modelPath, '--device', 'cpu', '--compute-type', 'int8', '--local-files-only'], { env, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), '红果 subtitle offline '));
  const previousEnv = { ...process.env };
  try {
    const suppliedResources = process.argv[2] && path.resolve(process.argv[2]);
    const resources = path.join(temporary, 'Resources');
    // Moving it out of the build tree catches links to a development venv/cache.
    await fs.mkdir(resources);
    await fs.cp(suppliedResources ? path.join(suppliedResources, 'faster-whisper') : path.join(root, 'build/faster-whisper', `${process.platform}-${process.arch}`), path.join(resources, 'faster-whisper'), { recursive: true, verbatimSymlinks: true });
    process.env.PATH = path.join(temporary, 'no-system-python');
    process.env.HF_HOME = path.join(temporary, 'empty-model-cache');
    process.env.HF_HUB_OFFLINE = '1';
    process.env.TRANSFORMERS_OFFLINE = '1';
    process.env.PYTHONHOME = path.join(temporary, 'invalid-python-home');
    process.env.PYTHONPATH = path.join(temporary, 'invalid-python-path');
    const runtime = await prepareRuntime({ resourcesPath: resources, isPackaged: true, faster_whisper_device: 'cpu', faster_whisper_python_path: 'never-run-system-python', faster_whisper_model: 'medium' });
    assert.equal(runtime.bundled, true);
    assert.equal(runtime.model, 'tiny');
    assert.ok((await selfTest(runtime, process.env)).includes('"ok": true'));
    if (process.argv[3]) {
      const result = await transcribeToSrt(path.resolve(process.argv[3]), path.join(temporary, '完整字幕.srt'), runtime, { onProgress: info => console.log(`progress ${info.progress}%`) });
      const entries = parseSrt(await fs.readFile(result.outputPath, 'utf8'));
      assert.ok(entries.length > 0);
      console.log(`Recognized ${entries.length} timed cues: ${entries.map(entry => entry.text).join(' ')}`);
    }
    await fs.rename(runtime.modelPath, `${runtime.modelPath}-missing`);
    await assert.rejects(() => prepareRuntime({ resourcesPath: resources, isPackaged: true }), /内置字幕引擎或模型缺失/);
    console.log('PASS relocated bundled ASR + VAD, empty PATH/model cache, no Python installation or model download, missing-resource guard');
  } finally {
    process.env = previousEnv;
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

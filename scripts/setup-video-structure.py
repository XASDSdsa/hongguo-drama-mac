#!/usr/bin/env python3
"""Build-machine setup. The desktop app never installs Python or packages."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TARGET = ('win32-x64' if sys.platform == 'win32' else 'darwin-arm64' if sys.platform == 'darwin' and platform.machine() == 'arm64' else 'unsupported')
if TARGET == 'unsupported':
    raise SystemExit('This build script supports Windows x64 and Apple Silicon macOS')
DEST = ROOT / 'build/video-structure' / TARGET
CACHE = ROOT / '.cache/video-structure/assets'
REVISION = '85cef72af9a916bdfd7cc94a670c9cdfbf12d1ed'
VERSION = '1.13.8'

def fetch(url, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_file() and output.stat().st_size > 200:
        return
    print('Downloading', output.name, flush=True)
    temp = output.with_suffix(output.suffix + '.part')
    with urllib.request.urlopen(url, timeout=60) as response, temp.open('wb') as target:
        shutil.copyfileobj(response, target)
    os.replace(temp, output)

def archive(url, target):
    file = CACHE / url.rsplit('/', 1)[-1]
    fetch(url, file)
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(file) as tar:
        tar.extractall(target, filter='data')

def main():
    DEST.mkdir(parents=True, exist_ok=True)
    models = DEST / 'models'
    models.mkdir(exist_ok=True)
    fetch('https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/UVR-MDX-NET-Inst_HQ_3.onnx', models / 'UVR-MDX-NET-Inst_HQ_3.onnx')
    fetch('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', models / 'silero_vad.onnx')
    model_name = 'sherpa-onnx-paraformer-zh-small-2024-03-09'
    if not (models / model_name / 'model.int8.onnx').exists():
        archive(f'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{model_name}.tar.bz2', models)
    punctuation_name = 'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8'
    if not (models / punctuation_name / 'model.int8.onnx').exists():
        archive(f'https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/{punctuation_name}.tar.bz2', models)
    # The official PyTorch weights are converted from the pinned upstream TF weights.
    weights = models / 'transnetv2.pth'
    if not weights.exists():
        tf_dir = CACHE / 'transnetv2-weights'
        for item in ['saved_model.pb', 'variables/variables.data-00000-of-00001', 'variables/variables.index']:
            fetch(f'https://media.githubusercontent.com/media/soCzech/TransNetV2/{REVISION}/inference/transnetv2-weights/{item}', tf_dir / item)
        convert = CACHE / 'convert_weights.py'
        fetch(f'https://raw.githubusercontent.com/soCzech/TransNetV2/{REVISION}/inference-pytorch/convert_weights.py', convert)
        shutil.copyfile(ROOT / 'src/native/video-structure/vendor/transnetv2_pytorch.py', CACHE / 'transnetv2_pytorch.py')
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--only-binary=:all:', 'tensorflow==2.20.0'], check=True)
        subprocess.run([sys.executable, str(convert), '--tf_weights', str(tf_dir)], cwd=CACHE, check=True)
        shutil.copyfile(CACHE / 'transnetv2-pytorch-weights.pth', weights)
    binary = 'sherpa-onnx-offline-source-separation' + ('.exe' if sys.platform == 'win32' else '')
    if not (DEST / 'bin' / binary).exists():
        suffix = 'win-x64-static-MT-Release-no-tts' if sys.platform == 'win32' else 'osx-arm64-static'
        package = f'sherpa-onnx-v{VERSION}-{suffix}'
        archive(f'https://github.com/k2-fsa/sherpa-onnx/releases/download/v{VERSION}/{package}.tar.bz2', CACHE / 'sherpa')
        source = next((CACHE / 'sherpa').rglob(binary))
        (DEST / 'bin').mkdir(exist_ok=True)
        shutil.copyfile(source, DEST / 'bin' / binary)
        shutil.copymode(source, DEST / 'bin' / binary)
        for library in source.parent.glob('*.dll'):
            shutil.copyfile(library, DEST / 'bin' / library.name)
    expected = {
        punctuation_name + '/model.int8.onnx': '65a3fb9f5ad7bfb96bf69e0dc4481df97f6ee60513c1d94ce981ba6effd524b1',
        'UVR-MDX-NET-Inst_HQ_3.onnx': 'c207b845d51dc1303c543503f6f5a8b596da5d7de97bead77b3e16ec38e8d5b3',
        'silero_vad.onnx': '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
        model_name + '/model.int8.onnx': '3ef6c19369b912f7caf3cef8e545c5ccd1a33d9d7ec792a46668dc41c4b229ec',
        model_name + '/tokens.txt': '4b2d964e18b9cf139b473003b6698fb2ed9a2a5ec55b93daa677b28f578897aa',
    }
    for name, checksum in expected.items():
        with (models / name).open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != checksum:
                raise RuntimeError('Pinned model checksum mismatch: ' + name)
    file_hashes = {}
    for file in sorted(models.rglob('*')):
        if file.is_file() and file.suffix in ('.onnx', '.pth', '.txt'):
            file_hashes[str(file.relative_to(DEST))] = hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
    (DEST / 'runtime.json').write_text(json.dumps(dict(schema_version='1.0.0', sherpa_version=VERSION, transnet_revision=REVISION, paraformer=model_name, files=file_hashes), indent=2), encoding='utf-8')
    print('Models and native source separation ready:', DEST, flush=True)

if __name__ == '__main__':
    main()

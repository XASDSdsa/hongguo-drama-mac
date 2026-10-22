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

def tf_converter_python():
    venv = CACHE / 'tf-convert-venv'
    python = venv / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
    if not python.exists():
        subprocess.run([sys.executable, '-m', 'venv', str(venv)], check=True)
    torch = [str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', 'torch==2.5.1']
    if sys.platform == 'win32':
        torch += ['--index-url', 'https://download.pytorch.org/whl/cpu']
    subprocess.run(torch, check=True)
    subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', 'tensorflow==2.20.0'], check=True)
    return python

LAMA_FILE = 'big-lama-fp16.pt'

def half_lama(source, target):
    import torch
    model = torch.jit.load(str(source), map_location='cpu').eval()
    with torch.no_grad():
        for _, tensor in list(model.named_parameters()) + list(model.named_buffers()):
            if tensor.is_floating_point():
                half = tensor.half()
                # BatchNorm running variances overflow float16: those few stay float32
                if torch.isfinite(half).all() and (half.float() - tensor).abs().max() <= 1e-2 * max(1.0, float(tensor.abs().max())):
                    tensor.data = half
    temp = target.with_name(target.name + '.part')
    torch.jit.save(model, str(temp))
    os.replace(temp, target)

REC_FILE = 'ppocrv3_rec_48x320.onnx'
REC_KEYS = 'ppocrv3_rec_keys.txt'
REC_CONVERT = '''
import sys
import onnx
from onnxsim import simplify
source, target, keys = sys.argv[1:4]
model = onnx.load(source)
chars = next(p.value for p in model.metadata_props if p.key == 'character')
if len(chars.split('\\n')) != 6623:
    raise SystemExit('unexpected character list')
with open(keys, 'w', encoding='utf-8', newline='') as handle:
    handle.write(chars)
fixed, ok = simplify(model, overwrite_input_shapes={'x': [1, 3, 48, 320]})
if not ok:
    raise SystemExit('simplify failed')
onnx.save(fixed, target)
'''

def rec_converter_python():
    """Build-machine tool venv for pinning the recognizer's input shape (onnx / onnxsim are not bundled)."""
    venv = CACHE / 'rec-convert-venv'
    python = venv / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
    if not python.exists():
        subprocess.run([sys.executable, '-m', 'venv', str(venv)], check=True)
    subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', 'onnx==1.23.2', 'onnxsim==0.8.1'], check=True)
    return python

def prepare_recognizer(models):
    """PP-OCRv3 text recognizer (PaddleOCR, Apache-2.0) as shipped in RapidOCR's PyPI package; its input is pinned to
    1x3x48x320 so OpenCV DNN can run it, and its character list is written next to it."""
    import zipfile
    if (models / REC_FILE).exists() and (models / REC_KEYS).exists():
        return
    wheel = CACHE / 'rapidocr_onnxruntime-1.2.3-py3-none-any.whl'
    if not wheel.exists():
        subprocess.run([sys.executable, '-m', 'pip', 'download', '--disable-pip-version-check', '--no-deps', '--only-binary=:all:', 'rapidocr_onnxruntime==1.2.3', '-d', str(CACHE)], check=True)
    if hashlib.file_digest(wheel.open('rb'), 'sha256').hexdigest() != 'c707d3a6eb72d13119afe9602d3cc36d8b2a4a4d74e9575cf1b0e67ed6a27819':
        raise RuntimeError('Pinned package checksum mismatch: rapidocr_onnxruntime 1.2.3')
    source = CACHE / 'ch_PP-OCRv3_rec_infer.onnx'
    source.write_bytes(zipfile.ZipFile(wheel).read('rapidocr_onnxruntime/models/ch_PP-OCRv3_rec_infer.onnx'))
    if hashlib.file_digest(source.open('rb'), 'sha256').hexdigest() != '897a3ededb38fee0dae2c1ccee38241f37df202c9509e3abca02e9217c5ee615':
        raise RuntimeError('Pinned model checksum mismatch: ch_PP-OCRv3_rec_infer.onnx')
    script = CACHE / 'convert_rec.py'
    script.write_text(REC_CONVERT, encoding='utf-8')
    subprocess.run([str(rec_converter_python()), str(script), str(source), str(models / REC_FILE), str(models / REC_KEYS)], check=True)

def main():
    DEST.mkdir(parents=True, exist_ok=True)
    models = DEST / 'models'
    models.mkdir(exist_ok=True)
    fetch('https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/UVR-MDX-NET-Inst_HQ_3.onnx', models / 'UVR-MDX-NET-Inst_HQ_3.onnx')
    fetch('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', models / 'silero_vad.onnx')
    # LaMa (big-lama, Apache-2.0) TorchScript export published by the IOPaint project: removes burned-in
    # subtitles from storyboard keyframes on the user's machine. The pinned download is verified, then its
    # weights are stored as float16 (half the installer size; loaded back as float32, output differs by
    # about 0.1/255). The Windows installer must stay under GitHub's 2 GiB asset limit.
    lama_source = CACHE / 'big-lama.pt'
    fetch('https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt', lama_source)
    if hashlib.file_digest(lama_source.open('rb'), 'sha256').hexdigest() != '344c77bbcb158f17dd143070d1e789f38a66c04202311ae3a258ef66667a9ea9':
        raise RuntimeError('Pinned model checksum mismatch: big-lama.pt')
    if not (models / LAMA_FILE).exists():
        half_lama(lama_source, models / LAMA_FILE)
    # PP-OCRv3 text detector (PaddleOCR, Apache-2.0) as published in the OpenCV model zoo for cv2.dnn: storyboard
    # keyframes are scanned for text anywhere in the frame (subtitles wherever they sit, name cards, vertical captions).
    fetch('https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/text_detection_ppocr/text_detection_cn_ppocrv3_2023may.onnx', models / 'text_detection_cn_ppocrv3_2023may.onnx')
    prepare_recognizer(models)
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
        # TensorFlow is only used to convert the pinned weights. Installing it in
        # the freeze environment upgrades numpy to a macOS 14 wheel and fails the
        # macOS 13 packaging check.
        convert_python = tf_converter_python()
        subprocess.run([str(convert_python), str(convert), '--tf_weights', str(tf_dir)], cwd=CACHE, check=True)
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
        'text_detection_cn_ppocrv3_2023may.onnx': '03f550c6b406fda8bf54bd8327815f6c7e2edd98cea02348c93d879254366587',
        model_name + '/model.int8.onnx': '3ef6c19369b912f7caf3cef8e545c5ccd1a33d9d7ec792a46668dc41c4b229ec',
        model_name + '/tokens.txt': '4b2d964e18b9cf139b473003b6698fb2ed9a2a5ec55b93daa677b28f578897aa',
    }
    for name, checksum in expected.items():
        with (models / name).open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != checksum:
                raise RuntimeError('Pinned model checksum mismatch: ' + name)
    file_hashes = {}
    for file in sorted(models.rglob('*')):
        if file.is_file() and file.suffix in ('.onnx', '.pth', '.pt', '.txt'):
            file_hashes[str(file.relative_to(DEST))] = hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
    (DEST / 'runtime.json').write_text(json.dumps(dict(schema_version='1.0.0', sherpa_version=VERSION, transnet_revision=REVISION, paraformer=model_name, files=file_hashes), indent=2), encoding='utf-8')
    print('Models and native source separation ready:', DEST, flush=True)

if __name__ == '__main__':
    main()

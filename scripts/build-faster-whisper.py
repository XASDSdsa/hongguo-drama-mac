"""Freeze the local subtitle worker and bundle a pinned, offline tiny model."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
MODEL_REPO = 'Systran/faster-whisper-tiny'
MODEL_REVISION = 'd90ca5fe260221311c53c58e660288d3deb8d356'
MODEL_FILES = ('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt', 'README.md')


def digest(file):
    with file.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def check_macos_compatibility(directory):
    from macholib.MachO import MachO
    from macholib.mach_o import LC_BUILD_VERSION, LC_VERSION_MIN_MACOSX

    minimum = 0
    for file in directory.rglob('*'):
        if not file.is_file() or file.is_symlink():
            continue
        with file.open('rb') as handle:
            magic = handle.read(4)
        if magic not in (b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xce\xfa\xed\xfe'):
            continue
        for header in MachO(str(file)).headers:
            if header.header.cputype != 0x0100000C:
                continue
            for load, command, _ in header.commands:
                version = command.minos if load.cmd == LC_BUILD_VERSION else command.version if load.cmd == LC_VERSION_MIN_MACOSX else 0
                minimum = max(minimum, version)
                if version > (13 << 16):
                    raise RuntimeError(f'{file.name} requires macOS {version >> 16}.{(version >> 8) & 255}; build with a Python distribution and wheels supporting macOS 13')
    return f'{minimum >> 16}.{(minimum >> 8) & 255}'


def main():
    target, build_id = sys.argv[1:3]
    output = ROOT / 'build/faster-whisper' / target
    cache = ROOT / '.cache/faster-whisper'
    model = cache / 'models' / MODEL_REVISION
    model.mkdir(parents=True, exist_ok=True)
    # Resolve fixed-revision file hashes on the build machine, never in the app.
    with urllib.request.urlopen(f'https://huggingface.co/api/models/{MODEL_REPO}/tree/{MODEL_REVISION}', timeout=60) as response:
        metadata = {item['path']: item for item in json.load(response)}
    for name in MODEL_FILES:
        file = model / name
        expected = metadata[name].get('lfs', {}).get('oid')
        valid = file.is_file() and file.stat().st_size == metadata[name]['size']
        if valid and expected:
            valid = digest(file) == expected
        if not valid:
            print(f'Downloading pinned tiny model: {name}', flush=True)
            temporary = file.with_suffix(file.suffix + '.download')
            with urllib.request.urlopen(f'https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{name}', timeout=120) as source, temporary.open('wb') as dest:
                shutil.copyfileobj(source, dest)
            if temporary.stat().st_size != metadata[name]['size'] or (expected and digest(temporary) != expected):
                raise RuntimeError(f'Model verification failed: {name}')
            temporary.replace(file)

    subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
                    '--distpath', str(cache / 'dist' / target), '--workpath', str(cache / 'work' / target),
                    str(ROOT / 'scripts/faster-whisper.spec')], cwd=ROOT, check=True)
    frozen = cache / 'dist' / target / 'hongguo-transcribe'
    minimum_macos = check_macos_compatibility(frozen) if sys.platform == 'darwin' else None
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(frozen, output, symlinks=True)
    shutil.copytree(model, output / 'models/tiny')
    licenses = output / 'licenses'
    licenses.mkdir()
    versions = {}
    for dist in importlib.metadata.distributions():
        name = dist.metadata['Name']
        versions[name] = dist.version
        for entry in dist.files or []:
            if any(token in str(entry).lower() for token in ('license', 'copying', 'notice')):
                source = dist.locate_file(entry)
                if source.is_file():
                    destination = licenses / name / str(entry).replace('..', '_')
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
    for file in Path(sys.base_prefix).glob('LICENSE*'):
        if file.is_file():
            shutil.copyfile(file, licenses / ('Python-' + file.name))
    python_license = Path(sys.base_prefix) / f'lib/python{sys.version_info.major}.{sys.version_info.minor}/LICENSE.txt'
    if python_license.is_file():
        shutil.copyfile(python_license, licenses / 'Python-LICENSE.txt')
    (licenses / 'versions.json').write_text(json.dumps(versions, indent=2), encoding='utf8')
    executable = output / ('hongguo-transcribe.exe' if sys.platform == 'win32' else 'hongguo-transcribe')
    env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1', 'TRANSFORMERS_OFFLINE': '1', 'PYTHONNOUSERSITE': '1'}
    # No python/ffmpeg on PATH and no existing model cache are needed by this executable.
    env['PATH'] = str(Path(os.environ['SystemRoot']) / 'System32') if sys.platform == 'win32' else '/usr/bin:/bin'
    env['HF_HOME'] = str(cache / 'empty-hf-home')
    env.pop('PYTHONPATH', None)
    env.pop('PYTHONHOME', None)
    subprocess.run([str(executable), '--self-test', '--model', str(output / 'models/tiny'), '--device', 'cpu', '--compute-type', 'int8', '--local-files-only'], check=True, env=env)
    checksums = {str(p.relative_to(output)).replace('\\', '/'): digest(p) for p in [executable, *(output / 'models/tiny' / name for name in MODEL_FILES)]}
    manifest = {'version': 1, 'buildId': build_id, 'platform': target, 'python': platform.python_version(), 'minimumMacOS': minimum_macos,
                'model': 'tiny', 'modelRevision': MODEL_REVISION, 'offlineSelfTest': True, 'sceneDetectSelfTest': True,
                'sentenceAlignmentSelfTest': True, 'sentenceAlignmentAlgorithm': 'whisper-audio-pause-v4', 'sha256': checksums}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
    print(f'Bundled transcription ready: {output}', flush=True)


if __name__ == '__main__':
    main()

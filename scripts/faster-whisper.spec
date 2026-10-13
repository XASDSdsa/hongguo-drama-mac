from pathlib import Path
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

root = Path(SPECPATH).parent
datas = collect_data_files('faster_whisper')
binaries = []
for package in ('ctranslate2', 'onnxruntime', 'av'):
    binaries += collect_dynamic_libs(package)

if sys.platform == 'win32':
    # These libraries are dynamically loaded, so PE import scanning alone misses them.
    import site
    for site_dir in site.getsitepackages():
        for dll in (Path(site_dir) / 'nvidia').glob('**/*.dll'):
            binaries.append((str(dll), 'cuda'))
    import os
    for name in ('msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'concrt140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'):
        dll = Path(os.environ['SystemRoot']) / 'System32' / name
        if not dll.is_file():
            raise RuntimeError(f'Missing redistributable runtime at build time: {dll}')
        binaries.append((str(dll), '.'))

a = Analysis(
    [str(root / 'src/native/faster_whisper_cli.py')],
    pathex=[str(root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=collect_submodules('av') + collect_submodules('huggingface_hub'),
    excludes=['torch', 'tensorflow', 'transformers', 'matplotlib', 'scipy', 'pandas', 'IPython'],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='hongguo-transcribe',
          console=True, strip=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='hongguo-transcribe')

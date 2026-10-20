from pathlib import Path
from PyInstaller.utils.hooks import collect_dynamic_libs, collect_data_files
root = Path(SPECPATH).parent
packages = ['torch', 'sherpa_onnx', 'cv2']
a = Analysis([str(root / 'src/native/video-structure/runner.py')],
    pathex=[str(root / 'src/native/video-structure')],
    binaries=sum([collect_dynamic_libs(p) for p in packages], []),
    datas=sum([collect_data_files(p) for p in packages], []),
    hiddenimports=['vendor.transnetv2_pytorch'],
    excludes=['tensorflow', 'keras', 'tensorboard', 'IPython', 'matplotlib', 'pandas', 'scipy', 'onnx', 'onnxmltools'],
    noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='structure-worker', console=True, strip=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='structure-worker')

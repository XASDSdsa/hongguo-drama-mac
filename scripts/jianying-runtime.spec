from pathlib import Path
import os
import sys

from PyInstaller.utils.hooks import collect_all, collect_submodules


root = Path(SPECPATH).parent
source = Path(os.environ.get("JIANYING_PYJY_SOURCE", root / ".cache" / "pyJianYingDraft-src-20261015"))
if (source / "pyJianYingDraft").is_dir():
    # The build venv installs the local fork in editable mode.  Add its source
    # directory before collect_all/collect_submodules so PyInstaller can see
    # the real package instead of only the PEP 660 finder shim.
    sys.path.insert(0, str(source))
datas = []
binaries = []
hiddenimports = []
# pyJianYingDraft uses package JSON templates and pymediainfo ships a native
# libmediainfo dylib.  collect_all keeps both available to the one-file
# executable; imageio/numpy are included because GIF material inspection is a
# supported library path even though the normal MP4 workflow does not import
# it eagerly.
for package in ("pyJianYingDraft", "pymediainfo", "imageio", "numpy"):
    try:
        package_datas, package_binaries, package_hidden = collect_all(package)
    except ImportError:
        continue
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden
    hiddenimports += collect_submodules(package)


a = Analysis(
    [str(root / "scripts/jianying-runtime-launcher.py")],
    pathex=[str(root), str(root / "scripts"), str(source)],
    binaries=binaries,
    datas=datas,
    hiddenimports=sorted(set(hiddenimports)),
    excludes=["tkinter", "matplotlib", "scipy", "pandas", "IPython"],
    noarchive=False,
)
pyz = PYZ(a.pure)
if sys.platform == "win32":
    # Windows: one folder (exe + _internal).  No unpacking to %TEMP% on every start and
    # no second worker process that outlives a killed parent.
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="jianying-runtime",
        console=True,
        strip=False,
        upx=False,
    )
    coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="jianying-runtime")
else:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name="jianying-runtime",
        console=True,
        strip=False,
        upx=False,
        onefile=True,
    )

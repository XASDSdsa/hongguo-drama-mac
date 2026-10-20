"""Freeze the Jianying draft adapter and its Python dependencies for macOS.

The generated ``jianying-runtime`` executable accepts the same arguments as
``python SCRIPT.py ...``.  It embeds CPython, pyJianYingDraft, pymediainfo and
imageio, so an installed app does not need Python, pip, or a package download.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def source_root() -> Path | None:
    configured = os.environ.get("JIANYING_PYJY_SOURCE")
    candidates = [Path(configured)] if configured else []
    candidates.append(ROOT / ".cache" / "pyJianYingDraft-src-20261015")
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "pyJianYingDraft").is_dir():
            return candidate.resolve()
    return None


def source_fingerprint(path: Path | None) -> str | None:
    if not path:
        return None
    files = sorted(
        file for file in path.rglob("*")
        if file.is_file() and ".git" not in file.parts and "__pycache__" not in file.parts
    )
    sha = hashlib.sha256()
    for file in files:
        sha.update(str(file.relative_to(path)).encode("utf-8"))
        sha.update(file.read_bytes())
    return sha.hexdigest()


def copy_licenses(output: Path) -> dict[str, str]:
    licenses = output / "licenses"
    licenses.mkdir(parents=True, exist_ok=True)
    versions: dict[str, str] = {}
    wanted = {"pyjianyingdraft", "pymediainfo", "imageio", "pillow", "numpy", "pyinstaller"}
    for distribution in importlib.metadata.distributions():
        name = (distribution.metadata.get("Name") or "").lower()
        if name not in wanted:
            continue
        versions[name] = distribution.version
        for entry in distribution.files or ():
            if not any(token in str(entry).lower() for token in ("license", "copying", "notice")):
                continue
            source = distribution.locate_file(entry)
            if source.is_file():
                target = licenses / name / str(entry).replace("..", "_")
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
    # PyInstaller embeds CPython itself.  Keep the interpreter license next to
    # the third-party notices so the packaged resource remains redistributable.
    for candidate in (
        Path(sys.base_prefix) / "LICENSE.txt",
        Path(sys.base_prefix) / f"lib/python{sys.version_info.major}.{sys.version_info.minor}/LICENSE.txt",
    ):
        if candidate.is_file():
            shutil.copyfile(candidate, licenses / "Python-LICENSE.txt")
            break
    return versions


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: {sys.argv[0]} TARGET BUILD_ID")
    target, build_id = sys.argv[1:]
    windows = target == "win32-x64"
    if windows:
        if sys.platform != "win32" or platform.machine().lower() not in ("amd64", "x86_64"):
            raise SystemExit("win32-x64 Jianying runtime must be built on 64-bit Windows")
    elif target != "darwin-arm64" or sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("Jianying runtime supports Apple Silicon macOS and 64-bit Windows only")

    cache = ROOT / ".cache" / "jianying"
    dist = cache / "dist" / target
    work = cache / "work" / target
    # macOS: one self-contained file.  Windows: a folder (exe + _internal).  A one-file exe on
    # Windows unpacks itself to %TEMP% on every start (slow, often blocked by antivirus) and its
    # real worker is a second process that is orphaned when only the parent is killed.
    executable_name = "jianying-runtime.exe" if windows else "jianying-runtime"
    frozen = (dist / "jianying-runtime" / executable_name) if windows else (dist / "jianying-runtime")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(dist),
            "--workpath",
            str(work),
            str(ROOT / "scripts" / "jianying-runtime.spec"),
        ],
        cwd=ROOT,
        check=True,
    )
    output = ROOT / "build" / "jianying" / target
    if not frozen.is_file():
        raise RuntimeError(f"PyInstaller output missing: {frozen}")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    executable = output / executable_name
    if windows:
        shutil.copytree(frozen.parent, output, dirs_exist_ok=True)
    else:
        shutil.copy2(frozen, executable)
        executable.chmod(executable.stat().st_mode | 0o111)
    versions = copy_licenses(output)
    env = {
        **os.environ,
        "PATH": os.environ.get("SystemRoot", "C:\\Windows") + "\\System32" if windows else "/usr/bin:/bin",
        "PYTHONNOUSERSITE": "1",
        "HF_HUB_OFFLINE": "1",
    }
    for key in ("PYTHONHOME", "PYTHONPATH", "JIANYING_PYJY_SOURCE"):
        env.pop(key, None)
    subprocess.run([str(executable), "--self-test"], check=True, env=env, cwd=ROOT)
    files = {str(path.relative_to(output)): digest(path) for path in output.rglob("*") if path.is_file()}
    source = source_root()
    manifest = {
        "schema_version": "1.0.0",
        "platform": target,
        "buildId": build_id,
        "runtime": executable_name,
        "python": platform.python_version(),
        "sourceCommit": subprocess.check_output(
            ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
        ).strip() if source and (source / ".git").exists() else None,
        "sourceFingerprint": source_fingerprint(source),
        "packages": versions,
        "offlineSelfTest": True,
        "sha256": files,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Bundled Jianying runtime ready: {output}", flush=True)


if __name__ == "__main__":
    main()

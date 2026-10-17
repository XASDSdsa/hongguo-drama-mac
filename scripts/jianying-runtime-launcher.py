#!/usr/bin/env python3
"""Small PyInstaller entry point for the bundled Jianying Python runtime.

The desktop process invokes this executable in the same way it would invoke
``python create-jianying-draft.py ...``.  Keeping the two adapter scripts as
normal files makes their traceback and command-line behaviour easy to inspect,
while the interpreter and pyJianYingDraft stay inside this frozen executable.
"""

from __future__ import annotations

import importlib.metadata
import runpy
import sys
from pathlib import Path

# Import at module load time so PyInstaller follows the package's normal
# imports. The spec adds the checked-out source directory to ``pathex``;
# relying only on the editable-install finder would omit the submodules from
# the frozen executable.
import pyJianYingDraft as _draft_library  # noqa: F401,E402


def _self_test() -> int:
    import imageio  # noqa: F401 - verifies the packaged dependency.
    import pymediainfo
    import pyJianYingDraft as draft

    if not getattr(draft, "ScriptFile", None):
        raise RuntimeError("pyJianYingDraft ScriptFile is not available")
    if not pymediainfo.MediaInfo.can_parse():
        raise RuntimeError("pymediainfo cannot load the bundled libmediainfo")
    versions = {
        name: importlib.metadata.version(name)
        for name in ("pyJianYingDraft", "pymediainfo", "imageio")
    }
    print("Jianying runtime self-test passed", versions)
    return 0


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        return _self_test()
    if len(sys.argv) < 2:
        print(f"usage: {Path(sys.argv[0]).name} SCRIPT.py [ARGS...]", file=sys.stderr)
        return 2

    script = Path(sys.argv[1]).expanduser().resolve()
    if not script.is_file():
        print(f"script not found: {script}", file=sys.stderr)
        return 2
    # runpy does not automatically put the external script directory first.
    # The adapters intentionally remain normal .py files so this keeps imports
    # and relative resources working when launched from an installed app.
    sys.path.insert(0, str(script.parent))
    sys.argv = [str(script), *sys.argv[2:]]
    runpy.run_path(str(script), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

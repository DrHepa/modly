import os
import subprocess
import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]


def test_main_import_succeeds_in_fresh_python_process():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import main; assert main.app is not None; print('ok')",
        ],
        cwd=API_DIR,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().endswith("ok")

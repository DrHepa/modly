#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PYTHON="${MODLY_APP_PYTHON:-$HOME/.config/Modly/venv/bin/python}"

if [[ ! -x "$APP_PYTHON" ]]; then
  printf 'App Python not found at %s\n' "$APP_PYTHON" >&2
  printf 'Set MODLY_APP_PYTHON to a Python interpreter with api dependencies installed.\n' >&2
  exit 1
fi

if ! "$APP_PYTHON" -c 'import pytest' >/dev/null 2>&1; then
  "$APP_PYTHON" -m pip install -r "$ROOT_DIR/api/requirements-test.txt"
fi

exec "$APP_PYTHON" -m pytest "$ROOT_DIR/api/tests" -q "$@"

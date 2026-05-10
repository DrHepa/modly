"""
ExtensionProcess — manages a generator running in an isolated subprocess.

Each extension runs in its own venv via runner.py.
Communication is done via newline-delimited JSON on stdin/stdout.

Interface is intentionally compatible with direct BaseGenerator usage
so GeneratorRegistry can treat both transparently.
"""
import base64
import json
import os
import platform
import queue
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

_RUNNER_PATH = Path(__file__).parent.parent / "runner.py"

# Runtime readiness can legitimately take longer than ordinary control-plane RPCs
# because some extensions perform managed import smoke/setup checks on cold start.
# Keep the timeout bounded so hung subprocesses still fail closed.
_RUNTIME_READINESS_RESPONSE_TIMEOUT_SECONDS = 30.0


def _venv_python(ext_dir: Path) -> Path:
    """Returns the path to the venv's Python executable."""
    if platform.system() == "Windows":
        return ext_dir / "venv" / "Scripts" / "python.exe"
    return ext_dir / "venv" / "bin" / "python"


class ExtensionProcess:
    """
    Wraps an extension subprocess. Presents the same interface as a
    direct generator (load / unload / generate / is_loaded / params_schema).
    """

    def __init__(self, ext_dir: Path, manifest: dict) -> None:
        self.ext_dir       = ext_dir
        self.manifest      = manifest
        self.model_dir     = None   # set by registry after init
        self.outputs_dir   = None   # set by registry after init

        self._proc:         Optional[subprocess.Popen] = None
        self._queue:        queue.Queue                = queue.Queue()
        self._lock:         threading.Lock             = threading.Lock()
        self._request_lock: threading.Lock             = threading.Lock()
        self._loaded:       bool                       = False

        # Mirrors BaseGenerator attributes used by the registry
        self.hf_repo          = manifest.get("hf_repo", "")
        self.hf_skip_prefixes = manifest.get("hf_skip_prefixes", [])
        self.download_check   = manifest.get("download_check", "")
        self._params_schema   = manifest.get("params_schema", [])

        # Public metadata
        self.MODEL_ID     = manifest.get("id", "")
        self.DISPLAY_NAME = manifest.get("name", "")
        self.VRAM_GB      = manifest.get("vram_gb", 0)

    # ------------------------------------------------------------------ #
    # Subprocess lifecycle
    # ------------------------------------------------------------------ #

    def _build_env(self) -> dict:
        from services.generator_registry import MODELS_DIR, WORKSPACE_DIR
        env = os.environ.copy()
        env["EXTENSION_DIR"] = str(self.ext_dir)
        env["MODELS_DIR"]    = str(MODELS_DIR)
        env["WORKSPACE_DIR"] = str(WORKSPACE_DIR)
        env["MODLY_API_DIR"] = str(Path(__file__).parent.parent)
        env["MODEL_ID"] = self.MODEL_ID
        # Pass the exact model_dir so runner.py doesn't have to re-derive it
        # from manifest["id"] (which is the ext_id, not the composite node id).
        if self.model_dir is not None:
            env["MODEL_DIR"] = str(self.model_dir)
        # Extension venvs are based on python-embed which ships without a CA bundle.
        # Only set SSL_CERT_FILE if not already provided (preserves corporate/custom certs).
        if "SSL_CERT_FILE" not in env:
            try:
                import certifi
                env["SSL_CERT_FILE"] = certifi.where()
            except ImportError:
                pass
        return env

    def _start(self) -> None:
        """Launch the subprocess and wait for the 'ready' signal."""
        python = _venv_python(self.ext_dir)
        if not python.exists():
            raise RuntimeError(
                f"[{self.MODEL_ID}] venv not found at {python}. "
                "Run the extension's setup.py first."
            )

        self._proc = subprocess.Popen(
            [str(python), str(_RUNNER_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=self._build_env(),
        )

        # Background thread: read stdout → queue
        reader = threading.Thread(target=self._read_loop, daemon=True)
        reader.start()

        # Background thread: forward stderr to our stderr
        stderr_fwd = threading.Thread(target=self._stderr_loop, daemon=True)
        stderr_fwd.start()

        # Wait for ready — runner sends params_schema in this message
        msg = self._recv(timeout=None)
        if msg.get("type") != "ready":
            self._proc.kill()
            raise RuntimeError(f"[{self.MODEL_ID}] Expected 'ready', got: {msg}")

        # Override params_schema with what the generator class actually declares
        if msg.get("params_schema"):
            self._params_schema = msg["params_schema"]

        print(f"[ExtensionProcess] {self.MODEL_ID} subprocess started (pid {self._proc.pid})")

    def _read_loop(self) -> None:
        """Continuously reads stdout and pushes parsed JSON to the queue."""
        try:
            for line in self._proc.stdout:
                line = line.strip()
                if line:
                    try:
                        self._queue.put(json.loads(line))
                    except json.JSONDecodeError:
                        print(f"[{self.MODEL_ID}] bad JSON: {line}", file=sys.stderr)
        finally:
            self._queue.put(None)  # sentinel: process is done

    def _stderr_loop(self) -> None:
        """Forwards subprocess stderr to the main process stderr."""
        for line in self._proc.stderr:
            print(f"[{self.MODEL_ID}] {line}", end="", file=sys.stderr)

    def _send(self, msg: dict) -> None:
        with self._lock:
            self._proc.stdin.write(json.dumps(msg) + "\n")
            self._proc.stdin.flush()

    def _recv(self, timeout: float | None = 120.0) -> dict:
        try:
            msg = self._queue.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError(f"[{self.MODEL_ID}] No response from subprocess after {timeout}s")
        if msg is None:
            raise RuntimeError(f"[{self.MODEL_ID}] Subprocess died unexpectedly")
        return msg

    def _recv_matching(
        self,
        *,
        expected_types: set[str],
        timeout: float | None,
        ignored_types: set[str] | None = None,
        context: str,
    ) -> dict:
        ignored = ignored_types or set()
        deadline = None if timeout is None else time.monotonic() + timeout

        while True:
            remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
            msg = self._recv(timeout=remaining)
            msg_type = msg.get("type")

            if msg_type in expected_types:
                return msg

            if msg_type in ignored:
                if msg_type == "log":
                    print(f"[{self.MODEL_ID}] {msg.get('message', '')}", file=sys.stderr)
                continue

            raise RuntimeError(f"[{self.MODEL_ID}] Unexpected response to {context}: {msg}")

    def _ensure_started(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            self._start()

    def _get_request_lock(self) -> threading.Lock:
        lock = getattr(self, "_request_lock", None)
        if lock is None:
            lock = threading.Lock()
            self._request_lock = lock
        return lock

    # ------------------------------------------------------------------ #
    # BaseGenerator-compatible interface
    # ------------------------------------------------------------------ #

    def is_downloaded(self) -> bool:
        if self.download_check:
            return (self.model_dir / self.download_check).exists()
        return self.model_dir.exists() and any(self.model_dir.iterdir())

    def is_loaded(self) -> bool:
        return self._loaded and self._proc is not None and self._proc.poll() is None

    def load(self) -> None:
        with self._get_request_lock():
            self._ensure_started()
            self._send({"action": "load"})

            while True:
                msg = self._recv_matching(
                    expected_types={"loaded", "unloaded", "error"},
                    ignored_types={"runtime_readiness", "log"},
                    timeout=None,
                    context="load",
                )
                if msg.get("type") == "unloaded":
                    continue
                if msg.get("type") == "loaded":
                    self._loaded = True
                    return
                raise RuntimeError(msg.get("traceback") or msg.get("message"))

    def unload(self) -> None:
        with self._get_request_lock():
            if self._proc and self._proc.poll() is None:
                try:
                    self._send({"action": "unload"})
                    self._recv(timeout=30.0)
                except Exception:
                    pass
        self._loaded = False

    def generate(
        self,
        image_bytes: bytes,
        params: dict,
        progress_cb: Optional[Callable[[int, str], None]] = None,
        cancel_event: Optional[threading.Event] = None,
    ) -> Path:
        from services.generators.base import GenerationCancelled

        with self._get_request_lock():
            self._ensure_started()
            req_id = str(uuid.uuid4())
            self._send({
                "action":      "generate",
                "id":          req_id,
                "image_b64":   base64.b64encode(image_bytes).decode(),
                "params":      params,
                "outputs_dir": str(self.outputs_dir) if self.outputs_dir else None,
            })

            while True:
                # Check for cancellation
                if cancel_event and cancel_event.is_set():
                    self._send({"action": "cancel", "id": req_id})
                    # Drain until the subprocess acknowledges
                    while True:
                        msg = self._recv(timeout=30.0)
                        msg_id = msg.get("id")
                        msg_type = msg.get("type")
                        if msg_type == "log":
                            print(f"[{self.MODEL_ID}] {msg.get('message', '')}", file=sys.stderr)
                            continue
                        if msg_type in ("runtime_readiness", "loaded", "unloaded"):
                            continue
                        if msg_type in ("cancelled", "done", "error") and msg_id == req_id:
                            raise GenerationCancelled()

                # Poll queue with short timeout so we can re-check cancel_event
                try:
                    msg = self._recv(timeout=0.5)
                except TimeoutError:
                    continue

                t = msg.get("type")
                msg_id = msg.get("id")

                if t in ("runtime_readiness", "loaded", "unloaded"):
                    continue

                if t == "progress" and msg_id == req_id:
                    if progress_cb:
                        progress_cb(msg.get("pct", 0), msg.get("step", ""))

                elif t == "done" and msg_id == req_id:
                    return Path(msg["output_path"])

                elif t == "error" and msg_id == req_id:
                    raise RuntimeError(msg.get("traceback") or msg.get("message", "Unknown error"))

                elif t == "cancelled" and msg_id == req_id:
                    raise GenerationCancelled()

                elif t == "log":
                    print(f"[{self.MODEL_ID}] {msg.get('message', '')}", file=sys.stderr)

    def params_schema(self) -> list:
        return self._params_schema

    def readiness_status(self) -> dict:
        """Read-only optional runtime readiness from the extension runner."""
        with self._get_request_lock():
            self._ensure_started()
            self._send({"action": "runtime_readiness"})
            msg = self._recv_matching(
                expected_types={"runtime_readiness", "error"},
                ignored_types={"loaded", "unloaded", "log"},
                timeout=_RUNTIME_READINESS_RESPONSE_TIMEOUT_SECONDS,
                context="runtime_readiness",
            )
            if msg.get("type") == "runtime_readiness":
                return msg.get("status") or {}
            if msg.get("type") == "error":
                raise RuntimeError(msg.get("message") or "Runtime readiness check failed")
            raise RuntimeError(f"[{self.MODEL_ID}] Unexpected response to runtime_readiness: {msg}")

    def stop(self) -> None:
        """Gracefully shut down the subprocess."""
        with self._get_request_lock():
            if self._proc and self._proc.poll() is None:
                try:
                    self._send({"action": "shutdown"})
                    self._proc.wait(timeout=15)
                except Exception:
                    self._proc.kill()
        self._loaded = False
        self._proc   = None

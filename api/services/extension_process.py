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
import re
import subprocess
import sys
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Optional

from services.generation_inputs import MODLY_WORKSPACE_DIR_ENV
from services.hf_download_assets import hf_download_assets_ready
from services.https_download_assets import https_download_assets_ready
from services.download_check import safe_download_check_exists

_RUNNER_PATH = Path(__file__).parent.parent / "runner.py"
_MISSING_MODULE_RE = re.compile(r"No module named ['\"]([^'\"]+)['\"]")
_AUTO_REPAIR_PACKAGE_MAP = {
    "PIL": "Pillow",
}

# Optional diagnostics may perform slow, read-only cold import checks.
# This bound neither starts a worker nor imposes a model-load deadline.
_RUNTIME_READINESS_RESPONSE_TIMEOUT_SECONDS = 30.0


class RuntimeReadinessUnavailable(RuntimeError):
    """Host-authored diagnostic state, safe to expose without exception text."""
    def __init__(self, machine_code: str, reason: str):
        super().__init__(reason)
        self.machine_code = machine_code
        self.reason = reason


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
        self.shared_model_dirs: dict[str, Path] = {}

        self._proc:   Optional[subprocess.Popen] = None
        self._queue:  queue.Queue                = queue.Queue()
        self._lock:   threading.Lock             = threading.Lock()
        self._loaded: bool                       = False
        # Order: invocation -> readiness state; neither is held by stop().
        # The write lock protects only stdin, not the reply queue's owner.
        self._invocation_lock = threading.Lock()
        self._readiness_lock = threading.Lock()
        self._readiness_pending = None
        self._runtime_revision = 0
        self._readiness_timeout = _RUNTIME_READINESS_RESPONSE_TIMEOUT_SECONDS

        # Mirrors BaseGenerator attributes used by the registry
        self.input            = manifest.get("input", "image")
        self.hf_repo          = manifest.get("hf_repo", "")
        self.hf_downloads      = manifest.get("hf_downloads", [])
        self.https_downloads   = manifest.get("https_downloads", [])
        self.hf_skip_prefixes = manifest.get("hf_skip_prefixes", [])
        self.hf_include_prefixes = manifest.get("hf_include_prefixes", [])
        self.download_check   = manifest.get("download_check", "")
        self._params_schema   = manifest.get("params_schema", [])

        # Public metadata
        self.MODEL_ID     = manifest.get("id", "")
        self.model_id     = self.MODEL_ID
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
        env[MODLY_WORKSPACE_DIR_ENV] = str(WORKSPACE_DIR.resolve())
        env["MODLY_API_DIR"] = str(Path(__file__).parent.parent)
        # Lets extensions call back into the Modly API (e.g. /llm/chat for the shared LLM).
        env.setdefault("MODLY_API_URL", "http://127.0.0.1:8765")
        # Force the worker's Python stdio to UTF-8 so it matches the UTF-8
        # pipe readers below regardless of the OS locale (cp1252/cp932).
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        if sys.platform == "darwin":
            env.setdefault("NUMBA_DISABLE_JIT", "1")
            # Must be set before the subprocess's first `import torch` — PyTorch
            # reads this once to decide whether MPS ops with no Metal kernel
            # (e.g. 3D pooling) fall back to CPU or raise NotImplementedError.
            # Setting it inside generator.py is too late, since generator.py
            # itself imports torch before calling select_device().
            env.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        # Keep capability identity separate from storage identity. MODEL_DIR
        # retains its node-private meaning; shared roots are passed explicitly.
        if self.model_dir is not None:
            env["MODEL_DIR"] = str(self.model_dir)
        env["MODEL_ID"] = self.MODEL_ID
        env["MODEL_NODE_ID"] = self.manifest.get(
            "node_id", self.MODEL_ID.split("/", 1)[-1]
        )
        env["SHARED_MODEL_DIRS"] = json.dumps(
            {group_id: str(path) for group_id, path in self.shared_model_dirs.items()}
        )
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

        for attempt in range(3):
            # Use a fresh queue per subprocess lifetime so late messages from an
            # older reader thread cannot poison startup for the new process.
            run_queue: queue.Queue = queue.Queue()
            self._queue = run_queue
            self._proc = subprocess.Popen(
                [str(python), str(_RUNNER_PATH)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                # Without these, text=True decodes with the locale codec — cp1252
                # on Windows. tqdm draws its partial blocks with U+258D/U+258F,
                # whose UTF-8 bytes (0x8d/0x8f) are undefined there: the decode
                # raises, _stderr_loop dies, nobody drains the pipe, and the
                # child blocks forever on write once it fills. errors="replace"
                # keeps a stray non-UTF-8 byte from resurrecting that failure.
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=self._build_env(),
            )
            self._runtime_revision += 1

            # Background thread: read stdout → queue
            reader = threading.Thread(target=self._read_loop, args=(self._proc, run_queue), daemon=True)
            reader.start()

            # Background thread: forward stderr to our stderr
            stderr_fwd = threading.Thread(target=self._stderr_loop, args=(self._proc,), daemon=True)
            stderr_fwd.start()

            # Wait for ready — runner sends params_schema in this message
            msg = self._recv(timeout=None)
            if msg.get("type") == "ready":
                # Use runtime schema only when the node manifest does not declare one.
                if msg.get("params_schema") and not self._params_schema:
                    self._params_schema = msg["params_schema"]

                print(f"[ExtensionProcess] {self.MODEL_ID} subprocess started (pid {self._proc.pid})")
                return

            self._proc.kill()
            self._proc.wait()
            missing_module = self._extract_missing_module(msg)
            package_name = self._resolve_auto_repair_package(missing_module) if missing_module else None
            if package_name and attempt < 2:
                self._install_missing_package(python, missing_module, package_name)
                continue

            raise RuntimeError(f"[{self.MODEL_ID}] Expected 'ready', got: {msg}")

    def _extract_missing_module(self, msg: dict) -> Optional[str]:
        """Returns missing import name from a runner error payload, if present."""
        blob = f"{msg.get('message', '')}\n{msg.get('traceback', '')}"
        match = _MISSING_MODULE_RE.search(blob)
        return match.group(1) if match else None

    def _resolve_auto_repair_package(self, module_name: str) -> Optional[str]:
        """
        Maps a missing import name to a pip package for safe auto-repair.

        Important: do not guess package names for arbitrary missing modules,
        because that can install wrong packages and break environments.
        """
        if module_name in _AUTO_REPAIR_PACKAGE_MAP:
            return _AUTO_REPAIR_PACKAGE_MAP[module_name]
        root = module_name.split(".")[0]
        return _AUTO_REPAIR_PACKAGE_MAP.get(root)

    def _install_missing_package(self, python: Path, module_name: str, package_name: str) -> None:
        """Best-effort auto-repair for a known missing import in extension venv."""
        print(
            f"[ExtensionProcess] {self.MODEL_ID} missing module '{module_name}' "
            f"-> installing '{package_name}'"
        )
        try:
            subprocess.run(
                [str(python), "-m", "pip", "install", package_name],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.CalledProcessError as exc:
            details = (exc.stderr or exc.stdout or "").strip()
            raise RuntimeError(
                f"[{self.MODEL_ID}] Auto-repair failed while installing '{package_name}' "
                f"for missing module '{module_name}'.\n{details[-2000:]}"
            ) from exc

    def _read_loop(self, proc: subprocess.Popen, msg_queue: queue.Queue) -> None:
        """Continuously reads stdout and pushes parsed JSON to the queue."""
        try:
            for line in proc.stdout:
                line = line.strip()
                if line:
                    try:
                        message = json.loads(line)
                        if not self._route_readiness_reply(proc, message):
                            msg_queue.put(message)
                    except json.JSONDecodeError:
                        print(f"[{self.MODEL_ID}] {line}", file=sys.stderr)
        finally:
            if self._proc is proc:
                self._runtime_revision += 1
            self._finish_readiness(proc)
            msg_queue.put(None)  # sentinel: process is done

    def _route_readiness_reply(self, proc, message: dict) -> bool:
        """Keep diagnostic replies (including late errors) out of model RPCs."""
        request_id = message.get("id")
        if not (message.get("type") == "runtime_readiness" or
                isinstance(request_id, str) and request_id.startswith("readiness:")):
            return False
        with self._readiness_lock:
            pending = self._readiness_pending
            if pending and pending[0] is proc and pending[1] == request_id:
                self._readiness_pending = None
                pending[2].put(message)
        return True

    def _finish_readiness(self, proc) -> None:
        with self._readiness_lock:
            pending = self._readiness_pending
            if pending and pending[0] is proc:
                self._readiness_pending = None
                pending[2].put(None)

    @contextmanager
    def _model_invocation(self):
        # Serialize model RPCs through both send and receive.
        with self._invocation_lock:
            self._runtime_revision += 1
            try:
                yield
            finally:
                self._runtime_revision += 1

    def _stderr_loop(self, proc: subprocess.Popen) -> None:
        """Forward subprocess stderr to the main process stderr, emitting
        one line every time we see EITHER '\\n' or '\\r'. tqdm writes live
        progress updates with '\\r' only, so a newline-only iterator would
        buffer every tick until the loop exits with '\\n' — which is why
        the HUD's log pane went dark during multi-minute volume decode.

        No per-line extension-id prefix: the HUD log pane is a single
        truncated line, and eating 20 characters with "[modly-hy3d2-mac] "
        hides the tail of the tqdm bar the user actually wants to read.
        """
        stream = proc.stderr
        if stream is None:
            return
        buf = []
        while True:
            ch = stream.read(1)
            if not ch:
                if buf:
                    print(''.join(buf), file=sys.stderr, flush=True)
                return
            if ch in ("\r", "\n"):
                if buf:
                    print(''.join(buf), file=sys.stderr, flush=True)
                    buf = []
            else:
                buf.append(ch)

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

    def _ensure_started(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            self._start()

    # ------------------------------------------------------------------ #
    # BaseGenerator-compatible interface
    # ------------------------------------------------------------------ #

    def is_downloaded(self) -> bool:
        if self.https_downloads:
            if not https_download_assets_ready(
                self.model_dir,
                self.model_id,
                self.https_downloads,
            ):
                return False
        if self.hf_downloads:
            return hf_download_assets_ready(self.model_dir, self.hf_downloads)
        if self.https_downloads:
            return True
        if self.download_check:
            import os
            if self.model_dir.is_symlink() or not isinstance(self.download_check, str) or Path(self.download_check).is_absolute() or "\\" in self.download_check:
                return False
            # Inspect raw descendants before normalization can erase a symlink
            # with '..'; parent traversal remains confined to the extension root.
            check_root = self.model_dir.parent if "/" in self.model_id else self.model_dir
            current = self.model_dir
            try:
                for part in Path(self.download_check).parts:
                    if part == "..":
                        if current == check_root:
                            return False
                        current = current.parent
                    else:
                        current = current / part
                        if current.is_symlink():
                            return False
            except (OSError, RuntimeError):
                return False
            if "/" in self.model_id:
                check = os.path.normpath(f"{self.model_dir.name}/{self.download_check}").replace(os.sep, "/")
                return safe_download_check_exists(self.model_dir.parent, check)
            return safe_download_check_exists(self.model_dir, self.download_check)
        return self.model_dir.exists() and any(self.model_dir.iterdir())

    def is_loaded(self) -> bool:
        return self._loaded and self._proc is not None and self._proc.poll() is None

    def load(self) -> None:
        with self._model_invocation():
            self._loaded = False
            self._ensure_started()
            proc = self._proc
            self._send({"action": "load"})

            while True:
                msg = self._recv(timeout=None)  # model load can be arbitrarily slow
                # A cooperative unload may time out before its acknowledgement
                # arrives. Ignore it and stale startup ready; neither confirms
                # this load. Only loaded from the same live worker can do that.
                if msg.get("type") in {"unloaded", "ready"}:
                    continue
                if msg.get("type") == "loaded":
                    if proc is None or self._proc is not proc or proc.poll() is not None:
                        raise RuntimeError(f"[{self.MODEL_ID}] Load worker changed or stopped")
                    self._loaded = True
                    return
                if msg.get("type") == "error":
                    raise RuntimeError(msg.get("traceback") or msg.get("message"))
                raise RuntimeError(f"[{self.MODEL_ID}] Unexpected response to load: {msg}")

    def unload(self) -> None:
        with self._model_invocation():
            if self._proc and self._proc.poll() is None:
                try:
                    self._send({"action": "unload"})
                    self._recv(timeout=30.0)
                except Exception:
                    pass
            self._loaded = False

    def generate(
        self,
        image_bytes,
        params: dict,
        progress_cb: Optional[Callable[[int, str], None]] = None,
        cancel_event: Optional[threading.Event] = None,
    ) -> Path:
        from services.capture_input import TypedModelInput, revalidate_typed_model_input
        if isinstance(image_bytes, TypedModelInput):
            from services.generator_registry import WORKSPACE_DIR
            typed = revalidate_typed_model_input(WORKSPACE_DIR, image_bytes)
            envelope = {"kind": typed.kind, "path": str(typed.path)}
            if typed.kind == "video":
                from services.video_input import video_snapshot_to_dict
                envelope["snapshot"] = video_snapshot_to_dict(typed.snapshot)
            input_payload = {"input": envelope}
        elif isinstance(image_bytes, bytes):
            input_payload = {"image_b64": base64.b64encode(image_bytes).decode()}
        elif isinstance(image_bytes, Path):
            if self.input != "video":
                raise ValueError("File-backed video input requires a video generator.")
            input_payload = {"input": {"kind": "video", "path": str(image_bytes)}}
        else:
            raise TypeError("Generation input must be bytes or a video Path.")
        return self._generate_request(
            input_payload, params, progress_cb, cancel_event,
        )

    def _receive_generation(
        self,
        req_id: str,
        progress_cb: Optional[Callable[[int, str], None]],
        cancel_event: Optional[threading.Event],
    ) -> Path:
        from services.generators.base import GenerationCancelled

        # Grace period after sending a cooperative cancel before hard-killing
        # the subprocess. Long enough to let generators that check cancel_event
        # between steps shut down cleanly, short enough that the user isn't
        # left staring at a stuck UI when the subprocess is blocked inside a
        # native call (octree decode, marching cubes, etc.) that ignores stdin.
        CANCEL_GRACE_SECONDS = 3.0

        cancel_sent_at: Optional[float] = None
        while True:
            # Check for cancellation
            if cancel_event and cancel_event.is_set():
                if cancel_sent_at is None:
                    # First observation of the cancel — ask the subprocess to stop.
                    try:
                        self._send({"action": "cancel", "id": req_id})
                    except Exception:
                        pass
                    import time
                    cancel_sent_at = time.monotonic()
                else:
                    import time
                    if time.monotonic() - cancel_sent_at >= CANCEL_GRACE_SECONDS:
                        # Grace period expired — the subprocess is not
                        # responding (almost certainly stuck in native code).
                        # Hard-kill it and drop our state so the next
                        # generation forces a fresh load.
                        try:
                            if self._proc and self._proc.poll() is None:
                                self._proc.kill()
                                self._proc.wait(timeout=5.0)
                        except Exception:
                            pass
                        self._loaded = False
                        self._proc   = None
                        print(
                            f"[ExtensionProcess] {self.MODEL_ID} subprocess killed "
                            f"after {CANCEL_GRACE_SECONDS}s grace; model will reload on next run",
                            file=sys.stderr,
                        )
                        raise GenerationCancelled()

            # Poll queue with short timeout so we can re-check cancel_event
            try:
                msg = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue

            if msg is None:
                raise RuntimeError(f"[{self.MODEL_ID}] Subprocess died during generation")

            t = msg.get("type")
            if t in ("progress", "done", "error", "cancelled") and msg.get("id") != req_id:
                # A late or foreign generation reply must not settle this
                # request, report progress, or invalidate its loaded model.
                continue

            if t == "progress":
                if progress_cb:
                    progress_cb(msg.get("pct", 0), msg.get("step", ""))

            elif t == "done":
                return Path(msg["output_path"])

            elif t == "error":
                # A failed generation can leave the worker without a model: a
                # lazy texture-setup failure frees the shape pipeline and then
                # raises. The worker reports its post-failure state, so drop
                # our cached flag and let GeneratorRegistry.get_active() reload
                # before the next run rather than reusing a broken worker.
                if msg.get("loaded") is False:
                    self._loaded = False
                if cancel_sent_at is not None:
                    raise GenerationCancelled()
                raise RuntimeError(msg.get("traceback") or msg.get("message", "Unknown error"))

            elif t == "cancelled":
                raise GenerationCancelled()

            elif t == "log":
                print(f"[{self.MODEL_ID}] {msg.get('message', '')}", file=sys.stderr)

    def generate_artifact(
        self,
        input_kind: str,
        artifact_path: Path,
        params: dict,
        progress_cb: Optional[Callable[[int, str], None]] = None,
        cancel_event: Optional[threading.Event] = None,
    ) -> Path:
        """Send a typed artifact envelope to the isolated runner."""
        from services.artifact_input import TypedArtifactInput, revalidate_artifact_input
        from services.generator_registry import WORKSPACE_DIR

        validated = revalidate_artifact_input(
            WORKSPACE_DIR, TypedArtifactInput(kind=input_kind, path=artifact_path)
        )
        return self._generate_request(
            {"input": {"kind": validated.kind, "path": str(validated.path)}},
            params, progress_cb, cancel_event,
        )

    def _generate_request(
        self,
        input_payload: dict,
        params: dict,
        progress_cb: Optional[Callable[[int, str], None]],
        cancel_event: Optional[threading.Event],
    ) -> Path:
        with self._model_invocation():
            req_id = str(uuid.uuid4())
            self._send({
                "action": "generate", "id": req_id, "model_id": self.MODEL_ID,
                **input_payload, "params": params,
                "outputs_dir": str(self.outputs_dir) if self.outputs_dir else None,
            })
            return self._receive_generation(req_id, progress_cb, cancel_event)

    def params_schema(self) -> list:
        return self._params_schema

    def readiness_status(self) -> dict:
        """Probe an already-running worker without preventing normal model use."""
        if self.https_downloads and not https_download_assets_ready(
            self.model_dir,
            self.model_id,
            self.https_downloads,
        ):
            return {
                "ok": False,
                "machine_code": "assets_not_ready",
                "label_hint": "Install model assets",
                "reason": (
                    f"{self.model_id} requires its exact HTTPS asset plan. "
                    "Install or repair the assets from the Models UI."
                ),
            }

        with self._invocation_lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                raise RuntimeReadinessUnavailable("runtime_not_running", "Worker is not running; diagnostics do not start it.")
            request_id = f"readiness:{uuid.uuid4()}"
            replies: queue.Queue = queue.Queue()
            with self._readiness_lock:
                self._readiness_pending = (proc, request_id, replies)
            self._send({"action": "runtime_readiness", "id": request_id})
            try:
                msg = replies.get(timeout=self._readiness_timeout)
            except queue.Empty as exc:
                raise TimeoutError("Runtime readiness check timed out") from exc
            if msg is None or self._proc is not proc or proc.poll() is not None:
                raise RuntimeError("Runtime readiness worker changed")
            if msg.get("type") == "runtime_readiness":
                return msg.get("status") or {}
            raise RuntimeError("Runtime readiness check failed")

    def stop(self) -> None:
        """Hard-stop the subprocess.

        Used by Free Memory / unload_all. Cooperative shutdown was the wrong
        semantics here: torch.mps.empty_cache() does not reliably release
        wired Metal pages, so only process exit actually returns the memory
        to the OS. We SIGKILL, reap the zombie, and drop our refs so the
        next load() starts a fresh subprocess.
        """
        proc = self._proc
        self._runtime_revision += 1
        self._loaded = False
        if proc and proc.poll() is None:
            try:
                proc.kill()
                proc.wait(timeout=5)
            except Exception as exc:
                # Keep the process reference so callers can verify that the
                # worker may still be alive and refuse to mutate its venv.
                self._proc = proc
                raise RuntimeError(
                    f"[{self.MODEL_ID}] Could not stop extension subprocess"
                ) from exc
            if proc.poll() is None:
                self._proc = proc
                raise RuntimeError(
                    f"[{self.MODEL_ID}] Extension subprocess is still running"
                )
        self._proc = None
        self._finish_readiness(proc)
        self._drain_queue()
        # Wake a load/generation consumer even if draining removed the reader's
        # death sentinel. The next subprocess receives its own fresh queue.
        self._queue.put(None)

    def _drain_queue(self) -> None:
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break

"""Job-scoped generator execution ownership.

The HTTP routers and the model registry share this coordinator so cancellation,
model switching, and queued execution all agree on one immutable owner.
"""
from __future__ import annotations

import asyncio
import threading
import uuid
import weakref
from dataclasses import dataclass

from services.generators.base import GenerationCancelled


@dataclass(frozen=True)
class RequestedExecutionTarget:
    model_id: str | None
    generator: object

    @property
    def key(self) -> str:
        return f"generator:{id(self.generator)}"


@dataclass
class ExecutionReservation:
    job_id: str
    token: str
    target: RequestedExecutionTarget
    lock: asyncio.Lock
    cancel_pending: bool = False
    stop_confirmed: bool = False
    cancel_watchdog: asyncio.Task | None = None

    @property
    def generator(self) -> object:
        return self.target.generator

    @property
    def key(self) -> str:
        return self.target.key

    # Compatibility for tests and callers which inspected the old field.  A
    # pending cancellation is deliberately not reported as a completed stop.
    @property
    def stop_requested(self) -> bool:
        return self.stop_confirmed


class GenerationLifecycle:
    def __init__(self) -> None:
        self.tokens: dict[str, str] = {}
        self.targets: dict[str, RequestedExecutionTarget] = {}
        self.reservations: dict[str, ExecutionReservation] = {}
        self._owner_lock = threading.Lock()
        self._locks: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()

    def register(self, job_id: str, model_id: str | None, generator: object) -> str:
        """Freeze the exact generator object requested when the job is created."""
        token = uuid.uuid4().hex
        with self._owner_lock:
            self.tokens[job_id] = token
            self.targets[job_id] = RequestedExecutionTarget(model_id, generator)
        return token

    def forget(self, job_id: str) -> None:
        with self._owner_lock:
            if job_id not in self.reservations:
                self.tokens.pop(job_id, None)
                self.targets.pop(job_id, None)

    def _execution_lock(self, key: str) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        locks = self._locks.setdefault(loop, {})
        return locks.setdefault(key, asyncio.Lock())

    async def reserve(self, job_id: str) -> ExecutionReservation:
        with self._owner_lock:
            token = self.tokens.get(job_id)
            target = self.targets.get(job_id)
        if token is None or target is None:
            raise RuntimeError(f"Generation job {job_id!r} has no frozen execution target")

        lock = self._execution_lock(target.key)
        await lock.acquire()
        reservation = ExecutionReservation(job_id, token, target, lock)
        with self._owner_lock:
            if self.tokens.get(job_id) != token or self.targets.get(job_id) != target:
                lock.release()
                raise GenerationCancelled()
            self.reservations[job_id] = reservation
        return reservation

    def release(self, reservation: ExecutionReservation) -> None:
        with self._owner_lock:
            if self.reservations.get(reservation.job_id) is reservation:
                self.reservations.pop(reservation.job_id, None)
            watchdog = reservation.cancel_watchdog
            reservation.cancel_watchdog = None
        if watchdog is not None and not watchdog.done():
            watchdog.cancel()
        if reservation.lock.locked():
            reservation.lock.release()

    def owned_generator(self, job_id: str) -> object | None:
        with self._owner_lock:
            reservation = self.reservations.get(job_id)
            token = self.tokens.get(job_id)
            if reservation is None or reservation.token != token:
                return None
            return reservation.generator

    def is_generator_reserved(self, generator: object) -> bool:
        with self._owner_lock:
            return any(item.generator is generator for item in self.reservations.values())

    @staticmethod
    def _live_process(generator: object) -> object | None:
        process = getattr(generator, "_proc", None)
        if process is None:
            return None
        try:
            return process if process.poll() is None else None
        except Exception:
            return None

    def _try_stop(self, reservation: ExecutionReservation) -> bool:
        with self._owner_lock:
            if (
                self.reservations.get(reservation.job_id) is not reservation
                or self.tokens.get(reservation.job_id) != reservation.token
            ):
                return False
            generator = reservation.generator
            process = self._live_process(generator)
            if process is None:
                return False

        if hasattr(generator, "stop"):
            generator.stop()
        else:
            process.kill()
        if hasattr(generator, "_loaded"):
            generator._loaded = False
        if hasattr(generator, "_proc"):
            generator._proc = None
        with self._owner_lock:
            if self.reservations.get(reservation.job_id) is reservation:
                reservation.stop_confirmed = True
        return True

    async def _watch_for_spawn(self, reservation: ExecutionReservation) -> None:
        """Honor a cancellation requested before a subprocess becomes visible."""
        try:
            while True:
                with self._owner_lock:
                    current = self.reservations.get(reservation.job_id)
                    if current is not reservation or not reservation.cancel_pending:
                        return
                if self._try_stop(reservation):
                    return
                await asyncio.sleep(0.01)
        except asyncio.CancelledError:
            return

    def request_cancel(self, job_id: str) -> bool:
        """Request cancellation of only the process owned by ``job_id``.

        Returns true only when a live subprocess was actually stopped.  A
        pre-spawn request remains pending and a watchdog stops the process as
        soon as it appears; it is not falsely recorded as completed.
        """
        with self._owner_lock:
            reservation = self.reservations.get(job_id)
            token = self.tokens.get(job_id)
            if reservation is None or reservation.token != token:
                return False
            if reservation.stop_confirmed:
                return True
            reservation.cancel_pending = True
        if self._try_stop(reservation):
            return True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False
        with self._owner_lock:
            if reservation.cancel_watchdog is None or reservation.cancel_watchdog.done():
                reservation.cancel_watchdog = loop.create_task(self._watch_for_spawn(reservation))
        return False

    def clear(self) -> None:
        with self._owner_lock:
            watchdogs = [
                item.cancel_watchdog for item in self.reservations.values()
                if item.cancel_watchdog is not None and not item.cancel_watchdog.done()
            ]
            self.tokens.clear()
            self.targets.clear()
            self.reservations.clear()
            self._locks = weakref.WeakKeyDictionary()
        for watchdog in watchdogs:
            watchdog.cancel()


generation_lifecycle = GenerationLifecycle()

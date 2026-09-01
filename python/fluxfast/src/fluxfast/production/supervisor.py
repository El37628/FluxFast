"""Production lifecycle coordination for FastAPI and Next.js children."""

from __future__ import annotations

import math
import socket
import time
from collections.abc import Callable
from enum import Enum

from .config import ProductionConfig
from .process import ManagedProcess


class SupervisorState(str, Enum):
    """Observable production supervisor lifecycle states."""

    INITIALIZING = "initializing"
    BACKEND_STARTING = "backend_starting"
    BACKEND_READY = "backend_ready"
    FRONTEND_STARTING = "frontend_starting"
    READY = "ready"
    SHUTTING_DOWN = "shutting_down"
    STOPPED = "stopped"
    FAILED = "failed"


class ProductionSupervisorError(RuntimeError):
    """Base error for invalid or failed production supervision."""


class ProductionStartupError(ProductionSupervisorError):
    """Raised when a production child does not become ready."""


class ProductionChildError(ProductionSupervisorError):
    """Raised when a production child exits unexpectedly."""

    def __init__(self, child_name: str, return_code: int) -> None:
        self.child_name = child_name
        self.return_code = return_code
        super().__init__(
            f"{child_name} process exited unexpectedly with status {return_code}"
        )


ReadinessProbe = Callable[[], bool]


class ProductionSupervisor:
    """Start, ready, and monitor one FastAPI and one Next.js child."""

    def __init__(
        self,
        config: ProductionConfig,
        backend: ManagedProcess,
        frontend: ManagedProcess,
        *,
        backend_ready: ReadinessProbe,
        frontend_ready: ReadinessProbe,
        poll_interval: float = 0.05,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not math.isfinite(poll_interval) or poll_interval <= 0:
            raise ProductionSupervisorError(
                "poll_interval must be a finite number greater than 0"
            )

        self.config = config
        self.backend = backend
        self.frontend = frontend
        self.backend_ready = backend_ready
        self.frontend_ready = frontend_ready
        self.poll_interval = poll_interval
        self._monotonic = monotonic
        self._sleep = sleep
        self.state = SupervisorState.INITIALIZING

    def start(self) -> None:
        """Start FastAPI, wait for it, then start and ready Next.js."""

        if self.state != SupervisorState.INITIALIZING:
            raise ProductionSupervisorError(
                f"cannot start production runtime from {self.state.value} state"
            )

        try:
            self.state = SupervisorState.BACKEND_STARTING
            self.backend.start()
            self._wait_until_ready(self.backend, self.backend_ready)
            self.state = SupervisorState.BACKEND_READY

            self.state = SupervisorState.FRONTEND_STARTING
            self.frontend.start()
            self._wait_until_ready(self.frontend, self.frontend_ready)
            self.state = SupervisorState.READY
        except Exception:
            self._fail()
            raise

    def monitor(self) -> None:
        """Block until either ready child exits unexpectedly."""

        if self.state != SupervisorState.READY:
            raise ProductionSupervisorError(
                f"cannot monitor production runtime from {self.state.value} state"
            )

        while True:
            for child in (self.backend, self.frontend):
                return_code = child.poll()
                if return_code is not None:
                    self._fail()
                    raise ProductionChildError(child.name, return_code)
            self._sleep(self.poll_interval)

    def run(self) -> None:
        """Start and monitor the production runtime."""

        self.start()
        self.monitor()

    def shutdown(self) -> None:
        """Request termination of both children in reverse startup order."""

        if self.state == SupervisorState.STOPPED:
            return
        if self.state == SupervisorState.FAILED:
            self._terminate_started_children()
            return

        self.state = SupervisorState.SHUTTING_DOWN
        self._terminate_started_children()
        self.state = SupervisorState.STOPPED

    def _wait_until_ready(
        self,
        child: ManagedProcess,
        readiness_probe: ReadinessProbe,
    ) -> None:
        deadline = self._monotonic() + self.config.startup_timeout
        while True:
            return_code = child.poll()
            if return_code is not None:
                raise ProductionStartupError(
                    f"{child.name} process exited before readiness with status "
                    f"{return_code}"
                )
            if readiness_probe():
                return

            remaining = deadline - self._monotonic()
            if remaining <= 0:
                raise ProductionStartupError(
                    f"{child.name} did not become ready within "
                    f"{self.config.startup_timeout:g} seconds"
                )
            self._sleep(min(self.poll_interval, remaining))

    def _fail(self) -> None:
        self.state = SupervisorState.FAILED
        self._terminate_started_children()

    def _terminate_started_children(self) -> None:
        for child in (self.frontend, self.backend):
            if child.process is not None:
                child.terminate()


def tcp_readiness_probe(
    host: str,
    port: int,
    *,
    connection_timeout: float = 0.2,
) -> ReadinessProbe:
    """Return a small TCP readiness probe for a supervised child."""

    if not math.isfinite(connection_timeout) or connection_timeout <= 0:
        raise ProductionSupervisorError(
            "connection_timeout must be a finite number greater than 0"
        )

    def ready() -> bool:
        try:
            with socket.create_connection((host, port), timeout=connection_timeout):
                return True
        except OSError:
            return False

    return ready

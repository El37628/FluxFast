"""Small, explicit child-process lifecycle support for production supervision."""

from __future__ import annotations

import os
import signal
import subprocess
from collections.abc import Mapping, Sequence
from pathlib import Path


class ManagedProcessError(RuntimeError):
    """Raised when a managed child is used outside its valid lifecycle."""


class ManagedProcess:
    """Own one child process and its isolated descendant process group."""

    def __init__(
        self,
        name: str,
        command: Sequence[str],
        *,
        cwd: Path | None = None,
        environment: Mapping[str, str] | None = None,
    ) -> None:
        if not name.strip():
            raise ManagedProcessError("process name must not be empty")
        if not command:
            raise ManagedProcessError("process command must not be empty")
        if any(not isinstance(argument, str) or not argument for argument in command):
            raise ManagedProcessError(
                "process command arguments must be non-empty strings"
            )

        self.name = name
        self.command = tuple(command)
        self.cwd = cwd
        self.environment = dict(environment) if environment is not None else None
        self.process: subprocess.Popen[bytes] | None = None

    def start(self) -> subprocess.Popen[bytes]:
        """Start the child exactly once with output attached to the parent."""

        if self.process is not None:
            raise ManagedProcessError(f"{self.name} process has already been started")

        kwargs: dict[str, object] = {
            "cwd": self.cwd,
            "env": self.environment,
            "shell": False,
        }
        if os.name == "posix":
            kwargs["start_new_session"] = True
        else:
            kwargs["creationflags"] = getattr(
                subprocess,
                "CREATE_NEW_PROCESS_GROUP",
                0,
            )

        self.process = subprocess.Popen(list(self.command), **kwargs)
        return self.process

    def poll(self) -> int | None:
        """Return the child exit code, or ``None`` while it is running."""

        return self._require_started().poll()

    def wait(self, timeout: float | None = None) -> int:
        """Wait for the child and return its exit code."""

        return self._require_started().wait(timeout=timeout)

    def terminate(self) -> None:
        """Request graceful termination of the child process group."""

        self._signal_process_group(signal.SIGTERM)

    def kill(self) -> None:
        """Forcefully terminate the child process group."""

        kill_signal = getattr(signal, "SIGKILL", signal.SIGTERM)
        self._signal_process_group(kill_signal)

    def _require_started(self) -> subprocess.Popen[bytes]:
        if self.process is None:
            raise ManagedProcessError(f"{self.name} process has not been started")
        return self.process

    def _signal_process_group(self, signum: signal.Signals) -> None:
        process = self._require_started()
        if process.poll() is not None:
            return

        try:
            if os.name == "posix":
                os.killpg(process.pid, signum)
            elif signum == signal.SIGTERM:
                process.terminate()
            else:
                process.kill()
        except ProcessLookupError:
            # The child can exit between poll() and signal delivery.
            return

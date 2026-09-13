"""Internal process-tree cleanup shared by development and production."""

from __future__ import annotations

import os
import signal
import subprocess
import time
from collections.abc import Callable
from weakref import WeakSet

_stopped_trees: WeakSet[subprocess.Popen[bytes]] = WeakSet()


def signal_process_tree(process: subprocess.Popen[bytes], signum: int) -> None:
    if process in _stopped_trees:
        return
    # Each caller creates a new POSIX session. Its descendants still belong to
    # the owned group when the direct child has already exited.
    try:
        if os.name == "posix":
            os.killpg(process.pid, signum)
        elif process.poll() is None:
            if signum == signal.SIGTERM:
                process.terminate()
            else:
                process.kill()
    except ProcessLookupError:
        pass


def _group_exists(process: subprocess.Popen[bytes]) -> bool:
    if os.name != "posix":
        return process.poll() is None
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return False
    return True


def _reap_adopted_descendants(process: subprocess.Popen[bytes]) -> None:
    if os.name != "posix":
        return
    # The direct child was already waited for. When FluxFast is PID 1 (or a
    # subreaper), exited descendants become its children too. Reap only members
    # of this owned group, never unrelated children managed by the application.
    while True:
        try:
            pid, _ = os.waitpid(-process.pid, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def _wait_for_group_exit(
    process: subprocess.Popen[bytes],
    deadline: float,
    monotonic: Callable[[], float],
    sleep: Callable[[float], None],
) -> bool:
    while True:
        _reap_adopted_descendants(process)
        if not _group_exists(process):
            return True
        remaining = deadline - monotonic()
        if remaining <= 0:
            return False
        sleep(min(0.02, remaining))


def stop_process_tree(
    process: subprocess.Popen[bytes],
    timeout: float,
    *,
    kill_timeout: float = 1.0,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    if process in _stopped_trees:
        return
    deadline = monotonic() + timeout
    signal_process_tree(process, signal.SIGTERM)
    direct_child_exited = True
    try:
        process.wait(timeout=max(0.0, deadline - monotonic()))
    except subprocess.TimeoutExpired:
        direct_child_exited = False
    if not direct_child_exited or not _wait_for_group_exit(
        process, deadline, monotonic, sleep
    ):
        signal_process_tree(process, getattr(signal, "SIGKILL", signal.SIGTERM))
        kill_deadline = monotonic() + kill_timeout
        process.wait(timeout=max(0.0, kill_deadline - monotonic()))
        if not _wait_for_group_exit(process, kill_deadline, monotonic, sleep):
            raise subprocess.TimeoutExpired(process.args, kill_timeout)
    _stopped_trees.add(process)

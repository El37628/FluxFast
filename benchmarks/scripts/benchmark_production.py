"""Measure the real FluxFast production lifecycle without timing gates."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import statistics
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
FRONTEND = REPOSITORY_ROOT / "tests" / "browser" / "frontend"
WORKER_COUNTS = (1, 2, 4, 8)
HTTP = build_opener(ProxyHandler({}))


@dataclass(frozen=True, slots=True)
class ProcessSnapshot:
    """One Linux process identity that remains safe across PID reuse."""

    pid: int
    parent_pid: int
    start_time: str
    command: str


@dataclass(frozen=True, slots=True)
class LifecycleMeasurement:
    """One complete start, readiness, and shutdown observation."""

    workers: int
    sample: int
    fastapi_start_ms: float
    fastapi_ready_ms: float
    next_start_ms: float
    public_ready_ms: float
    shutdown_ms: float
    observed_worker_pids: tuple[int, ...]
    peak_descendants: int


class OutputCapture:
    """Timestamp a child process's combined output without blocking probes."""

    def __init__(self, process: subprocess.Popen[str]) -> None:
        if process.stdout is None:
            raise RuntimeError("production benchmark process has no output pipe")
        self._stream = process.stdout
        self._lines: list[tuple[float, str]] = []
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()

    def _read(self) -> None:
        for line in self._stream:
            with self._lock:
                self._lines.append((time.perf_counter(), line.rstrip()))

    def marker_time(self, marker: str) -> float | None:
        with self._lock:
            for observed_at, line in self._lines:
                if marker in line:
                    return observed_at
        return None

    def text(self) -> str:
        with self._lock:
            return "\n".join(line for _observed_at, line in self._lines)

    def server_process_pids(self) -> set[int]:
        """Return deterministic Uvicorn worker identities from attached logs."""

        pattern = re.compile(r"Started server process \[(\d+)\]")
        with self._lock:
            return {
                int(match.group(1))
                for _observed_at, line in self._lines
                if (match := pattern.search(line)) is not None
            }

    def join(self) -> None:
        self._thread.join(timeout=2)


def available_port() -> int:
    """Reserve and return one currently available loopback port."""

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def process_table() -> dict[int, ProcessSnapshot]:
    """Read the Linux process table using only the standard library."""

    processes: dict[int, ProcessSnapshot] = {}
    for directory in Path("/proc").iterdir():
        if not directory.name.isdigit():
            continue
        pid = int(directory.name)
        try:
            stat = (directory / "stat").read_text(encoding="utf8")
            closing = stat.rfind(")")
            fields = stat[closing + 2 :].split()
            parent_pid = int(fields[1])
            start_time = fields[19]
            command = (directory / "cmdline").read_bytes().replace(b"\0", b" ")
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
            continue
        processes[pid] = ProcessSnapshot(
            pid=pid,
            parent_pid=parent_pid,
            start_time=start_time,
            command=command.decode("utf8", errors="replace").strip(),
        )
    return processes


def descendants(
    root_pid: int,
    processes: dict[int, ProcessSnapshot],
) -> dict[int, ProcessSnapshot]:
    """Return every current descendant of ``root_pid``."""

    found: dict[int, ProcessSnapshot] = {}
    parents = {root_pid}
    while parents:
        children = {
            pid: process
            for pid, process in processes.items()
            if process.parent_pid in parents and pid not in found
        }
        if not children:
            break
        found.update(children)
        parents = set(children)
    return found


def identity_is_alive(pid: int, start_time: str) -> bool:
    """Check one captured PID without confusing a later reused PID."""

    process = process_table().get(pid)
    return process is not None and process.start_time == start_time


def listening_ipv4_addresses(port: int) -> set[str]:
    """Return kernel-encoded IPv4 addresses listening on one port."""

    addresses: set[str] = set()
    try:
        lines = Path("/proc/net/tcp").read_text(encoding="ascii").splitlines()[1:]
    except FileNotFoundError as error:
        raise RuntimeError("production benchmark requires Linux /proc") from error
    for line in lines:
        fields = line.split()
        if len(fields) < 4 or fields[3] != "0A":
            continue
        address, encoded_port = fields[1].split(":")
        if int(encoded_port, 16) == port:
            addresses.add(address)
    return addresses


def owned_listening_ipv4_sockets(
    processes: dict[int, ProcessSnapshot],
) -> set[tuple[str, int]]:
    """Return IPv4 TCP listeners owned by the supervised process tree."""

    socket_inodes: set[str] = set()
    for pid in processes:
        try:
            descriptors = (Path("/proc") / str(pid) / "fd").iterdir()
            for descriptor in descriptors:
                try:
                    target = str(descriptor.readlink())
                except (FileNotFoundError, PermissionError, ProcessLookupError):
                    continue
                match = re.fullmatch(r"socket:\[(\d+)\]", target)
                if match is not None:
                    socket_inodes.add(match.group(1))
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue

    listeners: set[tuple[str, int]] = set()
    for line in Path("/proc/net/tcp").read_text(encoding="ascii").splitlines()[1:]:
        fields = line.split()
        if len(fields) < 10 or fields[3] != "0A" or fields[9] not in socket_inodes:
            continue
        address, encoded_port = fields[1].split(":")
        listeners.add((address, int(encoded_port, 16)))
    return listeners


def fetch_json(url: str, *, timeout: float = 0.5) -> tuple[int, Any]:
    """Fetch JSON over a fresh direct connection."""

    request = Request(url, headers={"Connection": "close"})
    with HTTP.open(request, timeout=timeout) as response:
        return response.status, json.loads(response.read())


def port_is_closed(port: int) -> bool:
    """Report whether a loopback TCP port refuses new connections."""

    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
            return False
    except OSError:
        return True


def run_checked(command: list[str]) -> None:
    """Run one benchmark preparation command with inherited output."""

    subprocess.run(command, cwd=REPOSITORY_ROOT, check=True, shell=False)


def prepare_frontend() -> None:
    """Build repository packages and the production frontend once."""

    pnpm = "pnpm.cmd" if os.name == "nt" else "pnpm"
    run_checked([pnpm, "--filter", "@fluxfast/core", "run", "build"])
    run_checked([pnpm, "--filter", "@fluxfast/next", "run", "build"])
    run_checked(
        [
            sys.executable,
            "-m",
            "fluxfast.cli",
            "build",
            "--app",
            "tests.browser.backend:app",
            "--frontend",
            str(FRONTEND.relative_to(REPOSITORY_ROOT)),
        ]
    )


def elapsed_ms(started_at: float, observed_at: float) -> float:
    return (observed_at - started_at) * 1_000


def _is_fastapi_process(process: ProcessSnapshot) -> bool:
    return (
        " -m uvicorn " in f" {process.command} "
        and "tests.browser.backend:app" in process.command
    )


def _is_next_process(process: ProcessSnapshot) -> bool:
    command = process.command.replace("\\", "/")
    return (
        ("next/dist/bin/next" in command and " start" in command)
        or ("pnpm" in command and " run start" in command)
        or ("tests/browser/frontend" in command and "next start" in command)
    )


def _capture_descendants(
    root_pid: int,
    captured: dict[tuple[int, str], ProcessSnapshot],
) -> dict[int, ProcessSnapshot]:
    current = descendants(root_pid, process_table())
    captured.update(
        {(process.pid, process.start_time): process for process in current.values()}
    )
    return current


def _wait_for_workers(
    capture: OutputCapture,
    supervisor_pid: int,
    captured: dict[tuple[int, str], ProcessSnapshot],
    expected: int,
) -> tuple[int, ...]:
    deadline = time.monotonic() + 15
    worker_pids = capture.server_process_pids()
    while time.monotonic() < deadline and len(worker_pids) < expected:
        _capture_descendants(supervisor_pid, captured)
        worker_pids = capture.server_process_pids()
        if len(worker_pids) < expected:
            time.sleep(0.01)
    if len(worker_pids) != expected:
        raise AssertionError(
            f"expected {expected} FastAPI worker PID(s), observed {sorted(worker_pids)}"
        )
    current = _capture_descendants(supervisor_pid, captured)
    missing = worker_pids - set(current)
    if missing:
        raise AssertionError(
            "Uvicorn reported worker PID(s) outside the supervisor tree: "
            f"{sorted(missing)}"
        )
    return tuple(sorted(worker_pids))


def _assert_runtime_contract(
    public_port: int,
    backend_port: int,
    processes: dict[int, ProcessSnapshot],
) -> None:
    health_status, health = fetch_json(
        f"http://127.0.0.1:{public_port}/_fluxfast/healthz"
    )
    ready_status, readiness = fetch_json(
        f"http://127.0.0.1:{public_port}/_fluxfast/readyz"
    )
    if (health_status, health) != (200, {"status": "ok"}):
        raise AssertionError(f"unexpected public health response: {health!r}")
    if (ready_status, readiness) != (200, {"status": "ready"}):
        raise AssertionError(f"unexpected public readiness response: {readiness!r}")

    public_addresses = listening_ipv4_addresses(public_port)
    backend_addresses = listening_ipv4_addresses(backend_port)
    if "00000000" not in public_addresses:
        raise AssertionError(
            f"public port {public_port} is not externally bound: {public_addresses}"
        )
    if not backend_addresses or backend_addresses != {"0100007F"}:
        raise AssertionError(
            f"FastAPI port {backend_port} must bind only 127.0.0.1: {backend_addresses}"
        )

    owned_listeners = owned_listening_ipv4_sockets(processes)
    externally_bound_ports = {
        port for address, port in owned_listeners if address != "0100007F"
    }
    if externally_bound_ports != {public_port}:
        raise AssertionError(
            "supervised children must expose exactly one public TCP port: "
            f"{sorted(owned_listeners)}"
        )
    if ("0100007F", backend_port) not in owned_listeners:
        raise AssertionError(
            f"FastAPI listener {backend_port} is not owned by the supervisor tree"
        )


def _wait_for_cleanup(
    captured: dict[tuple[int, str], ProcessSnapshot],
    public_port: int,
    backend_port: int,
) -> None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        alive = [
            process
            for (pid, start_time), process in captured.items()
            if identity_is_alive(pid, start_time)
        ]
        if not alive and port_is_closed(public_port) and port_is_closed(backend_port):
            return
        time.sleep(0.05)
    rendered = [f"{process.pid}: {process.command}" for process in alive]
    raise AssertionError(f"production child processes leaked: {rendered}")


def _force_cleanup(
    process: subprocess.Popen[str],
    captured: dict[tuple[int, str], ProcessSnapshot],
) -> None:
    if process.poll() is None:
        _capture_descendants(process.pid, captured)
    for (pid, start_time), _snapshot in reversed(list(captured.items())):
        if not identity_is_alive(pid, start_time):
            continue
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def benchmark_once(workers: int, sample: int) -> LifecycleMeasurement:
    """Run and verify one real FluxFast production lifecycle."""

    public_port = available_port()
    backend_port = available_port()
    while backend_port == public_port:
        backend_port = available_port()

    environment = os.environ.copy()
    environment["NEXT_TELEMETRY_DISABLED"] = "1"
    environment.pop("FLUXFAST_BACKEND_URL", None)
    environment.pop("NEXT_PUBLIC_FLUXFAST_BACKEND_URL", None)
    command = [
        sys.executable,
        "-m",
        "fluxfast.cli",
        "start",
        "tests.browser.backend:app",
        "--frontend",
        str(FRONTEND.relative_to(REPOSITORY_ROOT)),
        "--host",
        "0.0.0.0",
        "--port",
        str(public_port),
        "--backend-host",
        "127.0.0.1",
        "--backend-port",
        str(backend_port),
        "--workers",
        str(workers),
        "--startup-timeout",
        "60",
        "--shutdown-timeout",
        "20",
    ]
    started_at = time.perf_counter()
    process = subprocess.Popen(
        command,
        cwd=REPOSITORY_ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf8",
        errors="replace",
        bufsize=1,
        start_new_session=True,
        shell=False,
    )
    capture = OutputCapture(process)
    captured: dict[tuple[int, str], ProcessSnapshot] = {}
    fastapi_start_at: float | None = None
    fastapi_ready_at: float | None = None
    next_start_at: float | None = None
    public_ready_at: float | None = None
    peak_descendants = 0

    try:
        deadline = time.monotonic() + 90
        next_probe_at = 0.0
        while time.monotonic() < deadline:
            now = time.perf_counter()
            current = _capture_descendants(process.pid, captured)
            peak_descendants = max(peak_descendants, len(current))
            if fastapi_start_at is None and any(
                _is_fastapi_process(candidate) for candidate in current.values()
            ):
                fastapi_start_at = now
            fastapi_ready_at = fastapi_ready_at or capture.marker_time(
                "[fluxfast] FastAPI ready"
            )
            if (
                fastapi_ready_at is not None
                and next_start_at is None
                and any(_is_next_process(candidate) for candidate in current.values())
            ):
                next_start_at = now
            application_ready_at = capture.marker_time("[fluxfast] application ready")
            if now >= next_probe_at:
                next_probe_at = now + 0.05
                try:
                    status, body = fetch_json(
                        f"http://127.0.0.1:{public_port}/_fluxfast/readyz",
                        timeout=0.15,
                    )
                    if status == 200 and body == {"status": "ready"}:
                        public_ready_at = time.perf_counter()
                except (HTTPError, URLError, TimeoutError, ConnectionError):
                    pass
            if (
                fastapi_start_at is not None
                and fastapi_ready_at is not None
                and next_start_at is not None
                and public_ready_at is not None
                and application_ready_at is not None
            ):
                break
            return_code = process.poll()
            if return_code is not None:
                raise RuntimeError(
                    f"production runtime exited during startup with {return_code}"
                )
            time.sleep(0.01)
        else:
            raise TimeoutError("production runtime did not expose every startup phase")

        assert fastapi_start_at is not None
        assert fastapi_ready_at is not None
        assert next_start_at is not None
        assert public_ready_at is not None
        if not (
            fastapi_start_at <= fastapi_ready_at <= next_start_at <= public_ready_at
        ):
            raise AssertionError(
                "production lifecycle phases were observed out of order: "
                f"FastAPI start={fastapi_start_at}, ready={fastapi_ready_at}, "
                f"Next start={next_start_at}, public ready={public_ready_at}"
            )

        worker_pids = _wait_for_workers(
            capture,
            process.pid,
            captured,
            workers,
        )
        current = _capture_descendants(process.pid, captured)
        peak_descendants = max(peak_descendants, len(current))
        missing_workers = set(worker_pids) - set(current)
        if missing_workers:
            raise AssertionError(
                "Uvicorn reported worker processes outside the supervisor tree: "
                f"{sorted(missing_workers)}"
            )
        _assert_runtime_contract(public_port, backend_port, current)

        shutdown_started_at = time.perf_counter()
        process.send_signal(signal.SIGTERM)
        shutdown_deadline = time.monotonic() + 30
        while process.poll() is None and time.monotonic() < shutdown_deadline:
            current = _capture_descendants(process.pid, captured)
            peak_descendants = max(peak_descendants, len(current))
            time.sleep(0.01)
        if process.poll() is None:
            raise TimeoutError("production supervisor did not stop after SIGTERM")
        capture.join()
        if process.returncode != 0:
            raise RuntimeError(
                f"production supervisor exited with status {process.returncode}"
            )
        shutdown_ms = elapsed_ms(shutdown_started_at, time.perf_counter())
        _wait_for_cleanup(captured, public_port, backend_port)

        return LifecycleMeasurement(
            workers=workers,
            sample=sample,
            fastapi_start_ms=elapsed_ms(started_at, fastapi_start_at),
            fastapi_ready_ms=elapsed_ms(started_at, fastapi_ready_at),
            next_start_ms=elapsed_ms(started_at, next_start_at),
            public_ready_ms=elapsed_ms(started_at, public_ready_at),
            shutdown_ms=shutdown_ms,
            observed_worker_pids=worker_pids,
            peak_descendants=peak_descendants,
        )
    except Exception as error:
        raise RuntimeError(f"{error}\nproduction output:\n{capture.text()}") from error
    finally:
        _force_cleanup(process, captured)
        capture.join()


def median(values: list[float]) -> float:
    return statistics.median(values)


def run_benchmark(samples: int, *, skip_build: bool) -> None:
    """Run every planned worker count and print observational medians."""

    if sys.platform != "linux":
        raise RuntimeError(
            "production lifecycle benchmark currently requires Linux /proc"
        )
    if samples < 2:
        raise ValueError(
            "samples must be at least 2 to verify repeated start/stop cleanup"
        )
    if not skip_build:
        prepare_frontend()

    results = [
        benchmark_once(workers, sample)
        for workers in WORKER_COUNTS
        for sample in range(1, samples + 1)
    ]

    print("FluxFast controlled production lifecycle benchmark")
    print(
        f"workload: {samples} complete start/readiness/SIGTERM cycles for each "
        "1/2/4/8 FastAPI-worker topology"
    )
    print("cumulative startup observations from supervisor launch:")
    for workers in WORKER_COUNTS:
        group = [result for result in results if result.workers == workers]
        print(
            f"  {workers} worker(s) — FastAPI process start "
            f"{median([result.fastapi_start_ms for result in group]):.3f} ms; "
            f"FastAPI ready {median([result.fastapi_ready_ms for result in group]):.3f} ms; "
            f"Next.js process start {median([result.next_start_ms for result in group]):.3f} ms; "
            f"public ready {median([result.public_ready_ms for result in group]):.3f} ms; "
            f"SIGTERM cleanup {median([result.shutdown_ms for result in group]):.3f} ms; "
            f"{max(result.peak_descendants for result in group)} peak descendants"
        )
    print(
        "tradeoff: additional FastAPI workers increase process and startup work; "
        "timings are host observations, not release thresholds"
    )
    print(
        "correctness: PASS — every run exposed one public port with loopback-only "
        "FastAPI, returned minimal health/readiness payloads, served from the exact "
        "worker count, exited cleanly on SIGTERM, and left no child process or "
        "listening socket after repeated start/stop cycles"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--samples",
        type=int,
        default=int(os.getenv("FLUXFAST_BENCHMARK_SAMPLES", "3")),
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="reuse an already completed frontend production build",
    )
    arguments = sys.argv[1:]
    if arguments[:1] == ["--"]:
        arguments = arguments[1:]
    return parser.parse_args(arguments)


if __name__ == "__main__":
    arguments = parse_args()
    run_benchmark(arguments.samples, skip_build=arguments.skip_build)

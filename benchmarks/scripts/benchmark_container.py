"""Measure the FluxFast production image without machine-specific gates."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
HTTP = build_opener(ProxyHandler({}))
PROCESS_METRICS_SCRIPT = """
const fs = require("node:fs");
let rssKiB = 0;
const processes = [];
for (const entry of fs.readdirSync("/proc")) {
  if (!/^\\d+$/.test(entry) || Number(entry) === process.pid) continue;
  try {
    const command = fs.readFileSync(`/proc/${entry}/cmdline`)
      .toString().replaceAll("\\0", " ").trim();
    if (!command) continue;
    const status = fs.readFileSync(`/proc/${entry}/status`, "utf8");
    const match = status.match(/^VmRSS:\\s+(\\d+) kB$/m);
    const processRssKiB = match ? Number(match[1]) : 0;
    rssKiB += processRssKiB;
    processes.push({ pid: Number(entry), rssKiB: processRssKiB, command });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
process.stdout.write(JSON.stringify({ rssKiB, processes }));
""".strip()


def command_output(
    engine: str,
    arguments: list[str],
    *,
    check: bool = True,
) -> str:
    result = subprocess.run(
        [engine, *arguments],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        check=False,
        shell=False,
        text=True,
        encoding="utf8",
        errors="replace",
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"{engine} {' '.join(arguments)} exited with {result.returncode}\n"
            f"{result.stdout}{result.stderr}"
        )
    return result.stdout.strip()


def command_inherit(engine: str, arguments: list[str]) -> None:
    subprocess.run(
        [engine, *arguments],
        cwd=REPOSITORY_ROOT,
        check=True,
        shell=False,
    )


def fetch_json(url: str, *, timeout: float = 0.5) -> tuple[int, Any]:
    request = Request(url, headers={"Connection": "close"})
    with HTTP.open(request, timeout=timeout) as response:
        return response.status, json.loads(response.read())


def wait_for_readiness(base_url: str, timeout: float = 120) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status, payload = fetch_json(f"{base_url}/_fluxfast/readyz")
            if status == 200 and payload == {"status": "ready"}:
                return
        except (HTTPError, URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.1)
    raise TimeoutError("production container did not become publicly ready")


def parse_host_port(mapping: str) -> int:
    last = mapping.splitlines()[0].rsplit(":", 1)[-1]
    try:
        return int(last)
    except ValueError as error:
        raise RuntimeError(
            f"could not parse container port mapping {mapping!r}"
        ) from error


def inspect_one(engine: str, kind: str, name: str) -> dict[str, Any]:
    inspected = json.loads(command_output(engine, [kind, "inspect", name]))
    if not isinstance(inspected, list) or not inspected:
        raise RuntimeError(f"{engine} {kind} inspect returned no record for {name}")
    return inspected[0]


def human_bytes(size: int) -> str:
    value = float(size)
    units = ("B", "KiB", "MiB", "GiB")
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.1f} {unit}"
        value /= 1024
    raise AssertionError("unreachable")


def run_benchmark(engine: str) -> None:
    """Build, run, observe, and clean up one production image."""

    identifier = f"{os.getpid()}-{time.time_ns()}"
    image = f"fluxfast-production-benchmark:{identifier}"
    container = f"fluxfast-production-benchmark-{identifier}"
    image_created = False
    container_created = False
    container_running = False
    engine_name = Path(engine).name.casefold()

    try:
        build_arguments = ["build"]
        if engine_name == "podman":
            build_arguments.extend(["--format", "docker"])
        build_arguments.extend(["--tag", image, "--file", "Dockerfile", "."])
        command_inherit(engine, build_arguments)
        image_created = True

        image_record = inspect_one(engine, "image", image)
        image_size = int(
            image_record.get("Size") or image_record.get("VirtualSize") or 0
        )
        if image_size <= 0:
            raise AssertionError(
                "container engine did not report a positive image size"
            )
        exposed = sorted(image_record.get("Config", {}).get("ExposedPorts") or {})
        if exposed != ["3000/tcp"]:
            raise AssertionError(f"image must expose only 3000/tcp, got {exposed}")

        startup_started_at = time.perf_counter()
        command_output(
            engine,
            [
                "run",
                "--detach",
                "--name",
                container,
                "--read-only",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,size=64m",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--publish",
                "127.0.0.1::3000",
                image,
            ],
        )
        container_created = True
        container_running = True
        host_port = parse_host_port(
            command_output(engine, ["port", container, "3000/tcp"])
        )
        base_url = f"http://127.0.0.1:{host_port}"
        wait_for_readiness(base_url)
        startup_ms = (time.perf_counter() - startup_started_at) * 1_000

        health_status, health = fetch_json(f"{base_url}/_fluxfast/healthz")
        ready_status, readiness = fetch_json(f"{base_url}/_fluxfast/readyz")
        if (health_status, health) != (200, {"status": "ok"}):
            raise AssertionError(f"unexpected public health response: {health!r}")
        if (ready_status, readiness) != (200, {"status": "ready"}):
            raise AssertionError(f"unexpected public readiness response: {readiness!r}")

        container_record = inspect_one(engine, "container", container)
        bindings = sorted(
            container_record.get("HostConfig", {}).get("PortBindings") or {}
        )
        if bindings != ["3000/tcp"]:
            raise AssertionError(
                f"container must publish only its public port, got {bindings}"
            )

        time.sleep(1)
        metrics = json.loads(
            command_output(
                engine,
                ["exec", container, "node", "-e", PROCESS_METRICS_SCRIPT],
            )
        )
        processes = metrics.get("processes")
        if not isinstance(processes, list) or len(processes) < 3:
            raise AssertionError(
                f"unexpected production process inventory: {processes!r}"
            )
        idle_rss_kib = int(metrics.get("rssKiB", 0))
        if idle_rss_kib <= 0:
            raise AssertionError(
                "container process inventory reported no resident memory"
            )

        shutdown_started_at = time.perf_counter()
        command_inherit(engine, ["stop", "--timeout", "25", container])
        shutdown_ms = (time.perf_counter() - shutdown_started_at) * 1_000
        container_running = False
        stopped_record = inspect_one(engine, "container", container)
        state = stopped_record.get("State", {})
        if state.get("Running") is not False or int(state.get("ExitCode", -1)) != 0:
            raise AssertionError(f"container did not stop cleanly: {state}")

        print("FluxFast controlled production container benchmark")
        print(f"engine: {engine_name}")
        print(f"image size: {image_size} B ({human_bytes(image_size)})")
        print(f"public readiness: {startup_ms:.3f} ms from container run")
        print(
            f"idle processes: {len(processes)}; summed VmRSS: "
            f"{idle_rss_kib} KiB ({human_bytes(idle_rss_kib * 1024)})"
        )
        print(f"container stop: {shutdown_ms:.3f} ms")
        print(
            "tradeoff: the single image includes both Python/FastAPI and "
            "Node/Next.js runtimes in exchange for one deployable application boundary"
        )
        print(
            "correctness: PASS — the image exposed only 3000/tcp, the runtime "
            "published one host port, minimal health/readiness succeeded, process "
            "metrics were captured at idle, and SIGTERM stopped PID 1 and all children"
        )
    except Exception as error:
        if container_created:
            logs = command_output(engine, ["logs", container], check=False)
            if logs:
                raise RuntimeError(f"{error}\ncontainer output:\n{logs}") from error
        raise
    finally:
        if container_running:
            command_output(engine, ["stop", "--timeout", "5", container], check=False)
        if container_created:
            command_output(engine, ["rm", "--force", container], check=False)
        if image_created:
            command_output(engine, ["image", "rm", "--force", image], check=False)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--engine",
        default=os.getenv("FLUXFAST_CONTAINER_ENGINE", "docker"),
        help="Docker- or Podman-compatible container CLI",
    )
    arguments = sys.argv[1:]
    if arguments[:1] == ["--"]:
        arguments = arguments[1:]
    return parser.parse_args(arguments)


if __name__ == "__main__":
    run_benchmark(parse_args().engine)

"""Tests for ordered FastAPI and Next.js production supervision."""

import socket
from pathlib import Path

import pytest

from fluxfast.production import (
    ProductionChildError,
    ProductionConfig,
    ProductionStartupError,
    ProductionSupervisor,
    ProductionSupervisorError,
    SupervisorState,
    tcp_readiness_probe,
)


class FakeProcess:
    def __init__(self, name: str, events: list[str]) -> None:
        self.name = name
        self.events = events
        self.process: object | None = None
        self.return_code: int | None = None
        self.terminate_calls = 0

    def start(self) -> object:
        self.events.append(f"{self.name}.start")
        self.process = object()
        return self.process

    def poll(self) -> int | None:
        self.events.append(f"{self.name}.poll")
        return self.return_code

    def terminate(self) -> None:
        self.events.append(f"{self.name}.terminate")
        self.terminate_calls += 1


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, duration: float) -> None:
        self.now += duration


def _config(**overrides: object) -> ProductionConfig:
    values: dict[str, object] = {
        "app": "backend:app",
        "frontend": Path("frontend"),
        "startup_timeout": 0.2,
    }
    values.update(overrides)
    return ProductionConfig(**values)  # type: ignore[arg-type]


def test_supervisor_readies_backend_before_starting_frontend() -> None:
    events: list[str] = []
    backend = FakeProcess("backend", events)
    frontend = FakeProcess("frontend", events)
    backend_attempts = iter([False, True])
    frontend_attempts = iter([False, False, True])
    clock = FakeClock()
    supervisor = ProductionSupervisor(
        _config(),
        backend,  # type: ignore[arg-type]
        frontend,  # type: ignore[arg-type]
        backend_ready=lambda: next(backend_attempts),
        frontend_ready=lambda: next(frontend_attempts),
        poll_interval=0.05,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )

    supervisor.start()

    assert supervisor.state == SupervisorState.READY
    assert events.index("backend.start") < events.index("frontend.start")
    assert events.count("backend.poll") == 2
    assert events.count("frontend.poll") == 3


def test_supervisor_rejects_repeated_start() -> None:
    events: list[str] = []
    supervisor = ProductionSupervisor(
        _config(),
        FakeProcess("backend", events),  # type: ignore[arg-type]
        FakeProcess("frontend", events),  # type: ignore[arg-type]
        backend_ready=lambda: True,
        frontend_ready=lambda: True,
    )
    supervisor.start()

    with pytest.raises(ProductionSupervisorError, match="cannot start"):
        supervisor.start()


def test_supervisor_fails_when_backend_exits_before_readiness() -> None:
    events: list[str] = []
    backend = FakeProcess("backend", events)
    backend.return_code = 7
    frontend = FakeProcess("frontend", events)
    supervisor = ProductionSupervisor(
        _config(),
        backend,  # type: ignore[arg-type]
        frontend,  # type: ignore[arg-type]
        backend_ready=lambda: False,
        frontend_ready=lambda: True,
    )

    with pytest.raises(ProductionStartupError, match="status 7"):
        supervisor.start()

    assert supervisor.state == SupervisorState.FAILED
    assert "frontend.start" not in events


def test_supervisor_times_out_and_terminates_started_backend() -> None:
    events: list[str] = []
    backend = FakeProcess("backend", events)
    frontend = FakeProcess("frontend", events)
    clock = FakeClock()
    supervisor = ProductionSupervisor(
        _config(startup_timeout=0.1),
        backend,  # type: ignore[arg-type]
        frontend,  # type: ignore[arg-type]
        backend_ready=lambda: False,
        frontend_ready=lambda: True,
        poll_interval=0.04,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )

    with pytest.raises(ProductionStartupError, match="within 0.1 seconds"):
        supervisor.start()

    assert supervisor.state == SupervisorState.FAILED
    assert backend.terminate_calls == 1
    assert frontend.terminate_calls == 0


def test_supervisor_monitor_reports_child_exit_and_stops_sibling() -> None:
    events: list[str] = []
    backend = FakeProcess("backend", events)
    frontend = FakeProcess("frontend", events)
    supervisor = ProductionSupervisor(
        _config(),
        backend,  # type: ignore[arg-type]
        frontend,  # type: ignore[arg-type]
        backend_ready=lambda: True,
        frontend_ready=lambda: True,
        sleep=lambda _duration: setattr(frontend, "return_code", 9),
    )
    supervisor.start()

    with pytest.raises(ProductionChildError) as raised:
        supervisor.monitor()

    assert raised.value.child_name == "frontend"
    assert raised.value.return_code == 9
    assert supervisor.state == SupervisorState.FAILED
    assert backend.terminate_calls == 1


def test_supervisor_shutdown_is_reverse_order_and_idempotent() -> None:
    events: list[str] = []
    backend = FakeProcess("backend", events)
    frontend = FakeProcess("frontend", events)
    supervisor = ProductionSupervisor(
        _config(),
        backend,  # type: ignore[arg-type]
        frontend,  # type: ignore[arg-type]
        backend_ready=lambda: True,
        frontend_ready=lambda: True,
    )
    supervisor.start()
    events.clear()

    supervisor.shutdown()
    supervisor.shutdown()

    assert supervisor.state == SupervisorState.STOPPED
    assert events == ["frontend.terminate", "backend.terminate"]


def test_supervisor_rejects_monitor_before_readiness() -> None:
    events: list[str] = []
    supervisor = ProductionSupervisor(
        _config(),
        FakeProcess("backend", events),  # type: ignore[arg-type]
        FakeProcess("frontend", events),  # type: ignore[arg-type]
        backend_ready=lambda: True,
        frontend_ready=lambda: True,
    )

    with pytest.raises(ProductionSupervisorError, match="cannot monitor"):
        supervisor.monitor()


def test_tcp_readiness_probe_reports_open_and_closed_ports() -> None:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        host, port = server.getsockname()
        assert tcp_readiness_probe(host, port)() is True

    assert tcp_readiness_probe(host, port, connection_timeout=0.01)() is False


@pytest.mark.parametrize("invalid", [0, -1, float("inf"), float("nan")])
def test_supervisor_rejects_invalid_poll_and_connection_timeouts(
    invalid: float,
) -> None:
    events: list[str] = []
    with pytest.raises(ProductionSupervisorError, match="poll_interval"):
        ProductionSupervisor(
            _config(),
            FakeProcess("backend", events),  # type: ignore[arg-type]
            FakeProcess("frontend", events),  # type: ignore[arg-type]
            backend_ready=lambda: True,
            frontend_ready=lambda: True,
            poll_interval=invalid,
        )

    with pytest.raises(ProductionSupervisorError, match="connection_timeout"):
        tcp_readiness_probe("127.0.0.1", 3000, connection_timeout=invalid)

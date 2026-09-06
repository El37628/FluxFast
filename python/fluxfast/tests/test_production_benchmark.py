"""Regression tests for production lifecycle benchmark instrumentation."""

from benchmarks.scripts.benchmark_production import (
    ProcessSnapshot,
    _observe_next_start,
)


def test_next_observation_cannot_precede_backend_ready_marker() -> None:
    """Independent observers must not invert the supervised startup order."""

    processes = {
        7231: ProcessSnapshot(
            pid=7231,
            parent_pid=7200,
            start_time="12345",
            command="pnpm run start",
        )
    }

    observed_at = _observe_next_start(
        processes,
        fastapi_ready_at=397.139384666,
        next_start_at=None,
        clock=lambda: 397.136040067,
    )

    assert observed_at == 397.139384666


def test_next_observation_waits_for_process_and_backend_marker() -> None:
    process = ProcessSnapshot(
        pid=7231,
        parent_pid=7200,
        start_time="12345",
        command="python unrelated.py",
    )

    assert _observe_next_start({7231: process}, 5.0, None, clock=lambda: 6.0) is None
    assert _observe_next_start({}, None, None, clock=lambda: 6.0) is None

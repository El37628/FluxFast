"""Tests for validated production runtime configuration."""

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from fluxfast.production.config import (
    ProductionConfig,
    ProductionConfigError,
    resolve_production_config,
)


def test_production_config_defaults_are_safe_for_one_origin_runtime() -> None:
    config = ProductionConfig(app="backend.main:app", frontend=Path("frontend"))

    assert config == ProductionConfig(
        app="backend.main:app",
        frontend=Path("frontend"),
        host="0.0.0.0",
        port=3000,
        backend_host="127.0.0.1",
        backend_port=8123,
        workers=1,
        startup_timeout=30.0,
        shutdown_timeout=20.0,
    )


def test_production_config_is_immutable() -> None:
    config = ProductionConfig(app="backend:app", frontend=Path("frontend"))

    with pytest.raises(FrozenInstanceError):
        config.port = 4000  # type: ignore[misc]


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"app": "backend"}, "module:attribute"),
        ({"app": "backend:app:factory"}, "module:attribute"),
        ({"frontend": "frontend"}, "frontend must be a pathlib.Path"),
        ({"host": ""}, "host must be a non-empty"),
        ({"host": " 127.0.0.1"}, "host must be a non-empty"),
        ({"backend_host": "  "}, "backend_host must be a non-empty"),
        ({"port": 0}, "port must be an integer from 1 to 65535"),
        ({"port": 65536}, "port must be an integer from 1 to 65535"),
        ({"backend_port": False}, "backend_port must be an integer"),
        ({"workers": 0}, "workers must be an integer"),
        ({"workers": True}, "workers must be an integer"),
        ({"startup_timeout": 0}, "startup_timeout must be a finite"),
        ({"startup_timeout": float("inf")}, "startup_timeout must be a finite"),
        ({"shutdown_timeout": float("nan")}, "shutdown_timeout must be a finite"),
    ],
)
def test_production_config_rejects_invalid_values(
    overrides: dict[str, object],
    message: str,
) -> None:
    values: dict[str, object] = {
        "app": "backend:app",
        "frontend": Path("frontend"),
    }
    values.update(overrides)

    with pytest.raises(ProductionConfigError, match=message):
        ProductionConfig(**values)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("host", "backend_host"),
    [
        ("0.0.0.0", "127.0.0.1"),
        ("127.0.0.1", "127.0.0.1"),
        ("localhost", "127.0.0.1"),
        ("::", "::1"),
    ],
)
def test_production_config_rejects_potentially_overlapping_ports(
    host: str,
    backend_host: str,
) -> None:
    with pytest.raises(ProductionConfigError, match="host addresses may overlap"):
        ProductionConfig(
            app="backend:app",
            frontend=Path("frontend"),
            host=host,
            port=3100,
            backend_host=backend_host,
            backend_port=3100,
        )


def test_production_config_allows_same_port_on_distinct_literal_addresses() -> None:
    config = ProductionConfig(
        app="backend:app",
        frontend=Path("frontend"),
        host="127.0.0.2",
        port=3100,
        backend_host="127.0.0.1",
        backend_port=3100,
    )

    assert config.port == config.backend_port == 3100


def test_resolve_production_config_uses_environment_and_conventional_port() -> None:
    config = resolve_production_config(
        "backend:app",
        Path("web"),
        environment={
            "FLUXFAST_HOST": "127.0.0.2",
            "PORT": "4100",
            "FLUXFAST_BACKEND_HOST": "127.0.0.1",
            "FLUXFAST_BACKEND_PORT": "8124",
            "FLUXFAST_WORKERS": "4",
            "FLUXFAST_STARTUP_TIMEOUT": "45.5",
            "FLUXFAST_SHUTDOWN_TIMEOUT": "25",
        },
    )

    assert config == ProductionConfig(
        app="backend:app",
        frontend=Path("web"),
        host="127.0.0.2",
        port=4100,
        backend_host="127.0.0.1",
        backend_port=8124,
        workers=4,
        startup_timeout=45.5,
        shutdown_timeout=25.0,
    )


def test_resolve_production_config_applies_documented_precedence() -> None:
    config = resolve_production_config(
        "backend:app",
        Path("web"),
        host="127.0.0.3",
        port=4300,
        workers=6,
        environment={
            "FLUXFAST_HOST": "127.0.0.2",
            "FLUXFAST_PORT": "4200",
            "PORT": "4100",
            "FLUXFAST_WORKERS": "4",
        },
    )

    assert config.host == "127.0.0.3"
    assert config.port == 4300
    assert config.workers == 6


def test_fluxfast_port_precedes_conventional_port() -> None:
    config = resolve_production_config(
        "backend:app",
        Path("web"),
        environment={"FLUXFAST_PORT": "4200", "PORT": "4100"},
    )

    assert config.port == 4200


@pytest.mark.parametrize(
    ("environment", "message"),
    [
        ({"FLUXFAST_PORT": "three-thousand"}, "FLUXFAST_PORT must be an integer"),
        ({"PORT": "three-thousand"}, "PORT must be an integer"),
        ({"FLUXFAST_WORKERS": "1.5"}, "FLUXFAST_WORKERS must be an integer"),
        ({"FLUXFAST_STARTUP_TIMEOUT": "soon"}, "FLUXFAST_STARTUP_TIMEOUT must be a number"),
    ],
)
def test_resolve_production_config_reports_invalid_environment_values(
    environment: dict[str, str],
    message: str,
) -> None:
    with pytest.raises(ProductionConfigError, match=message):
        resolve_production_config(
            "backend:app",
            Path("web"),
            environment=environment,
        )

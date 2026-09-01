"""Validated configuration for the FluxFast production runtime."""

from __future__ import annotations

import ipaddress
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar


class ProductionConfigError(ValueError):
    """Raised when production runtime configuration is invalid."""


@dataclass(frozen=True)
class ProductionConfig:
    """Immutable settings shared by production commands and runtime components."""

    app: str
    frontend: Path
    host: str = "0.0.0.0"
    port: int = 3000
    backend_host: str = "127.0.0.1"
    backend_port: int = 8123
    workers: int = 1
    startup_timeout: float = 30.0
    shutdown_timeout: float = 20.0

    def __post_init__(self) -> None:
        _validate_app_import(self.app)
        _validate_frontend(self.frontend)
        _validate_host("host", self.host)
        _validate_host("backend_host", self.backend_host)
        _validate_port("port", self.port)
        _validate_port("backend_port", self.backend_port)
        _validate_positive_integer("workers", self.workers)
        _validate_timeout("startup_timeout", self.startup_timeout)
        _validate_timeout("shutdown_timeout", self.shutdown_timeout)

        if self.port == self.backend_port and _hosts_may_overlap(
            self.host,
            self.backend_host,
        ):
            raise ProductionConfigError(
                "port and backend_port cannot use the same value when their "
                "host addresses may overlap"
            )


_T = TypeVar("_T")


def resolve_production_config(
    app: str,
    frontend: Path,
    *,
    host: str | None = None,
    port: int | None = None,
    backend_host: str | None = None,
    backend_port: int | None = None,
    workers: int | None = None,
    startup_timeout: float | None = None,
    shutdown_timeout: float | None = None,
    environment: Mapping[str, str] | None = None,
) -> ProductionConfig:
    """Resolve CLI-style overrides and environment variables into one config.

    Explicit keyword arguments represent command-line values. Their precedence is
    higher than ``FLUXFAST_*`` values. The conventional ``PORT`` variable is used
    only for the public port and only when ``FLUXFAST_PORT`` is absent.
    """

    values = os.environ if environment is None else environment
    return ProductionConfig(
        app=app,
        frontend=frontend,
        host=_resolve_value(host, values, "FLUXFAST_HOST", "0.0.0.0"),
        port=_resolve_number(
            port,
            values,
            "FLUXFAST_PORT",
            3000,
            int,
            fallback_environment_name="PORT",
        ),
        backend_host=_resolve_value(
            backend_host,
            values,
            "FLUXFAST_BACKEND_HOST",
            "127.0.0.1",
        ),
        backend_port=_resolve_number(
            backend_port,
            values,
            "FLUXFAST_BACKEND_PORT",
            8123,
            int,
        ),
        workers=_resolve_number(
            workers,
            values,
            "FLUXFAST_WORKERS",
            1,
            int,
        ),
        startup_timeout=_resolve_number(
            startup_timeout,
            values,
            "FLUXFAST_STARTUP_TIMEOUT",
            30.0,
            float,
        ),
        shutdown_timeout=_resolve_number(
            shutdown_timeout,
            values,
            "FLUXFAST_SHUTDOWN_TIMEOUT",
            20.0,
            float,
        ),
    )


def _resolve_value(
    explicit: _T | None,
    environment: Mapping[str, str],
    environment_name: str,
    default: _T,
) -> _T | str:
    if explicit is not None:
        return explicit
    return environment.get(environment_name, default)


def _resolve_number(
    explicit: _T | None,
    environment: Mapping[str, str],
    environment_name: str,
    default: _T,
    parser: type[int | float],
    *,
    fallback_environment_name: str | None = None,
) -> _T | int | float:
    if explicit is not None:
        return explicit

    source_name = environment_name
    raw_value = environment.get(environment_name)
    if raw_value is None and fallback_environment_name is not None:
        source_name = fallback_environment_name
        raw_value = environment.get(fallback_environment_name)
    if raw_value is None:
        return default

    try:
        return parser(raw_value)
    except (TypeError, ValueError) as error:
        expected = "an integer" if parser is int else "a number"
        raise ProductionConfigError(
            f"{source_name} must be {expected}, got {raw_value!r}"
        ) from error


def _validate_app_import(value: object) -> None:
    if not isinstance(value, str):
        raise ProductionConfigError("app must be a module:attribute import string")
    module, separator, attribute = value.partition(":")
    if (
        not separator
        or value.count(":") != 1
        or not module
        or not attribute
        or value != value.strip()
    ):
        raise ProductionConfigError(
            "app must use module:attribute format, for example backend.main:app"
        )


def _validate_frontend(value: object) -> None:
    if not isinstance(value, Path):
        raise ProductionConfigError("frontend must be a pathlib.Path")


def _validate_host(name: str, value: object) -> None:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ProductionConfigError(f"{name} must be a non-empty address")


def _validate_port(name: str, value: object) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ProductionConfigError(f"{name} must be an integer from 1 to 65535")


def _validate_positive_integer(name: str, value: object) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ProductionConfigError(f"{name} must be an integer greater than or equal to 1")


def _validate_timeout(name: str, value: object) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise ProductionConfigError(f"{name} must be a finite number greater than 0")


def _hosts_may_overlap(left: str, right: str) -> bool:
    normalized_left = left.strip().casefold()
    normalized_right = right.strip().casefold()
    if normalized_left == normalized_right:
        return True

    try:
        left_address = ipaddress.ip_address(normalized_left)
        right_address = ipaddress.ip_address(normalized_right)
    except ValueError:
        # Hostnames can resolve to the same address, so reject an ambiguous
        # same-port configuration instead of relying on platform DNS behavior.
        return True

    if left_address.is_unspecified or right_address.is_unspecified:
        return True
    return left_address == right_address

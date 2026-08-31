"""Application-scoped developer schema metadata."""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any, TypeVar

from .contract import ResourceContract, _validate_resource_key

T = TypeVar("T")


class SchemaRegistry:
    """Own the authoritative contracts registered by one FluxFast instance."""

    __slots__ = ("_resource_contracts", "_resource_contracts_view")

    def __init__(self) -> None:
        self._resource_contracts: dict[str, ResourceContract[Any]] = {}
        self._resource_contracts_view: Mapping[str, ResourceContract[Any]] = (
            MappingProxyType(self._resource_contracts)
        )

    @property
    def resource_contracts(self) -> Mapping[str, ResourceContract[Any]]:
        """Return a live read-only view of contracts keyed by logical resource key."""

        return self._resource_contracts_view

    def define_resource(self, key: str, annotation: type[T]) -> ResourceContract[T]:
        """Create and register the sole authoritative contract for ``key``."""

        validated_key = _validate_resource_key(key)
        if validated_key in self._resource_contracts:
            raise ValueError(f'resource contract "{validated_key}" is already defined')

        contract: ResourceContract[T] = ResourceContract(
            key=validated_key,
            annotation=annotation,
        )
        self._resource_contracts[validated_key] = contract
        return contract

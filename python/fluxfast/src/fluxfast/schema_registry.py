"""Application-scoped developer schema metadata."""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any, TypeVar

from .contract import (
    ContractMode,
    ResourceContract,
    TypeContract,
    _validate_contract_name,
    _validate_resource_key,
)

T = TypeVar("T")


class SchemaRegistry:
    """Own the authoritative contracts registered by one FluxFast instance."""

    __slots__ = (
        "_resource_contracts",
        "_resource_contracts_view",
        "_type_contracts",
        "_type_contracts_view",
    )

    def __init__(self) -> None:
        self._resource_contracts: dict[str, ResourceContract[Any]] = {}
        self._resource_contracts_view: Mapping[str, ResourceContract[Any]] = (
            MappingProxyType(self._resource_contracts)
        )
        self._type_contracts: dict[str, TypeContract[Any]] = {}
        self._type_contracts_view: Mapping[str, TypeContract[Any]] = MappingProxyType(
            self._type_contracts
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

    @property
    def type_contracts(self) -> Mapping[str, TypeContract[Any]]:
        """Return a live read-only view of explicitly named application types."""

        return self._type_contracts_view

    def define_type(
        self,
        name: str,
        annotation: Any,
        *,
        mode: ContractMode = "serialization",
    ) -> TypeContract[Any]:
        """Create and register one authoritative application type contract."""

        validated_name = _validate_contract_name(name)
        if validated_name in self._type_contracts:
            raise ValueError(f'type contract "{validated_name}" is already defined')

        contract = TypeContract(
            name=validated_name,
            annotation=annotation,
            mode=mode,
        )
        self._type_contracts[validated_name] = contract
        return contract

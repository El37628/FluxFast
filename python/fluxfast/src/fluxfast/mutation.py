"""Mutation helpers, patch representations, and redirect descriptors."""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from .protocol import PROTOCOL_VERSION, MutationEnvelope, MutationPayload
from .scope import CacheScope

_PATCH_OPERATIONS = {
    "replace-resource",
    "merge-object",
    "replace-item",
    "remove-item",
    "append-item",
}


def _validate_key(key: str) -> None:
    if (
        not isinstance(key, str)
        or not key.strip()
        or len(key) > 128
        or "," in key
        or any(ord(char) < 32 for char in key)
    ):
        raise ValueError("mutation resource keys must be safe non-empty strings")


def _validate_patch(key: str, patch: dict[str, Any]) -> None:
    operation = patch.get("op")
    if operation not in _PATCH_OPERATIONS:
        raise ValueError(f"unsupported mutation patch operation for '{key}': {operation!r}")
    has_identity = "id" in patch or bool(patch.get("match"))
    if operation in {"replace-resource", "merge-object", "append-item"} and "value" not in patch:
        raise ValueError(f"'{operation}' patch for '{key}' requires a value")
    if operation in {"replace-item", "remove-item"} and not has_identity:
        raise ValueError(f"'{operation}' patch for '{key}' requires an id or match")
    if operation == "replace-item" and "value" not in patch:
        raise ValueError(f"'replace-item' patch for '{key}' requires a value")


def replace_resource(value: Any) -> dict[str, Any]:
    return {"op": "replace-resource", "value": value}


def merge_object(value: dict[str, Any]) -> dict[str, Any]:
    return {"op": "merge-object", "value": value}


def replace_item(identity: str | int, value: Any) -> dict[str, Any]:
    return {"op": "replace-item", "id": identity, "value": value}


def remove_item(identity: str | int) -> dict[str, Any]:
    return {"op": "remove-item", "id": identity}


def append_item(value: Any) -> dict[str, Any]:
    return {"op": "append-item", "value": value}


@dataclass(slots=True)
class InvalidateResource:
    """Descriptor to invalidate a server cache entry and notify client."""

    key: str
    scope: CacheScope | None = None


def invalidate_resource(key: str, scope: CacheScope | None = None) -> InvalidateResource:
    """Specify a resource key and scope to invalidate."""
    return InvalidateResource(key=key, scope=scope)


@dataclass(slots=True)
class MutationResult:
    """Represents a structured mutation return payload."""

    patches: dict[str, list[dict[str, Any]]] | None = None
    invalidate: list[InvalidateResource] | None = None
    redirect: str | None = None
    external_redirect: str | None = None

    def to_envelope(self) -> MutationEnvelope:
        inv_keys: list[str] | None = None
        if self.invalidate:
            inv_keys = [inv.key if isinstance(inv, InvalidateResource) else str(inv) for inv in self.invalidate]

        return MutationEnvelope(
            protocol=PROTOCOL_VERSION,
            mutation=MutationPayload(
                patches=self.patches,
                invalidate=inv_keys,
                redirect=self.redirect,
                externalRedirect=self.external_redirect,
            ),
        )


def mutation(
    *,
    patch: dict[str, list[dict[str, Any]] | dict[str, Any]] | None = None,
    patches: dict[str, list[dict[str, Any]] | dict[str, Any]] | None = None,
    invalidate: Sequence[str | InvalidateResource] | None = None,
    invalidates: Sequence[str | InvalidateResource] | None = None,
    redirect: str | None = None,
) -> MutationResult:
    """Build a FluxFast mutation result."""
    if patch is not None and patches is not None:
        raise ValueError("pass either patch or patches, not both")
    if invalidate is not None and invalidates is not None:
        raise ValueError("pass either invalidate or invalidates, not both")
    patch = patch if patch is not None else patches
    invalidate = invalidate if invalidate is not None else invalidates
    formatted_patches: dict[str, list[dict[str, Any]]] | None = None
    if patch is not None:
        formatted_patches = {}
        for k, v in patch.items():
            _validate_key(k)
            if isinstance(v, list):
                formatted_patches[k] = v
            elif isinstance(v, dict):
                formatted_patches[k] = [v]
            else:
                raise TypeError(f"patches for '{k}' must be a patch object or list")
            for operation in formatted_patches[k]:
                if not isinstance(operation, dict):
                    raise TypeError(f"patches for '{k}' must contain objects")
                _validate_patch(k, operation)

    formatted_inv: list[InvalidateResource] | None = None
    if invalidate is not None:
        formatted_inv = [
            inv if isinstance(inv, InvalidateResource) else InvalidateResource(key=inv) for inv in invalidate
        ]
        for descriptor in formatted_inv:
            _validate_key(descriptor.key)

    return MutationResult(
        patches=formatted_patches,
        invalidate=formatted_inv,
        redirect=redirect,
    )


def flux_redirect(url: str) -> MutationResult:
    """Initiate an internal SPA navigation redirect."""
    if not isinstance(url, str) or not url.startswith("/") or url.startswith("//"):
        raise ValueError("internal redirects must use an origin-relative path")
    return MutationResult(redirect=url)


def flux_external_redirect(url: str) -> MutationResult:
    """Initiate a full browser external window redirect."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("external redirects must use an absolute HTTP(S) URL")
    return MutationResult(external_redirect=url)

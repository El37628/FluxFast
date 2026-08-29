"""Tests for mutation building, patching, invalidation, and redirects."""

import pytest

from fluxfast import (
    append_item,
    flux_external_redirect,
    flux_redirect,
    invalidate_resource,
    merge_object,
    mutation,
    remove_item,
    replace_item,
    replace_resource,
    scope,
)


def test_mutation_envelope_building():
    res = mutation(
        patch={
            "rooms": [
                {"op": "replace-item", "id": 101, "value": {"id": 101, "status": "clean"}}
            ]
        },
        invalidate=["summary", invalidate_resource("rooms", scope=scope.tenant(1))],
        redirect="/rooms",
    )

    envelope = res.to_envelope()
    assert envelope.protocol == "fluxfast/1"
    assert envelope.mutation.redirect == "/rooms"
    assert "summary" in (envelope.mutation.invalidate or [])
    assert "rooms" in (envelope.mutation.invalidate or [])
    assert envelope.mutation.patches is not None
    assert len(envelope.mutation.patches["rooms"]) == 1


def test_redirects():
    redir = flux_redirect("/dashboard")
    assert redir.redirect == "/dashboard"

    ext = flux_external_redirect("https://example.com/login")
    assert ext.external_redirect == "https://example.com/login"
    assert ext.to_envelope().mutation.externalRedirect == "https://example.com/login"

    with pytest.raises(ValueError, match="origin-relative"):
        flux_redirect("https://example.com")
    with pytest.raises(ValueError, match="HTTP"):
        flux_external_redirect("javascript:alert(1)")


def test_public_patch_helpers_and_plural_aliases():
    result = mutation(
        patches={
            "items": [
                replace_resource([]),
                merge_object({"count": 1}),
                replace_item(1, {"id": 1}),
                remove_item(2),
                append_item({"id": 3}),
            ]
        },
        invalidates=["summary"],
    )
    payload = result.to_envelope().mutation
    assert payload.patches is not None
    assert [patch["op"] for patch in payload.patches["items"]] == [
        "replace-resource",
        "merge-object",
        "replace-item",
        "remove-item",
        "append-item",
    ]
    assert payload.invalidate == ["summary"]


def test_mutation_rejects_unknown_or_incomplete_patch_operations():
    with pytest.raises(ValueError, match="unsupported"):
        mutation(patches={"rooms": {"op": "execute-code"}})
    with pytest.raises(ValueError, match="requires an id"):
        mutation(patches={"rooms": {"op": "remove-item"}})

"""Public resource/cache contract through real page and mutation requests."""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import fluxfast.cache as cache_module
from fluxfast import (
    FluxFast,
    MemoryResourceCache,
    Page,
    invalidate_resource,
    mutation,
    replace_resource,
    resource,
    scope,
)
from fluxfast.headers import HEADER_FLUXFAST, HEADER_KNOWN, encode_known_header


@pytest.mark.parametrize("scope_mode", ["default", "request", "public-zero-ttl"])
def test_non_reusable_resources_run_on_every_request_even_with_known_values(scope_mode):
    app = FastAPI()
    flux = FluxFast(app)
    loads = 0

    @flux.page("/value")
    async def page():
        def load():
            nonlocal loads
            loads += 1
            return {"constant": True}

        options = {"ttl": 60}
        if scope_mode == "request":
            options["scope"] = scope.request()
        elif scope_mode == "public-zero-ttl":
            options = {"scope": scope.public(), "ttl": 0}
        return Page("value/index", [resource("value", load, **options)])

    headers = {HEADER_FLUXFAST: "1"}
    with TestClient(app) as client:
        first = client.get("/value", headers=headers)
        assert first.status_code == 200
        version = first.json()["resources"]["value"]["version"]
        second = client.get("/value", headers={
            **headers, HEADER_KNOWN: encode_known_header({"value": version}),
        })
        assert second.status_code == 200
        assert second.json()["resources"] == {}
        assert loads == 2


def test_ttl_is_a_fixed_reuse_deadline_not_a_sliding_or_eager_refresh(monkeypatch):
    now = 100.0
    # Replace only the cache module clock, not the async runtime's clock.
    monkeypatch.setattr(cache_module, "time", SimpleNamespace(monotonic=lambda: now))
    app = FastAPI()
    flux = FluxFast(app)
    loads = 0

    @flux.page("/value")
    async def page():
        def load():
            nonlocal loads
            loads += 1
            return {"load": loads}

        return Page("value/index", [
            resource("value", load, scope=scope.public(), ttl=10),
        ])

    with TestClient(app) as client:
        def read():
            response = client.get("/value", headers={HEADER_FLUXFAST: "1"})
            assert response.status_code == 200
            return response.json()["resources"]["value"]["value"]

        assert read() == {"load": 1}
        now = 109.999
        assert read() == {"load": 1}
        now = 110.0
        assert loads == 1
        assert read() == {"load": 2}
        now = 119.999
        assert read() == {"load": 2}
        now = 120.0
        assert read() == {"load": 3}


@pytest.mark.parametrize("scope_kind", ["user", "tenant", "custom"])
def test_patch_and_invalidation_have_distinct_authoritative_cache_effects(scope_kind):
    app = FastAPI()
    cache = MemoryResourceCache()
    flux = FluxFast(app, cache=cache)
    values = {"a": 1, "b": 10}
    loads = {"a": 0, "b": 0}

    def owner_scope(owner):
        if scope_kind == "custom":
            return scope.custom("organization", owner)
        return getattr(scope, scope_kind)(owner)

    @flux.page("/accounts/{owner}")
    async def account(owner: str):
        def load():
            loads[owner] += 1
            return {"count": values[owner]}

        return Page("account/index", [
            resource("summary", load, scope=owner_scope(owner), ttl=300),
        ])

    @flux.mutation("/accounts/{owner}/{mode}")
    async def update(owner: str, mode: str):
        values[owner] += 1
        invalidates = []
        if mode == "client-only":
            invalidates = ["summary"]
        elif mode == "scoped":
            invalidates = [invalidate_resource("summary", scope=owner_scope(owner))]
        return mutation(
            patches={"summary": replace_resource({"count": values[owner]})},
            invalidates=invalidates,
        )

    headers = {HEADER_FLUXFAST: "1"}
    with TestClient(app) as client:
        def read(owner, known=None):
            request_headers = dict(headers)
            if known is not None:
                request_headers[HEADER_KNOWN] = encode_known_header({"summary": known})
            response = client.get(f"/accounts/{owner}", headers=request_headers)
            assert response.status_code == 200
            return response.json()["resources"]

        first = read("a")["summary"]
        other = read("b")["summary"]
        assert first["value"] == {"count": 1}
        assert other["value"] == {"count": 10}
        assert loads == {"a": 1, "b": 1}

        for mode, expected_count in [("patch", 2), ("client-only", 3)]:
            response = client.post(f"/accounts/a/{mode}", headers=headers)
            assert response.status_code == 200
            assert response.json()["mutation"]["patches"]["summary"] == [
                {"op": "replace-resource", "value": {"count": expected_count}},
            ]
            assert read("a")["summary"] == first
            assert read("a", first["version"]) == {}
            assert loads == {"a": 1, "b": 1}

        response = client.post("/accounts/a/scoped", headers=headers)
        assert response.status_code == 200
        assert response.json()["mutation"]["invalidate"] == ["summary"]
        # Invalidation does not eagerly execute either loader.
        assert loads == {"a": 1, "b": 1}
        assert read("b")["summary"] == other
        refreshed = read("a", first["version"])["summary"]
        assert refreshed["value"] == {"count": 4}
        assert refreshed["version"] != first["version"]
        assert loads == {"a": 2, "b": 1}
        assert read("a", refreshed["version"]) == {}
        assert loads == {"a": 2, "b": 1}

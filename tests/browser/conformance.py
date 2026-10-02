"""Framework-neutral, repository-owned application scenarios for adapter tests."""

import asyncio
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fluxfast import (
    FluxFast,
    Page,
    append_item,
    flux_external_redirect,
    flux_redirect,
    merge_object,
    mutation,
    remove_item,
    replace_item,
    replace_resource,
    resource,
    scope,
)
from pydantic import BaseModel, Field


class ContractContext(BaseModel):
    number: int
    query: dict[str, list[str]]
    cookie: str | None
    authorization: str | None


class ContractCounter(BaseModel):
    value: int
    label: str


class ContractItem(BaseModel):
    id: int
    name: str


class ContractAction(BaseModel):
    run: str = Field(min_length=1, max_length=80)
    action: Literal[
        "replace",
        "merge",
        "replace-item",
        "remove-item",
        "append",
        "invalidate",
        "internal",
        "external",
    ]
    label: str = Field(min_length=2, max_length=80)


class ContractControl(BaseModel):
    fail: bool
    value: int | None = None


def register(app: FastAPI, flux: FluxFast) -> None:
    """The same FastAPI fixture can be driven by any frontend harness."""
    context = flux.define_resource("contract-context", ContractContext)
    counter = flux.define_resource("contract-counter", ContractCounter)
    items = flux.define_resource("contract-items", list[ContractItem])
    shared = flux.define_resource("contract-shared", ContractCounter)
    lru = [
        flux.define_resource(f"contract-lru-{key}", ContractCounter)
        for key in ("a", "b", "c")
    ]
    counters: dict[str, dict[str, object]] = {}
    collections: dict[str, list[dict[str, object]]] = {}
    failures: dict[str, bool] = {}

    def ensure(run: str) -> None:
        counters.setdefault(run, {"value": 0, "label": "initial"})
        collections.setdefault(
            run, [{"id": 1, "name": "one"}, {"id": 2, "name": "two"}]
        )

    @flux.page("/contract/{number}")
    async def contract_page(number: int, request: Request) -> Page:
        run = request.query_params.get("run", "default")
        ensure(run)

        async def load_counter() -> dict[str, object]:
            await asyncio.sleep(0.25)
            if failures.get(run, False):
                raise RuntimeError("intentional contract resource failure")
            return dict(counters[run])

        return Page(
            component="contract/index",
            resources=[
                resource(
                    context,
                    lambda: {
                        "number": number,
                        "query": {
                            key: request.query_params.getlist(key)
                            for key in request.query_params
                        },
                        "cookie": request.cookies.get("fixture_session"),
                        "authorization": request.headers.get("authorization"),
                    },
                    scope=scope.request(),
                ),
                resource(
                    counter, load_counter, scope=scope.custom("adapter-contract", run)
                ),
                resource(
                    items,
                    lambda: [dict(item) for item in collections[run]],
                    scope=scope.custom("adapter-contract", run),
                ),
                resource(
                    shared,
                    lambda: {"value": 1, "label": "shared"},
                    scope=scope.public(),
                    ttl=60,
                ),
            ],
        )

    @flux.page("/contract-cache/{number}")
    async def contract_cache(number: int) -> Page:
        return Page(
            component="contract-cache/index",
            resources=[
                resource(
                    shared,
                    lambda: {"value": 1, "label": "shared"},
                    scope=scope.public(),
                    ttl=60,
                ),
            ],
        )

    @flux.page("/contract-resource-cache/{number}")
    async def contract_resource_cache(number: int) -> Page:
        selected = number % len(lru)
        return Page(
            component="contract-cache/index",
            resources=[
                resource(
                    lru[selected],
                    lambda: {"value": selected, "label": "LRU"},
                    scope=scope.public(),
                ),
            ],
        )

    @flux.mutation("/contract-action")
    async def contract_action(payload: ContractAction):
        ensure(payload.run)
        current = counters[payload.run]
        collection = collections[payload.run]
        if payload.action == "replace":
            counters[payload.run] = {"value": 10, "label": payload.label}
            return mutation(
                patch={"contract-counter": replace_resource(counters[payload.run])}
            )
        if payload.action == "merge":
            current["label"] = payload.label
            return mutation(
                patch={"contract-counter": merge_object({"label": payload.label})}
            )
        if payload.action == "replace-item":
            collection[0] = {"id": 1, "name": payload.label}
            return mutation(patch={"contract-items": replace_item(1, collection[0])})
        if payload.action == "remove-item":
            collections[payload.run] = [item for item in collection if item["id"] != 2]
            return mutation(patch={"contract-items": remove_item(2)})
        if payload.action == "append":
            item = {"id": 3, "name": payload.label}
            collection.append(item)
            return mutation(patch={"contract-items": append_item(item)})
        if payload.action == "invalidate":
            current["value"] = int(current["value"]) + 1
            return mutation(invalidate=["contract-counter"])
        if payload.action == "internal":
            return flux_redirect(f"/contract/1?run={payload.run}")
        return flux_external_redirect("https://outside.fluxfast.invalid/landing")

    @app.post("/contract-control/{run}")
    async def contract_control(run: str, payload: ContractControl):
        ensure(run)
        failures[run] = payload.fail
        if payload.value is not None:
            counters[run]["value"] = payload.value
        return {"fail": payload.fail}

    @app.get("/contract-canonical")
    async def contract_canonical():
        return RedirectResponse("/rooms")

    @app.get("/contract-external-redirect")
    async def contract_external_redirect(request: Request):
        return RedirectResponse(
            request.query_params.get(
                "target", "https://outside.fluxfast.invalid/forbidden"
            )
        )

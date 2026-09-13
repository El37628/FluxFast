"""Request injection must preserve server authority with postponed annotations."""

from __future__ import annotations

from typing import Annotated

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import BaseModel

from fluxfast import FluxFast, Page, mutation, replace_resource, resource, scope

IncomingRequest = Request


class AnnotationPayload(BaseModel):
    value: int


@pytest.mark.parametrize("kind", ["page", "mutation"])
@pytest.mark.parametrize("annotation", ["plain", "alias", "annotated"])
def test_postponed_request_annotation_preserves_authenticated_identity(
    kind: str,
    annotation: str,
) -> None:
    app = FastAPI()
    flux = FluxFast(app)

    async def plain(incoming: Request, payload: AnnotationPayload):
        return incoming, payload

    async def alias(incoming: IncomingRequest, payload: AnnotationPayload):
        return incoming, payload

    async def annotated(
        incoming: Annotated[IncomingRequest, "server identity"],
        payload: AnnotationPayload,
    ):
        return incoming, payload

    endpoint = {"plain": plain, "alias": alias, "annotated": annotated}[annotation]
    # Preserve the actual annotated endpoint signature, including a separate
    # postponed Pydantic input; do not patch a wrapper's annotations in the test.
    if kind == "page":

        async def page_plain(incoming: Request):
            return Page(
                "Test",
                [
                    resource(
                        "identity",
                        lambda: incoming.cookies.get("session"),
                        scope=scope.request(),
                    )
                ],
            )

        async def page_alias(incoming: IncomingRequest):
            return await page_plain(incoming)

        async def page_annotated(
            incoming: Annotated[IncomingRequest, "server identity"],
        ):
            return await page_plain(incoming)

        flux.page("/annotated")(
            {"plain": page_plain, "alias": page_alias, "annotated": page_annotated}[
                annotation
            ]
        )
    else:
        from functools import wraps

        @wraps(endpoint)
        async def handler(*args, **kwargs):
            incoming, payload = await endpoint(*args, **kwargs)
            return mutation(
                patches={
                    "identity": replace_resource(
                        {
                            "session": incoming.cookies.get("session"),
                            "value": payload.value,
                        }
                    )
                }
            )

        flux.mutation("/annotated")(handler)
    with TestClient(app) as client:
        headers = {"X-FluxFast": "1", "Cookie": "session=server-alice"}
        if kind == "page":
            response = client.get("/annotated", headers=headers)
            assert response.status_code == 200
            assert response.json()["resources"]["identity"]["value"] == "server-alice"
        else:
            response = client.post("/annotated", headers=headers, json={"value": 7})
            assert response.status_code == 200
            assert response.json()["mutation"]["patches"] == {
                "identity": [replace_resource({"session": "server-alice", "value": 7})]
            }

"""Deterministic streaming reverse proxy for three browser-test workers."""

from __future__ import annotations

import os

import httpx2
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask


def _required_environment(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required by the distributed browser proxy")
    return value.rstrip("/")


WORKER_A = _required_environment("FLUXFAST_TEST_WORKER_A_URL")
WORKER_B = _required_environment("FLUXFAST_TEST_WORKER_B_URL")
WORKER_C = _required_environment("FLUXFAST_TEST_WORKER_C_URL")
_EXCLUDED_HEADERS = {
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "transfer-encoding",
}

app = FastAPI()
client = httpx2.AsyncClient(timeout=None)


def _target(request: Request) -> str:
    if request.url.path == "/distributed-live/increment":
        return WORKER_C
    if request.query_params.get("client") == "b":
        return WORKER_B
    return WORKER_A


def _headers(headers) -> dict[str, str]:
    return {
        key: value
        for key, value in headers.items()
        if key.lower() not in _EXCLUDED_HEADERS
    }


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ready": True}


@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
async def proxy(path: str, request: Request):
    query = request.url.query
    suffix = f"?{query}" if query else ""
    url = f"{_target(request)}/{path}{suffix}"
    upstream_request = client.build_request(
        request.method,
        url,
        headers=_headers(request.headers),
        content=await request.body(),
    )
    upstream = await client.send(upstream_request, stream=True)
    response_headers = _headers(upstream.headers)
    if request.headers.get("X-FluxFast-Live") == "1":
        return StreamingResponse(
            upstream.aiter_raw(),
            status_code=upstream.status_code,
            headers=response_headers,
            background=BackgroundTask(upstream.aclose),
        )
    try:
        content = await upstream.aread()
    finally:
        await upstream.aclose()
    return Response(
        content=content,
        status_code=upstream.status_code,
        headers=response_headers,
    )


app.router.add_event_handler("shutdown", client.aclose)

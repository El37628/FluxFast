# FluxFast for FastAPI

The Python package provides FastAPI page routes, scoped versioned resources, a
bounded in-memory cache, concurrent loader resolution, mutation helpers, 422
mapping, redirects, and the `fluxfast/1` protocol.

```bash
python -m pip install fluxfast
```

```python
from fastapi import FastAPI
from fluxfast import FluxFast, Page, resource, scope

app = FastAPI()
flux = FluxFast(app)

@flux.page("/")
async def home():
    return Page(
        "home/index",
        resources=[
            resource("news", load_news, scope=scope.public(), ttl=60),
        ],
    )
```

Reusable data must declare an appropriate public, user, tenant, or custom scope.
See the repository protocol and caching documentation for wire and invalidation
semantics.

For a Next.js consumer, install its backend and run both development processes
under one supervisor:

```bash
python -m pip install -e backend
fluxfast dev backend.app.main:app
```

The CLI starts FastAPI on an available internal loopback port and Next on the
browser-facing development port. The companion Next config uses the injected
server-only address, so browser requests stay same-origin.

## Application & Resource Contracts

Declare server-owned contracts with Pydantic for typed resources and general
application types:

```python
from pydantic import BaseModel
from fluxfast import FluxFast

app = FastAPI()
flux = FluxFast(app)

class Room(BaseModel):
    id: int
    number: str

class CreateRoomInput(BaseModel):
    number: str
    floor: int

ROOMS = flux.define_resource("rooms", list[Room])
CREATE_ROOM = flux.define_type(
    "CreateRoomInput",
    CreateRoomInput,
    mode="validation",
)
```

Export deterministic `fluxfast-schema/2` developer manifests and generate frontend
contracts with one command:

```bash
fluxfast types backend.app.main:app --frontend frontend
```

Use `--check` in CI to detect contract drift without writing files. See the
[contract documentation](https://github.com/El37628/FluxFast/blob/main/docs/contracts.md)
and [type safety guide](https://github.com/El37628/FluxFast/blob/main/docs/type-safety.md).

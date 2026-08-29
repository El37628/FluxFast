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

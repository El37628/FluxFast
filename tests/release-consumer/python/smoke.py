from importlib.metadata import files, version
from pathlib import Path

import fluxfast
from fastapi import FastAPI
from fluxfast import FluxFast, Page, resource, scope

installed_module = Path(fluxfast.__file__).resolve()
assert "site-packages" in installed_module.parts, installed_module
assert fluxfast.__version__ == version("fluxfast")
installed_files = files("fluxfast") or []
assert any(str(file).endswith("licenses/LICENSE") for file in installed_files)

app = FastAPI()
runtime = FluxFast(app)


@runtime.page("/health")
async def health() -> Page:
    return Page(
        component="health/index",
        resources=[
            resource(
                "health",
                lambda: {"ok": True},
                scope=scope.public(),
                ttl=1,
            )
        ],
    )


assert app.state.fluxfast_cache is runtime.cache
assert any(getattr(route, "path", None) == "/health" for route in app.routes)
print(f"Python release artifact {fluxfast.__version__} passed the consumer smoke test.")

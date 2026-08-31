"""Current Python backend used with the previous JavaScript packages."""

from fastapi import FastAPI, Request
from fluxfast import FluxFast, Page, resource, scope

app = FastAPI()
flux = FluxFast(app)
analytics_loads = 0


@flux.page("/")
async def home(request: Request) -> Page:
    async def load_analytics() -> dict[str, int | str]:
        global analytics_loads
        analytics_loads += 1
        return {
            "revenue": 120_000,
            "load": analytics_loads,
            "capabilities": request.headers.get("X-FluxFast-Capabilities", ""),
        }

    return Page(
        component="home/index",
        resources=[
            resource(
                "analytics",
                load_analytics,
                scope=scope.public(),
                live=True,
            )
        ],
    )

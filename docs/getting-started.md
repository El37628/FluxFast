# Getting started

This guide builds a small FluxFast application from an empty directory. It
uses FastAPI for routes, resources, mutations, and validation, and a Next.js 16
frontend for rendering. The finished application has one public browser origin;
you do not configure a backend URL or CORS.

## Prerequisites

Use Python 3.11 or newer and Node.js 22 or 24. The commands below use npm, but
the FluxFast CLI also detects pnpm, Yarn, and Bun projects.

## Install the backend and frontend

Create the project and install the Python package in a virtual environment:

```bash
mkdir hello-fluxfast
cd hello-fluxfast
python -m venv .venv
source .venv/bin/activate
python -m pip install fluxfast
```

Create a supported Next.js application, install the adapter, and let FluxFast
configure its catch-all page, transport route, health route, and page registry:

```bash
npx create-next-app@16 frontend \
  --ts --eslint --app --src-dir --no-tailwind --use-npm \
  --import-alias="@/*" --yes
cd frontend
npm install @fluxfast/next
npx fluxfast init --yes
cd ..
```

`fluxfast init` moves the starter page to
`frontend/src/flux-pages/home/index.tsx`. Each backend `Page.component` value
selects a module below `src/flux-pages`; it never accepts an arbitrary import.

## Define pages, a shared resource, and a mutation

Create `backend/main.py`. The `site-summary` resource is declared once and
included by both pages. Its Pydantic model is the authoritative server and
generated TypeScript contract. The mutation body is also a Pydantic model, so
FastAPI remains authoritative even when the frontend validates first.

This sample has no private data, so its reusable cache scope is explicitly
public. Use `scope.user(...)` or `scope.tenant(...)` for private values, enforce
authorization in FastAPI dependencies, and apply your normal CSRF protection to
mutations.

<!-- fresh-consumer:path=backend/main.py -->
```python
from fastapi import FastAPI
from fluxfast import FluxFast, Page, invalidate_resource, mutation, resource, scope
from pydantic import BaseModel, Field

app = FastAPI()
flux = FluxFast(app)
visits = 0


class SiteSummary(BaseModel):
    message: str
    visits: int


class IncrementVisitsInput(BaseModel):
    amount: int = Field(ge=1, le=10)


SITE_SUMMARY = flux.define_resource("site-summary", SiteSummary)


def load_site_summary() -> dict[str, object]:
    return {"message": "Hello from FastAPI", "visits": visits}


def shared_summary():
    return resource(
        SITE_SUMMARY,
        load_site_summary,
        scope=scope.public(),
        ttl=30,
    )


@flux.page("/", name="home")
async def home() -> Page:
    return Page(
        component="home/index",
        resources=[shared_summary()],
    )


@flux.page("/about", name="about")
async def about() -> Page:
    return Page(
        component="about/index",
        resources=[shared_summary()],
    )


@flux.mutation("/visits", name="increment_visits")
async def increment_visits(body: IncrementVisitsInput):
    global visits
    visits += body.amount
    return mutation(
        invalidates=[
            invalidate_resource("site-summary", scope=scope.public()),
        ]
    )
```

Replace `frontend/src/flux-pages/home/index.tsx`. The generated resource key
gives `summary` its `SiteSummary` type. The generated mutation body, validator,
and helper all come from `IncrementVisitsInput`; no TypeScript contract is
maintained by hand.

<!-- fresh-consumer:path=frontend/src/flux-pages/home/index.tsx -->
```tsx
"use client";

import type { FormEvent } from "react";
import { Link, useForm, useResource, useRouter } from "@fluxfast/next";
import { mutations } from "@/.fluxfast/mutations.generated";
import {
  resourceKeys,
  type IncrementVisitsBody,
} from "@/.fluxfast/types.generated";
import { IncrementVisitsBodyValidator } from "@/.fluxfast/validators.generated";

export default function HomePage() {
  const router = useRouter();
  const summary = useResource(resourceKeys.siteSummary);
  const form = useForm<IncrementVisitsBody>(
    { amount: 1 },
    { validator: IncrementVisitsBodyValidator },
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.validate()) return;
    await mutations.incrementVisits(router, { body: form.data });
    form.reset();
  }

  return (
    <main>
      <h1>FluxFast starter</h1>
      <p>{summary.message}</p>
      <p>Visits: {summary.visits}</p>

      <form onSubmit={submit}>
        <label htmlFor="visit-amount">Visits to add</label>
        <input
          id="visit-amount"
          type="number"
          min={1}
          max={10}
          value={form.data.amount}
          onChange={event => form.setData("amount", Number(event.target.value))}
        />
        {form.errors.amount ? <p role="alert">{form.errors.amount}</p> : null}
        <button type="submit">Add visits</button>
      </form>

      <Link href="/about">About this app</Link>
    </main>
  );
}
```

Create `frontend/src/flux-pages/about/index.tsx`. It consumes the same declared
resource without repeating its shape.

<!-- fresh-consumer:path=frontend/src/flux-pages/about/index.tsx -->
```tsx
"use client";

import { Link, useResource } from "@fluxfast/next";
import { resourceKeys } from "@/.fluxfast/types.generated";

export default function AboutPage() {
  const summary = useResource(resourceKeys.siteSummary);

  return (
    <main>
      <h1>About this app</h1>
      <p>The shared visit count is {summary.visits}.</p>
      <Link href="/">Home</Link>
    </main>
  );
}
```

## Generate and check the contracts

Run the Python-owned full-stack generator from the project root:

```bash
fluxfast types backend.main:app --frontend frontend
fluxfast types backend.main:app --frontend frontend --check
```

The first command imports the FastAPI application without executing page,
resource, or mutation handlers. It writes the developer manifest plus generated
resource types, validators, route builders, mutation helpers, and allowlisted
page registry under `frontend/src/.fluxfast/`. The second command is read-only
and fails when those files drift from Python or the page modules.

Check the initialized frontend too:

```bash
cd frontend
npx fluxfast doctor
npm run build
cd ..
```

## Run in development

One command supervises both runtimes:

```bash
fluxfast dev backend.main:app --frontend frontend
```

Open `http://127.0.0.1:3000`. Next.js is the only public browser origin;
FastAPI listens on a private supervisor-selected port.

## Build and start production

Build the checked frontend artifact, then start the same one-origin topology:

```bash
fluxfast build --app backend.main:app --frontend frontend
fluxfast start backend.main:app --frontend frontend
```

Production health endpoints are available through that public origin at
`/_fluxfast/healthz` and `/_fluxfast/readyz`. See [Production](production.md)
for workers, timeouts, proxies, process managers, and shutdown behavior.

## Where to go next

- [Typed contracts and code generation](type-safety.md)
- [Mutations and forms](mutations.md)
- [Native client validation](validation.md)
- [Resource caching and security scopes](caching.md)
- [Next.js adapter](nextjs-adapter.md)

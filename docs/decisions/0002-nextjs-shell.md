# ADR-0002: Next.js is an adapter and shell

Status: accepted.

FastAPI owns application URLs and component identifiers. Next.js provides the
initial document, React, compilation, chunk splitting, and an optional catch-all
entry. Subsequent navigation goes directly through the FluxFast transport.

The component generator creates an allowlist of lazy imports. Arbitrary backend
strings are never converted into filesystem imports. `@fluxfast/core` remains
free of React and Next imports so other adapters can reuse it.

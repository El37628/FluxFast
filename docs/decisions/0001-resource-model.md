# ADR-0001: Synchronize resources instead of page props

Status: accepted.

FluxFast models application data as independently versioned logical resources.
A page descriptor identifies which UI module is active but does not own a large
props object.

This enables cross-page reuse, granular subscriptions and invalidation, smaller
repeat payloads, and concurrent loading. The cost is an explicit resource store
and resource-key design. Large reusable values belong in resources; page `meta`
is reserved for small page-level information.

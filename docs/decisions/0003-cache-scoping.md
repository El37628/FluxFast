# ADR-0003: Explicit server cache scopes

Status: accepted.

The same logical wire key can represent data for different users or tenants.
Server cache keys therefore combine an explicit scope fingerprint with the
logical key. Positive TTL resources without a supplied scope remain
request-scoped rather than defaulting to public.

This adds small declaration overhead but prevents accidental cross-user and
cross-tenant reuse. Distributed caching may later implement the same backend
interface without changing resource APIs.

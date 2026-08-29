# Security Policy

Please report vulnerabilities privately to the project maintainers rather than
opening a public issue. Include affected versions, reproduction steps, and the
expected impact.

FluxFast cache scopes are a security boundary. Personalized resources must use
`scope.user(...)`, `scope.tenant(...)`, or an appropriate custom scope. A
positive TTL without an explicit scope remains request-scoped and is not shared.

FluxFast does not implement authentication or CSRF protection. FastAPI
dependencies remain authoritative, and applications using cookie credentials
must configure CSRF and CORS deliberately. Component identifiers resolve only
through the generated allowlist; never replace it with arbitrary runtime imports.

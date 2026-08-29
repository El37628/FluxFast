# Security Policy

## Supported versions

The latest minor release receives security fixes. Before 1.0, upgrade to the
latest `0.x` minor before reporting an issue unless the vulnerability prevents
that upgrade.

## Reporting a vulnerability

Use GitHub's private
[vulnerability reporting form](https://github.com/El37628/FluxFast/security/advisories/new)
rather than opening a public issue. Include affected versions, reproduction
steps, expected impact, and any known mitigations. Do not include live secrets
or personal data in the report.

The maintainers will acknowledge a report, assess severity, and coordinate a
fix and disclosure before publishing technical details.

## Application responsibilities

FluxFast cache scopes are a security boundary. Personalized resources must use
`scope.user(...)`, `scope.tenant(...)`, or an appropriate custom scope. A
positive TTL without an explicit scope remains request-scoped and is not shared.

FluxFast does not implement authentication or CSRF protection. FastAPI
dependencies remain authoritative, and applications using cookie credentials
must configure CSRF and CORS deliberately. Component identifiers resolve only
through the generated allowlist; never replace it with arbitrary runtime imports.

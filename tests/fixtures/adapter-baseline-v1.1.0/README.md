# Published v1.1 adapter baseline

These six generated artifacts were captured from the actual npm
`@fluxfast/next@1.1.0` and `@fluxfast/core@1.1.0` tarballs on 2026-10-01, before
the Phase A server/tooling extraction. The archives' SHA-512 integrities were
verified against npm metadata before executing the published generator.
`baseline.json` records those integrities, the page inputs, artifact SHA-256
digests, and published CLI output for both `src/` and root layouts.

The manifest input is `tests/fixtures/schema/fluxfast-schema-v2.json`, parsed
and serialized with two-space indentation plus one LF, with only `producer`
set to `1.1.0`. It covers resource models, general contracts, aliases, named
parameterized page routes, JSON mutation bodies, and a deliberately unsupported
native-validator pattern. Page inputs cover sorted TypeScript/JavaScript modules,
group/dynamic filenames, and excluded tests, stories, and private modules.

The published generator and the real published `fluxfast` binary were run in
each layout. All six artifacts matched across those paths. CLI diagnostics and
successful `generate --schema-file`/`generate --check` output are retained
without absolute machine paths. Tests consume these fixtures offline; they do
not download packages or update snapshots while running.

The new baseline complements, rather than replaces, the historical semantic
`generated-contract-v0.9.0.json` gate. Preserve these bytes throughout the
foundation extraction. Fix accidental candidate drift in the owning generator;
do not recapture the baseline from the candidate to make a failing test pass.
LF checkout rules keep this byte comparison valid on Windows as well as Linux.

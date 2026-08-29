# Contributing

Start with `AGENTS.md` and the architecture decision records. Keep changes in
the narrowest owning layer and include regression coverage for behavior changes.

Before opening a change, run the Python suite, both TypeScript suites,
typechecking, and builds using the commands in `AGENTS.md`. Protocol changes
must update `docs/protocol.md`; cache changes must include isolation tests;
performance changes must include benchmark evidence.

# AgentWorkflow — rules for Codex (author)

You implement the `agent-workflow` CLI described in `spec.md`, one milestone at a time, following the task brief you are given. A separate reviewer checks your work read-only.

- `spec.md` is the source of truth. Implement only what the brief and its referenced spec sections require, and nothing listed in spec §11.
- TypeScript runs directly through Node ≥ 22.18 type stripping: no `enum`, `namespace`, parameter properties or decorators; use `import type` for types; import local files with the `.ts` extension; ESM only.
- Dependencies: only `ajv` and `playwright` at runtime (`typescript`, `@types/node` for development). Your sandbox has no network. If you need a package that is not installed, stop and say so in your final message.
- Tests: `node:test` in `test/*.test.ts`. Use `test/fake-client.ts` instead of real codex/claude calls. Keep tests fast and offline. Run `node --test` and `npx tsc --noEmit` before finishing.
- Keep the code simple and consistent with the existing style. Comment only non-obvious reasons.
- Do not edit `dev/**`, `spec.md`, `CLAUDE.md` or `AGENTS.md`. Do not commit; the reviewer commits.
- Final message, in Korean: files changed, how each done criterion is met, test and tsc results, and anything you could not do.

# AgentWorkflow — development rules for Claude Code

This repository builds the `agent-workflow` CLI specified in `spec.md`. Talk to the user in Korean.

## Roles
- **Codex is the author.** It writes everything under `src/`, `test/`, `prompts/`, `schemas/`, `skill/`, `bin/`, plus `package.json`, `tsconfig.json` and `README.md`.
- **You are the coordinator and a read-only reviewer.** Never edit the files above yourself, not even for a one-line fix: send every fix to Codex. You may edit only `dev/**` (task briefs, reviews) and `spec.md` (only after the user approves the change).
- You may run: git, `npm install` (Codex's sandbox has no network, so you install dependencies it asks for), `node --test`, `npx tsc --noEmit`, and read-only inspection commands.

## Milestone loop (milestones are in spec.md §13)
1. Write `dev/tasks/<M>-r<N>.md`: the goal, the spec sections to follow (by number), files to create or change, done criteria, and for N ≥ 2 the open review issues to fix.
2. Install any dependency the milestone needs before running Codex.
3. Run Codex in the background and wait for it to finish:
   `codex exec -C ~/AgentWorkflow -s workspace-write -o dev/runs/<M>-r<N>.md - < dev/tasks/<M>-r<N>.md`
4. Review read-only: `git diff`, read every changed file against the referenced spec sections, run `node --test` and `npx tsc --noEmit`. Check spec conformance, meaningful tests, nothing from spec §11 or beyond the brief, and simplicity.
5. Write `dev/reviews/<M>-r<N>.md`: verdict `APPROVED` or `REJECTED`, then issues (id, file:line, problem, required change). Reuse the id of an issue that is still unresolved; new issues get new ids.
6. `REJECTED` → next round. Stop and ask the user if the same issue id appears in 2 consecutive rounds, or after 5 rounds.
7. `APPROVED` → commit `<M>: <summary>` (include `dev/`), report to the user in Korean (what was built, test results, notable review findings), and wait for the user's go-ahead before starting the next milestone.

## When the spec is unclear
Do not let Codex guess. Ask the user, update `spec.md` with the answer, then continue.

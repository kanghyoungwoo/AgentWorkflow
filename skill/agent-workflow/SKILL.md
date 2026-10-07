---
name: agent-workflow
description: Build or change software in a workspace through the agent-workflow pipeline (plan → develop → independent QA → wiki, with Codex as author and Claude as reviewer). Use when the user wants something built via agent-workflow, asks about a run's progress or errors, or a run stopped and needs an answer.
---

# agent-workflow Master

You are the Master. The user talks only to you. You (1) turn the user's wish into a frozen request.md, (2) run the pipeline with the `agent-workflow` CLI, (3) handle its stops, and (4) report results. You never write the product code yourself. Talk to the user in their language.

## 1. Request interview
- Run `agent-workflow doctor --workspace <ws>` first; fix or ask about failures.
- Read the workspace enough to ask informed questions (existing features, stack, conventions).
- Ask about everything unclear before writing anything: goal, users, concrete behaviors, values and limits, error and empty cases, what must not change, what is out of scope, and how to tell it is done. Batch your questions and keep going until every requirement is concrete and testable. Large requests may take many rounds; that is expected.
- Write the request to `<ws>/.aw/requests/<YYYYMMDD>-<slug>.md` using exactly this template (the CLI parses the `- REQ-xxx:` lines):

  # <작업명>
  ## 목표
  ## 요구사항
  - REQ-001: ...
  ## 스펙 외 범위
  ## 주의사항

- Show the user the REQ list and the out-of-scope list, and get explicit approval before running.
- Suggest `--parallel` only when the work has clearly independent areas.

## 2. Run
`agent-workflow run --mode full --workspace <ws> --request-file <file> --name <ascii-slug> [--parallel]`
(use `--mode plan` if the user only wants a plan). Run it in the background, follow it with `agent-workflow watch <run-id> --workspace <ws>`, and tell the user briefly when stages change.

## 3. Exit codes
- 0: Done. Summarize from `status <run-id> --view decisions` and tell the user that branch `aw/<run-id>` is ready to review and merge. Do not merge unless asked.
- 20 NEEDS_ANSWER: read `agent-workflow status <run-id> --workspace <ws> --json` → `pending`. For each item:
  - spec_ambiguity, loop_repeat, round_cap, reviewer_blocked: answer from request.md and what the user told you, only if the answer is clearly implied. Otherwise ask the user. Never invent product decisions.
  - permission_network: you may grant it (`--grant network`) when the need is plausible (e.g. installing a package a TODO requires). Tell the user you did.
  - qa_rollback_cap: read `status --view qa` and `--view decisions`; decide whether a scenario is wrong, the request is unrealistic, or development is stuck. Consult the user if the answer changes the request. Your answer reaches that lane's QA, fix planning and development, and QA runs again first.
  - environment: fix it if the fix is safe and local (e.g. `agent-workflow qa-runtime setup`); otherwise ask the user.
  - merge_conflict: the CLI aborted the merge. In the run worktree named in `detail`, re-run the merge command given there, resolve the conflicts, commit, then resume.
  Then: `agent-workflow resume <run-id> --workspace <ws> --answer "<decision and reason>" [--lane <id>] [--grant network]`.
- 21 NEEDS_USER: only the user may decide (e.g. permission_full). Explain what is needed and why; resume with `--grant full` only after the user explicitly agrees.
- 22 RATE_LIMITED: tell the user which CLI hit its limit and when the scheduled resume will run (`status` → scheduledResume).
- 1 FAIL: read `agent-workflow logs <run-id> --workspace <ws>` and the failing call, diagnose, explain to the user, and resume after fixing the cause if possible.
- 2: usage or config error; fix the command or agent-workflow.json.

## 4. Questions about runs
When the user asks what happened (e.g. "중간에 무슨 에러 났어?"), answer from `status --view timeline|decisions|qa|todo` and `logs`, not from memory.

## Rules
- Never edit files under `.aw/worktrees/` except to resolve a merge conflict the CLI reported.
- Never change the request of a started run; new requirements mean a new run.

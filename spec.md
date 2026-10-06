# agent-workflow 구현 명세서

> 기반 문서: `agent_workflow_blueprint.md` (영상 분석 설계도)
> 작성일: 2026-10-06 · 상태: **초안 — 사용자 검토 후 구현 착수**
> 실행 환경: **dev-kang** (Rocky Linux 9.7)

---

## 0. 확정된 결정 사항

| 항목 | 결정 |
|---|---|
| 실행 환경 | **Linux 전용**, dev-kang에서 개발과 운용(§0.2) |
| 실행 방식 | Node.js CLI(`agent-workflow`)가 오케스트레이터로 `codex`, `claude` CLI를 하위 프로세스로 호출 |
| 모델 조합 | 작업(기획·개발·Wiki 작성) = **Codex**, 검수 = **Claude**, 독립 QA = **Claude**(별도 세션) |
| Master | **Claude Code 대화 세션 + 스킬**(`skill/agent-workflow/SKILL.md`) |
| 적용 대상 | 범용 CLI. `--workspace`로 대상 지정, 프로젝트별 정보는 대상의 `agent-workflow.json`에 둠 |
| 범위 | 순차 4단계 + 교차 검수 + **병렬 레인** + ai-log + resume. **Seed/Fork는 제외** |
| QA 방식 | 시나리오마다 `browser`(Playwright 스크립트 + 스크린샷) 또는 `cli`(셸 명령 + 로그) |
| git | 필수. 런 브랜치 `aw/<run-id>`에 단계 승인 시 자동 커밋, main 머지는 사람/Master가 함. 레인은 git worktree로 격리 |
| 작업 AI 권한 | 기본 `-s workspace-write`. 더 필요하면 BLOCKED → 권한 상향 후 그 단계만 재실행 |
| 루프 한도 | 같은 지적 2회 연속이면 Master 호출, 단계당 검수 최대 5라운드, QA 실패 롤백 최대 3회 (설정 가능) |
| 사용량 한도 소진 | 상태 저장 → 종료 코드 22 → 리셋 시각을 알 수 있으면 `at`으로 resume 1회 예약 |
| 언어/런타임 | TypeScript, 빌드 없이 Node ≥ 22.18의 타입 스트리핑으로 실행 |
| 문서 언어 | 산출물(request, TODO, 판정 사유, timeline, wiki)은 한국어. 프롬프트 본문, JSON 키, enum은 영어 |
| 레인 분할 | 기획 작업 AI가 분할안 작성 → 검수 AI 승인 → 오케스트레이터가 ownedPaths 겹침을 기계 검사(겹치면 순차로 전환) |
| CLI 명령 | `doctor`, `run`, `resume`, `status`, `logs`, `list`, `watch`, `cleanup`, `qa-runtime setup` |

### 0.1 질문하지 않고 정한 가정 (검토 필요)

| # | 가정 | 이유 |
|---|---|---|
| A1 | 실행 기록은 `<workspace>/ai-log/`, worktree는 `<workspace>/.aw/worktrees/`에 둔다. 두 경로를 `.git/info/exclude`에 추가한다(추적되는 파일은 건드리지 않음) | 영상 구조를 따르면서 대상 저장소를 오염시키지 않음 |
| A2 | 런은 실행 시점의 `HEAD`에서 worktree를 만들어 진행한다. **사용자 작업 사본은 건드리지 않고, 커밋하지 않은 변경은 런에 포함되지 않는다**(doctor가 경고) | 사용자 작업과 충돌하지 않게 함 |
| A3 | `permission_network` 상향은 Master가 스스로 승인할 수 있다(종료 코드 20). `permission_full`은 사람만 승인한다(21) | "Master가 승인" 결정을 따르되, 샌드박스 해제는 사람에게 맡김 |
| A4 | **에이전트 호출은 매번 새 세션이다.** 라운드 사이에는 이전 출력, 지적 사항, 답변을 프롬프트로 다시 넣는다. 세션 resume은 쓰지 않는다 | Seed/Fork를 뺐으므로 세션 ID 파싱이나 resume 의미 차이에 의존하지 않는 것이 가장 단순하고 결정적임 |
| A5 | QA 실패 후 재실행할 때는 해당 범위의 시나리오를 **전부** 다시 돌린다 | 회귀 검출. 비용보다 정확성을 우선 |
| A6 | 코드의 `AI-NOTE:` 주석은 개발 작업 AI가 남긴다. Wiki 단계는 `wikiDir`만 수정한다 | QA를 통과한 코드를 Wiki 단계에서 다시 건드리지 않음 |
| A7 | Wiki 디렉터리는 기본 `docs/wiki`이고, 없으면 최소 구조(index/architecture/decisions/log)로 만든다 | 영상의 "최소 Wiki" |
| A8 | 역할별 `model`의 기본값은 `null`이다(각 CLI의 기본 모델 사용) | 모델 이름을 추측하지 않음 |
| A9 | Master 스킬은 `~/.claude/skills/agent-workflow/`로 복사해서 설치한다(README에 안내) | 설치 명령을 따로 만들지 않음 |
| A10 | `setupCommand`(예: `npm ci`)는 worktree를 만든 직후 **오케스트레이터가** 실행한다(샌드박스 밖이라 네트워크 가능) | 새 worktree에는 node_modules 등이 없음 |
| A11 | 병렬 레인을 합친 뒤의 통합 검증은 `testCommand`와 전체 QA 시나리오 재실행이다 | 영상의 "모두 끝나면 합쳐서 다시 검증" |
| A12 | FAIL(1)도 resume할 수 있다. `resume`은 실패한 단계를 처음부터 다시 실행한다 | 상태 종류를 줄임 |
| A13 | 개발 검수 AI는 request.md도 본다(개발 작업 AI는 TODO만 본다) | "의도에 맞게 했는지" 판단에 필요 |
| A14 | Master(Claude Code)는 dev-kang에 SSH로 접속해 **tmux 안에서** 실행한다 | 런이 길어서 SSH가 끊겨도 Master와 CLI가 살아 있어야 함 |
| A15 | resume 예약은 `at`으로 한다(systemd user timer는 쓰지 않음) | dev-kang은 `Linger=no`라 로그아웃하면 user timer가 멈춤. atd는 시스템 서비스로 동작 중 |

### 0.2 dev-kang 환경 (2026-10-06 확인)

| 항목 | 값 | 비고 |
|---|---|---|
| OS | Rocky Linux 9.7, kernel 5.14, SELinux + Landlock 활성 | |
| Node / npm / git | v24.19.0 (nvm) / 11.17.0 / 2.47.3 | Node ≥ 22.18 충족 |
| codex | codex-cli 0.160.1, ChatGPT 로그인됨 | |
| claude | 2.1.243, **로그인 안 됨** | 구현 전에 사용자가 직접 로그인해야 함 |
| Codex 샌드박스 | read-only는 쓰기 차단 ✓, workspace-write는 cwd와 /tmp만 쓰기 가능 ✓, 네트워크 차단 ✓, `-c sandbox_workspace_write.network_access=true`로 네트워크 허용 ✓ | `codex sandbox`로 토큰 없이 확인 |
| 예약 | `at` 설치, atd active ✓. 예약 작업이 현재 PATH(nvm 포함)를 그대로 가져감 ✓. `Linger=no` | |
| QA | Playwright chromium 의존 패키지 13종 모두 설치됨, DISPLAY 없음(headless), 포트 4100~4103 비어 있음 | sudo는 비밀번호 필요 |
| 기타 | tmux 있음, 디스크 여유 106G | |

---

## 1. 용어

| 용어 | 뜻 |
|---|---|
| Run | `run` 한 번으로 시작되는 전체 실행. ID는 `<YYYYMMDD_HHMMSS>_<slug>` |
| Stage | `PLANNING`, `DEV`, `QA`, `FIX_PLANNING`, `MERGE`, `INTEGRATION_QA`, `WIKI` |
| Round | 검수 루프 한 바퀴 = 작업 AI 호출 → 게이트 → (게이트 통과 시) 검수 AI 호출 |
| Lane | 병렬 실행 단위. 순차 실행이면 `main` 하나, 병렬이면 `a`, `b`, …, 통합 수정은 `integration` |
| Role | `planningAuthor`, `planningReviewer`, `devAuthor`, `devReviewer`, `qa`, `wikiAuthor`, `wikiReviewer` |
| Gate | LLM 없이 오케스트레이터가 코드로 하는 기계 검사(§7) |
| Pending | Master나 사람의 답을 기다리는 일시정지 항목 |
| stageBase | 현재 단계가 시작될 때의 커밋 SHA. 검수자는 `git diff <stageBase>..HEAD`를 본다 |

---

## 2. 전체 흐름

### 2.1 순차 모드 (`--parallel` 없음)

```
run ─▶ PLANNING(작업↔검수 루프) ──[mode=plan]──▶ DONE
                    │
                    ▼
        lane main: DEV(루프) ─▶ QA ──PASS──▶ WIKI(루프) ─▶ DONE
                     ▲          │FAIL
                     └─ DEV ◀─ FIX_PLANNING(루프)   (롤백 최대 3회)
```

### 2.2 병렬 모드 (`--parallel`)

```
PLANNING (분할안 포함) ─▶ 게이트 G2: ownedPaths 겹침?
   ├─ 겹침 또는 레인 1개 ─▶ 순차 모드와 동일하게 진행 (timeline에 기록)
   └─ 겹침 없음 ─▶ 레인마다 worktree 생성(aw/<run-id>/lane-<id>)
                    ├─ lane a: DEV ─▶ QA(레인 시나리오) ⟲ FIX
                    ├─ lane b: DEV ─▶ QA ⟲ FIX          (동시 최대 maxLanes)
                    └─ …
                  ─▶ 모든 레인 PASS ─▶ MERGE(런 브랜치에 --no-ff 순서대로)
                  ─▶ INTEGRATION_QA(testCommand + 전체 시나리오) ⟲ FIX(lane integration)
                  ─▶ WIKI ─▶ DONE
```

- 한 레인이 일시정지돼도 **다른 레인은 각자 완료되거나 멈출 때까지 진행**합니다. 모든 레인이 멈추면 프로세스가 종료됩니다.
- 레인에 지정되지 않은(`lane: null`) 시나리오는 통합 QA에서만 실행합니다.

### 2.3 Wiki 단독 모드 (`--mode wiki --since <ref>`)

`HEAD`에서 런 브랜치/worktree를 만들고, `<ref>..HEAD`의 변경 파일을 기준으로 WIKI 루프만 실행합니다. `--request-file`은 선택입니다.

### 2.4 git 운용

| 시점 | 동작 |
|---|---|
| run 시작 | `git worktree add <ws>/.aw/worktrees/<run-id>/main -b aw/<run-id> HEAD`, `.git/info/exclude`에 `/ai-log/`, `/.aw/` 추가(중복 시 생략), `setupCommand` 실행 |
| 레인 시작 | 병렬 레인만 해당. 런 브랜치에서 `aw/<run-id>/lane-<id>` 브랜치와 worktree를 만들고 `setupCommand` 실행. 순차 모드의 `main` 레인과 `integration` 레인은 런 worktree와 런 브랜치를 그대로 씀 |
| 작업 AI 라운드 후 | `git add -A && git commit -m "aw(<run-id>): wip <lane> <stage> r<N>"` (변경 없으면 생략) |
| 검수 승인 | `git reset --soft <stageBase> && git commit -m "aw(<run-id>): <lane> <stage> 승인 (<item-ids>)"` → 새 stageBase |
| 검수자/QA가 파일을 바꾼 경우 | `git reset --hard HEAD && git clean -fd` (worktree 안에서만) |
| MERGE | 런 worktree에서 레인마다 `git merge --no-ff aw/<run-id>/lane-<id>`. 충돌 시 `git merge --abort` 후 Pending `merge_conflict` |
| 완료 | 런 브랜치 `aw/<run-id>`가 남음. main 머지, push, PR은 하지 않음 |

---

## 3. 저장소 파일 구조 (이 도구)

```
AgentWorkflow/
├─ spec.md
├─ README.md                    설치(npm link), agent-workflow.json 예시, 스킬 설치 방법
├─ package.json                 bin: agent-workflow, engines.node ">=22.18", deps: ajv, playwright
├─ tsconfig.json                타입 검사 전용(noEmit, erasableSyntaxOnly, allowImportingTsExtensions, verbatimModuleSyntax)
├─ bin/agent-workflow.mjs       진입점. src/cli.ts를 import(타입 스트리핑은 node_modules 밖에서만 동작하므로 npm link로 설치)
├─ src/
│  ├─ cli.ts                    util.parseArgs로 인자 파싱, 명령 분기, 종료 코드 반환
│  ├─ commands/
│  │  ├─ doctor.ts
│  │  ├─ run.ts                 run과 resume(같은 엔진 진입점)
│  │  ├─ inspect.ts             status, logs, list, watch
│  │  ├─ cleanup.ts
│  │  └─ qa-runtime.ts
│  ├─ engine/
│  │  ├─ pipeline.ts            런 상태 머신: 단계 전이, 레인 스케줄링, 일시정지/재개, 종료 코드 결정
│  │  ├─ review-loop.ts         작업↔검수 공통 루프, 같은 지적 카운트, 라운드 상한
│  │  ├─ stages.ts              단계별 프롬프트 입력 조립과 출력 반영(planning/fix/dev/qa/wiki)
│  │  ├─ gates.ts               기계 검사 G1~G9
│  │  └─ lanes.ts               레인 검증(겹침), worktree 생성, 머지
│  ├─ clients/
│  │  ├─ index.ts               AgentClient 인터페이스, 역할→클라이언트 해석
│  │  ├─ codex.ts
│  │  ├─ claude.ts
│  │  ├─ spawn.ts               PATH에서 실행 파일 해석, stdin 프롬프트, 타임아웃, 프로세스 그룹 종료
│  │  └─ rate-limit.ts          한도 메시지 감지와 리셋 시각 파싱
│  ├─ qa/app-runner.ts          앱 기동, readyUrl 대기, 종료, 포트 슬롯
│  ├─ store/
│  │  ├─ state.ts               state.json, run.lock
│  │  ├─ runlog.ts              ai-log 디렉터리, raw 기록, events.jsonl, timeline.md, md 렌더링
│  │  └─ request.ts             request.md 파싱과 검증
│  ├─ git.ts
│  ├─ config.ts                 agent-workflow.json 로드, 기본값 병합, 스키마 검증
│  ├─ schedule.ts               at 등록 / atrm 해제
│  └─ types.ts                  공용 타입(§5 스키마와 1:1)
├─ prompts/
│  ├─ _common.md                모든 에이전트 공통 규칙
│  ├─ planning-author.md        기획 작업(초기/수정/fix 모드 포함)
│  ├─ planning-reviewer.md
│  ├─ dev-author.md
│  ├─ dev-reviewer.md
│  ├─ qa.md
│  ├─ wiki-author.md
│  └─ wiki-reviewer.md
├─ schemas/                     JSON Schema(Codex --output-schema, Claude --json-schema, ajv 검증에 공용)
│  ├─ plan-author.schema.json
│  ├─ review.schema.json
│  ├─ dev-author.schema.json
│  ├─ qa-report.schema.json
│  ├─ wiki-author.schema.json
│  └─ config.schema.json
├─ skill/agent-workflow/SKILL.md  Master 스킬
└─ test/                        node --test
   ├─ fake-client.ts            스크립트된 응답을 돌려주는 테스트용 AgentClient
   ├─ *.test.ts
   └─ fixtures/                 임시 git 저장소용 샘플(작은 정적 웹앱 + CLI)
```

전역 상태: `~/.agent-workflow/qa-runtime.json`(포트 슬롯).

---

## 4. 대상 워크스페이스

### 4.1 레이아웃

```
<workspace>/
├─ agent-workflow.json          프로젝트 설정 (사용자가 작성, 커밋 권장)
├─ .aw/                         (exclude) 
│  ├─ requests/<YYYYMMDD>-<slug>.md   Master가 쓴 요청 초안
│  └─ worktrees/<run-id>/{main,lane-a,…}
├─ ai-log/<run-id>/             (exclude) 실행 기록 — §4.3
└─ docs/wiki/                   Wiki (런 브랜치에 커밋됨)
```

### 4.2 설정 `agent-workflow.json`

```ts
type WorkspaceConfig = {
  setupCommand: string | null;     // worktree 생성 직후 1회. 예: "npm ci"
  testCommand: string | null;      // 개발 라운드마다 게이트 G5. 예: "npm test"
  app: {                           // browser 시나리오가 있으면 필수
    startCommand: string;          // "{port}" 치환. 환경변수 PORT도 설정. 예: "npm run dev -- --port {port}"
    readyUrl: string;              // "{port}" 치환. HTTP 2xx가 오면 준비 완료. 예: "http://127.0.0.1:{port}/"
    startTimeoutSec: number;       // 기본 90
  } | null;
  wikiDir: string;                 // 기본 "docs/wiki"
  roles: Partial<Record<Role, {    // 생략한 역할은 기본값
    client: "codex" | "claude";
    model: string | null;
    effort: "low" | "medium" | "high" | "xhigh" | null;
  }>>;
  limits: Partial<{
    maxReviewRounds: number;       // 기본 5
    sameIssueLimit: number;        // 기본 2
    maxQaRollbacks: number;        // 기본 3
    maxLanes: number;              // 기본 3
    stepTimeoutMin: number;        // 기본 45 (에이전트 호출 1회 상한)
  }>;
};
// 역할 기본값: *Author → codex, *Reviewer·qa → claude, model/effort → null
```

파일이 없으면 모든 값을 기본값으로 쓰고(`app: null`, `testCommand: null`), doctor가 경고합니다.

### 4.3 실행 기록 `ai-log/<run-id>/`

```
ai-log/<run-id>/
├─ state.json                   상태 머신 스냅샷 (§5.8)
├─ run.lock                     실행 중 PID (중복 실행 방지)
├─ events.jsonl                 이벤트 원본 (기계용)
├─ timeline.md                  이벤트 표 (사람용, 같은 이벤트를 렌더링)
├─ 00-request/request.md        고정된 요청 명세(run 시작 시 복사, 이후 불변)
├─ 01-planning/
│  ├─ round-NN.author.json      작업 AI 출력
│  ├─ round-NN.gate.json        게이트 실패 내역(있을 때)
│  ├─ round-NN.review.json      검수 AI 출력
│  ├─ plan.json                 승인된 계획 + 항목 상태(checked/evidence/approved). 오케스트레이터만 수정
│  ├─ plan.md                   plan.json 렌더링(TODO, QA 시나리오, 레인)
│  └─ fix/<lane>-<N>/round-NN.{author,gate,review}.json
├─ 02-development/<lane>/
│  ├─ round-NN.author.json
│  ├─ round-NN.tests.log
│  ├─ round-NN.gate.json
│  ├─ round-NN.review.json
│  └─ todo.md                   체크와 근거가 반영된 TODO (아래 형식)
├─ 03-qa/<lane|integration>/attempt-NN/
│  ├─ report.json, report.md
│  ├─ app.log
│  ├─ scripts/                  QA가 작성한 Playwright 스크립트
│  └─ evidence/                 스크린샷(.png), 명령 로그(.log)
├─ 04-wiki/round-NN.{author,gate,review}.json
└─ raw/
   └─ NNNN-<lane>-<stage>-<role>-rNN.{prompt.md,out.jsonl|out.json,last.json,stderr.log,meta.json}
```

- 파일은 지우지 않습니다(`cleanup`도 ai-log는 남김).
- `meta.json`: `{ client, args(프롬프트 제외), cwd, exitCode, durationMs, sessionId|null, rateLimited }`
- `todo.md` 형식(설계도와 같음):

```
- [x] DEV-002 카드 높이 520px 기본, 320~1,600px 범위를 상태로 도입한다
    완료 근거: QuickVizLocalPage.tsx에 normalHeightPx 추가, 전체화면 높이와 분리 (files: src/QuickVizLocalPage.tsx)
    검수: 승인 (round 2)
- [ ] DEV-003 …
```

- `timeline.md` 형식: `| 시각 | 레인 | 단계 | 역할 | 판정 | 내용 |`. 기록하는 이벤트는 런 시작, 작업 READY/BLOCKED, 게이트 실패, 테스트 결과, 검수 APPROVED/REJECTED, QA PASS/FAIL/BLOCKED, 일시정지(kind), 재개(답변/권한), 한도 소진과 예약, 머지, 커밋, 완료입니다.

---

## 5. 단계별 입출력 스키마

모든 출력 스키마는 **Codex strict 규칙**을 따릅니다. 즉 `additionalProperties: false`이고, 모든 속성을 `required`에 넣으며, 선택 값은 `["<type>", "null"]` 유니온으로 표현합니다. 아래 TypeScript 표기와 `schemas/*.json`은 1:1이고, 오케스트레이터는 모든 출력을 ajv로 다시 검증합니다.

### 5.1 요청 명세 `request.md` (0단계, Master 작성)

```markdown
# <작업명>

## 목표
<사용자가 이루려는 것, 2~5문장>

## 요구사항
- REQ-001: <구체적이고 테스트 가능한 요구 1개>
- REQ-002: …

## 스펙 외 범위
- <이번에 하지 않을 것> (없으면 "- 없음")

## 주의사항
- <바꾸면 안 되는 것, 제약, 참고> (없으면 "- 없음")
```

검증(run 시작 시, 실패하면 종료 코드 2):
- `# ` 제목이 있어야 합니다.
- `## 요구사항` 아래 `^- (REQ-\d{3}): (.+)$` 줄이 1개 이상이고 ID가 중복되지 않아야 합니다.
- `## 스펙 외 범위` 섹션이 있어야 합니다.

### 5.2 공용 타입

```ts
type BlockerKind = "spec_ambiguity" | "permission_network" | "permission_full"
                 | "scope" | "environment" | "other";
type Blocker = { kind: BlockerKind; detail: string };            // detail: 무엇이 왜 필요한지 (ko)
type Response = { issueId: string; resolution: string };          // 지적별 처리 내용 (ko)
type Issue = {
  id: string;             // R-001… (검수자), GATE-… (게이트)
  target: string;         // "DEV-003" | "QA-002" | "lane:a" | 파일 경로 | "general"
  problem: string;        // 무엇이 왜 문제인지, 근거 포함 (ko)
  requiredChange: string; // 무엇을 하면 승인되는지 (ko)
};
```

### 5.3 기획 (PLANNING / FIX_PLANNING)

**입력**(프롬프트 섹션)

| 섹션 | 초기 r1 | 초기 r≥2 | fix 모드 |
|---|---|---|---|
| Run context `{mode, parallel, maxLanes, hasApp, round, lane}` | ✓ | ✓ | ✓ |
| request.md 전문 | ✓ | ✓ | ✓ |
| 이전 라운드 작업 출력 | | ✓ | r≥2 |
| 지적 목록(검수 + 게이트) | | ✓ | r≥2 |
| 승인된 plan(항목 + 상태) | | | ✓ |
| QA defects(report.json의 defects) | | | ✓ |
| Master decisions | 있으면 | 있으면 | 있으면 |

**작업 출력** `PlanAuthorOutput`

```ts
type PlanAuthorOutput = {
  status: "READY" | "BLOCKED";
  blocker: Blocker | null;
  summary: string;                  // 계획 요약 (ko)
  todos: Todo[];                    // 초기: 전체 목록 / fix: 새 FIX 항목만
  qaScenarios: QaScenario[];        // 초기: 전체 / fix: 새 회귀 시나리오만(없으면 [])
  lanes: Lane[] | null;             // parallel=true인 초기 모드에서만, 그 외 null
  responses: Response[];            // r1은 []
};
type Todo = {
  id: string;            // "DEV-001" | "FIX-001"
  text: string;          // 한 문장 명령형, 구체적 대상 (ko)
  reqIds: string[];      // 1개 이상
  lane: string | null;   // 병렬 시 레인 ID, 그 외 null (fix 모드는 null, 오케스트레이터가 지정)
  defectIds: string[];   // fix 모드에서 대응 결함, 그 외 []
};
type QaScenario = {
  id: string;            // "QA-001"
  title: string;
  type: "browser" | "cli";
  reqIds: string[];
  lane: string | null;   // null이면 통합 QA에서만 실행 (순차 모드는 null)
  preconditions: string;
  steps: string[];       // 구체적인 사용자 행동과 입력값
  expected: string[];    // 밖에서 관찰 가능한 결과
  adversarial: boolean;
};
type Lane = {
  id: string;            // /^[a-h]$/
  title: string;
  ownedPaths: string[];  // 저장소 기준 상대 경로(디렉터리/파일), 와일드카드 금지
  interfaces: string;    // 다른 레인과의 계약 (ko)
};
```

**검수 출력**: `ReviewOutput` (§5.4와 같음)

**승인 후 오케스트레이터가 만드는 `plan.json`**

```ts
type Plan = {
  summary: string;
  todos: (Todo & { lane: string; checked: boolean; evidence: Evidence | null; approved: boolean })[];
  qaScenarios: QaScenario[];
  lanes: Lane[] | null;      // G2 결과 순차로 전환되면 null
};
type Evidence = { files: string[]; summary: string };
```

순차 모드에서는 모든 todo의 lane이 `"main"`이 됩니다. fix 모드에서 승인된 항목은 해당 레인으로 지정해 `todos`에 이어 붙이고, 새 시나리오는 `qaScenarios`에 이어 붙입니다.

### 5.4 검수 (모든 Reviewer 공통) `ReviewOutput`

```ts
type ReviewOutput = {
  verdict: "APPROVED" | "REJECTED" | "BLOCKED";
  summary: string;          // 판정 사유 1~3문장 (ko)
  issues: Issue[];          // REJECTED면 1개 이상, APPROVED면 []
  blocker: Blocker | null;  // BLOCKED일 때만
};
```

검수 입력에는 항상 **이전 라운드 지적 목록**(id 포함)이 들어갑니다. 아직 해결되지 않은 지적은 같은 id를 다시 쓰고, 새 지적은 번호를 이어서 매기게 합니다. 오케스트레이터는 이 id로 "같은 지적"을 셉니다(§8.1).

### 5.5 개발 (DEV)

**작업 입력**: Run context `{lane, ownedPaths|null, interfaces|null, testCommand|null, round}`, 대상 항목(`approved=false`인 레인 항목), 이미 승인된 항목(맥락용, 읽기 전용), r≥2이면 지적 목록, 실패한 테스트 로그 끝 200줄, 이전 출력, Master decisions. **request.md와 plan의 다른 부분은 주지 않습니다.**

```ts
type DevAuthorOutput = {
  status: "DONE" | "BLOCKED";
  blocker: Blocker | null;
  items: { id: string; checked: boolean; evidence: Evidence | null }[];
  testsRun: { command: string; passed: boolean; note: string } | null;
  responses: Response[];
  notes: string;            // 검수자에게 전할 말 (ko, 없으면 "")
};
```

오케스트레이터는 `items`의 `checked`와 `evidence`만 plan.json에 반영합니다. **TODO 문구는 코드상 수정할 수 없습니다.**

**검수 입력**: Run context `{lane, stageBase, ownedPaths|null}`, request.md, 대상 항목과 그 checked/evidence, G5 테스트 결과(명령, 종료 코드, 로그 끝 200줄), 작업 `notes`, 이전 지적 목록, Master decisions. **출력**: `ReviewOutput`. APPROVED면 대상 항목 전부 `approved=true`로 바꿉니다.

### 5.6 QA (QA / INTEGRATION_QA)

**오케스트레이터 사전 작업**
1. 포트 슬롯을 정합니다. 슬롯 0은 `main`/`integration`, 슬롯 1~N은 병렬 레인입니다. 포트가 사용 중이면 Pending `environment`.
2. `app`이 설정돼 있으면 worktree에서 `startCommand`를 기동하고, readyUrl이 2xx를 줄 때까지 기다립니다. 출력은 `app.log`에 남깁니다.
   - 기동에 실패하거나 시간이 초과되면 QA를 호출하지 않고 **자동 결함 `BUG-APP-START`로 FAIL** 처리합니다(앱이 안 뜨는 것은 개발 결함으로 봄).
3. browser 시나리오가 있는데 Playwright chromium이 없으면 Pending `environment`(`qa-runtime setup` 안내).

**QA 입력**: Run context `{scope: lane id | "integration", worktree, baseUrl | "none", qaDir, playwrightUrl}`, 실행할 시나리오 목록(레인이면 `lane`이 그 레인인 것, 통합이면 전체). **코드, TODO, plan 요약은 주지 않습니다.**

```ts
type QaReport = {
  status: "PASS" | "FAIL" | "BLOCKED";
  blocker: Blocker | null;
  scenarios: {
    id: string;                          // 입력 시나리오 전부, 각각 정확히 1번
    result: "PASS" | "FAIL" | "BLOCKED";
    observed: string;                    // 실제로 관찰한 내용 (ko)
    evidence: string[];                  // qaDir 기준 상대 경로, 1개 이상
  }[];
  exploratory: {
    title: string;
    result: "PASS" | "FAIL";
    observed: string;
    evidence: string[];
  }[];
  defects: {
    id: string;                          // "BUG-001"
    scenarioId: string | null;           // 탐색에서 나온 결함이면 null
    title: string;
    reproduction: string[];
    expected: string;
    actual: string;
    evidence: string[];
  }[];
};
```

**사후 작업**: 앱 프로세스 그룹 종료(`detached: true`로 띄운 그룹에 `SIGTERM`을 보내고, 5초 뒤에도 남아 있으면 `SIGKILL`), 게이트 G6(worktree 무변경), G9(보고 일관성과 증거 존재) 실행.

### 5.7 Wiki (WIKI)

**작업 입력**: Run context `{wikiDir, stageBase, round}`, request.md의 `# 제목`과 `## 목표`(wiki 모드에서 요청이 없으면 "(요청 없음)"), plan 요약, 변경 파일 목록(`git diff --name-only <baseRef>..HEAD`에서 wikiDir 제외), 현재 `<wikiDir>/index.md`(있으면), 지적 목록, 이전 출력, Master decisions.

```ts
type WikiAuthorOutput = {
  status: "DONE" | "BLOCKED";
  blocker: Blocker | null;
  docs: { path: string; action: "created" | "updated"; reason: string }[];   // 1개 이상 (log.md 항상 포함)
  responses: Response[];
};
```

**검수 입력**: 작업 입력과 같은 맥락 + `WikiAuthorOutput`. **출력**: `ReviewOutput`.

### 5.8 상태 `state.json`

```ts
type RunState = {
  runId: string;
  workspace: string;
  mode: "plan" | "full" | "wiki";
  parallel: boolean;              // 요청값
  baseRef: string;                // 시작 HEAD SHA
  runBranch: string;              // "aw/<run-id>"
  runWorktree: string;
  status: "RUNNING" | "PAUSED" | "DONE";
  stage: "PLANNING" | "LANES" | "MERGE" | "INTEGRATION_QA" | "WIKI" | "DONE";
  planning: LoopState;
  lanes: LaneState[];             // PLANNING 승인 후 생성
  integration: LaneState | null;  // INTEGRATION_QA에서 쓰는 가상 레인
  wiki: LoopState | null;
  pending: Pending[];
  lastExitCode: number | null;
  scheduledResume: { atJobId: number; at: string } | null;
  seq: number;                    // raw 파일 일련번호
  updatedAt: string;
};
type LoopState = {
  round: number;                  // 현재 라운드(Master 답변 시 0으로 리셋)
  issueStreak: Record<string, number>;   // issue id → 연속 반려 횟수
  stageBase: string | null;
  decisions: string[];            // 이 루프에 주입할 Master 답변
  grant: "network" | "full" | null;      // 이 루프가 끝날 때까지 유효
};
type LaneState = {
  id: string;                     // "main" | "a".. | "integration"
  branch: string;
  worktree: string;
  ownedPaths: string[] | null;
  portSlot: number;
  phase: "DEV" | "QA" | "FIX_PLANNING" | "DONE";
  loop: LoopState;                // 현재 DEV 또는 FIX_PLANNING 루프
  qaAttempt: number;
  qaRollbacks: number;
  status: "ACTIVE" | "PAUSED" | "DONE";
};
type Pending = {
  id: string;                     // "P-001"
  lane: string | null;            // PLANNING/WIKI는 null
  stage: string;
  kind: "loop_repeat" | "round_cap" | "qa_rollback_cap" | "reviewer_blocked"
      | "merge_conflict" | "failed" | "rate_limited" | BlockerKind;
  exitCode: 1 | 20 | 21 | 22;
  summary: string;                // Master가 읽을 한 줄 요약 (ko)
  detail: string;                 // 근거: 반복된 지적, blocker 내용, 충돌 파일, 에러 등
  createdAt: string;
};
```

---

## 6. 에이전트 호출 규격

### 6.1 공통

- 모든 호출은 **새 세션**이고(A4), 프롬프트는 **stdin**으로 넘깁니다(Linux에서 인자 하나의 길이 상한 128KB를 피하기 위해).
- 실행 파일은 PATH에서 찾은 `codex`, `claude`를 `shell: false`, `detached: true`(독립 프로세스 그룹)로 실행합니다. 타임아웃 시 그룹 전체를 종료합니다(§5.6과 같은 방식).
- 프롬프트는 다음 순서로 조립합니다: `_common.md` → 역할 프롬프트 → `# Inputs` 아래 `## <섹션>`들(§5의 입력 표 순서). 고정 텍스트를 앞에 두고, `{{var}}` 치환만 하며 조건부 템플릿 문법은 쓰지 않습니다.
- 출력 처리:
  1. 정해진 위치에서 JSON을 추출해 ajv로 검증합니다.
  2. 실패하면 검증 오류를 붙여 **1회 재호출**합니다(라운드로 세지 않음). 재호출도 실패하면 Pending `failed`(종료 코드 1).
- 프로세스가 0이 아닌 코드로 끝나면, 먼저 한도 메시지인지 확인합니다(§6.4). 아니면 1회 재시도하고, 다시 실패하면 Pending `failed`.
- 타임아웃(`stepTimeoutMin`)이 지나면 프로세스 트리를 종료하고, 0이 아닌 종료와 똑같이 처리합니다.

### 6.2 권한 프로필

| 프로필 | 쓰는 역할 | codex | claude |
|---|---|---|---|
| `readonly` | planningAuthor, 모든 Reviewer | `-s read-only` | `--permission-mode dontAsk --allowedTools "Read Grep Glob Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git status *)" --disallowedTools "Edit Write NotebookEdit"` |
| `write` | devAuthor, wikiAuthor | `-s workspace-write` · grant network: `+ -c sandbox_workspace_write.network_access=true` · grant full: `--dangerously-bypass-approvals-and-sandbox` (`-s` 대신) | `--permission-mode acceptEdits --allowedTools "Read Grep Glob Edit Write Bash"` · grant full: `--permission-mode bypassPermissions` |
| `qa` | qa | `-s workspace-write -C <qaDir>` (codex로 QA할 때만) | `--permission-mode dontAsk --allowedTools "Read Grep Glob Write Edit Bash" --add-dir <qaDir>` |

읽기 전용과 저장소 무변경은 프로필에만 맡기지 않고 **게이트 G6으로 한 번 더 검사**합니다.

### 6.3 명령줄

```
codex exec --json -C <cwd> <profile> --output-schema <abs>/schemas/<x>.schema.json
           -o <raw>/NNNN-….last.json [-m <model>] [-c model_reasoning_effort=<effort>] -
  → 결과: last.json(마지막 메시지 = JSON). stdout(JSONL 이벤트)은 out.jsonl에 저장

claude -p --output-format json --json-schema '<schema 한 줄 JSON>' --session-id <uuid>
       <profile> --strict-mcp-config --disable-slash-commands [--model <m>] [--effort <e>]
  (cwd = worktree)
  → 결과: stdout JSON의 structured_output, 없으면 result 문자열을 JSON.parse. 원문은 out.json에 저장
```

`cwd`는 역할별로 다음과 같습니다: PLANNING/WIKI = 런 worktree, FIX_PLANNING/DEV/QA = 해당 레인 worktree(codex QA는 qaDir, integration은 런 worktree).

### 6.4 사용량 한도 감지 (`rate-limit.ts`)

- 감지: 0이 아닌 종료 + stdout/stderr가 `/usage limit|rate limit|hit your limit|limit reached|quota/i`에 걸릴 때.
- 리셋 시각 파싱(순서대로 시도, 모두 실패하면 `null`):
  1. `|(\d{10})` 형태의 epoch 초
  2. `resets? (?:at )?(\d{1,2})(?::(\d{2}))?\s?(am|pm)` → 로컬 시각의 다음 도래 시점
  3. `try again in (?:(\d+) hours?)?\s*(?:(\d+) minutes?)?`
  4. `try again at (\d{1,2}):(\d{2})\s?(AM|PM)?`
- 처리: 진행 중인 단계를 처음부터 다시 할 수 있게 상태를 저장 → Pending `rate_limited`(22). 리셋 시각을 알면 `리셋 + 2분`에 예약합니다(§9.2).
- 이 패턴은 CLI 메시지가 바뀌면 깨질 수 있습니다. 샘플 메시지로 단위 테스트를 두고, 바뀌면 이 파일만 고칩니다.

---

## 7. 기계 게이트

게이트가 실패하면 검수 AI를 부르지 않고 **자동 반려**합니다. 실패 내역은 `Issue`(id `GATE-<코드>`) 형태로 다음 작업 라운드에 넘기고, 라운드 하나를 소비하며, 같은 지적 카운트(§8.1)에도 포함됩니다.

| ID | 시점 | 검사 | 실패 시 |
|---|---|---|---|
| G1 `GATE-REQ` | 기획 작업 출력 후 | 모든 REQ id가 어떤 todo의 `reqIds`에 있다. 알 수 없는 REQ id가 없다. todo/시나리오 id가 중복되지 않는다. `hasApp=false`인데 browser 시나리오가 있으면 안 된다 | 자동 반려 |
| G2 `GATE-LANES` | 기획 작업 출력 후 (parallel) | 레인 ≤ maxLanes. 레인 id 형식. 모든 todo와 레인 지정 시나리오가 존재하는 레인을 가리킨다. ownedPaths에 와일드카드/절대경로/`..`가 없다 | 자동 반려 |
| G2' | 기획 **승인 후** | ownedPaths끼리 겹침(정규화 후 한쪽이 다른 쪽의 경로 접두사)이 있거나 레인이 1개 | 반려하지 않고 **순차 모드로 전환**한다(모든 lane → main, timeline에 기록) |
| G3 `GATE-ITEMS` | 개발 작업 출력 후 | `items`의 id가 대상 항목 집합과 정확히 같다. `status=DONE`이면 모두 `checked=true`이고 evidence가 있다 | 자동 반려 |
| G4 `GATE-EVIDENCE` | 개발 작업 출력 후 | evidence.files의 파일이 worktree에 모두 존재한다. 대상 항목 전체의 evidence 파일 중 1개 이상이 이번 단계 변경(`stageBase..HEAD`)에 포함된다 | 자동 반려 |
| G5 `GATE-TESTS` | 개발 작업 커밋 후 | `testCommand` 종료 코드가 0이다(설정돼 있을 때) | 자동 반려(로그 끝 200줄 첨부) |
| G6 `GATE-READONLY` | 검수/QA 호출 후 | worktree의 `git status --porcelain`이 비어 있고 HEAD가 그대로다 | `reset --hard` + `clean -fd`로 되돌린 뒤 같은 호출을 1회 재실행. 다시 위반하면 Pending `failed`(1) |
| G7 `GATE-OWNED` | 개발 작업 커밋 후 (병렬 레인) | `stageBase..HEAD` 변경 파일이 전부 레인 ownedPaths 아래에 있다 | 자동 반려 |
| G8 `GATE-WIKI-SCOPE` | wiki 작업 커밋 후 | 변경 파일이 전부 `wikiDir` 아래에 있다. `docs` 경로가 실제 변경과 일치한다 | 자동 반려 |
| G9 `GATE-QA-REPORT` | QA 출력 후 | 입력 시나리오가 각각 정확히 1번 있다. 모든 evidence 경로가 qaDir 안에 존재한다. `PASS ⇔ 모든 시나리오 PASS ∧ defects=[]`, `FAIL ⇒ defects ≥ 1` | 검증 오류로 취급해 1회 재호출 → 다시 실패하면 Pending `failed`(1) |

---

## 8. 종료 조건

### 8.1 작업↔검수 루프 (PLANNING, FIX_PLANNING, DEV, WIKI 공통)

라운드 N: 작업 호출 → (작업 BLOCKED 확인) → 커밋(dev/wiki) → 게이트 → 검수 호출 → 판정.

| 조건 | 결과 |
|---|---|
| 게이트 통과 + 검수 **APPROVED** | 루프 종료 → 다음 단계. dev/wiki는 squash 커밋. FIX_PLANNING은 plan.json에 이어 붙임 |
| 게이트 실패 또는 REJECTED, 아래 조건에 해당 없음 | 라운드 N+1 |
| 어떤 지적 id가 **sameIssueLimit(2)회 연속** 반려에 나타남 | Pending `loop_repeat` → **20** |
| N = maxReviewRounds(5)인데 승인되지 않음 | Pending `round_cap` → **20** |
| 작업 BLOCKED, kind = `permission_full` | Pending `permission_full` → **21** |
| 작업 BLOCKED, 그 외 kind | Pending `<kind>` → **20** |
| 검수 BLOCKED | Pending `reviewer_blocked` → **20** |
| 출력 형식 오류 2회 / 프로세스 오류 2회 / G6 위반 2회 | Pending `failed` → **1** |
| 사용량 한도 | Pending `rate_limited` → **22** |

- 연속 카운트 규칙: 반려될 때마다 그 반려에 나온 id는 +1, 나오지 않은 id는 0으로 리셋합니다.
- Master가 `--answer`로 재개하면 그 루프의 `round`와 `issueStreak`을 0으로 리셋하고, 답변을 `decisions`에 추가합니다. 이후 작업과 검수 프롬프트 모두에 "Master decisions"로 들어갑니다.

### 8.2 QA

| 조건 | 결과 |
|---|---|
| PASS | 레인 DONE. 순차면 WIKI로, 병렬이면 다른 레인을 기다린 뒤 MERGE로. integration이면 WIKI로 |
| FAIL(`BUG-APP-START` 포함), `qaRollbacks < maxQaRollbacks(3)` | `qaRollbacks += 1` → FIX_PLANNING → DEV → QA(전체 재실행) |
| FAIL, `qaRollbacks = maxQaRollbacks` | Pending `qa_rollback_cap` → **20** |
| QA BLOCKED, 포트 사용 중, chromium 없음 | Pending `environment` → **20** |
| G6/G9 2회 실패, 프로세스 오류 2회 | Pending `failed` → **1** |

통합 단계에서 `testCommand`가 실패하면, 그 로그를 결함(`BUG-INTEGRATION-TESTS`)으로 만들어 QA 호출 없이 FAIL 처리합니다(위 표의 FAIL과 같은 경로, lane `integration`).

### 8.3 런 전체

| 조건 | 상태 / 종료 코드 |
|---|---|
| mode plan: 기획 승인 | DONE / **0** |
| mode full: WIKI 승인과 커밋 완료 | DONE / **0** |
| mode wiki: WIKI 승인과 커밋 완료 | DONE / **0** |
| 진행할 수 있는 레인이 없고 Pending이 있음 | PAUSED / Pending 종료 코드 중 우선순위가 가장 높은 것: **1 > 21 > 20 > 22** |
| 잘못된 인자, 설정/요청 검증 실패, 런 없음, 이미 실행 중 | 상태 변화 없음 / **2** |

### 8.4 종료 코드

| 코드 | 이름 | Master 동작 |
|---|---|---|
| 0 | OK | 완료 또는 진행 가능한 체크포인트 |
| 1 | FAIL | 로그를 진단하고 원인을 고친 뒤 resume |
| 2 | USAGE | 명령이나 설정을 수정 |
| 20 | NEEDS_ANSWER | Master가 판단해서 `resume --answer` |
| 21 | NEEDS_USER | 사람에게 확인한 뒤 resume |
| 22 | RATE_LIMITED | 예약된 resume을 기다리거나 나중에 resume |

---

## 9. CLI 명령 규격

공통: `--workspace <path>`(기본 cwd). 사람용 출력은 한국어이고, `--json`이면 기계용 JSON입니다.

### 9.1 명령

| 명령 | 인자 | 동작 |
|---|---|---|
| `doctor` | `[--deep]` | 다음을 검사합니다: Node ≥ 22.18, git, 워크스페이스가 커밋 1개 이상인 git 저장소인지(커밋 안 된 변경은 경고), 설정된 역할이 쓰는 클라이언트(`codex`/`claude`)의 경로와 버전, 로그인 상태(`codex login status`, `claude auth status`의 `loggedIn`), agent-workflow.json 스키마, `app`이 있으면 chromium headless 기동 여부, `at` 명령과 atd 활성(`systemctl is-active atd`, 실패하면 경고만). `--deep`(토큰 소모)은 §12의 미검증 항목을 실제 호출로 확인합니다. 모두 통과하면 0, 하나라도 실패하면 2 |
| `run` | `--mode plan\|full\|wiki`, `--request-file <p>`(wiki는 선택), `[--parallel]`, `[--name <slug>]`(ASCII `[a-z0-9-]`, 기본 `run`), `[--since <ref>]`(wiki 필수) | 요청을 검증하고, run-id 생성, ai-log 초기화, worktree 생성, 파이프라인을 시작합니다. 시작할 때 `run-id`를 첫 줄에 출력합니다. 종료 코드는 §8 |
| `resume` | `<run-id>`, `[--answer <text>]`, `[--lane <id>]`, `[--grant network\|full]`, `[--mode full]` | run.lock을 확인합니다(실행 중이면 2). `--answer`는 해당 Pending의 루프에 decisions로 추가하고 Pending을 지웁니다. Pending이 여러 개면 `--lane`이 필요합니다. `--grant`는 그 루프의 grant를 설정합니다. `rate_limited`, `failed` Pending은 인자 없이도 재시도합니다. `--mode full`은 plan 모드 런을 개발 단계로 이어 갑니다. 진행할 수 있는 것이 없으면 같은 종료 코드로 바로 끝냅니다 |
| `status` | `<run-id>`, `[--view current\|timeline\|decisions\|plan\|todo\|qa]`, `[--json]` | current: 단계, 레인 상태, Pending, 예약. timeline: timeline.md. decisions: 판정 이벤트만 모은 표(설계도 슬라이드 11 형식). plan: plan.md. todo: 레인별 todo.md. qa: 최근 QA report.md. `--json`은 `{runId, mode, parallel, status, stage, lastExitCode, runBranch, runWorktree, lanes[], pending[], scheduledResume, lastEvents[10]}` |
| `logs` | `<run-id>`, `[--seq <N>]` | 인자가 없으면 raw 호출 목록(seq, 레인, 단계, 역할, 라운드, 종료 코드, 소요 시간)을, `--seq`면 그 호출의 프롬프트, 최종 출력, stderr 끝 100줄을 출력합니다 |
| `list` | | ai-log의 런 목록: run-id, mode, status, stage, lastExitCode, updatedAt |
| `watch` | `<run-id>` | 2초마다 events.jsonl의 새 이벤트를 출력하고, status가 RUNNING이 아니면 종료합니다(종료 코드 = lastExitCode) |
| `cleanup` | `<run-id>` \| `--finished`, `[--force]` | 레인 worktree와 브랜치, 런 worktree, 예약 작업을 지웁니다. **런 브랜치와 ai-log는 남깁니다.** DONE이 아닌 런은 `--force`가 있어야 지웁니다 |
| `qa-runtime setup` | `[--slots <1..32>]`(기본 4), `[--base-port <n>]`(기본 4100) | 도구 디렉터리의 playwright로 `install chromium`을 실행하고, 포트 base..base+slots-1이 비어 있는지 확인한 뒤 `~/.agent-workflow/qa-runtime.json`을 저장합니다. 설정이 없을 때 기본값은 base 4100, slots = maxLanes + 1 |

### 9.2 resume 예약 (`schedule.ts`, `at`)

```sh
echo '"<node>" "<repo>/bin/agent-workflow.mjs" resume <run-id> --workspace "<ws>" \
      >> "<ws>/ai-log/<run-id>/scheduled-resume.log" 2>&1' | at -t <YYYYMMDDhhmm>
# stderr "job <N> at <시각>"에서 <N>을 파싱
```

- `at`은 등록할 때의 환경변수(nvm PATH 포함)와 cwd를 그대로 가져가므로 실행 파일을 따로 지정하지 않습니다(dev-kang에서 확인함).
- 시각은 `-t`(`[[CC]YY]MMDDhhmm`)로 넘겨 로케일에 영향받지 않게 합니다.
- 예약 정보는 `state.scheduledResume = { atJobId, at }`에 기록합니다. resume이 시작되거나 `cleanup`을 하면 `atrm <atJobId>`로 지웁니다(이미 실행됐으면 무시).
- 예약으로 실행된 resume이 다시 한도에 걸리면 다시 1회 예약합니다.
- `at`이 없거나 atd가 멈춰 있으면 예약하지 않고 종료 코드 22만 반환합니다(timeline에 기록).

---

## 10. 역할별 프롬프트

아래 본문을 `prompts/*.md`에 그대로 둡니다. `{{…}}`는 오케스트레이터가 치환합니다.

### 10.1 `_common.md`

```markdown
You are a stage worker in "agent-workflow", an automated pipeline where an author AI produces work and a separate reviewer AI must approve it. You run non-interactively: nobody will answer questions during your task.

Rules:
1. Language: write every human-readable string value in Korean. Keep code, identifiers, file paths, commands, JSON keys and enum values in English.
2. Output: your final message must be exactly one JSON object conforming to the provided JSON Schema. No markdown fences, no text before or after it.
3. Evidence over claims: never state that something exists, works or was done unless you verified it in this session.
4. Don't guess on decisions. If you cannot proceed correctly without a decision, permission or information you lack, set status "BLOCKED" and fill `blocker` with a kind and a precise Korean description of what is needed and why:
   - spec_ambiguity: the request or plan is ambiguous or contradictory
   - permission_network: you need network access (e.g. installing a package)
   - permission_full: you need access beyond the workspace sandbox
   - scope: the task requires touching something you are not allowed to touch
   - environment: required tooling or runtime is broken or missing
   - other: anything else
5. "Master decisions" in your inputs are authoritative answers from the supervisor. Follow them over any earlier instruction they conflict with.
6. Paths in your output are relative to the repository root and use forward slashes, unless stated otherwise.
```

### 10.2 `planning-author.md`

```markdown
# Role: Planning Author

You turn a frozen request specification (request.md) into an implementation plan. A developer AI will implement your TODO list WITHOUT seeing request.md, and an independent tester will run your QA scenarios WITHOUT seeing the code. You may read the repository but must not modify any file.

## Produce
1. `todos`: the development TODO list.
   - Cover every requirement (REQ-xxx) completely, including the contracts it implies: state transitions, limits and ranges, error and empty cases, and interactions with existing features. Add nothing beyond the request, and never touch anything listed under "스펙 외 범위".
   - One TODO is one verifiable change, written as one Korean imperative sentence that names concrete targets (file/module/component, values, behavior), so a reviewer can confirm it by reading code.
     Bad: "UI 개선". Good: "ChartCard.tsx에서 카드 기본 높이를 520px로, 허용 범위를 320~1600px로 상태화한다".
   - Order by dependency. IDs: DEV-001, DEV-002, ... `reqIds` lists the REQs it serves (at least one). `defectIds` is [].
   - If the repository has a test setup, include TODOs for the unit tests that prove the changes.
2. `qaScenarios`: user-level scenarios executed against the running product.
   - Every user-observable REQ is covered by at least one scenario.
   - `steps` are concrete user actions with concrete input values. `expected` lists results observable from outside (visible text, URL, file contents, exit code, stdout).
   - Add adversarial scenarios (`adversarial: true`) for each input surface you touch: special characters (<>'"&, emoji, Korean), empty and very long input, rapid repeated actions, reload/back navigation, invalid arguments.
   - `type`: "browser" for UI in a browser (allowed only when Run context has hasApp: true), otherwise "cli" (shell commands, HTTP via curl, file outputs).
   - IDs: QA-001, ...
3. `lanes`: only when Run context has parallel: true; otherwise null.
   - Split into at most maxLanes lanes, and only where file ownership does not overlap and no lane depends on another lane's unfinished work. If a clean split is not possible, return exactly one lane.
   - `ownedPaths`: repository-relative directories or files, no wildcards, no overlap between lanes. A lane may modify only files under its ownedPaths, so include the tests and config it needs.
   - `interfaces`: the exact contracts between lanes (function signatures, API shapes, events, file formats) both sides must honor.
   - Set `lane` on every TODO and scenario. A scenario that spans lanes gets lane null (it runs in integration QA). When lanes is null, every `lane` is null.
4. `responses`: on revision rounds, one entry per issue you received, saying how you addressed it (or why it is invalid, with evidence). Empty on round 1.
5. `summary`: a short Korean summary of the plan.

## Revision rounds
You receive your previous output and the issues raised by the reviewer and by automatic gates. Return the complete revised plan, not a diff. Keep the IDs of unchanged items stable.

## Fix mode (Run context mode: "fix")
You receive the approved plan and the defects found by QA. Return ONLY new items:
- FIX-### TODOs that fix the root cause of each defect (fill `defectIds`; take `reqIds` from the related scenario, or the closest REQ).
- New regression scenarios only if no existing scenario already reproduces a defect.
Do not repeat or edit approved items. Set `lanes` to null and every `lane` to null; the orchestrator assigns lanes.
```

### 10.3 `planning-reviewer.md`

```markdown
# Role: Planning Reviewer (read-only)

You review an implementation plan against request.md before any code is written. You can read the repository but must not modify anything; your only output is a verdict. The developer will implement the TODO list without seeing request.md, so every gap you miss becomes a bug.

## Check
1. Coverage: each REQ is fully realized by TODOs, including implied contracts (states, ranges, error and empty cases, interaction with existing features). A TODO that merely restates a REQ without concrete targets does not count.
2. Scope: nothing beyond the request; nothing from "스펙 외 범위".
3. Verifiability: each TODO is one concrete change a reviewer can confirm in code; its targets exist in the repository or are clearly new.
4. QA scenarios: executable from outside without reading code; concrete inputs; observable expected results; adversarial cases for each touched input surface; every user-observable REQ covered; type "browser" only when hasApp is true.
5. Lanes (if present): ownedPaths include every file each lane's TODOs need; interfaces are precise enough for both sides; no lane depends on another lane's unfinished work.
6. Fix mode: FIX items address the root cause of each defect, and do not rewrite approved items.

## Verdict rules
- APPROVED: no blocking problem remains. Wording preferences and nice-to-haves are not issues.
- REJECTED: list every blocking problem now; do not hold issues back for later rounds.
- Issue ids: if a previously raised issue (listed in your inputs) is still unresolved, reuse its id exactly. New issues get new ids continuing the numbering (R-001, R-002, ...).
- Each issue has `target` (item id such as DEV-003 or QA-002, "lane:<id>", or "general"), `problem` (what is wrong, with evidence) and `requiredChange` (what would make it acceptable).
- Never ask for anything the request explicitly excludes.
- BLOCKED only if you cannot judge at all (for example, request.md contradicts itself); explain in `blocker`.
```

### 10.4 `dev-author.md`

```markdown
# Role: Developer

You implement the TODO list in this repository. The TODO list is your only specification: do not look for other planning documents, and do not implement anything that is not on it.

## Rules
1. Implement every target item. Items listed as already approved are context only.
2. Follow the existing code's style, structure and conventions. Keep each change minimal for its item.
3. Leave a short `AI-NOTE:` comment only where a decision is non-obvious and a future reader would otherwise get it wrong. Say why, not what.
4. If Run context lists `ownedPaths`, modify only files under them. If an item cannot be done without touching other paths, stop and return BLOCKED (kind: scope) naming the files.
5. If Run context gives a test command, run it before finishing and make it pass. Add or update unit tests when an item asks for them.
6. You cannot change TODO wording; you only report completion.
7. Report every target item in `items`. Set `checked: true` only when the change is really in the code, and give `evidence.files` (the files that prove it) and `evidence.summary` (one Korean sentence a reviewer can verify by opening those files, e.g. "ChartCard.tsx에 normalHeightPx 상태 추가, 전체화면 높이와 분리"). An item without evidence is not done.
8. status DONE requires every target item to be checked. Otherwise return BLOCKED with the reason.
9. If you need network access (e.g. to install a package) and it is unavailable, return BLOCKED (kind: permission_network). If you need access outside the workspace, return BLOCKED (kind: permission_full). Do not work around missing permissions.

## Revision rounds
The working tree already contains your previous work (committed). Fix every issue you received (reviewer issues, gate failures, failing test output) and answer each one in `responses`. Report all target items again.
```

### 10.5 `dev-reviewer.md`

```markdown
# Role: Development Reviewer (read-only)

You verify a developer's work by following its evidence into the code. You must not modify files; your only output is a verdict. Use `git diff {{stageBase}}..HEAD` and read the files.

## Check each target item
1. Implemented: the change exists in the evidence files. It is not a stub, placeholder, commented-out code or a TODO.
2. Intent: it does what the item means (use request.md to understand intent), including the edge cases the item names.
3. Evidence: the summary is true and points at the right place.

## Then check the diff as a whole
4. No out-of-scope changes: no behavior change, refactor or file that the items do not need.
5. No obvious regression in the surrounding code paths the diff touches.
6. Tests: the attached test result is consistent with this diff; tests that the items ask for exist and assert the behavior.

## Verdict rules
- APPROVED only if every target item is verified and no blocking problem remains. Style preferences are not issues.
- REJECTED: list every blocking problem now. Reuse ids of unresolved earlier issues; new ids continue numbering (R-001, ...).
- `target` is the item id (DEV-xxx / FIX-xxx), a file path, or "general".
```

### 10.6 `qa.md`

```markdown
# Role: Independent QA

You test the product the way a user would, against approved scenarios. You did not build it. Judge only by observable behavior; do not read source code to decide whether something passes.

## Environment
- Repository (do not modify anything in it): {{worktree}}
- App base URL (already running), or "none": {{baseUrl}}
- QA directory (put every file you create here): {{qaDir}}
  - scripts go in {{qaDir}}/scripts, evidence in {{qaDir}}/evidence
- Playwright for browser scripts: `import { chromium } from "{{playwrightUrl}}";`

## Procedure
1. Execute every scenario in your inputs, in order.
   - browser: write one Playwright script (`.mjs`, headless) per scenario in scripts/, run it with `node`, and save a full-page screenshot after each step and on any failure to `evidence/<scenarioId>-<NN>.png`. Open the screenshots to confirm what was actually visible.
   - cli: run the steps as shell commands from the repository directory (or curl against the base URL) and save the commands, stdout, stderr and exit codes to `evidence/<scenarioId>.log`.
2. A scenario PASSes only if every expected result was observed and evidenced. Anything else is FAIL and gets a defect.
3. Exploratory adversarial pass: on the surfaces the scenarios touched, try special characters (<>'"&, emoji, Korean), empty and very long input, rapid repeated actions, reload/back, invalid arguments. Report each attempt in `exploratory` with evidence; failures become defects.
4. Defects: concrete reproduction steps, expected, actual, evidence paths. One defect per distinct problem. IDs: BUG-001, ...
5. Evidence paths in your output are relative to the QA directory (e.g. "evidence/QA-001-02.png") and must exist.
6. status: PASS only if every scenario passed and there are no defects. FAIL if there is any defect. BLOCKED only if the environment prevents testing (app unreachable, browser cannot launch), never for product bugs.
7. Never change repository files, configuration or installed packages to make a test pass.
```

### 10.7 `wiki-author.md`

```markdown
# Role: Wiki Author

You update the project's minimal wiki in `{{wikiDir}}` so it matches the code after this run. The code itself is the detailed context; the wiki holds only the big picture.

## Rules
1. Modify only files under `{{wikiDir}}`.
2. Touch only documents related to the changed files listed in your inputs. Do not rewrite unrelated documents.
3. Content: architecture and module responsibilities, data and control flow between modules, policies and constraints, and decisions with their reasons. No code copies, no per-function API listings, no tutorials.
4. Structure:
   - `index.md`: one line per document (link and one-sentence purpose). Keep it complete.
   - `architecture.md`: overview of the system structure.
   - `decisions.md`: append "결정 / 이유 / 버린 대안" entries only for decisions this run made.
   - `log.md`: append exactly one entry: date, run id, and a one-paragraph summary of what changed.
   - `features/<feature>.md`: one per feature area. Create one only for a new area; otherwise update the existing one.
   If `{{wikiDir}}` does not exist, create index.md, architecture.md, decisions.md and log.md.
5. Every statement must be true in the current code. Verify by reading it.
6. Report every file you created or updated in `docs`.
```

### 10.8 `wiki-reviewer.md`

```markdown
# Role: Wiki Reviewer (read-only)

You check that the wiki changes match the code. You must not modify files; your only output is a verdict. Use `git diff {{stageBase}}..HEAD -- {{wikiDir}}` and read the code the documents describe.

## Check
1. Accuracy: every statement in the changed documents is true in the current code (names, paths, flows, policies).
2. Completeness: significant changes from this run (see the changed files list) that affect architecture, behavior or policy are reflected in the relevant document; index.md lists every document; log.md has exactly one entry for this run.
3. Minimalism: no code copies, per-function documentation, or content unrelated to this run's changes.

## Verdict rules
- APPROVED only if no blocking problem remains. Style preferences are not issues.
- REJECTED: list every blocking problem now. Reuse ids of unresolved earlier issues; new ids continue numbering (R-001, ...).
- `target` is a document path or "general".
```

### 10.9 Master 스킬 `skill/agent-workflow/SKILL.md`

```markdown
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
  - qa_rollback_cap: read `status --view qa` and `--view decisions`; decide whether a scenario is wrong, the request is unrealistic, or development is stuck. Consult the user if the answer changes the request.
  - environment: fix it if the fix is safe and local (e.g. `agent-workflow qa-runtime setup`); otherwise ask the user.
  - merge_conflict: resolve the conflict in the run worktree named in `detail`, commit, then resume.
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
```

---

## 11. 구현하지 않을 것

| # | 항목 | 이유 |
|---|---|---|
| N1 | Seed/Fork 세션(캐시 절약용 frozen seed, session fork) | 사용자 결정. Codex는 비대화형 fork가 없음 |
| N2 | 라운드 간 세션 이어가기(resume)와 세션 ID 기반 맥락 유지 | A4: 모든 호출이 새 세션 |
| N3 | Gemini/agy 어댑터, Codex/Claude 외 클라이언트 | 모델 조합 결정. 어댑터는 codex, claude 두 개만 |
| N4 | `--supervisor-client` 같은 Master 클라이언트 선택, Codex/Antigravity Master | Master는 Claude Code 스킬 하나 |
| N5 | 두 모델 동시 작업과 토론, 결과 병합 | 설계도 원칙 8 |
| N6 | 검수자/QA의 직접 수정 | 원칙 2. G6으로 강제 |
| N7 | main 자동 머지, push, PR 생성 | git 결정 |
| N8 | git이 아닌 워크스페이스 지원 | worktree와 커밋에 의존 |
| N9 | RAG, 벡터 검색, 임베딩 기반 Wiki | 설계도: 최소 MD Wiki |
| N10 | 웹 UI, 대시보드, TUI | CLI 출력과 Master 질의로 충분 |
| N11 | 토큰/비용 집계와 리포트 | raw/meta에 원본만 보존 |
| N12 | Windows/macOS 지원(프로세스 종료, 예약 등 OS별 처리) | Linux 전용(운용 환경이 Linux) |
| N13 | CLI 자체의 대화형 요청 인터뷰 | Master 스킬 담당 |
| N14 | 같은 워크스페이스에서 여러 런 동시 실행 시 포트 조정 | 런 하나를 전제. 포트 충돌은 Pending `environment` |
| N15 | QA용 브라우저 MCP 도구 | Playwright 스크립트 방식으로 결정 |
| N16 | 오케스트레이터의 의존성 자동 설치(`setupCommand` 외) | BLOCKED → 권한 상향 경로로 처리 |
| N17 | npm 레지스트리 배포 | `npm link`로 로컬 설치 |
| N18 | 린트/타입체크 게이트 | 요청 범위 밖. 필요하면 `testCommand`에 포함 |

---

## 12. 구현 전에 검증할 사항 (`doctor --deep`으로 자동 확인)

| # | 가정 | 확인 방법 | 다를 경우 |
|---|---|---|---|
| V1 | `codex exec --output-schema … -o <file>`가 스키마에 맞는 JSON을 `-o` 파일에 쓴다 | 스키마 `{ok:boolean}`로 호출 | `codex.ts`의 결과 추출 위치를 수정 |
| ~~V2~~ | Codex `-s workspace-write`가 cwd만 쓰기 허용, 밖은 차단, 네트워크 차단, `network_access=true`로 허용 | **dev-kang에서 `codex sandbox`로 확인 완료**(§0.2) | — |
| V3 | `claude -p --output-format json --json-schema`가 `structured_output`을 준다 | 스키마 `{ok:boolean}`로 호출 | `result` 파싱 경로만 사용 |
| V4 | Claude `--permission-mode dontAsk` + `--disallowedTools Edit Write`에서 쓰기가 거부된다 | 파일 쓰기를 지시하고 결과 확인 | G6만으로 강제(동작은 같음) |
| V5 | 한도 메시지 형식 | 실제로는 재현할 수 없어 단위 테스트 샘플로만 검증 | `rate-limit.ts`의 패턴 갱신 |

dev-kang의 Codex는 설치와 로그인이 끝나 있습니다. **Claude는 로그인되어 있지 않으므로** V3, V4를 확인하기 전에 사용자가 직접 `claude`로 로그인해야 합니다.

---

## 13. 구현 순서와 완료 기준

두 CLI 연동을 한 번에 하면 문제를 가려내기 어려우므로 두 단계로 나눕니다.
- **1단계(M1~M4)**: Claude 하나로 모든 역할을 돌려 파이프라인 흐름을 검증합니다. 작업과 검수는 같은 모델이지만 서로 다른 세션과 권한 프로필로 분리됩니다. 테스트용 워크스페이스 설정에서 `roles`를 모두 `claude`로 덮어씁니다.
- **2단계(M5~)**: Codex 어댑터를 붙여 기본 역할 조합(작업 Codex / 검수 Claude)으로 전환합니다.

doctor는 **설정된 역할이 실제로 쓰는 클라이언트만** 필수로 검사합니다(1단계에서는 codex가 없어도 통과).

| 단계 | 내용 | 검증 |
|---|---|---|
| M1 | 골격: cli, config, request 파서, state, runlog, git 헬퍼 | `node --test`: request 검증 케이스, config 기본값 병합, timeline 렌더링 |
| M2 | 클라이언트 1: spawn(stdin, 타임아웃, 프로세스 그룹 종료), **claude 어댑터**(readonly/write/qa 프로필), rate-limit | 단위 테스트: 명령줄 조립(프로필 × grant), 한도 메시지 샘플 파싱. `doctor --deep`으로 V3, V4 |
| M3 | 검수 루프 + 게이트 G1~G9 | fake-client로 §8.1, §8.2 표의 **모든 행**에 대한 테스트 |
| M4 | 순차 파이프라인(plan, dev, QA, fix, wiki) + 커밋/squash + resume | fake-client + 임시 git 저장소로 E2E: 정상 완료, QA 실패 → fix → 통과, 각 Pending 후 resume. **1단계 완료 기준**: fixtures 샘플 앱에서 모든 역할을 claude로 둔 `--mode full` 실제 실행 1회 완주(토큰 소모) |
| M5 | 클라이언트 2: **codex 어댑터** | 단위 테스트: 명령줄 조립. `doctor --deep`으로 V1. 기본 역할 조합으로 fixtures `--mode full` 실제 실행 1회 완주 |
| M6 | 병렬 레인: G2/G2', worktree, 동시 실행, MERGE, 통합 QA | fake-client로 겹침 → 순차 전환, 2레인 정상, 머지 충돌 → Pending, 통합 실패 → integration fix |
| M7 | 예약(schedule.ts), status/logs/list/watch/cleanup, qa-runtime setup | 단위 테스트(`at -t` 시각 변환, job id 파싱), 수동 확인: dev-kang에서 at 등록/해제 |
| M8 | Master 스킬, README | 수동: Master 스킬로 fixtures에 요청 인터뷰 → `--parallel` 실행 1회 완주 |

**완료 기준**: `node --test` 전체 통과, `tsc --noEmit` 오류 0, M4·M5·M8의 실제 완주(ai-log에 기획 → 개발 → QA 증거 → Wiki 기록이 남고 런 브랜치에 커밋 생성).

이 도구 자체를 만드는 개발 방식(Codex 작성 / Claude Code 읽기 전용 검수)은 저장소의 `CLAUDE.md`, `AGENTS.md`에 정의합니다.

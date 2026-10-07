# agent-workflow

## 무엇인가

소프트웨어 변경을 기획 → 개발 → 독립 QA → Wiki 순서로 진행하는 CLI입니다.
Codex가 작성하고 Claude가 검수하며, Claude Code의 Master 스킬이 요청 인터뷰와 실행·중단 처리를 맡습니다.

## 요구 사항

Linux, Node ≥ 22.18, git, 로그인된 `codex`·`claude` CLI가 필요합니다.
대상 워크스페이스는 커밋이 하나 이상 있는 git 저장소여야 합니다.
브라우저 QA에는 Playwright chromium을 사용합니다.
`at`과 실행 중인 atd는 사용량 한도 리셋 후 자동 재개 예약에 쓰는 선택 사항입니다.

## 설치

이 도구의 저장소에서 실행합니다. `<ws>`는 대상 저장소 경로로 바꿉니다.
Node 타입 스트리핑은 node_modules 밖에서만 동작하므로 `npm link`로 설치합니다.

```sh
npm install
npm link
agent-workflow qa-runtime setup
agent-workflow doctor --deep --workspace <ws>
```

`doctor --deep`은 실제 AI 호출로 동작을 확인하므로 토큰을 사용합니다(spec §12).

## Master 스킬 설치

이 도구의 저장소에서 다음 명령을 실행합니다.

```sh
mkdir -p ~/.claude/skills && cp -r skill/agent-workflow ~/.claude/skills/
```

Claude Code에서 `/agent-workflow`를 호출하고 대상 저장소와 원하는 변경을 설명하면 Master가 인터뷰 후 승인을 받아 실행합니다.

## 대상 저장소 설정

대상 저장소 루트의 `agent-workflow.json`에 필요한 필드만 지정합니다.
파일이 없거나 필드를 생략하면 기본값을 사용하며, 파일이 없으면 doctor가 경고합니다.

```json
{
  "setupCommand": "npm ci",
  "testCommand": "npm test",
  "app": {
    "startCommand": "npm run dev -- --port {port}",
    "readyUrl": "http://127.0.0.1:{port}/",
    "startTimeoutSec": 90
  },
  "wikiDir": "docs/wiki",
  "roles": {
    "devAuthor": { "client": "codex" },
    "devReviewer": { "client": "claude" }
  },
  "limits": {
    "maxReviewRounds": 5,
    "maxLanes": 3
  }
}
```

| 필드 | 용도와 기본값 |
|---|---|
| `setupCommand` | worktree 생성 직후 실행하는 준비 명령. 기본 `null` |
| `testCommand` | 개발 라운드마다 실행하는 테스트 게이트. 기본 `null` |
| `app` | 브라우저 QA용 기동 명령·준비 URL. `{port}` 치환, 환경변수 `PORT` 제공. 기본 `null`, 준비 제한 90초 |
| `wikiDir` | Wiki 저장 경로. 기본 `docs/wiki` |
| `roles` | 역할별 `client`, `model`, `effort`. 기본 Author는 Codex, Reviewer·QA는 Claude, 모델·effort는 `null` |
| `limits` | 검수 5회, 같은 지적 2회, QA 롤백 3회, 레인 3개, 단계 제한 45분이 기본값 |

브라우저 시나리오가 있으면 `app`이 필요합니다. 설정은 run·resume 시작마다 다시 읽습니다.
명령 실행과 필드 상세는 [spec §4.2](spec.md#42-설정-agent-workflowjson)를 참고하세요.

## 사용법

### 1. 빠른 시작 (5분)

도구 설치·CLI 로그인·[Master 스킬 설치](#master-스킬-설치)를 마쳤다고 가정합니다.
아래는 의존성 없는 Node CLI를 처음 만드는 예입니다. 5분은 요청까지의 준비 시간이며 AI 실행 시간은 별도입니다.

```sh
mkdir hello-cli
cd hello-cli
git init -b main
cat > agent-workflow.json <<'JSON'
{
  "setupCommand": null,
  "testCommand": null,
  "app": null,
  "wikiDir": "docs/wiki"
}
JSON
git add agent-workflow.json
git commit -m "Initialize workspace"
agent-workflow doctor --workspace "$PWD"
tmux new -s hello-workflow
claude
```

git 작성자 정보가 없다면 첫 커밋 전에 이 저장소의 `git config user.name`과 `git config user.email`을 설정합니다.
`doctor`의 fail은 [FAQ](#8-문제-해결faq)를 보고 해결한 뒤 다시 검사합니다.
이 예시는 브라우저 앱이 없어 `app: null`이며, 테스트 명령도 아직 없습니다. 기존 프로젝트에서는 실제 준비·테스트 명령을 [설정](#대상-저장소-설정)에 넣으세요.

Claude Code 대화창에 다음처럼 입력합니다. 대상 경로는 `pwd`로 확인한 절대 경로로 바꿉니다.

```text
/agent-workflow
대상 저장소는 /home/me/hello-cli입니다.
Node로 실행하는 hello.mjs를 만들어 주세요. 외부 의존성 없이
node hello.mjs 민수는 "안녕하세요, 민수!", 인자가 없으면 "안녕하세요!"를
한 줄 출력하고 종료 코드 0으로 끝나게 해 주세요.
```

Master 질문에 답하고 REQ와 스펙 외 범위를 확인해 승인하면 런이 시작됩니다.

### 2. Master와 함께 쓰기 (권장 흐름)

긴 실행 중 SSH 연결이 끊겨도 Master와 CLI가 살아 있도록 tmux 안에서 `claude`를 실행합니다([spec §0.1 A14](spec.md#01-질문하지-않고-정한-가정-검토-필요)).
분리할 때는 `Ctrl-b`, `d`, 다시 접속할 때는 `tmux attach -t hello-workflow`를 사용합니다.

인터뷰는 모호한 요구를 테스트 가능한 조건으로 바꾸는 과정입니다. 예를 들면:

```text
사용자: 이름을 받아 인사하는 Node CLI를 만들어 주세요.
Master: 파일 이름, 이름이 없을 때의 문구, 이름을 여러 개 줬을 때의 동작은요?
사용자: hello.mjs로요. 없으면 "안녕하세요!", 여러 개면 첫 인자만 쓰세요.
Master: REQ-001: 첫 인자가 있으면 "안녕하세요, <이름>!"를 한 줄 출력, 종료 0.
        REQ-002: 인자가 없으면 "안녕하세요!"를 한 줄 출력, 종료 0.
        스펙 외 범위: 옵션 파서, 배포 패키징, 브라우저 UI.
        제약: Node, 외부 의존성 없음. 이 범위로 실행할까요?
사용자: 네, 승인합니다.
```

Master는 저장소를 읽고 먼저 doctor를 실행하며, 불명확한 조건을 모두 물은 뒤
`.aw/requests/<YYYYMMDD>-<slug>.md`에 [spec §5.1 템플릿](spec.md#51-요청-명세-requestmd-0단계-master-작성)으로 요청을 씁니다.
REQ 목록과 스펙 외 범위를 보여 주고 명시적 승인을 받아 실행합니다. 실행 시 요청은 `ai-log/<run-id>/00-request/request.md`로 복사·고정됩니다.
시작한 런의 요청을 바꾸지 않으며 새 요구는 새 런으로 진행합니다.

실행 중 Master는 CLI를 백그라운드로 실행하고 `watch <run-id>`로 이벤트를 따라가며 단계 변경을 짧게 알립니다.
중단 처리는 [Master SKILL.md](skill/agent-workflow/SKILL.md)의 종료 코드 규칙을 따릅니다.

| 코드 | Master가 하는 일 |
|---|---|
| 0 | `status --view decisions`로 결과를 요약하고 런 브랜치 검토·머지를 안내합니다. 요청 없이 머지하지 않습니다. plan 모드는 계획 완료입니다. |
| 20 | `status --json`의 pending을 읽습니다. 요청에서 명확히 도출되는 답만 내리고, 제품 결정이 필요하면 사용자에게 묻습니다. 타당한 network 요청은 승인하고 알립니다. 안전한 로컬 환경 문제는 고치고, 충돌은 detail의 절차로 해결합니다. |
| 21 | 필요한 결정과 이유를 설명하고 사람의 명시적 승인을 기다립니다. full 권한은 사람만 승인합니다. |
| 22 | 어느 CLI의 한도인지, `scheduledResume`에 재개 예약이 있는지와 그 시각을 알립니다. |
| 1 | 호출 목록과 실패한 호출 로그를 읽고 원인을 설명·수정한 뒤 재개합니다. |
| 2 | 명령 인자나 `agent-workflow.json`을 수정합니다. |

`qa_rollback_cap`이면 QA와 decisions를 읽고 시나리오·요구·개발 중 어디가 문제인지 판단합니다.
답변이 요청을 바꾼다면 사용자와 상의하며, 답변 후에는 해당 레인 QA부터 다시 실행합니다.

### 3. 런 한 번에 일어나는 일

기본 역할은 작성 Codex, 검수·QA Claude입니다. 기계 게이트 상세는 [spec §7](spec.md#7-기계-게이트)을 참고하세요.

- **SETUP**: CLI가 시작 시점의 HEAD에서 런 브랜치와 worktree를 만들고 `setupCommand`를 실행합니다. 병렬 레인도 각각 준비합니다. 명령 실패·시간 초과는 `environment`(20)로 멈추고 준비 로그를 남깁니다.
- **PLANNING**: 작성자가 요청을 TODO·QA 시나리오·필요한 레인 분할안으로 바꾸고 검수자가 승인합니다. G1은 REQ 누락·잘못된 ID 등을, G2는 레인 구조를 검사하며 승인 결과는 `01-planning/plan.json`, `plan.md`에 남습니다.
- **DEV**: 작성자가 TODO를 구현하고 파일 증거를 제시하며, 검수자는 요청과 변경을 대조합니다. G3·G4는 항목과 증거, G5는 설정된 테스트, 병렬의 G7은 소유 경로 밖 변경을 막습니다. 승인 후 변경을 squash 커밋하고 `todo.md`에 체크·근거를 남깁니다.
- **QA**: 별도 QA 세션은 코드·TODO·계획 요약 없이 시나리오로 CLI나 브라우저를 검사합니다. 보고서와 로그·스크린샷은 `03-qa/`에 남기며 G6은 저장소 변경, G9는 보고 일관성과 증거 누락을 막습니다. 시나리오가 없으면 호출 없이 통과합니다.
- **FIX**: QA 실패 시 기획 작성·검수가 결함을 수정 TODO로 바꾸는 `FIX_PLANNING`을 거친 뒤 DEV와 해당 범위 전체 QA를 다시 수행합니다. 결함 대응 누락은 G1이 막고, 기본 롤백 3회 한도에 도달하면 `qa_rollback_cap`(20)로 판단을 요청합니다.
- **WIKI**: 작성자가 변경을 `wikiDir` 문서로 정리하고 검수자가 승인합니다. G8은 Wiki 밖 변경·파일 목록 불일치·`log.md` 누락을 막으며 승인 문서를 런 브랜치에 커밋합니다. 기획 작성·모든 검수에도 G6이 적용됩니다.

```text
순차: SETUP → PLANNING → main: DEV → QA → WIKI → 완료
                                  ↑     │
                                  └ FIX ←┘ (QA 실패 시)

병렬: SETUP → PLANNING ┬→ a: SETUP → DEV → QA (실패 시 FIX → DEV → QA) ─┐
                      └→ b: SETUP → DEV → QA (실패 시 FIX → DEV → QA) ─┤
                                 모두 완료 → MERGE ←──────────────────┘
                                               ↓
                           통합 테스트 + 전체 QA → WIKI → 완료
                                    ↑       │
                                    └ FIX ←─┘ (integration 레인)
```

`--parallel`은 독립된 경로를 맡는 레인마다 worktree와 `aw/<run-id>-lane-<id>` 브랜치를 사용합니다.
승인된 소유 경로가 겹치거나 레인이 하나면 순차로 전환합니다.
레인 QA는 그 레인에 지정된 시나리오만 실행하고, MERGE는 레인 ID 순으로 `--no-ff` 머지합니다.
그 뒤 통합 QA는 `testCommand`와 전체 시나리오(레인 미지정 시나리오 포함)를 다시 실행합니다([spec §2](spec.md#2-전체-흐름)).

### 4. 결과 확인과 반영

아래부터는 대상 저장소 루트에서 실행합니다. `run`의 첫 출력 줄이 run-id이며,
`agent-workflow list`로도 찾을 수 있습니다. 예시 ID는 실제 출력값으로 바꿉니다.

```sh
RUN_ID=20261007_153000_hello
agent-workflow status "$RUN_ID"
git log --oneline "main..aw/$RUN_ID"
git diff main "aw/$RUN_ID"
agent-workflow status "$RUN_ID" --view decisions
agent-workflow status "$RUN_ID" --view todo
agent-workflow status "$RUN_ID" --view qa
agent-workflow status "$RUN_ID" --view timeline
agent-workflow logs "$RUN_ID"
agent-workflow logs "$RUN_ID" --seq 1
```

기본 status 출력은 다음 형식입니다(예시 발췌, 시각·경로·내용은 런마다 다릅니다).
JSON에는 `stage`와 별도로 `lanes[].phase`가 있어 DEV·QA·FIX_PLANNING을 확인할 수 있습니다.

```text
런: 20261007_153000_hello
단계: DONE
상태: DONE
모드: full
병렬: 아니오
마지막 종료 코드: 0
런 브랜치: aw/20261007_153000_hello
```

timeline은 아래 표 형식이고, decisions는 author·gate·tests·review·qa 중 판정이 있는 이벤트만 같은 표로 표시합니다.
qa는 가장 최근 `report.md`의 경로와 내용, todo는 레인별 TODO를 표시하며 기록이 아직 없으면 `아직 없음`입니다.

```text
| 시각 | 레인 | 단계 | 역할 | 판정 | 내용 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-07 15:30:00 | - | - | - | - | 런을 시작했습니다. |
| 2026-10-07 15:30:01 | - | SETUP | - | PASS | SETUP을 완료했습니다. |
```

run·watch의 이벤트 줄은 `시각 레인 단계 역할 이벤트종류 판정 내용` 형식입니다.

```text
2026-10-07 15:30:00 run - - run_start - 런을 시작했습니다.
2026-10-07 15:30:01 run SETUP - setup PASS SETUP을 완료했습니다.
```

logs 목록에서 seq를 고르면 상세 출력은 `프롬프트`, `최종 출력`, `stderr` 순서입니다(stderr는 끝 100줄).
목록 형식 예시는 다음과 같습니다.

```text
| seq | lane | stage | role | round | exitCode | durationMs |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | run | PLANNING | planningAuthor | 1 | 0 | 1200 |
```

완료된 full·wiki 런의 코드·테스트·QA 증거·문서를 사람이 검토한 뒤 머지합니다.
아래 `main`은 대상 저장소의 기본 브랜치로 바꾸며, main 작업 사본을 정리한 상태에서 실행합니다.

```sh
git switch main
git merge --no-ff "aw/$RUN_ID"
agent-workflow cleanup "$RUN_ID"
# 완료된 런들을 한꺼번에 정리하려면:
agent-workflow cleanup --finished
```

cleanup은 worktree·레인 브랜치·예약을 정리하고 런 브랜치와 `ai-log`는 보존합니다.
미완료 런은 `cleanup "$RUN_ID" --force`가 필요합니다. 재개할 런은 정리하지 마세요.

### 5. CLI만으로 쓰기 (Master 없이)

인터뷰·승인·중단 판단을 직접 맡습니다. 다음은 요청 파일 전체를 만드는 예입니다.
제목, 정확한 `- REQ-xxx:` 줄, 스펙 외 범위가 없거나 ID가 중복되면 run이 종료 코드 2로 거부합니다.

```sh
mkdir -p .aw/requests
cat > .aw/requests/20261007-hello.md <<'REQUEST'
# 이름으로 인사하는 CLI

## 목표
Node에서 실행하는 작은 인사 프로그램을 만든다.
이름이 있는 경우와 없는 경우를 모두 명확히 처리한다.

## 요구사항
- REQ-001: node hello.mjs 민수는 "안녕하세요, 민수!"를 한 줄 출력하고 종료 코드 0으로 끝난다. 인자가 여러 개면 첫 인자만 이름으로 쓴다.
- REQ-002: node hello.mjs는 "안녕하세요!"를 한 줄 출력하고 종료 코드 0으로 끝난다.

## 스펙 외 범위
- 옵션 파서, 배포 패키징, 브라우저 UI.

## 주의사항
- Node ESM을 사용하고 외부 의존성을 추가하지 않는다.
REQUEST
agent-workflow doctor
agent-workflow run --mode full --request-file .aw/requests/20261007-hello.md --name hello
```

`--name`은 소문자 영문·숫자·하이픈만 받으며 기본값은 `run`입니다.
별도 터미널에서 `agent-workflow watch "$RUN_ID"`로 관찰할 수 있습니다.
다음은 모드별 대안입니다. 각각 새 런을 시작하므로 필요한 흐름 하나를 선택합니다.

```sh
# 계획만 승인받은 뒤 내용을 보고 같은 런을 full로 이어 가기:
agent-workflow run --mode plan --request-file .aw/requests/20261007-hello.md --name hello-plan
# 위 명령이 출력한 ID를 사용:
RUN_ID=20261007_154000_hello-plan
agent-workflow status "$RUN_ID" --view plan
agent-workflow resume "$RUN_ID" --mode full

# 독립된 영역을 가진 요청의 계획·개발을 병렬로 실행:
agent-workflow run --mode full --request-file .aw/requests/20261007-hello.md --parallel --name hello-parallel

# 현재 HEAD에서, 해석 가능한 과거 커밋 이후의 변경을 Wiki로 정리:
agent-workflow run --mode wiki --since HEAD~1 --name wiki-update
```

작은 hello 요청의 병렬 예시는 단일 레인으로 계획되면 순차 전환됩니다.
wiki는 `--since`가 필수이고 `--parallel`은 허용되지 않습니다. `HEAD~1`은 이전 커밋이 있을 때만 쓸 수 있으며 실제 커밋·태그로 바꿀 수 있습니다.
wiki 요청 파일은 선택 사항입니다. plan·full은 요청 파일이 필수이고 `--since`는 허용되지 않습니다.
`resume --mode full`은 plan 런에만 사용할 수 있습니다.

### 6. 멈췄을 때 (resume)

먼저 `agent-workflow status "$RUN_ID" --json`의 `pending`에서 `kind`, `lane`, `stage`, `detail`을 확인합니다.
여러 Pending이 있으면 한 번에 하나씩 처리하고, 답변 대상이 여러 개면 `--lane a`처럼 선택합니다(`main`, `integration`도 가능).
여러 종류가 함께 남으면 런 종료 코드는 `1 > 21 > 20 > 22` 순으로 선택됩니다.

**20 — 판단·환경·network 요청.** 예를 들어 명세 해석은 확정된 요구를 근거로 답하고, DEV의 패키지 다운로드 요청은 필요성을 확인해 network를 부여합니다.

```sh
agent-workflow status "$RUN_ID" --json
agent-workflow resume "$RUN_ID" --answer "REQ-001에 따라 여러 인자 중 첫 인자만 이름으로 사용하세요." --lane a
agent-workflow resume "$RUN_ID" --grant network --lane a
```

위 두 resume은 각각 해당 Pending이 있을 때 쓰는 별도 예시입니다. 런 단위 Pending 하나면 `--lane`을 생략합니다.
`--grant`는 DEV·WIKI Pending에만 적용되고 해당 루프가 끝날 때까지 유효합니다.
QA 환경 문제는 환경을 고친 뒤 `--answer "QA 환경을 복구했습니다. 다시 검사하세요."`로 재개합니다.

**21 — 사람의 결정.** `permission_full`은 샌드박스 해제가 필요한 상황입니다.
사람이 이유를 확인하고 명시적으로 승인한 뒤에만 다음 명령을 실행합니다(Master 자체 승인 불가).

```sh
agent-workflow resume "$RUN_ID" --grant full --lane a
```

**22 — 사용량 한도.** `pending[].resetAt`과 status의 `예약:` 또는 JSON의 `scheduledResume`을 확인합니다.
리셋 시각을 알며 `at`·atd를 사용할 수 있으면 가장 늦은 리셋 시각 + 2분에 한 번 재개를 예약합니다.
예약이 없거나 직접 재개하려면 한도가 회복된 뒤 실행합니다. 직접 실행되는 resume은 기존 예약을 취소합니다.

```sh
agent-workflow status "$RUN_ID"
agent-workflow resume "$RUN_ID"
```

예약 표시는 `예약: 2026-10-07T08:02:00.000Z (작업 7)` 또는 `예약: 없음` 형식입니다.
예약 출력은 `ai-log/<run-id>/scheduled-resume.log`에 남습니다.

**1 — 실패.** 예를 들어 AI 출력 형식·프로세스·타임아웃·읽기 전용 게이트가 두 번 실패하면 멈춥니다.
logs 목록에서 실패한 seq를 골라 원인을 진단·수정하고 답변·권한 인자 없이 재개합니다.

```sh
agent-workflow logs "$RUN_ID"
agent-workflow logs "$RUN_ID" --seq 1
agent-workflow resume "$RUN_ID"
```

**merge_conflict(20).** CLI는 충돌한 merge를 abort한 상태로 멈춥니다.
`status --json`의 detail에 적힌 worktree와 merge 명령을 그대로 사용해 다시 머지하고, 충돌 파일을 편집·해결·커밋한 뒤 재개합니다.
아래 경로·레인·파일은 detail에 나온 실제 값으로 바꿉니다.

```sh
git -C ".aw/worktrees/$RUN_ID/main" merge --no-ff "aw/$RUN_ID-lane-a"
# detail의 충돌 파일을 편집해 해결한 뒤:
git -C ".aw/worktrees/$RUN_ID/main" add <해결한-파일>
git -C ".aw/worktrees/$RUN_ID/main" commit -m "Resolve lane merge conflict"
agent-workflow resume "$RUN_ID" --answer "충돌을 해결하고 머지 커밋을 완료했습니다."
```

**Ctrl-C·비정상 종료.** Ctrl-C/SIGTERM은 자식 프로세스를 종료하고 실패 상태(1)를 저장합니다.
강제 종료·재부팅 후에는 RUNNING으로 남아도 실행 PID가 죽었으면 인자 없는 `resume "$RUN_ID"`로 이어 갑니다.
살아 있는 PID가 있으면 중복 실행을 막아 종료 코드 2가 됩니다.
재개는 worktree를 HEAD로 reset하고 미추적 파일을 정리하므로 충돌 해결 등 수동 작업은 먼저 커밋해야 합니다.
승인된 작업은 유지하고 중단된 루프를 새 라운드 번호로, QA를 새 attempt로 다시 실행합니다([spec §8.5](spec.md#85-재개-resume)).
종료 코드 2는 재시도 전에 인자·설정·요청 오류부터 수정합니다.

### 7. 역할과 모델 바꾸기

기본 조합은 `planningAuthor`, `devAuthor`, `wikiAuthor`가 Codex이고,
`planningReviewer`, `devReviewer`, `wikiReviewer`, `qa`가 Claude입니다.
작성과 검수를 다른 클라이언트로 나누어 교차 검수하며 QA도 별도 세션으로 실행하는 설계입니다([spec §0](spec.md#0-확정된-결정-사항)).
매 호출은 새 세션이고 모델·effort 기본값은 `null`(각 CLI 기본값 사용)입니다.

모든 역할을 Claude로 쓰려면 `agent-workflow.json`의 roles를 다음처럼 설정합니다.

```json
{
  "roles": {
    "planningAuthor": { "client": "claude" },
    "planningReviewer": { "client": "claude" },
    "devAuthor": { "client": "claude" },
    "devReviewer": { "client": "claude" },
    "qa": { "client": "claude" },
    "wikiAuthor": { "client": "claude" },
    "wikiReviewer": { "client": "claude" }
  }
}
```

역할별 모델·effort 지정도 가능합니다. 아래 모델 문자열은 예시 자리표시자이므로
설치·로그인한 CLI에서 실제 사용할 수 있는 모델명으로 바꿉니다.

```json
{
  "roles": {
    "devAuthor": { "client": "codex", "model": "<사용-가능한-Codex-모델>", "effort": "high" },
    "devReviewer": { "client": "claude", "model": "<사용-가능한-Claude-모델>", "effort": "medium" }
  }
}
```

설정 스키마는 effort로 `low|medium|high|xhigh|null`을 허용합니다. CLI는 이를 Codex의
`model_reasoning_effort`, Claude의 `--effort`에 전달하므로 선택한 클라이언트·모델이 지원하는 값을 사용하세요.
생략한 역할·필드는 기본값이며 설정은 run·resume 시작마다 다시 읽습니다.

### 8. 문제 해결(FAQ)

| 증상 | 원인 | 해결 |
|---|---|---|
| doctor의 Node fail | Node가 22.18 미만 | Node ≥ 22.18로 바꾼 뒤 다시 doctor를 실행합니다. |
| git 또는 클라이언트 경로·버전 fail | 실행 파일이 없거나 PATH·실행이 잘못됨 | git 및 역할이 사용하는 codex·claude 설치/PATH를 확인하고 `--version` 실행을 복구합니다. |
| codex·claude 로그인 fail | 해당 CLI 로그인 상태를 확인할 수 없음 | 해당 CLI에서 로그인을 완료한 뒤 `codex login status`, `claude auth status`와 doctor를 다시 확인합니다. |
| workspace fail | git 저장소가 아니거나 첫 커밋이 없음 | `git init -b main`, 필요한 파일 add, 첫 commit을 합니다([빠른 시작](#1-빠른-시작-5분)). |
| 설정 fail | 잘못된 키·타입·값 | doctor의 스키마 오류에 따라 `agent-workflow.json`을 수정합니다([spec §4.2](spec.md#42-설정-agent-workflowjson)). |
| chromium fail 또는 browser QA의 environment | 브라우저 설치·headless 기동 문제 | `agent-workflow qa-runtime setup` 후 doctor를 다시 실행합니다. 설치·기동 오류가 남으면 해당 오류부터 해결합니다. |
| doctor --deep의 V1·V3·V4 또는 deep fail | 실제 스키마 출력·readonly 차단·임시 저장소 준비 검사 실패 | 출력의 error·exitCode와 CLI 동작을 확인해 원인을 고친 뒤 deep 검사를 다시 실행합니다([spec §12](spec.md#12-구현-전에-검증할-사항-doctor---deep으로-자동-확인)). |
| at·atd warn | 예약 도구·서비스 사용 불가 | 자동 예약이 필요하면 at 설치·atd 활성화를 확인합니다. 아니면 한도 회복 후 직접 resume합니다. |
| QA 포트를 사용할 수 없음(environment, 20) | 지정 포트를 다른 프로세스가 사용하거나 슬롯이 부족함 | 점유 프로세스를 확인해 정리하거나 `agent-workflow qa-runtime setup --base-port 5100 --slots 4`로 비어 있는 범위를 설정하고 `resume "$RUN_ID" --answer "QA 포트 설정을 복구했습니다."`를 실행합니다. |
| 앱 실행 후 G6 위반, 재시도 후 실패(1) | 앱이 worktree에 로그·캐시 등 미추적 파일을 생성함 | 런에 적용되는 `.gitignore`로 생성 파일을 제외합니다. 새 런이면 대상 저장소에서 수정·커밋 후 시작합니다. 진행 중 런은 원인을 명시한 수정 요청으로 새 런을 만들며 Master가 임의로 worktree를 편집하지 않습니다. |
| 같은 지적으로 loop_repeat(20) | 같은 지적 ID가 기본 2회 연속 반려됨 | `status --view decisions`, logs와 pending detail을 읽고 요구에 근거한 구체적 판단을 `resume --answer`로 전달합니다. 병렬이면 해당 레인을 선택합니다. |
| 로컬 수정이 결과에 반영되지 않음 | A2: 런은 시작 시 HEAD를 기준으로 worktree를 만듦 | 포함할 변경은 run 전에 커밋합니다. 기존 런에는 나중의 커밋이 자동 반영되지 않으므로 필요하면 새 런을 시작합니다. |

`doctor`는 fail이 하나라도 있으면 2, warn만 있으면 0입니다.
포트 설정은 `~/.agent-workflow/qa-runtime.json`에 저장되며 기본 4100부터 4개 슬롯입니다.
main·integration은 슬롯 0을 사용합니다. 병렬 최대 레인까지 포트를 확보하려면 `--slots`를 `maxLanes + 1` 이상으로 설정하세요.
포트 설정 파일이 없으면 런은 basePort 4100, slots = `maxLanes + 1`을 사용합니다.
G6과 앱 생성 파일 규칙은 [spec §5.6](spec.md#56-qa-qa--integration_qa),
커밋되지 않은 변경 제외는 [spec §0.1 A2](spec.md#01-질문하지-않고-정한-가정-검토-필요)를 참고하세요.

### 9. 팁

- 요청은 REQ 10개 안팎의 검토 가능한 크기로 나누면 다루기 쉽습니다. 이는 운영 팁이며 CLI의 개수 제한은 아닙니다.
- 처음부터 만드는 프로그램은 언어·런타임·프레임워크·의존성 허용 범위 등 스택을 요청에 명시하세요.
- 기본 조합은 Codex와 Claude 두 구독의 사용량을 소비합니다. 검수 반복·QA 재실행·`doctor --deep`도 실제 호출을 사용하므로 한도와 예약 상태를 확인하세요.
- 결과 코드와 QA 증거는 사람이 검토한 후 머지하세요. 완료 코드 0이 사람의 최종 검토를 대신하지 않습니다.

## 명령 요약

공통으로 `--workspace <ws>`를 받으며 기본값은 현재 디렉터리입니다.
`doctor`, `status`, `list`, `logs`는 `--json`을 지원합니다.

| 명령 | 설명 |
|---|---|
| `doctor [--deep]` | 환경·설정을 검사하며, `--deep`은 실제 AI 호출도 확인합니다. |
| `run --mode plan\|full\|wiki` | 요청으로 런을 시작합니다. plan·full은 `--request-file`, wiki는 `--since`가 필수이며 병렬은 `--parallel`입니다(wiki 제외). |
| `resume <run-id>` | 중단된 런을 재개합니다. `--answer`, `--lane`, `--grant network\|full`, `--mode full`을 사용할 수 있습니다. |
| `status <run-id>` | 현재 상태나 `--view current\|timeline\|decisions\|plan\|todo\|qa` 기록을 표시합니다. |
| `logs <run-id> [--seq <N>]` | AI 호출 목록 또는 특정 호출의 프롬프트·출력·stderr를 표시합니다. |
| `list` | 실행 기록에 있는 런 목록과 상태를 표시합니다. |
| `watch <run-id>` | 기존 이벤트와 새 이벤트를 따라가며 런이 멈추면 종료합니다. |
| `cleanup <run-id>\|--finished [--force]` | worktree·레인 브랜치·예약을 정리하고 런 브랜치와 ai-log는 남깁니다. 미완료 런은 `--force`가 필요합니다. |
| `qa-runtime setup` | chromium과 QA 포트 설정을 준비합니다. `--slots` 기본 4, `--base-port` 기본 4100입니다. |

| 종료 코드 | 의미와 다음 행동 |
|---|---|
| 0 | 완료 또는 진행 가능한 체크포인트 |
| 1 | 실패: 로그로 원인을 확인하고 수정 후 resume |
| 2 | 명령·설정 오류: 인자나 설정 수정 |
| 20 | Master 판단 필요: Pending 확인 후 답변 또는 network 권한으로 resume |
| 21 | 사용자 결정 필요: 명시적 승인 후 resume, full 권한은 사람만 승인 |
| 22 | 사용량 한도: 예약된 재개를 기다리거나 나중에 resume |

전체 인자는 [spec §9](spec.md#9-cli-명령-규격), 재개 규칙은 [spec §8.5](spec.md#85-재개-resume)를 참고하세요.

## 실행 기록

대상 저장소의 `ai-log/<run-id>/`에 기록을 보존합니다.

```text
ai-log/<run-id>/
├─ state.json, run.lock           상태와 실행 PID
├─ events.jsonl, timeline.md      기계용·사람용 이벤트
├─ 00-request/                   고정된 요청
├─ 01-planning/                  계획과 검수
├─ 02-development/<lane>/        개발·테스트·TODO
├─ 03-qa/<lane|integration>/     QA 보고서·스크립트·증거
├─ 04-wiki/                      Wiki 작성과 검수
├─ scheduled-resume.log          예약 재개 출력
└─ raw/                          AI 호출 원본과 메타데이터
```

결과 커밋은 런 브랜치 `aw/<run-id>`에 남습니다. main 머지는 사람이 합니다.
`cleanup`도 런 브랜치와 실행 기록을 보존합니다. 상세 구조는 spec §4.3을 참고하세요.

## 개발

오프라인 테스트와 타입 검사를 실행합니다.

```sh
node --test test/*.test.ts
npx tsc --noEmit
```

개발 방식과 작업 규칙은 [CLAUDE.md](CLAUDE.md)와 [AGENTS.md](AGENTS.md)를 따릅니다.

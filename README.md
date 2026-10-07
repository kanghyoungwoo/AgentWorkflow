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

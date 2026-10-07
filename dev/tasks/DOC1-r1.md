# DOC1-r1 작업 지시서 — README 사용법 상세화

## 목표
README.md에 처음 쓰는 사람이 따라 할 수 있는 **상세 사용법**을 더한다. 기존 절(무엇인가, 요구 사항, 설치, 스킬 설치, 설정, 명령 요약, 실행 기록, 개발)은 유지하고 필요한 만큼만 다듬는다. 모든 내용은 **현재 코드와 spec에서 실제로 확인한 동작**이어야 한다(추측 금지). 코드 동작과 spec.md는 바꾸지 않는다.

## 추가할 절 (한국어, "설치" 다음, "명령 요약" 앞에 "사용법" 절)
1. **빠른 시작 (5분)**: 새 대상 저장소를 만들고(git init, 첫 커밋, `agent-workflow.json` 예시), `doctor`를 실행한 뒤 Claude Code에서 `/agent-workflow`로 요청하기까지 명령 순서대로 쓴다.
2. **Master와 함께 쓰기 (권장 흐름)**
   - tmux 안에서 `claude`를 실행하는 이유(긴 실행, SSH 끊김)
   - 인터뷰 예시: 사용자 요청 → Master 질문 → REQ·스펙 외 범위 정리 → 승인을 짧은 대화로 보여 준다
   - 요청 파일 위치(`.aw/requests/`), §5.1 템플릿
   - 실행 중 Master가 하는 일(watch, 단계 변경 알림), 멈췄을 때 Master가 종료 코드별로 하는 일(SKILL.md 기준)
3. **런 한 번에 일어나는 일**: SETUP → PLANNING → DEV → QA → (FIX) → WIKI를 단계마다 2~3줄로 설명한다. 누가(작성/검수/QA 역할), 무엇을 만들고, 어떤 게이트가 막는지 적고, 순차와 병렬(`--parallel`, 레인, MERGE, 통합 QA)의 차이를 짧은 그림(텍스트 다이어그램)으로 보여 준다.
4. **결과 확인과 반영**:
   - 런 브랜치 `aw/<run-id>`를 확인한다(`git log`, `git diff main aw/<run-id>`).
   - 사람이 머지한다.
   - `status --view decisions|todo|qa|timeline`, `logs --seq`로 과정을 본다(예시 출력 몇 줄 포함).
   - `cleanup`으로 정리한다.
5. **CLI만으로 쓰기 (Master 없이)**:
   - 요청 파일을 직접 쓴다(예시 전체).
   - `run --mode full|plan|wiki`, `--parallel`, `--name`, `--since`(wiki)의 예시를 든다.
   - `run --mode plan`으로 계획만 본 뒤 `resume --mode full`로 이어 가는 흐름을 보인다.
6. **멈췄을 때 (resume)**: 종료 코드별 상황 예시와 정확한 명령을 쓴다.
   - 20: `status --json`으로 pending을 확인한다. `resume --answer "..." [--lane a]`, `--grant network`.
   - 21: `--grant full`은 사람만 승인한다.
   - 22: 한도와 at 예약(`status`의 예약), 직접 resume.
   - 1: `logs`로 진단한 뒤 인자 없는 resume.
   - merge_conflict: detail의 명령으로 다시 merge하고 해결·커밋한 뒤 resume.
   - Ctrl-C나 비정상 종료 뒤의 재개.
7. **역할과 모델 바꾸기**: `roles` 예시. 모든 역할을 claude로 두기, 모델·effort 지정, 기본 조합(작성 Codex, 검수·QA Claude)과 그 이유를 쓴다.
8. **문제 해결(FAQ)**: 다음 항목마다 증상, 원인, 해결을 쓴다.
   - doctor fail 항목별 조치(로그인, chromium → `qa-runtime setup`, 커밋 없는 저장소)
   - 포트 사용 중
   - 앱이 만든 파일 때문에 G6 위반(.gitignore)
   - 같은 지적 반복(loop_repeat)
   - 커밋 안 된 변경은 런에 포함되지 않음(A2)
9. **팁**: 요청 크기(REQ 10개 안팎), 처음부터 만드는 프로그램은 스택을 명시, 비용(두 구독 사용량), 결과는 사람이 검토 후 머지.

## 규칙
- 예시 명령은 실제 CLI 인자와 정확히 일치해야 한다(src/cli.ts 확인).
- 출력 예시는 실제 형식을 따른다(status, timeline 표, 이벤트 줄 형식은 src/store/runlog.ts와 src/commands/inspect.ts 확인).
- spec 세부는 길게 복사하지 말고 절 링크로 넘긴다.
- 테스트·코드 변경 없음. `node --test test/*.test.ts` 통과 유지.

## 완료 기준
README.md에 위 9개 내용이 들어 있고, 명령과 출력 예시가 코드와 일치한다.

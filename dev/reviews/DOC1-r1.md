# DOC1-r1 검수

## 판정: APPROVED

## 확인한 것
- 변경 파일: README.md뿐(+367줄). 코드·테스트·spec 변경 없음. `node --test test/*.test.ts` 373개 통과.
- 9개 절이 모두 있다: 빠른 시작, Master 흐름, 런 단계와 순차·병렬 그림, 결과 확인과 머지, CLI만으로 쓰기, 종료 코드별 resume, 역할·모델, FAQ, 팁.
- 코드와 대조한 결과 아래 항목이 모두 일치한다.
  - 명령 인자(src/cli.ts): `--grant`는 DEV·WIKI만, wiki는 `--since` 필수이고 `--parallel` 불가, `--name` 형식, `resume --mode full`은 plan 런만.
  - 출력 형식(src/store/runlog.ts, src/commands/inspect.ts): status 줄, timeline·logs 표, 이벤트 줄, `예약: … (작업 N)`.
  - 재개 동작(src/commands/run.ts): worktree `reset --hard` + `clean -fd`, 살아 있는 PID면 2, 예약 해제 시점.
  - 설정 스키마의 null 허용, effort 값, qa-runtime 기본값과 슬롯 규칙, doctor 종료 코드(fail 2, warn 0).
- 추측성 내용 없음: 모델명은 자리표시자로 명시했고, REQ 개수는 "CLI 제한이 아닌 운영 팁"이라고 밝혔다.

## 지적
없음.

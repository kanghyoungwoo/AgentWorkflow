[README.md](/home/mcesos/AgentWorkflow/README.md:77)만 수정했습니다.

- 기존 절을 유지하고 요청한 사용법 9개 항목을 추가했습니다.
- 명령 예시 29개를 CLI 파서로 검증하고, 요청 템플릿·이벤트·timeline 출력을 소스와 대조했습니다.
- `node --test test/*.test.ts`: 373개 통과
- `node --test`: 377개 통과
- `npx tsc --noEmit`, `git diff --check`: 통과

테스트는 샌드박스 오류로 외부 실행에서 재검증했습니다. 코드·테스트·spec 변경이나 커밋은 없으며, 미완료 항목도 없습니다.
---
description: Orca 저장소별 셋업 스크립트와 한글 브랜치 리네임 한 줄 적용 현황을 읽기 전용으로 감사한다
allowed-tools: Bash(bash:*)
---

다음 명령을 실행하고 결과를 한국어로 요약한다. Orca DB는 읽기 전용으로만 연다.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/orca-setup-audit.sh" $ARGUMENTS
```

요약에는 리네임 한 줄이 없는 git 저장소 목록, 붙여 넣을 줄(`"$HOME/.local/bin/orca-branch-en.sh" || true`), GUI 위치(설정 → 저장소 → 훅 → "설정 스크립트")를 포함한다. `~/.local/bin/orca-branch-en.sh`가 없으면 먼저 `bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"`로 설치하라고 안내한다. DB 수정이나 실제 워크트리 생성은 하지 않는다.

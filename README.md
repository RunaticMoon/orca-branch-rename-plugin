# orca-local 마켓플레이스

Orca 워크트리용 Claude Code 플러그인을 담은 개인 로컬 마켓플레이스.

## 플러그인: `orca-setup-hooks`

| 구성 | 경로 | 내용 |
|---|---|---|
| skill | `plugins/orca-setup-hooks/skills/orca-setup-hooks/` | Orca 셋업 스크립트 저장 위치·실행 환경, 이름 규칙, 네이밍 선택지 A/B/C |
| 리네임 | `plugins/orca-setup-hooks/scripts/orca-branch-en.sh` | 한글 브랜치 끝부분을 영어 kebab-case로 `git branch -m` (방법 B) |
| 설치 | `plugins/orca-setup-hooks/scripts/install.sh` | 위 스크립트를 `~/.local/bin`에 복사 |
| 감사 | `plugins/orca-setup-hooks/scripts/orca-setup-audit.sh`, `/orca-setup-hooks:orca-setup-audit` | 저장소별 셋업·리네임 한 줄 적용 현황(읽기 전용) |
| 테스트 | `plugins/orca-setup-hooks/tests/` | 임시 git 저장소·가짜 DB로 네트워크 없이 실행 |

## 설치

```bash
# Claude Code 안에서
/plugin marketplace add <이 디렉터리 경로>
/plugin install orca-setup-hooks@orca-local

# 셋업 스크립트가 부를 고정 경로에 복사 (플러그인 업데이트 후에도 다시 실행)
bash <이 디렉터리>/plugins/orca-setup-hooks/scripts/install.sh
```

그다음 Orca → 설정 → 저장소 → (저장소) → 훅 → "설정 스크립트" 맨 아래에 붙여 넣는다.

```bash
"$HOME/.local/bin/orca-branch-en.sh" || true
```

## 테스트

```bash
bash plugins/orca-setup-hooks/tests/test-orca-branch-en.sh
bash plugins/orca-setup-hooks/tests/test-orca-setup-audit.sh
```

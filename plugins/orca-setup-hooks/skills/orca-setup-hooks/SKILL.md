---
name: orca-setup-hooks
description: Orca(워크트리 관리 앱)의 저장소별 셋업/아카이브 스크립트가 어디에 저장되고 어떻게 실행되는지, 한글 워크스페이스 이름이 폴더·브랜치명으로 어떻게 바뀌는지, 한글 브랜치를 영어로 바꾸는 방법(orca-branch-en.sh)과 적용 현황 감사(orca-setup-audit)를 다룬다. "Orca 셋업 스크립트", "orca hook", "orca.yaml", "워크트리 이름", "한글 브랜치", "브랜치 영어로", "브랜치 자동 이름 바꾸기", "워크트리 폴더 이름 바꾸기" 같은 요청에 사용한다.
---

# Orca 셋업 훅과 워크트리 이름

Orca 1.4.218(macOS, 2026-10-02 확인) 기준. 축약된 내부 함수 이름(`Sr`, `CKi` 등)은 버전마다 바뀐다. 근거와 재확인 방법은 [references/orca-internals.md](references/orca-internals.md)에 있다.

## 먼저 바로잡을 오해

기존 메모리·문서에 아래 내용이 있으면 틀린 것이다. 이 문서가 우선한다.

| 틀린 주장 | 사실 |
|---|---|
| 한글이 하이픈으로 바뀐다 | 이름 정규식은 `/[^\p{L}\p{N}._-]+/gu` → `-`. `\p{L}`이 한글을 포함하므로 한글은 그대로 남는다. 예: 이름 `v2 결제 화면` → 폴더 `v2-결제-화면`, 브랜치 `feature/v2-결제-화면` |
| 폴더를 `git worktree move`로 옮겨도 메타데이터가 유지된다 | `worktreeMeta` 키가 `<repoId>::<경로>`라서 경로를 바꾸면 표시 이름·상태·터미널 연결이 끊길 가능성이 높다(직접 시험하지는 않음). 폴더는 옮기지 않는다 |
| AI 브랜치명 생성 기능이 없다 | 내장 "브랜치 자동 이름 바꾸기"(`autoRenameBranchFromWork`, 기본 켜짐)가 있다. 단 자동 생성된 동물 이름 브랜치만 대상이고 한글 이름은 건너뛴다 |

## 셋업 스크립트: 저장소별로만 있고 전역 설정은 없다

- Orca에는 사용자가 만들 수 있는 플러그인 시스템이 없다. 그래서 이 기능은 Claude Code 플러그인(skill + 스크립트)으로 제공한다.
- 스크립트 원본은 저장소마다 Orca 프로필 DB에 있다: `~/Library/Application Support/orca/profiles/local-default/profile-state.db`의 `profile_state_documents` 테이블, `domain='repos'` payload(JSON 배열)의 `hookSettings.scripts.setup` / `hookSettings.scripts.archive`. `domain='projectHostSetups'`에도 같은 내용이 들어 있다.
- 전역 설정에서 셋업과 관련된 항목은 `setupScriptLaunchMode: 'new-tab'` 하나뿐이다. 저장소 기본값(`{mode:'auto', setupRunPolicy:'run-by-default', setupAgentStartupPolicy:'start-immediately', scripts:{setup:'', archive:''}}`)에 저장소 값을 덮어쓸 뿐, 전역 스크립트를 읽어 오는 경로는 없다. **모든 저장소에 적용하려면 저장소마다 한 줄씩 넣어야 한다.**
- 저장소 루트의 `orca.yaml`(`scripts.setup`)도 저장소 단위다. 커밋되므로 팀 전체에 적용된다. UI 문구상 orca.yaml이 먼저, 로컬 명령이 그다음에 실행된다. 개인 도구 호출은 orca.yaml이 아니라 로컬 셋업 스크립트에 넣는다.
- **수정은 Orca GUI에서 한다**: 설정 → 저장소 → (저장소 선택) → 훅 섹션 "설정 스크립트" / "아카이브 스크립트".
- 원본이 아닌 것(고쳐도 효과 없음):
  - DB 직접 쓰기 — Orca가 실행 중에 계속 쓰고 `content_hash`/`revision`도 관리한다. 절대 쓰지 않는다. 읽기는 `sqlite3 -readonly`로 Orca 실행 중에도 된다(WAL).
  - `orca-data.json` — 예전 내보내기 파일.
  - `.git/worktrees/<admin>/orca/setup-runner.sh` — 워크트리를 만들 때 생성되는 사본(`#!/usr/bin/env bash` + `set -e` + 스크립트).

### 실행 환경

- cwd는 새 워크트리 루트이고, 보이는 터미널(새 탭)에서 실행된다. 러너가 `set -e`라서 한 줄이 실패하면 뒤 줄이 실행되지 않는다.
- 환경변수: `ORCA_ROOT_PATH`(메인 체크아웃), `ORCA_WORKTREE_PATH`, `ORCA_WORKSPACE_NAME`(워크트리 경로 basename), `CONDUCTOR_ROOT_PATH`·`GHOSTX_ROOT_PATH`(둘 다 root와 같음).
- 셋업 터미널의 PATH에 `~/.local/bin`이 없을 수 있다. 스크립트는 절대경로(`$HOME/...`)로 부른다.
- 기본값 `setupAgentStartupPolicy: start-immediately` — 이름으로 보아 에이전트가 셋업 완료를 기다리지 않는 것 같다(추정, 미확인). 셋업에서 브랜치를 바꾸는 동안 에이전트가 먼저 시작될 수 있다는 뜻이다.

### 흔히 쓰는 셋업 스크립트 패턴

gitignore 대상(로컬 설정, 생성된 캐시 등)은 새 워크트리에 따라오지 않는다. 필요하면 `$ORCA_ROOT_PATH`에서 복사한다. 이미 있으면 덮어쓰지 않게 조건을 건다.

```bash
set -eu
# 로컬 설정은 커밋되지 않아 새 워크트리에 없다. 메인 체크아웃 것을 가져온다.
if [ ! -f "$ORCA_WORKTREE_PATH/config/local.json" ] && [ -f "$ORCA_ROOT_PATH/config/local.json" ]; then
  cp "$ORCA_ROOT_PATH/config/local.json" "$ORCA_WORKTREE_PATH/config/local.json"
fi
```

- 큰 디렉터리는 macOS APFS에서 `cp -Rc`(clone)로 복사하면 즉시 끝나고 디스크도 거의 늘지 않는다.
- 복사한 디렉터리에 메인 체크아웃 경로가 박힌 런타임 파일(pid, 소켓 등)이 있으면 지운다. 그대로 두면 워크트리 도구가 메인 쪽 프로세스에 붙는다.

## 이름이 만들어지는 방식

- GUI 생성 창에는 "워크스페이스 이름" 입력란 하나뿐이다. 이 값에서 폴더 basename, 브랜치(`branchPrefix` 설정: git-username / custom / none), displayName이 모두 만들어진다.
- `orca worktree create --name X`는 displayName도 X로 고정한다(사용자 지정 모드). `--json` 결과는 `.result.worktree`(`path`, `branch`, `displayName`, `identity.key` 등)에 있고 `orca worktree show`도 같은 형태다.
- CLI로 할 수 있는 리네임은 `orca worktree set --worktree <selector> --display-name <이름>`뿐이다. 브랜치·폴더 리네임 명령은 없다. selector: `identity:<key>` / `id:<repoId>::<path>` / `name:<displayName>` / `branch:<branch>` / `path:<path>` / `active`.
- `git branch -m`은 안전하다. Orca는 브랜치명을 git에서 읽는다(한글 폴더 + 영어 브랜치 조합도 정상 동작한다).

### 내장 "브랜치 자동 이름 바꾸기" (`autoRenameBranchFromWork`, 기본 켜짐)

- 에이전트가 첫 프롬프트로 작업을 시작할 때 `git branch -m`으로 바꾼다.
- 조건: Orca가 만든 워크트리(`orcaCreationSource`) + 브랜치 끝이 자동 생성 동물 이름(`-숫자` 접미사 허용) + upstream 없음. **한글 이름으로 만든 워크트리는 건너뛴다.**
- displayName은 비어 있거나 자동 이름일 때만 바꾼다. 폴더 리네임은 연결되어 있지 않아(`renameWorktreeFolder: void 0`) 동물 이름 폴더가 그대로 남는다.
- 프롬프트·명령 템플릿(`{basePrompt}`, `{firstPrompt}`, `{assistantMessage}`)은 설정에서 바꿀 수 있다.

## 한글 이름을 원할 때의 선택지

목표 세 가지: ① 표시 이름은 한글 ② 브랜치는 영어 ③ 폴더도 영어.

| 방법 | 절차 | ① | ② | ③ | 비고 |
|---|---|---|---|---|---|
| **A. 영어 slug로 생성 + 한글 표시 이름** | 래퍼/CLI로 영어 slug를 정해 만들고 표시 이름만 한글로 바꾼다 | ✅ | ✅ | ✅ | GUI 대신 CLI로 만들어야 한다 |
| **B. GUI 한글 생성 + 셋업 훅에서 브랜치만 영어로** | 셋업 스크립트에 `orca-branch-en.sh` 한 줄 | ✅ | ✅ | ❌ 폴더는 한글 | 평소대로 GUI를 쓴다. 이 플러그인의 기본 방법 |
| **C. 이름을 비워 생성 + 내장 자동 리네임** | 이름 없이 만들고 첫 프롬프트에서 Orca가 브랜치를 바꾸게 한 뒤 표시 이름만 한글로 | ✅ | ✅ | ❌ 폴더는 동물 이름 | 추가 도구 없음. 브랜치명이 AI 결과에 달림 |

### 방법 A 예시

```bash
# 저장소 안(또는 --repo 지정)에서 실행. slug 가 폴더 basename 과 브랜치 끝이 된다.
json=$(orca worktree create --repo "path:$PWD" --name fix-login-flow --json)
wt=$(printf '%s' "$json" | jq -r '.result.worktree.path')
orca worktree set --worktree "path:$wt" --display-name "로그인 흐름 수정"
```

slug를 직접 정하기 귀찮으면 `claude -p --model haiku`로 한글 → 영어 kebab-case를 먼저 만든 뒤 `--name`에 넘긴다. 실제 워크트리를 만드는 명령이므로 사용자에게 확인받고 실행한다.

## 방법 B 적용 절차 (`orca-branch-en.sh`)

동작: 브랜치 끝 부분(마지막 `/` 뒤)에 비ASCII가 있을 때만, upstream이 없고 detached HEAD가 아니면, `claude -p --model haiku`로 한글을 영어 kebab-case 소문자 2~5단어로 바꿔 `git branch -m` 한다. 결과는 터미널과 로그 파일(`${XDG_STATE_HOME:-~/.local/state}/orca-branch-en.log`)에 한 줄로 남긴다. 어떤 실패에도 exit 0이다.

- 접두사(`feature/`, `user/feature/` 등)는 그대로 둔다.
- 티켓 ID(`[A-Z][A-Z0-9]+-[0-9]+`, 예: `ABC-123`)는 원래 모양 그대로 slug 앞에 둔다. 티켓 바로 뒤가 `_`였으면 `_`, 아니면 `-`로 잇는다(`feature/ABC-123_결제-정리` → `feature/ABC-123_payment-cleanup`). 티켓이 뒤에 있었어도 앞으로 옮겨진다.
- 티켓 외의 ASCII 조각(`v2-결제-화면`의 `v2`)은 한글과 함께 모델에 넘어가므로 보존 여부는 모델 출력에 달려 있다.
- 모델 출력은 소문자 `[a-z0-9]`와 `-`로 정규화하고 5단어까지만 쓴다. 1단어 응답도 한글로 남기는 것보다 나아서 받아들인다.
- 같은 이름이 있으면 `-2`, `-3`…을 붙인다.
- 모델 호출은 `ORCA_BRANCH_EN_TIMEOUT`초(기본 60) 뒤 프로세스 그룹째 종료한다. 이 제한은 perl(macOS 기본 탑재)로 걸며, perl이 없으면 제한 없이 실행한다.
- 셋업 기본값이 `start-immediately`라서 에이전트가 리네임 전의 한글 브랜치명을 먼저 볼 수 있다(추정).

1. **고정 경로에 설치** (플러그인 캐시 `~/.claude/plugins/cache/.../<version>/`는 버전마다 바뀌므로 셋업 스크립트에서 직접 부르면 업데이트 후 깨진다. 복사본을 둔다):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"
   ```
   `${CLAUDE_PLUGIN_ROOT}`가 비어 있으면 이 SKILL.md 위치 기준 `../../scripts/install.sh`를 쓴다. `~/.local/bin/orca-branch-en.sh`, `~/.local/bin/orca-setup-audit.sh`로 복사된다. 플러그인을 업데이트하면 다시 실행한다. 제거는 `--uninstall`.
2. **저장소마다 GUI에서 한 줄 추가**: Orca → 설정 → 저장소 → (저장소) → 훅 → "설정 스크립트" 맨 아래(기존 스크립트가 있으면 그 뒤)에 붙여 넣는다.
   ```bash
   "$HOME/.local/bin/orca-branch-en.sh" || true
   ```
   - `|| true` 이유: 러너가 `set -e`라 이 줄이 실패하면(파일 없음·권한 등) 셋업 전체가 거기서 멈춘다. 스크립트 자체도 항상 0으로 끝나지만, 설치 전이거나 파일이 지워진 경우까지 막기 위해 붙인다.
   - 맨 아래에 두는 이유: 의존성 설치 같은 기존 단계가 리네임 실패나 지연(모델 호출)에 영향받지 않게 하기 위해서다. 반대로 에이전트가 브랜치명을 빨리 봐야 한다면 맨 위에 둔다.
3. **확인**: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/orca-setup-audit.sh"` (또는 `/orca-setup-hooks:orca-setup-audit`). 리네임 한 줄이 없는 git 저장소와 붙여 넣을 줄을 보여 준다. DB는 읽기 전용으로만 연다.

### 환경변수 (선택)

| 변수 | 기본값 | 용도 |
|---|---|---|
| `ORCA_BRANCH_EN_CLAUDE` | PATH → `~/.local/bin/claude` → `/opt/homebrew/bin/claude` → `/usr/local/bin/claude` | claude 실행 파일 |
| `ORCA_BRANCH_EN_MODEL` | `haiku` | slug 생성 모델 |
| `ORCA_BRANCH_EN_TIMEOUT` | `60` | slug 생성 제한 시간(초) |
| `ORCA_BRANCH_EN_SLUG_CMD` | (없음) | claude 대신 쓸 명령. 한글을 stdin으로 받아 slug를 stdout으로 낸다(테스트용) |
| `ORCA_BRANCH_EN_LOG` | `${XDG_STATE_HOME:-~/.local/state}/orca-branch-en.log` | 결과 로그 |
| `ORCA_BRANCH_EN_INSTALL_DIR` | `~/.local/bin` | `install.sh` 설치 위치 |
| `ORCA_BRANCH_EN_DRY_RUN` | (없음) | `1`이면 이름만 기록하고 바꾸지 않음 |

## 하지 말 것

- Orca DB에 쓰기, `setup-runner.sh`·`orca-data.json` 수정(효과 없음).
- Orca 밖에서 `git worktree move`로 폴더 옮기기.
- 이미 push한(upstream 있는) 브랜치 이름 바꾸기.
- 사용자 확인 없이 실제 Orca 워크트리 만들기·지우기.

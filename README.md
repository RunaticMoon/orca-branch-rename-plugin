# 한글 브랜치 영어 변환 (Orca 플러그인)

Orca에서 워크스페이스 이름을 한글로 지어 워크트리를 만들면 브랜치 이름에도 한글이 남습니다(예: `feature/결제-화면-정리`). 이 플러그인은 워크트리가 만들어질 때 브랜치 이름 끝의 한글을 영어 kebab-case로 바꿉니다(예: `feature/payment-screen-cleanup`).

- `git branch -m`만 합니다. 폴더 이름과 표시 이름은 그대로 둡니다.
  - 폴더를 옮기면 Orca 메타데이터가 끊길 수 있기 때문입니다.
  - Orca는 브랜치 이름을 git에서 읽으므로 화면에도 반영됩니다.
- 모든 저장소에 적용됩니다. 저장소마다 셋업 스크립트를 고칠 필요가 없습니다.
- 브랜치 끝에 한글(비ASCII)이 없으면 아무것도 하지 않습니다.
- 이미 push한 브랜치(upstream 있음)와 detached HEAD는 건너뜁니다.
- 접두사(`feature/` 등)와 티켓 ID(`ABC-123`)는 그대로 둡니다. 같은 이름의 브랜치가 있으면 `-2`, `-3`을 붙입니다.
- 영어 이름은 `claude -p --model haiku`로 만듭니다.
  - 1~5단어로 정리합니다.
  - 60초 안에 끝나지 않으면 중단합니다.
- 결과는 데스크톱 알림으로 알려 줍니다. 실패하면(`claude`를 찾지 못한 경우 포함) 브랜치를 그대로 둡니다.

## 필요한 것

- Orca 1.4.217 이상(플러그인 시스템)
- `claude` CLI(Claude Code). PATH, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` 순서로 찾습니다.
- `bash`, `git`, `perl`(macOS 기본 탑재. 시간 제한에 씁니다)

## 설치

1. Orca → Settings → Plugins → **Plugin system**(Experimental)을 켭니다.
2. **Install plugin**에서 설치 방법을 고릅니다.
   - **Git URL**: `https://github.com/RunaticMoon/orca-branch-rename-plugin#v0.1.0`
   - **Local folder**: 이 저장소를 클론한 폴더의 절대경로
3. 권한 검토 창을 확인하고 **Enable plugin**을 누릅니다.
   - 요청 권한: 워크트리 이벤트 구독, 알림 표시, 현재 워크트리 정보 읽기, 플러그인 저장소(수동 명령이 쓸 워크트리 경로 기억)
   - 이 플러그인은 백그라운드 워커가 있습니다. Orca 안내대로 워커는 일반 프로세스로 실행되며, 여기서 `git`과 `claude`를 실행합니다.

플러그인을 고치면서 바로 확인하려면 Settings → Plugins → **Development**에 클론한 폴더 경로를 추가합니다.

## 사용

- **자동**: GUI에서 한글 이름으로 워크트리를 만들면 몇 초 뒤 "브랜치 이름을 바꿨습니다" 알림이 뜹니다.
- **수동**: 자동 변환이 실패했거나 건너뛰었으면 그 워크트리에서 명령 팔레트의 **브랜치 이름을 영어로 다시 바꾸기**를 실행합니다.
  - 플러그인은 `worktree.created` 때 받은 경로를 기억해 두었다가 스크립트를 바로 실행합니다. 터미널에 입력하지 않으므로 에이전트가 돌고 있는 터미널에 영향을 주지 않습니다.
  - 다른 저장소에 같은 이름의 한글 브랜치가 있어 대상을 고를 수 없으면 실행하지 않고 알림으로 알려 줍니다.
  - 플러그인을 켜기 전에 만든 워크트리는 경로를 모르기 때문에, 알림으로 안내하는 명령을 그 워크트리 폴더에서 직접 실행합니다: `bash <플러그인 폴더>/bin/orca-branch-en.sh`
- 로그
  - Orca Settings → Plugins → 이 플러그인 → **View logs**
  - 스크립트 로그: `~/.local/state/orca-branch-en.log`

## 구성

| 경로 | 내용 |
|---|---|
| `orca-plugin.json` | 플러그인 매니페스트 |
| `main.mjs` | 워커. `worktree.created`를 받아 스크립트를 실행하고 결과를 알림으로 보냄. 수동 명령용으로 경로를 storage에 기억 |
| `bin/orca-branch-en.sh` | 리네임 본체(bash 3.2 호환, 항상 exit 0). 단독 실행 가능: `bash bin/orca-branch-en.sh <워크트리 경로>` |
| `tests/` | 네트워크 없이 도는 테스트 |
| `docs/orca-internals.md` | Orca 플러그인 API·셋업 훅·이름 규칙 근거와 재확인 방법 |

## 테스트

```bash
bash tests/test-orca-branch-en.sh       # 리네임 스크립트
node tests/test-plugin-host.mjs         # 실제 Orca 플러그인 호스트로 워커 검증 (ORCA_RESOURCES 로 Orca 위치 지정)
```

## 알려진 제약

- 이벤트는 워크트리가 만들어진 **뒤**에 옵니다. 그래서 셋업 스크립트나 에이전트가 바뀌기 전의 한글 브랜치 이름을 먼저 볼 수 있습니다.
- Orca가 플러그인 워커에 환경변수를 넘기지 않으므로, `ORCA_BRANCH_EN_*` 환경변수 설정은 스크립트를 단독으로 실행할 때만 적용됩니다.
- 티켓 ID가 아닌 영어 조각(`v2-결제-화면`의 `v2`)이 남을지는 모델 출력에 달려 있습니다.

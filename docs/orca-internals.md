# Orca 내부 근거와 재확인 방법

- 셋업 훅·이름 규칙: Orca 1.4.218(macOS)에서 2026-10-02에 확인했다.
- 플러그인 API: Orca 1.4.217(Linux) 번들에서 2026-10-02에 확인했다.
- 축약된 함수 이름은 빌드마다 바뀌므로 문자열 키로 찾는다.

## 번들 추출

```bash
tmp=$(mktemp -d)
npx --yes @electron/asar extract /Applications/Orca.app/Contents/Resources/app.asar "$tmp"
grep -rl 'autoRenameBranchFromWork' "$tmp" | head
```

플러그인 관련 코드는 `out/shared/plugins/` 아래에 있다. 진입 파일은 `app.asar.unpacked/out/main/plugin-host-entry.js`이고, Settings 화면 문자열은 `out/renderer/assets/Settings-*.js`에 있다.

## 플러그인 API (pluginApi 1)

### 매니페스트

- 파일 이름은 `orca-plugin.json`이다. Zod로 검증한다. `contributes`와 각 capability 객체는 `strict`라 모르는 키가 있으면 거부되고, 최상위·`commands[i]`·`events[i]`는 `strict`가 아니다.
- 필수: `manifestVersion: 1`, `id`, `publisher`, `name`, `version`(semver), `engines.orca`(`">=x.y.z"`), `pluginApi: 1`.
  - `id`와 `publisher`는 kebab-case여야 한다.
- 선택: `description`, `author`, `repository`, `icon`, `main`.
- `contributes`에 쓸 수 있는 키: `panels`, `commands`, `events`, `languagePacks`, `keybindings`, `vmRecipes`, `agents`.
- `events[].on`은 `worktree.created`, `worktree.removed`, `agent.status.changed` 중 하나다.
- `capabilities[].kind`: `workspace:read`, `terminal:send`, `notifications:show`, `storage`, `secrets`, `events:subscribe`, `settings:own`.
  - 셸 실행·파일·네트워크 capability는 없다.
- 교차 규칙:
  - `events`가 있으면 `main`과 `events:subscribe`가 필요하다.
  - `action`이 없는 command(워커가 처리하는 command)가 있으면 `main`이 필요하다.
- command의 `action`은 화면 토글용 내장 별칭 15개(`view.tasks`, `sidebar.search.toggle` 등)로 닫혀 있다.

### 워커

- Orca는 `child_process.fork(plugin-host-entry.js, [], {execArgv: [], env: 허용목록 + ELECTRON_RUN_AS_NODE=1})`로 워커를 띄운다.
  - 환경변수 허용목록: `PATH`, `HOME`, `LANG`, `LC_*`, `TZ`, `TMPDIR` 등. 그 밖의 환경변수는 넘어가지 않는다.
- 호스트는 `import(main)`을 한 뒤 `default` export `activate(context)`를 부르고, 선택적으로 `deactivate`도 쓴다.
  - `context`: `commands.register`, `events.on`, `host.call(method, params)`, `grantedCapabilities`, `log`
- 제한 시간: 준비 10초, 명령 30초, 이벤트 5분.
- 설치·동의 화면 문구: "Its worker still runs as a normal process on your computer with full access to your files, network, and other processes." capability는 Orca API를 쓰는 범위만 제한한다. 그래서 워커가 `git`이나 셸을 실행하는 것은 Orca가 밝힌 신뢰 모델 안의 동작이다.
- 워커가 받는 `worktree.created` payload는 `{worktreeId, path, branch}`다. 실제 앱(1.4.217)에서 `branch`는 `refs/heads/<이름>` 형태로 온다(격리 프로필 실기 확인). 그래서 플러그인은 `refs/heads/`를 떼고 비교한다. 워크트리가 만들어지고 상태에 등록된 **뒤**에 비동기로 오는 사후 이벤트다. 생성 전에 이름을 가로챌 방법은 없다.
- host API(v0)
  | 메서드 | 필요한 capability | 입출력 |
  |---|---|---|
  | `workspace.readContext` | `workspace:read` | `{branch, displayName, terminals:[{id}]} \| null` (경로는 주지 않음) |
  | `terminal.sendText` | `terminal:send` | `{terminalId, text, enter?}` → `{accepted}`. 현재 워크트리의 터미널만 가능 |
  | `notifications.show` | `notifications:show` | `{title(≤120), body?(≤1000)}` → `{delivered}` |
  | `storage.get` / `storage.set` | `storage` | `{key}` → `{value}` / `{key, value}` → `{ok}` |
  | `secrets.*` | `secrets` | 시크릿 저장 |
  | `settings.*` | `settings:own` | 플러그인 자체 설정 |

### 설치와 켜기

1. Settings → Plugins → **Plugin system**(Experimental)을 켠다. 설정 키는 `pluginSystemEnabled`이고 기본값은 꺼짐이다.
2. 설치 방법은 다음 중 하나다.
   - **Install plugin → Local folder**: `orca-plugin.json`이 있는 폴더의 절대경로를 넣는다.
   - **Install plugin → Git URL**: HTTPS·SSH URL 뒤에 `#태그` 또는 `#커밋`을 반드시 붙인다. 태그는 원격에 push되어 있어야 한다.
   - **Marketplace**: **Marketplace sources** → **Add marketplace**에 Git URL과 ref를 넣는다. 목록에서 고른 뒤 **Install**을 누른다. 규칙은 아래 **Marketplace**를 본다.
   - **Development**: 플러그인 폴더를 `devPluginPaths`에 추가한다. 복사하지 않고 그 자리에서 불러온다.
3. 권한 검토 창에서 **Enable plugin**을 누른다. 그 전에는 코드가 실행되지 않는다. 권한이나 워커 여부가 바뀌면 다시 검토해야 한다.

- 설치 위치: `<userData>/plugins/<publisher>.<id>/<contentHash>/`
  - `<userData>`는 macOS에서 `~/Library/Application Support/orca`, Linux에서 `~/.config/orca`다.
- 실행 로그는 Settings의 플러그인 행 → **View logs**에서 본다(최근 200줄).

### Marketplace

- Settings → Plugins → **Marketplace sources** → **Add marketplace**에 Git URL(HTTPS/SSH)과 ref를 넣으면 커스텀 marketplace를 추가한다. Orca는 그 ref를 depth 1로 가져와 **저장소 루트**의 `orca-marketplace.json`을 읽는다. 파일 이름은 `PLUGIN_MARKETPLACE_FILENAME`으로 고정되어 있고 다른 경로는 보지 않는다.
- 스키마는 모두 `strictObject`라 정의에 없는 키는 거부한다(`out/shared/plugins/plugin-marketplace.js`).
  - 최상위: `{name: 1~256자, owner: /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/ 1~128자, plugins: 배열 ≤2048, id 중복 금지}`
  - 항목: `{id: "<publisher>.<id>", source: {kind:"git", url, ref}, description?: 1~4096자, categories?: 소문자 slug 배열}`
    - `source`도 `strictObject`라 `kind`/`url`/`ref`만 쓴다. `kind`는 `"git"`이고 `url`은 HTTPS 또는 SSH만, `ref`는 1~4096자 필수다.
    - `categories` 각 항목은 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 1~64자, ≤16개, 중복 금지다.
  - 지원 안 하는 카테고리(`themes`, `icons`, `icon-themes`, `terminal-themes`, `skills`)가 있으면 목록에서 숨긴다(`isMarketplaceListingSupported`).
- 설치: 항목의 `source.url`+`ref`를 가져와 루트의 `orca-plugin.json`을 읽고, `entry.id === manifest.publisher + "." + manifest.id`를 강제한다. marketplace 저장소와 플러그인 저장소가 같아도 막지 않는다.
- 예약 신원: publisher가 `stablyai`이거나 id가 `orca-`로 시작하면(`isReservedPluginIdentity`) 공식 저장소만 허용한다.
- marketplace를 추가할 때 ref는 커밋으로 고정되므로 새 버전은 새로고침(**Refresh**)으로 받는다.
- 근거: `out/shared/plugins/plugin-marketplace.js`, IPC `plugins:addMarketplace` / `plugins:listMarketplacePlugins` / `plugins:previewMarketplacePlugin` / `plugins:installMarketplacePlugin`.

### 이 플러그인의 선택

- `workspace.readContext`가 경로를 주지 않으므로 수동 명령은 `worktree.created`에서 받은 `path → branch`를 storage 키 `pending`에 기억해 두고 쓴다(최대 200개, 성공하거나 브랜치가 이미 바뀌었으면 지운다).
  - 수동 명령은 현재 브랜치와 같은 이름으로 기억된 경로마다 `git symbolic-ref`로 실제 브랜치를 다시 확인한다. 저장소가 달라도 브랜치 이름이 같을 수 있기 때문이다. 일치하는 경로가 둘 이상이면 실행하지 않고 알린다.
- `terminal.sendText`는 쓰지 않는다. 첫 터미널에서 에이전트 TUI가 돌고 있으면 입력이 프롬프트로 들어가기 때문이다.
- 명령 제한이 30초라 수동 명령은 스크립트를 시작만 하고 바로 반환한다. 결과는 알림으로 알린다.

## 셋업 스크립트

- 저장소별로만 있다. 원본은 프로필 DB에 있다.
  ```bash
  db="$HOME/Library/Application Support/orca/profiles/local-default/profile-state.db"
  sqlite3 -readonly "$db" "select payload from profile_state_documents where domain='repos'"
  ```
  - `repos`의 각 원소: `id`, `path`, `displayName`, `kind`(`git`/`folder`), `hookSettings.scripts.{setup,archive}`
  - `projectHostSetups`에도 같은 스크립트가 들어 있다.
  - DB에 직접 쓰지 않는다. Orca가 실행 중에 쓰고 `content_hash`/`revision`을 관리한다.
- 기본값 함수: `{mode:'auto', setupRunPolicy:'run-by-default', setupAgentStartupPolicy:'start-immediately', scripts:{setup:'', archive:''}}`
  - 여기에 저장소 값을 덮어쓸 뿐이고, 전역 스크립트를 읽어 오는 경로는 없다.
- 전역 설정 중 셋업과 관련된 것은 `setupScriptLaunchMode: 'new-tab'` 하나뿐이다.
- 저장소 루트의 `orca.yaml`(`scripts.setup`)도 저장소 단위다. 커밋되므로 팀 전체에 적용된다.
- 수정은 GUI에서 한다: 설정 → 저장소 → 훅 → "설정 스크립트" / "아카이브 스크립트".
- `.git/worktrees/<admin>/orca/setup-runner.sh`(`set -e` + 스크립트)는 생성 때 만들어지는 사본이라 고쳐도 효과가 없다. `orca-data.json`도 원본이 아니다(예전 내보내기 파일).
- 실행 환경
  - cwd는 새 워크트리 루트이고, 보이는 터미널 탭에서 실행된다.
  - 환경변수: `ORCA_ROOT_PATH`, `ORCA_WORKTREE_PATH`, `ORCA_WORKSPACE_NAME`

## 이름 규칙

- GUI 생성 창의 "워크스페이스 이름" 하나에서 폴더 basename, 브랜치(`branchPrefix`: git-username / custom / none), displayName이 모두 만들어진다.
- 정규식은 `/[^\p{L}\p{N}._-]+/gu` → `-`다. `\p{L}`이 한글을 포함하므로 **한글은 그대로 남는다**.
- 내장 "브랜치 자동 이름 바꾸기"(`autoRenameBranchFromWork`, 기본 켜짐)
  - 첫 프롬프트 때 `git branch -m`으로 바꾼다.
  - 대상: Orca가 만든 워크트리 + 자동 생성 동물 이름 + upstream 없음. 한글 이름은 건너뛴다.
  - 폴더 리네임은 연결되어 있지 않다(`renameWorktreeFolder: void 0`).
- `worktreeMeta` 키는 `<repoId>::<경로>`다.
  - `git worktree move`로 폴더를 옮기면 메타데이터가 끊길 가능성이 높다(직접 시험하지 않은 추정).
  - `git branch -m`은 안전하다. Orca는 브랜치명을 git에서 읽는다.
- CLI로 할 수 있는 리네임은 `orca worktree set --worktree <selector> --display-name <이름>`뿐이다.
  - selector: `identity:` / `id:<repoId>::<path>` / `name:` / `branch:` / `path:` / `active`

## 미확인

- 실제 Orca 앱에서 `worktree.created` 이벤트가 셋업 스크립트·에이전트 시작보다 먼저 오는지 늦게 오는지.
- `setupAgentStartupPolicy: start-immediately`가 셋업 완료를 기다리지 않는지(이름으로 본 추정).
- macOS 1.4.218 번들의 플러그인 API가 Linux 1.4.217과 같은지.

# Orca 내부 근거와 재확인 방법

Orca 1.4.218, macOS, 2026-10-02 확인. 버전이 바뀌면 아래 방법으로 다시 확인한다.

## 번들 추출

```bash
tmp=$(mktemp -d)
npx --yes @electron/asar extract /Applications/Orca.app/Contents/Resources/app.asar "$tmp"
grep -rl 'autoRenameBranchFromWork' "$tmp" | head
```

축약된 함수 이름(`Sr`, `CKi` 등)은 빌드마다 바뀌므로 문자열 키(`hookSettings`, `setupRunPolicy`, `autoRenameBranchFromWork`, `renameWorktreeFolder`)로 찾는다.

## 확인된 사실과 위치

| 항목 | 내용 | 찾는 키 |
|---|---|---|
| 저장소 훅 기본값 | `constants-*.js`의 기본값 함수(당시 `Sr()`)가 `{mode:'auto', setupRunPolicy:'run-by-default', setupAgentStartupPolicy:'start-immediately', scripts:{setup:'', archive:''}}` 반환 | `setupRunPolicy` |
| 병합 | `{...기본값, ...repo.hookSettings, scripts:{...기본.scripts, ...repo.hookSettings.scripts}}` — 전역 값이 끼어들 자리가 없다 | `hookSettings` |
| 전역 설정 | 셋업 관련은 `setupScriptLaunchMode: 'new-tab'` 뿐 | `setupScriptLaunchMode` |
| 이름 정규화 | `/[^\p{L}\p{N}._-]+/gu` → `-` | `\p{L}` |
| 자동 브랜치 리네임 | `autoRenameBranchFromWork` 기본 켜짐, 동물 이름 + upstream 없음 + `orcaCreationSource` 조건, `git branch -m` | `autoRenameBranchFromWork` |
| 폴더 리네임 미연결 | `renameWorktreeFolder: void 0` | `renameWorktreeFolder` |
| 메타데이터 키 | `worktreeMeta`는 `<repoId>::<경로>` 키, 값에 instanceId | `worktreeMeta` |
| 플러그인 시스템 | 사용자 플러그인 없음. `pluginsDir`/`installPluginsOnRelay`는 에이전트 상태 훅을 SSH relay에 설치하는 내부 용도 | `installPluginsOnRelay` |

## 프로필 DB

```bash
db="$HOME/Library/Application Support/orca/profiles/local-default/profile-state.db"
sqlite3 -readonly "$db" "select payload from profile_state_documents where domain='repos'"
```

- 테이블 `profile_state_documents(domain PK, payload JSON, content_hash, revision, ...)`.
- `repos` 원소: `id`, `path`, `displayName`, `kind`(`git`/`folder`), `hookSettings.scripts.{setup,archive}` 등.
- `projectHostSetups`에도 같은 스크립트가 들어 있다.
- Linux 빌드는 `${XDG_CONFIG_HOME:-~/.config}/orca/profiles/local-default/profile-state.db`.
- 쓰기 금지. Orca가 실행 중에 쓰고 `content_hash`/`revision`을 관리한다.

## CLI

- `/usr/local/bin/orca` → `/Applications/Orca.app/Contents/Resources/bin/orca` 심볼릭 링크.
- `orca worktree create --name <name> [--repo <selector>] [--base-branch <ref>] [--setup run|skip|inherit] [--json]`
- `orca worktree set --worktree <selector> --display-name <name>` — CLI로 가능한 유일한 리네임.
- `orca worktree show --worktree <selector> --json` — `.result.worktree` 형태.

## 미확인

- `git worktree move` 후 Orca 메타데이터가 끊기는지 직접 시험하지 않았다(키 구조로 본 추정).
- `setupAgentStartupPolicy: start-immediately`가 에이전트를 셋업 완료 전에 시작하는지 확인하지 않았다(이름으로 본 추정).

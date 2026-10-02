#!/usr/bin/env bash
# orca-setup-audit.sh
#
# Orca 저장소별 "셋업 스크립트"에 한글 워크트리 브랜치 영어 리네임 한 줄이
# 들어 있는지 읽기 전용으로 감사한다.
#
# Why (읽기 전용 원칙):
#   Orca는 저장소/훅 정보를 SQLite(profile-state.db)에 담고 WAL 모드로 굴린다.
#   우리가 DB에 값을 쓰면 Orca가 관리하는 content_hash/revision과 어긋나
#   데이터가 깨질 수 있다. 그래서 이 스크립트는 DB에 절대 쓰지 않고 항상
#   `sqlite3 -readonly` 로만 읽는다.
#
# Why (JSON을 sqlite3 내장 함수로 파싱):
#   대상 OS인 macOS(bash 3.2, BSD 유틸)에는 jq/python이 없을 수 있다. payload가
#   JSON 배열이므로 sqlite3 내장 json_each/json_extract 로 직접 순회한다.
#
# Why (셋업 스크립트 본문을 SQL에서 0/1로 환산):
#   셋업 스크립트에는 개행·탭·`|`가 들어갈 수 있어 그대로 출력하면 행/열 구분이
#   깨진다. 그래서 본문 대신 SQL에서 length/instr 로 "있음"과 "리네임 포함"만
#   계산해 0/1로 받는다. 표시 이름/경로는 한글·공백이 가능하므로 UTF-8 그대로
#   출력하되, 필드 구분자는 공백류가 아닌 비공백 문자(ASCII US)를 쓴다.
#
# 사용법:
#   orca-setup-audit.sh [--db <경로>] [--line <리네임 한 줄>] [-h]
#
# 종료 코드:
#   0 정상 출력 (리네임이 빠진 저장소가 있어도 0)
#   2 sqlite3 없음 / DB 파일 없음 / 옵션 오류 / 조회 실패

set -u

# 리네임 한 줄 기본값. `$HOME` 은 확장하지 않고 "문자 그대로" 출력한다.
# (사용자가 GUI에 그대로 붙여 넣고, 실행 시점에 셸이 확장하도록.)
# shellcheck disable=SC2016  # 위 주석대로 $HOME 을 문자 그대로 출력하려는 의도다.
DEFAULT_LINE='"$HOME/.local/bin/orca-branch-en.sh" || true'

# "포함" 판정에 쓰는 문자열. 경로 표기가 달라도 이 한 조각이 있으면 인정한다.
MARKER='orca-branch-en.sh'

usage() {
  cat <<'EOF'
사용법: orca-setup-audit.sh [--db <경로>] [--line <리네임 한 줄>] [-h]

  --db <경로>    Orca profile-state.db 경로 (기본: $ORCA_PROFILE_DB >
                 OS 기본 경로. Darwin이면 ~/Library/Application Support/orca/...,
                 그 외에는 ${XDG_CONFIG_HOME:-$HOME/.config}/orca/...)
  --line <줄>    안내에 출력할 리네임 한 줄 (기본: "$HOME/.local/bin/orca-branch-en.sh" || true)
  -h             이 도움말

DB는 항상 sqlite3 -readonly 로만 읽는다. 리네임 포함 여부는 셋업 스크립트(DB)
또는 저장소 루트 orca.yaml 내용에 'orca-branch-en.sh' 가 있으면 "포함"으로 본다.
EOF
}

default_db() {
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '%s\n' "$HOME/Library/Application Support/orca/profiles/local-default/profile-state.db"
  else
    printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/orca/profiles/local-default/profile-state.db"
  fi
}

DB=""
LINE="$DEFAULT_LINE"
while [ $# -gt 0 ]; do
  case "$1" in
    --db)
      if [ $# -lt 2 ]; then
        echo "오류: --db 뒤에 경로가 필요합니다." >&2
        exit 2
      fi
      DB="$2"
      shift 2
      ;;
    --line)
      if [ $# -lt 2 ]; then
        echo "오류: --line 뒤에 문자열이 필요합니다." >&2
        exit 2
      fi
      LINE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "오류: 알 수 없는 옵션입니다: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# DB 경로 우선순위: --db > $ORCA_PROFILE_DB > OS 기본.
if [ -z "$DB" ]; then
  if [ -n "${ORCA_PROFILE_DB:-}" ]; then
    DB="$ORCA_PROFILE_DB"
  else
    DB="$(default_db)"
  fi
fi

# Why: sqlite3/DB가 없으면 감사 자체가 불가능하므로 명확히 안내하고 종료한다.
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "오류: sqlite3 를 찾을 수 없습니다. 설치 후 다시 실행하세요." >&2
  exit 2
fi
if [ ! -f "$DB" ]; then
  echo "오류: DB 파일을 찾을 수 없습니다: $DB" >&2
  exit 2
fi

# 셋업 스크립트 본문은 SQL에서 0/1로 환산해 받는다(위 Why 참고).
REPO_SQL=$(cat <<'SQL'
select
  coalesce(json_extract(value, '$.displayName'), ''),
  coalesce(json_extract(value, '$.kind'), ''),
  coalesce(json_extract(value, '$.path'), ''),
  case when length(coalesce(json_extract(value, '$.hookSettings.scripts.setup'), '')) > 0 then '1' else '0' end,
  case when instr(coalesce(json_extract(value, '$.hookSettings.scripts.setup'), ''), 'orca-branch-en.sh') > 0 then '1' else '0' end
from profile_state_documents, json_each(payload)
where domain = 'repos'
SQL
)

# Why (탭 대신 US=0x1f): 탭은 IFS 공백 문자라 연속 구분자가 하나로 합쳐져
#   빈 필드(displayName 없음 → coalesce 로 '')가 사라지고 열이 한 칸씩 밀린다.
#   비공백 구분자면 빈 필드도 하나의 열로 유지된다.
SEP=$(printf '\037')
rows=$(sqlite3 -readonly -separator "$SEP" "$DB" "$REPO_SQL")
status=$?
if [ "$status" -ne 0 ]; then
  # sqlite3가 이미 원인을 stderr에 출력했다. 여기서는 종료 코드만 보강한다.
  echo "오류: DB 조회에 실패했습니다 (sqlite3 종료 코드 $status): $DB" >&2
  exit 2
fi

total=0
git_cnt=0
folder_cnt=0
setup_cnt=0
yaml_cnt=0
rename_cnt=0
missing_names=()
missing_paths=()

# 표 헤더. 한글 표시 폭 오차는 허용하고 ` | ` 로 열을 구분한다.
printf '%-24s | %-6s | %-9s | %-4s | %s\n' '이름' 'kind' 'orca.yaml' '셋업' '리네임'
printf '%s\n' '-------------------------+--------+-----------+------+------------'

if [ -n "$rows" ]; then
  while IFS="$SEP" read -r name kind path has_setup has_rename; do
    # 빈 줄/필드 부족 방어.
    [ -n "$name$kind$path$has_setup$has_rename" ] || continue

    # displayName이 없으면 path의 basename을 이름으로 쓴다.
    if [ -z "$name" ]; then
      if [ -n "$path" ]; then
        name=$(basename "$path")
      fi
      [ -n "$name" ] || name='(이름없음)'
    fi

    total=$((total + 1))

    # kind: 'folder'만 folder로 세고, 나머지(빈 값 포함)는 git 계열로 본다.
    if [ "$kind" = "folder" ]; then
      folder_cnt=$((folder_cnt + 1))
    else
      git_cnt=$((git_cnt + 1))
    fi

    # 셋업 스크립트 있음/없음.
    if [ "$has_setup" = "1" ]; then
      setup_col='있음'
      setup_cnt=$((setup_cnt + 1))
    else
      setup_col='없음'
    fi

    # orca.yaml 존재 여부. path 디렉터리가 없으면 판단 불가이므로 '?'.
    yaml_col='?'
    yaml_has_rename=0
    if [ -n "$path" ] && [ -d "$path" ]; then
      if [ -f "$path/orca.yaml" ]; then
        yaml_col='있음'
        yaml_cnt=$((yaml_cnt + 1))
        # 마커는 고정 문자열로 찾는다('.' 등이 정규식 임의문자로 해석되지 않도록).
        if grep -qF -- "$MARKER" "$path/orca.yaml" 2>/dev/null; then
          yaml_has_rename=1
        fi
      else
        yaml_col='없음'
      fi
    fi

    # 리네임 열: folder는 대상이 아니고, git은 DB 셋업 > orca.yaml 순으로 본다.
    if [ "$kind" = "folder" ]; then
      rename_col='해당없음'
    elif [ "$has_rename" = "1" ]; then
      rename_col='포함'
      rename_cnt=$((rename_cnt + 1))
    elif [ "$yaml_has_rename" = "1" ]; then
      rename_col='포함(yaml)'
      rename_cnt=$((rename_cnt + 1))
    else
      rename_col='없음'
      missing_names+=("$name")
      missing_paths+=("$path")
    fi

    printf '%-24s | %-6s | %-9s | %-4s | %s\n' "$name" "$kind" "$yaml_col" "$setup_col" "$rename_col"
  done <<< "$rows"
fi

# 출력 2: 요약.
echo
printf '저장소 %d개(git %d, folder %d), 셋업 스크립트 있음 %d개, orca.yaml 있음 %d개, 리네임 포함 %d개\n' \
  "$total" "$git_cnt" "$folder_cnt" "$setup_cnt" "$yaml_cnt" "$rename_cnt"

# 출력 3: 누락 안내.
echo
missing_count=${#missing_names[@]}
if [ "$git_cnt" -eq 0 ]; then
  # git 저장소가 없으면 누락 블록·붙여 넣기 안내가 무의미하므로 여기서 끝낸다.
  echo '등록된 git 저장소 없음'
  exit 0
elif [ "$missing_count" -eq 0 ]; then
  echo '모든 git 저장소에 적용됨'
  exit 0
fi

printf '리네임 한 줄이 없는 git 저장소 (%d개):\n' "$missing_count"
i=0
while [ "$i" -lt "$missing_count" ]; do
  printf '  - %s (%s)\n' "${missing_names[$i]}" "${missing_paths[$i]}"
  i=$((i + 1))
done
echo
echo '붙여 넣을 줄:'
printf '  %s\n' "$LINE"
echo
echo 'GUI 위치: Orca → 설정 → 저장소 → <이름> → 훅 → "설정 스크립트" 맨 아래에 붙여 넣기.'
echo '셋업 스크립트가 비어 있는 저장소는 위 한 줄만 넣으면 됩니다.'

exit 0

#!/usr/bin/env bash
# test-orca-setup-audit.sh
#
# orca-setup-audit.sh 의 회귀 테스트.
# Why: 실제 Orca DB를 건드리지 않도록 mktemp 로 가짜 DB를 만들어 검증하고,
#      감사 스크립트가 DB를 읽기만 하는지(해시 불변)도 함께 확인한다.

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
AUDIT="$HERE/../scripts/orca-setup-audit.sh"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }

# 문자열 포함/불포함 검사.
assert_contains() { # <라벨> <본문> <부분문자열>
  case "$2" in
    *"$3"*) pass "$1" ;;
    *) fail "$1 (기대: '$3' 포함)" ;;
  esac
}
assert_not_contains() { # <라벨> <본문> <부분문자열>
  case "$2" in
    *"$3"*) fail "$1 (기대: '$3' 미포함)" ;;
    *) pass "$1" ;;
  esac
}
assert_eq() { # <라벨> <실제> <기대>
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1 (실제: '$2' / 기대: '$3')"
  fi
}

# 표에서 첫 열(이름)이 정확히 <이름>인 행을 그대로 반환한다(없으면 빈 문자열).
# Why: 부분문자열 검사만으로는 열이 밀린 버그(이름 칸에 경로가 들어감)를 놓친다.
row_for() { # <본문> <이름>
  printf '%s\n' "$1" | awk -F' \\| ' -v want="$2" '
    { n=$1; gsub(/^[ \t]+|[ \t]+$/, "", n); if (n == want) { print; exit } }'
}
# 행에서 <열번호>번째 열 값을 앞뒤 공백만 제거해 반환한다.
col_of() { # <행> <열번호>
  printf '%s\n' "$1" | awk -F' \\| ' -v n="$2" '
    { c=$n; gsub(/^[ \t]+|[ \t]+$/, "", c); print c; exit }'
}

# --- 도구 확인 ---------------------------------------------------------------
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo 'SKIP: sqlite3 가 없어 테스트를 실행할 수 없습니다.' >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo 'SKIP: python3 가 없어 가짜 DB를 만들 수 없습니다.' >&2
  exit 2
fi

# --- 문법 검사 ---------------------------------------------------------------
if bash -n "$AUDIT"; then pass 'bash -n: orca-setup-audit.sh'; else fail 'bash -n: orca-setup-audit.sh'; fi
if bash -n "$0"; then pass 'bash -n: test-orca-setup-audit.sh'; else fail 'bash -n: test-orca-setup-audit.sh'; fi

# --- 가짜 환경 생성 ----------------------------------------------------------
TMP=$(mktemp -d "${TMPDIR:-/tmp}/orca-setup-audit.XXXXXX") || exit 1
# shellcheck disable=SC2317  # 아래 trap EXIT 에서 간접 호출된다.
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

DB="$TMP/profile-state.db"
EMPTY_DB="$TMP/profile-state-empty.db"
NULL_DB="$TMP/profile-state-null.db"
NULLRENAME_DB="$TMP/profile-state-nullrename.db"
NOKIND_DB="$TMP/profile-state-nokind.db"
FOLDER_DB="$TMP/profile-state-folder.db"

python3 - "$TMP" <<'PY'
import json, sqlite3, sys
tmp = sys.argv[1]

def newdb(path):
    con = sqlite3.connect(path)
    con.execute(
        "create table profile_state_documents("
        "domain text primary key, payload text, content_hash text, revision integer)"
    )
    return con

# (1)~(7) 케이스. 셋업 스크립트 본문에는 개행과 `|` 를 일부러 넣는다.
repos = [
    # (1) git + 셋업에 리네임 포함(여러 줄, 개행, `|`).
    {"displayName": "repo-included", "kind": "git", "path": tmp + "/repos/repo1",
     "hookSettings": {"scripts": {"setup":
        'set -eu\necho start\n"$HOME/.local/bin/orca-branch-en.sh" || true\nmake setup | tee log'}}},
    # (2) git + 셋업 있음(리네임 없음).
    {"displayName": "repo-plain", "kind": "git", "path": tmp + "/repos/repo2",
     "hookSettings": {"scripts": {"setup": "set -eu\ncp config.sample x\nmake setup"}}},
    # (3) git + hookSettings 없음.
    {"displayName": "repo-nohook", "kind": "git", "path": tmp + "/repos/repo3"},
    # (4) folder 종류.
    {"displayName": "folder-repo", "kind": "folder", "path": tmp + "/repos/repo4"},
    # (5) git + orca.yaml 에 리네임 포함(훅 없음).
    {"displayName": "repo-yaml", "kind": "git", "path": tmp + "/repos/repo5"},
    # (6) displayName 한글.
    {"displayName": "한글-저장소", "kind": "git", "path": tmp + "/repos/repo6"},
    # (7) path 가 존재하지 않음.
    {"displayName": "missing-path", "kind": "git", "path": tmp + "/repos/does-not-exist"},
]
con = newdb(tmp + "/profile-state.db")
con.execute(
    "insert into profile_state_documents(domain,payload,content_hash,revision) values(?,?,?,?)",
    ("repos", json.dumps(repos, ensure_ascii=False), "h1", 1),
)
con.commit()
con.close()

# repos payload 가 빈 배열인 DB.
con = newdb(tmp + "/profile-state-empty.db")
con.execute(
    "insert into profile_state_documents(domain,payload,content_hash,revision) values(?,?,?,?)",
    ("repos", "[]", "h2", 1),
)
con.commit()
con.close()

# displayName 이 null 인 DB(path basename 대체 확인용).
con = newdb(tmp + "/profile-state-null.db")
one = [{"kind": "git", "path": tmp + "/repos/nullrepo",
        "hookSettings": {"scripts": {"setup": "make setup"}}}]
con.execute(
    "insert into profile_state_documents(domain,payload,content_hash,revision) values(?,?,?,?)",
    ("repos", json.dumps(one, ensure_ascii=False), "h3", 1),
)
con.commit()
con.close()

# displayName 없음 + 셋업에 리네임 줄 포함(공백류가 아닌 구분자로 열 유지 확인).
con = newdb(tmp + "/profile-state-nullrename.db")
one = [{"kind": "git", "path": tmp + "/repos/nullrename",
        "hookSettings": {"scripts": {"setup":
            'set -eu\necho x\n"$HOME/.local/bin/orca-branch-en.sh" || true'}}}]
con.execute(
    "insert into profile_state_documents(domain,payload,content_hash,revision) values(?,?,?,?)",
    ("repos", json.dumps(one, ensure_ascii=False), "h4", 1),
)
con.commit()
con.close()

# kind/path 필드가 아예 없는 DB(kind 는 git 으로 집계되는 현재 규칙).
con = newdb(tmp + "/profile-state-nokind.db")
one = [{"displayName": "nokind-nopath"}]
con.execute(
    "insert into profile_state_documents(domain,payload,content_hash,revision) values(?,?,?,?)",
    ("repos", json.dumps(one, ensure_ascii=False), "h5", 1),
)
con.commit()
con.close()

# folder 저장소만 있는 DB(git 0개 조기 종료 확인).
con = newdb(tmp + "/profile-state-folder.db")
one = [{"displayName": "folder-only", "kind": "folder", "path": tmp + "/repos/folder-only"}]
con.execute(
    "insert into profile_state_documents(domain,payload,content_hash,revision) values(?,?,?,?)",
    ("repos", json.dumps(one, ensure_ascii=False), "h6", 1),
)
con.commit()
con.close()
PY

# 저장소 디렉터리 생성. repo7 은 만들지 않는다(케이스 7).
mkdir -p "$TMP/repos/repo1" "$TMP/repos/repo2" "$TMP/repos/repo3" \
         "$TMP/repos/repo4" "$TMP/repos/repo5" "$TMP/repos/repo6" "$TMP/repos/nullrepo" \
         "$TMP/repos/nullrename"
# (5) orca.yaml 에 리네임 한 줄 포함.
# shellcheck disable=SC2016  # orca.yaml 에 "$HOME" 리터럴이 들어가야 한다.
printf '%s\n' 'scripts:' '  setup: |' '    "$HOME/.local/bin/orca-branch-en.sh" || true' > "$TMP/repos/repo5/orca.yaml"

# --- 해시(DB 내용 불변 확인용) ----------------------------------------------
sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    cksum "$1"
  fi
}
BEFORE=$(sha "$DB")

# --- 본 테스트 실행 ---------------------------------------------------------
out=$(bash "$AUDIT" --db "$DB")
rc=$?
assert_eq 'exit 0 (일반 DB)' "$rc" '0'

# 출력 1: 표 헤더/열.
assert_contains '표 헤더 존재' "$out" 'orca.yaml'
assert_contains '한글 이름 표시' "$out" '한글-저장소'
assert_contains 'yaml 포함 표기' "$out" '포함(yaml)'
assert_contains 'folder 리네임 해당없음' "$out" '해당없음'

# 출력 2: 요약 숫자 정확성.
SUMMARY='저장소 7개(git 6, folder 1), 셋업 스크립트 있음 2개, orca.yaml 있음 1개, 리네임 포함 2개'
assert_contains '요약 줄 정확' "$out" "$SUMMARY"

# 출력 3: 누락 목록 구간만 따로 잘라서 검사.
missing_section=$(printf '%s\n' "$out" | awk '/리네임 한 줄이 없는 git 저장소/{f=1} f')
assert_contains '누락: repo-plain' "$missing_section" 'repo-plain'
assert_contains '누락: repo-nohook' "$missing_section" 'repo-nohook'
assert_contains '누락: 한글-저장소' "$missing_section" '한글-저장소'
assert_contains '누락: missing-path' "$missing_section" 'missing-path'
assert_not_contains '누락 아님: repo-included' "$missing_section" 'repo-included'
assert_not_contains '누락 아님: folder-repo' "$missing_section" 'folder-repo'
assert_not_contains '누락 아님: repo-yaml' "$missing_section" 'repo-yaml'

# 붙여 넣을 줄이 $HOME 문자 그대로 나오는지.
# shellcheck disable=SC2016  # 출력에 "$HOME" 리터럴이 있는지 검사하는 것이라 의도된 표기다.
if printf '%s\n' "$out" | grep -qF '"$HOME/.local/bin/orca-branch-en.sh" || true'; then
  pass '붙여 넣을 줄 원문 출력'
else
  fail '붙여 넣을 줄 원문 출력'
fi

# 누락 안내 문구.
assert_contains 'GUI 위치 안내' "$out" '설정 스크립트'

# --line 사용자 지정.
out_line=$(bash "$AUDIT" --db "$DB" --line 'CUSTOM-LINE-XYZ')
assert_contains '--line 사용자 지정 반영' "$out_line" 'CUSTOM-LINE-XYZ'

# -h 는 종료 코드 0.
bash "$AUDIT" -h >/dev/null 2>&1
assert_eq 'exit 0 (-h)' "$?" '0'

# DB 내용 불변(해시): 감사 실행이 DB 파일을 바꾸지 않았는지.
AFTER=$(sha "$DB")
assert_eq 'DB 내용 불변(해시)' "$AFTER" "$BEFORE"

# 없는 DB 경로 -> exit 2.
bash "$AUDIT" --db "$TMP/does-not-exist.db" >/dev/null 2>&1
assert_eq 'exit 2 (없는 DB)' "$?" '2'

# repos payload 가 [] -> exit 0, 저장소 0개.
out_empty=$(bash "$AUDIT" --db "$EMPTY_DB")
assert_eq 'exit 0 (빈 repos)' "$?" '0'
assert_contains '빈 repos 요약' "$out_empty" \
  '저장소 0개(git 0, folder 0), 셋업 스크립트 있음 0개, orca.yaml 있음 0개, 리네임 포함 0개'

# displayName null -> path basename 대체. 부분문자열이 아니라 표의 열을 정확히 본다.
out_null=$(bash "$AUDIT" --db "$NULL_DB")
assert_eq 'exit 0 (displayName null)' "$?" '0'
null_row=$(row_for "$out_null" 'nullrepo')
assert_eq 'displayName null -> 1열 basename 정확' "$(col_of "$null_row" 1)" 'nullrepo'
assert_eq 'displayName null -> 2열 kind 정확' "$(col_of "$null_row" 2)" 'git'

# displayName 없음 + 셋업에 리네임 포함 -> 리네임 '포함', 요약 반영, 누락 목록 제외.
out_nr=$(bash "$AUDIT" --db "$NULLRENAME_DB")
assert_eq 'exit 0 (displayName 없음+리네임)' "$?" '0'
nr_row=$(row_for "$out_nr" 'nullrename')
assert_eq 'null+리네임 1열 basename' "$(col_of "$nr_row" 1)" 'nullrename'
assert_eq 'null+리네임 2열 kind' "$(col_of "$nr_row" 2)" 'git'
assert_eq 'null+리네임 5열 포함' "$(col_of "$nr_row" 5)" '포함'
assert_contains 'null+리네임 요약 반영' "$out_nr" '리네임 포함 1개'
assert_contains 'null+리네임 모두 적용' "$out_nr" '모든 git 저장소에 적용됨'
assert_not_contains 'null+리네임 누락 아님' "$out_nr" '리네임 한 줄이 없는'

# kind 필드 없음(=git 집계) + path 필드 없음 -> 열 밀림 없이 출력, exit 0.
out_nk=$(bash "$AUDIT" --db "$NOKIND_DB")
assert_eq 'exit 0 (kind/path 없음)' "$?" '0'
nk_row=$(row_for "$out_nk" 'nokind-nopath')
assert_eq 'kind/path 없음 1열 이름' "$(col_of "$nk_row" 1)" 'nokind-nopath'
assert_eq 'kind/path 없음 2열 kind 공백' "$(col_of "$nk_row" 2)" ''
assert_eq 'kind/path 없음 3열 orca.yaml ?' "$(col_of "$nk_row" 3)" '?'
assert_eq 'kind/path 없음 4열 셋업 없음' "$(col_of "$nk_row" 4)" '없음'
assert_eq 'kind/path 없음 5열 리네임 없음' "$(col_of "$nk_row" 5)" '없음'
assert_contains 'kind/path 없음 git 집계' "$out_nk" '저장소 1개(git 1, folder 0)'

# folder 저장소만 있는 DB -> '등록된 git 저장소 없음'만, 누락/붙여 넣기 안내 없음, exit 0.
out_folder=$(bash "$AUDIT" --db "$FOLDER_DB")
assert_eq 'exit 0 (folder만)' "$?" '0'
assert_contains 'folder만 등록된 git 저장소 없음' "$out_folder" '등록된 git 저장소 없음'
assert_not_contains 'folder만 누락 문구 없음' "$out_folder" '리네임 한 줄이 없는'
assert_not_contains 'folder만 붙여 넣기 안내 없음' "$out_folder" '붙여 넣을 줄'
assert_not_contains 'folder만 GUI 안내 없음' "$out_folder" '설정 스크립트'

# --- shellcheck (있으면) -----------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$AUDIT"; then pass 'shellcheck: orca-setup-audit.sh'; else fail 'shellcheck: orca-setup-audit.sh'; fi
  if shellcheck "$0"; then pass 'shellcheck: test-orca-setup-audit.sh'; else fail 'shellcheck: test-orca-setup-audit.sh'; fi
else
  echo 'SKIP: shellcheck 없음'
fi

# --- 결과 -------------------------------------------------------------------
echo
printf '결과: PASS %d, FAIL %d\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  exit 0
fi
exit 1

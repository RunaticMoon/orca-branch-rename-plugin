#!/usr/bin/env bash
#
# test-orca-branch-en.sh
#
# orca-branch-en.sh / install.sh 를 네트워크 없이 검증한다.
# 실제 claude 호출은 하지 않고 ORCA_BRANCH_EN_SLUG_CMD 로 slug 명령을 바꿔치기한다.
# 실제 ~/.local/bin 에 설치하지 않고 ORCA_BRANCH_EN_INSTALL_DIR 로 임시 경로를 쓴다.
#
# macOS 의 bash 3.2 에서도 돌 수 있도록 4.0+ 문법을 쓰지 않는다.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# 스크립트는 테스트 디렉터리가 아니라 형제 디렉터리(../scripts)에 있다.
SCRIPTS_DIR=$(cd "$SCRIPT_DIR/../scripts" && pwd)
TARGET="$SCRIPTS_DIR/orca-branch-en.sh"
INSTALL="$SCRIPTS_DIR/install.sh"

TMP=$(mktemp -d 2>/dev/null)
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then
  echo "FAIL: mktemp -d 실패"
  exit 1
fi
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
SKIP=0

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "SKIP: $1"; SKIP=$((SKIP + 1)); }

REPO="$TMP/repo"
git init -q -b main "$REPO" 2>/dev/null || { echo "FAIL: git init 실패"; exit 1; }
git -C "$REPO" config user.email test@example.com
git -C "$REPO" config user.name "Test User"
git -C "$REPO" commit -q --allow-empty -m init

# upstream 케이스용 bare 원격 저장소
REMOTE="$TMP/remote.git"
git init --bare -q "$REMOTE" 2>/dev/null
git -C "$REPO" remote add origin "$REMOTE" 2>/dev/null

wt_add() { # $1 = 브랜치, $2 = 경로
  git -C "$REPO" worktree add -q -b "$1" "$2" 2>/dev/null
}

branch_of() { # $1 = 워크트리 경로
  git -C "$1" symbolic-ref -q --short HEAD 2>/dev/null
}

# orca-branch-en.sh 를 지정한 환경으로 실행하고 OUT/RC 에 담는다.
# 나머지 ORCA_* 변수가 밖에서 새지 않도록 -u 로 먼저 지운다.
run_wt() {
  _p="$1"; shift
  OUT=$(env -u ORCA_BRANCH_EN_SLUG_CMD -u ORCA_BRANCH_EN_CLAUDE \
        -u ORCA_BRANCH_EN_LOG -u ORCA_BRANCH_EN_DRY_RUN \
        -u ORCA_BRANCH_EN_MODEL -u ORCA_BRANCH_EN_TIMEOUT \
        -u ORCA_WORKTREE_PATH \
        "$@" bash "$TARGET" "$_p" 2>&1)
  RC=$?
}

echo "== orca-branch-en.sh =="

# ---------------------------------------------------------------------------
# case 1: 기본 한글 브랜치
# ---------------------------------------------------------------------------
log="$TMP/log1"; rm -f "$log"
wt="$TMP/wt1"; wt_add 'feature/샘플-작업' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "Sample Task"' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/sample-task" ] \
   && [ -f "$log" ] && grep -q 'renamed:' "$log"; then
  pass "case1 기본 리네임 (feature/샘플-작업 -> feature/sample-task)"
else
  fail "case1 기본 리네임 (rc=$RC branch=$(branch_of "$wt"))"
fi

# ---------------------------------------------------------------------------
# case 2: 이미 ASCII 브랜치 -> slug 명령 호출되지 않아야 하고 로그도 없어야 한다
# ---------------------------------------------------------------------------
marker="$TMP/marker2"; rm -f "$marker"
log="$TMP/log2"; rm -f "$log"
wt="$TMP/wt2"; wt_add 'feature/already-english' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD="touch '$marker'" ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/already-english" ] \
   && [ ! -e "$marker" ] && [ ! -s "$log" ]; then
  pass "case2 ASCII 브랜치 무시(slug 미호출, 로그 없음)"
else
  fail "case2 ASCII 브랜치 (rc=$RC branch=$(branch_of "$wt") marker=$([ -e "$marker" ] && echo yes || echo no) log=$([ -s "$log" ] && echo yes || echo no))"
fi

# ---------------------------------------------------------------------------
# case 3: upstream 있음 -> 건너뛰어야 한다
# ---------------------------------------------------------------------------
log="$TMP/log3"; rm -f "$log"
wt="$TMP/wt3"; wt_add 'feature/푸시됨' "$wt"
git -C "$wt" push -q -u origin 'feature/푸시됨' 2>/dev/null
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "pushed"' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/푸시됨" ] \
   && [ -f "$log" ] && grep -q 'skip:' "$log"; then
  pass "case3 upstream 있으면 skip"
else
  fail "case3 upstream (rc=$RC branch=$(branch_of "$wt"))"
fi

# ---------------------------------------------------------------------------
# case 4: 이름 충돌 -> -2, 그리고 -2 도 있으면 -3
# ---------------------------------------------------------------------------
# 기준 브랜치 feature/sample-task 가 반드시 존재하도록 보장한다(case1 결과에 의존하지 않음).
git -C "$REPO" branch 'feature/sample-task' "$(git -C "$REPO" rev-parse main)" 2>/dev/null || true

log="$TMP/log4a"; rm -f "$log"
wtA="$TMP/wt4a"; wt_add 'feature/한글-충돌' "$wtA"
run_wt "$wtA" ORCA_BRANCH_EN_SLUG_CMD='echo "sample-task"' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wtA")" = "feature/sample-task-2" ]; then
  pass "case4a 충돌 시 -2"
else
  fail "case4a 충돌 -2 (rc=$RC branch=$(branch_of "$wtA"))"
fi

# case4a 가 만든 feature/sample-task-2 가 있으므로 다음은 -3 이어야 한다.
log="$TMP/log4b"; rm -f "$log"
wtB="$TMP/wt4b"; wt_add 'feature/한글-충돌2' "$wtB"
run_wt "$wtB" ORCA_BRANCH_EN_SLUG_CMD='echo "sample-task"' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wtB")" = "feature/sample-task-3" ]; then
  pass "case4b 충돌 시 -3"
else
  fail "case4b 충돌 -3 (rc=$RC branch=$(branch_of "$wtB"))"
fi

# ---------------------------------------------------------------------------
# case 5: 접두사 없음
# ---------------------------------------------------------------------------
log="$TMP/log5"; rm -f "$log"
wt="$TMP/wt5"; wt_add '한글-브랜치' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "korean branch"' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "korean-branch" ]; then
  pass "case5 접두사 없음 (한글-브랜치 -> korean-branch)"
else
  fail "case5 접두사 없음 (rc=$RC branch=$(branch_of "$wt"))"
fi

# ---------------------------------------------------------------------------
# case 6: slug 명령 실패 -> 그대로, 종료 코드 0, 로그 fail:
# ---------------------------------------------------------------------------
log="$TMP/log6a"; rm -f "$log"
wt="$TMP/wt6a"; wt_add 'feature/한글-실패' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='exit 3' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/한글-실패" ] \
   && [ -f "$log" ] && grep -q 'fail:' "$log"; then
  pass "case6a slug 실패(exit 3) 시 원래 브랜치 유지"
else
  fail "case6a slug 실패 (rc=$RC branch=$(branch_of "$wt"))"
fi

log="$TMP/log6b"; rm -f "$log"
wt="$TMP/wt6b"; wt_add 'feature/한글-빈출력' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='true' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/한글-빈출력" ] \
   && [ -f "$log" ] && grep -q 'fail:' "$log"; then
  pass "case6b slug 빈 출력 시 원래 브랜치 유지"
else
  fail "case6b slug 빈 출력 (rc=$RC branch=$(branch_of "$wt"))"
fi

# ---------------------------------------------------------------------------
# case 7: 티켓 ID 보존과 구분자
# ---------------------------------------------------------------------------
log="$TMP/log7a"; rm -f "$log"
wt="$TMP/wt7a"; wt_add 'feature/ABC-123_결제-화면-정리' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "payment cleanup"' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/ABC-123_payment-cleanup" ]; then
  pass "case7a 티켓+밑줄 구분자 보존"
else
  fail "case7a 티켓 보존 (rc=$RC branch=$(branch_of "$wt"))"
fi

log="$TMP/log7b"; rm -f "$log"
wt="$TMP/wt7b"; wt_add 'feature/ABC-123-알림-설정' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "notification settings"' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/ABC-123-notification-settings" ]; then
  pass "case7b 티켓+하이픈 구분자 보존"
else
  fail "case7b 티켓 보존 (rc=$RC branch=$(branch_of "$wt"))"
fi

# 여러 티켓은 '-' 로 잇고, 마지막 티켓 뒤 구분자를 따른다.
log="$TMP/log7c"; rm -f "$log"
wt="$TMP/wt7c"; wt_add 'feature/ABC-1_XYZ-2_한글작업' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "multi ticket"' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/ABC-1-XYZ-2_multi-ticket" ]; then
  pass "case7c 여러 티켓 '-' 연결"
else
  fail "case7c 여러 티켓 (rc=$RC branch=$(branch_of "$wt"))"
fi

# ---------------------------------------------------------------------------
# case 8: detached HEAD
# ---------------------------------------------------------------------------
log="$TMP/log8"; rm -f "$log"
wt="$TMP/wt8"; git -C "$REPO" worktree add -q --detach "$wt" 2>/dev/null
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "whatever"' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ -f "$log" ] && grep -q 'skip:' "$log"; then
  pass "case8 detached HEAD skip"
else
  fail "case8 detached HEAD (rc=$RC)"
fi

# ---------------------------------------------------------------------------
# case 9: slug 정규화(마지막 줄, 소문자, 기호 접기, 최대 5단어)
# ---------------------------------------------------------------------------
log="$TMP/log9"; rm -f "$log"
wt="$TMP/wt9"; wt_add 'feature/한글-정규화' "$wt"
SLUG9='printf "\n  Fix: The *Login* Flow!! now please extra words\n"'
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD="$SLUG9" ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/fix-the-login-flow-now" ]; then
  pass "case9 slug 정규화 -> fix-the-login-flow-now"
else
  fail "case9 slug 정규화 (rc=$RC branch=$(branch_of "$wt"))"
fi

# ---------------------------------------------------------------------------
# case 10: 경로 인자 / ORCA_WORKTREE_PATH
# ---------------------------------------------------------------------------
# 10a: 인자 없이 ORCA_WORKTREE_PATH 로 지정, cwd 는 다른 곳
log="$TMP/log10a"; rm -f "$log"
wt="$TMP/wt10a"; wt_add 'feature/한글-환경변수' "$wt"
OUT=$(cd "$TMP" && env -u ORCA_BRANCH_EN_SLUG_CMD -u ORCA_BRANCH_EN_CLAUDE \
      -u ORCA_BRANCH_EN_LOG -u ORCA_BRANCH_EN_DRY_RUN \
      ORCA_WORKTREE_PATH="$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "path env"' \
      ORCA_BRANCH_EN_LOG="$log" bash "$TARGET" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/path-env" ]; then
  pass "case10a ORCA_WORKTREE_PATH 로 대상 지정"
else
  fail "case10a ORCA_WORKTREE_PATH (rc=$RC branch=$(branch_of "$wt"))"
fi

# 10b: 경로 인자 우선(인자가 env 보다 우선)
log="$TMP/log10b"; rm -f "$log"
wt="$TMP/wt10b"; wt_add 'feature/한글-인자' "$wt"
other="$TMP/wt10b-other"; wt_add 'feature/한글-다른대상' "$other"
OUT=$(cd "$TMP" && env -u ORCA_BRANCH_EN_SLUG_CMD -u ORCA_BRANCH_EN_CLAUDE \
      -u ORCA_BRANCH_EN_LOG -u ORCA_BRANCH_EN_DRY_RUN \
      ORCA_WORKTREE_PATH="$other" ORCA_BRANCH_EN_SLUG_CMD='echo "arg wins"' \
      ORCA_BRANCH_EN_LOG="$log" bash "$TARGET" "$wt" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/arg-wins" ] \
   && [ "$(branch_of "$other")" = "feature/한글-다른대상" ]; then
  pass "case10b 경로 인자가 환경변수보다 우선"
else
  fail "case10b 인자 우선 (rc=$RC arg=$(branch_of "$wt") other=$(branch_of "$other"))"
fi

# ---------------------------------------------------------------------------
# case 11: DRY_RUN=1
# ---------------------------------------------------------------------------
log="$TMP/log11"; rm -f "$log"
wt="$TMP/wt11"; wt_add 'feature/한글-드라이런' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "dry run test"' ORCA_BRANCH_EN_DRY_RUN=1 ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/한글-드라이런" ] \
   && [ -f "$log" ] && grep -q 'dry-run-test' "$log"; then
  pass "case11 DRY_RUN 은 브랜치를 바꾸지 않고 새 이름만 기록"
else
  fail "case11 DRY_RUN (rc=$RC branch=$(branch_of "$wt"))"
fi

# ---------------------------------------------------------------------------
# case 12: claude 미발견
# ---------------------------------------------------------------------------
log="$TMP/log12"; rm -f "$log"
wt="$TMP/wt12"; wt_add 'feature/한글-클로드없음' "$wt"
fakehome="$TMP/fakehome"; mkdir -p "$fakehome"

# 제한 PATH/HOME 밖의 실제 claude 가 발견될 수 있으면 이 케이스는 건너뛴다.
skip12=0
for p in /opt/homebrew/bin/claude /usr/local/bin/claude /usr/bin/claude /bin/claude; do
  [ -x "$p" ] && skip12=1
done
if [ "$skip12" -eq 1 ]; then
  skip "case12 claude 미발견(실제 claude 가 제한 경로에 있어 건너뜀)"
else
  OUT=$(cd / && env -u ORCA_BRANCH_EN_SLUG_CMD -u ORCA_WORKTREE_PATH \
        -u ORCA_BRANCH_EN_DRY_RUN \
        PATH=/usr/bin:/bin HOME="$fakehome" ORCA_BRANCH_EN_CLAUDE=/nonexistent \
        ORCA_BRANCH_EN_LOG="$log" bash "$TARGET" "$wt" 2>&1)
  RC=$?
  if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/한글-클로드없음" ]; then
    pass "case12 claude 미발견 시 조용히 종료(코드 0, 브랜치 유지)"
  else
    fail "case12 claude 미발견 (rc=$RC branch=$(branch_of "$wt"))"
  fi
fi

# ---------------------------------------------------------------------------
# case 13: install.sh 설치/삭제
# ---------------------------------------------------------------------------
echo "== install.sh =="
indir="$TMP/install"
OUT=$(ORCA_BRANCH_EN_INSTALL_DIR="$indir" bash "$INSTALL" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && [ -x "$indir/orca-branch-en.sh" ] \
   && printf '%s' "$OUT" | grep -q '|| true'; then
  pass "case13a install.sh 설치(복사+실행권한, || true 안내)"
else
  fail "case13a install.sh 설치 (rc=$RC exists=$([ -x "$indir/orca-branch-en.sh" ] && echo yes || echo no))"
fi

OUT=$(ORCA_BRANCH_EN_INSTALL_DIR="$indir" bash "$INSTALL" --uninstall 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && [ ! -e "$indir/orca-branch-en.sh" ] && [ ! -e "$indir/orca-setup-audit.sh" ]; then
  pass "case13b install.sh --uninstall 삭제"
else
  fail "case13b install.sh --uninstall (rc=$RC)"
fi

# ---------------------------------------------------------------------------
# case 14: 다중 접두사 보존 (user/feature/... 를 통째로 유지)
# ---------------------------------------------------------------------------
log="$TMP/log14"; rm -f "$log"
wt="$TMP/wt14"; wt_add 'user/feature/한글-작업' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "nested task"' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "user/feature/nested-task" ]; then
  pass "case14 다중 접두사 보존 (user/feature/한글-작업 -> user/feature/nested-task)"
else
  fail "case14 다중 접두사 (rc=$RC branch=$(branch_of "$wt"))"
fi

# ---------------------------------------------------------------------------
# case 15: 1단어 slug 도 허용(한글로 남기지 않는다)
# ---------------------------------------------------------------------------
log="$TMP/log15"; rm -f "$log"
wt="$TMP/wt15"; wt_add 'feature/한단어' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo single' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/single" ]; then
  pass "case15 1단어 slug 허용 (feature/한단어 -> feature/single)"
else
  fail "case15 1단어 slug (rc=$RC branch=$(branch_of "$wt"))"
fi

# ---------------------------------------------------------------------------
# case 16: timeout 이 실제 경과 시간을 제한하고 손자 프로세스를 남기지 않는다
# ---------------------------------------------------------------------------
# 가짜 claude: 인자를 무시하고 오래 잔다. sleep 값을 고유한 소수로 두어
# 나중 pgrep 이 이 테스트가 만든 프로세스만 집도록 한다(다른 sleep 과 충돌 방지).
fakeclaude="$TMP/fake-claude-sleep"
printf '#!/bin/bash\nsleep 32.7\n' > "$fakeclaude"
chmod +x "$fakeclaude"

# 16a: claude 경로. TIMEOUT=2 인데 손자(sleep)가 stdout 을 쥐고 있어도 10초 안에 끝나야 한다.
log="$TMP/log16a"; rm -f "$log"
wt="$TMP/wt16a"; wt_add 'feature/한글-타임아웃' "$wt"
start=$(date +%s)
run_wt "$wt" ORCA_BRANCH_EN_TIMEOUT=2 ORCA_BRANCH_EN_CLAUDE="$fakeclaude" ORCA_BRANCH_EN_LOG="$log"
end=$(date +%s)
elapsed=$((end - start))
# 프로세스 정리 유예. 경과 시간 측정에는 넣지 않는다.
sleep 1
leftover=no
if command -v pgrep >/dev/null 2>&1 && pgrep -f 'sleep 32.7' >/dev/null 2>&1; then
  leftover=yes
fi
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/한글-타임아웃" ] \
   && [ "$elapsed" -lt 10 ] && [ -f "$log" ] && grep -q 'fail:' "$log" \
   && [ "$leftover" = no ]; then
  pass "case16a claude timeout(${elapsed}s) 브랜치 유지 + 손자 정리"
else
  fail "case16a claude timeout (rc=$RC elapsed=${elapsed}s branch=$(branch_of "$wt") leftover=$leftover)"
fi

# 16b: ORCA_BRANCH_EN_SLUG_CMD 경로에서도 같은 방식으로 시간이 제한되어야 한다.
log="$TMP/log16b"; rm -f "$log"
wt="$TMP/wt16b"; wt_add 'feature/한글-타임아웃2' "$wt"
start=$(date +%s)
run_wt "$wt" ORCA_BRANCH_EN_TIMEOUT=2 ORCA_BRANCH_EN_SLUG_CMD='sleep 31.7; echo x' ORCA_BRANCH_EN_LOG="$log"
end=$(date +%s)
elapsed=$((end - start))
sleep 1
leftover=no
if command -v pgrep >/dev/null 2>&1 && pgrep -f 'sleep 31.7' >/dev/null 2>&1; then
  leftover=yes
fi
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/한글-타임아웃2" ] \
   && [ "$elapsed" -lt 10 ] && [ -f "$log" ] && grep -q 'fail:' "$log" \
   && [ "$leftover" = no ]; then
  pass "case16b slug-cmd timeout(${elapsed}s) 브랜치 유지 + 손자 정리"
else
  fail "case16b slug-cmd timeout (rc=$RC elapsed=${elapsed}s branch=$(branch_of "$wt") leftover=$leftover)"
fi

# 17: 정상 종료 뒤 손자가 백그라운드에 남아도 출력을 캡처하는 호출자가 묶이지 않아야 한다.
#     (손자가 stderr 를 상속하면 out=$(... 2>&1) 이 손자 종료까지 기다린다.)
log="$TMP/log17"; rm -f "$log"
wt="$TMP/wt17"; wt_add 'feature/한글-백그라운드' "$wt"
start=$(date +%s)
out17=$(cd "$wt" && env ORCA_BRANCH_EN_SLUG_CMD='(sleep 35.9 &); echo "bg case"' ORCA_BRANCH_EN_LOG="$log" \
  bash "$TARGET" 2>&1)
RC=$?
end=$(date +%s)
elapsed=$((end - start))
if command -v pkill >/dev/null 2>&1; then pkill -f 'sleep 35.9' 2>/dev/null; fi
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/bg-case" ] && [ "$elapsed" -lt 10 ] \
   && printf '%s' "$out17" | grep -q 'renamed:'; then
  pass "case17 백그라운드 손자가 남아도 캡처 호출자 즉시 반환(${elapsed}s)"
else
  fail "case17 백그라운드 손자 (rc=$RC elapsed=${elapsed}s branch=$(branch_of "$wt"))"
fi

# 18: slug 명령이 실패하면 stderr 첫 줄이 로그 한 줄에 원인으로 남는다.
log="$TMP/log18"; rm -f "$log"
wt="$TMP/wt18"; wt_add 'feature/한글-오류' "$wt"
run_wt "$wt" ORCA_BRANCH_EN_SLUG_CMD='echo "auth required" >&2; exit 4' ORCA_BRANCH_EN_LOG="$log"
if [ "$RC" -eq 0 ] && [ "$(branch_of "$wt")" = "feature/한글-오류" ] \
   && [ "$(wc -l < "$log" | tr -d ' ')" = 1 ] && grep -q 'fail: slug 명령 실패 (exit 4): auth required' "$log"; then
  pass "case18 실패 원인(stderr 첫 줄) 로그 기록"
else
  fail "case18 실패 원인 로그 (rc=$RC log=$(cat "$log" 2>/dev/null))"
fi

# ---------------------------------------------------------------------------
# 문법 검사 / shellcheck
# ---------------------------------------------------------------------------
echo "== 정적 검사 =="
if bash -n "$TARGET" 2>/dev/null; then
  pass "bash -n orca-branch-en.sh"
else
  fail "bash -n orca-branch-en.sh"
fi

if bash -n "$INSTALL" 2>/dev/null; then
  pass "bash -n install.sh"
else
  fail "bash -n install.sh"
fi

if bash -n "$0" 2>/dev/null; then
  pass "bash -n test-orca-branch-en.sh"
else
  fail "bash -n test-orca-branch-en.sh"
fi

if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -s bash "$TARGET" "$INSTALL" "$0" 2>/dev/null; then
    pass "shellcheck"
  else
    fail "shellcheck"
  fi
else
  skip "shellcheck 없음"
fi

echo ""
echo "요약: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0

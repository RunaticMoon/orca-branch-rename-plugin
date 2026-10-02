#!/usr/bin/env bash
#
# orca-branch-en.sh
#
# 목적: Orca 가 만든 워크트리의 브랜치 이름 끝에 남은 한글을 영어 kebab-case slug 로 바꾼다.
#       폴더 이름은 그대로 두고 `git branch -m` 만 한다. Orca 는 브랜치 이름을 git 에서 읽으므로
#       폴더를 옮기지 않아도 화면에 반영된다.
#
# 누가 부르는가:
#   주로 Orca 플러그인 워커(main.mjs)가 `worktree.created` 를 받으면 `bash orca-branch-en.sh <경로>` 로 부른다.
#   워커는 stdout 의 마지막 `[orca-branch-en] ` 줄(renamed/skip/fail)로 결과를 해석한다.
#   터미널이나 저장소 셋업 스크립트에서 단독으로 실행해도 된다.
#
# 왜 전체에 set -e 를 쓰지 않는가:
#   셋업 스크립트에서 부를 때 Orca 셋업 러너는 `set -e` 로 감싸 실행하므로, 0 이 아닌 코드로 끝나면
#   셋업 전체가 멈춘다. 그래서 어떤 실패(경로 없음, git 아님, slug 실패, branch -m 실패 등)에도
#   반드시 0 으로 끝나도록 main()/task() 안에서 모두 `return 0` 으로 빠져나오고 마지막에 `exit 0` 을 둔다.
#   실패 여부는 종료 코드가 아니라 결과 줄로 알린다.
#
# 왜 bash 3.2 를 신경 쓰는가:
#   대상 OS 인 macOS 의 기본 /bin/bash 는 3.2 다. 연관 배열·${var,,}·mapfile 은 4.0+ 이므로 쓰지 않고,
#   GNU/BSD 가 다른 sed -i / grep -P 도 쓰지 않는다.

# ---------------------------------------------------------------------------
# 로깅
# ---------------------------------------------------------------------------

# 결과 한 줄을 stdout 에도, 로그 파일에도 남긴다.
# 왜 양쪽인가: 셋업 터미널에서 즉시 보이게 하면서 나중에 추적할 수 있도록 파일에도 쌓기 위해서다.
log_result() {
  _ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  _line="[orca-branch-en] $_ts $worktree_path $1"
  printf '%s\n' "$_line"
  if [ -n "$log_file" ]; then
    _dir=$(dirname "$log_file")
    # 로그 디렉터리가 없으면 만든다. 실패해도 본 작업은 계속한다.
    [ -d "$_dir" ] || mkdir -p "$_dir" 2>/dev/null || true
    printf '%s\n' "$_line" >> "$log_file" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# claude 실행 파일 찾기
# ---------------------------------------------------------------------------

# 왜 command -v 만 쓰지 않는가:
#   Orca 셋업 터미널의 PATH 에 ~/.local/bin 이 없을 수 있어서 claude 를 못 찾는다.
#   그래서 사용자가 지정한 경로 → PATH → 흔한 설치 위치 순으로 직접 확인한다.
find_claude() {
  _cenv="$1"
  if [ -n "$_cenv" ] && [ -x "$_cenv" ]; then
    printf '%s' "$_cenv"
    return 0
  fi
  _c=$(command -v claude 2>/dev/null)
  if [ -n "$_c" ] && [ -x "$_c" ]; then
    printf '%s' "$_c"
    return 0
  fi
  for _p in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -x "$_p" ]; then
      printf '%s' "$_p"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# timeout 래퍼
# ---------------------------------------------------------------------------

# 왜 perl 을 쓰는가:
#   macOS 에는 coreutils 의 timeout 명령이 없다. perl 은 기본 탑재라서 fork/alarm 으로
#   시간 제한을 걸 수 있다. perl 마저 없으면 시간 제한 없이 그냥 실행한다.
#
# 왜 프로세스 그룹을 통째로 죽이는가:
#   자식 하나만 죽이면 그 자식이 띄운 손자 프로세스(예: claude 가 띄운 자식)가 살아남아
#   stdout 을 붙들고 있으면 셸이 EOF 를 못 받아 계속 기다린다. 자식을 setpgrp 로 새
#   프로세스 그룹 리더로 만들고 부모가 그룹(-pid)으로 시그널을 보내 손자까지 정리한다.
#
# 왜 명령치환 대신 임시 파일인가:
#   out=$(cmd) 는 cmd 의 stdout 파이프가 닫혀야 셸이 돌아온다. 손자가 파이프를 쥐고 있으면
#   timeout 으로 자식을 죽여도 셸이 그대로 30초를 더 기다린다. stdout 을 파일로 돌리면
#   셸이 파이프 EOF 에 묶이지 않아 timeout 이 실제 경과 시간을 제한한다.
#   stderr 도 같은 이유로 파일로 받는다. 정상 종료 뒤 남은 손자가 stderr 를 쥐고 있으면
#   이 스크립트 출력을 캡처하는 호출자가 그 손자가 끝날 때까지 묶인다.
#
# run_with_timeout <출력파일> <오류파일> <명령> [인자...]
# stdout 을 <출력파일>, stderr 를 <오류파일> 로 보낸다. stdin 은 호출한 쪽이 리다이렉트한다.
run_with_timeout() {
  _out="$1"; _err="$2"; shift 2
  if command -v perl >/dev/null 2>&1; then
    perl -e 'my $t=shift; my $pid=fork; exit 127 unless defined $pid; if(!$pid){setpgrp(0,0); exec @ARGV; exit 127} $SIG{ALRM}=sub{kill "TERM",-$pid; sleep 1; kill "KILL",-$pid; exit 142}; alarm $t; waitpid($pid,0); my $s=$?; exit(($s & 127) ? 128+($s & 127) : ($s >> 8))' "$timeout_secs" "$@" > "$_out" 2> "$_err"
  else
    "$@" > "$_out" 2> "$_err"
  fi
}

# ---------------------------------------------------------------------------
# slug 정규화
# ---------------------------------------------------------------------------

# stdin 으로 받은 slug 원문을 다음 순서로 다듬어 stdout 으로 낸다.
#   1) 비어 있지 않은 마지막 줄만 사용
#   2) 소문자화
#   3) [a-z0-9] 가 아닌 문자 연속을 '-' 하나로
#   4) 앞뒤 '-' 제거
#   5) 하이픈 기준 최대 5단어
# 왜 LC_ALL=C 를 붙이는가: 로케일에 상관없이 '영어 소문자/숫자'만 남기고 나머지(한글·기호)는
#   바이트 단위로 확실히 '-' 로 접기 위해서다.
# 왜 1단어도 허용하는가: 프롬프트는 2~5단어를 요구하지만 모델이 1단어만 내더라도, 한글이
#   그대로 남는 것보다는 짧은 영어 한 단어가 낫기 때문에 받아들인다(상한만 5로 제한).
normalize_slug() {
  awk 'NF { last = $0 } END { print last }' \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed -E 's/[^a-z0-9]+/-/g' \
    | sed -E 's/^-+//; s/-+$//' \
    | awk -F- '{
        n = NF
        if (n > 5) n = 5
        out = ""
        i = 1
        while (i <= n) {
          if (i > 1) out = out "-"
          out = out $i
          i++
        }
        print out
      }'
}

# ---------------------------------------------------------------------------
# 본 작업
# ---------------------------------------------------------------------------

task() {
  slug_cmd="${ORCA_BRANCH_EN_SLUG_CMD:-}"
  claude_env="${ORCA_BRANCH_EN_CLAUDE:-}"
  model="${ORCA_BRANCH_EN_MODEL:-haiku}"
  timeout_secs="${ORCA_BRANCH_EN_TIMEOUT:-60}"
  dry_run="${ORCA_BRANCH_EN_DRY_RUN:-}"
  # 기본 로그 경로: XDG_STATE_HOME 이 있으면 그것을, 없으면 ~/.local/state 를 쓴다.
  log_file="${ORCA_BRANCH_EN_LOG:-${XDG_STATE_HOME:-$HOME/.local/state}/orca-branch-en.log}"

  # 대상 경로 우선순위: $1 > $ORCA_WORKTREE_PATH > 현재 디렉터리
  target="${1:-}"
  [ -n "$target" ] || target="${ORCA_WORKTREE_PATH:-}"
  [ -n "$target" ] || target="$PWD"

  if ! cd "$target" 2>/dev/null; then
    worktree_path="$target"
    log_result "fail: 대상 경로로 이동할 수 없음: $target"
    return 0
  fi
  worktree_path=$(pwd -P 2>/dev/null)
  [ -n "$worktree_path" ] || worktree_path="$PWD"

  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    log_result "fail: git 저장소가 아님"
    return 0
  fi

  # detached HEAD 는 브랜치 이름이 없으므로 symbolic-ref 가 실패한다.
  branch=$(git symbolic-ref -q --short HEAD 2>/dev/null)
  if [ -z "$branch" ]; then
    log_result "skip: detached HEAD"
    return 0
  fi

  # 브랜치를 마지막 '/' 기준으로 prefix(마지막 '/' 포함)와 tail 로 나눈다.
  # 예: feature/v2-결제-화면 -> prefix "feature/", tail "v2-결제-화면"
  case "$branch" in
    */*)
      prefix="${branch%/*}/"
      tail="${branch##*/}"
      ;;
    *)
      prefix=""
      tail="$branch"
      ;;
  esac

  # tail 에 비ASCII 바이트가 없으면 손댈 것이 없다.
  # 이 경우만 아무 출력/로그도 남기지 않는다(불필요한 노이즈 방지).
  # LC_ALL=C 로 두어야 바이트 단위로 판정한다(GNU/BSD 공통).
  if ! printf '%s' "$tail" | LC_ALL=C grep -q '[^ -~]' 2>/dev/null; then
    return 0
  fi

  # upstream 이 이미 있으면(즉 push 된 브랜치면) 이름을 바꾸지 않는다.
  # 왜: 원격 브랜치와 어긋나서 다음 push/pull 이 꼬이기 때문이다.
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    log_result "skip: upstream 있음"
    return 0
  fi
  if [ -n "$(git config --get "branch.$branch.remote" 2>/dev/null)" ]; then
    log_result "skip: upstream 있음"
    return 0
  fi

  # 티켓 ID(예: ABC-123)는 원래 모양 그대로 보존한다.
  # 왜 보존하는가: 이슈 트래커 링크·관례를 깨지 않기 위해서다.
  tickets=$(printf '%s' "$tail" | LC_ALL=C grep -oE '[A-Z][A-Z0-9]+-[0-9]+' 2>/dev/null)
  # 티켓을 제거한 나머지에서 앞뒤 구분자(-_.)를 다듬어 번역 대상 텍스트로 쓴다.
  trans=$(printf '%s' "$tail" | LC_ALL=C sed -E 's/[A-Z][A-Z0-9]+-[0-9]+//g' 2>/dev/null)
  trans=$(printf '%s' "$trans" | sed -E 's/^[-_.]+//; s/[-_.]+$//' 2>/dev/null)

  if [ -z "$trans" ]; then
    log_result "skip: 번역 대상 없음"
    return 0
  fi
  if ! printf '%s' "$trans" | LC_ALL=C grep -q '[^ -~]' 2>/dev/null; then
    log_result "skip: 번역 대상에 비ASCII 없음"
    return 0
  fi

  # 티켓 뒤 구분자: 원래 tail 에서 마지막 티켓 바로 뒤 문자가 '_' 이면 '_', 그 외에는 '-'.
  # 여러 티켓이면 '-' 로 잇는다.
  sep="-"
  if [ -n "$tickets" ]; then
    last_ticket=$(printf '%s\n' "$tickets" | tail -n 1)
    # 마지막 티켓 뒤의 나머지를 잘라 첫 문자를 본다.
    after="${tail##*"$last_ticket"}"
    case "$after" in
      _*) sep="_" ;;
      *) sep="-" ;;
    esac
  fi

  # slug 생성: 테스트용 바꿔치기(ORCA_BRANCH_EN_SLUG_CMD)가 있으면 그것을 claude 대신 쓴다.
  # 출력은 명령치환 대신 임시 파일로 받는다(이유는 run_with_timeout 주석 참고).
  # 남은 파일은 정상 경로에서 지우고, 중간 실패로 빠져도 trap 이 마무리한다.
  # trap 을 먼저 걸어 두 번째 mktemp 만 실패해도 첫 파일이 남지 않게 한다.
  tmp_out=""
  tmp_err=""
  trap 'rm -f ${tmp_out:+"$tmp_out"} ${tmp_err:+"$tmp_err"}' EXIT
  if ! tmp_out=$(mktemp 2>/dev/null) || ! tmp_err=$(mktemp 2>/dev/null); then
    log_result "fail: 임시 파일을 만들 수 없음"
    return 0
  fi

  status=0
  if [ -n "$slug_cmd" ]; then
    # 번역할 한글 텍스트를 stdin 으로 넘기고 stdout 은 임시 파일로 받는다.
    printf '%s\n' "$trans" | run_with_timeout "$tmp_out" "$tmp_err" bash -c "$slug_cmd"
    status=$?
  else
    claude_path=$(find_claude "$claude_env")
    if [ -z "$claude_path" ]; then
      # 사용자가 고쳐야 하는 문제라 skip 이 아니라 fail 로 알린다(플러그인이 실패 알림을 띄운다).
      log_result "fail: claude 실행 파일을 찾을 수 없음"
      return 0
    fi
    # 프롬프트는 영어로 고정하고, 번역할 텍스트를 프롬프트 뒤에 붙인다.
    prompt='Convert the following Korean (possibly mixed) task description into an English slug for a git branch name. Use lowercase English words in kebab-case, 2 to 5 words, ASCII only. Output only the slug on a single line. Do not add explanations, quotes, or code fences.'
    full_prompt="$prompt

$trans"
    # </dev/null: claude 가 터미널 입력을 기다려 멈추는 것을 막는다.
    run_with_timeout "$tmp_out" "$tmp_err" "$claude_path" -p --model "$model" --no-session-persistence --tools "" "$full_prompt" </dev/null
    status=$?
  fi

  if [ "$status" -ne 0 ]; then
    # timeout 으로 죽어도(비정상 종료 코드) 여기서 실패 처리한다.
    # 로그 한 줄에 원인을 남기려고 stderr 첫 줄(최대 200자)만 붙인다.
    err_line=$(grep -m 1 . "$tmp_err" 2>/dev/null | cut -c 1-200)
    if [ -n "$err_line" ]; then
      log_result "fail: slug 명령 실패 (exit $status): $err_line"
    else
      log_result "fail: slug 명령 실패 (exit $status)"
    fi
    return 0
  fi

  slug=$(normalize_slug < "$tmp_out")
  rm -f "$tmp_out" "$tmp_err"
  if [ -z "$slug" ]; then
    log_result "fail: slug 결과가 비어 있음"
    return 0
  fi

  # 새 tail 조립: 티켓이 있으면 (티켓들 + 구분자 + slug), 없으면 slug.
  if [ -n "$tickets" ]; then
    ticket_part=$(printf '%s\n' "$tickets" | tr '\n' '-')
    ticket_part=${ticket_part%-}
    new_tail="${ticket_part}${sep}${slug}"
  else
    new_tail="$slug"
  fi
  new_branch="${prefix}${new_tail}"

  # git 이 허용하는 브랜치 이름인지 검증한다.
  if ! git check-ref-format --branch "$new_branch" >/dev/null 2>&1; then
    log_result "fail: 유효하지 않은 브랜치 이름: $new_branch"
    return 0
  fi

  # 이미 같은 이름의 로컬 브랜치가 있으면 -2, -3 ... -99 를 붙여 빈 이름을 찾는다.
  if git show-ref --verify --quiet "refs/heads/$new_branch" 2>/dev/null; then
    _n=2
    _resolved=""
    while [ "$_n" -le 99 ]; do
      _cand="${new_branch}-${_n}"
      if ! git show-ref --verify --quiet "refs/heads/$_cand" 2>/dev/null; then
        _resolved="$_cand"
        break
      fi
      _n=$((_n + 1))
    done
    if [ -z "$_resolved" ]; then
      log_result "fail: 사용 가능한 브랜치 이름이 없음: $new_branch"
      return 0
    fi
    new_branch="$_resolved"
  fi

  if [ "$dry_run" = "1" ]; then
    # 실제로 바꾸지 않고 바꿀 이름만 기록한다.
    log_result "renamed: $branch -> $new_branch (dry-run)"
    return 0
  fi

  if git branch -m "$branch" "$new_branch" >/dev/null 2>&1; then
    log_result "renamed: $branch -> $new_branch"
  else
    log_result "fail: git branch -m 실패: $branch -> $new_branch"
  fi

  return 0
}

main() {
  task "$@" || true
  return 0
}

# Orca 셋업 러너가 set -e 라도 절대 멈추지 않도록 항상 0 으로 끝낸다.
main "$@" || true
exit 0

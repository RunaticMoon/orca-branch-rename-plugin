#!/usr/bin/env bash
#
# install.sh
#
# 목적: orca-branch-en.sh(와 다른 작업자가 만들 orca-setup-audit.sh)를 셋업 스크립트가 부를
#       고정 경로(기본 ~/.local/bin)에 설치한다.
#
# 왜 심볼릭 링크가 아니라 복사인가:
#   이 스크립트가 사는 Claude 플러그인 캐시 경로(~/.claude/plugins/cache/.../<version>/)는
#   버전마다 바뀌고, 구버전 캐시 디렉터리는 삭제된다. 원본을 가리키는 심볼릭 링크를 만들어 두면
#   캐시가 지워질 때 링크가 깨져 셋업 때 아무것도 실행되지 않는다. 그래서 실제 파일을 복사해 둔다.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

INSTALL_DIR=${ORCA_BRANCH_EN_INSTALL_DIR:-$HOME/.local/bin}
DEFAULT_DIR="$HOME/.local/bin"

UNINSTALL=0
for _arg in "$@"; do
  case "$_arg" in
    --uninstall) UNINSTALL=1 ;;
  esac
done

# 설치/삭제 대상. orca-setup-audit.sh 는 다른 작업자가 만드는 중이라 아직 없을 수 있다.
TARGETS="orca-branch-en.sh orca-setup-audit.sh"

if [ "$UNINSTALL" -eq 1 ]; then
  for _name in $TARGETS; do
    if [ -e "$INSTALL_DIR/$_name" ]; then
      if rm -f "$INSTALL_DIR/$_name" 2>/dev/null; then
        echo "제거됨: $INSTALL_DIR/$_name"
      else
        echo "제거 실패: $INSTALL_DIR/$_name" >&2
      fi
    fi
  done
  exit 0
fi

if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
  echo "설치 디렉터리를 만들 수 없습니다: $INSTALL_DIR" >&2
  exit 1
fi

for _name in $TARGETS; do
  _src="$SCRIPT_DIR/$_name"
  if [ ! -f "$_src" ]; then
    # orca-setup-audit.sh 가 아직 없을 수 있으므로 경고만 하고 건너뛴다.
    echo "경고: $_name 을(를) 찾을 수 없어 건너뜁니다: $_src" >&2
    continue
  fi
  if cp "$_src" "$INSTALL_DIR/$_name" 2>/dev/null; then
    chmod 755 "$INSTALL_DIR/$_name" 2>/dev/null || true
    echo "설치됨: $INSTALL_DIR/$_name"
  else
    echo "복사 실패: $_src -> $INSTALL_DIR/$_name" >&2
    exit 1
  fi
done

# 기본 설치 경로일 때는 다른 머신에서도 그대로 쓸 수 있도록 $HOME 을 그대로 출력한다.
if [ "$INSTALL_DIR" = "$DEFAULT_DIR" ]; then
  # 여기서는 $HOME 을 지금 셸에서 확장하려는 게 아니라, 안내문에 문자 그대로 남겨 다른
  # 머신의 셋업 스크립트에 붙여도 각자의 $HOME 으로 풀리게 하려는 의도다.
  # shellcheck disable=SC2016
  CALL_PATH='$HOME/.local/bin/orca-branch-en.sh'
else
  CALL_PATH="$INSTALL_DIR/orca-branch-en.sh"
fi

echo ""
echo "각 저장소 셋업 스크립트에 붙여 넣을 줄:"
echo "\"$CALL_PATH\" || true"
echo ""
echo "끝의 '|| true' 는 Orca 셋업 러너가 set -e 로 실행하기 때문에, 이 스크립트가 만에 하나 0 이 아닌 코드로 끝나도 셋업 전체가 멈추지 않게 하려는 것입니다."

exit 0

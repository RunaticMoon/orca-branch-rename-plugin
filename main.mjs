// Orca 플러그인 워커 엔트리.
//
// 워크트리가 만들어지면(worktree.created) 번들 스크립트 bin/orca-branch-en.sh 를 실행해
// 브랜치 이름 끝의 한글을 영어 kebab-case 로 바꾸고(git branch -m) 결과를 알림으로 알린다.
// 스크립트가 무거운 일(번역·git)을 모두 담당하므로 여기서는 이벤트를 걸러 실행하고 해석만 한다.
//
// 수동 커맨드는 터미널에 타이핑하지 않는다. 그 터미널에 에이전트 TUI 가 돌고 있으면 입력이
// 프롬프트로 들어가 버리기 때문이다. 대신 worktree.created 때 기억해 둔 경로(storage 'pending')로
// 스크립트를 직접 실행한다.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// 플러그인 루트 기준으로 번들 스크립트 경로를 찾는다.
// 메인 파일이 어디로 복사되어도 자기 위치를 기준으로 삼기 위해 import.meta.url 을 쓴다.
const pluginRoot = fileURLToPath(new URL('.', import.meta.url));
const scriptPath = join(pluginRoot, 'bin', 'orca-branch-en.sh');

// 브랜치 이름에 비ASCII(한글 등)가 있는지 바이트/코드포인트 단위로 본다.
const NON_ASCII = /[^\x00-\x7F]/;
// 스크립트 결과 줄에 붙는 접두사. 이 줄만 결과로 해석한다.
const RESULT_PREFIX = '[orca-branch-en] ';

// 같은 워크트리에 대한 실행이 겹쳐 들어와도 스크립트를 중복 실행하지 않는다(경로 기준).
const running = new Set();
// deactivate 때 정리할 진행 중 자식 프로세스.
const children = new Set();

// 수동 커맨드가 대상을 찾을 수 있게 워크트리 경로를 키로, 그때의 브랜치 이름을 값으로 기억한다.
// 브랜치 이름을 키로 쓰면 서로 다른 저장소의 같은 한글 브랜치가 서로를 덮어써 엉뚱한 저장소의
// 워크트리를 실행할 수 있어서 경로를 키로 삼는다. 삽입 순서를 유지하고, storage 에도 저장해
// 워커가 재시작해도 남는다.
const pending = new Map();
const PENDING_KEY = 'pending';
const PENDING_MAX = 200;

// 브랜치의 마지막 '/' 뒤 부분만 본다. 스크립트와 같은 기준을 쓴다.
function branchTail(branch) {
  const i = branch.lastIndexOf('/');
  return i === -1 ? branch : branch.slice(i + 1);
}

// 알림은 실패해도 본 흐름을 막지 않는다. 실패는 로그만 남긴다.
async function notify(context, title, body) {
  try {
    await context.host.call('notifications.show', {
      title: String(title).slice(0, 120),
      body: String(body).slice(0, 1000),
    });
  } catch (err) {
    context.log(`알림 실패: ${err && err.message ? err.message : String(err)}`);
  }
}

// bin/orca-branch-en.sh 를 실행한다. 스크립트는 정상적으로도 실패를 알리며 항상 exit 0 이지만,
// 비0 종료·timeout·spawn 오류는 여기서 error 로 올라오므로 Promise 로 감싸 throw 하지 않는다.
function runScript(worktreePath) {
  return new Promise((resolve) => {
    const child = execFile(
      '/bin/bash',
      [scriptPath, worktreePath],
      {
        cwd: worktreePath,
        env: process.env,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        children.delete(child);
        resolve({ error, stdout: stdout || '', stderr: stderr || '' });
      },
    );
    children.add(child);
  });
}

// stdout 에서 결과 줄(마지막 것)만 뽑는다. 없으면 null.
function parseResult(stdout) {
  const lines = String(stdout)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith(RESULT_PREFIX));
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

function reasonFromError(error) {
  if (error && error.killed) return '시간 초과(120초)로 중단';
  if (error && typeof error.code === 'number') return `스크립트가 exit ${error.code} 로 끝남`;
  return (error && error.message) || '알 수 없는 오류';
}

// 워크트리 현재 브랜치를 git 에서 직접 읽는다.
// pending 은 마지막으로 실행할 때의 기억이라 그 사이 누군가 브랜치를 바꿨거나 워크트리가
// 사라졌을 수 있다. 실행 직전에 실제 값과 대조하려고 매번 git 에 물어본다.
// 성공하면 trim 한 브랜치 문자열, 실패(경로 없음·git 아님·detached·timeout)면 null. throw 하지 않는다.
function currentBranch(worktreePath) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', worktreePath, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const branch = String(stdout || '').trim();
        resolve(branch === '' ? null : branch);
      },
    );
  });
}

// pending 에 경로를 키로 기억한다. 같은 키를 다시 넣으면 지웠다가 넣어 최근 순서로 올린다.
// 그러지 않으면 상한(200)을 넘을 때 Map 의 오래된 순서 그대로 최근 것부터 축출될 수 있다.
// 상한을 넘으면 가장 오래된 것부터 버린다(삽입 순서 유지).
function rememberPending(worktreePath, branch) {
  pending.delete(worktreePath);
  pending.set(worktreePath, branch);
  while (pending.size > PENDING_MAX) {
    const oldest = pending.keys().next().value;
    pending.delete(oldest);
  }
}

// pending Map 을 storage 에 저장한다. 실패는 로그만 남기고 본 흐름을 막지 않는다.
async function savePending(context) {
  try {
    await context.host.call('storage.set', {
      key: PENDING_KEY,
      value: Object.fromEntries(pending),
    });
  } catch (err) {
    context.log(`pending 저장 실패: ${err && err.message ? err.message : String(err)}`);
  }
}

// 실패·skip 처리 뒤 pending 을 정리한다.
// 기억한 한글 브랜치에서 실제 브랜치가 이미 달라졌거나(누군가 먼저 바꿈) 읽을 수 없으면
// (경로 소실·detached) 그 기억은 더 이상 쓸모가 없어 지운다. 그대로면 수동 재시도를 위해 남긴다.
async function forgetIfStale(context, worktreePath, branch) {
  const cur = await currentBranch(worktreePath);
  if (cur === branch) return;
  pending.delete(worktreePath);
  await savePending(context);
}

// 워크트리 하나를 처리한다.
// 반환: 'none'(ASCII) | 'busy' | 'renamed' | 'fail' | 'skip' | 'error'.
async function processWorktree(context, worktreePath, branch) {
  // 브랜치 끝이 ASCII면 손댈 것이 없다. 자식 프로세스도 만들지 않는다.
  if (!NON_ASCII.test(branchTail(branch))) return 'none';

  if (running.has(worktreePath)) {
    context.log(`이미 실행 중: ${worktreePath}`);
    return 'busy';
  }
  running.add(worktreePath);
  try {
    // 실행 전에 먼저 기억해 둔다. 실패·skip 이어도 경로는 남겨 수동 재시도를 돕는다.
    rememberPending(worktreePath, branch);
    await savePending(context);

    const { error, stdout, stderr } = await runScript(worktreePath);
    const line = parseResult(stdout);
    // 결과 줄은 항상 로그로 남긴다(skip 포함).
    if (line) context.log(line);
    if (stderr.trim()) context.log(`stderr: ${stderr.trim().slice(0, 500)}`);

    if (error) {
      // 스크립트가 이미 실패를 보고했으면 그 사유를, 아니면 execFile 오류 사유를 쓴다.
      const failMarker = 'fail: ';
      const body = line && line.includes(failMarker)
        ? line.slice(line.indexOf(failMarker) + failMarker.length)
        : reasonFromError(error);
      await notify(context, '브랜치 이름 바꾸기 실패', body);
      // 결과 줄이 없어 실제로 바뀌었는지 알 수 없으므로 git 과 대조해 필요 없어진 기억을 지운다.
      await forgetIfStale(context, worktreePath, branch);
      return 'error';
    }

    if (!line) {
      // 결과 줄이 없으면 알릴 것이 없다. 다만 브랜치가 이미 영어면 기억을 지워 잔류를 막는다.
      await forgetIfStale(context, worktreePath, branch);
      return 'skip';
    }

    if (line.includes('renamed: ')) {
      // 스크립트는 'old -> new' 로 쓰지만 사람이 읽기 쉽게 '→' 로 바꿔 알린다.
      const rest = line.slice(line.indexOf('renamed: ') + 'renamed: '.length).replace(/ \(dry-run\)$/, '');
      const sep = ' -> ';
      const at = rest.lastIndexOf(sep);
      const body = at === -1 ? rest : `${rest.slice(0, at)} → ${rest.slice(at + sep.length)}`;
      await notify(context, '브랜치 이름을 바꿨습니다', body);
      // 성공했으면 이제 필요 없는 기억을 지우고 저장한다.
      pending.delete(worktreePath);
      await savePending(context);
      return 'renamed';
    }
    if (line.includes('fail: ')) {
      await notify(context, '브랜치 이름 바꾸기 실패', line.slice(line.indexOf('fail: ') + 'fail: '.length));
      // 실패해도 브랜치가 이미 바뀌었을 수 있어 git 과 대조해 잔류를 정리한다.
      await forgetIfStale(context, worktreePath, branch);
      return 'fail';
    }
    // 'skip:' 은 로그만 남기고 알리지 않는다. 브랜치가 그대로면 재시도를 위해 기억은 남긴다.
    await forgetIfStale(context, worktreePath, branch);
    return 'skip';
  } catch (err) {
    // 예외가 새어 나가도 ack 는 되지만, 직접 로그해 둔다.
    context.log(`워크트리 처리 중 오류: ${err && err.message ? err.message : String(err)}`);
    return 'error';
  } finally {
    running.delete(worktreePath);
  }
}

async function onWorktreeCreated(context, payload) {
  const worktreePath = payload && payload.path;
  const branch = payload && payload.branch;
  if (typeof worktreePath !== 'string' || worktreePath.length === 0 || typeof branch !== 'string') {
    context.log('worktree.created: path/branch 가 올바른 문자열이 아님');
    return;
  }
  try {
    await processWorktree(context, worktreePath, branch);
  } catch (err) {
    context.log(`worktree.created 처리 중 오류: ${err && err.message ? err.message : String(err)}`);
  }
}

async function renameBranchEn(context) {
  let ctx = null;
  try {
    ctx = await context.host.call('workspace.readContext');
  } catch (err) {
    context.log(`workspace.readContext 실패: ${err && err.message ? err.message : String(err)}`);
  }

  if (!ctx) {
    await notify(context, '브랜치 이름 바꾸기', '현재 워크트리를 알 수 없습니다');
    return { ok: false };
  }

  const branch = typeof ctx.branch === 'string' ? ctx.branch : '';
  if (!NON_ASCII.test(branchTail(branch))) {
    await notify(context, '브랜치 이름 바꾸기', '이미 영어 브랜치입니다');
    return { ok: false };
  }

  // pending(경로→브랜치)에서 같은 한글 브랜치를 가리키는 후보 경로를 모은다.
  // 알림 본문이 커지지 않도록 상한을 둔다(같은 이름이 이보다 많으면 어차피 고를 수 없다).
  const candidates = [];
  for (const [worktreePath, remembered] of pending) {
    if (remembered === branch) {
      candidates.push(worktreePath);
      if (candidates.length >= 10) break;
    }
  }

  // 기억은 실행 시점의 값이라 그 사이 브랜치가 바뀌었을 수 있다. 실제 브랜치와 대조해
  // 더 이상 그 한글 브랜치가 아닌 후보는 지운다(변경이 있을 때만 한 번 저장한다).
  const current = await Promise.all(candidates.map((p) => currentBranch(p)));
  const matches = [];
  let pruned = false;
  for (let i = 0; i < candidates.length; i += 1) {
    if (current[i] === branch) {
      matches.push(candidates[i]);
    } else {
      pending.delete(candidates[i]);
      pruned = true;
    }
  }
  if (pruned) await savePending(context);

  // 경로를 모르면 터미널에 타이핑하는 대신 직접 실행하도록 안내한다.
  if (matches.length === 0) {
    await notify(
      context,
      '브랜치 이름 바꾸기',
      `이 워크트리 경로를 모릅니다. 워크트리 폴더의 터미널에서 직접 실행하세요: /bin/bash ${scriptPath}`,
    );
    return { ok: false };
  }

  // 같은 한글 브랜치가 여러 저장소의 워크트리에 있으면 어느 것인지 가릴 수 없다.
  // 엉뚱한 저장소를 건드리지 않도록 아무 것도 실행하지 않고 후보 경로만 알려 준다.
  if (matches.length > 1) {
    const body = [
      '같은 이름의 브랜치가 여러 워크트리에 있어 고를 수 없습니다. 워크트리 폴더의 터미널에서 직접 실행하세요:',
      `/bin/bash ${scriptPath}`,
      ...matches,
    ].join('\n');
    await notify(context, '브랜치 이름 바꾸기', body.slice(0, 1000));
    return { ok: false };
  }

  const worktreePath = matches[0];
  if (running.has(worktreePath)) {
    await notify(context, '브랜치 이름 바꾸기', '이미 실행 중입니다');
    return { ok: false };
  }

  // 시작만 하고 기다리지 않는다. 커맨드 핸들러 제한이 30초인데 스크립트는 번역·git 으로
  // 그보다 오래 걸릴 수 있어서, 여기서 await 하면 핸들러가 시간 초과로 끊긴다.
  processWorktree(context, worktreePath, branch).catch((err) => {
    context.log(`수동 실행 중 오류: ${err && err.message ? err.message : String(err)}`);
  });
  return { ok: true, started: true };
}

export default async function activate(context) {
  // 이전 실행에서 남긴 pending 을 복원한다. 실패해도 등록은 계속한다.
  try {
    const res = await context.host.call('storage.get', { key: PENDING_KEY });
    const stored = res && res.value;
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [worktreePath, branch] of Object.entries(stored)) {
        if (typeof worktreePath === 'string' && typeof branch === 'string') {
          rememberPending(worktreePath, branch);
        }
      }
    }
  } catch (err) {
    context.log(`pending 복원 실패: ${err && err.message ? err.message : String(err)}`);
  }

  context.events.on('worktree.created', (payload) => onWorktreeCreated(context, payload));
  context.commands.register('rename-branch-en', (args) => renameBranchEn(context, args));
}

// 호스트가 shutdown 할 때 진행 중인 자식 프로세스를 정리한다.
export function deactivate() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // 이미 죽은 프로세스는 무시한다.
    }
  }
  children.clear();
  running.clear();
}

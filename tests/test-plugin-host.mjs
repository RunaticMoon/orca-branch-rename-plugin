// Orca 플러그인 워커(main.mjs)를 실제 Orca 번들의 플러그인 호스트로 검증한다.
//
// 외부 의존성 없이 Node 내장 모듈과 로컬 Orca 설치만 쓴다.
//   - 매니페스트 검증: 실제 chunks/plugin-manifest-*.js 의 검증기 사용
//   - 워커/이벤트/커맨드: 실제 app.asar.unpacked/out/main/plugin-host-entry.js 를 fork
// Orca 설치가 없으면 해당 케이스는 SKIP 한다(실패로 세지 않음).
//
// 실행: node tests/test-plugin-host.mjs
// Orca 위치: ORCA_RESOURCES (기본 /home/ubuntu/.local/opt/orca/1.4.217/squashfs-root/resources,
//            macOS 는 /Applications/Orca.app/Contents/Resources)

import { fork, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const MANIFEST_PATH = join(ROOT, 'orca-plugin.json');
const SCRIPT_PATH = join(ROOT, 'bin', 'orca-branch-en.sh');

// 플러그인이 storage.set/get 으로 쓰는 값. 워커(자식 프로세스)들끼리 공유해
// 재시작 후에도 pending 이 남아 있는지 검증할 수 있게 한다.
// pending 은 이제 Map<워크트리 경로, 브랜치 이름> 이므로 객체도 { [path]: branch } 모양이다.
const SHARED_STORAGE = new Map();
const PENDING_KEY = 'pending';
function pendingValue() {
  const v = SHARED_STORAGE.get(PENDING_KEY);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function pendingHasPath(path) {
  return Object.prototype.hasOwnProperty.call(pendingValue(), path);
}
function pendingBranchOf(path) {
  return pendingValue()[path];
}
// 같은 브랜치를 가리키는 pending 경로 목록. 충돌·정리 검증에 쓴다.
function pendingPathsFor(branch) {
  return Object.entries(pendingValue())
    .filter(([, value]) => value === branch)
    .map(([path]) => path);
}
// pending 의 초기 상태를 특정 객체로 시드한다(이전 케이스의 잔여 값 제거 포함).
function seedPending(obj) {
  SHARED_STORAGE.set(PENDING_KEY, obj);
}

// 플랫폼별 기본 Orca 리소스 위치. 실제로 존재하는 쪽을 고른다.
function defaultOrcaResources() {
  const linux = '/home/ubuntu/.local/opt/orca/1.4.217/squashfs-root/resources';
  const mac = '/Applications/Orca.app/Contents/Resources';
  if (existsSync(linux)) return linux;
  if (existsSync(mac)) return mac;
  return process.platform === 'darwin' ? mac : linux;
}

const ORCA_RESOURCES =
  process.env.ORCA_RESOURCES || defaultOrcaResources();
const OUT_MAIN = join(ORCA_RESOURCES, 'app.asar.unpacked', 'out', 'main');
const HOST_ENTRY = join(OUT_MAIN, 'plugin-host-entry.js');
const CHUNKS_DIR = join(OUT_MAIN, 'chunks');

const STEP_TIMEOUT = 15000;

let PASS = 0;
let FAIL = 0;
let SKIP = 0;
function pass(name) {
  console.log(`PASS: ${name}`);
  PASS += 1;
}
function fail(name, detail) {
  console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  FAIL += 1;
}
function skip(name, why) {
  console.log(`SKIP: ${name}${why ? ` (${why})` : ''}`);
  SKIP += 1;
}
function check(name, cond, detail) {
  if (cond) pass(name);
  else fail(name, detail);
}

const TMP = mkdtempSync(join(tmpdir(), 'orca-plugin-test-'));
process.on('exit', () => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // 정리 실패는 무시한다.
  }
});

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// 임시 git 저장소를 만들고 worktree 추가 함수를 돌려준다.
function makeRepo(name) {
  const repo = join(TMP, name);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test User'], repo);
  git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);
  return {
    repo,
    addWorktree(branch, suffix) {
      const wt = join(TMP, `${name}-${suffix}`);
      git(['worktree', 'add', '-q', '-b', branch, wt], repo);
      return wt;
    },
  };
}

function branchOf(wt) {
  return git(['symbolic-ref', '-q', '--short', 'HEAD'], wt).trim();
}

// ---------------------------------------------------------------------------
// 부모 프로세스 대신 실제 플러그인 호스트를 흉내 내는 워커 컨트롤러
// ---------------------------------------------------------------------------
function startWorker(extraEnv) {
  if (!existsSync(HOST_ENTRY)) throw new Error(`host entry 없음: ${HOST_ENTRY}`);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
    ELECTRON_RUN_AS_NODE: '1',
    ...extraEnv,
  };
  const child = fork(HOST_ENTRY, [], {
    env,
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const messages = [];
  const waiters = [];
  const storageCalls = [];
  let stderr = '';
  let exited = null;
  const exitWaiters = [];

  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  child.on('message', (m) => {
    // storage.get/set 은 하네스가 직접 응답하고, 기록만 남긴다.
    if (m && m.type === 'hostCall' && (m.method === 'storage.get' || m.method === 'storage.set')) {
      storageCalls.push(m);
      const key = m.params && m.params.key;
      if (m.method === 'storage.get') {
        const value = SHARED_STORAGE.has(key) ? SHARED_STORAGE.get(key) : null;
        child.send({ type: 'hostResult', callId: m.callId, ok: true, value: { value } });
      } else {
        SHARED_STORAGE.set(key, m.params ? m.params.value : undefined);
        child.send({ type: 'hostResult', callId: m.callId, ok: true, value: { ok: true } });
      }
      return;
    }
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
    } else {
      messages.push(m);
    }
  });
  const onExit = (code, signal) => {
    exited = { code, signal };
    for (const w of exitWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(exited);
    }
  };
  child.on('exit', onExit);
  child.on('error', (err) => {
    stderr += `\nspawn error: ${err.message}`;
  });

  const dump = () =>
    `stderr=${stderr.slice(0, 400)} messages=${JSON.stringify(messages).slice(0, 400)}`;

  function next(pred, label, timeout = STEP_TIMEOUT) {
    const i = messages.findIndex(pred);
    if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: null };
      w.timer = setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j >= 0) waiters.splice(j, 1);
        reject(new Error(`timeout: ${label} (${dump()})`));
      }, timeout);
      waiters.push(w);
    });
  }

  function waitExit(timeout = STEP_TIMEOUT) {
    if (exited) return Promise.resolve(exited);
    return new Promise((resolve, reject) => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => reject(new Error(`timeout: worker exit (${dump()})`)), timeout);
      exitWaiters.push(w);
    });
  }

  // 워커가 보낸 hostCall 에 응답한다.
  function hostResult(callId, value) {
    child.send({ type: 'hostResult', callId, ok: true, value });
  }

  return {
    child,
    env,
    next,
    waitExit,
    hostResult,
    send: (m) => child.send(m),
    storageCalls: () => storageCalls,
    leftoverHostCalls: () => messages.filter((m) => m.type === 'hostCall'),
    dump,
    init() {
      child.send({
        type: 'init',
        pluginId: 'korean-branch-en',
        pluginRoot: ROOT,
        mainEntry: 'main.mjs',
        grantedCapabilities: ['events:subscribe', 'notifications:show', 'workspace:read', 'storage'],
      });
    },
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 조건이 참이 될 때까지 짧게 폴링한다(비동기 후처리 확인용).
async function waitFor(cond, timeout = 5000, step = 50) {
  const end = Date.now() + timeout;
  while (true) {
    if (cond()) return true;
    if (Date.now() >= end) return cond();
    await delay(step);
  }
}

// ---------------------------------------------------------------------------
// 케이스 a: 매니페스트 검증기
// ---------------------------------------------------------------------------
function caseA() {
  const name = 'a 매니페스트 검증';
  if (!existsSync(CHUNKS_DIR)) {
    skip(name, `chunks 없음: ${CHUNKS_DIR}`);
    return;
  }
  const manifestFiles = readdirSync(CHUNKS_DIR).filter((f) => /^plugin-manifest-.*\.js$/.test(f));
  if (manifestFiles.length === 0) {
    skip(name, 'plugin-manifest-*.js 없음');
    return;
  }
  const require = createRequire(import.meta.url);
  const validator = require(join(CHUNKS_DIR, manifestFiles[0]));

  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const good = validator.i(raw);
  check(`${name}: 실제 매니페스트 ok`, good.ok === true, JSON.stringify(good));

  const bad = JSON.parse(JSON.stringify(raw));
  bad.contributes.bogus = [];
  const badResult = validator.i(bad);
  check(`${name}: 모르는 contributes 키 거부`, badResult.ok === false, JSON.stringify(badResult));
}

// ---------------------------------------------------------------------------
// 케이스 b: fork + init + ready
// ---------------------------------------------------------------------------
async function caseB() {
  const name = 'b 워커 init/ready';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, `host entry 없음: ${HOST_ENTRY}`);
    return null;
  }
  let w;
  try {
    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: join(TMP, 'b.log'),
    });
    w.init();
    const ready = await w.next((m) => m.type === 'ready', 'ready');
    const ok = Array.isArray(ready.commands) && ready.commands.includes('rename-branch-en');
    check(`${name}: ready 에 rename-branch-en 등록`, ok, JSON.stringify(ready).slice(0, 200));
    return w;
  } catch (err) {
    fail(name, err.message);
    return w || null;
  }
}

// ---------------------------------------------------------------------------
// 케이스 c: worktree.created 로 리네임 + 알림
// ---------------------------------------------------------------------------
async function caseC() {
  const name = 'c worktree.created 리네임+알림';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    const log = join(TMP, 'c.log');
    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: log,
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    const { addWorktree } = makeRepo('repo-c');
    const wt = addWorktree('feature/샘플-작업', 'wt');

    w.send({
      type: 'deliverEvent',
      eventId: 1,
      event: 'worktree.created',
      payload: { worktreeId: `repo::${wt}`, path: wt, branch: 'feature/샘플-작업' },
    });

    const call = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show',
    );
    w.hostResult(call.callId, { delivered: true });
    await w.next((m) => m.type === 'eventAck' && m.eventId === 1, 'eventAck');

    check(`${name}: 브랜치 영어로 변경`, branchOf(wt) === 'feature/sample-task', `branch=${branchOf(wt)}`);
    const titleOk = call.params && call.params.title === '브랜치 이름을 바꿨습니다';
    const bodyOk = call.params && call.params.body === 'feature/샘플-작업 → feature/sample-task';
    check(`${name}: 알림 내용`, titleOk && bodyOk, JSON.stringify(call.params));

    // 실행 전에 pending(경로 키)이 기록됐다가, renamed 후 제거됐는지 본다.
    const recorded = w
      .storageCalls()
      .filter((m) => m.method === 'storage.set')
      .some((m) => m.params && m.params.value && m.params.value[wt] === 'feature/샘플-작업');
    check(`${name}: 실행 전 pending 기록`, recorded, JSON.stringify(w.storageCalls()));
    check(`${name}: renamed 후 pending 제거`, !pendingHasPath(wt), JSON.stringify(pendingValue()));
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 d: ASCII 브랜치 → 호스트 호출 없음
// ---------------------------------------------------------------------------
async function caseD() {
  const name = 'd ASCII 브랜치 무시';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    const marker = join(TMP, 'd.marker');
    const log = join(TMP, 'd.log');
    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: `touch '${marker}'`,
      ORCA_BRANCH_EN_LOG: log,
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    const { addWorktree } = makeRepo('repo-d');
    const wt = addWorktree('feature/already-english', 'wt');

    w.send({
      type: 'deliverEvent',
      eventId: 7,
      event: 'worktree.created',
      payload: { worktreeId: `repo::${wt}`, path: wt, branch: 'feature/already-english' },
    });
    await w.next((m) => m.type === 'eventAck' && m.eventId === 7, 'eventAck');
    // hostCall 이 뒤늦게 올 여지를 조금 기다린다.
    await delay(300);

    check(`${name}: 브랜치 그대로`, branchOf(wt) === 'feature/already-english', `branch=${branchOf(wt)}`);
    check(`${name}: 스크립트 미호출(marker 없음)`, !existsSync(marker));
    check(`${name}: 로그 파일 미생성`, !existsSync(log));
    check(`${name}: hostCall 없음`, w.leftoverHostCalls().length === 0, w.dump());
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 e: slug 명령 실패 → 실패 알림, 브랜치 유지
// ---------------------------------------------------------------------------
async function caseE() {
  const name = 'e slug 실패 → 실패 알림';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return null;
  }
  let w;
  try {
    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'exit 3',
      ORCA_BRANCH_EN_LOG: join(TMP, 'e.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    const { addWorktree } = makeRepo('repo-e');
    const wt = addWorktree('feature/한글-실패', 'wt');

    w.send({
      type: 'deliverEvent',
      eventId: 3,
      event: 'worktree.created',
      payload: { worktreeId: `repo::${wt}`, path: wt, branch: 'feature/한글-실패' },
    });

    const call = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(실패)',
    );
    w.hostResult(call.callId, { delivered: true });
    await w.next((m) => m.type === 'eventAck' && m.eventId === 3, 'eventAck');

    check(`${name}: 브랜치 그대로`, branchOf(wt) === 'feature/한글-실패', `branch=${branchOf(wt)}`);
    check(
      `${name}: 실패 알림`,
      call.params && call.params.title === '브랜치 이름 바꾸기 실패',
      JSON.stringify(call.params),
    );
    // 실패했으니 pending 에 경로가 남아 있어야 이후 수동 재시도가 가능하다.
    check(
      `${name}: 실패 후 pending 유지`,
      pendingHasPath(wt) && pendingBranchOf(wt) === 'feature/한글-실패',
      JSON.stringify(pendingValue()),
    );
    return { wt, branch: 'feature/한글-실패' };
  } catch (err) {
    fail(name, err.message);
    return null;
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 f: 수동 커맨드 (경로 기억 방식)
// ---------------------------------------------------------------------------
async function caseF(eInfo) {
  const name = 'f 수동 rename-branch-en 커맨드';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  if (!eInfo) {
    skip(name, '케이스 e 정보 없음');
    return;
  }
  let w;
  try {
    // e 에서 남은 pending(storage 가 워커 간에 공유됨)을 그대로 물려받은 워커를 새로 띄운다.
    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: join(TMP, 'f.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    // f1: pending 에 기억된 경로를 재시도 → 즉시 started 반환 후 실제 리네임+알림.
    w.send({ type: 'invokeCommand', callId: 101, commandId: 'rename-branch-en' });
    const rc1 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(f1)',
    );
    w.hostResult(rc1.callId, { branch: eInfo.branch, displayName: 'x', terminals: [] });
    const cmd1 = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 101,
      'commandResult 101',
    );
    check(
      `${name}: f1 즉시 started 반환`,
      cmd1.ok === true && cmd1.value && cmd1.value.ok === true && cmd1.value.started === true,
      JSON.stringify(cmd1),
    );
    const notif1 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(f1)',
    );
    w.hostResult(notif1.callId, { delivered: true });
    await waitFor(() => branchOf(eInfo.wt) === 'feature/sample-task' && !pendingHasPath(eInfo.wt));
    check(
      `${name}: f1 브랜치 영어로 변경`,
      branchOf(eInfo.wt) === 'feature/sample-task',
      `branch=${branchOf(eInfo.wt)}`,
    );
    check(
      `${name}: f1 성공 알림`,
      notif1.params && notif1.params.title === '브랜치 이름을 바꿨습니다',
      JSON.stringify(notif1.params),
    );
    check(`${name}: f1 pending 제거`, !pendingHasPath(eInfo.wt), JSON.stringify(pendingValue()));

    // f2: readContext null → value.ok=false
    w.send({ type: 'invokeCommand', callId: 102, commandId: 'rename-branch-en' });
    const rc2 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(f2)',
    );
    w.hostResult(rc2.callId, null);
    const notif2 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(f2)',
    );
    w.hostResult(notif2.callId, { delivered: true });
    const cmd2 = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 102,
      'commandResult 102',
    );
    check(
      `${name}: f2 컨텍스트 없음 → value.ok=false`,
      cmd2.ok === true && cmd2.value && cmd2.value.ok === false,
      JSON.stringify(cmd2),
    );

    // f3: ASCII 브랜치 → value.ok=false
    w.send({ type: 'invokeCommand', callId: 103, commandId: 'rename-branch-en' });
    const rc3 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(f3)',
    );
    w.hostResult(rc3.callId, { branch: 'feature/already-english', displayName: 'x', terminals: [] });
    const notif3 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(f3)',
    );
    w.hostResult(notif3.callId, { delivered: true });
    const cmd3 = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 103,
      'commandResult 103',
    );
    check(
      `${name}: f3 ASCII → value.ok=false`,
      cmd3.ok === true && cmd3.value && cmd3.value.ok === false,
      JSON.stringify(cmd3),
    );

    // f4: pending 에 없는 한글 브랜치 → 경로 안내 알림
    w.send({ type: 'invokeCommand', callId: 104, commandId: 'rename-branch-en' });
    const rc4 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(f4)',
    );
    w.hostResult(rc4.callId, { branch: 'feature/모르는-브랜치', displayName: 'x', terminals: [] });
    const notif4 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(f4)',
    );
    w.hostResult(notif4.callId, { delivered: true });
    const cmd4 = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 104,
      'commandResult 104',
    );
    check(
      `${name}: f4 경로 모름 → value.ok=false`,
      cmd4.ok === true && cmd4.value && cmd4.value.ok === false,
      JSON.stringify(cmd4),
    );
    check(
      `${name}: f4 경로 안내 알림`,
      notif4.params && typeof notif4.params.body === 'string' && notif4.params.body.includes('orca-branch-en.sh'),
      JSON.stringify(notif4.params),
    );

    // 어떤 경로로도 터미널에 타이핑하지 않아야 한다.
    check(
      `${name}: terminal.sendText 없음`,
      w.leftoverHostCalls().every((m) => m.method !== 'terminal.sendText'),
      w.dump(),
    );
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 g: shutdown → 프로세스 종료
// ---------------------------------------------------------------------------
async function caseG() {
  const name = 'g shutdown 후 종료';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    w = startWorker({ ORCA_BRANCH_EN_LOG: join(TMP, 'g.log') });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');
    w.send({ type: 'shutdown' });
    const info = await w.waitExit(STEP_TIMEOUT);
    check(`${name}: 프로세스 exit`, info && info.code === 0, JSON.stringify(info));
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 h1: 같은 한글 브랜치가 두 저장소에 있으면 고르지 않고 안내만
// ---------------------------------------------------------------------------
async function caseH1() {
  const name = 'h1 같은 브랜치 충돌 안내';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return null;
  }
  let w;
  try {
    const branch = 'feature/알림-설정';
    const a = makeRepo('repo-h1a');
    const b = makeRepo('repo-h1b');
    const wt1 = a.addWorktree(branch, 'wt');
    const wt2 = b.addWorktree(branch, 'wt');
    // 서로 다른 저장소의 같은 한글 브랜치 두 경로가 기억된 상태를 시드한다.
    seedPending({ [wt1]: branch, [wt2]: branch });

    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: join(TMP, 'h1.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    w.send({ type: 'invokeCommand', callId: 201, commandId: 'rename-branch-en' });
    const rc = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(h1)',
    );
    w.hostResult(rc.callId, { branch, displayName: 'x', terminals: [] });

    const notif = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(h1)',
    );
    w.hostResult(notif.callId, { delivered: true });
    const cmd = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 201,
      'commandResult 201',
    );

    check(
      `${name}: value.ok=false`,
      cmd.ok === true && cmd.value && cmd.value.ok === false,
      JSON.stringify(cmd),
    );
    const body = notif.params && notif.params.body;
    check(
      `${name}: 알림 body 에 두 경로`,
      typeof body === 'string' && body.includes(wt1) && body.includes(wt2),
      JSON.stringify(notif.params),
    );
    check(`${name}: 두 브랜치 그대로`, branchOf(wt1) === branch && branchOf(wt2) === branch);
    check(
      `${name}: terminal.sendText 없음`,
      w.leftoverHostCalls().every((m) => m.method !== 'terminal.sendText'),
      w.dump(),
    );
    return { branch, wt1, wt2 };
  } catch (err) {
    fail(name, err.message);
    return null;
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 h2: 한쪽이 이미 영어로 바뀐 충돌 → 남은 하나만 실행하고 바뀐 쪽 기억 제거
// ---------------------------------------------------------------------------
async function caseH2(h1) {
  const name = 'h2 한쪽이 이미 바뀐 충돌';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  if (!h1) {
    skip(name, 'h1 정보 없음');
    return;
  }
  let w;
  try {
    const { branch, wt1, wt2 } = h1;
    // 첫 번째 워크트리는 이미 영어 브랜치로 바뀐 상태를 만든다.
    git(['branch', '-m', branch, 'feature/notification-settings'], wt1);
    // pending 은 아직 두 경로를 가리킨다고 가정한다(h1 은 지우지 않음).
    seedPending({ [wt1]: branch, [wt2]: branch });

    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: join(TMP, 'h2.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    w.send({ type: 'invokeCommand', callId: 202, commandId: 'rename-branch-en' });
    const rc = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(h2)',
    );
    w.hostResult(rc.callId, { branch, displayName: 'x', terminals: [] });

    const cmd = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 202,
      'commandResult 202',
    );
    check(
      `${name}: 남은 하나만 started`,
      cmd.ok === true && cmd.value && cmd.value.ok === true && cmd.value.started === true,
      JSON.stringify(cmd),
    );

    const notif = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(h2)',
    );
    w.hostResult(notif.callId, { delivered: true });
    await waitFor(() => branchOf(wt2) === 'feature/sample-task' && !pendingHasPath(wt1));

    check(
      `${name}: 남은 브랜치 영어로 변경`,
      branchOf(wt2) === 'feature/sample-task',
      `branch=${branchOf(wt2)}`,
    );
    check(`${name}: 바뀐 쪽 경로 제거`, !pendingHasPath(wt1), JSON.stringify(pendingValue()));
    check(
      `${name}: terminal.sendText 없음`,
      w.leftoverHostCalls().every((m) => m.method !== 'terminal.sendText'),
      w.dump(),
    );
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 h3: payload 는 한글인데 실제 브랜치는 이미 ASCII → 잔류 기억 제거
// ---------------------------------------------------------------------------
async function caseH3() {
  const name = 'h3 잔류 pending 정리';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    // 이전 케이스의 잔여가 섞이지 않게 비워 둔다.
    seedPending({});
    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: join(TMP, 'h3.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    const { addWorktree } = makeRepo('repo-h3');
    const wt = addWorktree('feature/already-english', 'wt');

    w.send({
      type: 'deliverEvent',
      eventId: 31,
      event: 'worktree.created',
      payload: { worktreeId: `repo::${wt}`, path: wt, branch: 'feature/한글-잔류' },
    });
    await w.next((m) => m.type === 'eventAck' && m.eventId === 31, 'eventAck');

    check(`${name}: 브랜치 그대로`, branchOf(wt) === 'feature/already-english', `branch=${branchOf(wt)}`);
    check(`${name}: 잔류 기억 제거`, !pendingHasPath(wt), JSON.stringify(pendingValue()));
    check(
      `${name}: terminal.sendText 없음`,
      w.leftoverHostCalls().every((m) => m.method !== 'terminal.sendText'),
      w.dump(),
    );
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 h4: 같은 워크트리에 수동 커맨드가 겹치면 두 번째는 거절
// ---------------------------------------------------------------------------
async function caseH4() {
  const name = 'h4 실행 중 중복 명령 차단';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    const branch = 'feature/지연-작업';
    const { addWorktree } = makeRepo('repo-h4');
    const wt = addWorktree(branch, 'wt');
    seedPending({ [wt]: branch });

    w = startWorker({
      // 첫 실행이 running 에 머무는 동안 두 번째가 겹치도록 slug 명령을 늦춘다.
      ORCA_BRANCH_EN_SLUG_CMD: 'sleep 2; echo "sample task"',
      ORCA_BRANCH_EN_LOG: join(TMP, 'h4.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    // 첫 번째 명령: 즉시 started 를 돌려주고 백그라운드로 리네임한다.
    w.send({ type: 'invokeCommand', callId: 203, commandId: 'rename-branch-en' });
    const rc1 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(h4-1)',
    );
    w.hostResult(rc1.callId, { branch, displayName: 'x', terminals: [] });
    const cmd1 = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 203,
      'commandResult 203',
    );
    check(
      `${name}: 첫 명령 started`,
      cmd1.ok === true && cmd1.value && cmd1.value.started === true,
      JSON.stringify(cmd1),
    );

    // 두 번째 명령: 아직 실행 중이라 거절되어야 한다.
    w.send({ type: 'invokeCommand', callId: 204, commandId: 'rename-branch-en' });
    const rc2 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(h4-2)',
    );
    w.hostResult(rc2.callId, { branch, displayName: 'x', terminals: [] });
    const notif2 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(h4-busy)',
    );
    w.hostResult(notif2.callId, { delivered: true });
    const cmd2 = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 204,
      'commandResult 204',
    );
    check(
      `${name}: 두 번째 value.ok=false`,
      cmd2.ok === true && cmd2.value && cmd2.value.ok === false,
      JSON.stringify(cmd2),
    );
    check(
      `${name}: 이미 실행 중 알림`,
      notif2.params && notif2.params.body === '이미 실행 중입니다',
      JSON.stringify(notif2.params),
    );

    // 첫 실행이 2초 뒤 끝나며 성공 알림을 보낸다.
    const notif1 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(h4-done)',
    );
    w.hostResult(notif1.callId, { delivered: true });
    await waitFor(() => branchOf(wt) === 'feature/sample-task' && !pendingHasPath(wt));

    check(`${name}: 첫 실행 리네임 완료`, branchOf(wt) === 'feature/sample-task', `branch=${branchOf(wt)}`);
    check(`${name}: 완료 후 기억 제거`, !pendingHasPath(wt), JSON.stringify(pendingValue()));
    check(
      `${name}: terminal.sendText 없음`,
      w.leftoverHostCalls().every((m) => m.method !== 'terminal.sendText'),
      w.dump(),
    );
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 i1: git 판독 불가(가짜 git 실패) → 실행하지 않고 pending 보존
// ---------------------------------------------------------------------------
async function caseI1() {
  const name = 'i1 판독 불가 시 pending 보존';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    // 워커 PATH 맨 앞에 git 대신 exit 2 하는 스크립트를 둬서 currentBranch 가 'unknown' 을 내게 한다.
    const fakeDir = join(TMP, 'fake-git-i1');
    mkdirSync(fakeDir, { recursive: true });
    const fakeGit = join(fakeDir, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\nexit 2\n');
    chmodSync(fakeGit, 0o755);

    const branch = 'feature/판독-불가';
    const { addWorktree } = makeRepo('repo-i1');
    const wt = addWorktree(branch, 'wt');
    // 경로는 실제로 존재하지만 git 이 실패해 브랜치를 확인할 수 없는 상태를 시드한다.
    seedPending({ [wt]: branch });

    w = startWorker({
      PATH: `${fakeDir}:${process.env.PATH}`,
      ORCA_BRANCH_EN_LOG: join(TMP, 'i1.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    w.send({ type: 'invokeCommand', callId: 301, commandId: 'rename-branch-en' });
    const rc = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(i1)',
    );
    w.hostResult(rc.callId, { branch, displayName: 'x', terminals: [] });

    const notif = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(i1)',
    );
    w.hostResult(notif.callId, { delivered: true });
    const cmd = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 301,
      'commandResult 301',
    );

    check(
      `${name}: value.ok=false`,
      cmd.ok === true && cmd.value && cmd.value.ok === false,
      JSON.stringify(cmd),
    );
    check(
      `${name}: 확인 불가 안내`,
      notif.params && typeof notif.params.body === 'string' && notif.params.body.includes('확인할 수 없습니다'),
      JSON.stringify(notif.params),
    );
    // 판독 불가일 뿐 브랜치가 바뀐 게 아니므로 기억은 남아 있어야 한다.
    check(
      `${name}: pending 유지`,
      pendingHasPath(wt) && pendingBranchOf(wt) === branch,
      JSON.stringify(pendingValue()),
    );
    check(`${name}: 브랜치 그대로`, branchOf(wt) === branch, `branch=${branchOf(wt)}`);
    check(
      `${name}: terminal.sendText 없음`,
      w.leftoverHostCalls().every((m) => m.method !== 'terminal.sendText'),
      w.dump(),
    );
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 i2: 사라진 경로는 정리하고 실제 경로만 실행
// ---------------------------------------------------------------------------
async function caseI2() {
  const name = 'i2 사라진 경로 정리 후 실행';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    const branch = 'feature/사라진-경로';
    const { addWorktree } = makeRepo('repo-i2');
    const wt = addWorktree(branch, 'wt');
    const ghost = join(TMP, 'repo-i2-ghost-wt'); // 존재하지 않는 경로
    seedPending({ [ghost]: branch, [wt]: branch });

    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: join(TMP, 'i2.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    w.send({ type: 'invokeCommand', callId: 302, commandId: 'rename-branch-en' });
    const rc = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(i2)',
    );
    w.hostResult(rc.callId, { branch, displayName: 'x', terminals: [] });
    const cmd = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 302,
      'commandResult 302',
    );
    check(
      `${name}: 실제 경로만 started`,
      cmd.ok === true && cmd.value && cmd.value.ok === true && cmd.value.started === true,
      JSON.stringify(cmd),
    );

    const notif = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(i2)',
    );
    w.hostResult(notif.callId, { delivered: true });
    // 성공 후 저장까지 끝나야 다음 케이스 시드와 겹치지 않는다. 실제 경로 제거까지 기다린다.
    await waitFor(
      () => branchOf(wt) === 'feature/sample-task' && !pendingHasPath(ghost) && !pendingHasPath(wt),
    );

    check(`${name}: 브랜치 영어로 변경`, branchOf(wt) === 'feature/sample-task', `branch=${branchOf(wt)}`);
    check(`${name}: 없는 경로 제거`, !pendingHasPath(ghost), JSON.stringify(pendingValue()));
    check(`${name}: 실제 경로도 성공 후 제거`, !pendingHasPath(wt), JSON.stringify(pendingValue()));
    check(
      `${name}: terminal.sendText 없음`,
      w.leftoverHostCalls().every((m) => m.method !== 'terminal.sendText'),
      w.dump(),
    );
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 i3: 같은 브랜치 후보 11개 → git 확인 없이 거절, pending 그대로
// ---------------------------------------------------------------------------
async function caseI3() {
  const name = 'i3 후보 11개 초과 거절';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    // git 이 호출되면 marker 를 남기는 가짜 git 을 앞에 둔다(호출 여부 확인용).
    const fakeDir = join(TMP, 'fake-git-i3');
    mkdirSync(fakeDir, { recursive: true });
    const marker = join(TMP, 'i3.git-called');
    const fakeGit = join(fakeDir, 'git');
    writeFileSync(fakeGit, `#!/bin/sh\ntouch '${marker}'\nexit 2\n`);
    chmodSync(fakeGit, 0o755);

    const branch = 'feature/후보-과다';
    const seeded = {};
    for (let i = 0; i < 11; i += 1) seeded[join(TMP, `repo-i3-ghost-${i}`)] = branch;
    seedPending(seeded);

    w = startWorker({
      PATH: `${fakeDir}:${process.env.PATH}`,
      ORCA_BRANCH_EN_LOG: join(TMP, 'i3.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    w.send({ type: 'invokeCommand', callId: 303, commandId: 'rename-branch-en' });
    const rc = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(i3)',
    );
    w.hostResult(rc.callId, { branch, displayName: 'x', terminals: [] });
    const notif = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(i3)',
    );
    w.hostResult(notif.callId, { delivered: true });
    const cmd = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 303,
      'commandResult 303',
    );

    check(
      `${name}: value.ok=false`,
      cmd.ok === true && cmd.value && cmd.value.ok === false,
      JSON.stringify(cmd),
    );
    check(
      `${name}: 너무 많아 안내`,
      notif.params && typeof notif.params.body === 'string' && notif.params.body.includes('너무 많아'),
      JSON.stringify(notif.params),
    );
    check(`${name}: git 미호출`, !existsSync(marker));
    check(
      `${name}: pending 11개 그대로`,
      pendingPathsFor(branch).length === 11,
      JSON.stringify(pendingValue()),
    );
    check(
      `${name}: terminal.sendText 없음`,
      w.leftoverHostCalls().every((m) => m.method !== 'terminal.sendText'),
      w.dump(),
    );
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 i4: 매칭 7개 → 본문은 경로 5줄 + '외 2개', 1000자 이하
// ---------------------------------------------------------------------------
async function caseI4() {
  const name = 'i4 고를 수 없음 본문 절단';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    const branch = 'feature/절단-확인';
    // 같은 브랜치는 한 저장소에 여러 워크트리로 만들 수 없어 저장소 7개를 만든다.
    const paths = [];
    for (let i = 0; i < 7; i += 1) {
      const { addWorktree } = makeRepo(`repo-i4-${i}`);
      paths.push(addWorktree(branch, 'wt'));
    }
    const seeded = {};
    for (const p of paths) seeded[p] = branch;
    seedPending(seeded);

    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: join(TMP, 'i4.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    w.send({ type: 'invokeCommand', callId: 304, commandId: 'rename-branch-en' });
    const rc = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(i4)',
    );
    w.hostResult(rc.callId, { branch, displayName: 'x', terminals: [] });
    const notif = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(i4)',
    );
    w.hostResult(notif.callId, { delivered: true });
    const cmd = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 304,
      'commandResult 304',
    );

    const body = notif.params && notif.params.body;
    const lines = typeof body === 'string' ? body.split('\n') : [];
    check(
      `${name}: value.ok=false`,
      cmd.ok === true && cmd.value && cmd.value.ok === false,
      JSON.stringify(cmd),
    );
    check(`${name}: 본문 1000자 이하`, typeof body === 'string' && body.length <= 1000, `len=${body && body.length}`);
    check(`${name}: 경로 5줄만 나열`, paths.slice(0, 5).every((p) => lines.includes(p)), JSON.stringify(lines));
    check(
      `${name}: 6·7번째 경로 없음`,
      !lines.includes(paths[5]) && !lines.includes(paths[6]),
      JSON.stringify(lines),
    );
    check(`${name}: 외 2개 표기`, typeof body === 'string' && body.includes('외 2개'), JSON.stringify(body));
    check(`${name}: 브랜치 그대로`, paths.every((p) => branchOf(p) === branch));
    check(
      `${name}: terminal.sendText 없음`,
      w.leftoverHostCalls().every((m) => m.method !== 'terminal.sendText'),
      w.dump(),
    );
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 j1: payload.branch 가 refs/heads/ 형태여도 정규화해 리네임
// 실제 Orca 1.4.217 은 worktree.created payload.branch 를 `refs/heads/<이름>` 로 준다.
// ---------------------------------------------------------------------------
async function caseJ1() {
  const name = 'j1 refs/heads/ payload 정규화 리네임';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    // 이전 케이스들의 잔여 pending 을 비운다.
    seedPending({});
    const log = join(TMP, 'j1.log');
    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: log,
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    const { addWorktree } = makeRepo('repo-j1');
    const wt = addWorktree('feature/j1-한글', 'wt');

    w.send({
      type: 'deliverEvent',
      eventId: 411,
      event: 'worktree.created',
      payload: { worktreeId: `repo::${wt}`, path: wt, branch: 'refs/heads/feature/j1-한글' },
    });

    const call = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(j1)',
    );
    w.hostResult(call.callId, { delivered: true });
    await w.next((m) => m.type === 'eventAck' && m.eventId === 411, 'eventAck');

    check(`${name}: 브랜치 영어로 변경`, branchOf(wt) === 'feature/sample-task', `branch=${branchOf(wt)}`);
    const titleOk = call.params && call.params.title === '브랜치 이름을 바꿨습니다';
    // 알림의 old 이름은 스크립트가 git 에서 읽은 짧은 이름이라 refs/heads/ 가 섞이지 않아야 한다.
    const bodyOk = call.params && call.params.body === 'feature/j1-한글 → feature/sample-task';
    check(`${name}: 알림 내용`, titleOk && bodyOk, JSON.stringify(call.params));
    check(
      `${name}: 알림에 refs/heads/ 없음`,
      call.params && typeof call.params.body === 'string' && !call.params.body.includes('refs/heads/'),
      JSON.stringify(call.params),
    );
    check(`${name}: pending 제거`, !pendingHasPath(wt), JSON.stringify(pendingValue()));
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 j2: payload 가 refs/heads/ + slug 실패 → pending 에 정규화된 이름으로 남김
// 정규화하지 않으면 forgetIfStale 이 짧은 git 이름과 달라 항상 지워 버린다.
// ---------------------------------------------------------------------------
async function caseJ2() {
  const name = 'j2 refs/heads/ slug 실패 후 pending 정규화 유지';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return null;
  }
  let w;
  try {
    const branch = 'feature/j2-한글';
    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'exit 3',
      ORCA_BRANCH_EN_LOG: join(TMP, 'j2.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    const { addWorktree } = makeRepo('repo-j2');
    const wt = addWorktree(branch, 'wt');

    w.send({
      type: 'deliverEvent',
      eventId: 412,
      event: 'worktree.created',
      payload: { worktreeId: `repo::${wt}`, path: wt, branch: `refs/heads/${branch}` },
    });

    const call = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(j2)',
    );
    w.hostResult(call.callId, { delivered: true });
    await w.next((m) => m.type === 'eventAck' && m.eventId === 412, 'eventAck');

    check(`${name}: 브랜치 그대로`, branchOf(wt) === branch, `branch=${branchOf(wt)}`);
    check(
      `${name}: 실패 알림`,
      call.params && call.params.title === '브랜치 이름 바꾸기 실패',
      JSON.stringify(call.params),
    );
    check(
      `${name}: pending 에 정규화된 이름으로 유지`,
      pendingHasPath(wt) && pendingBranchOf(wt) === branch,
      JSON.stringify(pendingValue()),
    );
    return { wt, branch };
  } catch (err) {
    fail(name, err.message);
    return null;
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 j3: j2 상태를 이어받은 새 워커 + readContext 가 refs/heads/ → 수동 성공
// ---------------------------------------------------------------------------
async function caseJ3(j2) {
  const name = 'j3 refs/heads/ readContext 수동 재시도';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  if (!j2) {
    skip(name, '케이스 j2 정보 없음');
    return;
  }
  let w;
  try {
    // j2 가 남긴 pending(storage 공유)을 그대로 물려받은 새 워커를 띄운다.
    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: join(TMP, 'j3.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    w.send({ type: 'invokeCommand', callId: 413, commandId: 'rename-branch-en' });
    const rc = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(j3)',
    );
    // 실제 Orca 의 workspace.readContext 도 refs/heads/ 형태일 수 있다.
    w.hostResult(rc.callId, { branch: `refs/heads/${j2.branch}`, displayName: 'x', terminals: [] });
    const cmd = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 413,
      'commandResult 413',
    );
    check(
      `${name}: 즉시 started 반환`,
      cmd.ok === true && cmd.value && cmd.value.ok === true && cmd.value.started === true,
      JSON.stringify(cmd),
    );

    const notif = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(j3)',
    );
    w.hostResult(notif.callId, { delivered: true });
    await waitFor(() => branchOf(j2.wt) === 'feature/sample-task' && !pendingHasPath(j2.wt));

    check(`${name}: 브랜치 영어로 변경`, branchOf(j2.wt) === 'feature/sample-task', `branch=${branchOf(j2.wt)}`);
    check(
      `${name}: 성공 알림`,
      notif.params && notif.params.title === '브랜치 이름을 바꿨습니다',
      JSON.stringify(notif.params),
    );
    check(`${name}: pending 제거`, !pendingHasPath(j2.wt), JSON.stringify(pendingValue()));
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 케이스 j4: readContext 가 짧은 이름이어도 동작 + 저장값이 refs/heads/ 여도 복원 정규화
// 이전 실행이 refs/heads/ 형태로 저장했을 수 있어 activate 복원 때도 정규화해야 매칭된다.
// ---------------------------------------------------------------------------
async function caseJ4() {
  const name = 'j4 짧은 readContext + refs/heads/ 저장값 복원';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    const branch = 'feature/j4-한글';
    const { addWorktree } = makeRepo('repo-j4');
    const wt = addWorktree(branch, 'wt');
    // 이전 실행이 raw refs/heads/ 형태로 저장해 둔 상황을 흉내 낸다.
    seedPending({ [wt]: `refs/heads/${branch}` });

    w = startWorker({
      ORCA_BRANCH_EN_SLUG_CMD: 'echo "sample task"',
      ORCA_BRANCH_EN_LOG: join(TMP, 'j4.log'),
    });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    w.send({ type: 'invokeCommand', callId: 414, commandId: 'rename-branch-en' });
    const rc = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(j4)',
    );
    // 짧은 이름을 돌려주는 경우도 지원해야 한다.
    w.hostResult(rc.callId, { branch, displayName: 'x', terminals: [] });
    const cmd = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 414,
      'commandResult 414',
    );
    check(
      `${name}: 즉시 started 반환`,
      cmd.ok === true && cmd.value && cmd.value.ok === true && cmd.value.started === true,
      JSON.stringify(cmd),
    );

    const notif = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(j4)',
    );
    w.hostResult(notif.callId, { delivered: true });
    await waitFor(() => branchOf(wt) === 'feature/sample-task' && !pendingHasPath(wt));

    check(`${name}: 브랜치 영어로 변경`, branchOf(wt) === 'feature/sample-task', `branch=${branchOf(wt)}`);
    check(`${name}: pending 제거`, !pendingHasPath(wt), JSON.stringify(pendingValue()));
  } catch (err) {
    fail(name, err.message);
  } finally {
    try {
      w.child.kill();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  console.log(`== Orca 플러그인 호스트 테스트 ==`);
  console.log(`plugin root: ${ROOT}`);
  console.log(`orca resources: ${ORCA_RESOURCES}`);
  console.log('');

  caseA();
  const bWorker = await caseB();
  if (bWorker) {
    try {
      bWorker.child.kill();
    } catch {
      /* ignore */
    }
  }
  await caseC();
  await caseD();
  const eInfo = await caseE();
  await caseF(eInfo);
  await caseG();
  const h1 = await caseH1();
  await caseH2(h1);
  await caseH3();
  await caseH4();
  await caseI1();
  await caseI2();
  await caseI3();
  await caseI4();
  await caseJ1();
  const j2 = await caseJ2();
  await caseJ3(j2);
  await caseJ4();

  console.log('');
  console.log(`요약: PASS=${PASS} FAIL=${FAIL} SKIP=${SKIP}`);
  if (FAIL > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('예상치 못한 오류:', err);
  process.exit(1);
});

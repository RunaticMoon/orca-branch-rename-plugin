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
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const MANIFEST_PATH = join(ROOT, 'orca-plugin.json');
const SCRIPT_PATH = join(ROOT, 'bin', 'orca-branch-en.sh');

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
  let stderr = '';
  let exited = null;
  const exitWaiters = [];

  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  child.on('message', (m) => {
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
    leftoverHostCalls: () => messages.filter((m) => m.type === 'hostCall'),
    dump,
    init() {
      child.send({
        type: 'init',
        pluginId: 'korean-branch-en',
        pluginRoot: ROOT,
        mainEntry: 'main.mjs',
        grantedCapabilities: ['events:subscribe', 'notifications:show', 'workspace:read', 'terminal:send'],
      });
    },
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
    return;
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
// 케이스 f: 수동 커맨드
// ---------------------------------------------------------------------------
async function caseF() {
  const name = 'f 수동 rename-branch-en 커맨드';
  if (!existsSync(HOST_ENTRY)) {
    skip(name, 'host entry 없음');
    return;
  }
  let w;
  try {
    w = startWorker({ ORCA_BRANCH_EN_LOG: join(TMP, 'f.log') });
    w.init();
    await w.next((m) => m.type === 'ready', 'ready');

    // f1: 터미널 있음 → terminal.sendText
    w.send({ type: 'invokeCommand', callId: 101, commandId: 'rename-branch-en' });
    const rc1 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext',
    );
    w.hostResult(rc1.callId, { branch: 'feature/한글-수동', displayName: 'x', terminals: [{ id: 't1' }] });
    const send = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'terminal.sendText',
      'terminal.sendText',
    );
    const expectedText = `/bin/bash '${SCRIPT_PATH}'`;
    check(
      `${name}: sendText text/enter/terminalId`,
      send.params &&
        send.params.text === expectedText &&
        send.params.enter === true &&
        send.params.terminalId === 't1',
      JSON.stringify(send.params),
    );
    w.hostResult(send.callId, { accepted: true });
    const cmd1 = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 101,
      'commandResult 101',
    );
    check(
      `${name}: commandResult ok + value.ok`,
      cmd1.ok === true && cmd1.value && cmd1.value.ok === true,
      JSON.stringify(cmd1),
    );

    // f2: readContext null → 알림 후 value.ok=false
    w.send({ type: 'invokeCommand', callId: 102, commandId: 'rename-branch-en' });
    const rc2 = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'workspace.readContext',
      'workspace.readContext(null)',
    );
    w.hostResult(rc2.callId, null);
    const notif = await w.next(
      (m) => m.type === 'hostCall' && m.method === 'notifications.show',
      'notifications.show(터미널없음)',
    );
    w.hostResult(notif.callId, { delivered: true });
    const cmd2 = await w.next(
      (m) => m.type === 'commandResult' && m.callId === 102,
      'commandResult 102',
    );
    check(
      `${name}: 터미널 없음 → ok + value.ok=false`,
      cmd2.ok === true && cmd2.value && cmd2.value.ok === false,
      JSON.stringify(cmd2),
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
  await caseE();
  await caseF();
  await caseG();

  console.log('');
  console.log(`요약: PASS=${PASS} FAIL=${FAIL} SKIP=${SKIP}`);
  if (FAIL > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('예상치 못한 오류:', err);
  process.exit(1);
});

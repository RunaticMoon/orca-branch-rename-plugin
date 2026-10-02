// orca-marketplace.json 검증. 외부 의존성 없이 Node 내장 모듈만 쓴다.
//
// Orca 는 marketplace 소스 저장소 루트의 orca-marketplace.json 을 읽는다.
// 이 테스트는 스키마 요점과, 이 저장소 플러그인 항목이 orca-plugin.json 과
// 버전·저장소·설명에서 일치하는지(= 버전을 올리면 태그와 ref 를 같이 바꾸는지)를 본다.
//
// 실행: node tests/test-marketplace.mjs [대상 파일]
//   대상 파일: 인자 > 환경변수 MARKETPLACE_FILE > 저장소 루트 orca-marketplace.json
//   매니페스트: 환경변수 PLUGIN_MANIFEST > 저장소 루트 orca-plugin.json

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const MARKETPLACE_PATH =
  process.argv[2] ||
  process.env.MARKETPLACE_FILE ||
  join(ROOT, 'orca-marketplace.json');
const MANIFEST_PATH = process.env.PLUGIN_MANIFEST || join(ROOT, 'orca-plugin.json');

// Orca out/shared/plugins/plugin-marketplace.js 의 상수·스키마 요점.
const PLUGIN_MARKETPLACE_ENTRY_LIMIT = 2048;
const PLUGIN_MARKETPLACE_CATEGORY_LIMIT = 16;
const MARKETPLACE_NAME_MAX = 256;
const MARKETPLACE_OWNER_MAX = 128;
const MARKETPLACE_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const CATEGORY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATEGORY_MAX = 64;
const DESCRIPTION_MAX = 4096;
const SOURCE_REF_MAX = 4096;
const SOURCE_URL_MAX = 32 * 1024;
const UNSUPPORTED_MARKETPLACE_CATEGORIES = [
  'themes',
  'icons',
  'icon-themes',
  'terminal-themes',
  'skills',
];
const OFFICIAL_PLUGIN_PUBLISHER = 'stablyai';
const OFFICIAL_PLUGIN_ID_PREFIX = 'orca-';
// plugin-id-format.js: publisher·id 조각은 kebab-case 소문자 slug, 최대 64자,
// 프로토타입 오염을 막는 예약 이름은 쓸 수 없다.
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_MAX = 64;
const FORBIDDEN_ID_NAMES = ['__proto__', 'prototype', 'constructor'];

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
function summary() {
  console.log('');
  console.log(`요약: PASS=${PASS} FAIL=${FAIL} SKIP=${SKIP}`);
}
function finish() {
  summary();
  if (FAIL > 0) process.exit(1);
  process.exit(0);
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIdName(name) {
  return (
    typeof name === 'string' &&
    name.length <= ID_MAX &&
    ID_RE.test(name) &&
    !FORBIDDEN_ID_NAMES.includes(name)
  );
}

// '<publisher>.<id>'. publisher·id 모두 점을 포함하지 않으므로 첫 점에서 가른다.
function splitQualifiedKey(key) {
  if (typeof key !== 'string') return null;
  const index = key.indexOf('.');
  if (index <= 0 || index === key.length - 1) return null;
  const publisher = key.slice(0, index);
  const id = key.slice(index + 1);
  if (!isIdName(publisher) || !isIdName(id)) return null;
  return { publisher, id };
}

function isReservedIdentity(key) {
  const identity = splitQualifiedKey(key);
  if (identity === null) return false;
  return (
    identity.publisher === OFFICIAL_PLUGIN_PUBLISHER ||
    identity.id.startsWith(OFFICIAL_PLUGIN_ID_PREFIX)
  );
}

// HTTPS 또는 SSH(scp 형식 `git@host:path`, `ssh://`) 만 허용한다.
function isAllowedGitUrl(url) {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('https://')) return true;
  if (trimmed.startsWith('ssh://')) return true;
  return /^[^\s@/:]+@[^\s:]+:.+$/.test(trimmed);
}

function stripGitSuffix(url) {
  return String(url)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

function loadJson(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`${label} 읽기`, `파일을 읽을 수 없음: ${path} (${err.code || err.message})`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${label} JSON 파싱`, `유효한 JSON 아님: ${err.message}`);
    return null;
  }
}

function checkMarketplace(mp) {
  check(
    '최상위가 객체',
    isPlainObject(mp),
    `기대: {name, owner, plugins} 객체, 실제: ${Array.isArray(mp) ? '배열' : typeof mp}`
  );
  if (!isPlainObject(mp)) return;

  const keys = Object.keys(mp).sort();
  const expectedKeys = ['name', 'owner', 'plugins'];
  check(
    '최상위 키가 정확히 name/owner/plugins',
    keys.length === expectedKeys.length && keys.every((k, i) => k === expectedKeys[i]),
    `기대: ${expectedKeys.join(', ')} (그 외 키 금지), 실제: ${keys.join(', ') || '(없음)'}`
  );

  check(
    'name 문자열 1~256자',
    typeof mp.name === 'string' && mp.name.length >= 1 && mp.name.length <= MARKETPLACE_NAME_MAX,
    `기대: 문자열 길이 1~${MARKETPLACE_NAME_MAX}, 실제: ${JSON.stringify(mp.name)}`
  );

  check(
    'owner 정규식 1~128자',
    typeof mp.owner === 'string' &&
      mp.owner.length >= 1 &&
      mp.owner.length <= MARKETPLACE_OWNER_MAX &&
      MARKETPLACE_OWNER_RE.test(mp.owner),
    `기대: /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/ 길이 1~${MARKETPLACE_OWNER_MAX}, 실제: ${JSON.stringify(mp.owner)}`
  );

  check(
    'plugins 가 배열',
    Array.isArray(mp.plugins),
    `기대: 배열, 실제: ${typeof mp.plugins}`
  );
  if (!Array.isArray(mp.plugins)) return;

  check(
    'plugins 비어 있지 않음',
    mp.plugins.length >= 1,
    `기대: 1개 이상, 실제: ${mp.plugins.length}개`
  );
  check(
    `plugins ${PLUGIN_MARKETPLACE_ENTRY_LIMIT}개 이하`,
    mp.plugins.length <= PLUGIN_MARKETPLACE_ENTRY_LIMIT,
    `기대: ≤${PLUGIN_MARKETPLACE_ENTRY_LIMIT}, 실제: ${mp.plugins.length}`
  );

  const seenIds = new Set();
  const duplicateIds = new Set();
  for (const entry of mp.plugins) {
    if (isPlainObject(entry) && typeof entry.id === 'string') {
      if (seenIds.has(entry.id)) duplicateIds.add(entry.id);
      seenIds.add(entry.id);
    }
  }
  check(
    'plugin id 중복 없음',
    duplicateIds.size === 0,
    `기대: 중복 없음, 중복: ${[...duplicateIds].join(', ') || '(없음)'}`
  );

  mp.plugins.forEach((entry, index) => {
    checkEntry(entry, index);
  });
}

function checkEntry(entry, index) {
  const at = `plugins[${index}]`;
  check(`${at} 항목이 객체`, isPlainObject(entry), `기대: 객체, 실제: ${typeof entry}`);
  if (!isPlainObject(entry)) return;

  const allowedKeys = ['id', 'source', 'description', 'categories'];
  const extra = Object.keys(entry).filter((k) => !allowedKeys.includes(k));
  check(
    `${at} 키가 id/source/description/categories 범위 안`,
    extra.length === 0,
    `기대: ${allowedKeys.join(', ')} 외 키 금지, 허용 밖 키: ${extra.join(', ') || '(없음)'}`
  );

  checkQualifiedId(`${at}.id`, entry.id);
  check(
    `${at} 예약 신원 아님`,
    !isReservedIdentity(entry.id),
    `기대: publisher !== '${OFFICIAL_PLUGIN_PUBLISHER}' 이고 id 가 '${OFFICIAL_PLUGIN_ID_PREFIX}' 로 시작하지 않음, 실제: ${JSON.stringify(entry.id)}`
  );

  checkSource(`${at}.source`, entry.source);

  if (entry.description !== undefined) {
    check(
      `${at}.description 1~${DESCRIPTION_MAX}자`,
      typeof entry.description === 'string' &&
        entry.description.length >= 1 &&
        entry.description.length <= DESCRIPTION_MAX,
      `기대: 문자열 길이 1~${DESCRIPTION_MAX}, 실제: ${JSON.stringify(entry.description)}`
    );
  }

  checkCategories(`${at}.categories`, entry.categories);
}

function checkQualifiedId(label, id) {
  const identity = splitQualifiedKey(id);
  check(
    `${label}가 <publisher>.<id> 형식`,
    identity !== null,
    `기대: /^[a-z0-9]+(?:-[a-z0-9]+)*\\.[a-z0-9]+(?:-[a-z0-9]+)*$/ (각 조각 ≤${ID_MAX}자, 예약어 금지), 실제: ${JSON.stringify(id)}`
  );
}

function checkSource(label, source) {
  check(`${label}가 객체`, isPlainObject(source), `기대: {kind, url, ref} 객체, 실제: ${typeof source}`);
  if (!isPlainObject(source)) return;

  const keys = Object.keys(source).sort();
  const expected = ['kind', 'ref', 'url'];
  check(
    `${label} 키가 정확히 kind/url/ref`,
    keys.length === expected.length && keys.every((k, i) => k === expected[i]),
    `기대: ${expected.join(', ')} (그 외 키 금지), 실제: ${keys.join(', ') || '(없음)'}`
  );

  check(
    `${label}.kind === 'git'`,
    source.kind === 'git',
    `기대: "git", 실제: ${JSON.stringify(source.kind)}`
  );

  check(
    `${label}.url HTTPS 또는 SSH`,
    typeof source.url === 'string' && isAllowedGitUrl(source.url),
    `기대: https:// 또는 ssh:// 또는 git@host:path, 실제: ${JSON.stringify(source.url)}`
  );
  check(
    `${label}.url ${SOURCE_URL_MAX}자 이하`,
    typeof source.url === 'string' && source.url.trim().length <= SOURCE_URL_MAX,
    `기대: trim 후 ≤${SOURCE_URL_MAX}자, 실제: ${typeof source.url === 'string' ? source.url.trim().length : '문자열 아님'}`
  );

  check(
    `${label}.ref 비어 있지 않음(1~${SOURCE_REF_MAX}자)`,
    typeof source.ref === 'string' &&
      source.ref.trim().length >= 1 &&
      source.ref.trim().length <= SOURCE_REF_MAX,
    `기대: trim 후 1~${SOURCE_REF_MAX}자, 실제: ${JSON.stringify(source.ref)}`
  );
}

function checkCategories(label, categories) {
  if (categories === undefined) return; // optional, 기본값 []
  check(`${label}가 배열`, Array.isArray(categories), `기대: 배열, 실제: ${typeof categories}`);
  if (!Array.isArray(categories)) return;

  check(
    `${label} ${PLUGIN_MARKETPLACE_CATEGORY_LIMIT}개 이하`,
    categories.length <= PLUGIN_MARKETPLACE_CATEGORY_LIMIT,
    `기대: ≤${PLUGIN_MARKETPLACE_CATEGORY_LIMIT}, 실제: ${categories.length}`
  );

  const badSlug = categories.filter(
    (c) => typeof c !== 'string' || c.length < 1 || c.length > CATEGORY_MAX || !CATEGORY_RE.test(c)
  );
  check(
    `${label} 각 항목이 소문자 slug(1~${CATEGORY_MAX}자)`,
    badSlug.length === 0,
    `기대: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 위반: ${JSON.stringify(badSlug)}`
  );

  const seen = new Set();
  const dup = new Set();
  for (const c of categories) {
    if (seen.has(c)) dup.add(c);
    seen.add(c);
  }
  check(
    `${label} 중복 없음`,
    dup.size === 0,
    `기대: 중복 없음, 중복: ${[...dup].join(', ') || '(없음)'}`
  );

  const unsupported = categories.filter((c) => UNSUPPORTED_MARKETPLACE_CATEGORIES.includes(c));
  check(
    `${label} 지원 안 하는 카테고리 없음`,
    unsupported.length === 0,
    `기대: ${UNSUPPORTED_MARKETPLACE_CATEGORIES.join(', ')} 없음, 발견: ${unsupported.join(', ') || '(없음)'}`
  );
}

function checkRepoEntry(mp, manifest) {
  check(
    'orca-plugin.json 최상위가 객체',
    isPlainObject(manifest),
    `기대: 매니페스트 객체, 실제: ${Array.isArray(manifest) ? '배열' : typeof manifest}`
  );
  if (!isPlainObject(mp) || !Array.isArray(mp.plugins) || !isPlainObject(manifest)) return;

  const qualified =
    typeof manifest.publisher === 'string' && typeof manifest.id === 'string'
      ? `${manifest.publisher}.${manifest.id}`
      : null;
  check(
    'orca-plugin.json publisher.id 로 qualified key 계산 가능',
    qualified !== null,
    `기대: publisher·id 문자열, 실제: publisher=${JSON.stringify(manifest.publisher)}, id=${JSON.stringify(manifest.id)}`
  );
  if (qualified === null) return;

  const matches = mp.plugins.filter((e) => isPlainObject(e) && e.id === qualified);
  check(
    `이 저장소 플러그인 항목(${qualified}) 존재`,
    matches.length === 1,
    `기대: 정확히 1개, 실제: ${matches.length}개`
  );
  if (matches.length !== 1) return;
  const entry = matches[0];

  const expectedRef = `v${manifest.version}`;
  check(
    `${qualified} source.ref === '${expectedRef}'`,
    isPlainObject(entry.source) && entry.source.ref === expectedRef,
    `기대: ${expectedRef} (manifest.version + 'v'), 실제: ${JSON.stringify(entry.source && entry.source.ref)}`
  );

  check(
    `${qualified} source.url 이 manifest.repository 와 같은 저장소`,
    isPlainObject(entry.source) &&
      typeof entry.source.url === 'string' &&
      typeof manifest.repository === 'string' &&
      stripGitSuffix(entry.source.url) === stripGitSuffix(manifest.repository),
    `기대: ${stripGitSuffix(manifest.repository)} (끝 '.git' 무시), 실제: ${isPlainObject(entry.source) ? stripGitSuffix(entry.source.url) : '(source 없음)'}`
  );

  check(
    `${qualified} description 이 manifest.description 과 일치`,
    typeof entry.description === 'string' && entry.description === manifest.description,
    `기대: ${JSON.stringify(manifest.description)}, 실제: ${JSON.stringify(entry.description)}`
  );
}

function main() {
  console.log(`# orca-marketplace.json 검증: ${MARKETPLACE_PATH}`);
  const mp = loadJson(MARKETPLACE_PATH, 'orca-marketplace.json');
  const manifest = loadJson(MANIFEST_PATH, 'orca-plugin.json');

  if (mp === null) {
    finish();
    return;
  }

  checkMarketplace(mp);
  checkRepoEntry(mp, manifest);
  finish();
}

main();

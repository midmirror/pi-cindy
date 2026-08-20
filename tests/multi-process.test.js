// tests/multi-process.test.js
// 多进程集成：spawn 多个 node 子进程，各自 open 同一 db 文件。
// 1) 双进程单持有者仲裁（A owner / B standby，B 在 A 存活期间不接管）。
// 2) 三进程会话路由握手：A 收到手机 enqueue（B 会话）→ 落邮箱 + handoffTo(B)
//    → B fast-poll 独占认领 → B 消费邮箱重放 → B fakePi 注入；C 全程不抢。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cindy-multi-'));

const workerSrc = `
const { createJiti } = require(${JSON.stringify(require.resolve('jiti'))});
process.env.PI_CINDY_DATA_DIR = ${JSON.stringify(DATA_DIR)};
// jiti v2 要求绝对路径入口：node -e 上下文里 __filename 是 '[eval]'（非绝对路径），
// 会抛 ERR_INVALID_ARG_VALUE。这里指向测试文件自身（真实绝对路径，仅作解析基准）。
const JITI_ENTRY = ${JSON.stringify(path.join(__dirname, 'multi-process.test.js'))};
const jiti = createJiti(JITI_ENTRY, { interopDefault: true });
const { getDb } = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'store', 'db.ts'))});
const { DeviceLinkOwnershipArbiter, createSqliteOwnershipStore } = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'ownership.ts'))});
const inst = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'instance.ts'))});
const handoff = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'handoff.ts'))});
const router = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'handlers', 'router.ts'))});
const store = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'store', 'session-store.ts'))});
const injected = [];
const fakePi = { sendUserMessage: (t) => { injected.push(t); console.log(process.argv[1] + ' INJECTED ' + t); } };
inst.registerInstance();
let activeId = null;
const arb = new DeviceLinkOwnershipArbiter({
  getStore: () => createSqliteOwnershipStore(getDb()),
  instance: { ownerPid: process.pid, ownerLabel: process.argv[1] },
  instanceId: inst.getInstanceId(),
  onAcquire: () => {
    console.log(process.argv[1] + ' ACQUIRED');
    handoff.consumeMailboxForSession(activeId || '').catch(() => {});
  },
  onDemote: () => { console.log(process.argv[1] + ' DEMOTED'); },
  heartbeatMs: 30, staleMs: 400, fastPollMs: 20, storeRetryMs: 10, opTimeoutMs: 30,
});
router.setInvokeContext({
  pi: fakePi, push: () => {}, activeSessions: new Map(),
  activeId: () => activeId,
  handoffTo: (i) => arb.handoffTo(i),
  handoffPending: () => arb.isAwaitingHandoff(),
});
// 会话归属：argv[3] = 本 worker 的会话 id（B 有会话；A/C 无）
const mySid = process.argv[3];
if (mySid) store.createSession({ id: mySid, hostInstanceId: inst.getInstanceId() });
activeId = mySid || null;
arb.start();
// 就绪信号：jiti 编译 + registerInstance + createSession + arbiter 启动完成
// （慢环境/CI 高负载下 B 可能晚于 invoke 就绪，测试必须先等 READY 再发路由）
console.log(process.argv[1] + ' READY');
process.stdin.on('data', (buf) => {
  const line = buf.toString().trim();
  if (line.startsWith('invoke ')) {
    const rest = line.slice('invoke '.length);
    const sp = rest.indexOf(' ');
    const sid = sp < 0 ? rest : rest.slice(0, sp);
    const text = sp < 0 ? '' : rest.slice(sp + 1);
    const cid = 'cid-' + Date.now();
    // 走真实 router（M6）：host 查找 → 邮箱落行 → 定向接管，A（owner）收 B 会话 enqueue 的完整路由语义
    router.routeInvoke('maker:input:enqueue', [sid, { clientId: cid, text, chatMessage: { clientId: cid, role: 'user', content: text } }])
      .then((r) => console.log(process.argv[1] + ' ROUTE-OK ' + JSON.stringify(r).slice(0, 60)))
      .catch((e) => console.log(process.argv[1] + ' ROUTE-ERR ' + (e.code || 'ERR')));
  }
  if (line === 'shutdown') { arb.stop().then(() => process.exit(0)); }
});
const DURATION = Number(process.argv[2] || 1000);
if (DURATION > 0) {
  setTimeout(() => { console.log(process.argv[1] + ' STOP'); arb.stop().then(() => process.exit(0)); }, DURATION);
}
`;

function runWorker(label, duration) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', workerSrc, label, String(duration)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', () => resolve(out));
  });
}

(async () => {
  let failures = 0;
  const assert = (cond, name, extra) => { if (cond) { console.log('  ok:', name); } else { failures++; console.error('  FAIL:', name, extra ?? ''); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 场景 1：双进程单持有者仲裁（回归）----
  // A 先起（应 owner），B 后起（应 standby）。时长错开：A 活 1500ms，B 活 1000ms →
  // B 在 A 释放前先退出，全程 A 心跳新鲜，B 不接管。
  const pA = spawn(process.execPath, ['-e', workerSrc, 'A', '1500'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let outA = '';
  pA.stdout.on('data', (d) => { outA += d.toString(); });
  await sleep(150); // A 已认领
  const outB = await runWorker('B', 1000);
  const linesB = outB.split('\n').filter(Boolean);
  assert(outA.includes('A ACQUIRED'), '场景1：A 应 acquire');
  assert(!outB.includes('B ACQUIRED'), '场景1：B 应 standby（不 acquire）');
  assert(linesB.some((l) => l.includes('B STOP')), '场景1：B 应正常退出');
  console.log('A:', outA.trim());
  console.log('B:', outB.trim());
  try { pA.kill(); } catch { /* 进程可能已退出 */ }

  // ---- 场景 2：三进程会话路由握手：A 让位 → B 认领 → B 消费邮箱注入；C 不抢 ----
  const spawnW = (label, sid, dur) => {
    const p = spawn(process.execPath, ['-e', workerSrc, label, String(dur), sid || ''], { stdio: ['pipe', 'pipe', 'inherit'] });
    p._out = '';
    p.stdout.on('data', (d) => { p._out += d.toString(); });
    return p;
  };
  const waitOut = (p, needle, ms) => new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => { if (p._out.includes(needle) || Date.now() - t0 > ms) { clearInterval(iv); resolve({ out: p._out, ms: Date.now() - t0 }); } }, 20);
  });
  const pA2 = spawnW('A2', '', 4000);
  await waitOut(pA2, 'A2 ACQUIRED', 1000);
  const pC = spawnW('C', '', 2000);
  // B 存活 4000ms（原 2000ms）：保证接管窗口内 B 不因超时先退出；
  // waitOut READY 替代 sleep(150)——B 经 jiti 编译 TS + createSession + registerInstance
  // 可能晚于 invoke 就绪（CI 高负载稳定复现 ROUTE-ERR NOT_FOUND）。
  const pB = spawnW('B', 'sess-b', 4000);
  await waitOut(pB, 'B READY', 5000);
  pA2.stdin.write('invoke sess-b hello-from-mobile\n');
  const bRes = await waitOut(pB, 'INJECTED', 5000);
  const bOut = bRes.out;
  const aOut = pA2._out;
  const cOut = pC._out;
  const okB = /B ACQUIRED/.test(bOut) && /B INJECTED hello-from-mobile/.test(bOut);
  // 精确断言（M6）：A 必须真实让位（router 经 ctx.handoffTo 触发 DEMOTED），且无路由错误；
  // HANDOFF-ISSUED-SKIPPED（CAS 失败）不再算通过。
  const okA = /A2 DEMOTED/.test(aOut) && !/A2 ROUTE-ERR/.test(aOut);
  const okC = !/C ACQUIRED/.test(cOut);
  assert(okB, '场景2：B 认领 + 消费邮箱注入', JSON.stringify({ bOut }));
  assert(okA, '场景2：A 真实让位（DEMOTED，无 ROUTE-ERR）', JSON.stringify({ aOut }));
  assert(okC, '场景2：C 全程不抢', JSON.stringify({ cOut }));
  // 接管延迟绑定（M6）：fastPoll=20ms，目标 ≤2s 远低于 v0.4 优雅接管 4.4s（回归护栏）
  assert(bRes.ms < 2000, '场景2：接管+消费注入 ≤2s（目标 ~1s）', bRes.ms + 'ms');
  [pA2, pB, pC].forEach((p) => { try { p.stdin.write('shutdown\n'); } catch { /* 可能已退出 */ } });
  await sleep(200);
  [pA2, pB, pC].forEach((p) => { try { p.kill(); } catch { /* 可能已退出 */ } });

  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });

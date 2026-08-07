// tests/ownership.test.js
// 仲裁测试：SQLite 单行表 CAS 语义 + 单持有者/接管/让位（copy desktop ownership.test.ts 语义适配 node:sqlite）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJiti } = require('jiti');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cindy-owner-'));
process.env.PI_CINDY_DATA_DIR = DATA_DIR;
const jiti = createJiti(__filename, { interopDefault: true });
const dbMod = jiti(path.join(__dirname, '..', 'src', 'store', 'db.ts'));
const ownerMod = jiti(path.join(__dirname, '..', 'src', 'ownership.ts'));
const { createSqliteOwnershipStore, DeviceLinkOwnershipArbiter } = ownerMod;

let failures = 0;
function assert(cond, name, extra) { if (cond) { console.log('  ok:', name); } else { failures++; console.error('  FAIL:', name, extra ?? ''); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // store CAS 语义（同 desktop createDbClientOwnershipStore 测试）
  const db = dbMod.getDb();
  const store = createSqliteOwnershipStore(db);
  const id1 = { ownerId: 'o-1', ownerPid: 111, ownerLabel: 'a' };
  const id2 = { ownerId: 'o-2', ownerPid: 222, ownerLabel: 'b' };
  assert((await store.read()) === null, '空表 read → null');
  assert(await store.tryInsert(id1, 1000), 'tryInsert 首次成功');
  assert(!(await store.tryInsert(id2, 2000)), 'tryInsert 二次失败（单行）');
  assert((await store.read())?.ownerId === 'o-1', 'read 返回 o-1');
  assert(await store.renew('o-1', 3000), 'renew 属主成功');
  assert(!(await store.renew('o-2', 3000)), 'renew 非属主失败');
  // CAS 接管：heartbeat 必须匹配
  const row = await store.read();
  assert(!(await store.tryTakeover({ ownerId: 'o-1', heartbeatAt: 9999 }, id2, 4000)), 'takeover heartbeat 不匹配失败');
  assert(await store.tryTakeover({ ownerId: 'o-1', heartbeatAt: row.heartbeatAt }, id2, 4000), 'takeover CAS 成功');
  assert((await store.read())?.ownerId === 'o-2', '接管后 o-2 持有');
  await store.release('o-2');
  assert((await store.read()) === null, 'release 清空');

  // 仲裁器：first-wins 单持有者
  const eventsA = [], eventsB = [];
  const arbA = new DeviceLinkOwnershipArbiter({
    getStore: () => createSqliteOwnershipStore(dbMod.getDb()),
    instance: { ownerPid: 111, ownerLabel: 'a' },
    onAcquire: () => eventsA.push('acquire'),
    onDemote: () => eventsA.push('demote'),
    heartbeatMs: 20, staleMs: 100, fastPollMs: 20, storeRetryMs: 5, opTimeoutMs: 20,
  });
  const arbB = new DeviceLinkOwnershipArbiter({
    getStore: () => createSqliteOwnershipStore(dbMod.getDb()),
    instance: { ownerPid: 222, ownerLabel: 'b' },
    onAcquire: () => eventsB.push('acquire'),
    onDemote: () => eventsB.push('demote'),
    heartbeatMs: 20, staleMs: 100, fastPollMs: 20, storeRetryMs: 5, opTimeoutMs: 20,
  });
  arbA.start();
  arbB.start();
  await sleep(120);
  const ownerIsA = eventsA.filter(e => e === 'acquire').length === 1 && eventsB.filter(e => e === 'acquire').length === 0;
  assert(ownerIsA, 'first-wins：A 持有、B 待命');
  assert(arbA.isOwner() && !arbB.isOwner(), 'isOwner 状态正确');
  assert(arbB.isStandby(), 'B 待命态');

  // 持有者停止 → B 接管
  await arbA.stop();
  await sleep(150);
  assert(eventsB.filter(e => e === 'acquire').length >= 1, 'A 退出后 B 接管');

  // stale 接管：B 崩溃（不再续期、行保留）→ C 按过期心跳 CAS 接管
  // desktop 语义 = 持有者停 tick 不释放行，staleMs 后被动方接管。这里把行改写为
  // 「失效持有者 + 过期心跳」：B 的 renew 因 owner 不匹配 CAS 失败并让位（superseded），
  // C 走 tryTakeover 过期接管路径（真实 stale 场景，非 release 场景）。
  dbMod.getDb()
    .prepare("UPDATE device_link_ownership SET owner_id = 'crashed-b', heartbeat_at = ? WHERE id = 1")
    .run(Date.now() - 500);
  const eventsC = [];
  const arbC = new DeviceLinkOwnershipArbiter({
    getStore: () => createSqliteOwnershipStore(dbMod.getDb()),
    instance: { ownerPid: 333, ownerLabel: 'c' },
    onAcquire: () => eventsC.push('acquire'),
    heartbeatMs: 20, staleMs: 100, fastPollMs: 20, storeRetryMs: 5, opTimeoutMs: 20,
  });
  arbC.start();
  await sleep(250);
  assert(eventsC.filter(e => e === 'acquire').length >= 1, 'B 崩溃后 C 在 staleMs 窗口接管');
  assert(arbC.isOwner(), 'C 成为持有者');

  await Promise.all([arbB.stop(), arbC.stop()]);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });

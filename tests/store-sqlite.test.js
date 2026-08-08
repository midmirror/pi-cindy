// tests/store-sqlite.test.js
// SQLite store 行为测试：覆盖 session-store 全部导出，与 JSON 版语义一致。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJiti } = require('jiti');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cindy-sqlite-'));
process.env.PI_CINDY_DATA_DIR = DATA_DIR;
const jiti = createJiti(__filename, { interopDefault: true });
const store = jiti(path.join(__dirname, '..', 'src', 'store', 'session-store.ts'));

let failures = 0;
function assert(cond, name, extra) {
  if (cond) { console.log('  ok:', name); }
  else { failures++; console.error('  FAIL:', name, extra ?? ''); }
}

(async () => {
  // create/get/update/list
  const s = store.createSession({ model: 'deepseek-v4-flash', workingDir: '/tmp/proj' });
  assert(s.id && s.status === 'active' && s.model === 'deepseek-v4-flash', 'createSession 形状');
  assert(store.getSession(s.id)?.title === s.title, 'getSession 命中');
  assert(store.getSession('no-such') === null, 'getSession miss → null');
  const upd = store.updateSession(s.id, { status: 'archived', totalTokenUsage: 42 });
  assert(upd?.status === 'archived' && upd?.totalTokenUsage === 42, 'updateSession 生效');
  assert(store.listSessions({ status: 'archived' }).length === 1, 'listSessions 按 status 过滤');
  assert(store.listSessions({ status: 'active' }).length === 0, 'listSessions active 为空');
  assert(store.listSessions().length === 1, 'listSessions 默认排除 deleted');

  // patchSessionMeta 白名单
  const pm = store.patchSessionMeta(s.id, { title: 'New Title', pinnedAt: '2026-08-06T00:00:00.000Z' });
  assert(pm?.title === 'New Title' && pm?.pinnedAt !== null, 'patchSessionMeta title/pinnedAt');
  let rejected = false;
  try { store.patchSessionMeta(s.id, { model: 'x' }); } catch (e) { rejected = e.code === 'INVALID_PARAMS'; }
  assert(rejected, 'patchSessionMeta 白名单拒绝 model');
  try { store.patchSessionMeta(s.id, { status: 'bogus' }); } catch (e) { rejected = e.code === 'INVALID_PARAMS'; }
  assert(rejected, 'patchSessionMeta 拒绝非法 status');

  // findSessionBySdkId
  const s2 = store.createSession({ sdkSessionId: 'sdk-abc' });
  assert(store.findSessionBySdkId('sdk-abc')?.id === s2.id, 'findSessionBySdkId 命中');
  assert(store.findSessionBySdkId('nope') === null, 'findSessionBySdkId miss');

  // messages: append/list/delete/deleteByClientId/count
  store.appendMessage({ id: 'm-1', sessionId: s.id, role: 'user', content: 'hi', clientId: 'c-1', createdAt: 1000 });
  store.appendMessage({ id: 'm-2', sessionId: s.id, role: 'assistant', content: 'yo', createdAt: 2000, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 6 }, stopReason: 'end_turn' });
  assert(store.getMessageCount(s.id) === 2, 'getMessageCount');
  const asc = store.listMessages(s.id);
  assert(asc.length === 2 && asc[0].id === 'm-1' && asc[1].content === 'yo', 'listMessages 升序 + usage 还原');
  assert(asc[1].usage?.totalTokens === 6 && asc[1].stopReason === 'end_turn', 'usage/stopReason 经 agentMeta 还原');
  assert(store.listMessages(s.id, { after: 1000 }).length === 1, 'listMessages after 游标');
  assert(store.listMessages(s.id, { before: 2000 }).length === 1, 'listMessages before 游标');
  assert(store.listMessages(s.id, { limit: 1 }).length === 1, 'listMessages limit');
  assert(store.deleteMessage(s.id, 'm-1') === true, 'deleteMessage');
  assert(store.deleteMessage(s.id, 'm-1') === false, 'deleteMessage 幂等 miss');
  store.appendMessage({ id: 'm-3', sessionId: s.id, role: 'user', content: 'bye', clientId: 'c-3', createdAt: 3000 });
  assert(store.deleteMessageByClientId(s.id, 'c-3') === true, 'deleteMessageByClientId');
  assert(store.deleteMessageByClientId(s.id, 'c-3') === false, 'deleteMessageByClientId miss');

  // getInterruptedSessions（activeTurnStartedAt > lastTurnEndedAt 判定）
  const s3 = store.createSession({});
  store.updateSession(s3.id, { activeTurnStartedAt: 5000 });
  assert(store.getInterruptedSessions().map(x => x.id).includes(s3.id), 'getInterruptedSessions 命中 startedAt>endedAt');
  store.updateSession(s3.id, { lastTurnEndedAt: 6000 });
  assert(!store.getInterruptedSessions().map(x => x.id).includes(s3.id), 'getInterruptedSessions 收尾后熄灭');

  // deleteSession 级联删消息
  const s4 = store.createSession({});
  store.appendMessage({ id: 'mx', sessionId: s4.id, role: 'user', content: 'x', createdAt: 1 });
  store.deleteSession(s4.id);
  assert(store.getSession(s4.id) === null && store.getMessageCount(s4.id) === 0, 'deleteSession 级联');

  // loadOrCreateDeviceId 稳定
  const d1 = store.loadOrCreateDeviceId();
  const d2 = store.loadOrCreateDeviceId();
  assert(d1 === d2 && d1.length > 10, 'loadOrCreateDeviceId 幂等');

  // requireSafeSid 路径穿越防护（非法 sid 拒绝，不碰文件系统）
  let traversal = false;
  try { store.appendMessage({ id: 'z', sessionId: '../../etc/passwd', role: 'user', content: 'x', createdAt: 1 }); } catch (e) { traversal = e.code === 'INVALID_PARAMS'; }
  assert(traversal, '非法 sessionId 拒绝（INVALID_PARAMS）');

  // db 权限收敛：含全量会话/消息内容，必须 0600（win32 无 POSIX mode 位，跳过）
  if (process.platform !== 'win32') {
    const st = fs.statSync(path.join(DATA_DIR, 'pi-cindy.db'));
    assert((st.mode & 0o777) === 0o600, `db 权限 0600（实际 ${(st.mode & 0o777).toString(8)}）`);
  }

  // 损坏恢复：页面级损坏（header 完好）→ open 期 quick_check 检测 + 隔离重建
  const { getDb, closeDb } = jiti(path.join(__dirname, '..', 'src', 'store', 'db.ts'));
  store.createSession({ id: 'corrupt-probe-1', title: 'probe' });
  closeDb();
  const dbFile = path.join(DATA_DIR, 'pi-cindy.db');
  const buf = Buffer.from(fs.readFileSync(dbFile));
  for (let i = 4096; i < Math.min(buf.length, 8192); i++) buf[i] = ~buf[i] & 0xff; // 翻转数据页
  fs.writeFileSync(dbFile, buf);
  const reopenedDb = getDb(); // 应隔离重建，不抛错
  const cnt = reopenedDb.prepare('SELECT COUNT(*) AS c FROM sessions').get();
  assert(Number(cnt.c) === 0, '页面级损坏 → quick_check 隔离重建（旧数据不残留）');
  assert(fs.readdirSync(DATA_DIR).some((f) => f.includes('.corrupt-')), '损坏库已隔离保留 .corrupt-*');
  closeDb();

  console.log(failures === 0 ? `\nALL PASS (${new Date().toLocaleTimeString()})` : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });

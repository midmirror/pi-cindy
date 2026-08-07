const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJiti } = require('jiti');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cindy-migrate-'));
process.env.PI_CINDY_DATA_DIR = DATA_DIR;
const jiti = createJiti(__filename, { interopDefault: true });
const migration = jiti(path.join(__dirname, '..', 'src', 'store', 'migration.ts'));
const store = jiti(path.join(__dirname, '..', 'src', 'store', 'session-store.ts'));

let failures = 0;
function assert(cond, name, extra) { if (cond) { console.log('  ok:', name); } else { failures++; console.error('  FAIL:', name, extra ?? ''); } }

(async () => {
  // 无旧 JSON → 不迁移
  const did = migration.runMigrationIfNeeded();
  assert(did === false, '无旧数据不迁移');

  // 制造旧 JSON 数据（模拟 JSON 版 store 产物）
  fs.mkdirSync(path.join(DATA_DIR, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), JSON.stringify({
    sessions: {
      'sess-old-1': {
        id: 'sess-old-1', title: 'Old Session', workingDir: '/tmp/old', workspaceKind: 'project',
        model: 'deepseek-v4-flash', effort: 'high', permissionMode: 'ask', status: 'active',
        sdkSessionId: 'sdk-old', totalTokenUsage: 10, totalCostUsd: 0.1, totalCostAmount: 0.7,
        totalCostCurrency: 'CNY', totalCostIsApproximate: false, contextTokens: 100, contextWindow: 200000,
        fastMode: false, planModeEnabled: false, clearedAt: null, pinnedAt: null, summary: null,
        providerId: 'deepseek', agentKind: 'pi', userSendAt: null, createdAt: 1000, updatedAt: 2000,
        activeTurnStartedAt: null, lastTurnEndedAt: null,
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'messages', 'sess-old-1.json'), JSON.stringify([
    { id: 'om-1', sessionId: 'sess-old-1', role: 'user', content: 'hello old', createdAt: 1000 },
    { id: 'om-2', sessionId: 'sess-old-1', role: 'assistant', content: 'hi', model: 'deepseek-v4-flash', createdAt: 2000 },
  ]));

  // 新 db 为空 → 迁移执行
  const did2 = migration.runMigrationIfNeeded();
  assert(did2 === true, '旧数据触发迁移');
  const sess = store.getSession('sess-old-1');
  assert(sess?.title === 'Old Session' && sess?.totalCostCurrency === 'CNY', '会话迁移字段');
  assert(store.getMessageCount('sess-old-1') === 2, '消息迁移数量');
  const msgs = store.listMessages('sess-old-1');
  assert(msgs[0].content === 'hello old' && msgs[1].model === 'deepseek-v4-flash', '消息迁移内容+model');
  assert(fs.existsSync(path.join(DATA_DIR, 'sessions.json')), '旧 JSON 保留');
  assert(fs.existsSync(path.join(DATA_DIR, 'migration_done')), 'migration_done 标记写入');

  // 幂等：再跑不重复
  const did3 = migration.runMigrationIfNeeded();
  assert(did3 === false, '二次运行 no-op（标记存在）');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });

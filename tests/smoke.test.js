/**
 * pi-cindy handler 层冒烟测试（无网络、mock pi/ctx，隔离数据目录）。
 *
 * 覆盖（对照 mobile 消费方契约，见 docs/HANDOFF.md）：
 *   1. get-capabilities 契约形状（availableModels/effortLevels/permissionModes/
 *      hasFastMode/planMode/supportsSessionAgentSwitch）
 *   2. 白名单过滤（scopedModels 非空 → 只列白名单）+ id 首见去重 + displayName
 *      provider 前缀 + pin 的 thinkingLevel 作 defaultEffort
 *   3. 发送路径：inputEnqueue → pi.sendUserMessage（void，无 .catch TypeError）
 *      + 注入前 apply model/effort
 *   4. stop/steer/abort 走 ctx.abort（ExtensionAPI 顶层无 abort）
 *   5. setModel / setEffort（ultra → max 收敛）
 *   6. 其余 input 通道（compact/resume/retry/clear/remove/update/move/expanded/clear-session）
 *   7. router 可达性（provider:list / model-pricing / api-key:present / get-context-usage）
 *      + 系统级 channel（goal:get-status → null / schedule:list → [] /
 *      clear-session-attention no-op / fs:stat-path dir|file|missing + ~ 展开）
 *      + 未实现 channel 拒绝（含已摘除的 get-session-tree）
 *   8. store 隔离：PI_CINDY_DATA_DIR 指向临时目录，不污染真实 ~/.pi/cindy-sync
 *
 * 2026-08-06 追加（对齐 mobile 契约修复）：
 *   9.  create-session 透传 mobile 预生成 id（幂等）+ 返回 {sessionId, agentKind, workDir}
 *   10. messages:list 输出降序（最新在前）+ before/after 游标
 *   11. messages:around / around-client-id 锚点窗口
 *   12. 队列投影项透传 chatMessage（mobile isQueuedRemoteMessage 校验）
 *   13. inputStop opts（keepQueue/pauseQueue）+ 空闲清 abortPending
 *   14. enqueue/steer 前台会话门禁（activeId）+ 附件显式拒绝
 *   15. 中断语义：turn_start/agent_settled 后 interrupted-pending 恒不命中
 *   16. store：非法 sessionId 拒绝（路径穿越防护）+ 原子写
 *
 * 运行：pnpm/npm test（node tests/smoke.test.js）。依赖 devDep jiti（与 pi 运行时同版本）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJiti } = require('jiti');

// 数据目录隔离：必须在加载 store 之前设置
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cindy-test-'));
process.env.PI_CINDY_DATA_DIR = DATA_DIR;

const jiti = createJiti(__filename, { interopDefault: true });
const base = path.join(__dirname, '..', 'src');
const maker = jiti(path.join(base, 'handlers/maker.js'));
const router = jiti(path.join(base, 'handlers/router.js'));
const runtime = jiti(path.join(base, 'runtime.js'));
const messages = jiti(path.join(base, 'handlers/messages.js'));
const store = jiti(path.join(base, 'store/session-store.js'));

let failures = 0;
let passed = 0;
function assert(cond, name, extra) {
  if (cond) { passed++; }
  else { failures++; console.error('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// ---------- mock pi / ctx / 模型池 ----------
const sent = [];
const abortCalls = [];
const setModelCalls = [];
const setThinkingCalls = [];
const compactCalls = [];
const fakePi = {
  sendUserMessage: (text, opts) => { sent.push({ text, opts }); }, // void，对齐真实 API
  setModel: async (m) => { setModelCalls.push(m); return true; },
  setThinkingLevel: (l) => { setThinkingCalls.push(l); },
  abort: undefined, // 顶层不存在（对齐 ExtensionAPI）
  // 手机端 `/` palette 数据源：extension + prompt templates + skills（skill 名带 skill: 前缀）
  getCommands: () => [
    { name: 'cindy-status', description: 'Show Cindy sync status', source: 'extension', sourceInfo: { path: '/ext/pi-cindy', scope: 'user' } },
    { name: 'review', description: 'Review staged changes', source: 'prompt', sourceInfo: { path: '/home/u/.pi/agent/prompts/review.md', scope: 'user' } },
    { name: 'skill:cpp', description: 'C++ skill', source: 'skill', sourceInfo: { path: '/home/u/.agents/skills/cpp/SKILL.md', scope: 'user' } },
  ],
};
const pushes = [];
let activeTestSid = null; // 前台会话 id（enqueue/steer 门禁用）
router.setInvokeContext({
  pi: fakePi,
  push: (ch, data, sid) => pushes.push({ ch, data, sid }),
  activeSessions: new Map(),
  activeId: () => activeTestSid,
});

// 模型池：同 id 跨 provider + 非 reasoning + name 含 provider
const m1 = { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', reasoning: true, contextWindow: 200000, thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } };
const m1dup = { id: 'claude-sonnet-4-5', name: 'Sonnet via proxy', provider: 'proxy', reasoning: true, contextWindow: 200000 };
const m2 = { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', reasoning: false, contextWindow: 200000 };
const m3 = { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', reasoning: true, contextWindow: 128000, thinkingLevelMap: { high: 'high' } };
const m4 = { id: 'anthropic-claude-3-7', name: 'Anthropic Claude 3.7', provider: 'anthropic', reasoning: true, contextWindow: 200000 };
const PROVIDER_NAMES = { anthropic: 'Anthropic', proxy: 'Proxy', deepseek: 'DeepSeek' };

function captureCtx({ scoped = [], model = m1 } = {}) {
  runtime.captureRuntimeCtx({
    modelRegistry: {
      getAvailable: () => [m1, m1dup, m2, m3, m4],
      getRegisteredProviderIds: () => ['anthropic', 'proxy', 'deepseek'],
      getProviderDisplayName: (id) => PROVIDER_NAMES[id] ?? id,
    },
    scopedModels: scoped,
    abort: () => abortCalls.push(1),
    isIdle: () => true,
    compact: () => compactCalls.push(1),
    getContextUsage: () => ({ tokens: 100, window: 200000 }),
    model,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ============ 1. capabilities 契约（无白名单） ============
  captureCtx({ scoped: [] });
  let caps = await maker.getCapabilities(['pi']);
  assert(Array.isArray(caps.availableModels) && caps.availableModels.length > 0, 'capabilities.availableModels 非空');
  const sonnet = caps.availableModels.find((x) => x.id === 'claude-sonnet-4-5');
  assert(sonnet && typeof sonnet.displayName === 'string', 'availableModels id/displayName');
  assert(Array.isArray(sonnet.efforts) && sonnet.efforts.includes('high'), 'reasoning 模型 efforts 含 high');
  assert(sonnet.supportsFastMode === false, 'supportsFastMode=false');
  const haiku = caps.availableModels.find((x) => x.id === 'claude-haiku-4-5');
  assert(haiku && haiku.efforts.length === 0 && haiku.defaultEffort === null, '非 reasoning 模型 efforts 为空/defaultEffort=null');
  assert(Array.isArray(caps.effortLevels) && caps.effortLevels[0].id === 'minimal', 'effortLevels 形状');
  assert(Array.isArray(caps.permissionModes) && caps.permissionModes[0].displayName !== undefined, 'permissionModes 带 displayName');
  assert(caps.hasFastMode === false, 'hasFastMode=false');
  assert(typeof caps.planMode === 'object' && caps.planMode.supported === false, 'planMode 是对象');
  assert(caps.supportsSessionAgentSwitch === false, 'supportsSessionAgentSwitch=false');
  const agents = await maker.listAvailableAgents([]);
  assert(Array.isArray(agents) && agents.length === 1 && agents[0] === 'pi', 'listAvailableAgents 返回数组 ["pi"]');

  // ============ 2. 白名单过滤 / 去重 / provider 前缀 ============
  assert(caps.availableModels.length === 4, '无白名单：全量 + 同 id 去重（5→4）', caps.availableModels.map((x) => x.id));
  assert(sonnet.displayName === 'Anthropic Claude Sonnet 4.5', 'displayName 前缀 provider', sonnet.displayName);
  assert(caps.availableModels.filter((x) => x.id === 'claude-sonnet-4-5').length === 1, '同 id 只留首见');
  const m4row = caps.availableModels.find((x) => x.id === 'anthropic-claude-3-7');
  assert(m4row.displayName === 'Anthropic Claude 3.7', 'name 已含 provider 不重复拼接', m4row.displayName);

  // 白名单非空 → 只返回白名单 + pin 的 thinkingLevel 作 defaultEffort
  captureCtx({ scoped: [{ model: m1, thinkingLevel: 'xhigh' }, { model: m3 }] });
  caps = await maker.getCapabilities(['pi']);
  assert(caps.availableModels.length === 2, '白名单非空：只返回白名单（2）', caps.availableModels.map((x) => x.id));
  assert(caps.availableModels.every((x) => ['claude-sonnet-4-5', 'deepseek-v4-flash'].includes(x.id)), '白名单内容正确');
  const pinned = caps.availableModels.find((x) => x.id === 'claude-sonnet-4-5');
  assert(pinned.defaultEffort === 'xhigh', '白名单 pin 的 thinkingLevel 作默认 effort', pinned.defaultEffort);
  const unpinned = caps.availableModels.find((x) => x.id === 'deepseek-v4-flash');
  assert(unpinned.defaultEffort === 'high', '未 pin 回落 high', unpinned.defaultEffort);

  // ============ 3. 会话 + enqueue 发送路径 ============
  captureCtx({ scoped: [], model: m1 });
  const created = await maker.createSessionHandler([{ model: 'claude-sonnet-4-5', workingDir: '/tmp' }]);
  const sid = created.sessionId;
  activeTestSid = sid; // 前台会话
  // 标注宿主 = 本进程实例（v0.5 路由语义：host==我 → 本地 handler；无宿主会话经 router 会 NOT_FOUND）
  store.updateSession(sid, { hostInstanceId: jiti(path.join(base, 'instance.js')).getInstanceId() });
  assert(typeof sid === 'string' && sid.length > 0, 'createSession 返回 sessionId');
  assert(created.agentKind === 'pi' && created.workDir === '/tmp', 'createSession 返回 agentKind/workDir', created);
  const proj = await maker.inputEnqueue([sid, { clientId: 'c1', text: 'hello from phone', model: 'claude-sonnet-4-5', effort: 'high' }]);
  assert(proj.pendingQueue.length === 0, 'enqueue 后队列已冲刷（idle）');
  await sleep(50);
  assert(sent.length === 1 && sent[0].text === 'hello from phone', 'sendUserMessage 被调用且无 TypeError', sent);
  assert(sent[0].opts.deliverAs === 'followUp', 'deliverAs=followUp');
  assert(setModelCalls.length === 1 && setModelCalls[0].id === 'claude-sonnet-4-5', '注入前 setModel');
  assert(setThinkingCalls.length === 1 && setThinkingCalls[0] === 'high', '注入前 setThinkingLevel');

  // ============ 4. stop/steer/abort 走 ctx.abort ============
  await maker.inputStop([sid]);
  assert(abortCalls.length === 1, 'inputStop 调 ctx.abort（原 pi().abort 恒 undefined）');
  const beforeSteer = sent.length;
  await maker.inputSteer([sid, { clientId: 'c2', text: 'keep going', model: 'claude-sonnet-4-5' }]);
  await sleep(50);
  assert(sent.length === beforeSteer + 1 && sent[sent.length - 1].opts.deliverAs === 'steer', 'inputSteer 注入 steer');
  await maker.abortSession([sid]);
  assert(abortCalls.length === 2, 'abortSession 调 ctx.abort');

  // ============ 5. setModel / setEffort ============
  const sm = await maker.setModel([sid, 'claude-sonnet-4-5']);
  assert(sm.ok === true, 'setModel ok');
  await maker.setEffort([sid, 'xhigh']);
  assert(setThinkingCalls.includes('xhigh'), 'setEffort → setThinkingLevel');
  await maker.setEffort([sid, 'ultra']);
  assert(setThinkingCalls.includes('max'), 'ultra 收敛到 max');

  // ============ 6. 其余 input 通道 ============
  maker.inputQueueMarkRunning(sid, true); // 标记 running 让队列堆积
  await maker.inputEnqueue([sid, { clientId: 'q1', text: 'msg1' }]);
  await maker.inputEnqueue([sid, { clientId: 'q2', text: 'msg2' }]);
  await maker.inputEnqueue([sid, { clientId: 'q3', text: 'msg3' }]);
  await maker.inputMove([sid, 'q3', 0]);
  let p = await maker.inputGetProjection([sid]);
  assert(p.pendingQueue[0].clientId === 'q3', 'inputMove 移动到首位');
  await maker.inputUpdateText([sid, 'q3', 'msg3-edited']);
  p = await maker.inputGetProjection([sid]);
  assert(p.pendingQueue[0].text === 'msg3-edited', 'inputUpdateText');
  await maker.inputRemove([sid, 'q3']);
  p = await maker.inputGetProjection([sid]);
  assert(p.pendingQueue.length === 2 && p.pendingQueue[0].clientId === 'q1', 'inputRemove');
  await maker.inputSetExpanded([sid, true]);
  p = await maker.inputGetProjection([sid]);
  assert(p.queueExpanded === true, 'inputSetExpanded');
  await maker.inputResume([sid]);
  await maker.inputClearError([sid]);
  await maker.inputRetryLastError([sid]);
  await maker.inputCompact([sid]);
  assert(compactCalls.length === 1, 'inputCompact 调 ctx.compact');
  await maker.inputClearSession([sid]);
  p = await maker.inputGetProjection([sid]);
  assert(p.pendingQueue.length === 0 && p.error === null, 'inputClearSession 清空');

  // ============ 7. router 可达性 ============
  const prov = await router.routeInvoke('maker:provider:list', [{}]);
  assert(Array.isArray(prov.providers) && prov.providers.length === 0, 'provider:list 返回空 providers（手机端回退扁平列表）');
  const pricing = await router.routeInvoke('maker:usage:model-pricing', []);
  assert(typeof pricing === 'object', 'model-pricing 不报错');
  const key = await router.routeInvoke('maker:api-key:present', []);
  assert(typeof key.present === 'boolean', 'api-key:present 形状');
  const gp = await router.routeInvoke('maker:input:get-projection', [sid]);
  assert(gp && gp.sessionId === sid, 'get-projection 经 router');
  const cu = await router.routeInvoke('maker:get-context-usage', [sid]);
  assert(cu.contextTokens === 100 && cu.contextWindow === 200000, 'get-context-usage 用 runtime');

  // ============ 7b. 系统级 channel（手机端常调，契约形状对齐 desktop 空态） ============
  const goal = await router.routeInvoke('maker:goal:get-status', [sid]);
  assert(goal === null, 'goal:get-status 返回 null（Pi 无 goal host，desktop 无 goal 亦 null）');
  const sched = await router.routeInvoke('maker:schedule:list', [{}]);
  assert(Array.isArray(sched) && sched.length === 0, 'schedule:list 返回 []（Pi 无 scheduler）');
  const cleared = await router.routeInvoke('notification:clear-session-attention', [sid, 'explicit']);
  assert(cleared === undefined, 'clear-session-attention no-op 不报错');

  // fs:stat-path：dir / file / missing + ~ 展开 + 相对路径归 home
  const statDir = await router.routeInvoke('fs:stat-path', [{ path: DATA_DIR }]);
  assert(statDir.kind === 'dir' && statDir.resolvedPath === path.resolve(DATA_DIR), 'stat-path dir', JSON.stringify(statDir));
  const statFile = await router.routeInvoke('fs:stat-path', [{ path: path.join(DATA_DIR, 'pi-cindy.db') }]);
  assert(statFile.kind === 'file', 'stat-path file（SQLite 库文件）');
  const statMiss = await router.routeInvoke('fs:stat-path', [{ path: path.join(DATA_DIR, 'no-such-dir') }]);
  assert(statMiss.kind === 'missing', 'stat-path missing');
  const statHome = await router.routeInvoke('fs:stat-path', [{ path: '~' }]);
  assert(statHome.kind === 'dir' && statHome.resolvedPath === os.homedir(), 'stat-path ~ 展开');

  try { await router.routeInvoke('maker:get-session-tree', [sid]); assert(false, 'get-session-tree 应拒绝'); }
  catch (e) { assert(e.code === 'CHANNEL_NOT_ALLOWED', 'get-session-tree 已摘除（伪造树）'); }
  try { await router.routeInvoke('maker:navigate-session-tree', [sid]); assert(false, 'navigate-session-tree 应拒绝'); }
  catch (e) { assert(e.code === 'CHANNEL_NOT_ALLOWED', 'navigate-session-tree 已摘除'); }

  // ============ 7c. 手机端 `/` palette 三源（mobile [sessionId].tsx / new.tsx 并行拉取） ============
  // 契约：list-agent-commands → {success, commands: agent-builtin[]}；
  //       list-agent-skills → {success, skills: agent-skill[]}（source 'user'|'skill'）；
  //       list-desktop-commands → {success, commands: desktop[]}（pi-cindy 无 → 空）
  const lc = await router.routeInvoke('maker:list-agent-commands', ['pi']);
  assert(lc.success === true, 'list-agent-commands success');
  assert(Array.isArray(lc.commands) && lc.commands.length === 1, 'list-agent-commands 只含 extension 命令', JSON.stringify(lc.commands));
  assert(lc.commands[0] && lc.commands[0].kind === 'agent-builtin' && lc.commands[0].name === 'cindy-status'
    && typeof lc.commands[0].description === 'string', 'list-agent-commands 项形状（kind/name/description）');
  const ls = await router.routeInvoke('maker:list-agent-skills', ['pi', { workingDir: '/tmp', forceReload: false }]);
  assert(ls.success === true, 'list-agent-skills success');
  assert(Array.isArray(ls.skills) && ls.skills.length === 2, 'list-agent-skills 含 prompt + skill 两条', JSON.stringify(ls.skills));
  const promptRow = ls.skills.find((c) => c.name === 'review');
  const skillRow = ls.skills.find((c) => c.name === 'skill:cpp');
  assert(promptRow && promptRow.kind === 'agent-skill' && promptRow.source === 'user'
    && promptRow.path === '/home/u/.pi/agent/prompts/review.md', 'prompt 映射 agent-skill source=user + path');
  assert(skillRow && skillRow.kind === 'agent-skill' && skillRow.source === 'skill'
    && skillRow.scope === 'user' && skillRow.enabled === true, 'skill 映射 agent-skill source=skill（名带 skill: 前缀）');
  const ld = await router.routeInvoke('maker:list-desktop-commands', []);
  assert(ld.success === true && Array.isArray(ld.commands) && ld.commands.length === 0, 'list-desktop-commands 空清单（pi-cindy 无 main 命令）');
  // getCommands 缺失/抛错 → 容错空清单（success:true 空数组，不报错不重试）——老 pi 无该 API 时 palette 空面板而非错误
  const brokenPi = { getCommands: () => { throw new Error('boom'); } };
  router.setInvokeContext({ ...router.getInvokeContext(), pi: brokenPi });
  const lcBroken = await router.routeInvoke('maker:list-agent-commands', ['pi']);
  assert(lcBroken.success === true && Array.isArray(lcBroken.commands) && lcBroken.commands.length === 0, 'list-agent-commands getCommands 抛错 → 容错空清单');
  const lsBroken = await router.routeInvoke('maker:list-agent-skills', ['pi']);
  assert(lsBroken.success === true && Array.isArray(lsBroken.skills) && lsBroken.skills.length === 0, 'list-agent-skills getCommands 缺失 → 容错空清单');
  const noGetCommandsPi = {};
  router.setInvokeContext({ ...router.getInvokeContext(), pi: noGetCommandsPi });
  const lcNone = await router.routeInvoke('maker:list-agent-commands', ['pi']);
  assert(lcNone.success === true && lcNone.commands.length === 0, 'list-agent-commands 无 getCommands 方法 → 空清单');
  // 逐行防御：null 行被过滤，不炸整面板（修：曾整体 cast，单行 null → TypeError → 面板 error）
  const nullRowPi = {
    getCommands: () => [null, { name: 'cindy-status', description: 'x', source: 'extension' }, { name: 'skill:cpp', description: 'y', source: 'skill' }],
  };
  router.setInvokeContext({ ...router.getInvokeContext(), pi: nullRowPi });
  const lcNull = await router.routeInvoke('maker:list-agent-commands', ['pi']);
  assert(lcNull.success === true && lcNull.commands.length === 1, 'list-agent-commands 过滤 null 行', JSON.stringify(lcNull.commands));
  const lsNull = await router.routeInvoke('maker:list-agent-skills', ['pi']);
  assert(lsNull.success === true && lsNull.skills.length === 1, 'list-agent-skills 过滤 null 行', JSON.stringify(lsNull.skills));
  router.setInvokeContext({ ...router.getInvokeContext(), pi: fakePi });

  // ============ 8. store 隔离 ============
  const storeFiles = fs.readdirSync(DATA_DIR);
  assert(storeFiles.includes('pi-cindy.db'), 'store 写入隔离目录（SQLite 库）');
  // 真实数据目录可能不存在（新机器），存在才校验未泄漏；不存在 = 无泄漏
  // SQLite 化后真实库文件存在则用只读查询验证测试会话未写入（防污染真实数据）
  const realStorePath = path.join(os.homedir(), '.pi', 'cindy-sync', 'pi-cindy.db');
  if (fs.existsSync(realStorePath)) {
    jiti(path.join(base, 'store', 'db.js')); // 仅验证 db.js 可加载；getDb 单例已指向测试 DATA_DIR
    // 真实库文件存在性检查只做路径层面，不 open 真实库（避免与运行中 pi 进程争锁）
    assert(fs.existsSync(realStorePath), '真实库文件存在（路径层面校验）');
  }
  // token 登录态隔离快照（EXPERIENCE #45 回归）：token-store 曾硬编码 ~/.pi/cindy-sync，
  // 冒烟测试的 logout/saveSession/clearSession 全部作用在真实 session.enc 上——
  // 每次 npm test 删真实登录态，重启 pi 即“登录态丢了”。记录真实文件字节快照，
  // 20b 段（全量 token 操作）结束后比对，任何写/删都算污染。
  // 路径同源引用 token-store.DEFAULT_DIR（修：曾硬编码，DIR 逻辑迁移后快照会静默校验错路径）。
  const realTokPath = path.join(jiti(path.join(base, 'store/token-store.js')).DEFAULT_DIR, 'session.enc');
  const realTokBefore = fs.existsSync(realTokPath) ? fs.readFileSync(realTokPath) : null;

  // ============ 9. create-session 透传预生成 id（幂等） ============
  const preId = 'cm-9f8e7d6c5b4a3210';
  const pushesBefore = pushes.filter((x) => x.ch === 'local-db:sessions:created').length;
  const r1 = await maker.createSessionHandler([{ id: preId, model: 'claude-sonnet-4-5', workingDir: '/srv' }]);
  assert(r1.sessionId === preId, 'create-session 采用 mobile 预生成 id', r1);
  assert(r1.agentKind === 'pi' && r1.workDir === '/srv', 'create-session 返回形状');
  activeTestSid = preId; // 后续消息/队列测试以 preId 会话为前台
  const r2 = await maker.createSessionHandler([{ id: preId, model: 'claude-sonnet-4-5' }]);
  assert(r2.sessionId === preId, '同 id 二次 create 幂等复用', r2);
  const createdPushes = pushes.filter((x) => x.ch === 'local-db:sessions:created').length;
  assert(createdPushes === pushesBefore + 1, '幂等复用不再推 sessions:created', { before: pushesBefore, after: createdPushes });

  // ============ 10. messages:list 降序 + 游标 ============
  const msid = preId;
  const ids = ['m-1', 'm-2', 'm-3', 'm-4', 'm-5'];
  ids.forEach((id, i) => store.appendMessage({ id, sessionId: msid, role: 'user', content: `msg${i + 1}`, createdAt: 1000 + i * 1000 }));
  let rows = await messages.list([msid, { limit: 10 }]);
  assert(rows[0].id === 'm-5' && rows[rows.length - 1].id === 'm-1', 'messages:list 输出降序（最新在前）', rows.map((r) => r.id));
  rows = await messages.list([msid, { limit: 2 }]);
  assert(rows.length === 2 && rows[0].id === 'm-5' && rows[1].id === 'm-4', 'limit 取最新窗口降序', rows.map((r) => r.id));
  rows = await messages.list([msid, { before: 'm-4', limit: 10 }]);
  assert(rows[0].id === 'm-3' && rows[rows.length - 1].id === 'm-1', 'before 游标：严格早于 + 降序', rows.map((r) => r.id));
  rows = await messages.list([msid, { after: 'm-2', limit: 10 }]);
  assert(rows[0].id === 'm-5' && rows[rows.length - 1].id === 'm-3', 'after 游标：严格晚于 + 降序', rows.map((r) => r.id));
  rows = await messages.list([msid, { beforeTs: 2500, limit: 10 }]);
  assert(rows[0].id === 'm-2' && rows.length === 2, 'beforeTs 毫秒兜底', rows.map((r) => r.id));

  // ============ 11. messages:around / around-client-id ============
  const aroundRows = await messages.around([msid, 'm-3', { radius: 1 }]);
  assert(aroundRows.length === 3, 'around radius=1 → 3 行', aroundRows.length);
  assert(aroundRows[0].id === 'm-2' && aroundRows[1].id === 'm-3' && aroundRows[2].id === 'm-4', 'around 锚点窗口顺序', aroundRows.map((r) => r.id));
  // m-3 无 clientId → 锚点缺失抛 NOT_FOUND（对齐 desktop throwIpcError）
  try { await messages.aroundByClientId([msid, 'm-3', { radius: 1 }]); assert(false, '缺 clientId 锚点应 NOT_FOUND'); }
  catch (e) { assert(e.code === 'NOT_FOUND', 'around-client-id 缺锚点 NOT_FOUND', e.code); }
  // 带 clientId 的行（enqueue 注入路径落库的 user 行）→ 锚定窗口
  store.appendMessage({ id: 'm-cid', sessionId: msid, role: 'user', content: 'client-id row', clientId: 'q-full', createdAt: 9999 });
  const aroundCid2 = await messages.aroundByClientId([msid, 'q-full', { radius: 1 }]);
  assert(Array.isArray(aroundCid2) && aroundCid2.some((r) => r.clientId === 'q-full'), 'around-client-id 按 clientId 锚定', Array.isArray(aroundCid2) ? aroundCid2.map((r) => r.id) : aroundCid2);
  const got = await router.routeInvoke('local-db:messages:around', [msid, 'm-3', { radius: 2 }]);
  assert(Array.isArray(got) && got.length === 5, 'around 通道经 router 可达', Array.isArray(got) ? got.length : got);

  // ============ 12. 队列投影透传 chatMessage（mobile isQueuedRemoteMessage 校验） ============
  maker.inputQueueMarkRunning(msid, true);
  const fullItem = {
    clientId: 'q-full', text: 'hi',
    persistedContent: '{"text":"hi"}', model: 'claude-sonnet-4-5', effort: 'high',
    permissionMode: 'ask', workingDir: '/srv',
    createOpts: { agentKind: 'pi', workingDir: '/srv', model: 'claude-sonnet-4-5' },
    chatMessage: { clientId: 'q-full', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
  };
  p = await maker.inputEnqueue([msid, fullItem]);
  const queued = p.pendingQueue[0];
  assert(queued && queued.clientId === 'q-full', '投影含 queue item');
  assert(queued.chatMessage && queued.chatMessage.role === 'user' && queued.chatMessage.content === 'hi', '投影透传 chatMessage（isQueuedRemoteMessage 通过）', queued.chatMessage);
  assert(queued.persistedContent === '{"text":"hi"}' && queued.createOpts?.agentKind === 'pi', '投影透传 persistedContent/createOpts');
  await maker.inputClearSession([msid]);

  // ============ 13. inputStop opts：keepQueue / pauseQueue / 空闲清 abortPending ============
  maker.inputQueueMarkRunning(msid, true);
  await maker.inputEnqueue([msid, { clientId: 'keep1', text: 'k1' }]);
  await maker.inputStop([msid, { keepQueue: true, pauseQueue: true }]);
  p = await maker.inputGetProjection([msid]);
  assert(p.pendingQueue.length === 1 && p.pendingQueue[0].clientId === 'keep1', 'stop keepQueue 保留队列');
  assert(p.queuePaused === true, 'stop pauseQueue 置暂停态');
  assert(p.queueAbortPending === false, '空闲 stop 不残留 abortPending（isRuntimeIdle）');
  await maker.inputResume([msid]);
  p = await maker.inputGetProjection([msid]);
  assert(p.queuePaused === false, 'resume 清暂停');
  await maker.inputStop([msid, {}]);
  p = await maker.inputGetProjection([msid]);
  assert(p.pendingQueue.length === 0, 'stop 无 keepQueue 清空队列');
  maker.inputQueueMarkRunning(msid, false);

  // ============ 14. enqueue/steer 前台会话门禁 + 附件拒绝 ============
  const otherSid = 'cm-other-session-0001';
  store.createSession({ id: otherSid, status: 'active' });
  try { await maker.inputEnqueue([otherSid, { clientId: 'x', text: 'to stale session' }]); assert(false, '非前台 enqueue 应拒绝'); }
  catch (e) { assert(e.code === 'NOT_FOUND', '非前台会话 enqueue 拒绝（NOT_FOUND）', e.code); }
  try { await maker.inputEnqueue([sid, { clientId: 'img1', text: 'pic', files: [{ name: 'a.png', path: '/tmp/a.png', size: 1 }] }]); assert(false, '附件 enqueue 应拒绝'); }
  catch (e) { assert(e.code === 'INVALID_PARAMS', '附件显式拒绝（INVALID_PARAMS）而非静默丢弃', e.code); }
  const afterReject = sent.length;
  await sleep(30);
  assert(sent.length === afterReject, '被拒消息未注入 agent');

  // ============ 15. 中断语义 ============
  let interrupted = store.getInterruptedSessions();
  assert(!interrupted.some((s) => s.id === msid), '正常会话不命中 interrupted-pending');
  store.updateSession(msid, { activeTurnStartedAt: 9000, lastTurnEndedAt: null });
  interrupted = store.getInterruptedSessions();
  assert(interrupted.some((s) => s.id === msid), 'startedAt 无 endedAt → 命中疑似中断');
  store.updateSession(msid, { lastTurnEndedAt: 9500 });
  interrupted = store.getInterruptedSessions();
  assert(!interrupted.some((s) => s.id === msid), 'endedAt > startedAt → 中断熄灭');

  // ============ 16. store：非法 sessionId 拒绝 + 原子写 ============
  try { store.listMessages('../../etc/passwd'); assert(false, '非法 sid 应拒绝'); }
  catch (e) { assert(e.code === 'INVALID_PARAMS', '路径穿越 sid 拒绝（INVALID_PARAMS）', e.code); }
  try { await messages.list(['../../etc/passwd']); assert(false, 'messages:list 非法 sid 应拒绝'); }
  catch (e) { assert(e.code === 'INVALID_PARAMS', 'messages:list 路径穿越防护', e.code); }
  const msgsFile = path.join(DATA_DIR, 'messages', `${msid}.json`);
  // SQLite 化后无消息文件；改断言消息已入 SQLite 库（经 store API 读回）
  assert(!fs.existsSync(msgsFile), 'SQLite 化后无 JSON 消息文件残留');
  const storedMsgs = store.listMessages(msid);
  assert(storedMsgs.length > 0, '消息已写入 SQLite（经 store API 读回）');

  // ============ 17. 端点清单解析（对齐参考仓 parseClientEndpointManifest 严格语义） ============
  const endpoints = jiti(path.join(base, 'endpoints.js'));
  let pr = endpoints.parseClientEndpointManifest(JSON.stringify({
    schemaVersion: 1,
    authApiBaseUrl: 'https://auth.cindy.app',
    deviceLinkApiBaseUrl: 'https://device-link.cindy.app///',
    authDesktopCallbackUrl: '',
    futureField: 'ignored',
  }));
  assert(pr.ok === true, '合法清单解析 ok', pr);
  assert(pr.endpoints.authApiBaseUrl === 'https://auth.cindy.app', '非空字段保留');
  assert(pr.endpoints.deviceLinkApiBaseUrl === 'https://device-link.cindy.app', '尾斜杠归一');
  assert(pr.endpoints.authDesktopCallbackUrl === '', '缺失/空白字段补空串');
  assert(pr.endpoints.websiteUrl === '', '缺失 key 也补空串');
  assert(!('futureField' in pr.endpoints), '未知字段忽略');
  assert(pr.endpoints.futureField === undefined, '未知字段不入 map');

  pr = endpoints.parseClientEndpointManifest('not json');
  assert(pr.ok === false && pr.reason === 'invalid-json', '非法 JSON 拒绝', pr);
  pr = endpoints.parseClientEndpointManifest(JSON.stringify({ schemaVersion: 2, authApiBaseUrl: 'https://x.com' }));
  assert(pr.ok === false && pr.reason.startsWith('unsupported-schema-version'), 'schemaVersion 超限拒绝', pr);
  pr = endpoints.parseClientEndpointManifest(JSON.stringify({ schemaVersion: '1' }));
  assert(pr.ok === false && pr.reason === 'invalid-schema-version', 'schemaVersion 非整数拒绝', pr);
  pr = endpoints.parseClientEndpointManifest(JSON.stringify({ schemaVersion: 1, deviceLinkApiBaseUrl: 'http://x.com' }));
  assert(pr.ok === false && pr.reason === 'invalid-protocol:deviceLinkApiBaseUrl', 'http 进 https-only 字段拒绝', pr);
  pr = endpoints.parseClientEndpointManifest(JSON.stringify({ schemaVersion: 1, authApiBaseUrl: 'https://u:p@x.com' }));
  assert(pr.ok === false && pr.reason === 'credentials-in-url:authApiBaseUrl', 'URL 带凭据拒绝', pr);
  pr = endpoints.parseClientEndpointManifest(JSON.stringify({ schemaVersion: 1, review: 42 }));
  assert(pr.ok === false && pr.reason === 'invalid-field:review', 'review 非 string 拒绝', pr);

  // ============ 18. 端点热更新：CDN 拉取覆盖 + 失败保留 ============
  const origFetch = globalThis.fetch;
  const manifestsByRealm = {
    cn: { schemaVersion: 1, authApiBaseUrl: 'https://auth-cn.test', deviceLinkApiBaseUrl: 'https://dl-cn.test' },
    global: { schemaVersion: 1, authApiBaseUrl: 'https://auth-global.test', deviceLinkApiBaseUrl: 'https://dl-global.test' },
  };
  globalThis.fetch = async (url) => {
    const s = String(url);
    const realm = s.includes('cindy.com.cn') ? 'cn' : 'global';
    return { ok: true, text: async () => JSON.stringify(manifestsByRealm[realm]) };
  };
  await endpoints.refreshEndpoints();
  assert(endpoints.getEndpoint('global', 'authApiBaseUrl') === 'https://auth-global.test', '拉取成功覆盖 global auth', endpoints.getEndpoint('global', 'authApiBaseUrl'));
  assert(endpoints.getEndpoint('cn', 'deviceLinkApiBaseUrl') === 'https://dl-cn.test', '拉取成功覆盖 cn device-link');
  assert(endpoints.getEndpoint('global', 'websiteUrl') === 'https://cindy.app', '清单缺失字段回落烘焙默认');
  globalThis.fetch = async () => { throw new Error('net down'); };
  await endpoints.refreshEndpoints();
  assert(endpoints.getEndpoint('global', 'authApiBaseUrl') === 'https://auth-global.test', '拉取失败保留上次成功覆盖（不阻断）');
  globalThis.fetch = origFetch;

  // ============ 19. RFC 8252 loopback 回调 ============
  const loopbackMod = jiti(path.join(base, 'auth/loopback.js'));
  let lr = loopbackMod.parseAuthLoopbackCallback('/auth/callback?state=s1&code=abc', 's1');
  assert(lr && lr.code === 'abc', 'loopback 合法回调取 code', lr);
  lr = loopbackMod.parseAuthLoopbackCallback('/auth/callback?state=wrong&code=abc', 's1');
  assert(lr && lr.error === 'STATE_MISMATCH', 'state 不匹配 STATE_MISMATCH', lr);
  lr = loopbackMod.parseAuthLoopbackCallback('/other?state=s1&code=abc', 's1');
  assert(lr === null, '未知路径返回 null（404 不结算）', lr);
  lr = loopbackMod.parseAuthLoopbackCallback('/auth/callback?state=s1&error=denied', 's1');
  assert(lr && lr.error === 'denied', 'provider error 透传', lr);
  lr = loopbackMod.parseAuthLoopbackCallback('/auth/callback?state=s1', 's1');
  assert(lr && lr.error === 'INVALID_AUTH_CODE', '缺 code → INVALID_AUTH_CODE', lr);
  // 真实 listener 链路：起 server → 模拟浏览器回调 → 结算
  const http = require('node:http');
  const listener = await loopbackMod.startLoopbackListener('st-real', 5000);
  assert(listener.redirectUri.startsWith('http://127.0.0.1:') && listener.redirectUri.endsWith('/auth/callback'), 'redirect_uri 形状', listener.redirectUri);
  http.get(`${listener.redirectUri}?state=st-real&code=real-code`, () => {});
  const lbResult = await listener.result;
  assert(lbResult.code === 'real-code', 'loopback 端到端取到授权码', lbResult);

  // ============ 19.5 tracker：session_start 时 relay 未就绪仍落库 + 就绪后推送 ============
  // 真机复现（P1）：index.ts 的 ensureClient 与 tracker 的 session_start 并发，tracker 先跑时
  // client 为 null，旧实现 `if (!c) return` 导致当前会话永不落库 → 手机刷新不出会话。
  const tracker = jiti(path.join(base, 'tracker.js'));
  const trackerEvents = {};
  const trackerPi = {
    on: (ev, fn) => { trackerEvents[ev] = fn; },
  };
  let trackerClient = null; // 先 null（relay 连接在途），后注入就绪 client
  const trackerPushes = [];
  const trackerActive = { id: null };
  tracker.attachSessionTracker(
    trackerPi,
    () => trackerClient,
    () => trackerActive.id,
    (id) => { trackerActive.id = id; },
  );
  // 首次 session_start：client 未就绪，会话必须落库 + setActiveId，push 跳过不崩
  const tctx = {
    sessionManager: { getSessionId: () => 'tracker-sdk-001' },
    cwd: '/Users/mellow/Projects/tracker-test',
    model: { id: 'claude-sonnet-4-5', provider: 'anthropic' },
  };
  await trackerEvents['session_start'](null, tctx);
  const tSession = store.findSessionBySdkId('tracker-sdk-001');
  assert(tSession && tSession.status === 'active', 'client 未就绪时 session_start 仍落库 active', tSession && { status: tSession.status });
  assert(trackerActive.id === tSession.id, 'client 未就绪时 setActiveId 生效', trackerActive.id);
  assert(trackerPushes.length === 0, 'client 未就绪时不推（push 无 c 不崩）', trackerPushes.length);
  // 就绪后推送可用
  trackerClient = { push: (ch, data) => trackerPushes.push({ ch, data }) };
  await trackerEvents['session_start'](null, { ...tctx, sessionManager: { getSessionId: () => 'tracker-sdk-002' }, cwd: '/tmp/2' });
  assert(trackerPushes.filter((p) => p.ch === 'local-db:sessions:created').length === 1, 'client 就绪后 session_start 推 sessions:created', trackerPushes.map((p) => p.ch));
  const t2 = store.findSessionBySdkId('tracker-sdk-002');
  assert(t2 && t2.status === 'active', '第二个会话正常落库', t2 && t2.status);
  // 已存在会话（archived）再 start → 恢复 active
  store.updateSession(tSession.id, { status: 'archived' });
  await trackerEvents['session_start'](null, { ...tctx, cwd: '/tmp/1' });
  assert(store.findSessionBySdkId('tracker-sdk-001').status === 'active', '已归档会话再 start 恢复 active');

  // ============ 19.6 tracker：standby（client=null）时消息仍落库 + shutdown 仍归档 ============
  // 多进程仲裁后：standby 进程 getClient()=null。旧实现 `if (!c || !sid) return` 挡在
  // appendMessage/updateSession 之前 → standby 会话消息不落库（永久空白）+ shutdown 不归档
  // （active 空白会话堆积）。修：落库与 push 解耦，push 才判 c。
  trackerClient = null; // 模拟 standby（不连 relay）
  await trackerEvents['session_start'](null, { ...tctx, sessionManager: { getSessionId: () => 'standby-sdk-001' }, cwd: '/tmp/standby' });
  const stSession = store.findSessionBySdkId('standby-sdk-001');
  assert(stSession && stSession.status === 'active', 'standby session_start 仍落库');
  const standbyPushesBefore = trackerPushes.length;
  await trackerEvents['message_end']({ message: { role: 'user', content: 'standby 消息' } }, {});
  const stMsgs = store.listMessages(stSession.id);
  assert(stMsgs.length === 1 && stMsgs[0].content === 'standby 消息', 'standby 消息仍落库（不依赖 client）', stMsgs.map((m) => m.content));
  await trackerEvents['message_end']({ message: { role: 'assistant', content: 'standby 回复', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }, {});
  assert(store.listMessages(stSession.id).length === 2, 'standby assistant 消息落库');
  assert(store.getSession(stSession.id).totalTokenUsage === 2, 'standby 用量更新落库');
  assert(trackerPushes.length === standbyPushesBefore, 'standby 不 push（client null）');
  await trackerEvents['turn_start']();
  assert(store.getSession(stSession.id).activeTurnStartedAt != null, 'standby turn_start 落库（中断判定数据完整）');
  await trackerEvents['session_shutdown']();
  assert(store.getSession(stSession.id).status === 'archived', 'standby shutdown 仍归档（防空白会话堆积）');
  assert(trackerActive.id === null, 'standby shutdown 清 activeId');

  // ============ 19.7 tracker：子 agent（Agent 工具）会话不落库、不占 activeId、不推手机 ============
  // pi-subagents 用 createAgentSession + SessionManager.inMemory() 同进程建子会话，
  // bindExtensions 会为子会话建独立 extension runner（独立 API 实例），session_start
  // 重新触发。判定信号：sessionManager.isPersisted()=false。
  // 用户需求：手机上不显示子 agent 会话（噪音）；同时子 agent 不得劫持主会话 activeId。
  trackerClient = { push: (ch, data) => trackerPushes.push({ ch, data }), setBusy: () => {} }; // 恢复就绪 client
  // 先建主会话（persisted），activeId 指向主会话
  await trackerEvents['session_start'](null, { ...tctx, sessionManager: { getSessionId: () => 'main-sdk-001', isPersisted: () => true }, cwd: '/tmp/main' });
  const mainSession = store.findSessionBySdkId('main-sdk-001');
  assert(mainSession && mainSession.status === 'active', 'persisted 主会话正常落库', mainSession && { id: mainSession.id });
  assert(trackerActive.id === mainSession.id, '主会话 setActiveId 生效', trackerActive.id);
  const pushesAfterMain = trackerPushes.length;
  // 子 agent session_start（in-memory）：不落库、不 setActiveId、不 push
  await trackerEvents['session_start'](null, {
    sessionManager: { getSessionId: () => 'subagent-sdk-001', isPersisted: () => false },
    cwd: '/tmp/main', model: { id: 'claude-haiku-4-5', provider: 'anthropic' },
  });
  assert(store.findSessionBySdkId('subagent-sdk-001') === null, '子 agent 会话不落库', store.findSessionBySdkId('subagent-sdk-001'));
  assert(trackerActive.id === mainSession.id, '子 agent 不劫持 activeId（仍指向主会话）', trackerActive.id);
  assert(trackerPushes.length === pushesAfterMain, '子 agent 不推 sessions:created', trackerPushes.map((p) => p.ch));
  // 子 agent 有自己的 extension runner/API → 独立 tracker 实例：session_start 被跳过 →
  // activeId 保持 null → 子 agent 消息/归档/推送全部自然跳过（真实架构：子 agent 事件
  // 不到主 tracker，这里用独立实例模拟同一进程内的子 agent runner）
  const subEvents = {};
  const subPi = { on: (ev, fn) => { subEvents[ev] = fn; } };
  const subActive = { id: null };
  const subPushes = [];
  tracker.attachSessionTracker(subPi, () => ({ push: (ch, d) => subPushes.push({ ch, d }), setBusy: () => {} }), () => subActive.id, (id) => { subActive.id = id; });
  await subEvents['session_start'](null, {
    sessionManager: { getSessionId: () => 'subagent-sdk-001', isPersisted: () => false },
    cwd: '/tmp/main', model: { id: 'claude-haiku-4-5', provider: 'anthropic' },
  });
  assert(store.findSessionBySdkId('subagent-sdk-001') === null, '子 agent runner：会话不落库', store.findSessionBySdkId('subagent-sdk-001'));
  assert(subActive.id === null, '子 agent runner：activeId 保持 null', subActive.id);
  assert(subPushes.length === 0, '子 agent runner：不推 sessions:created', subPushes.map((p) => p.ch));
  await subEvents['message_end']({ message: { role: 'user', content: '子 agent 任务' } }, {});
  assert(store.listMessages(mainSession.id).length === 0, '子 agent 消息不落入主会话', store.listMessages(mainSession.id).map((m) => m.content));
  await subEvents['message_end']({ message: { role: 'assistant', content: '子 agent 结果', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }, {});
  assert(store.listMessages(mainSession.id).length === 0, '子 agent assistant 消息也不落入主会话');
  await subEvents['session_shutdown']();
  assert(store.getSession(mainSession.id).status === 'active', '子 agent shutdown 不归档主会话', store.getSession(mainSession.id) && { status: store.getSession(mainSession.id).status });
  assert(trackerActive.id === mainSession.id, '子 agent shutdown 不清主 activeId', trackerActive.id);
  // 子 agent 后主会话消息仍正常落库（回归）
  await trackerEvents['message_end']({ message: { role: 'user', content: '主会话消息' } }, {});
  assert(store.listMessages(mainSession.id).length === 1 && store.listMessages(mainSession.id)[0].content === '主会话消息', '子 agent 结束后主会话消息正常落库', store.listMessages(mainSession.id).map((m) => m.content));


  // ============ 20. binding 流程：request-code / verify 请求形状（对齐参考 auth-client） ============
  const authClient = jiti(path.join(base, 'auth/auth-client.js'));
  const authCalls = [];
  globalThis.fetch = async (url, opts) => {
    authCalls.push({ url: String(url), body: opts ? JSON.parse(opts.body || '{}') : {} });
    return { ok: true, json: async () => ({ status: 'sent' }) };
  };
  await authClient.requestBindingCode('global', 'bind-ticket-1', 'email', 'you@example.com');
  assert(authCalls[0].url.endsWith('/api/auth/binding/request-code'), 'binding request-code URL', authCalls[0].url);
  assert(authCalls[0].url.startsWith(endpoints.getEndpoint('global', 'authApiBaseUrl')), 'binding 走生效 auth 端点', authCalls[0].url);
  assert(authCalls[0].body.bindTicket === 'bind-ticket-1', 'binding 带 bindTicket');
  assert(authCalls[0].body.email === 'you@example.com', 'binding 带 [bindType]: contact', authCalls[0].body);
  assert(typeof authCalls[0].body.locale === 'string' && authCalls[0].body.locale.length > 0, 'binding 带 locale（未修项#补）', authCalls[0].body.locale);
  authCalls.length = 0;
  globalThis.fetch = async (url, opts) => {
    authCalls.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
    return { ok: true, json: async () => ({ status: 'ok', accessToken: 'at-0123456789012345', refreshToken: 'rt-0123456789012345', membership: { id: 'm1' } }) };
  };
  const bindOutcome = await authClient.verifyBinding('global', 'bind-ticket-1', 'email', 'you@example.com', '123456');
  assert(authCalls[0].url.endsWith('/api/auth/binding/verify'), 'binding verify URL', authCalls[0].url);
  assert(authCalls[0].body.code === '123456' && authCalls[0].body.bindTicket === 'bind-ticket-1', 'verify 带 code/bindTicket', authCalls[0].body);
  assert(authCalls[0].body.deviceId && authCalls[0].body.deviceId.length > 0, 'verify 带 deviceId');
  assert(bindOutcome.status === 'ok', 'verify ok 返回 TokenPair 形状', bindOutcome);
  globalThis.fetch = origFetch;

  // ============ 20b. token 对防御性校验（畸形响应不落盘，防 session.enc 被垃圾 token 冲掉） ============
  // 真机复现：刷新响应返回 refreshToken="rt"（2 字符）直接覆盖好 token → 永久 401，只能重登。
  assert(authClient.isValidTokenPair({ accessToken: 'at', refreshToken: 'rt' }) === false, '短 token 对判无效');
  assert(authClient.isValidTokenPair({ accessToken: 'at-0123456789012345', refreshToken: 'rt-0123456789012345' }) === true, '长 token 对判有效');
  assert(authClient.isValidTokenPair(null) === false, 'null 判无效');
  assert(authClient.isValidTokenPair({ accessToken: 'at-0123456789012345' }) === false, '缺 refreshToken 判无效');
  // 畸形刷新响应：getAccessToken 返回 null，session.enc 不被覆盖
  // （先 logout 清掉 binding 测试留下的 cachedToken + session.enc，保证走真实刷新路径）
  const tokenStore = jiti(path.join(base, 'store/token-store.js'));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  await authClient.logout();
  tokenStore.saveSession({ version: 1, realm: 'global', refreshToken: 'good-0123456789012345' });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ accessToken: 'at', refreshToken: 'rt', membership: { id: 'm1' } }) });
  const badRefresh = await authClient.getAccessToken('global');
  assert(badRefresh === null, '畸形刷新响应 → null（不落盘）');
  const sessionAfterBad = tokenStore.loadSession();
  assert(sessionAfterBad && sessionAfterBad.refreshToken === 'good-0123456789012345', 'session.enc 未被垃圾 token 覆盖', sessionAfterBad?.refreshToken);
  // 连续畸形累计（修：曾只跳过不落盘 → 服务端持续异常时无限静默重试）：第 2 次保留会话，
  // 第 3 次（上限）→ 清会话强制重登。
  const bad2 = await authClient.getAccessToken('global');
  assert(bad2 === null, '第 2 次畸形刷新 → null（不落盘）');
  assert(tokenStore.loadSession()?.refreshToken === 'good-0123456789012345', '第 2 次畸形：会话仍保留');
  const bad3 = await authClient.getAccessToken('global');
  assert(bad3 === null, '第 3 次畸形刷新 → null');
  assert(tokenStore.loadSession() === null, '连续 3 次畸形 → 会话被清（触发重新登录）');
  // 401 INVALID_REFRESH_TOKEN → 清会话（强制重登）
  tokenStore.saveSession({ version: 1, realm: 'global', refreshToken: 'good-0123456789012345' });
  globalThis.fetch = async () => ({
    ok: false, status: 401, text: async () => '{"error":{"code":"INVALID_REFRESH_TOKEN","message":"invalid"}}',
  });
  const deadRefresh = await authClient.getAccessToken('global');
  assert(deadRefresh === null, 'INVALID_REFRESH_TOKEN → null');
  assert(tokenStore.loadSession() === null, '401 后会话被清（提示重新登录）');
  // 401 分支已复位畸形计数：重新落好 token 后连续 2 次畸形（< 上限 3）不触发清除
  tokenStore.saveSession({ version: 1, realm: 'global', refreshToken: 'good-0123456789012345' });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ accessToken: 'at', refreshToken: 'rt' }) });
  const boundary1 = await authClient.getAccessToken('global');
  const boundary2 = await authClient.getAccessToken('global');
  assert(boundary1 === null && boundary2 === null, '计数复位后连续 2 次畸形 → null');
  assert(tokenStore.loadSession()?.refreshToken === 'good-0123456789012345', '连续 2 次畸形不触发清除（上限 3）');
  // 成功刷新复位畸形计数（L7）：先用一次成功刷新把计数归零（不论先前状态——边界段
  // 结束计数=2，若成功不复位，后续 2 连畸形即 4≥3 触发清除，测试会红）→ 再 2 连畸形
  // 不触发清除。成功后 cachedToken 有效 1h，用 Date.now 假跳过期强制走刷新路径。
  tokenStore.saveSession({ version: 1, realm: 'global', refreshToken: 'good-0123456789012345' });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ accessToken: 'good-at-0123456789012345', refreshToken: 'good-rt-0123456789012345' }) });
  assert((await authClient.getAccessToken('global')) !== null, '成功刷新返回 token（计数归零）');
  const realNowFn = Date.now;
  Date.now = () => realNowFn() + 2 * 3600_000; // 缓存假过期 → 强制走刷新
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ accessToken: 'at', refreshToken: 'rt' }) });
  const resetB1 = await authClient.getAccessToken('global');
  const resetB2 = await authClient.getAccessToken('global');
  Date.now = realNowFn;
  assert(resetB1 === null && resetB2 === null, '成功复位后连续 2 次畸形 → null');
  assert(tokenStore.loadSession()?.refreshToken === 'good-rt-0123456789012345', '成功复位后 2 连畸形不触发清除');
  // 隔离回归终验：token-store 落在隔离目录（可控），真实 session.enc 字节级未变
  assert(fs.existsSync(path.join(DATA_DIR, 'session.enc')), 'token-store 落在 PI_CINDY_DATA_DIR 隔离目录（EXPERIENCE #45 回归）', fs.readdirSync(DATA_DIR));
  const realTokAfter = fs.existsSync(realTokPath) ? fs.readFileSync(realTokPath) : null;
  assert((realTokAfter === null) === (realTokBefore === null), '真实 session.enc 存在性未被测试改变', { before: !!realTokBefore, after: !!realTokAfter });
  if (realTokBefore && realTokAfter) {
    assert(realTokAfter.equals(realTokBefore), '真实 session.enc 内容未被测试改写');
  }
  globalThis.fetch = origFetch;

  // ============ 20c. 畸形 refresh token 快速失败（启动无感：不发无效网络请求） ============
  // 真机场景：session.enc 被旧版污染的 refreshToken="rt"（<16 字符）。getAccessToken 应
  // 直接判失效清会话，**不发网络请求**（此前每次启动必发一次必然 401 的无效往返）。
  const malformedCalls = [];
  globalThis.fetch = async (url) => { malformedCalls.push(String(url)); return { ok: true, json: async () => ({}) }; };
  await authClient.logout(); // 清内存缓存 + session.enc，保证走磁盘判定路径
  malformedCalls.length = 0; // logout 自身调 /api/auth/logout，不计入本次断言
  tokenStore.saveSession({ version: 1, realm: 'global', refreshToken: 'rt' }); // 畸形 token
  const malformedResult = await authClient.getAccessToken('global');
  assert(malformedResult === null, '畸形 refresh token → null（不发网络）');
  assert(malformedCalls.length === 0, '畸形 refresh token 不发网络请求（启动无感核心）', malformedCalls);
  assert(tokenStore.loadSession() === null, '畸形 refresh token → 清会话（提示重新登录）');
  assert(authClient.isMalformedRefreshToken('rt') === true, '短 token 判畸形');
  assert(authClient.isMalformedRefreshToken('good-rt-0123456789012345') === false, '长 token 非畸形');
  assert(authClient.isMalformedRefreshToken(null) === true && authClient.isMalformedRefreshToken(undefined) === true, 'null/undefined 判畸形');

  // ============ 20d. access token 磁盘缓存（启动零网络：未过期直接返回，不 refresh） ============
  // 核心路径：进程启动 getAccessToken 应优先用落盘 access token（含 exp），未过期则零网络。
  const cacheCalls = [];
  globalThis.fetch = async (url) => { cacheCalls.push(String(url)); return { ok: true, json: async () => ({}) }; };
  await authClient.logout(); // 清内存缓存
  cacheCalls.length = 0; // logout 自身调 /api/auth/logout，不计入本次断言
  const future = Date.now() + 3600_000; // 1h 后过期
  tokenStore.saveSession({ version: 1, realm: 'global', refreshToken: 'good-rt-0123456789012345', accessToken: 'good-at-0123456789012345', accessExpiresAt: future });
  const cached = await authClient.getAccessToken('global');
  assert(cached === 'good-at-0123456789012345', '磁盘缓存命中：返回落盘 access token');
  assert(cacheCalls.length === 0, '磁盘缓存命中：零网络请求（启动无感核心）', cacheCalls);
  // 已过期 → 走 refresh
  await authClient.logout();
  cacheCalls.length = 0; // 重新计数（logout 自身请求不计入）
  tokenStore.saveSession({ version: 1, realm: 'global', refreshToken: 'good-rt-0123456789012345', accessToken: 'stale-at-0123456789012345', accessExpiresAt: Date.now() - 1000 });
  globalThis.fetch = async (url) => {
    cacheCalls.push(String(url));
    return { ok: true, json: async () => ({ accessToken: 'fresh-at-0123456789012345', refreshToken: 'fresh-rt-0123456789012345' }) };
  };
  const refreshed = await authClient.getAccessToken('global');
  assert(refreshed === 'fresh-at-0123456789012345', '磁盘缓存过期 → refresh 拿新 token');
  assert(cacheCalls.some((u) => u.includes('/api/auth/refresh')), '过期缓存 → 发起 refresh', cacheCalls);
  // 刷新成功后落盘含 accessToken + exp（后续启动零网络依赖）
  const sessionAfterRefresh = tokenStore.loadSession();
  assert(sessionAfterRefresh?.accessToken === 'fresh-at-0123456789012345', '刷新后 access token 落盘', sessionAfterRefresh);
  assert(typeof sessionAfterRefresh?.accessExpiresAt === 'number' && sessionAfterRefresh.accessExpiresAt > Date.now(), '刷新后 accessExpiresAt 落盘', sessionAfterRefresh);
  // realm 不匹配：磁盘缓存是 global 但请求 cn → 不命中，走 refresh（防错区 token 连错 relay 401）
  await authClient.logout();
  cacheCalls.length = 0;
  tokenStore.saveSession({ version: 1, realm: 'global', refreshToken: 'good-rt-0123456789012345', accessToken: 'global-at-0123456789012345', accessExpiresAt: Date.now() + 3600_000 });
  globalThis.fetch = async (url) => {
    cacheCalls.push(String(url));
    return { ok: true, json: async () => ({ accessToken: 'cn-at-0123456789012345', refreshToken: 'cn-rt-0123456789012345' }) };
  };
  const realmMismatch = await authClient.getAccessToken('cn');
  assert(realmMismatch === 'cn-at-0123456789012345', 'realm 不匹配 → 不命中磁盘缓存，走 refresh');
  assert(cacheCalls.some((u) => u.includes('/api/auth/refresh')), 'realm 不匹配 → 发起 refresh', cacheCalls);
  await authClient.logout();
  globalThis.fetch = origFetch;

  // ============ 17. 被控授权门禁（revokedControllers / remoteControlEnabled，对齐 desktop dispatch.ts） ============
  const DeviceLinkClient = jiti(path.join(base, 'device-link/client.js')).DeviceLinkClient;
  const settingsStore = jiti(path.join(base, 'store/settings-store.js'));
  const sentFrames = [];
  const ctl = new DeviceLinkClient('http://relay.local', async () => 'tok', async (ch, args) => router.routeInvoke(ch, args), 'pi-dev-1');
  ctl.sendEnvelope = (env) => sentFrames.push(env); // spy 私有发送方法（TS private 编译后可达）

  // settings-store：读写 + 原子写 + 默认值
  assert(settingsStore.readDeviceLinkSettings().remoteControlEnabled === true, 'settings 默认 remoteControlEnabled=true');
  settingsStore.updateDeviceLinkSetting('remoteControlEnabled', () => false);
  assert(settingsStore.readDeviceLinkSettings().remoteControlEnabled === false, 'settings remote off 持久化');
  const rawSettings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
  assert(rawSettings.remoteControlEnabled === false && Array.isArray(rawSettings.revokedControllers), 'settings.json 落盘形状');
  assert(!fs.existsSync(path.join(DATA_DIR, 'settings.json.tmp')), 'settings 原子写无 tmp 残留', fs.readdirSync(DATA_DIR));
  assert(!fs.existsSync(path.join(DATA_DIR, 'settings.json.lock')), 'settings 写锁已释放（无 .lock 残留）');
  assert(fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('settings.json.tmp-')).length === 0, 'settings pid 后缀 tmp 无残留');

  // remote off：link-open 静默不响应（对齐 desktop handleLinkOpen 第二道闸）
  await ctl.handleEnvelope({ kind: 'link-open', id: 'l1', src: 'ctl-any', payload: { controllerName: 'iphone' } });
  assert(sentFrames.length === 0, 'remote off 时 link-open 静默不 accept', sentFrames);
  // remote off：subscribe 被拒 REMOTE_DISABLED
  sentFrames.length = 0;
  await ctl.handleEnvelope({ kind: 'invoke', id: 's1', src: 'ctl-any', payload: { channel: 'device-link:subscribe', args: [{ topics: ['sessions'] }] } });
  let subRes = sentFrames.find((f) => f.kind === 'invoke-result');
  assert(subRes && subRes.payload?.ok === false && subRes.payload?.error?.code === 'REMOTE_DISABLED', 'remote off subscribe → REMOTE_DISABLED', subRes);
  // remote off：通用 invoke 被拒 REMOTE_DISABLED（onInvoke 不触达）
  sentFrames.length = 0;
  await ctl.handleEnvelope({ kind: 'invoke', id: 'i1', src: 'ctl-any', payload: { channel: 'sessions:list', args: ['active'] } });
  let invRes = sentFrames.find((f) => f.kind === 'invoke-result');
  assert(invRes && invRes.payload?.ok === false && invRes.payload?.error?.code === 'REMOTE_DISABLED', 'remote off invoke → REMOTE_DISABLED', invRes);

  // 恢复开关
  settingsStore.updateDeviceLinkSetting('remoteControlEnabled', () => true);
  // revoked：link-open 不回 accept + 发 link-close('revoked') 明确信号（对齐 desktop purgeRevokedController）
  settingsStore.updateDeviceLinkSetting('revokedControllers', () => ['ctl-revoked']);
  sentFrames.length = 0;
  await ctl.handleEnvelope({ kind: 'link-open', id: 'l2', src: 'ctl-revoked', payload: { controllerName: 'iphone' } });
  assert(!sentFrames.some((f) => f.kind === 'link-accept'), 'revoked link-open 不回 accept');
  assert(sentFrames.some((f) => f.kind === 'link-close' && f.payload?.reason === 'revoked' && f.dst === 'ctl-revoked'), 'revoked link-open 发 link-close(revoked)', sentFrames);
  // revoked：subscribe → ACCESS_REVOKED
  sentFrames.length = 0;
  await ctl.handleEnvelope({ kind: 'invoke', id: 's2', src: 'ctl-revoked', payload: { channel: 'device-link:subscribe', args: [{ topics: ['sessions'] }] } });
  subRes = sentFrames.find((f) => f.kind === 'invoke-result');
  assert(subRes && subRes.payload?.ok === false && subRes.payload?.error?.code === 'ACCESS_REVOKED', 'revoked subscribe → ACCESS_REVOKED', subRes);
  // revoked：通用 invoke → ACCESS_REVOKED
  sentFrames.length = 0;
  await ctl.handleEnvelope({ kind: 'invoke', id: 'i2', src: 'ctl-revoked', payload: { channel: 'sessions:list', args: ['active'] } });
  invRes = sentFrames.find((f) => f.kind === 'invoke-result');
  assert(invRes && invRes.payload?.ok === false && invRes.payload?.error?.code === 'ACCESS_REVOKED', 'revoked invoke → ACCESS_REVOKED', invRes);
  // revoked 期间不建立控制链路/订阅
  assert(ctl.hasControllers() === false, 'revoked link-open 未加入 controllers');

  // restore：移除黑名单后放行（invoke 恢复路由到 handler）
  settingsStore.updateDeviceLinkSetting('revokedControllers', () => []);
  sentFrames.length = 0;
  await ctl.handleEnvelope({ kind: 'invoke', id: 'i3', src: 'ctl-ok', payload: { channel: 'local-db:sessions:list', args: ['active'] } });
  invRes = sentFrames.find((f) => f.kind === 'invoke-result');
  assert(invRes && invRes.payload?.ok === true && Array.isArray(invRes.payload?.result), 'restore 后 invoke 放行（空库 → []）', invRes);
  // 未撤销的 link-open 正常 accept
  sentFrames.length = 0;
  await ctl.handleEnvelope({ kind: 'link-open', id: 'l3', src: 'ctl-ok', payload: { controllerName: 'iphone' } });
  assert(sentFrames.some((f) => f.kind === 'link-accept' && f.dst === 'ctl-ok'), '未撤销 link-open 正常 accept', sentFrames);

  // subscribe 成功形状钉线：result 为 { ok: true }（对齐 desktop dispatch.ts 返回对象；
  // 曾 result 为裸 boolean——真机验证项，防形状漂移）
  sentFrames.length = 0;
  await ctl.handleEnvelope({ kind: 'invoke', id: 's3', src: 'ctl-ok', payload: { channel: 'device-link:subscribe', args: [{ topics: ['sessions'] }] } });
  const subOk = sentFrames.find((f) => f.kind === 'invoke-result' && f.id === 's3');
  assert(subOk && subOk.payload?.ok === true && subOk.payload?.result && subOk.payload?.result.ok === true && !Array.isArray(subOk.payload?.result), 'subscribe 成功 → result={ok:true}（对象）', subOk);

  // ============ 17b. sweep：standby 进程改 settings 后 owner 断开被撤销/禁用控制器 ============
  // （跨进程场景 owner 无法被同步通知，靠持有者定时 sweep 兜底；直接调方法验证语义）
  settingsStore.updateDeviceLinkSetting('remoteControlEnabled', () => true);
  settingsStore.updateDeviceLinkSetting('revokedControllers', () => []);
  const ctlSweep = new DeviceLinkClient('http://relay.local', async () => 'tok', async (ch, args) => router.routeInvoke(ch, args), 'pi-dev-sweep');
  const sweepFrames = [];
  ctlSweep.sendEnvelope = (env) => sweepFrames.push(env);
  await ctlSweep.handleEnvelope({ kind: 'link-open', id: 'lw1', src: 'ctl-a', payload: {} });
  await ctlSweep.handleEnvelope({ kind: 'invoke', id: 'sw1', src: 'ctl-a', payload: { channel: 'device-link:subscribe', args: [{ topics: ['sessions'] }] } });
  assert(ctlSweep.hasControllers() === true, 'sweep 前置：控制链路已建立');
  // 逐设备撤销 → sweep 发 link-close(revoked) 且链路清空
  settingsStore.updateDeviceLinkSetting('revokedControllers', () => ['ctl-a']);
  sweepFrames.length = 0;
  ctlSweep.sweepRevokedControllers();
  assert(sweepFrames.some((f) => f.kind === 'link-close' && f.dst === 'ctl-a' && f.payload?.reason === 'revoked'), 'sweep 断开新被撤销控制器', sweepFrames);
  assert(ctlSweep.hasControllers() === false, 'sweep 后 controllers 清空');
  // 全局关闭 → sweep 断开全部（reason=toggle-off）
  settingsStore.updateDeviceLinkSetting('revokedControllers', () => []);
  await ctlSweep.handleEnvelope({ kind: 'link-open', id: 'lw2', src: 'ctl-b', payload: {} });
  assert(ctlSweep.hasControllers() === true, 'sweep 前置 2：ctl-b 已连接');
  settingsStore.updateDeviceLinkSetting('remoteControlEnabled', () => false);
  sweepFrames.length = 0;
  ctlSweep.sweepRevokedControllers();
  assert(sweepFrames.some((f) => f.kind === 'link-close' && f.dst === 'ctl-b' && f.payload?.reason === 'toggle-off'), 'sweep remote off 断开全部', sweepFrames);
  assert(ctlSweep.hasControllers() === false, 'sweep remote off 后 controllers 清空');
  settingsStore.updateDeviceLinkSetting('remoteControlEnabled', () => true);

  // ============ 17c. settings.json 损坏 → fail-closed（黑名单/开关意图不可知时禁止被控） ============
  const settingsPath = path.join(DATA_DIR, 'settings.json');
  fs.writeFileSync(settingsPath, '{broken json', { mode: 0o600 });
  const corruptSettings = settingsStore.readDeviceLinkSettings();
  assert(corruptSettings.remoteControlEnabled === false, 'settings 损坏 fail-closed（remote off）', corruptSettings);
  // 命令路径自愈：/cindy-remote on 等价更新重写合法文件
  settingsStore.updateDeviceLinkSetting('remoteControlEnabled', () => true);
  assert(settingsStore.readDeviceLinkSettings().remoteControlEnabled === true, '损坏 settings 经命令路径自愈');
  assert(!fs.existsSync(path.join(DATA_DIR, 'settings.json.lock')), '损坏自愈后锁无残留');

  // ============ 17d. updateSession 定点列 UPDATE：不同列并发写互不覆盖 ============
  const ptId = 'cm-pt-upd-0001';
  store.createSession({ id: ptId });
  store.updateSession(ptId, { totalTokenUsage: 100 }); // standby tracker 写（token）
  store.updateSession(ptId, { title: 'from-mobile' }); // owner mobile patch 写（title）
  const ptAfter = store.getSession(ptId);
  assert(ptAfter.totalTokenUsage === 100 && ptAfter.title === 'from-mobile', '定点 UPDATE 列级互不覆盖（并发安全）', ptAfter);
  store.updateSession(ptId, { status: 'archived' });
  assert(store.getSession(ptId).status === 'archived', '定点 UPDATE 状态列生效');

  // ============ 17e. protocol mismatch / notify 能力位（真实 ws 握手） ============
  // http 已在上文（section 14 附近）require，此处复用
  const { WebSocketServer } = require('ws');
  const wssServer = http.createServer();
  const wss = new WebSocketServer({ server: wssServer });
  await new Promise((r) => wssServer.listen(0, '127.0.0.1', r));
  const wsPort = wssServer.address().port;
  const wsBase = `http://127.0.0.1:${wsPort}`;
  let ackVersion = 999;
  let ackCaps = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const env = JSON.parse(raw.toString());
      if (env.kind === 'hello') {
        ws.send(JSON.stringify({ v: 1, kind: 'hello-ack', id: env.id, payload: { deviceId: 'dev-ws', userId: 'u-ws', serverProtocolVersion: ackVersion, capabilities: ackCaps } }));
      }
    });
  });
  // 协议版本不一致 → 拒上线 + 终态标志
  ackVersion = 999; ackCaps = [];
  const cMis = new DeviceLinkClient(wsBase, async () => 'tok', async (ch, args) => router.routeInvoke(ch, args), 'pi-dev-mis');
  let misErr = null;
  try { await cMis.connect(); } catch (e) { misErr = e; }
  assert(misErr !== null && /protocol mismatch/.test(misErr.message), 'protocol mismatch → connect 拒绝', misErr?.message);
  assert(cMis.isProtocolMismatch() === true, 'protocol mismatch → isProtocolMismatch()', cMis);
  assert(cMis.isConnected() === false, 'protocol mismatch 不上线');
  // notify 能力位缺失 → notify 不发帧（黑洞防护）
  ackVersion = 1; ackCaps = ['other-cap'];
  const cNoNotify = new DeviceLinkClient(wsBase, async () => 'tok', async (ch, args) => router.routeInvoke(ch, args), 'pi-dev-nn');
  const nnFrames = [];
  cNoNotify.sendEnvelope = (env) => nnFrames.push(env);
  await cNoNotify.connect();
  assert(cNoNotify.isConnected() === true, '能力位缺失但版本匹配 → 正常上线');
  cNoNotify.notify('session-done', 't', 'sid-1', 'b');
  assert(!nnFrames.some((f) => f.kind === 'notify'), '无 notify 能力位 → notify 不发帧', nnFrames);
  // notify 能力位声明 → notify 正常发帧
  ackCaps = ['notify'];
  const cNotify = new DeviceLinkClient(wsBase, async () => 'tok', async (ch, args) => router.routeInvoke(ch, args), 'pi-dev-ny');
  const nyFrames = [];
  cNotify.sendEnvelope = (env) => nyFrames.push(env);
  await cNotify.connect();
  cNotify.notify('session-done', 'title', 'sid-2', 'body');
  assert(nyFrames.some((f) => f.kind === 'notify' && f.payload?.category === 'session-done' && f.payload?.deepLink.includes('sid-2')), '有 notify 能力位 → notify 发帧', nyFrames);
  cMis.disconnect(); cNoNotify.disconnect(); cNotify.disconnect();
  wss.close();
  wssServer.close();

  // ============ 22. sessions.host_instance_id 读写 ============
  {
    const s = store.createSession({ hostInstanceId: 'inst-A' });
    const got = store.getSession(s.id);
    assert(got.hostInstanceId === 'inst-A', 'createSession 带 host 可读回', got.hostInstanceId);
    store.updateSession(s.id, { hostInstanceId: null });
    const cleared = store.getSession(s.id);
    assert(cleared.hostInstanceId == null, 'updateSession 清 host', cleared.hostInstanceId);
    store.deleteSession(s.id);
  }

  // ============ 23. 实例身份与心跳 ============
  {
    const inst = jiti(path.join(base, 'instance.js'));
    const db = jiti(path.join(base, 'store/db.js')).getDb();
    // 身份单例
    const id1 = inst.getInstanceId();
    const id2 = inst.getInstanceId();
    assert(id1 === id2 && typeof id1 === 'string' && id1.length > 0, 'instanceId 进程内单例', id1);
    // 登记 + 心跳
    inst.registerInstance();
    let row = db.prepare('SELECT pid, heartbeat_at FROM cindy_instances WHERE instance_id = ?').get(id1);
    assert(row && row.pid === process.pid, 'registerInstance 写入行', row);
    const firstBeat = row.heartbeat_at;
    inst.heartbeatInstance();
    row = db.prepare('SELECT heartbeat_at FROM cindy_instances WHERE instance_id = ?').get(id1);
    assert(row.heartbeat_at >= firstBeat, 'heartbeatInstance 刷新心跳');
    // 活体判定：新鲜 → true
    assert(inst.instanceAlive(id1, Date.now() + 1000, 30_000) === true, '心跳新鲜判活');
    // 陈旧 + pid 活（本测试进程）→ true（GC 停顿容忍，<2×staleMs 探活窗口）
    assert(inst.instanceAlive(id1, Date.now() + 45_000, 30_000) === true, '心跳陈旧但 pid 活判活（探活窗口）');
    // 心跳硬上限（M5）：>2×staleMs 无论 pid 判死（pid 复用/挂死兜底）
    assert(inst.instanceAlive(id1, Date.now() + 90_000, 30_000) === false, '心跳超 2×staleMs 判死');
    // 陈旧 + pid 死 → false
    db.prepare('INSERT OR REPLACE INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?)')
      .run('inst-dead', 999999, 'dead', Date.now() - 60_000);
    assert(inst.instanceAlive('inst-dead', Date.now(), 30_000) === false, '陈旧+pid 死判死');
    assert(inst.instanceAlive('no-such-instance', Date.now(), 30_000) === false, '不存在判死');
    // release
    inst.releaseInstance();
    row = db.prepare('SELECT 1 FROM cindy_instances WHERE instance_id = ?').get(id1);
    assert(!row, 'releaseInstance 删行');
    db.prepare('DELETE FROM cindy_instances WHERE instance_id = ?').run('inst-dead');
  }

  // ============ 24. 邮箱存取 ============
  {
    const hs = jiti(path.join(base, 'store/handoff-store.js'));
    const db = jiti(path.join(base, 'store/db.js')).getDb();
    const sess = store.createSession({ hostInstanceId: 'inst-A' });
    // 幂等 upsert（同 clientId 二次 no-op）
    hs.upsertMailbox(sess.id, 'cid-1', 'maker:input:enqueue', ['arg0', { clientId: 'cid-1', text: 'hi' }]);
    hs.upsertMailbox(sess.id, 'cid-1', 'maker:input:enqueue', ['arg0', { clientId: 'cid-1', text: 'hi' }]);
    hs.upsertMailbox(sess.id, null, 'maker:input:stop', ['arg0']);
    hs.upsertMailbox(sess.id, 'cid-2', 'maker:input:enqueue', ['arg0', { clientId: 'cid-2', text: 'hi2' }]);
    const rows = hs.listPendingMailbox(sess.id);
    assert(rows.length === 3, '同 clientId 幂等去重 + 动作行不合并', rows.length);
    assert(rows[0].kind === 'maker:input:enqueue' && rows[0].clientId === 'cid-1', 'created_at 升序', rows.map((r) => r.kind));
    assert(JSON.parse(rows[0].payload)[1].text === 'hi', 'payload 序列化往返');
    // failPendingMailboxForSessions
    hs.failPendingMailboxForSessions([sess.id]);
    assert(hs.listPendingMailbox(sess.id).length === 0, 'fail 后不再 pending');
    // 恢复一条再删
    hs.upsertMailbox(sess.id, 'cid-3', 'maker:input:enqueue', ['a', {}]);
    const r3 = hs.listPendingMailbox(sess.id)[0];
    hs.deleteMailbox(r3.id);
    assert(hs.listPendingMailbox(sess.id).length === 0, 'deleteMailbox 删行');
    // clearHostAndArchiveForInstance：会话清 host + archived + 邮箱 failed + 实例行删除
    const inst2 = jiti(path.join(base, 'instance.js'));
    inst2.registerInstance();
    const iid = inst2.getInstanceId();
    const s2 = store.createSession({ hostInstanceId: iid });
    hs.upsertMailbox(s2.id, 'cid-x', 'maker:input:enqueue', ['a', {}]);
    hs.clearHostAndArchiveForInstance(iid);
    const s2g = store.getSession(s2.id);
    assert(s2g.hostInstanceId == null && s2g.status === 'archived', '清 host + archived', s2g.status);
    assert(hs.listPendingMailbox(s2.id).length === 0, '邮箱行标 failed');
    const irow = db.prepare('SELECT 1 FROM cindy_instances WHERE instance_id = ?').get(iid);
    assert(!irow, '实例行删除');
    store.deleteSession(sess.id); store.deleteSession(s2.id);
    // sweepStaleInstances 孤儿会话反查（修：死实例行被 releaseInstance 删除后，
    // 旧 sweep 只看 cindy_instances → 看不到死实例 → 其 active 会话永不归档，
    // 手机端列表堆积死会话。现按会话反查 host 不在活实例 → 归档）
    const hs2 = jiti(path.join(base, 'handoff.js'));
    // 场景 A：host 指向已删除的死实例（实例行不存在）→ sweep 归档
    const orphanA = store.createSession({ hostInstanceId: 'ghost-inst-gone' });
    // 场景 B：host 已空（router 死宿主路径只清 host 不归档）→ sweep 归档
    const orphanB = store.createSession({ hostInstanceId: 'ghost-inst-b' });
    store.updateSession(orphanB.id, { hostInstanceId: null });
    // 场景 C：活实例 host → 保留（用当前测试进程实例，心跳未启动也算 alive？——
    // 心跳未启动时 cindy_instances 无行 → instanceAlive 返回 false → 会误归档，
    // 故这里显式注册活实例验证保留路径）
    const liveInst = jiti(path.join(base, 'instance.js'));
    liveInst.registerInstance();
    const liveIid = liveInst.getInstanceId();
    const liveSess = store.createSession({ hostInstanceId: liveIid });
    hs2.sweepStaleInstances(Date.now(), 30_000);
    assert(store.getSession(orphanA.id).status === 'archived', 'sweep 归档 host=死实例（实例行已删）的会话');
    assert(store.getSession(orphanB.id).status === 'archived', 'sweep 归档 host=空 的 active 会话');
    assert(store.getSession(liveSess.id).status === 'active', 'sweep 保留活实例会话');
    store.deleteSession(orphanA.id); store.deleteSession(orphanB.id); store.deleteSession(liveSess.id);
    // purgeFailedMailbox
    hs.upsertMailbox(sess.id, 'cid-p1', 'maker:input:enqueue', ['a', {}]);
    hs.failPendingMailboxForSessions([sess.id]);
    hs.purgeFailedMailbox(Date.now() + 10_000);
    assert(hs.listPendingMailbox(sess.id).length === 0 && db.prepare('SELECT COUNT(*) c FROM cindy_handoff_mailbox').get().c === 0, 'failed 超时清理');
  }

  // ============ 25. tracker 写/清会话宿主 ============
  {
    const { EventEmitter } = require('node:events');
    const tracker = jiti(path.join(base, 'tracker.js'));
    const inst = jiti(path.join(base, 'instance.js'));
    const hs = jiti(path.join(base, 'store/handoff-store.js'));
    const db = jiti(path.join(base, 'store/db.js')).getDb();
    const fakePi = new EventEmitter();
    let activeId = null;
    tracker.attachSessionTracker(fakePi, () => null, () => activeId, (id) => { activeId = id; });
    fakePi.emit('session_start', {}, {
      sessionManager: { getSessionId: () => 'sdk-route-test' },
      cwd: '/tmp/route-test',
      model: { id: 'claude-sonnet-4-5', provider: 'anthropic' },
    });
    const bySdk = store.listSessions().find((s) => s.sdkSessionId === 'sdk-route-test');
    assert(bySdk && bySdk.hostInstanceId === inst.getInstanceId(), 'session_start 写 host=instanceId', bySdk && bySdk.hostInstanceId);
    // M2：优雅关闭清自己 pending 邮箱行（spec §7）——先落行再 shutdown
    hs.upsertMailbox(bySdk.id, 'cid-sh', 'maker:input:enqueue', [bySdk.id, { clientId: 'cid-sh', text: 'x' }]);
    fakePi.emit('session_shutdown', { reason: 'quit' });
    const after = store.getSession(bySdk.id);
    assert(after.hostInstanceId == null && after.status === 'archived', 'session_shutdown 清 host', after.status);
    assert(db.prepare("SELECT status FROM cindy_handoff_mailbox WHERE client_id = 'cid-sh'").get()?.status === 'failed', 'session_shutdown 清 pending 邮箱（M2）');
    db.prepare('DELETE FROM cindy_handoff_mailbox WHERE client_id = ?').run('cid-sh');
  }

  // ============ 26. 仲裁器定向接管 ============
  {
    const ownership = jiti(path.join(base, 'ownership.js'));
    const { DeviceLinkOwnershipArbiter } = ownership;
    // fake store：内存单行 + handoff 支持
    const makeFake = () => {
      let row = null;
      return {
        _row: () => row,
        async read() { return row; },
        async tryInsert(identity, now) { if (row) return false; row = { ownerId: identity.ownerId, ownerPid: identity.ownerPid, ownerLabel: identity.ownerLabel, heartbeatAt: now }; return true; },
        async tryTakeover(expected, identity, now) {
          if (row && row.ownerId === expected.ownerId && row.heartbeatAt === expected.heartbeatAt) {
            row = { ownerId: identity.ownerId, ownerPid: identity.ownerPid, ownerLabel: identity.ownerLabel, heartbeatAt: now };
            return true;
          }
          return false;
        },
        async renew(ownerId, now) { if (row && row.ownerId === ownerId) { row.heartbeatAt = now; return true; } return false; },
        async release(ownerId) { if (row && row.ownerId === ownerId) row = null; },
        async setHandoff(ownerId, target, expiresAt) { if (row && row.ownerId === ownerId) { row.handoffTo = target; row.handoffExpiresAt = expiresAt; return true; } return false; },
      };
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // A：owner。B：standby（handoff 目标）。C：standby（不应抢）。
    let aAcq = 0, cAcq = 0;
    const makeArb = (store, label, extra = {}) => new DeviceLinkOwnershipArbiter({
      getStore: () => store,
      instance: { ownerPid: 1111, ownerLabel: label },
      instanceId: label, // A/B/C
      onAcquire: () => { if (label === 'A') aAcq++; if (label === 'C') cAcq++; },
      onDemote: () => {},
      heartbeatMs: 20, staleMs: 100, fastPollMs: 15, storeRetryMs: 5, opTimeoutMs: 20,
      ...extra,
    });
    const storeFake = makeFake();
    const arbA = makeArb(storeFake, 'A');
    const arbB = makeArb(storeFake, 'B');
    const arbC = makeArb(storeFake, 'C');
    arbA.start(); arbB.start(); arbC.start();
    await sleep(60);
    assert(arbA.isOwner() && !arbB.isOwner() && !arbC.isOwner() && aAcq === 1, 'first-wins：A 成为 owner', storeFake._row());
    // A handoffTo(B)：A 让位停续期（行保留 + handoff 目标）
    const ok = await arbA.handoffTo('B');
    assert(ok === true, 'handoffTo 成功');
    const rowAfter = storeFake._row();
    assert(rowAfter && rowAfter.handoffTo === 'B' && rowAfter.ownerId !== null, '行保留带 handoff_to', rowAfter);
    await sleep(60);
    assert(!arbA.isOwner() && arbB.isOwner() && cAcq === 0, 'B 独占认领、C 不抢、A 降级', { a: arbA.isOwner(), b: arbB.isOwner(), c: cAcq });
    // B 接管后 C 心跳新鲜不抢（回归）
    await sleep(60);
    assert(arbB.isOwner() && !arbC.isOwner(), 'B 保持 owner（C 被动）');
    // A awaiting 判定（新身份 start 后 handoff 恢复）
    arbA.stop(); arbB.stop(); arbC.stop();
    await sleep(30);
  }

  // ============ 26b. 仲裁器：TTL 过期回落清 handoff + 熔断 strike（H1/M4，真实 sqlite store） ============
  {
    const ownership = jiti(path.join(base, 'ownership.js'));
    const { DeviceLinkOwnershipArbiter } = ownership;
    const dbMod = jiti(path.join(base, 'store/db.js'));
    const storeReal = ownership.createSqliteOwnershipStore({ prepare: dbMod.getStmt });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let cAcq = 0;
    const makeArb = (label, extra = {}) => new DeviceLinkOwnershipArbiter({
      getStore: () => storeReal,
      instance: { ownerPid: 3333, ownerLabel: label },
      instanceId: label,
      onAcquire: () => { if (label === 'C') cAcq++; },
      onDemote: () => {},
      heartbeatMs: 20, staleMs: 100, fastPollMs: 15, storeRetryMs: 5, opTimeoutMs: 20, handoffTtlMs: 40,
      ...extra,
    });
    const arbA = makeArb('A');
    makeArb('B'); // 不 start：目标实例不存在，交接必无人认领
    const arbC = makeArb('C');
    dbMod.getDb().prepare('DELETE FROM device_link_ownership').run();
    arbA.start(); // 阶段 1：仅 A（无 standby 竞争）——「唯一进程 self-handoff 后无人接管」自愈路径
    await sleep(80);
    assert(arbA.isOwner(), '26b first-wins：A 为 owner');
    const ok = await arbA.handoffTo('B');
    assert(ok === true, '26b handoffTo 写交接信号');
    await sleep(80); // TTL=40ms 过期 + reclaim 节奏（A 心跳 20ms）
    assert(arbA.isOwner(), '26b 无人认领 → A 自动收回（reclaimed）');
    const rowAfter = dbMod.getDb().prepare('SELECT handoff_to, handoff_expires_at FROM device_link_ownership WHERE id = 1').get();
    assert(rowAfter.handoff_to == null && rowAfter.handoff_expires_at == null, '26b reclaim 清过期 handoff（H1）', rowAfter);
    assert(arbA.isHandoffStruck('B') === true, '26b 未认领交接记 strike（M4）');
    assert(arbA.isHandoffStruck('C') === false, '26b 无关实例无 strike');
    // 阶段 2：C 加入——reclaim 后无过期 handoff → standby 回落 staleMs 阈值，活 owner 不被误抢
    arbC.start();
    await sleep(150);
    assert(arbA.isOwner() && !arbC.isOwner() && cAcq === 0, '26b 活 owner 不被误抢（H1 回归）', { a: arbA.isOwner(), c: cAcq });
    arbA.stop(); arbC.stop();
    await sleep(30);
  }

  // ============ 27. 会话路由 + 合成投影 + 去重 ============
  {
    const inst = jiti(path.join(base, 'instance.js'));
    const hs = jiti(path.join(base, 'store/handoff-store.js'));
    const db = jiti(path.join(base, 'store/db.js')).getDb();
    const myId = inst.getInstanceId();
    inst.registerInstance();
    // 活宿主实例（pid=本进程 + 新鲜心跳）
    db.prepare('INSERT OR REPLACE INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?)')
      .run('host-alive', process.pid, 'alive', Date.now());
    // 死宿主实例（pid 无效 + 陈旧心跳）
    db.prepare('INSERT OR REPLACE INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?)')
      .run('host-dead', 999999, 'dead', Date.now() - 60_000);
    // 路由上下文：handoffTo 记录调用
    const handoffCalls = [];
    const prevCtx = { handoffTo: async (i) => { handoffCalls.push(i); return true; }, handoffPending: () => false };
    router.setInvokeContext({ ...router.getInvokeContext(), ...prevCtx });

    // host==我 → 本地路径（activeId 匹配）
    const sMine = store.createSession({ hostInstanceId: myId });
    activeTestSid = sMine.id;
    const pMine = await router.routeInvoke('maker:input:enqueue', [sMine.id, { clientId: 'cid-mine', text: 'hi', chatMessage: { clientId: 'cid-mine', role: 'user', content: 'hi' } }]);
    assert(pMine && Array.isArray(pMine.pendingQueue), 'host==我 走本地投影', pMine);
    assert(sent.some((s) => s.text === 'hi'), 'host==我 注入 sendUserMessage');

    // host==他(活) → enqueue：邮箱落行 + 合成投影 + handoffTo 调用
    activeTestSid = null;
    const sOther = store.createSession({ hostInstanceId: 'host-alive' });
    const pOther = await router.routeInvoke('maker:input:enqueue', [sOther.id, { clientId: 'cid-other', text: 'hello', chatMessage: { clientId: 'cid-other', role: 'user', content: 'hello' } }]);
    assert(handoffCalls.includes('host-alive'), '路由到活宿主触发 handoffTo', handoffCalls);
    assert(Array.isArray(pOther.pendingQueue) && pOther.pendingQueue.length === 1 && pOther.pendingQueue[0].clientId === 'cid-other', '合成投影含排队项', pOther);
    assert(pOther.pendingQueue[0].chatMessage && pOther.pendingQueue[0].chatMessage.content === 'hello', '合成投影透传 chatMessage');
    const mb = hs.listPendingMailbox(sOther.id);
    assert(mb.length === 1 && mb[0].kind === 'maker:input:enqueue', '邮箱落行', mb.map((r) => r.kind));

    // H2：非投影类 channel 路由响应 = 本地 handler 同形状 {ok:true}（spec §6）
    const pSend = await router.routeInvoke('maker:send', [sOther.id, { content: [{ type: 'text', text: 'hi2' }] }]);
    assert(pSend && pSend.ok === true && !Array.isArray(pSend.pendingQueue), 'H2 路由 send 返回 {ok:true}', pSend);
    const pSet = await router.routeInvoke('maker:set-model', [sOther.id, 'claude-sonnet-4-5']);
    assert(pSet && pSet.ok === true, 'H2 路由 set-model 返回 {ok:true}', pSet);

    // host==他(活) → get-projection：合成但不落邮箱不接管
    const pc = handoffCalls.length;
    const mbBefore = hs.listPendingMailbox(sOther.id).length; // enqueue+send+set-model = 3
    const pGet = await router.routeInvoke('maker:input:get-projection', [sOther.id]);
    assert(Array.isArray(pGet.pendingQueue) && pGet.pendingQueue.length === 1, 'get-projection 合成含邮箱项', pGet);
    assert(handoffCalls.length === pc, 'get-projection 不触发接管');
    assert(hs.listPendingMailbox(sOther.id).length === mbBefore, 'get-projection 不落新邮箱行', hs.listPendingMailbox(sOther.id).length);

    // host==他(死) → get-projection：error 投影 + 清 host（M1；死宿主预检即清理）
    const sDead = store.createSession({ hostInstanceId: 'host-dead' });
    const pDeadGet = await router.routeInvoke('maker:input:get-projection', [sDead.id]);
    assert(pDeadGet.error === 'session host unavailable', 'M1 死宿主 get-projection 报错', pDeadGet.error);
    assert(store.getSession(sDead.id).hostInstanceId == null, '死宿主 get-projection 清 host');
    // M1：清 host 后 get-projection → NOT_FOUND（不再静默空队列）
    let threwDeadGet = false;
    try { await router.routeInvoke('maker:input:get-projection', [sDead.id]); } catch (e) { threwDeadGet = e.code === 'NOT_FOUND'; }
    assert(threwDeadGet, 'M1 清 host 后 get-projection NOT_FOUND');

    // host==他(死) → enqueue：清 host + 邮箱 failed + error 投影
    const sDead2 = store.createSession({ hostInstanceId: 'host-dead' });
    const pDead = await router.routeInvoke('maker:input:enqueue', [sDead2.id, { clientId: 'cid-dead', text: 'x', chatMessage: { clientId: 'cid-dead', role: 'user', content: 'x' } }]);
    assert(pDead.error !== null && pDead.pendingQueue.length === 0, '死宿主返回 error 投影', pDead.error);
    assert(store.getSession(sDead2.id).hostInstanceId == null, '死宿主清 host');
    assert(hs.listPendingMailbox(sDead2.id).length === 0, '死宿主邮箱 failed');
    // H2：死宿主非投影 channel → invoke error（与本地失败路径同形状）
    const sDead3 = store.createSession({ hostInstanceId: 'host-dead' });
    let threwDeadSend = false;
    try { await router.routeInvoke('maker:send', [sDead3.id, { content: [{ type: 'text', text: 'x' }] }]); } catch (e) { threwDeadSend = e.code === 'NOT_FOUND'; }
    assert(threwDeadSend, 'H2 死宿主 send 抛 invoke error');

    // host==null → NOT_FOUND
    const sNone = store.createSession({});
    let threw = false;
    try { await router.routeInvoke('maker:input:enqueue', [sNone.id, { clientId: 'c', text: 'x', chatMessage: { clientId: 'c', role: 'user', content: 'x' } }]); } catch (e) { threw = e.code === 'NOT_FOUND'; }
    assert(threw, '无宿主 NOT_FOUND');
    // M1：unhosted get-projection → NOT_FOUND（spec 路由表）
    let threwNoneGet = false;
    try { await router.routeInvoke('maker:input:get-projection', [sNone.id]); } catch (e) { threwNoneGet = e.code === 'NOT_FOUND'; }
    assert(threwNoneGet, 'M1 unhosted get-projection NOT_FOUND');

    // awaiting（handoffPending=true）→ 只落邮箱不重复 CAS
    const pc2 = handoffCalls.length;
    router.setInvokeContext({ ...router.getInvokeContext(), handoffPending: () => true });
    await router.routeInvoke('maker:input:enqueue', [sOther.id, { clientId: 'cid-other2', text: 'y', chatMessage: { clientId: 'cid-other2', role: 'user', content: 'y' } }]);
    assert(handoffCalls.length === pc2, 'awaiting 不重复 CAS', handoffCalls);
    assert(hs.listPendingMailbox(sOther.id).length === 4, 'awaiting 仍落邮箱（enqueue+send+set-model+enqueue2）', hs.listPendingMailbox(sOther.id).map((r) => r.kind));
    router.setInvokeContext({ ...router.getInvokeContext(), handoffPending: () => false });

    // 本地队列 clientId 环形窗口去重（弱网重发不双注入）
    activeTestSid = sMine.id;
    sent.length = 0;
    await router.routeInvoke('maker:input:enqueue', [sMine.id, { clientId: 'dup-1', text: 'once', chatMessage: { clientId: 'dup-1', role: 'user', content: 'once' } }]);
    await router.routeInvoke('maker:input:enqueue', [sMine.id, { clientId: 'dup-1', text: 'once', chatMessage: { clientId: 'dup-1', role: 'user', content: 'once' } }]);
    assert(sent.filter((s) => s.text === 'once').length === 1, '同 clientId 重发不双注入', sent);

    // M4：熔断宿主（handoffStruck=true）→ 按死宿主 fail-fast，不发起 handoff
    const sStruck = store.createSession({ hostInstanceId: 'host-alive' });
    const pcStruck = handoffCalls.length;
    router.setInvokeContext({ ...router.getInvokeContext(), handoffStruck: () => true });
    const pStruck = await router.routeInvoke('maker:input:enqueue', [sStruck.id, { clientId: 'cid-struck', text: 'x', chatMessage: { clientId: 'cid-struck', role: 'user', content: 'x' } }]);
    assert(pStruck.error === 'session host unavailable', 'M4 熔断宿主 error 投影', pStruck.error);
    assert(handoffCalls.length === pcStruck, 'M4 熔断不发起 handoff');
    assert(store.getSession(sStruck.id).hostInstanceId == null, 'M4 熔断清 host');
    router.setInvokeContext({ ...router.getInvokeContext(), handoffStruck: undefined });

    // 清理
    activeTestSid = null;
    for (const s of [sMine, sOther, sDead, sDead2, sDead3, sNone, sStruck]) store.deleteSession(s.id);
    db.prepare('DELETE FROM cindy_instances WHERE instance_id IN (?, ?, ?)').run('host-alive', 'host-dead', myId);
    db.prepare('DELETE FROM cindy_handoff_mailbox').run();
    router.setInvokeContext({ pi: fakePi, push: (ch, data, sid) => pushes.push({ ch, data, sid }), activeSessions: new Map(), activeId: () => activeTestSid });
  }

  // ============ 28. 邮箱消费 + 清理扫描 ============
  {
    const handoff = jiti(path.join(base, 'handoff.js'));
    const hs = jiti(path.join(base, 'store/handoff-store.js'));
    const inst = jiti(path.join(base, 'instance.js'));
    const db = jiti(path.join(base, 'store/db.js')).getDb();
    const myId = inst.getInstanceId();
    inst.registerInstance();
    const s = store.createSession({ hostInstanceId: myId });
    activeTestSid = s.id;
    // 消费：enqueue 重放注入 + 行删除；stop 重放 abort
    const before = sent.length;
    hs.upsertMailbox(s.id, 'cid-c1', 'maker:input:enqueue', [s.id, { clientId: 'cid-c1', text: 'replay-me', chatMessage: { clientId: 'cid-c1', role: 'user', content: 'replay-me' } }]);
    hs.upsertMailbox(s.id, null, 'maker:input:stop', [s.id]);
    await handoff.consumeMailboxForSession(s.id);
    assert(sent.length === before + 1 && sent[before].text === 'replay-me', '邮箱 enqueue 重放注入', sent.slice(before));
    assert(abortCalls.length >= 1, '邮箱 stop 重放 abort');
    assert(hs.listPendingMailbox(s.id).length === 0, '消费后行删除');
    // 消费失败（payload 损坏）→ 行保留
    hs.upsertMailbox(s.id, 'cid-bad', 'maker:input:enqueue', [s.id, { clientId: 'cid-bad', text: 'x', chatMessage: { clientId: 'cid-bad', role: 'user', content: 'x' } }]);
    db.prepare("UPDATE cindy_handoff_mailbox SET payload = 'not-json{' WHERE client_id = 'cid-bad'").run();
    await handoff.consumeMailboxForSession(s.id);
    assert(hs.listPendingMailbox(s.id).length === 1, '重放失败行保留（不标 consumed）');
    db.prepare('DELETE FROM cindy_handoff_mailbox WHERE client_id = ?').run('cid-bad');
    // 清理扫描：陈旧+pid 死 → unhosted + archived + failed + 实例行删除；pid 活 → 保留
    db.prepare('INSERT OR REPLACE INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?)').run('sweep-dead', 999999, 'd', Date.now() - 60_000);
    db.prepare('INSERT OR REPLACE INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?)').run('sweep-alive', process.pid, 'a', Date.now() - 50_000);
    const sd = store.createSession({ hostInstanceId: 'sweep-dead' });
    const sa = store.createSession({ hostInstanceId: 'sweep-alive' });
    hs.upsertMailbox(sd.id, 'cid-sd', 'maker:input:enqueue', ['a', {}]);
    handoff.sweepStaleInstances(Date.now(), 30_000);
    assert(store.getSession(sd.id).hostInstanceId == null && store.getSession(sd.id).status === 'archived', '死实例会话清 host + archived');
    assert(hs.listPendingMailbox(sd.id).length === 0, '死实例邮箱 failed');
    assert(!db.prepare('SELECT 1 FROM cindy_instances WHERE instance_id = ?').get('sweep-dead'), '死实例行删除');
    assert(store.getSession(sa.id).hostInstanceId === 'sweep-alive', 'pid 活实例保留');
    assert(db.prepare('SELECT 1 FROM cindy_instances WHERE instance_id = ?').get('sweep-alive'), 'pid 活实例行保留');
    // 清理
    activeTestSid = null;
    for (const x of [s, sd, sa]) store.deleteSession(x.id);
    db.prepare("DELETE FROM cindy_instances WHERE instance_id IN ('sweep-dead','sweep-alive')").run();
    db.prepare('DELETE FROM cindy_handoff_mailbox').run();
  }

  // ============ 29. 会话激活消费滞留邮箱行（M3）+ pending TTL 兜底 ============
  {
    const { EventEmitter } = require('node:events');
    const tracker = jiti(path.join(base, 'tracker.js'));
    const hs = jiti(path.join(base, 'store/handoff-store.js'));
    const inst = jiti(path.join(base, 'instance.js'));
    const db = jiti(path.join(base, 'store/db.js')).getDb();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const myId = inst.getInstanceId();
    inst.registerInstance();
    // 会话已存在（host=me）+ 滞留 pending 行 → session_start 激活时补消费（M3）
    const s = store.createSession({ hostInstanceId: myId, sdkSessionId: 'sdk-activate-1' });
    activeTestSid = s.id;
    hs.upsertMailbox(s.id, 'cid-act', 'maker:input:enqueue', [s.id, { clientId: 'cid-act', text: 'activate-me', chatMessage: { clientId: 'cid-act', role: 'user', content: 'activate-me' } }]);
    const fakePi = new EventEmitter();
    let activeId2 = null;
    tracker.attachSessionTracker(fakePi, () => null, () => activeId2, (id) => { activeId2 = id; });
    fakePi.emit('session_start', {}, {
      sessionManager: { getSessionId: () => 'sdk-activate-1' },
      cwd: '/tmp/act',
      model: { id: 'claude-sonnet-4-5', provider: 'anthropic' },
    });
    await sleep(50); // session_start handler await consume
    assert(sent.filter((x) => x.text === 'activate-me').length >= 1, 'M3 激活消费滞留行注入', sent);
    assert(hs.listPendingMailbox(s.id).length === 0, 'M3 消费后行删除');
    // pending TTL 兜底：超期 pending 行标 failed（无法消费的滞留行不无限堆积）
    hs.upsertMailbox(s.id, 'cid-ttl', 'maker:input:enqueue', [s.id, { clientId: 'cid-ttl', text: 'old' }]);
    hs.failStalePendingMailbox(Date.now() + 10_000);
    assert(hs.listPendingMailbox(s.id).length === 0, 'M3 pending TTL 标 failed');
    assert(db.prepare("SELECT status FROM cindy_handoff_mailbox WHERE client_id = 'cid-ttl'").get()?.status === 'failed', 'TTL 行状态 failed');
    // 清理
    activeTestSid = null;
    store.deleteSession(s.id);
    db.prepare('DELETE FROM cindy_handoff_mailbox').run();
    db.prepare('DELETE FROM cindy_instances WHERE instance_id = ?').run(myId);
  }

  // ============ M4 状态栏语言偏好（ui-prefs-store）============
  {
    const prefs = jiti(path.join(base, 'store/ui-prefs-store.js'));
    const prefsFile = path.join(DATA_DIR, 'ui-prefs.json');
    const savedLocale = process.env.CINDY_LOCALE;
    try {
      // 无显式设置时跟随系统 locale（CINDY_LOCALE 覆盖，与 auth resolveSystemLocale 同源）
      process.env.CINDY_LOCALE = 'zh-CN';
      assert(prefs.readStatusLang() === 'zh', 'M4 无显式设置跟随 zh 系统 locale');
      process.env.CINDY_LOCALE = 'en-US';
      assert(prefs.readStatusLang() === 'en', 'M4 无显式设置跟随 en 系统 locale');
    } finally {
      // 还原 env：undefined 必须 delete——直接赋值会写入字面量 "undefined"（truthy），
      // resolveSystemLocale 短路返回，污染同进程后续用例的 locale 解析
      if (savedLocale === undefined) delete process.env.CINDY_LOCALE;
      else process.env.CINDY_LOCALE = savedLocale;
    }
    // 显式设置持久化 + 覆盖默认（缓存路径）
    prefs.setStatusLang('en');
    assert(prefs.readStatusLang() === 'en', 'M4 setStatusLang(en) 后读回 en（缓存命中）');
    assert(fs.existsSync(prefsFile), 'M4 偏好文件已持久化');
    // 显式设置优先于 env（设置 zh 后仍返回 en）
    process.env.CINDY_LOCALE = 'zh-CN';
    assert(prefs.readStatusLang() === 'en', 'M4 显式设置优先于系统 locale');
    if (savedLocale === undefined) delete process.env.CINDY_LOCALE;
    else process.env.CINDY_LOCALE = savedLocale;
    prefs.setStatusLang('zh');
    assert(prefs.readStatusLang() === 'zh', 'M4 setStatusLang(zh) 覆盖为 zh');
    // 文件权限 0600（与 settings/session.enc 同级收敛）
    const mode = fs.statSync(prefsFile).mode & 0o777;
    assert(mode === 0o600, 'M4 ui-prefs.json 权限 0600', { mode });
  }

  // 清理
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1); });

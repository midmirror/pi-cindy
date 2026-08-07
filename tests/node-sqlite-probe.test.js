// tests/node-sqlite-probe.test.js
// 探测 pi 运行时环境（同 jiti 加载链）能否 require node:sqlite。
// 注意：必须在 pi 进程内跑（npx pi -e . -c 触发加载），不是 shell node。
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { interopDefault: true });
try {
  const { DatabaseSync } = jiti('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('probe-ok');
  const row = db.prepare('SELECT v FROM t').all()[0];
  console.log('NODE_SQLITE_PROBE:', row.v);
  if (row.v !== 'probe-ok') process.exit(1);
} catch (err) {
  console.error('NODE_SQLITE_PROBE FAILED:', err.message);
  process.exit(2);
}

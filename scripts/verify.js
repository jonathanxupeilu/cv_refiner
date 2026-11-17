/* ============================================================
   scripts/verify.js · 程序化回读外部证据（不要求人工看截图）
   用法：npm run verify  （需先 node server.js 启动服务）
   依次 GET /api/health 与 /api/verify，并打印结构化结论。
   ============================================================ */
'use strict';

const BASE = process.env.VERIFY_BASE || 'http://localhost:5173';

async function get(p) {
  const res = await fetch(BASE + p, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(p + ' 返回非 JSON：' + text.slice(0, 200)); }
  return { status: res.status, data };
}

(async () => {
  console.log('目标：' + BASE);
  try {
    const h = await get('/api/health');
    console.log('\n[1/2] /api/health  ' + h.status);
    console.log(JSON.stringify(h.data, null, 2));

    const v = await get('/api/verify');
    console.log('\n[2/2] /api/verify  ' + v.status);
    console.log(JSON.stringify(v.data, null, 2));
    console.log('\n结论：' + (v.data.conclusion || v.data.message || '无'));
    /* 让 fetch 的 keep-alive 句柄自然释放，避免 Windows 下 process.exit 触发 libuv 断言 */
    process.exitCode = v.data.ok ? 0 : 2;
    return;
  } catch (e) {
    console.error('回读失败：' + e.message);
    console.error('确认服务已启动：node server.js');
    process.exitCode = 1;
  }
})();

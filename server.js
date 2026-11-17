/* ============================================================
   server.js · 静态服务 + DeepSeek 代理（OpenAI 兼容 SDK）
   ------------------------------------------------------------
   用法：node server.js   默认 http://localhost:5173

   端点：
     GET  /api/health    回读当前 provider / 模型 / 密钥加载状态（不含密钥值）
     GET  /api/verify    用官方兼容 SDK 逐一比对候选端点，程序化判定 key/模型可用性
     POST /api/analyze   代理 DeepSeek，产出严格校验过的 analysis JSON
     POST /api/bullet    代理 DeepSeek，把追问回答转成简历 bullet

   设计约束：
     - 密钥只在服务端 .env，绝不进前端、绝不打印值本身（只报长度/前缀/字符集）
     - 无 Key / 调用失败时前端显式降级到 local-mock，不静默伪造成功
     - 提示词与输出契约在 prompts/ 数据文件，调优不改本文件
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai').OpenAI;

const ROOT = __dirname;
const PROMPTS = path.join(ROOT, 'prompts');
const LOGS = path.join(ROOT, 'logs');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* ------------------------------------------------------------
   1. 配置加载：只认等号；避免 KEY:value 冒号写法静默为空
   ------------------------------------------------------------ */
function parseEnvText(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;                       // 冒号写法直接跳过，不猜
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

/* 启动时对 .env 做快照，供 /api/health 判断「改了配置但没重启」 */
function envSnapshot() {
  const file = path.join(ROOT, '.env');
  try {
    const st = fs.statSync(file);
    return { mtimeMs: st.mtimeMs, text: fs.readFileSync(file, 'utf8') };
  } catch (e) { return { mtimeMs: 0, text: '' }; }
}

/* 纯函数：区分「没填 Key」与「填了 Key 但服务没重启」，避免误导性提示 */
function healthFlags(snapshot, cur, mode) {
  const envChanged = cur.mtimeMs !== snapshot.mtimeMs || cur.text !== snapshot.text;
  const diskHasKey = !!((parseEnvText(cur.text).DEEPSEEK_API_KEY || '').trim());
  const pendingKey = envChanged && diskHasKey && mode !== 'deepseek';
  let hint;
  if (mode === 'deepseek') hint = 'DeepSeek 已接入';
  else if (pendingKey) hint = '检测到 .env 已写入 Key，但服务未重启 → 重启后生效';
  else hint = '未配置 DEEPSEEK_API_KEY。本地开发写入 .env；创空间部署请在「设置 → 环境变量」添加密文变量后重启';
  return { envChanged, pendingKey, hint };
}

const ENV_SNAPSHOT = envSnapshot();
const ENV = Object.assign({}, parseEnvText(ENV_SNAPSHOT.text), process.env);   // 进程环境变量优先，便于临时覆盖
const CFG = {
  port: Number(ENV.PORT) || 5173,
  key: (ENV.DEEPSEEK_API_KEY || '').trim(),
  model: (ENV.DEEPSEEK_MODEL || 'deepseek-flash').trim(),
  baseURL: (ENV.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim().replace(/\/+$/, ''),
  forceMock: String(ENV.FORCE_MOCK || '0') === '1',
  /* 7 条 rewrite × 5 风格 + 10 面试追问 + 完整简历，16K 实测不够 */
  maxTokens: Math.min(384000, Math.max(8000, Number(ENV.DEEPSEEK_MAX_TOKENS) || 32000)),
  /* 可选访问口令：公开平台部署时防止陌生人消耗 API 额度；不配置则完全关闭 */
  accessToken: (ENV.APP_ACCESS_TOKEN || '').trim()
};
CFG.mode = (CFG.forceMock || !CFG.key) ? 'local-mock' : 'deepseek';

/* 只暴露脱敏信息，绝不返回密钥本身 */
function keyMask(k) {
  if (!k) return { loaded: false, length: 0, prefix: '', charset: '' };
  const nonAscii = /[^\x20-\x7E]/.test(k);
  return {
    loaded: true,
    length: k.length,
    prefix: k.slice(0, 3),
    charset: nonAscii ? '含非 ASCII 字符（请检查是否复制了多余内容）' : 'ascii 可打印字符'
  };
}

function logConfig() {
  const km = keyMask(CFG.key);
  console.log('─ 配置回读 ─────────────────────────────');
  console.log('DEEPSEEK_API_KEY : ' + (km.loaded
    ? '已加载（长度 ' + km.length + '，前缀 ' + km.prefix + '…，' + km.charset + '）'
    : '未配置 → 自动使用 local-mock'));
  console.log('模型 / 端点     : ' + CFG.model + '  @  ' + CFG.baseURL);
  console.log('运行模式        : ' + CFG.mode + (CFG.forceMock ? '（FORCE_MOCK=1 强制）' : ''));
  console.log('访问口令        : ' + (CFG.accessToken
    ? '已启用（长度 ' + CFG.accessToken.length + '，仅 API 需要）'
    : '未启用 → 拿到链接的人都能调用 API，公开部署时建议设置 APP_ACCESS_TOKEN'));
  if (km.loaded && km.length < 20) console.log('⚠ 密钥长度偏短，请确认 .env 用的是 KEY= 等号写法（不是 KEY:）');
  console.log('提示：确认上面出现「已加载」，即代表 .env 的值确实被读进来了。');
  console.log('────────────────────────────────────────');
}

/* ------------------------------------------------------------
   2. 提示词 / 契约：单一真源，启动时读入内存
   ------------------------------------------------------------ */
function readPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS, name), 'utf8');
}
const PROMPT_ANALYZE = readPrompt('analyze.system.md');
const PROMPT_BULLET = readPrompt('bullet.system.md');
const PROMPT_JDOCR = readPrompt('jdocr.system.md');
const SCHEMA = JSON.parse(readPrompt('analyze.schema.json'));

/* ------------------------------------------------------------
   3. SDK 客户端与错误分类
   ------------------------------------------------------------ */
function makeClient(baseURL, timeout) {
  return new OpenAI({
    apiKey: CFG.key,
    baseURL: baseURL || CFG.baseURL,
    timeout: timeout || 180000,
    maxRetries: 1
  });
}

/* 精确区分鉴权失败 / 权限受限 / 余额 / 限流 / 模型名 / 网络，不笼统报「失败」 */
function classify(err) {
  const status = err && (err.status || err.statusCode);
  const name = err && err.constructor ? err.constructor.name : 'Error';
  const msg = (err && err.message) ? String(err.message).slice(0, 240) : '未知错误';
  let code = 'UPSTREAM_ERROR', hint = '查看服务端日志 logs/analysis-last.json';

  if (status === 401 || name === 'AuthenticationError') {
    code = 'AUTH_FAILED'; hint = 'API Key 无效或已撤销。到 platform.deepseek.com 重新创建，确认 .env 用 KEY= 等号写法且值无多余空格/引号。';
  } else if (status === 402) {
    code = 'INSUFFICIENT_BALANCE'; hint = '账户余额不足，需在控制台充值。注意 HTTP 402 是余额问题，不是鉴权失败。';
  } else if (status === 403 || name === 'PermissionDeniedError') {
    code = 'PERMISSION_DENIED'; hint = '权限受限或端点写错。请逐一核对 /api/verify 里各候选端点的结果，不要凭裸 HTTP 状态码猜测。';
  } else if (status === 429 || name === 'RateLimitError') {
    code = 'RATE_LIMIT'; hint = '触发限流，稍后重试；可在 /api/verify 确认账号并发上限。';
  } else if (status === 400 && /image|multimodal|vision|视觉|图片|content.?type/i.test(msg)) {
    code = 'VISION_UNSUPPORTED'; hint = '当前模型不支持图片输入（多模态）。请直接粘贴 JD 文本，或在 .env 将 DEEPSEEK_MODEL 换成支持视觉的模型。';
  } else if (status === 400 && /model/i.test(msg)) {
    code = 'MODEL_NOT_FOUND'; hint = '模型名不存在。当前现役为 deepseek-flash / deepseek-v4-pro；deepseek-chat、deepseek-reasoner 已于 2026-07-24 停用。';
  } else if (status === 400 && /context|length|token/i.test(msg)) {
    code = 'CONTEXT_TOO_LONG'; hint = '输入超长或 max_tokens 不足，可适当缩短 JD / 简历。';
  } else if (name === 'APIConnectionTimeoutError' || name === 'APIConnectionError' || name === 'APIUserAbortError') {
    code = 'NETWORK'; hint = '网络不通或请求超时。检查代理/防火墙，或用 /api/verify 逐一比对端点。';
  } else if (status >= 500) {
    code = 'UPSTREAM_5XX'; hint = 'DeepSeek 服务端异常，稍后重试。';
  }
  return { code, status: status || null, sdkError: name, message: msg, hint };
}

/* ------------------------------------------------------------
   4. 输出契约校验（对齐 prompts/analyze.schema.json）
   ------------------------------------------------------------ */
function resolvePath(root, p) {
  let cur = [root];
  for (const seg of p.split('.')) {
    const isArr = seg.endsWith('[]');
    const key = isArr ? seg.slice(0, -2) : seg;
    const next = [];
    for (const o of cur) {
      if (!o || typeof o !== 'object') continue;
      const v = o[key];
      if (isArr) { if (Array.isArray(v)) v.forEach(x => next.push(x)); }
      else next.push(v);
    }
    cur = next;
  }
  return cur;
}
function getArray(root, p) {
  return p.split('.').reduce((o, k) => (o == null ? o : o[k]), root);
}
/* 枚举/数字路径形如 diagnosis.dimensions[].tone，返回 {obj, value} 对 */
function resolveField(root, p) {
  const segs = p.split('.');
  const field = segs.pop().replace('[]', '');
  return resolvePath(root, segs.join('.')).map(o =>
    (o && typeof o === 'object' && !Array.isArray(o)) ? { obj: o, value: o[field] } : { obj: null, value: undefined }
  );
}
function validateAnalysis(a) {
  const errors = [];
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['输出不是 JSON 对象'];
  for (const k of SCHEMA.topLevel) if (!(k in a)) errors.push('缺少顶层字段 ' + k);
  if (errors.length) return errors;

  for (const [p, keys] of Object.entries(SCHEMA.required)) {
    resolvePath(a, p).forEach((o, i) => {
      if (!o || typeof o !== 'object') { errors.push(p + '[' + i + '] 不是对象'); return; }
      keys.forEach(k => { if (o[k] === undefined || o[k] === null) errors.push(p + '[' + i + '].' + k + ' 缺失'); });
    });
  }
  for (const [p, allowed] of Object.entries(SCHEMA.enums)) {
    resolveField(a, p).forEach((r, i) => {
      if (!r.obj) { errors.push(p + '[' + i + '] 父对象缺失'); return; }
      if (r.value !== undefined && r.value !== null && !allowed.includes(r.value)) {
        errors.push(p + '[' + i + '] 枚举值非法：' + r.value);
      }
    });
  }
  for (const [p, range] of Object.entries(SCHEMA.counts)) {
    const arr = getArray(a, p);
    if (!Array.isArray(arr)) { errors.push(p + ' 不是数组'); continue; }
    if (arr.length < range.min || arr.length > range.max) errors.push(p + ' 数量 ' + arr.length + ' 超出 ' + range.min + '-' + range.max);
  }
  for (const [p, range] of Object.entries(SCHEMA.numeric)) {
    resolveField(a, p).forEach((r, i) => {
      if (!r.obj) { errors.push(p + '[' + i + '] 父对象缺失'); return; }
      const v = r.value;
      if (typeof v !== 'number' || !isFinite(v)) { errors.push(p + '[' + i + '] 不是数字'); return; }
      if (v < range.min || v > range.max) errors.push(p + '[' + i + '] 数值 ' + v + ' 越界');
      if (range.integer && !Number.isInteger(v)) errors.push(p + '[' + i + '] 应为整数');
    });
  }
  for (const p of SCHEMA.styleObjects) {
    resolvePath(a, p).forEach((o, i) => {
      if (!o || typeof o !== 'object') { errors.push(p + '[' + i + '] 不是对象'); return; }
      SCHEMA.styleKeys.forEach(k => { if (!(k in o)) errors.push(p + '[' + i + '] 缺少风格 ' + k); });
    });
  }
  if (Array.isArray(a.resumeBase && a.resumeBase.capabilityByStyle)) {
    errors.push('resumeBase.capabilityByStyle 应为对象');
  } else if (a.resumeBase && a.resumeBase.capabilityByStyle) {
    SCHEMA.styleKeys.forEach(k => {
      if (a.resumeBase.capabilityByStyle[k] !== undefined && !Array.isArray(a.resumeBase.capabilityByStyle[k])) {
        errors.push('resumeBase.capabilityByStyle.' + k + ' 应为数组');
      }
    });
  }
  /* UI 用 id 作为 key，必须唯一 */
  ['probes', 'rewrite'].forEach(field => {
    const arr = a[field];
    if (!Array.isArray(arr)) return;
    const ids = arr.map(x => x && x.id);
    if (new Set(ids).size !== ids.length) errors.push(field + ' 的 id 有重复，会导致前端渲染错乱');
    if (ids.some(x => !x)) errors.push(field + ' 存在空 id');
  });
  /* 强度分布合计必须等于行数，避免顶栏统计与表格不一致 */
  const m = a.matching;
  if (m && m.summary && Array.isArray(m.rows)) {
    const sum = ['strong', 'medium', 'weak', 'missing'].reduce((n, k) => n + (Number(m.summary[k]) || 0), 0);
    if (sum !== m.rows.length) errors.push('matching.summary 合计 ' + sum + ' ≠ rows 行数 ' + m.rows.length);
  }
  return errors;
}

/* LLM 常见三类 JSON 违规：字符串内真实换行、字符串内裸 ASCII 双引号、尾随逗号。
   逐字符扫描并就地修复，避免因整段输出重跑一次真实调用。 */
function repairJsonText(t) {
  const CLOSERS = new Set([',', '}', ']', ':']);
  const ESCAPES = '"\\/bfnrtu';
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i], code = t.charCodeAt(i);
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') {
        const nx = t[i + 1];
        if (nx && ESCAPES.includes(nx)) { out += c; esc = true; }
        else out += '\\\\';                       // 裸反斜杠
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < t.length && /\s/.test(t[j])) j++;
        const nx = t[j];
        if (nx === undefined || CLOSERS.has(nx)) { out += c; inStr = false; }
        else out += '\\"';                       // 字符串内的裸引号
        continue;
      }
      if (code < 0x20) {
        out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t'
             : '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += c;
    } else {
      if (c === '"') { inStr = true; out += c; continue; }
      if (c === '}' || c === ']') {             // 去尾随逗号
        let k = out.length - 1;
        while (k >= 0 && /\s/.test(out[k])) k--;
        if (out[k] === ',') out = out.slice(0, k) + out.slice(k + 1);
      }
      out += c;
    }
  }
  return out;
}
/* 模型会在中途「提前闭合根对象」，且可能连续多次：
   {"jdParse":…,"probes":[…]},"rewrite":…},"interview":{…},}
   用括号深度栈找出所有「depth 归零后仍有后续内容」的 }，删掉并用逗号接上；
   再修末尾 ",}" 笔误（少写一层闭合）、按栈补齐缺失闭合符。 */
function mergePrematureRootClose(t) {
  let s = t;
  for (let it = 0; it < 20; it++) {
    let depth = 0, inStr = false, esc = false, pos = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0 && c === '}' && s.slice(i + 1).trim().length) { pos = i; break; }
      }
    }
    if (pos < 0) break;
    let after = s.slice(pos + 1);
    if (!after.trimStart().startsWith(',')) after = ',' + after;
    s = s.slice(0, pos) + after;
  }
  s = s.replace(/,\s*\}\s*$/, '}');       // 末尾 ",}" → "}"（模型少写一层的笔误）
  s = s + balanceClosers(s);
  try { JSON.parse(s); return s; } catch (e) { return null; }
}
/* 栈式补齐缺失的闭合符（模型常在结尾少写 }），基于已修复引号的文本扫描 */
function balanceClosers(s) {
  const st = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') st.push(c);
    else if (c === '}' || c === ']') st.pop();
  }
  return st.reverse().map(c => c === '{' ? '}' : ']').join('');
}
/* 合并提前闭合后，某些父对象的子字段会散落到根层（如 interview.intro）；
   按 schema 声明的子字段把它们收拢回父对象。 */
function foldStrayChildren(obj) {
  const folded = [];
  if (!obj || typeof obj !== 'object') return folded;
  for (const top of SCHEMA.topLevel) {
    const childKeys = (SCHEMA.required[top] || []).filter(k => !k.includes('.') && !k.includes('[]'));
    if (!obj[top] || typeof obj[top] !== 'object' || Array.isArray(obj[top]) || !childKeys.length) continue;
    for (const ck of childKeys) {
      if (obj[top][ck] === undefined && obj[ck] !== undefined) {
        obj[top][ck] = obj[ck];
        delete obj[ck];
        folded.push(top + '.' + ck);
      }
    }
  }
  return folded;
}
/* 少写 } 会把后续字段层层嵌进上一个对象里；按 schema 的顶层字段名提升回根 */
function normalizeStructure(obj, topKeys) {
  const lifted = [];
  const folded = foldStrayChildren(obj);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { obj, lifted, folded };
  for (const key of topKeys) {
    if (obj[key] !== undefined) continue;
    let found = null, path = '';
    (function walk(x, p) {
      if (found !== null || !x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach((v, i) => walk(v, p + '[' + i + ']')); return; }
      for (const k of Object.keys(x)) {
        if (k === key) { found = x[k]; path = p + '.' + k; return; }
        walk(x[k], p + '.' + k);
        if (found !== null) return;
      }
    })(obj, 'root');
    if (found !== null) { obj[key] = found; lifted.push(key + '←' + path); }
  }
  return { obj, lifted, folded };
}
/* summary 是 rows 的确定性统计量，模型常算错；按 rows 重算而不是拒绝整份结果 */
function normalizeSummary(a) {
  if (!a || !a.matching || !Array.isArray(a.matching.rows)) return null;
  const before = Object.assign({}, a.matching.summary || {});
  const after = { strong: 0, medium: 0, weak: 0, missing: 0 };
  a.matching.rows.forEach(r => {
    if (r.strength === '强') after.strong++;
    else if (r.strength === '中') after.medium++;
    else if (r.strength === '弱') after.weak++;
    else if (r.strength === '缺失') after.missing++;
  });
  a.matching.summary = after;
  return { before, after };
}
/* 「嵌套对象/数组漏写闭合符」修复器（实测案例：rewrite[] 元素的 after 对象
   （5 风格键）后漏 }，reason/risk 被吞进 after，下一个元素的 { 出现在 key
   期待位，V8 报 Expected double-quoted property name）。
   严格模拟 V8 期待状态扫描，找到第一个违规点插入一个闭合符/逗号，迭代收敛；
   遇到无法语法修复的违规（如根提前闭合后仍有内容）即停止，交给
   mergePrematureRootClose 兜底。 */
function scanStrictViolation(s) {
  let inStr = false, esc = false, expect = 'value';
  const stack = [];
  const top = () => stack[stack.length - 1];
  function parentExpect() {
    const p = stack[stack.length - 1];
    return p && p.type === 'arr' ? 'commaOrCloseArr' : 'commaOrClose';
  }
  /* 「key 期待位出现值」= 上一成员漏 }。闭合符必须插在分隔逗号之前，
     否则形成尾随逗号（严格 JSON 非法）。逗号紧邻违规字符（中间只可能有空白）。 */
  function beforeComma(i) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(s[j])) j--;
    return (j >= 0 && s[j] === ',') ? j : i;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') {
        inStr = false;
        expect = (expect === 'key') ? 'colon' : parentExpect();
      }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (/\s/.test(c)) continue;
    if (c === '{' || c === '[') {
      /* 严格期待校验：key 位置 / 对象值闭合后出现值开头 → 上一成员漏闭合符 */
      if (expect === 'key' || expect === 'commaOrClose') return { violation: { insertAt: beforeComma(i), insert: '}' } };
      if (expect === 'commaOrCloseArr') return { violation: { insertAt: i, insert: ',' } };
      if (expect !== 'value') return { violation: { insertAt: i, insert: null } };
      stack.push({ type: c === '{' ? 'obj' : 'arr' });
      expect = c === '{' ? 'key' : 'value';
      continue;
    }
    if (c === ':') {
      if (expect !== 'colon') return { violation: { insertAt: i, insert: null } };   // 无法语法修复
      expect = 'value'; continue;
    }
    if (c === ',') {
      if (!top()) return null;                                            // 根外内容 → mergePrematureRootClose 的活
      if (expect !== 'commaOrClose' && expect !== 'commaOrCloseArr') return { violation: { insertAt: i, insert: null } };
      expect = top().type === 'obj' ? 'key' : 'value'; continue;
    }
    if (c === '}') {
      if (!top()) return null;
      if (top().type !== 'obj') {
        /* 数组未闭就想闭对象 → 插 ] 让数组先闭 */
        if (expect === 'commaOrCloseArr') return { violation: { insertAt: i, insert: ']' } };
        return { violation: { insertAt: i, insert: null } };
      }
      stack.pop(); expect = stack.length ? parentExpect() : 'done'; continue;
    }
    if (c === ']') {
      if (!top()) return null;
      if (top().type !== 'arr') {
        /* 对象未闭就想闭数组（本案例 r6 尾部："]}"）→ 插 } 先闭对象 */
        if (expect === 'commaOrClose') return { violation: { insertAt: i, insert: '}' } };
        return { violation: { insertAt: i, insert: null } };
      }
      stack.pop(); expect = stack.length ? parentExpect() : 'done'; continue;
    }
    /* 非字符串值：数字 / true / false / null */
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/.exec(s.slice(i));
    if (m) {
      if (expect !== 'value' && expect !== 'commaOrCloseArr') {
        /* 值出现在非法期待位：key 位置 → 上一成员缺 }；对象值闭合后 → 同 */
        if (expect === 'key' || expect === 'commaOrClose') return { violation: { insertAt: beforeComma(i), insert: '}' } };
        return { violation: { insertAt: i, insert: null } };
      }
      i += m[0].length - 1;
      expect = top() && top().type === 'arr' ? 'commaOrCloseArr' : 'commaOrClose';
      continue;
    }
    /* 裸标识符等 → 无法语法修复 */
    return { violation: { insertAt: i, insert: null } };
  }
  return null;
}

function insertMissingClosers(t) {
  let s = String(t || '');
  for (let round = 0; round < 60; round++) {
    const v = scanStrictViolation(s);
    if (!v || !v.violation || v.violation.insert == null) return s;
    const { insertAt, insert } = v.violation;
    s = s.slice(0, insertAt) + insert + s.slice(insertAt);
  }
  return s;
}

/* schema 感知的语义修复：语法层补 } 后，被吞进 after 的 reason/risk 搬回
   rewrite 元素顶层（schema 要求它们是元素字段；after 多余键是漏 } 的连带结果） */
function liftStrayRewriteMeta(a) {
  const moved = [];
  if (!a || !Array.isArray(a.rewrite)) return moved;
  a.rewrite.forEach((r, i) => {
    if (!r || typeof r.after !== 'object' || Array.isArray(r.after)) return;
    ['reason', 'risk'].forEach(k => {
      if (r[k] === undefined && r.after[k] !== undefined) {
        r[k] = r.after[k];
        delete r.after[k];
        moved.push('rewrite[' + i + '].' + k);
      }
    });
  });
  return moved;
}

function tryParse(t) {
  let lastErr = null;
  const repaired = repairJsonText(t);
  const closers = balanceClosers(repaired);
  const mended = insertMissingClosers(repaired);
  const mendedRaw = insertMissingClosers(t);
  const variants = [
    t, repaired,
    mergePrematureRootClose(t), mergePrematureRootClose(repaired),
    mended, mendedRaw,
    mergePrematureRootClose(mended), mergePrematureRootClose(mendedRaw),
    closers ? repaired + closers : null,
    closers ? mergePrematureRootClose(repaired + closers) : null,
    closers ? insertMissingClosers(repaired + closers) : null
  ];
  for (const c of variants) {
    if (c == null) continue;
    try { return { value: JSON.parse(c), err: null }; }
    catch (e) { lastErr = e; }
  }
  return { value: null, err: lastErr };
}
function parseJsonLoose(text) {
  let t = String(text || '').trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  const whole = tryParse(t);
  if (whole.value) return whole.value;
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  let sliced = { value: null, err: whole.err };
  if (s !== -1 && e > s) sliced = tryParse(t.slice(s, e + 1));
  if (sliced.value) return sliced.value;
  /* 带上 JSON.parse 的位置信息，下一次可直接定位语法错，无需再跑一次模型 */
  const why = (sliced.err || whole.err || {}).message || '未知';
  throw new Error('模型输出不是合法 JSON（长度 ' + t.length + '；解析错误：' + why +
    '；末尾 120 字：' + t.slice(-120).replace(/\s+/g, ' ') + '）');
}

/* ------------------------------------------------------------
   5. 业务调用
   ------------------------------------------------------------ */
function callDeepSeek(systemPrompt, userPayload, opts) {
  opts = opts || {};
  return makeClient().chat.completions.create({
    model: CFG.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPayload }
    ],
    response_format: { type: 'json_object' },   // JSON 模式：必须与 prompt 里的 JSON 要求同时存在
    thinking: { type: 'disabled' },             // 结构化抽取关闭思考，更快更省
    temperature: opts.temperature != null ? opts.temperature : 0.2,
    max_tokens: opts.max_tokens || CFG.maxTokens,
    stream: false
  });
}

async function handleAnalyze(body) {
  const materials = body && body.materials;
  const mode = (materials && materials.mode === 'generic') ? 'generic' : 'jd';
  if (!materials || !String(materials.resume || '').trim()) {
    return { status: 400, payload: { ok: false, code: 'BAD_INPUT', message: '缺少 materials.resume' } };
  }
  if (mode === 'jd' && !String(materials.jd || '').trim()) {
    return { status: 400, payload: { ok: false, code: 'BAD_INPUT', message: '缺少 materials.jd（JD 定制版必填；没有 JD 请改用 mode=generic 通用版）' } };
  }
  if (CFG.mode !== 'deepseek') {
    return { status: 503, payload: { ok: false, code: 'NO_KEY', message: '服务端未配置 DEEPSEEK_API_KEY，前端将降级到 local-mock', mode: 'local-mock' } };
  }

  const started = Date.now();
  /* 请求级取证：证明 JD / 原始简历确实被送入模型，便于排查「没读取到简历」类反馈 */
  const inputSizes = {
    mode,
    jd: String(materials.jd || '').length,
    resume: String(materials.resume || '').length,
    extra: String(materials.extra || '').length
  };
  const payload = JSON.stringify({
    materials: {
      mode,
      city: materials.city || '',
      position: materials.position || '', industry: materials.industry || '',
      companyType: materials.companyType || '', stage: materials.stage || '',
      highlight: materials.highlight || '', jd: materials.jd || '',
      resume: materials.resume, extra: materials.extra || ''
    },
    instruction: '请严格按 system 提示词里的字段契约输出单个 JSON 对象，不要输出任何解释文字。'
  });

  /* 最多两次：截断 → 加大 max_tokens 重试；语法/契约错误 → 修复器救回，
     仍失败则原样重试一次（模型第二遍常能写对结构），不再放大 max_tokens */
  const attemptsLog = [];
  let parsed = null, lastRaw = '', lastFinish = '', lastErrMsg = '', lastUsage = null;
  let normInfo = null, validateErrors = null;
  let maxTokens = CFG.maxTokens;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let completion;
    try {
      completion = await callDeepSeek(PROMPT_ANALYZE, payload, { max_tokens: maxTokens });
    } catch (err) {
      const c = classify(err);
      writeLog({ ok: false, stage: 'request', error: c, attemptsLog, inputSizes });
      return { status: 502, payload: Object.assign({ ok: false }, c) };
    }
    const choice = completion.choices && completion.choices[0];
    lastFinish = choice && choice.finish_reason;
    lastRaw = (choice && choice.message && choice.message.content) || '';
    lastUsage = completion.usage || null;
    attemptsLog.push({
      attempt, maxTokens, finishReason: lastFinish, rawLen: lastRaw.length,
      usage: lastUsage, tail: lastRaw.slice(-180).replace(/\s+/g, ' ')
    });

    if (lastFinish === 'length' || !lastRaw.trim()) {
      lastErrMsg = lastFinish === 'length' ? '输出被 max_tokens 截断' : '模型返回空内容';
    } else {
      let candidate = null;
      try { candidate = parseJsonLoose(lastRaw); }
      catch (e) { lastErrMsg = e.message; }
      if (candidate) {
        const norm = normalizeStructure(candidate, SCHEMA.topLevel);
        const summaryFix = normalizeSummary(norm.obj);
        const rewriteLift = liftStrayRewriteMeta(norm.obj);
        const errs = validateAnalysis(norm.obj);
        if (!errs.length) {
          parsed = norm.obj;
          normInfo = { norm, summaryFix, rewriteLift };
          break;
        }
        validateErrors = errs;
        lastErrMsg = '输出契约校验失败：' + errs.slice(0, 6).join('；');
        /* 契约错误重跑一次值得：结构性漏写多为随机，第二遍常能写对 */
        if (attempt === 1) continue;
        break;
      }
    }
    /* 只有截断才值得放大 max_tokens；语法错误重跑只会重复失败、白花一次调用费用 */
    const tailChar = lastRaw.trim().slice(-1);
    const looksTruncated = lastFinish === 'length' || (tailChar !== '}' && tailChar !== ']');
    if (!looksTruncated) break;
    maxTokens = Math.min(60000, Math.round(maxTokens * 1.6));
  }

  if (!parsed) {
    const code = lastFinish === 'length' ? 'TRUNCATED' : (validateErrors ? 'SCHEMA_INVALID' : 'JSON_PARSE');
    const c = {
      code, message: lastErrMsg || '模型输出无法解析',
      errors: validateErrors || undefined,
      attempts: attemptsLog,
      hint: code === 'TRUNCATED'
        ? '调高 DEEPSEEK_MAX_TOKENS（当前 ' + CFG.maxTokens + '，已自动重试一次）'
        : code === 'SCHEMA_INVALID'
          ? '模型两次输出均未通过契约校验；已回退本地 mock，原始输出见 logs/analysis-last.json'
          : '模型未遵守 JSON 契约；已回退本地 mock，原始输出见 logs/analysis-last.json'
    };
    writeLog({ ok: false, stage: code === 'TRUNCATED' ? 'truncated' : (code === 'SCHEMA_INVALID' ? 'validate' : 'parse'), error: c,
      attemptsLog, inputSizes, rawLen: lastRaw.length, rawHead: lastRaw.slice(0, 600),
      rawTail: lastRaw.slice(-2000), rawFull: lastRaw.slice(0, 120000) });
    return { status: 502, payload: Object.assign({ ok: false }, c) };
  }

  const now = new Date();
  parsed.meta = {
    mode,
    position: materials.position || '目标岗位',
    industry: materials.industry || '',
    companyType: materials.companyType || '',
    stage: materials.stage || '',
    generatedAt: pad(now.getHours()) + ':' + pad(now.getMinutes()),
    provider: 'deepseek',
    model: CFG.model,
    score: parsed.diagnosis.score,
    usage: lastUsage,
    attempts: attemptsLog.length,
    elapsedMs: Date.now() - started
  };
  writeLog({ ok: true, stage: 'done', model: CFG.model, usage: lastUsage,
    attemptsLog, inputSizes,
    normalizedFields: normInfo.norm.lifted, foldedFields: normInfo.norm.folded,
    summaryFix: normInfo.summaryFix, rewriteLift: normInfo.rewriteLift,
    elapsedMs: parsed.meta.elapsedMs });
  return { status: 200, payload: { ok: true, analysis: parsed } };
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }

async function handleBullet(body) {
  if (CFG.mode !== 'deepseek') {
    return { status: 503, payload: { ok: false, code: 'NO_KEY', message: '未配置 Key，前端使用本地 mock 生成 bullet' } };
  }
  const { probe, answer, position, jd } = body || {};
  if (!probe) return { status: 400, payload: { ok: false, code: 'BAD_INPUT', message: '缺少 probe' } };
  const payload = JSON.stringify({
    position: position || '', jd: jd || '',
    probe: { category: probe.category, question: probe.question, why: probe.why, hint: probe.hint, bullet: probe.bullet },
    answer: answer || ''
  });
  try {
    /* bullet 是纯文本，不用 JSON 模式 */
    const completion = await makeClient().chat.completions.create({
      model: CFG.model,
      messages: [{ role: 'system', content: PROMPT_BULLET }, { role: 'user', content: payload }],
      thinking: { type: 'disabled' },
      temperature: 0.3,
      max_tokens: 300,
      stream: false
    });
    const text = completion.choices[0].message.content.trim()
      .replace(/^```[\s\S]*?\n?/, '').replace(/```$/, '').trim()
      .replace(/^[-*•]\s*/, '').replace(/^["「「]|["」」]$/g, '');
    if (!text) throw new Error('模型返回空 bullet');
    return { status: 200, payload: { ok: true, bullet: text, provider: 'deepseek' } };
  } catch (err) {
    const c = classify(err);
    return { status: 502, payload: Object.assign({ ok: false }, c) };
  }
}

/* ------------------------------------------------------------
   5b. /api/jd-ocr：JD 截图 → JD 文本（OpenAI 兼容多模态，image_url）
       - 前端已用 canvas 压缩（长边 ≤1600px，JPEG 0.82）；这里再兜底校验大小
       - 模型不支持图片时 classify 给 VISION_UNSUPPORTED，前端明确提示粘贴文本
   ------------------------------------------------------------ */
const IMG_MIME_OK = /^data:image\/(png|jpeg|jpg|webp);base64,/;
const IMG_MAX_BYTES = 6 * 1024 * 1024;   // base64 解码后上限

async function handleJdOcr(body) {
  if (CFG.mode !== 'deepseek') {
    return { status: 503, payload: { ok: false, code: 'NO_KEY', message: '截图识别需要服务端配置 DEEPSEEK_API_KEY（local-mock 不支持图片）', mode: 'local-mock' } };
  }
  const image = body && body.image;
  if (!image || !IMG_MIME_OK.test(image)) {
    return { status: 400, payload: { ok: false, code: 'BAD_INPUT', message: '缺少 image 或不是 data:image/…;base64, 格式' } };
  }
  const b64 = image.slice(image.indexOf(',') + 1);
  const approxBytes = Math.floor(b64.length * 3 / 4);
  if (approxBytes > IMG_MAX_BYTES) {
    return { status: 400, payload: { ok: false, code: 'IMAGE_TOO_LARGE', message: '图片过大（解码后约 ' + Math.round(approxBytes / 1024) + ' KB，上限 6 MB）' } };
  }

  try {
    const completion = await makeClient().chat.completions.create({
      model: CFG.model,
      messages: [
        { role: 'system', content: PROMPT_JDOCR },
        { role: 'user', content: [
          { type: 'text', text: JSON.stringify({ instruction: '请转录图片中的岗位描述' }) },
          { type: 'image_url', image_url: { url: image } }
        ] }
      ],
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      temperature: 0.1,
      max_tokens: 4000,
      stream: false
    });
    const raw = (completion.choices[0].message.content || '').trim();
    const parsed = parseJsonLoose(raw);
    const jd = String(parsed.jd || '').trim();
    writeLog({ ok: true, stage: 'jd-ocr', inputSizes: { imageKB: Math.round(approxBytes / 1024) },
      jdLen: jd.length, reason: parsed.reason || '', usage: completion.usage || null });
    if (!jd) {
      return { status: 200, payload: { ok: false, code: 'OCR_EMPTY', message: parsed.reason || '未能从截图中识别出 JD 正文，请换一张更清晰的截图或直接粘贴文本' } };
    }
    return { status: 200, payload: { ok: true, jd, provider: 'deepseek', model: CFG.model } };
  } catch (err) {
    const c = classify(err);
    writeLog({ ok: false, stage: 'jd-ocr', error: c });
    return { status: 502, payload: Object.assign({ ok: false }, c) };
  }
}

/* ------------------------------------------------------------
   6. /api/verify：用官方兼容 SDK 逐一比对候选端点
      只有 SDK 全部失败、且逐端点比对后，才判定 Key 失效
   ------------------------------------------------------------ */
async function handleVerify() {
  const km = keyMask(CFG.key);
  if (!km.loaded) {
    return { ok: false, code: 'NO_KEY', conclusion: '未配置 API Key，无法判定有效性（当前运行 local-mock）', key: km, message: '未配置 DEEPSEEK_API_KEY', hint: '未配置 DEEPSEEK_API_KEY。本地开发写入 .env；创空间部署请在设置页添加密文变量后重启' };
  }
  const candidates = [...new Set([
    CFG.baseURL,
    'https://api.deepseek.com',
    'https://api.deepseek.com/v1'
  ])].filter(Boolean);

  const endpoints = [];
  for (const baseURL of candidates) {
    const client = new OpenAI({ apiKey: CFG.key, baseURL, timeout: 25000, maxRetries: 0 });
    const entry = { baseURL, ok: false };
    /* 探针 1：models.list（不产生 token 费用） */
    try {
      const list = await client.models.list();
      const ids = (list.data || []).map(m => m.id);
      entry.modelsList = { ok: true, count: ids.length, ids: ids.slice(0, 12) };
      entry.ok = true;
    } catch (e) {
      entry.modelsList = { ok: false, error: classify(e) };
    }
    /* 探针 2：最小 chat 调用（仅当 models.list 不可用时，用于区分端点错误与鉴权错误） */
    if (!entry.ok) {
      try {
        const c = await client.chat.completions.create({
          model: CFG.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        });
        entry.chat = { ok: true, id: c.id, model: c.model, finish_reason: c.choices[0].finish_reason };
        entry.ok = true;
      } catch (e2) {
        entry.chat = { ok: false, error: classify(e2) };
      }
    }
    endpoints.push(entry);
  }

  const anyOk = endpoints.some(e => e.ok);
  const codes = endpoints.flatMap(e => [e.modelsList, e.chat].filter(Boolean).filter(x => !x.ok && x.error).map(x => x.error.code));
  let conclusion;
  if (anyOk) conclusion = 'Key 与模型可用（SDK 调用成功）';
  else if (codes.length && codes.every(c => c === 'AUTH_FAILED')) conclusion = 'SDK 全部端点均返回 401 → Key 无效或已撤销';
  else if (codes.includes('INSUFFICIENT_BALANCE')) conclusion = '账户余额不足（402），非鉴权问题';
  else if (codes.includes('MODEL_NOT_FOUND')) conclusion = '模型名不存在，请改用 deepseek-flash / deepseek-v4-pro';
  else if (codes.includes('NETWORK')) conclusion = '网络不通/超时，未能判定 Key 有效性（不要据此认定 Key 失效）';
  else conclusion = '端点或权限异常，请逐项查看 endpoints 明细';

  return {
    ok: anyOk, conclusion, key: km, model: CFG.model, sdk: 'openai (OpenAI 兼容 SDK，DeepSeek 官方推荐)',
    note: '判定规则：只有官方兼容 SDK 在所有候选端点都失败、且错误一致为 401 时，才认定 Key 失效。',
    endpoints
  };
}

/* ------------------------------------------------------------
   7. 日志留痕（可归因，不含密钥）
   ------------------------------------------------------------ */
function writeLog(record) {
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.writeFileSync(path.join(LOGS, 'analysis-last.json'),
      JSON.stringify(Object.assign({ at: new Date().toISOString(), mode: CFG.mode, model: CFG.model }, record), null, 2));
  } catch (e) { /* 日志失败不影响主链路 */ }
}

/* ------------------------------------------------------------
   8. HTTP 路由
   ------------------------------------------------------------ */
/* 访问口令校验：支持 ?token= / X-Access-Token / Bearer，任一命中即可 */
function accessAllowed(req, url) {
  if (!CFG.accessToken) return true;
  const header = String(req.headers['x-access-token'] || '');
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const q = url.searchParams.get('token') || '';
  return header === CFG.accessToken || bearer === CFG.accessToken || q === CFG.accessToken;
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => {
      buf += c;
      /* 8MB：JD 截图 base64（前端已压缩，通常 150-400KB）+ 常规 JSON 都够用 */
      if (buf.length > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* 静态资源白名单：杜绝 .env / node_modules / logs / 服务端源码被读走 */
function isBlocked(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p === 'server.js' || p === 'package.json' || p === 'package-lock.json') return true;
  const segs = p.split('/');
  if (segs.some(s => s.startsWith('.'))) return true;               // .env / .git / .gitignore …
  return /^(node_modules|logs|prompts|scripts)\//.test(p);
}

const server = http.createServer(async (req, res) => {
  let url, pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch (e) { res.writeHead(400); res.end('Bad Request'); return; }

  /* ---- API ---- */
  if (pathname === '/api/health') {
    const flags = healthFlags(ENV_SNAPSHOT, envSnapshot(), CFG.mode);
    return json(res, 200, {
      ok: true, mode: CFG.mode, model: CFG.model, baseURL: CFG.baseURL,
      forceMock: CFG.forceMock, key: keyMask(CFG.key), prompts: 'prompts/*.md',
      schema: SCHEMA.version,
      authRequired: !!CFG.accessToken,
      envChanged: flags.envChanged, pendingKey: flags.pendingKey,
      hint: flags.hint
    });
  }
  /* 除健康检查外，所有 API 需要访问口令（未配置口令时 accessAllowed 恒为 true） */
  if (pathname.startsWith('/api/') && !accessAllowed(req, url)) {
    return json(res, 401, {
      ok: false, code: 'UNAUTHORIZED',
      message: '需要访问口令',
      hint: '在链接后追加 ?token=你的口令，或让部署者关闭 APP_ACCESS_TOKEN'
    });
  }
  if (pathname === '/api/verify') {
    try { return json(res, 200, await handleVerify()); }
    catch (e) { return json(res, 500, { ok: false, code: 'VERIFY_CRASH', message: String(e.message) }); }
  }
  if (pathname === '/api/analyze' || pathname === '/api/bullet' || pathname === '/api/jd-ocr') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD', message: '仅支持 POST' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return json(res, 400, { ok: false, code: 'BAD_BODY', message: e.message }); }
    try {
      let r;
      if (pathname === '/api/analyze') r = await handleAnalyze(body);
      else if (pathname === '/api/jd-ocr') r = await handleJdOcr(body);
      else r = await handleBullet(body);
      return json(res, r.status, r.payload);
    } catch (e) {
      return json(res, 500, { ok: false, code: 'SERVER_CRASH', message: String(e.message) });
    }
  }

  /* ---- 静态 ---- */
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(ROOT, '.' + pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (isBlocked(path.relative(ROOT, filePath))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

/* 供质量门禁直接 require 校验器，不启动 HTTP 服务 */
module.exports = { CFG, SCHEMA, validateAnalysis, parseJsonLoose, repairJsonText,
  insertMissingClosers, liftStrayRewriteMeta,
  balanceClosers, normalizeStructure, normalizeSummary, classify, keyMask, parseEnvText, healthFlags, accessAllowed };

if (require.main === module) {
  server.listen(CFG.port, () => {
    logConfig();
    console.log('简历专家已启动：http://localhost:' + CFG.port);
    console.log('自检：GET /api/health（配置回读） · GET /api/verify（SDK 逐端点验证）');
  });
}

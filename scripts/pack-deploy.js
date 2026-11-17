/* ============================================================
   scripts/pack-deploy.js · 生成可直接上传的干净部署包
   - 排除 .env / logs / node_modules / .git / 本地调试脚本
   - 保留 Dockerfile / deploy.json / package*.json / 前端 / prompts
   用法：npm run pack
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'deploy-package');

const SKIP_DIRS = new Set(['node_modules', 'logs', '.git', 'deploy-package']);
function skipFile(name) {
  if (name === '.env') return true;
  if (name === '.env.example') return false;
  if (/^\.env\./.test(name)) return true;          // .env.local 等
  if (/\.log$/.test(name)) return true;
  if (/^_(smoke|real|verify_real|gate.*)\.js$/.test(name)) return true;
  return false;
}

let files = 0, bytes = 0;
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      copyDir(s, d);
    } else {
      if (skipFile(ent.name)) continue;
      fs.copyFileSync(s, d);
      files++; bytes += fs.statSync(d).size;
    }
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
copyDir(ROOT, OUT);

/* 自检：干净包不得含密钥与用户日志 */
const leaked = [];
(function scan(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) scan(p);
    else if (ent.name === '.env' || /^\.env\.(?!example)/.test(ent.name)) leaked.push(path.relative(OUT, p));
  }
})(OUT);
if (fs.existsSync(path.join(OUT, 'logs'))) leaked.push('logs/');

console.log('部署包：' + OUT);
console.log('文件数：' + files + '，大小：' + (bytes / 1024).toFixed(1) + ' KB');
if (leaked.length) { console.error('✗ 发现敏感文件：' + leaked.join(', ')); process.exitCode = 1; }
else console.log('✓ 已排除 .env 与 logs/，可安全上传');

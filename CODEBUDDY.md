# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

「简历专家」—— JD 定制简历优化 Agent 的 Web 应用。前端为**零依赖静态页面**（传统 script + 全局命名空间 `window.RE`，无构建步骤），后端是单文件 Node 服务（`server.js`），通过 OpenAI 兼容 SDK 代理 DeepSeek。唯一 npm 依赖是 `openai`。

## 常用命令

```bash
npm start          # 启动服务，默认 http://localhost:5173（改 .env 的 PORT）
npm run verify     # 程序化验证：GET /api/health + /api/verify（需先启动服务）
npm run pack       # 生成干净部署包 deploy-package/（排除 .env/logs/node_modules/_*.js）

# 单文件运行（无任何测试框架，验证走 /api/verify 与手动验收）
FORCE_MOCK=1 node server.js   # 强制本地 mock 模式，离线开发用
```

部署目标是 ModelScope 创空间（Docker，端口强制 7860）。部署全流程、踩坑记录见 `DEPLOY.md`；本地 Docker 用 `docker-compose.yml`（宿主 5173 → 容器 7860）。

## 架构

### 后端（server.js，单文件）

- **端点**：`GET /api/health`（provider/模型/密钥状态，脱敏只报长度/前缀）、`GET /api/verify`（SDK 逐一比对候选端点判定 key 可用性）、`POST /api/analyze`、`POST /api/bullet`、`POST /api/jd-ocr`（JD 截图 → 文本，OpenAI 兼容多模态 `image_url`）。另有静态文件服务与可选访问口令保护（`APP_ACCESS_TOKEN`，只保护 API 不保护静态页）。
- **配置**：`.env` 自解析（只认 `KEY=` 等号写法，冒号写法被忽略——曾因 `KEY:value` 静默为空踩坑）。进程环境变量优先于 .env。启动时快照 .env mtime，用于区分「没填 Key」与「填了 Key 但没重启」。
- **输出契约校验**：模型返回的 JSON 经 `validateAnalysis()`（对照 `prompts/analyze.schema.json`，版本 `resume-expert/v2`）严格校验，配有一套 JSON 截断修复管线（`repairJsonText` → `mergePrematureRootClose` → `balanceClosers` → `normalizeStructure` → `normalizeSummary`）。修复失败就显式报错降级，**绝不静默伪造成功结果**。顶层 8 个字段：`jdParse / diagnosis / matching / probes / rewrite / resumeBase / interview / positioning`；`interview.statusChallenges`（在职状态质疑应对）与 `positioning`（年龄/经验段的 HR 预期）为 v2 新增。
- **单一口径**：分析只锚定用户提供的 JD 原文，`jd` 必填；无「通用版/无 JD」模式（曾短暂支持，已移除）。
- **日志**：每次调用写 `logs/analysis-last.json`（inputSizes、模型状态、归一化修正项），排查「简历是否送入模型」先看这里。
- **密钥纪律**：Key 只在服务端环境变量；日志/health 只报长度、前缀、字符集，绝不打印值。

### 前端（js/，加载顺序即依赖顺序）

- `data.js` — 单一真源：示例输入 `RE.sample`、风格 `RE.styles`、mock 分析结果 `RE.mock`（**Golden Dataset**，作为真实模型的评测基线保留，必须持续通过 `validateAnalysis` 全量校验）。
- `ai.js` — AI 能力层（唯一可替换点）：`RE.ai.detect/createProvider/generateBullet/buildEffectiveResume/buildExportText/extractJdFromImage`。双 provider：`deepseek`（真实调用）与 `local-mock`（离线基线），两者共用同一份 `analyze.schema.json` 契约。`RE.ai.buildEffectiveResume(analysis, bullets)` 是最终简历的单一合成入口：把第 5 步生成/编辑的 bullet 按「probe.bullet ↔ resumeBase bullet」相似度就地替换占位符，未命中的不进交付简历（仅在第 5 步提示手动合并），`trace` 记录每条去向供归因；`renderResume` / `buildResumeText` / `buildExportText` 都必须经它取数。
- `store.js` — 极简状态容器：全局单 state，`update(mutator, shouldRender)`；输入场景传 `shouldRender=false` 避免失焦。
- `ui.js` — 无框架 UI 原子组件（纯函数 → HTML 字符串），`esc()` 转义。`renderDialog` 支持 `editable`：`editable:true` 时渲染可编辑 `<textarea>`（输入只写 state、不重渲染以免失焦，复制取最新文本），底部「保存」按钮把编辑文本写入 `S.state.resumeOverrides[style]`（按风格隔离），后续复制 / PDF 导出优先使用；第 6 步提供「恢复结构化版本」清除覆盖。验证连接等只读 dialog 仍用 `<pre>`、且不显示保存按钮。
- `steps.js` — 8 个流程步骤的视图层；`app.js` — 布局渲染/导航/事件委托/分析编排。
- **PDF 导出**：零依赖方案——`#print-root` 打印专用容器 + `@media print`（styles.css）+ `window.print()`，浏览器「另存为 PDF」即交付文件；不引入 jsPDF/CDN。
- **JD 截图上传**：canvas 压缩（长边 1600px / JPEG 0.82，data: URL 不污染画布，file:// 可用）→ `/api/jd-ocr`；模型不支持图片时按 `VISION_UNSUPPORTED` 明确提示粘贴文本。

### 提示词（prompts/，数据文件而非代码常量）

`analyze.system.md`（分析提示词）、`bullet.system.md`（追问转 bullet）、`analyze.schema.json`（输出契约，前后端共用）。**调优提示词/契约改这里，不改 server.js**。

## 关键约束（违反会导致已踩过的坑复发）

- 推送前脱敏门禁：全局 `pre-push` hook（`~/.git-hooks/pre-push`）会扫描所有受 git 跟踪的文件，命中 `~/.git-sensitive-patterns`（全局）或 `.git/info/sensitive-patterns`（项目本地）中的规则时阻止推送。敏感词清单只存本地、不进仓库；被拦下时先脱敏，**不要绕过 hook**。
- 用户 bullet 回流：第 5 步的 `S.state.bullets` 不写回分析契约，只在渲染/导出时经 `RE.ai.buildEffectiveResume` 合入最终简历。任何新增的最终简历出口（页面渲染 / 复制文本 / PDF）都必须透传 `s.bullets`，否则「补充资料不生效、X/Y/N 占位符仍在」的 bug 会复发。简历文本出口还须透传 `s.resumeOverrides`（用户在导出预览中点「保存」的编辑版），否则保存操作对该出口不生效；同时 `startAnalyze` 与 `setAnalyzeError` 必须清空 `resumeOverrides`，否则上一轮保存的文本（尤其离线示例预览）会覆盖新分析结果，表现为「导出结果是 mock 数据」。
- 教育经历：`resumeBase.education` 是数组，本科 / 硕士（含在职）必须逐段成项，不得合并或遗漏；Golden Dataset 已含硕士 + 本科两段，任何契约改动后须通过 `require('./server.js').validateAnalysis(RE.ai.buildMockAnalysis(...))` 全量校验（顺带修复了 mock 曾漏 `positioning` 导致校验不过的既存缺陷）。
- 模型相关：现役模型 `deepseek-flash` / `deepseek-v4-pro`；`deepseek-chat`/`deepseek-reasoner` 已停用（2026-07-24）。`DEEPSEEK_MAX_TOKENS` 默认 32000（16K 实测会截断完整简历输出）。
- Dockerfile 必须保持 LF 换行（CRLF 会污染 RUN/HEALTHCHECK）；`.dockerignore` 必须含 `deploy-package/` 与 `_*.js`，否则部署目录会打进镜像。
- 判断第三方 API key 是否失效：必须用官方 SDK 走 `/api/verify` 端点比对，不做裸 HTTP 探测。
- 失败兜底：模型异常时前端显示失败面板并说明「简历确实已送入模型」，不得用示例数据（陈默/ERP/WMS）冒充结果——验收第 6 项专查这一点。
- 改动交付：启动服务 + 给出可操作测试路径，等用户手动确认；已有实例先停掉重启（不热重载）。

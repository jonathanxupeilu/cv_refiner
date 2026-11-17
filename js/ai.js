/* ============================================================
   ai.js · AI 能力层（唯一可替换点）
   ------------------------------------------------------------
   对外契约：
     RE.ai.detect()                    -> Promise<runtime>   探测服务端 provider
     RE.ai.createProvider()            -> { analyze(materials, onProgress) -> Promise<analysis> }
     RE.ai.generateBullet(probe, answer, ctx) -> Promise<string>
     RE.ai.buildExportText(analysis, kind) -> string
     RE.ai.buildResumeText(analysis, style) -> string

   两个 provider 共用同一份 analysis 契约（prompts/analyze.schema.json）：
     - local-mock : 完全离线，js/data.js 的 RE.mock 作为 Golden Dataset 基线
     - deepseek   : POST /api/analyze，服务端用 OpenAI 兼容 SDK 调 DeepSeek
   调用失败由 app.js 显式降级到 local-mock 并标注原因，绝不静默伪造成功。
   ============================================================ */
(function (RE) {
  'use strict';

  /* 分析阶段（用于可观测的进度反馈，体现 Agent 工作链路） */
  var PHASES = [
    '解析目标 JD / 岗位画像：职责 / 硬性与隐性要求 / 核心能力权重',
    '诊断原始简历：匹配度评分与维度拆解',
    '逐条对齐 JD 要求与简历证据强度',
    '生成经历追问，定位证据缺口',
    '重构表达：修改前 / 修改后 / 风险提示',
    '生成最终简历与面试准备材料'
  ];

  RE.ai = {};
  RE.ai.PHASES = PHASES;

  /* 运行时状态：由 /api/health 回读，供 UI 明示「当前到底是谁在分析」。
     file:// 直开或服务端未启动时探测失败，保持 local-mock。 */
  RE.runtime = {
    mode: 'local-mock',
    providerLabel: '本地 mock',
    model: '',
    baseURL: '',
    key: { loaded: false, length: 0, prefix: '' },
    forceMock: false,
    healthOk: false,
    envChanged: false,   // .env 被改过但服务未重启
    pendingKey: false,   // 磁盘上已有 Key，只差重启
    reason: '尚未探测服务端'
  };

  /* 访问口令：公开平台部署时由 URL ?token= 注入，存 sessionStorage 后自动带到 API 请求。
     未配置口令时 authToken() 为空，请求与本地开发完全一致。 */
  RE.ai.captureToken = function () {
    try {
      var q = new URLSearchParams(location.search).get('token');
      if (q) sessionStorage.setItem('re_token', q);
      return sessionStorage.getItem('re_token') || '';
    } catch (e) { return ''; }
  };
  RE.ai.authToken = function () {
    try { return sessionStorage.getItem('re_token') || ''; } catch (e) { return ''; }
  };
  RE.ai.apiFetch = function (url, opts) {
    opts = opts || {};
    var t = RE.ai.authToken();
    if (t) opts.headers = Object.assign({}, opts.headers || {}, { 'X-Access-Token': t });
    return fetch(url, opts);
  };

  RE.ai.detect = function () {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 2500) : null;
    return Promise.resolve()
      .then(function () { return RE.ai.apiFetch('/api/health', { signal: ctrl ? ctrl.signal : undefined }); })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('health ' + r.status)); })
      .then(function (h) {
        RE.runtime = {
          mode: h.mode === 'deepseek' ? 'deepseek' : 'local-mock',
          providerLabel: h.mode === 'deepseek' ? 'DeepSeek' : '本地 mock',
          model: h.model || '',
          baseURL: h.baseURL || '',
          key: h.key || { loaded: false, length: 0, prefix: '' },
          forceMock: !!h.forceMock,
          healthOk: true,
          envChanged: !!h.envChanged,
          pendingKey: !!h.pendingKey,
          authRequired: !!h.authRequired,
          reason: h.mode === 'deepseek' ? '服务端已接入真实模型' : (h.hint || '服务端未配置 Key')
        };
        return RE.runtime;
      })
      .catch(function () {
        RE.runtime.mode = 'local-mock';
        RE.runtime.providerLabel = '本地 mock';
        RE.runtime.healthOk = false;
        RE.runtime.envChanged = false;
        RE.runtime.pendingKey = false;
        RE.runtime.reason = '未探测到本地服务（file:// 直开或 server.js 未启动），使用离线 mock';
        return RE.runtime;
      })
      .then(function (rt) { if (timer) clearTimeout(timer); return rt; });
  };

  RE.ai.createProvider = function (config) {
    config = config || {};
    var mode = config.mode || RE.runtime.mode;
    return mode === 'deepseek' ? deepseekProvider(config) : mockProvider(config);
  };

  /* ---------------- local-mock ---------------- */
  function mockProvider(config) {
    var delay = config.delay == null ? 260 : config.delay;
    return {
      name: 'local-mock',
      analyze: function (materials, onProgress) {
        return new Promise(function (resolve) {
          var i = 0;
          function tick() {
            if (onProgress) onProgress(i, PHASES[i]);
            if (i >= PHASES.length) { resolve(buildAnalysis(materials)); return; }
            i += 1;
            setTimeout(tick, delay);
          }
          tick();
        });
      }
    };
  }

  /* ---------------- DeepSeek（经服务端代理） ---------------- */
  function deepseekProvider(config) {
    var heartbeatMs = config.heartbeatMs == null ? 2200 : config.heartbeatMs;
    return {
      name: 'deepseek',
      analyze: function (materials, onProgress) {
        return new Promise(function (resolve, reject) {
          var i = 0;
          if (onProgress) onProgress(0, PHASES[0]);
          /* 真实生成较慢，用阶段心跳保持可观测进度 */
          var timer = setInterval(function () {
            if (i < PHASES.length - 1) { i += 1; if (onProgress) onProgress(i, PHASES[i]); }
          }, heartbeatMs);

          RE.ai.apiFetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              materials: materials,
              mode: materials.mode === 'generic' ? 'generic' : 'jd',
              schema: 'resume-expert/v2'
            })
          })
            .then(function (r) {
              return r.json().then(function (p) {
                if (!r.ok || !p.ok || !p.analysis) {
                  throw makeAiError(p, r.status);
                }
                return p.analysis;
              });
            })
            .then(function (analysis) {
              clearInterval(timer);
              if (onProgress) onProgress(PHASES.length, '完成');
              resolve(analysis);
            })
            .catch(function (err) {
              clearInterval(timer);
              reject(err && err.code ? err : makeAiError({ code: 'NETWORK', message: String(err && err.message || err) }, 0));
            });
        });
      }
    };
  }

  function makeAiError(p, status) {
    var e = new Error(p.message || ('服务端返回 ' + status));
    e.code = p.code || 'UPSTREAM_ERROR';
    e.hint = p.hint || '';
    e.errors = p.errors || [];
    e.status = status;
    return e;
  }

  /* 组装分析产物：结构固定，meta 来自用户输入，正文来自 RE.mock（Golden Sample） */
  function buildAnalysis(materials) {
    var now = new Date();
    return {
      meta: {
        mode: materials.mode === 'generic' ? 'generic' : 'jd',
        position: materials.position || '目标岗位',
        industry: materials.industry || '',
        companyType: materials.companyType || '',
        stage: materials.stage || '',
        generatedAt: pad(now.getHours()) + ':' + pad(now.getMinutes()),
        provider: 'local-mock',
        score: RE.mock.diagnosis.score
      },
      jdParse:      RE.mock.jdParse,
      diagnosis:    RE.mock.diagnosis,
      matching:     RE.mock.matching,
      probes:       RE.mock.probes,
      rewrite:      RE.mock.rewrite,
      resumeBase:   RE.mock.resumeBase,
      interview:    RE.mock.interview
    };
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  /* 供「主动查看离线示例」使用：示例数据永远不会被当作用户的分析结果 */
  RE.ai.buildMockAnalysis = buildAnalysis;

  /* 基于追问回答生成可用 bullet（返回 Promise）。
     无回答时直接用预置示范 bullet，不发请求（省 8 次调用）。
     真实模型失败时静默回退到本地拼接，不打断填写流程。 */
  RE.ai.generateBullet = function (probe, answer, ctx) {
    var a = (answer || '').trim();
    if (!a) return Promise.resolve(probe.bullet);
    ctx = ctx || {};

    if (RE.runtime.mode === 'deepseek') {
      return RE.ai.apiFetch('/api/bullet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          probe: { category: probe.category, question: probe.question, why: probe.why, hint: probe.hint, bullet: probe.bullet },
          answer: a, position: ctx.position || '', jd: ctx.jd || ''
        })
      })
        .then(function (r) { return r.json().then(function (p) { return (r.ok && p.ok && p.bullet) ? p.bullet : null; }); })
        .then(function (bullet) { return bullet || mockBullet(probe, a); })
        .catch(function () { return mockBullet(probe, a); });
    }
    return Promise.resolve(mockBullet(probe, a));
  };

  function mockBullet(probe, answer) {
    var base = probe.bullet;
    var first = answer.split(/[。；;！!\n]/)[0].replace(/^[,，、\s]+/, '').trim();
    if (!first) return base;
    if (first.length > 46) first = first.slice(0, 46) + '…';
    return base + '（结合你的补充：' + first + '）';
  }

  /* JD 截图 → JD 文本（POST /api/jd-ocr，OpenAI 兼容多模态）。
     需要服务端已接入真实模型；mock 模式 / 模型不支持图片时显式报错，不静默。 */
  RE.ai.extractJdFromImage = function (dataURL) {
    return RE.ai.apiFetch('/api/jd-ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataURL })
    })
      .then(function (r) {
        return r.json().then(function (p) {
          if (!r.ok || !p.ok || !p.jd) throw makeAiError(p, r.status);
          return p.jd;
        });
      });
  };

  /* 生成最终简历纯文本（用于导出 / 复制） */
  RE.ai.buildResumeText = function (analysis, style) {
    var b = analysis.resumeBase;
    var s = pick(style, b.summaryByStyle);
    var caps = b.capabilityByStyle[style] || b.capabilityByStyle.balanced;
    var L = [];
    L.push(b.personal.name + '　|　' + analysis.meta.position);
    L.push(b.personal.contact);
    L.push('');
    L.push('【求职意向】' + b.intention.line);
    L.push(b.intention.sub);
    L.push('');
    L.push('【职业摘要】');
    L.push(s);
    L.push('');
    L.push('【核心能力】' + caps.join(' · '));
    L.push('');
    L.push('【工作经历】');
    b.experience.forEach(function (e) {
      L.push(e.period + '　' + e.company + '　' + e.role);
      e.bullets.forEach(function (x) { L.push('  - ' + x); });
      L.push('');
    });
    L.push('【项目经历】');
    b.projects.forEach(function (p) {
      L.push(p.name + '　' + p.period);
      p.bullets.forEach(function (x) { L.push('  - ' + x); });
      L.push('');
    });
    L.push('【技能工具】');
    b.skills.forEach(function (x) { L.push('  ' + x.k + '：' + x.v); });
    L.push('');
    L.push('【教育背景】' + b.education.period + '　' + b.education.school + '　' + b.education.major + '　' + b.education.degree);
    return L.join('\n');
  };

  /* 生成导出文本：resume / interview / full */
  RE.ai.buildExportText = function (analysis, kind, ctx) {
    ctx = ctx || {};
    var style = ctx.style || 'balanced';
    var L = [];
    if (kind === 'resume') {
      L.push(RE.ai.buildResumeText(analysis, style));
    } else if (kind === 'interview') {
      var iv = analysis.interview;
      L.push('面试准备材料 · ' + analysis.meta.position);
      L.push('');
      L.push('一、在职状态 × 时间线：针对性质疑与应对');
      (iv.statusChallenges || []).forEach(function (c, i) {
        L.push((i + 1) + '. 质疑：「' + c.challenge + '」');
        L.push('   HR 真实在筛：' + c.risk);
        L.push('   回答策略：' + c.strategy);
      });
      L.push('');
      L.push('二、10 个可能被追问的问题');
      iv.questions.forEach(function (q, i) {
        L.push((i + 1) + '. ' + q.q);
        L.push('   考察点：' + q.focus);
        L.push('   回答要点：' + q.points);
      });
      L.push('');
      L.push('三、需要准备的证据');
      iv.evidences.forEach(function (e) { L.push('  - ' + e.t + '（来源：' + e.from + '；用途：' + e.why + '）'); });
      L.push('');
      L.push('四、可能夸大的表达');
      iv.exaggerations.forEach(function (e) { L.push('  - ' + e.text + '｜风险：' + e.risk + '｜建议：' + e.fix); });
      L.push('');
      L.push('五、建议补充的数据');
      iv.dataGaps.forEach(function (d) { L.push('  - ' + d.item + '：需补 ' + d.need + '（用于 ' + d.use + '）'); });
      L.push('');
      L.push('六、自我介绍（60-90 秒）');
      L.push(iv.intro);
    } else {
      L.push('简历专家 · 完整分析报告');
      L.push('目标岗位：' + analysis.meta.position + '｜行业：' + analysis.meta.industry +
        '｜模式：' + (analysis.meta.mode === 'generic' ? '通用版（岗位画像为模型推断）' : 'JD 定制版'));
      L.push('匹配度评分：' + analysis.meta.score + ' / 100｜生成时间：' + analysis.meta.generatedAt);
      L.push('');
      L.push('========== 2. JD 解析 ==========');
      L.push('一句话：' + analysis.jdParse.meta.oneLine);
      L.push('职责：'); analysis.jdParse.responsibilities.forEach(function (x, i) { L.push('  ' + (i + 1) + '. ' + x); });
      L.push('硬性要求：'); analysis.jdParse.hard.forEach(function (x, i) { L.push('  ' + (i + 1) + '. ' + x); });
      L.push('隐性要求：'); analysis.jdParse.implicit.forEach(function (x) { L.push('  - ' + x); });
      L.push('');
      L.push('========== 3. 简历诊断 ==========');
      L.push('结论：' + analysis.diagnosis.verdict);
      analysis.diagnosis.dimensions.forEach(function (d) { L.push('  - ' + d.name + '：' + d.score + '（' + d.note + '）'); });
      L.push('');
      L.push('========== 4. 匹配分析 ==========');
      analysis.matching.rows.forEach(function (r, i) {
        L.push('  ' + (i + 1) + '. ' + r.requirement);
        L.push('     证据：' + r.evidence + '｜强度：' + r.strength + '｜补充：' + r.need);
        L.push('     建议：' + r.advice);
      });
      L.push('');
      L.push('========== 5. 经历追问 ==========');
      analysis.probes.forEach(function (p, i) { L.push('  ' + (i + 1) + '. [' + p.category + '] ' + p.question); });
      L.push('');
      L.push('========== 6. 简历优化（' + styleLabel(style) + '）==========');
      analysis.rewrite.forEach(function (r, i) {
        L.push('  ' + (i + 1) + '. ' + r.part);
        L.push('     修改前：' + r.before);
        L.push('     修改后：' + pick(style, r.after));
        L.push('     理由：' + r.reason);
        L.push('     风险：' + r.risk);
      });
      L.push('');
      L.push('========== 最终简历 ==========');
      L.push(RE.ai.buildResumeText(analysis, style));
      L.push('');
      L.push('========== 7. 面试准备 ==========');
      L.push('在职状态质疑应对（详见面试材料）：');
      (analysis.interview.statusChallenges || []).forEach(function (c, i) { L.push('  ' + (i + 1) + '. ' + c.challenge + ' → ' + c.risk.slice(0, 60) + '…'); });
      L.push('');
      analysis.interview.questions.forEach(function (q, i) { L.push('  ' + (i + 1) + '. ' + q.q); });
    }
    return L.join('\n');
  };

  function pick(style, obj) { return obj[style] || obj.balanced || Object.values(obj)[0]; }
  function styleLabel(s) {
    var found = (RE.styles || []).filter(function (x) { return x.key === s; })[0];
    return found ? found.label : s;
  }

})(window.RE = window.RE || {});

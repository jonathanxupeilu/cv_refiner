/* ============================================================
   steps.js · 8 个流程步骤的视图层
   每个 render(s) 返回步骤主体 HTML（不含标题头与底部导航，由 app.js 统一包裹）
   ============================================================ */
(function (RE) {
  'use strict';

  var U = RE.ui, esc = U.esc;

  RE.steps = {};

  RE.steps.meta = [
    { id: 1, title: '输入材料',       desc: '录入岗位与原始简历',     kicker: 'STEP 01 / 08', head: '输入材料', headDesc: '录入目标岗位、目标 JD 与原始简历，Agent 全部分析以 JD 原文为准。材料越具体，证据定位越准。' },
    { id: 2, title: 'JD 解析',        desc: '拆职责 / 要求 / 能力',   kicker: 'STEP 02 / 08', head: 'JD 解析', headDesc: '把岗位描述拆成职责、硬性要求、隐性要求、关键词与核心能力权重，作为后续所有匹配的统一口径。' },
    { id: 3, title: '简历诊断',       desc: '评分与问题定位',         kicker: 'STEP 03 / 08', head: '简历诊断', headDesc: '按 JD 口径给原始简历打匹配度评分，拆维度、列问题、排修改优先级。' },
    { id: 4, title: '匹配分析',       desc: '要求 × 证据 × 强度',     kicker: 'STEP 04 / 08', head: '匹配分析', headDesc: '逐条把 JD 要求对齐到简历证据，标注证据强度与补充必要性，明确哪些是硬缺口。' },
    { id: 5, title: '经历追问',       desc: '填写回答生成 bullet',    kicker: 'STEP 05 / 08', head: '经历追问', headDesc: '针对证据缺口生成追问。填写回答后，Agent 会把你的原始表述转成可直接用于简历的 bullet。' },
    { id: 6, title: '简历优化',       desc: '对照重构 + 最终简历',    kicker: 'STEP 06 / 08', head: '简历优化', headDesc: '逐条展示「修改前 → 修改后 → 修改理由 → 风险提示」，切换表达风格，并输出完整优化版简历。' },
    { id: 7, title: '面试准备',       desc: '追问 / 证据 / 自我介绍', kicker: 'STEP 07 / 08', head: '面试准备', headDesc: '预判面试官追问、待准备证据、可能夸大的表达、建议补充的数据，并给出自我介绍逐字稿。' },
    { id: 8, title: '导出结果',       desc: '复制 / 导出 PDF',        kicker: 'STEP 08 / 08', head: '导出结果', headDesc: '汇总本次分析结果：最终简历可导出 PDF（浏览器打印 → 另存为 PDF），其余内容可复制到剪贴板。' }
  ];

  /* 统一的取数入口：未分析时锁定 2-8 */
  RE.steps.renderBody = function (step, s) {
    if (step > 1 && !s.analyzed) {
      return U.empty('◌', '该步骤尚未生成', '请先在「输入材料」中点击「开始分析」，Agent 会一次性生成全部 8 步结果。',
        '<button class="btn accent" data-action="goto" data-step="1">返回输入材料</button>');
    }
    var fn = RE.steps.render[step];
    return fn ? fn(s) : '';
  };

  /* ========================================================
     STEP 1 · 输入材料
     ======================================================== */
  function inputField(label, key, val, opts) {
    opts = opts || {};
    return '<div class="field">' +
      '<label class="label">' + esc(label) + (opts.req ? '<span class="req">*</span>' : '') +
        (opts.opt ? '<span class="opt">' + esc(opts.opt) + '</span>' : '') + '</label>' +
      (opts.hint ? '<div class="field-hint">' + esc(opts.hint) + '</div>' : '') +
      '<input class="input" data-model="' + key + '" value="' + esc(val) + '" placeholder="' + esc(opts.ph || '') + '" />' +
    '</div>';
  }

  function selectField(label, key, val, options) {
    var opts = options.slice();
    if (val && opts.indexOf(val) === -1) opts.unshift(val);
    return '<div class="field">' +
      '<label class="label">' + esc(label) + '</label>' +
      '<select class="select" data-model="' + key + '">' +
        '<option value="">请选择…</option>' +
        opts.map(function (o) {
          return '<option value="' + esc(o) + '"' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>';
        }).join('') +
      '</select></div>';
  }

  function textareaField(label, key, val, opts) {
    opts = opts || {};
    return '<div class="field">' +
      '<label class="label">' + esc(label) + (opts.req ? '<span class="req">*</span>' : '') +
        (opts.opt ? '<span class="opt">' + esc(opts.opt) + '</span>' : '') + '</label>' +
      (opts.hint ? '<div class="field-hint">' + esc(opts.hint) + '</div>' : '') +
      '<textarea class="textarea' + (opts.mono ? ' mono' : '') + '" data-model="' + key + '" rows="' + (opts.rows || 4) + '" placeholder="' + esc(opts.ph || '') + '">' + esc(val) + '</textarea>' +
    '</div>';
  }

  var INDUSTRIES = ['企业服务 / SaaS', '互联网 / 平台', '金融 / 保险', '零售 / 电商', '制造 / 供应链', '医疗 / 政企', '其他'];
  var COMPANY_TYPES = ['B 轮及以上成长型公司', '大厂 / 成熟业务线', '初创（A 轮及以前）', '国企 / 传统企业数字化', '外企', '不限'];
  var STAGES = ['转岗求职 · 已开始投递', '在职看机会', '定向准备某家公司面试', '已拿 offer 谈薪', '应届 / 实习'];

  RE.steps.render = {};

  RE.steps.render[1] = function (s) {
    var m = s.materials;
    var canAnalyze = !!(m.jd.trim() && m.resume.trim());

    var actionBar =
      '<div class="card card-subtle" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:22px">' +
        '<div style="flex:1;min-width:220px">' +
          '<div class="card-title">快速开始</div>' +
          '<div class="card-hint">可一键载入「3-5 年产品经理转 AI 产品经理」示例，或自行粘贴 JD 与简历。</div>' +
        '</div>' +
        '<div class="btn-row">' +
          '<button class="btn" data-action="use-sample">使用示例数据</button>' +
          '<button class="btn ghost" data-action="clear">清空</button>' +
          '<button class="btn accent" data-action="analyze" ' + (canAnalyze && !s.analyzing ? '' : 'disabled') + '>开始分析 →</button>' +
        '</div>' +
      '</div>';

    if (s.analyzing) {
      return actionBar + analyzePanel(s);
    }

    var jdSection = U.section('目标 JD', 'B', '解析与匹配的唯一口径来源',
          '<div class="card">' +
            '<div class="jd-upload-row">' +
              '<label class="btn sm">📷 上传 JD 截图<input type="file" accept="image/png,image/jpeg,image/webp" data-jd-file hidden /></label>' +
              '<span class="card-hint">招聘 App 的 JD 截图可直接上传，由模型转录为文本（长边自动压缩至 1600px）；也可以直接粘贴文本。</span>' +
              (m.jdImage
                ? '<span class="jd-preview"><img class="jd-thumb" src="' + m.jdImage + '" alt="JD 截图预览" />' +
                  '<button class="btn xs" data-action="clear-jd-image">移除截图</button></span>'
                : '') +
            '</div>' +
            '<div class="mt12">' +
              textareaField('岗位描述原文', 'jd', m.jd, { req: true, mono: true, rows: 10, ph: '粘贴完整 JD，包含职责与任职要求…', hint: '建议保留职责 / 要求编号，隐性要求的识别更准。' }) +
            '</div>' +
          '</div>');

    var form =
      U.section('岗位与求职背景', 'A', '决定匹配口径与表达侧重',
        '<div class="card"><div class="grid-2">' +
          inputField('目标岗位', 'position', m.position, { req: true, ph: '如：AI 产品经理（B 端智能应用方向）' }) +
          selectField('目标行业', 'industry', m.industry, INDUSTRIES) +
          selectField('公司类型', 'companyType', m.companyType, COMPANY_TYPES) +
          selectField('求职阶段', 'stage', m.stage, STAGES) +
        '</div>' +
        textareaField('希望突出的能力', 'highlight', m.highlight, { rows: 2, ph: '如：B 端业务抽象、数据驱动、0→1 落地…' }) +
        '</div>') +

      jdSection +

      U.section('原始简历与补充信息', 'C', '',
        '<div class="card">' +
          textareaField('原始简历', 'resume', m.resume, { req: true, mono: true, rows: 11, ph: '粘贴当前简历全文…' }) +
          textareaField('补充信息', 'extra', m.extra, { rows: 5, mono: true, ph: '未被写进简历、但可能很有价值的经历：内部 POC、自学、带人、获奖…', hint: 'Agent 会从这里挖掘「被埋没的证据」，示例中的 LLM 报表问数 POC 就来自这一栏。' }) +
        '</div>');

    return actionBar + providerBlock(s) + form;
  };

  /* 当前 provider 状态：明示「到底是谁在分析」，避免把 mock 结果误当真实结果 */
  function providerBlock(s) {
    var rt = s.runtime || RE.runtime;
    var isDeep = rt.mode === 'deepseek';
    var km = rt.key || { loaded: false, length: 0, prefix: '' };
    var lines;
    if (isDeep) {
      lines = '<strong>DeepSeek 已接入</strong> · 模型 <code>' + esc(rt.model) + '</code> · 端点 <code>' + esc(rt.baseURL) + '</code><br>' +
        'Key 已加载（长度 ' + (km.length || 0) + '，前缀 ' + esc(km.prefix || '') + '…）。分析会调用真实模型，通常 10-60 秒；' +
        '输出按 <code>prompts/analyze.schema.json</code> 严格校验。<strong>失败会明确报错，不会用示例数据冒充你的简历结果。</strong>';
    } else {
      lines = '<strong>本地 mock 模式</strong>：材料不上传，结果来自 <code>js/data.js</code> 的离线基线（Golden Dataset），可用于真实模型上线前的回归对比。<br>' +
        (rt.pendingKey
          ? '已检测到 <code>.env</code> 写入了 Key，<strong>只差重启服务</strong>（见下方提示）。'
          : '切换真实模型：本地开发在 <code>.env</code> 写 <code>DEEPSEEK_API_KEY=sk-…</code>；<b>部署在创空间时，到「设置 → 环境变量 → 添加密文变量」填 <code>DEEPSEEK_API_KEY</code>，保存后重启创空间</b>。') +
        (rt.healthOk ? '' : '<br><span class="txt-3">当前未探测到本地服务：' + esc(rt.reason || '') + '</span>');
    }
    /* 失败面板：直接证明「简历已提交」，并说明失败发生在模型输出解析阶段，不是输入丢失 */
    var e = s.analyzeError;
    var errHtml = e ? '<div class="callout risk mt8">' +
      '<strong>模型分析失败，未生成结果</strong>　' + U.badge(e.code, 'red') + '<br>' +
      esc(e.message) +
      (e.hint ? '<br><span class="txt-3">' + esc(e.hint) + '</span>' : '') +
      (e.input ? '<br><span class="txt-3">已提交：目标 JD ' + e.input.jd + ' 字 / 原始简历 ' + e.input.resume +
        ' 字 / 补充信息 ' + e.input.extra + ' 字 —— <b>简历确实已送入模型</b>，失败发生在解析模型返回内容的结构阶段，不是输入丢失。</span>' : '') +
      '<div class="btn-row mt12">' +
        '<button class="btn accent sm" data-action="analyze">重试分析</button>' +
        '<button class="btn sm" data-action="load-demo">查看离线示例预览</button>' +
        '<span class="txt-3" style="font-size:11.5px">为保证可信，失败时不会用示例数据冒充你的简历分析结果。</span>' +
      '</div></div>' : '';
    /* 填了 Key 但忘重启是最常见的误判来源：明确区隔「没填」与「填了没生效」 */
    var pendingHtml = rt.pendingKey ? '<div class="callout warn mt8">' +
      '<strong>检测到 .env 已写入 Key，但服务未重启</strong>：配置只在进程启动时读取一次。<br>' +
      '请停掉当前服务后重新运行 <code>node server.js</code>，再刷新本页；启动日志应出现 ' +
      '<code>DEEPSEEK_API_KEY : 已加载（长度 …，前缀 sk-…）</code>。' +
      '<br><span class="txt-3">也可用 <code>npm run verify</code> 程序化回读，不要把「未重启」误判成「Key 无效」。</span></div>' : '';

    return '<div class="card card-subtle" style="margin-bottom:22px">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">' +
        U.badge(rt.providerLabel, isDeep ? 'blue' : 'neutral') +
        (rt.healthOk ? '<button class="btn xs" data-action="verify">SDK 验证连接</button>' : '') +
        '<span class="card-hint" style="margin-left:auto">' + esc(rt.reason || '') + '</span>' +
      '</div>' +
      '<div style="font-size:12.5px;color:var(--text-2);line-height:1.75">' + lines +
        (rt.authRequired
          ? '<br><span class="badge ' + (RE.ai.authToken() ? 'green' : 'amber') + '">' +
            (RE.ai.authToken() ? '访问口令已生效' : '需要访问口令') + '</span> ' +
            (RE.ai.authToken()
              ? '本次链接已带口令，可正常调用 API。'
              : '本空间已启用访问口令，请在链接后追加 <code>?token=你的口令</code> 再刷新。')
          : '') +
        (s.demoMode ? '<br><span class="badge amber">离线示例预览</span> 当前全流程展示的是示例用户「陈默」的 Demo 数据，<b>不是你的简历分析结果</b>。' : '') +
      '</div>' +
    '</div>' + errHtml + pendingHtml;
  }

  function analyzePanel(s) {
    var phases = RE.ai.PHASES.map(function (p, i) {
      var cls = i < s.analyzePhase ? 'done' : (i === s.analyzePhase ? 'on' : '');
      return '<div class="analyze-phase ' + cls + '">' +
        '<span class="ap-dot"></span><span>' + esc(p) + '</span>' +
        (i < s.analyzePhase ? '<span class="ap-done">完成</span>' : '') +
      '</div>';
    }).join('');
    var rt = s.runtime || RE.runtime;
    var isDeep = rt.mode === 'deepseek';
    return '<div class="analyze-panel">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">' +
        '<span class="badge blue">Agent 运行中</span>' +
        U.badge(rt.providerLabel, isDeep ? 'blue' : 'neutral') +
        '<span class="txt-3" style="font-size:12px">' + Math.min(s.analyzePhase, RE.ai.PHASES.length) + ' / ' + RE.ai.PHASES.length + ' 阶段</span>' +
      '</div>' + phases +
      '<div class="divider"></div>' +
      '<div class="card-hint">' + (isDeep
        ? '真实模型 ' + esc(rt.model) + ' 正在生成结构化结果（含 5 种表达风格），通常 10-40 秒；阶段为链路进度心跳，不代表模型已返回。'
        : '正在按 JD 口径逐层解析，结果将一次性解锁全部 8 个步骤。') + '</div>' +
    '</div>';
  }

  /* ========================================================
     STEP 2 · JD 解析
     ======================================================== */
  RE.steps.render[2] = function (s) {
    var d = s.analysis.jdParse;

    var overview = U.card(
      '<div class="card-title">岗位一句话</div>' +
      '<div style="font-size:14px;margin-top:6px">' + esc(d.meta.oneLine) + '</div>' +
      '<div class="grid-4 mt16">' +
        miniStat('岗位', d.meta.position) + miniStat('层级', d.meta.level) +
        miniStat('领域', d.meta.domain) + miniStat('关键词', d.keywords.length + ' 个') +
      '</div>', { cls: 'card-subtle' });

    var respList = '<div class="list">' + d.responsibilities.map(function (x, i) {
      return '<div class="list-item"><span class="li-mark">' + (i + 1) + '</span><div class="li-body"><div class="li-title">' + esc(x) + '</div></div></div>';
    }).join('') + '</div>';

    var hardList = '<div class="list">' + d.hard.map(function (x, i) {
      return '<div class="list-item"><span class="li-mark">' + (i + 1) + '</span><div class="li-body"><div class="li-title">' + esc(x) + '</div></div></div>';
    }).join('') + '</div>';

    var implicitList = '<div class="list">' + d.implicit.map(function (x, i) {
      return '<div class="list-item"><span class="li-mark" style="background:var(--violet-soft);color:var(--violet)">' + (i + 1) + '</span><div class="li-body"><div class="li-title" style="font-weight:520">' + esc(x) + '</div></div></div>';
    }).join('') + '</div>';

    var keywords = '<div class="tag-row">' + d.keywords.map(function (k) { return '<span class="tag">' + esc(k) + '</span>'; }).join('') + '</div>';

    var compRows = d.competency.map(function (c) {
      return [
        '<b>' + esc(c.name) + '</b><span class="cell-sub">' + U.badge(c.level, c.level === '核心' ? 'blue' : (c.level === '加分' ? 'neutral' : 'green')) + '</span>',
        '<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;min-width:70px">' + U.progress(c.weight * 4, c.level === '核心' ? '' : 'green') + '</div><span class="nowrap txt-3" style="font-size:11.5px">' + c.weight + '%</span></div>',
        esc(c.desc),
        '<span class="muted">' + esc(c.basis) + '</span>'
      ];
    });

    return overview +
      U.section('职责拆解', '01', d.responsibilities.length + ' 条', U.card(respList)) +
      U.section('硬性要求', '02', '必须命中', U.card(hardList)) +
      U.section('隐性要求', '03', '字里行间的真实筛选标准',
        U.card(implicitList) +
        '<div class="mt12">' + U.callout('<strong>关键判断</strong>：JD 两次出现「可衡量 / 评测体系」，且明确「企业信息化 / 经营分析背景优先」——本次机会窗口正是「有指标治理经验 + 开始碰 LLM」的转型候选人。', 'warn') + '</div>') +
      U.section('关键词', '04', d.keywords.length + ' 个', U.card(keywords)) +
      U.section('理想候选人画像', '05', '', U.callout(esc(d.idealCandidate))) +
      U.section('核心能力表', '06', '按 JD 权重排序',
        U.table(['能力 / 级别', '权重', '能力说明', 'JD 依据'], compRows));
  };

  function miniStat(label, value) {
    return '<div><div class="sc-label">' + esc(label) + '</div><div style="font-size:13px;font-weight:600;margin-top:3px">' + esc(value) + '</div></div>';
  }

  /* ========================================================
     STEP 3 · 简历诊断
     ======================================================== */
  RE.steps.render[3] = function (s) {
    var d = s.analysis.diagnosis;
    var pos = s.analysis.positioning;

    var hero = U.card(
      '<div class="score-hero">' + U.ring(d.score) +
      '<div class="score-hero-txt"><h3>当前匹配度 ' + d.score + ' / 100　' + U.badge('转型期 · 可优化', 'amber') + '</h3>' +
      '<p>' + esc(d.verdict) + '</p></div></div>');

    var dims = '<div class="card">' + d.dimensions.map(function (x) {
      return '<div class="dim-row">' +
        '<span class="dim-name">' + esc(x.name) + '</span>' +
        '<span class="dim-bar">' + U.progress(x.score, x.tone === 'green' ? 'green' : (x.tone === 'amber' ? 'amber' : 'red')) + '</span>' +
        '<span class="dim-score">' + x.score + '</span>' +
        '<span class="dim-note">' + esc(x.note) + '</span>' +
      '</div>';
    }).join('') + '</div>';

    var problems = '<div class="list">' + d.problems.map(function (p, i) {
      return '<div class="list-item"><span class="li-mark">' + (i + 1) + '</span><div class="li-body">' +
        '<div class="li-title">' + esc(p.title) + '　' + U.level(p.level) + '</div>' +
        '<div class="li-detail">' + esc(p.detail) + '</div></div></div>';
    }).join('') + '</div>';

    var sugg = '<div class="list">' + d.suggestions.map(function (x) {
      return '<div class="list-item"><span class="li-mark" style="background:var(--accent-soft);color:var(--accent)">' + x.priority + '</span>' +
        '<div class="li-body"><div class="li-title">' + esc(x.title) + '</div>' +
        '<div class="li-detail">' + esc(x.detail) + '</div></div></div>';
    }).join('') + '</div>';

    var posSection = '';
    if (pos) {
      var expRows = (pos.expectations || []).map(function (e) {
        return ['<b>' + esc(e.theme) + '</b>', esc(e.expectation), '<span class="muted">' + esc(e.countermeasure) + '</span>'];
      });
      var riskRows = (pos.risks || []).map(function (r) {
        return ['<span class="cmp-risk">' + esc(r.risk) + '</span>', '<span class="muted">' + esc(r.mitigation) + '</span>'];
      });
      posSection = U.section('年龄 / 经验段的 HR 岗位预期', '04', esc(pos.ageBand) + ' · ' + esc(pos.yearsBand),
        U.table(['筛选维度', 'HR 默认预期', '本简历对策'], expRows) +
        '<div class="mt12">' + U.callout('<strong>常被预设的扣分项与化解</strong>：以下是该年龄段 / 经验段 HR 的惯性判断，简历与面试话术要提前对冲，不粉饰、也不回避。', 'warn') +
        '<div class="mt12">' + U.table(['预设偏见', '化解办法'], riskRows) + '</div>' +
        '<div class="mt12">' + U.callout('<strong>定位建议</strong>：' + esc(pos.advice)) + '</div>');
    }

    return hero +
      U.section('维度评分', '01', '6 个维度 · 强项与短板', dims) +
      U.section('主要问题', '02', d.problems.length + ' 项 · 按严重度排序', U.card(problems)) +
      U.section('优先修改建议', '03', '按 ROI 从高到低执行', U.card(sugg) +
        '<div class="mt12">' + U.callout('<strong>最高杠杆的一处</strong>：把补充信息里的「LLM 报表问数 POC」提为正文独立项目——它能一次性补齐匹配分析中的 2 个「缺失」项。') + '</div>') +
      posSection;
  };

  /* ========================================================
     STEP 4 · 匹配分析
     ======================================================== */
  RE.steps.render[4] = function (s) {
    var m = s.analysis.matching;

    var summary = '<div class="card card-subtle" style="display:flex;gap:22px;flex-wrap:wrap;align-items:center">' +
      '<div style="font-size:12.5px;color:var(--text-3)">证据强度分布 · 共 ' + m.rows.length + ' 条要求</div>' +
      U.badge('强 ' + m.summary.strong, 'green') + U.badge('中 ' + m.summary.medium, 'amber') +
      U.badge('弱 ' + m.summary.weak, 'red') + U.badge('缺失 ' + m.summary.missing, 'red') +
      '</div>';

    var rows = m.rows.map(function (r, i) {
      return [
        '<b>' + (i + 1) + '. ' + esc(r.requirement) + '</b>',
        esc(r.evidence),
        U.strength(r.strength),
        '<span class="' + (r.need === '否' ? 'muted' : '') + '">' + esc(r.need) + '</span>',
        '<span class="muted">' + esc(r.advice) + '</span>'
      ];
    });

    return summary +
      U.section('JD 要求 × 简历证据', '01', '强度标注决定补充优先级',
        U.table(['JD 要求', '简历证据', '证据强度', '是否补充', '优化建议'], rows)) +
      U.callout('<strong>两个硬缺口</strong>：① Prompt / RAG / Agent 应用证据只存在于补充信息、正文零覆盖；②「理解能力边界与成本」完全没有证据。' +
        '这两项不靠润色能补，必须靠「经历追问」把 POC 挖出来 —— 已自动生成 ' + s.analysis.probes.length + ' 个追问。', 'warn');
  };

  /* ========================================================
     STEP 5 · 经历追问
     ======================================================== */
  RE.steps.render[5] = function (s) {
    var probes = s.analysis.probes;
    var answered = probes.filter(function (p) { return (s.answers[p.id] || '').trim(); }).length;
    var generated = probes.filter(function (p) { return s.bullets[p.id]; }).length;

    var bar = '<div class="card card-subtle" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px">' +
      '<div style="flex:1;min-width:230px">' +
        '<div class="card-title">已生成 ' + probes.length + ' 个追问</div>' +
        '<div class="card-hint">填写回答后点「生成简历 bullet」；已填写 ' + answered + ' / ' + probes.length + '，已生成 bullet ' + generated + ' 条。</div>' +
        '<div class="mt8">' + U.progress(Math.round(answered / probes.length * 100)) + '</div>' +
      '</div>' +
      '<button class="btn" data-action="gen-all">一键生成全部 bullet</button>' +
    '</div>';

    var cards = '<div class="grid-2">' + probes.map(function (p, i) {
      var ans = s.answers[p.id] || '';
      var bul = s.bullets[p.id];
      var bulletBox = bul ?
        '<div class="bullet-box">' +
          '<div class="bb-label">✦ 可用于简历的 bullet（可编辑）</div>' +
          '<textarea data-bullet="' + p.id + '" rows="3">' + esc(bul) + '</textarea>' +
          '<div class="btn-row mt8"><button class="btn xs" data-action="copy-bullet" data-id="' + p.id + '">复制这条</button></div>' +
        '</div>' : '';
      return '<div class="probe">' +
        '<div class="probe-head"><span class="li-mark">' + (i + 1) + '</span><div style="min-width:0">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">' + U.badge(p.category, p.badge) + '</div>' +
          '<div class="probe-q">' + esc(p.question) + '</div>' +
          '<div class="probe-why">为什么问：' + esc(p.why) + '</div>' +
        '</div></div>' +
        '<div class="probe-hint">' + esc(p.hint) + '</div>' +
        '<div class="probe-body"><textarea class="textarea" data-probe="' + p.id + '" rows="3" placeholder="写下你的回答（越具体、含数字越好）…">' + esc(ans) + '</textarea></div>' +
        '<div class="probe-foot">' +
          '<span class="txt-3" style="font-size:11.5px">' + (ans.trim() ? '已填写，可生成 bullet' : '未填写 · 可直接生成示范 bullet') + '</span>' +
          '<button class="btn sm accent" data-action="gen-bullet" data-id="' + p.id + '">生成简历 bullet →</button>' +
        '</div>' + bulletBox +
      '</div>';
    }).join('') + '</div>';

    return bar + cards +
      '<div class="mt16">' + U.callout('生成的 bullet 会带上你回答中的要点；其中「X / Y / N」为<strong>待补量化占位符</strong>，交付前请替换为真实数字。' +
        '第 4 条追问不建议写进简历，会进入「面试准备 → 可能夸大的表达」清单。', 'risk') + '</div>';
  };

  /* ========================================================
     STEP 6 · 简历优化（对照表 + 最终简历）
     ======================================================== */
  RE.steps.render[6] = function (s) {
    var style = s.style;
    var items = s.analysis.rewrite;
    var styleObj = RE.styles.filter(function (x) { return x.key === style; })[0] || RE.styles[0];

    var seg = '<div class="card card-subtle" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px">' +
      '<div><div class="card-title">表达风格模拟</div><div class="card-hint">切换后「修改后」列与最终简历摘要实时重算</div></div>' +
      '<div class="seg" style="margin-left:auto">' + RE.styles.map(function (st) {
        return '<button data-action="style" data-style="' + st.key + '" class="' + (st.key === style ? 'on' : '') + '">' + esc(st.label) + '</button>';
      }).join('') + '</div>' +
    '</div>';

    var styleNote = '<div class="mb0" style="margin-bottom:18px">' + U.callout('<strong>当前风格：' + esc(styleObj.label) + '</strong>　' + esc(styleObj.desc) +
      '　<span class="txt-3">风格只改变表达，不改变事实；所有「风险提示」保持生效。</span>') + '</div>';

    var cards = items.map(function (r, i) {
      return '<div class="card" style="margin-bottom:12px">' +
        '<div style="display:flex;align-items:center;gap:9px;margin-bottom:12px">' +
          '<span class="st-idx">' + (i + 1) + '</span><b style="font-size:13px">' + esc(r.part) + '</b>' +
        '</div>' +
        '<div class="grid-2">' +
          '<div><div class="card-hint" style="margin-bottom:5px">修改前</div><div class="cmp-before">' + esc(r.before) + '</div></div>' +
          '<div><div class="card-hint" style="margin-bottom:5px">修改后 · ' + esc(styleObj.label) + '</div><div class="cmp-after">' + esc(U.pick(style, r.after)) + '</div></div>' +
        '</div>' +
        '<div class="divider" style="margin:14px 0"></div>' +
        '<div class="grid-2">' +
          '<div><span class="card-hint">修改理由　</span><span class="cmp-reason">' + esc(r.reason) + '</span></div>' +
          '<div><span class="card-hint">风险提示　</span><span class="cmp-risk">⚠ ' + esc(r.risk) + '</span></div>' +
        '</div>' +
      '</div>';
    }).join('');

    var compare = U.section('修改前 / 修改后 对照', '01', items.length + ' 处重构', cards);

    var final = U.section('最终简历（优化版）', '02', esc(styleObj.label),
      '<div class="btn-row" style="margin-bottom:12px">' +
        '<button class="btn sm" data-action="copy" data-kind="resume">复制最终简历</button>' +
        '<button class="btn sm" data-action="export-pdf">导出 PDF / 打印</button>' +
        '<span class="txt-3" style="font-size:11.5px">完整 8 个板块 · 随上方风格切换 · PDF 用打印对话框「另存为 PDF」</span>' +
      '</div>' + renderResume(s.analysis, style));

    return seg + styleNote + compare + final;
  };

  /* 完整简历渲染 */
  function renderResume(a, style) {
    var b = a.resumeBase;
    var summary = U.pick(style, b.summaryByStyle);
    var caps = b.capabilityByStyle[style] || b.capabilityByStyle.balanced;

    function sec(title, inner) {
      return '<div class="rs"><div class="rs-title">' + esc(title) + '</div>' + inner + '</div>';
    }
    var exp = b.experience.map(function (e) {
      return '<div class="rs-line"><b>' + esc(e.company) + '</b>　' + esc(e.role) +
        '　<span class="rs-meta">' + esc(e.period) + '</span></div>' +
        '<ul class="rs-bullets">' + e.bullets.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    }).join('<div style="height:12px"></div>');

    var proj = b.projects.map(function (p) {
      return '<div class="rs-line"><b>' + esc(p.name) + '</b>　<span class="rs-meta">' + esc(p.period) + '</span></div>' +
        '<ul class="rs-bullets">' + p.bullets.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    }).join('<div style="height:12px"></div>');

    var skills = b.skills.map(function (x) {
      return '<div class="rs-line"><span class="rs-meta" style="display:inline-block;width:62px">' + esc(x.k) + '</span>' + esc(x.v) + '</div>';
    }).join('');

    return '<div class="resume">' +
      '<div class="resume-head">' +
        '<div class="resume-name">' + esc(b.personal.name) + '</div>' +
        '<div class="resume-contact">' + esc(b.personal.contact) + '</div>' +
      '</div>' +
      '<div class="resume-body">' +
        sec('求职意向', '<div class="rs-line"><b>' + esc(b.intention.line) + '</b></div><div class="rs-line rs-meta">' + esc(b.intention.sub) + '</div>') +
        sec('职业摘要', '<div class="rs-summary">' + esc(summary) + '</div>') +
        sec('核心能力', '<div class="rs-cap">' + caps.map(function (c) { return U.badge(c, 'blue'); }).join('') + '</div>') +
        sec('工作经历', exp) +
        sec('项目经历', proj) +
        sec('技能工具', skills) +
        sec('教育背景', '<div class="rs-line">' + esc(b.education.period) + '　<b>' + esc(b.education.school) + '</b>　' + esc(b.education.major) + '　' + esc(b.education.degree) + '</div>') +
      '</div></div>';
  }
  RE.steps.renderResume = renderResume;

  /* ========================================================
     STEP 7 · 面试准备
     ======================================================== */
  RE.steps.render[7] = function (s) {
    var iv = s.analysis.interview;

    var sc = '<div>' + (iv.statusChallenges || []).map(function (c) {
      return '<div class="qa">' +
        '<div class="qa-q">「' + esc(c.challenge) + '」</div>' +
        '<div class="qa-points"><b>HR 真实在筛：</b>' + esc(c.risk) + '</div>' +
        '<div class="qa-points"><b>回答策略：</b>' + esc(c.strategy) + '</div>' +
      '</div>';
    }).join('') + '</div>';

    var qs = '<div>' + iv.questions.map(function (q, i) {
      return '<div class="qa">' +
        '<div class="qa-q">' + (i + 1) + '. ' + esc(q.q) + '　' + U.badge(q.focus, 'violet') + '</div>' +
        '<div class="qa-points"><b>回答要点：</b>' + esc(q.points) + '</div>' +
      '</div>';
    }).join('') + '</div>';

    var evRows = iv.evidences.map(function (e) {
      return ['<b>' + esc(e.t) + '</b>', '<span class="muted">' + esc(e.from) + '</span>', '<span class="muted">' + esc(e.why) + '</span>'];
    });

    var exRows = iv.exaggerations.map(function (e) {
      return ['<b>' + esc(e.text) + '</b>', '<span class="cmp-risk">' + esc(e.risk) + '</span>', '<span class="muted">' + esc(e.fix) + '</span>'];
    });

    var gapRows = iv.dataGaps.map(function (d) {
      return ['<b>' + esc(d.item) + '</b>', esc(d.need), '<span class="muted">' + esc(d.use) + '</span>'];
    });

    return U.section('在职状态 × 时间线：针对性质疑与应对', '01', (iv.statusChallenges || []).length + ' 条 · 基于求职阶段与简历时间线',
      U.callout('<strong>状态类质疑先于能力类问题。</strong>在职看机会、空窗期、频繁跳槽、转型动机——这些质疑不过关，后面的问题根本没有机会回答。每条先看清「HR 真实在筛什么」，再按策略准备话术。') +
      '<div class="mt12">' + U.card(sc) + '</div>') +
      U.section('10 个可能被追问的问题', '02', '含考察点与回答要点', U.card(qs)) +
      U.section('需要准备的证据', '03', '面试前逐项备齐', U.table(['证据', '从哪里取', '为什么需要'], evRows)) +
      U.section('可能夸大的表达', '04', '诚信核查重点',
        U.callout('<strong>面试官在测诚信，不在测功劳大小。</strong>凡是你没有拍板的事，主动降级措辞比硬撑更安全。', 'risk') +
        '<div class="mt12">' + U.table(['简历表达', '风险', '建议说法'], exRows) + '</div>') +
      U.section('建议补充的数据', '05', '量化缺口清单', U.table(['项目', '需要补什么', '用于哪里'], gapRows)) +
      U.section('自我介绍（60-90 秒逐字稿）', '06', '按「主线 → 可迁移能力 → POC → 短板」组织',
        U.card('<div class="script">' + esc(iv.intro) + '</div>') +
        '<div class="mt12"><button class="btn sm" data-action="copy" data-kind="interview">复制面试材料</button></div>');
  };

  /* ========================================================
     STEP 8 · 导出结果
     ======================================================== */
  RE.steps.render[8] = function (s) {
    var a = s.analysis;
    var probes = a.probes;
    var answered = probes.filter(function (p) { return (s.answers[p.id] || '').trim(); }).length;
    var generated = probes.filter(function (p) { return s.bullets[p.id]; }).length;

    var stats = '<div class="grid-4 mb0" style="margin-bottom:20px">' +
      statCard('匹配度评分', a.meta.score + ' / 100', '优化后目标 ≥ 80') +
      statCard('目标岗位', a.meta.position, a.meta.industry) +
      statCard('追问完成', answered + ' / ' + probes.length, '已生成 bullet ' + generated + ' 条') +
      statCard('表达风格', U.styleLabel(s.style), '可在第 6 步切换') +
    '</div>' +
    U.callout('<strong>本次分析来源</strong>：' + esc(a.meta.provider || 'local-mock') +
      (a.meta.model ? ' · ' + esc(a.meta.model) : '') +
      (a.meta.usage ? ' · tokens ' + (a.meta.usage.prompt_tokens || 0) + ' → ' + (a.meta.usage.completion_tokens || 0) : '') +
      (a.meta.elapsedMs ? ' · 耗时 ' + (a.meta.elapsedMs / 1000).toFixed(1) + 's' : '') +
      (s.lastFallback ? ' · <span style="color:var(--red)">已降级：' + esc(s.lastFallback.code) + '</span>' : '')) +
    '<div style="height:16px"></div>';

    var kinds = [
      { k: 'resume', label: '最终简历' },
      { k: 'interview', label: '面试准备材料' },
      { k: 'full', label: '完整分析报告' }
    ];
    var picker = '<div class="card" style="margin-bottom:16px">' +
      '<div class="card-title">选择导出内容</div>' +
      '<div class="card-hint" style="margin-bottom:12px">最终简历支持导出 PDF（打印对话框 → 另存为 PDF）；其余内容复制到剪贴板。</div>' +
      '<div class="seg">' + kinds.map(function (x) {
        return '<button data-action="export-kind" data-kind="' + x.k + '" class="' + (s.exportKind === x.k ? 'on' : '') + '">' + esc(x.label) + '</button>';
      }).join('') + '</div>' +
      '<div class="mt16 btn-row">' +
        '<button class="btn accent" data-action="copy" data-kind="' + s.exportKind + '">复制到剪贴板 →</button>' +
        '<button class="btn" data-action="preview" data-kind="' + s.exportKind + '">预览内容</button>' +
        (s.exportKind === 'resume' ? '<button class="btn primary" data-action="export-pdf">导出 PDF →</button>' : '') +
      '</div></div>';

    var text = RE.ai.buildExportText(a, s.exportKind, { style: s.style });
    var lines = text.split('\n');
    var preview = '<div class="card pad-0">' +
      '<div style="padding:12px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">' +
        '<span class="card-title mb0">内容预览</span><span class="card-hint">共 ' + lines.length + ' 行 · 仅显示前 18 行</span>' +
      '</div>' +
      '<pre style="margin:0;padding:16px 18px;font-family:var(--mono);font-size:12px;line-height:1.7;white-space:pre-wrap;color:var(--text-2);max-height:320px;overflow:auto">' +
        esc(lines.slice(0, 18).join('\n')) + (lines.length > 18 ? '\n\n…（其余 ' + (lines.length - 18) + ' 行请复制后查看）' : '') +
      '</pre></div>';

    return stats + picker + preview +
      '<div class="mt16">' + U.callout('<strong>交付前自检</strong>：把简历中所有「X / Y / N」占位符替换为真实数字；' +
        '确认「主导 / 参与」与真实角色一致；确认 POC 明确标注「未上线」。这三点直接决定面试可信度。', 'warn') + '</div>';
  };

  function statCard(label, value, sub) {
    return '<div class="card card-subtle"><div class="sc-label">' + esc(label) + '</div>' +
      '<div style="font-size:15px;font-weight:650;margin-top:4px;line-height:1.4">' + esc(value) + '</div>' +
      '<div class="card-hint" style="margin-top:3px">' + esc(sub) + '</div></div>';
  }

})(window.RE = window.RE || {});

/* ============================================================
   app.js · 应用控制器
   布局渲染 / 流程导航 / 事件委托 / 分析编排 / 复制 Dialog
   ============================================================ */
(function (RE) {
  'use strict';

  var U = RE.ui, esc = U.esc, S = RE.store;

  RE.app = {};

  /* ---------------- 布局渲染 ---------------- */
  function renderApp(s) {
    var meta = RE.steps.meta[s.currentStep - 1];
    document.getElementById('app').innerHTML =
      '<div class="layout">' +
        topbar(s) +
        '<div class="body-row">' +
          sidebar(s) +
          '<main class="main"><div class="main-inner">' +
            stepHead(meta) +
            demoBanner(s) +
            RE.steps.renderBody(s.currentStep, s) +
            stepNav(s) +
          '</div></main>' +
        '</div>' +
      '</div>';
    U.renderDialog(s.dialog);
  }

  /* 离线示例预览：所有分析步骤顶部统一打醒目来源横幅，避免被误当成用户自己的结果 */
  function demoBanner(s) {
    if (!s.demoMode || s.currentStep === 1) return '';
    return '<div class="callout warn" style="margin-bottom:20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:260px"><strong>离线示例预览</strong>：当前展示的是示例用户「陈默」的 Demo 数据，' +
      '<b>不是你的简历分析结果</b>。请回到第 1 步重新点「开始分析」生成真实结果。</div>' +
      '<button class="btn xs" data-action="goto" data-step="1">返回输入材料</button>' +
    '</div>';
  }

  function topbar(s) {
    var dot = s.analyzed ? 'done' : 'idle';
    var text = s.analyzing ? 'Agent 分析中…' :
      (s.analyzed ? '分析完成 · 匹配度 ' + s.analysis.meta.score + ' / 100' :
        (s.sampleLoaded ? '示例数据已载入 · 等待分析' : '等待输入材料'));
    var rt = s.runtime || RE.runtime;
    var badge = s.demoMode
      ? '<span class="badge amber">离线示例 Demo</span>'
      : '<span class="badge ' + (rt.mode === 'deepseek' ? 'blue' : 'neutral') + '">' +
          esc(rt.providerLabel) + (rt.mode === 'deepseek' && rt.model ? ' · ' + esc(rt.model) : '') + '</span>';
    return '<header class="topbar">' +
      '<div class="topbar-left">' +
        '<div class="brand-mark">简</div>' +
        '<span class="brand-name">简历专家</span>' +
        '<span class="brand-tag">JD 定制简历优化 Agent</span>' +
      '</div>' +
      '<div class="topbar-right">' +
        badge +
        '<span class="status-dot ' + dot + '"></span><span class="status-text">' + esc(text) + '</span>' +
        (rt.healthOk ? '<button class="btn ghost xs" data-action="verify">验证连接</button>' : '') +
        (s.analyzed ? '<button class="btn ghost sm" data-action="reset">重新开始</button>' : '') +
      '</div>' +
    '</header>';
  }

  function sidebar(s) {
    var items = RE.steps.meta.map(function (m) {
      var active = s.currentStep === m.id;
      var done = s.analyzed && s.visited[m.id] && !active;
      var locked = !s.analyzed && m.id > 1;
      var cls = 'nav-item' + (active ? ' active' : '') + (done ? ' done' : '') + (locked ? ' locked' : '');
      return '<button class="' + cls + '" data-action="goto" data-step="' + m.id + '">' +
        '<span class="nav-num">' + (done ? '✓' : m.id) + '</span>' +
        '<span class="nav-text"><span class="nav-label">' + esc(m.title) + '</span>' +
        '<span class="nav-desc">' + esc(m.desc) + '</span></span>' +
      '</button>';
    }).join('');

    var card = s.analyzed ?
      '<div class="side-card">' +
        '<div class="sc-label">当前分析</div>' +
        '<div class="sc-value">' + esc(s.analysis.meta.position) + '</div>' +
        '<div class="sc-row"><span class="sc-label">匹配度评分</span>' +
          '<span class="sc-score">' + s.analysis.meta.score + '<small> / 100</small></span></div>' +
        '<div class="mt8">' + U.progress(s.analysis.meta.score) + '</div>' +
      '</div>' :
      '<div class="side-card">' +
        '<div class="sc-label">当前分析</div>' +
        '<div class="sc-value txt-3" style="font-weight:500">尚未开始</div>' +
        '<div class="card-hint mt8">载入示例数据并点击「开始分析」即可解锁全部流程。</div>' +
      '</div>';

    return '<aside class="sidebar">' +
      '<div class="side-head">' +
        '<div class="side-title">工作流程</div>' +
        '<div class="side-progress"><b>' + s.currentStep + '</b> / 8 · ' + esc(RE.steps.meta[s.currentStep - 1].title) + '</div>' +
      '</div>' +
      '<nav class="nav-list">' + items + '</nav>' +
      card +
    '</aside>';
  }

  function stepHead(m) {
    return '<div class="step-head">' +
      '<div class="step-kicker">' + esc(m.kicker) + '</div>' +
      '<h1 class="step-title">' + esc(m.head) + '</h1>' +
      '<p class="step-desc">' + esc(m.headDesc) + '</p>' +
    '</div>';
  }

  function stepNav(s) {
    var prev = s.currentStep > 1;
    var next = s.currentStep < 8;
    return '<div class="step-nav">' +
      '<div>' + (prev ? '<button class="btn" data-action="goto" data-step="' + (s.currentStep - 1) + '">← 上一步</button>' : '') + '</div>' +
      '<span class="sn-label">' + s.currentStep + ' / 8 · ' + esc(RE.steps.meta[s.currentStep - 1].title) + '</span>' +
      '<div>' + (next
        ? '<button class="btn primary" data-action="goto" data-step="' + (s.currentStep + 1) + '">下一步 →</button>'
        : '<button class="btn accent" data-action="copy" data-kind="resume">复制最终简历</button>') +
      '</div>' +
    '</div>';
  }

  /* ---------------- 分析编排 ---------------- */
  function startAnalyze() {
    var s = S.state;
    if (s.analyzing) return;
    var isGeneric = s.materials.mode === 'generic';
    if (!s.materials.resume.trim() || (!isGeneric && !s.materials.jd.trim())) {
      U.toast(isGeneric ? '请先填写原始简历' : '请先填写目标 JD 与原始简历', false);
      return;
    }
    var materials = Object.assign({}, s.materials);
    delete materials.jdImage;   // 截图预览只在前端展示，不参与分析
    /* 记录输入规模，失败时可证明「简历确实已提交」，不是输入丢失 */
    var inputEvidence = {
      jd: materials.jd.length, resume: materials.resume.length, extra: (materials.extra || '').length
    };
    S.update(function (st) {
      st.analyzing = true; st.analyzePhase = 0;
      st.lastFallback = null; st.analyzeError = null; st.demoMode = false;
    });

    var onProgress = function (i) { S.update(function (st) { st.analyzePhase = i; }); };

    /* 先回读服务端 provider，再决定走真实模型还是离线基线 */
    RE.ai.detect().then(function (rt) {
      S.setRuntime(rt);
      return RE.ai.createProvider().analyze(materials, onProgress);
    }).then(function (analysis) {
      S.update(function (st) {
        st.analysis = analysis;
        st.analyzed = true;
        st.analyzing = false;
        st.lastFallback = null;
        st.demoMode = false;
      });
      S.go(2);
      var label = (S.state.runtime && S.state.runtime.providerLabel) || '本地 mock';
      U.toast('分析完成 · ' + label + ' · 已解锁全部 8 个步骤');
    }).catch(function (err) {
      /* 关键：失败时绝不把示例数据冒充成用户简历的分析结果 */
      S.setAnalyzeError({
        code: err.code || 'UNKNOWN',
        message: err.message || '未知错误',
        hint: err.hint || '',
        input: inputEvidence
      });
      U.toast('模型调用失败（' + (err.code || 'UNKNOWN') + '），未生成分析结果', false);
    });
  }

  /* ---------------- PDF 导出 ---------------- */
  /* 零依赖方案：把当前风格的最终简历填入隐藏打印容器，window.print() 弹出打印对话框，
     用户选「另存为 PDF」即得交付文件。@media print 只显示 print-root（styles.css），
     且 @page margin:0 使浏览器页眉页脚（应用名 / URL）无渲染空间。 */
  function exportPdf() {
    var s = S.state;
    if (!s.analyzed) { U.toast('请先完成分析', false); return; }
    /* 打印期间临时替换 title：
       ① 兜底浏览器页眉显示（部分浏览器 margin 不归零时仍会渲染）；
       ② 「另存为 PDF」的默认文件名取 document.title，改成「姓名-目标岗位」更合适 */
    var prevTitle = document.title;
    var b = s.analysis.resumeBase;
    document.title = (b.personal.name || '简历') + '-' + (s.analysis.meta.position || '').replace(/[\\/:*?"<>|]/g, '');
    document.getElementById('print-root').innerHTML =
      RE.steps.renderResume(s.analysis, s.style);
    function restoreTitle() { document.title = prevTitle; }
    window.addEventListener('afterprint', restoreTitle);
    U.toast('已唤起打印：目标打印机选「另存为 PDF」，页眉页脚不会出现');
    window.print();
    /* afterprint 兜底：个别浏览器不触发时定时恢复，重复恢复幂等 */
    setTimeout(function () {
      window.removeEventListener('afterprint', restoreTitle);
      restoreTitle();
    }, 3000);
  }

  /* ---------------- JD 截图上传 ---------------- */
  /* canvas 压缩：长边 ≤1600px、JPEG 0.82。data: URL 画图不会污染画布，file:// 直开可用。 */
  function compressImage(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('图片解码失败，请换 PNG / JPG 截图')); };
        img.onload = function () {
          var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function handleJdFile(file) {
    var s = S.state;
    if (!file) return;
    if (!/^image\//.test(file.type)) { U.toast('请选择 PNG / JPG / WebP 图片', false); return; }
    U.toast('正在压缩并识别 JD 截图…');
    compressImage(file, 1600, 0.82).then(function (dataURL) {
      S.update(function (st) { st.materials.jdImage = dataURL; });   // 显示预览
      return RE.ai.extractJdFromImage(dataURL);
    }).then(function (jd) {
      S.update(function (st) { st.materials.jd = jd; });             // 重渲染后 textarea 已带文本
      U.toast('识别完成：已转录 ' + jd.length + ' 字 JD，请核对后再开始分析');
    }).catch(function (err) {
      var msg = (err && err.code === 'VISION_UNSUPPORTED')
        ? '当前模型不支持图片识别，请直接粘贴 JD 文本'
        : ((err && err.code ? err.code + '：' : '') + (err && err.message || '识别失败'));
      U.toast(msg, false);
    });
  }

  /* ---------------- 复制 / Dialog ---------------- */
  function openCopy(kind) {
    var s = S.state;
    if (!s.analyzed) { U.toast('请先完成分析', false); return; }
    var labels = { resume: '最终简历', interview: '面试准备材料', full: '完整分析报告' };
    var text = RE.ai.buildExportText(s.analysis, kind, { style: s.style });
    S.openDialog({
      title: '复制' + (labels[kind] || '内容'),
      sub: (labels[kind] || '内容') + ' · ' + s.analysis.meta.position + ' · 当前风格：' + U.styleLabel(s.style),
      note: '<strong>交付方式</strong>：简历 PDF 用第 6 / 8 步「导出 PDF」按钮（浏览器打印 → 另存为 PDF）；本对话框用于复制文本。本次分析由 <b>' +
            esc(s.analysis.meta.provider || 'local-mock') + '</b> 产出。',
      text: text
    });
  }

  /* ---------------- 事件委托 ---------------- */
  function onClick(e) {
    /* 点击遮罩空白处关闭 */
    if (e.target.classList && e.target.classList.contains('overlay')) {
      S.closeDialog(); return;
    }
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var a = el.getAttribute('data-action');
    var s = S.state;

    switch (a) {
      case 'use-sample':
        S.loadSample(); U.toast('已载入示例数据'); break;
      case 'mode':
        S.update(function (st) { st.materials.mode = el.getAttribute('data-mode') === 'generic' ? 'generic' : 'jd'; });
        break;
      case 'clear':
        S.clearMaterials(); U.toast('已清空输入'); break;
      case 'analyze':
        startAnalyze(); break;
      case 'load-demo':
        S.loadDemo(); U.toast('已载入离线示例预览（非你的简历结果）'); break;
      case 'goto':
        S.go(parseInt(el.getAttribute('data-step'), 10)); break;
      case 'style':
        S.setStyle(el.getAttribute('data-style')); break;
      case 'gen-bullet':
        S.generateBullet(el.getAttribute('data-id')); break;
      case 'gen-all':
        U.toast('正在生成 bullet…');
        S.generateAllBullets().then(function () { U.toast('已生成全部 bullet'); });
        break;
      case 'verify':
        U.toast('正在用官方兼容 SDK 验证连接…');
        RE.ai.apiFetch('/api/verify')
          .then(function (r) { return r.json(); })
          .then(function (v) {
            S.openDialog({
              title: 'DeepSeek 连接验证',
              sub: v.conclusion || '验证完成',
              note: '<strong>程序化回读</strong>：服务端用 OpenAI 兼容 SDK 逐一比对候选端点；只有 SDK 全部端点失败且均为 401 才判定 Key 失效。',
              text: JSON.stringify(v, null, 2)
            });
          })
          .catch(function (e) { U.toast('验证失败：' + (e.message || e), false); });
        break;
      case 'copy-bullet':
        U.copy(s.bullets[el.getAttribute('data-id')] || ''); break;
      case 'copy':
      case 'preview':
        openCopy(el.getAttribute('data-kind') || 'resume'); break;
      case 'export-pdf':
        exportPdf(); break;
      case 'clear-jd-image':
        S.update(function (st) { st.materials.jdImage = ''; }); break;
      case 'export-kind':
        S.update(function (st) { st.exportKind = el.getAttribute('data-kind'); }); break;
      case 'close-dialog':
        S.closeDialog(); break;
      case 'do-copy':
        U.copy((s.dialog && s.dialog.text) || ''); break;
      case 'reset':
        S.reset(); U.toast('已重置，可重新分析'); break;
    }
  }

  function onInput(e) {
    var t = e.target;
    if (!t) return;
    if (t.hasAttribute('data-model')) {
      S.setMaterial(t.getAttribute('data-model'), t.value);
      /* 不整页重渲染，只就地更新「开始分析」按钮可用态，避免输入失焦 */
      var btn = document.querySelector('[data-action="analyze"]');
      if (btn) {
        var m = S.state.materials;
        btn.disabled = !(m.resume.trim() && (m.mode === 'generic' || m.jd.trim()));
      }
    } else if (t.hasAttribute('data-probe')) {
      S.setAnswer(t.getAttribute('data-probe'), t.value);
    } else if (t.hasAttribute('data-bullet')) {
      S.setBulletText(t.getAttribute('data-bullet'), t.value);
    }
  }

  function onChange(e) {
    var t = e.target;
    if (!t) return;
    if (t.matches && t.matches('[data-jd-file]')) {
      handleJdFile(t.files && t.files[0]);
      t.value = '';   // 允许重复选择同一文件
      return;
    }
    /* select 在部分浏览器只触发 change，兜底一次 */
    if (t.tagName === 'SELECT' && t.hasAttribute('data-model')) {
      S.setMaterial(t.getAttribute('data-model'), t.value);
    }
  }

  /* ---------------- 启动 ---------------- */
  RE.app.init = function () {
    RE.ai.captureToken();          // URL ?token=… → sessionStorage，供后续 API 请求携带
    S.subscribe(renderApp);
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    renderApp(S.state);
    /* 启动即回读 provider，顶栏明示「当前到底是谁在分析」 */
    RE.ai.detect().then(function (rt) { S.setRuntime(rt); });
  };

  RE.app.init();

})(window.RE = window.RE || {});

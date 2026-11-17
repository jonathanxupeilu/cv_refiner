/* ============================================================
   store.js · 极简状态容器
   - 全局单一 state；update(mutator, shouldRender)
   - shouldRender=false 用于输入场景：只写 state 不重渲染，避免输入框失焦
   ============================================================ */
(function (RE) {
  'use strict';

  var listeners = [];

  var state = {
    currentStep: 1,
    analyzing: false,
    analyzePhase: 0,
    analyzed: false,
    analysis: null,
    materials: blankMaterials(),
    sampleLoaded: false,
    answers: {},     // probeId -> 用户回答
    bullets: {},     // probeId -> 生成的 bullet（可编辑）
    style: 'balanced',
    exportKind: 'resume',
    dialog: null,
    visited: { 1: true },
    /* 由 /api/health 回读，UI 明示当前 provider；降级原因可归因 */
    runtime: null,
    lastFallback: null,
    bulletBusy: false,
    /* 模型失败时不再静默用示例数据冒充用户结果；demoMode 只在用户主动选择时开启 */
    analyzeError: null,
    demoMode: false
  };

  function blankMaterials() {
    return {
      mode: 'jd',     // 'jd' = JD 定制版（默认）；'generic' = 通用版（无 JD，模型推断岗位画像）
      position: '', industry: '', companyType: '', stage: '',
      highlight: '', jd: '', resume: '', extra: '',
      jdImage: ''     // JD 截图预览（dataURL，仅展示用，不参与分析）
    };
  }

  RE.store = {
    state: state,

    subscribe: function (fn) { listeners.push(fn); },

    notify: function () { listeners.forEach(function (fn) { fn(state); }); },

    /* mutator 直接修改 state；默认触发渲染 */
    update: function (mutator, shouldRender) {
      mutator(state);
      if (shouldRender !== false) RE.store.notify();
    },

    go: function (step) {
      RE.store.update(function (s) {
        s.currentStep = step;
        s.visited[step] = true;
        s.dialog = null;
      });
    },

    loadSample: function () {
      RE.store.update(function (s) {
        s.materials = Object.assign({}, RE.sample);
        s.sampleLoaded = true;
        s.answers = {};
        s.bullets = {};
      });
    },

    clearMaterials: function () {
      RE.store.update(function (s) {
        s.materials = blankMaterials();
        s.sampleLoaded = false;
      });
    },

    /* 输入专用：不渲染 */
    setMaterial: function (key, value) {
      RE.store.update(function (s) { s.materials[key] = value; }, false);
    },

    setAnswer: function (id, value) {
      RE.store.update(function (s) {
        s.answers[id] = value;
        if (s.bullets[id] != null) delete s.bullets[id]; // 回答变更后旧 bullet 失效
      }, false);
    },

    setBulletText: function (id, value) {
      RE.store.update(function (s) { s.bullets[id] = value; }, false);
    },

    setRuntime: function (rt) {
      RE.store.update(function (s) { s.runtime = rt; });
    },

    setFallback: function (info) {
      RE.store.update(function (s) { s.lastFallback = info; });
    },

    /* 异步：真实模型生成 bullet，失败由 ai.js 内部回退本地拼接 */
    generateBullet: function (id) {
      var s = RE.store.state;
      var probes = (s.analysis && s.analysis.probes) || RE.mock.probes;
      var probe = probes.filter(function (p) { return p.id === id; })[0];
      if (!probe) return Promise.resolve();
      return RE.ai.generateBullet(probe, s.answers[id], {
        position: s.analysis ? s.analysis.meta.position : s.materials.position,
        jd: s.materials.jd
      }).then(function (bullet) {
        RE.store.update(function (st) { st.bullets[id] = bullet; });
      });
    },

    generateAllBullets: function () {
      var s = RE.store.state;
      var probes = (s.analysis && s.analysis.probes) || [];
      RE.store.update(function (st) { st.bulletBusy = true; });
      return Promise.all(probes.map(function (p) {
        return RE.ai.generateBullet(p, s.answers[p.id], {
          position: s.analysis ? s.analysis.meta.position : s.materials.position,
          jd: s.materials.jd
        });
      })).then(function (list) {
        RE.store.update(function (st) {
          probes.forEach(function (p, i) { st.bullets[p.id] = list[i]; });
          st.bulletBusy = false;
        });
      }).catch(function () {
        RE.store.update(function (st) { st.bulletBusy = false; });
      });
    },

    setStyle: function (key) { RE.store.update(function (s) { s.style = key; }); },

    setExportKind: function (kind) {
      RE.store.update(function (s) { s.exportKind = kind; }, false);
    },

    openDialog: function (cfg) { RE.store.update(function (s) { s.dialog = cfg; }); },
    closeDialog: function () { RE.store.update(function (s) { s.dialog = null; }); },

    /* 真实模型失败：保留错误，不生成 analysis，绝不塞示例数据冒充结果 */
    setAnalyzeError: function (err) {
      RE.store.update(function (s) {
        s.analyzing = false;
        s.analyzed = false;
        s.analysis = null;
        s.demoMode = false;
        s.analyzeError = err;
        s.currentStep = 1;
        s.visited = { 1: true };
      });
    },

    /* 用户主动选择才载入离线示例，且全步骤打来源横幅 */
    loadDemo: function () {
      RE.store.update(function (s) {
        s.analysis = RE.ai.buildMockAnalysis(s.materials);
        s.analysis.meta.provider = 'local-mock-demo';
        s.analyzed = true;
        s.analyzing = false;
        s.analyzeError = null;
        s.demoMode = true;
        s.answers = {}; s.bullets = {};
        s.visited = { 1: true };
        s.currentStep = 1;
      });
    },

    reset: function () {
      RE.store.update(function (s) {
        s.currentStep = 1; s.analyzed = false; s.analysis = null;
        s.analyzing = false; s.analyzePhase = 0;
        s.answers = {}; s.bullets = {}; s.style = 'balanced';
        s.visited = { 1: true }; s.dialog = null;
        s.lastFallback = null; s.bulletBusy = false;
        s.analyzeError = null; s.demoMode = false;
      });
    }
  };

})(window.RE = window.RE || {});

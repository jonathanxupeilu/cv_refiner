/* ============================================================
   ui.js · 无框架 UI 原子组件（纯函数 -> HTML 字符串）
   ============================================================ */
(function (RE) {
  'use strict';

  var UI = {};
  RE.ui = UI;

  UI.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  UI.nl = function (s) { return UI.esc(s).replace(/\n/g, '<br>'); };

  UI.badge = function (text, tone) {
    return '<span class="badge ' + (tone || 'neutral') + '">' + UI.esc(text) + '</span>';
  };

  UI.progress = function (score, tone) {
    return '<div class="progress ' + (tone || '') + '"><i style="width:' + Math.max(0, Math.min(100, score)) + '%"></i></div>';
  };

  UI.section = function (title, idx, note, body) {
    return '<div class="section">' +
      '<div class="section-title">' +
        (idx != null ? '<span class="st-idx">' + UI.esc(idx) + '</span>' : '') +
        UI.esc(title) +
        (note ? '<span class="section-note">' + UI.esc(note) + '</span>' : '') +
      '</div>' + body + '</div>';
  };

  UI.card = function (body, opts) {
    opts = opts || {};
    return '<div class="card ' + (opts.cls || '') + '">' + body + '</div>';
  };

  UI.strength = function (s) {
    var map = { '强': 'green', '中': 'amber', '弱': 'red', '缺失': 'red' };
    return UI.badge(s, map[s] || 'neutral');
  };

  UI.level = function (s) {
    var map = { high: ['高优', 'red'], mid: ['中优', 'amber'], low: ['低优', 'neutral'] };
    var m = map[s] || ['—', 'neutral'];
    return UI.badge(m[0], m[1]);
  };

  UI.ring = function (score) {
    return '<div class="score-ring" style="--p:' + score + '">' +
      '<div class="num">' + score + '<small>/ 100</small></div></div>';
  };

  UI.table = function (headers, rows, opts) {
    opts = opts || {};
    var h = '<thead><tr>' + headers.map(function (x) {
      return '<th' + (x.w ? ' style="width:' + x.w + '"' : '') + '>' + UI.esc(typeof x === 'string' ? x : x.t) + '</th>';
    }).join('') + '</tr></thead>';
    var b = '<tbody>' + rows.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody>';
    return '<div class="table-wrap"><div class="tbl-scroll"><table>' + h + b + '</table></div></div>';
  };

  UI.empty = function (icon, title, desc, actionHtml) {
    return '<div class="empty"><div class="empty-icon">' + icon + '</div>' +
      '<h3>' + UI.esc(title) + '</h3><p>' + UI.esc(desc) + '</p>' +
      (actionHtml || '') + '</div>';
  };

  UI.callout = function (html, kind) {
    return '<div class="callout ' + (kind || '') + '">' + html + '</div>';
  };

  /* ---------- Dialog ---------- */
  UI.renderDialog = function (dialog) {
    var root = document.getElementById('dialog-root');
    if (!dialog) { root.innerHTML = ''; return; }
    root.innerHTML =
      '<div class="overlay" data-action="overlay">' +
        '<div class="dialog" data-stop="1">' +
          '<div class="dlg-head">' +
            '<div><div class="dlg-title">' + UI.esc(dialog.title) + '</div>' +
            (dialog.sub ? '<div class="dlg-sub">' + UI.esc(dialog.sub) + '</div>' : '') + '</div>' +
            '<button class="dlg-close" data-action="close-dialog" aria-label="关闭">✕</button>' +
          '</div>' +
          '<div class="dlg-body">' +
            (dialog.note ? '<div class="callout warn" style="margin-bottom:14px">' + dialog.note + '</div>' : '') +
            (dialog.editable
              ? '<div class="dlg-edit-hint">内容可直接编辑，复制以编辑后的文本为准。</div>' +
                '<textarea id="export-text" class="dlg-edit" spellcheck="false">' + UI.esc(dialog.text) + '</textarea>'
              : '<pre id="export-pre">' + UI.esc(dialog.text) + '</pre>') +
          '</div>' +
          '<div class="dlg-foot">' +
            '<span class="placeholder-note">简历 PDF：第 6 / 8 步「导出 PDF」按钮（打印 → 另存为 PDF）</span>' +
            (dialog.editable ? '<button class="btn primary" data-action="save-resume">保存</button>' : '') +
            '<button class="btn" data-action="close-dialog">关闭</button>' +
            '<button class="btn accent" data-action="do-copy">复制内容</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  };

  /* ---------- Toast ---------- */
  var toastTimer = null;
  UI.toast = function (msg, ok) {
    var root = document.getElementById('toast-root');
    root.innerHTML = '<div class="toast">' + (ok === false ? '✕' : '✓') + ' ' + UI.esc(msg) + '</div>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { root.innerHTML = ''; }, 2400);
  };

  UI.copy = function (text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); UI.toast('已复制到剪贴板'); }
      catch (e) { UI.toast('复制失败，请手动选择文本', false); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { UI.toast('已复制到剪贴板'); }, fallback);
    } else { fallback(); }
  };

  UI.styleLabel = function (s) {
    var f = RE.styles.filter(function (x) { return x.key === s; })[0];
    return f ? f.label : s;
  };
  UI.pick = function (style, obj) { return obj[style] || obj.balanced || Object.values(obj)[0]; };

})(window.RE = window.RE || {});

/* ============================================================================
 * utils.js — 通用工具函数
 * 说明：全部挂载在 window.KBUtil 命名空间下，避免全局污染，无需构建工具。
 * ==========================================================================*/
window.KBUtil = (function () {
  'use strict';

  var seq = 0;

  /** 生成短唯一 ID */
  function uid(prefix) {
    seq += 1;
    return (prefix || 'id') + '_' + Date.now().toString(36) + seq.toString(36);
  }

  /** HTML 转义，防止 XSS / 结构破坏 */
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 正则元字符转义 */
  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 文件体积格式化 */
  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  /** 时间格式化：今天 HH:mm / MM-DD HH:mm */
  function formatTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
  }

  /** FNV-1a 32 位哈希（用于特征哈希向量化） */
  function hash32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** 触发浏览器下载 */
  function download(filename, content, mime) {
    var blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  return {
    uid: uid,
    escapeHtml: escapeHtml,
    escapeRegExp: escapeRegExp,
    formatBytes: formatBytes,
    formatTime: formatTime,
    hash32: hash32,
    sleep: sleep,
    clamp: clamp,
    download: download
  };
})();

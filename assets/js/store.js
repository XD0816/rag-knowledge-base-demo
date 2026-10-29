/* ============================================================================
 * store.js — 本地知识库持久化层（localStorage）
 * 存储内容：文档元数据 + 切片文本 + 问答历史 + 模型设置
 * 向量不落盘：页面启动时由切片文本重建索引（毫秒级），节省 90% 存储空间。
 * ==========================================================================*/
window.KBStore = (function () {
  'use strict';

  var KEY = 'ekb.state.v1';
  var MAX_HISTORY = 60;

  var state = {
    version: 1,
    docs: [],
    chunks: [],
    history: [],
    settings: {
      useRemote: false,
      apiBase: '',
      apiKey: '',
      model: ''
    }
  };

  function defaults() {
    return {
      version: 1,
      docs: [],
      chunks: [],
      history: [],
      settings: { useRemote: false, apiBase: '', apiKey: '', model: '' }
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return state;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return state;
      state.docs = Array.isArray(parsed.docs) ? parsed.docs : [];
      state.chunks = Array.isArray(parsed.chunks) ? parsed.chunks : [];
      state.history = Array.isArray(parsed.history) ? parsed.history : [];
      state.settings = Object.assign(defaults().settings, parsed.settings || {});
      return state;
    } catch (e) {
      console.warn('[KBStore] 读取本地数据失败，已重置', e);
      state = defaults();
      return state;
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return { ok: true };
    } catch (e) {
      console.error('[KBStore] 写入失败', e);
      return {
        ok: false,
        message: '本地存储空间不足，请删除部分文档后重试'
      };
    }
  }

  function getState() { return state; }

  /* ------------------------------------------------------------- 文档 --- */
  function addDocument(meta, chunks) {
    state.docs.unshift(meta);
    for (var i = 0; i < chunks.length; i++) {
      state.chunks.push({
        id: meta.id + '_c' + i,
        docId: meta.id,
        docName: meta.name,
        page: chunks[i].page || 1,
        index: i,
        text: chunks[i].text
      });
    }
    return save();
  }

  function removeDocument(docId) {
    state.docs = state.docs.filter(function (d) { return d.id !== docId; });
    state.chunks = state.chunks.filter(function (c) { return c.docId !== docId; });
    return save();
  }

  function clearDocuments() {
    state.docs = [];
    state.chunks = [];
    return save();
  }

  /* ------------------------------------------------------------- 历史 --- */
  function addHistory(item) {
    state.history.unshift(item);
    if (state.history.length > MAX_HISTORY) {
      state.history = state.history.slice(0, MAX_HISTORY);
    }
    return save();
  }

  function clearHistory() {
    state.history = [];
    return save();
  }

  function removeHistory(id) {
    state.history = state.history.filter(function (h) { return h.id !== id; });
    return save();
  }

  /* ------------------------------------------------------------- 设置 --- */
  function updateSettings(patch) {
    state.settings = Object.assign({}, state.settings, patch);
    return save();
  }

  /* ------------------------------------------------------------- 统计 --- */
  function stats() {
    var chars = 0;
    for (var i = 0; i < state.chunks.length; i++) chars += state.chunks[i].text.length;
    var bytes = 0;
    try { bytes = (localStorage.getItem(KEY) || '').length * 2; } catch (e) { bytes = 0; }
    return {
      docCount: state.docs.length,
      chunkCount: state.chunks.length,
      charCount: chars,
      historyCount: state.history.length,
      storageBytes: bytes
    };
  }

  function reset() {
    state = defaults();
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    return state;
  }

  return {
    load: load,
    save: save,
    getState: getState,
    addDocument: addDocument,
    removeDocument: removeDocument,
    clearDocuments: clearDocuments,
    addHistory: addHistory,
    clearHistory: clearHistory,
    removeHistory: removeHistory,
    updateSettings: updateSettings,
    stats: stats,
    reset: reset
  };
})();

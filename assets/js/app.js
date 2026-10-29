/* ============================================================================
 * app.js — 应用主控制器
 * 负责：状态管理、DOM 渲染、事件绑定、上传流水线、对话交互
 * ==========================================================================*/
(function () {
  'use strict';

  var U = window.KBUtil;
  var T = window.KBText;

  /* ---------------------------------------------------------- DOM 引用 --- */
  var $ = function (id) { return document.getElementById(id); };

  var el = {};
  var state = {
    busy: false,
    processing: [],   // 正在入库的文件
    activeTab: 'kb',
    sessionStart: Date.now()
  };

  /* ------------------------------------------------------------ 图标 --- */
  var ICON = {
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    quote: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    chevron: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
  };

  /* ------------------------------------------------------------ 工具 --- */
  function toast(message, type) {
    var node = document.createElement('div');
    node.className = 'toast ' + (type || 'info');
    var color = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '#2563eb';
    node.innerHTML =
      '<span style="color:' + color + ';display:flex">' +
      (type === 'error'
        ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
        : type === 'success'
          ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
          : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>') +
      '</span><span>' + U.escapeHtml(message) + '</span>';
    el.toastStack.appendChild(node);
    setTimeout(function () {
      node.classList.add('out');
      setTimeout(function () { node.remove(); }, 240);
    }, 2800);
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise(function (resolve) {
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('btnConfirmOk').textContent = okLabel || '确定';
      el.confirmModal.classList.add('active');

      function cleanup() {
        el.confirmModal.classList.remove('active');
        $('btnConfirmOk').onclick = null;
        $('btnConfirmCancel').onclick = null;
      }
      $('btnConfirmOk').onclick = function () { cleanup(); resolve(true); };
      $('btnConfirmCancel').onclick = function () { cleanup(); resolve(false); };
    });
  }

  /* ------------------------------------------------------ 索引与统计 --- */
  function rebuildIndex() {
    var s = window.KBStore.getState();
    window.KBRag.rebuild(s.chunks);
    updateHeaderStats();
  }

  function updateHeaderStats() {
    var st = window.KBStore.stats();
    var idx = window.KBRag.stats();
    $('hdrDocCount').textContent = st.docCount;
    $('hdrChunkCount').textContent = st.chunkCount;
    $('statDocs').textContent = st.docCount;
    $('statChunks').textContent = st.chunkCount;
    $('statChars').textContent = st.charCount.toLocaleString('zh-CN');
    $('statDim').textContent = idx.dim + ' 维';

    var dot = $('statusDot');
    var label = $('statusLabel');
    if (st.docCount > 0) {
      dot.classList.remove('is-idle');
      label.textContent = '知识库就绪';
    } else {
      dot.classList.add('is-idle');
      label.textContent = '知识库为空';
    }
  }

  /* -------------------------------------------------------- 文档渲染 --- */
  function renderDocs() {
    var s = window.KBStore.getState();
    var html = '';

    // 处理中的文件
    state.processing.forEach(function (p) {
      html +=
        '<div class="doc-item is-processing" data-pid="' + p.id + '">' +
          '<div class="doc-type ' + p.type + '">' + window.KBParser.typeLabel(p.type) + '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="doc-name">' + U.escapeHtml(p.name) + '</div>' +
            '<div class="doc-meta">' + U.escapeHtml(p.label) + '</div>' +
          '</div>' +
          '<div class="doc-progress" style="width:' + p.progress + '%"></div>' +
        '</div>';
    });

    // 已入库文档
    s.docs.forEach(function (doc) {
      // 列表中去掉扩展名（类型已由左侧徽章表达），避免长文件名断行难看
      var displayName = String(doc.name).replace(/\.(pdf|docx|doc|txt|md)$/i, '');
      html +=
        '<div class="doc-item" data-doc="' + doc.id + '">' +
          '<div class="doc-type ' + doc.type + '">' + window.KBParser.typeLabel(doc.type) + '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="doc-name" title="' + U.escapeHtml(doc.name) + '">' + U.escapeHtml(displayName) + '</div>' +
            '<div class="doc-meta">' + doc.chunkCount + ' 个切片 · ' + U.formatBytes(doc.size) +
              (doc.pageCount > 1 ? ' · ' + doc.pageCount + ' 页' : '') + '</div>' +
          '</div>' +
          '<button class="doc-del" data-del="' + doc.id + '" title="移除文档">' + ICON.trash + '</button>' +
        '</div>';
    });

    if (!html) {
      html = '<div class="empty-tip">尚未上传文档<br/>支持 PDF / Word(docx) / TXT 格式</div>';
    }

    el.docList.innerHTML = html;

    el.docList.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        removeDoc(btn.getAttribute('data-del'));
      });
    });
  }

  function removeDoc(docId) {
    var s = window.KBStore.getState();
    var doc = s.docs.filter(function (d) { return d.id === docId; })[0];
    if (!doc) return;
    confirmDialog('移除文档', '确定要从知识库中移除《' + doc.name + '》吗？该文档的 ' + doc.chunkCount + ' 个切片将同时删除。', '移除')
      .then(function (ok) {
        if (!ok) return;
        window.KBStore.removeDocument(docId);
        rebuildIndex();
        renderDocs();
        toast('已移除《' + doc.name + '》', 'success');
      });
  }

  /* ---------------------------------------------------- 上传处理流水 --- */
  function setProcessing(id, progress, label) {
    var p = state.processing.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    p.progress = progress;
    p.label = label;
    var node = el.docList.querySelector('[data-pid="' + id + '"]');
    if (node) {
      var bar = node.querySelector('.doc-progress');
      var meta = node.querySelector('.doc-meta');
      if (bar) bar.style.width = progress + '%';
      if (meta) meta.textContent = label;
    }
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () { return processFile(file); });
    });
    return chain;
  }

  function processFile(file) {
    var ext = window.KBParser.extOf(file.name);
    var id = U.uid('p');

    // 格式预检
    if (ext === 'doc') {
      toast('暂不支持旧版 .doc，请另存为 .docx 后上传', 'error');
      return Promise.resolve();
    }
    if (['pdf', 'docx', 'txt', 'md'].indexOf(ext) === -1) {
      toast('不支持的文件类型：.' + ext, 'error');
      return Promise.resolve();
    }
    if (file.size > window.KBParser.MAX_SIZE) {
      toast('文件超过 20MB 限制：' + file.name, 'error');
      return Promise.resolve();
    }

    state.processing.push({ id: id, name: file.name, type: ext, progress: 4, label: '准备解析…' });
    renderDocs();

    var docId = U.uid('doc');

    return window.KBParser.parseFile(file, function (page, total) {
      setProcessing(id, 8 + Math.round(page / total * 40), '解析中 ' + page + '/' + total + ' 页');
    }).then(function (parsed) {
      setProcessing(id, 52, '文本清洗与切片…');
      var fullText = T.normalize(parsed.text);
      if (T.charCount(fullText) < 20) {
        throw new Error('未能提取到有效文本，可能是扫描版 PDF 或空文档');
      }

      var chunks = [];
      parsed.pages.forEach(function (page) {
        var pieces = T.chunkText(page.text, { size: 380, overlap: 70 });
        pieces.forEach(function (pc) {
          chunks.push({ text: pc.text, page: page.no });
        });
      });

      if (!chunks.length) throw new Error('文档内容过短，无法生成有效切片');

      setProcessing(id, 74, '向量化 ' + chunks.length + ' 个切片…');

      return U.sleep(140).then(function () {
        var meta = {
          id: docId,
          name: file.name,
          type: ext,
          size: file.size,
          pageCount: parsed.pageCount,
          charCount: T.charCount(fullText),
          chunkCount: chunks.length,
          createdAt: Date.now()
        };
        var res = window.KBStore.addDocument(meta, chunks);
        if (!res.ok) {
          window.KBStore.removeDocument(docId);
          throw new Error(res.message);
        }
        setProcessing(id, 92, '构建索引…');
        return U.sleep(80).then(function () {
          rebuildIndex();
          setProcessing(id, 100, '入库完成');
          return U.sleep(220);
        });
      }).then(function () {
        state.processing = state.processing.filter(function (x) { return x.id !== id; });
        renderDocs();
        toast('《' + file.name + '》已入库，生成 ' + chunks.length + ' 个切片', 'success');
      });
    }).catch(function (err) {
      state.processing = state.processing.filter(function (x) { return x.id !== id; });
      renderDocs();
      toast('解析失败：' + (err && err.message ? err.message : '未知错误'), 'error');
    });
  }

  /* -------------------------------------------------------- 示例语料 --- */
  function loadSamples() {
    var existing = window.KBStore.getState().docs.map(function (d) { return d.name; });
    var todo = window.KBSamples.filter(function (s) { return existing.indexOf(s.name) === -1; });
    if (!todo.length) {
      toast('示例文档已全部在知识库中', 'info');
      return;
    }

    todo.forEach(function (sample) {
      var docId = U.uid('doc');
      var text = T.normalize(sample.text);
      var chunks = T.chunkText(text, { size: 380, overlap: 70 }).map(function (c) {
        return { text: c.text, page: 1 };
      });
      window.KBStore.addDocument({
        id: docId,
        name: sample.name,
        type: 'txt',
        size: text.length * 2,
        pageCount: 1,
        charCount: T.charCount(text),
        chunkCount: chunks.length,
        createdAt: Date.now()
      }, chunks);
    });

    rebuildIndex();
    renderDocs();
    toast('已载入 ' + todo.length + ' 份示例制度文档', 'success');
  }

  /* -------------------------------------------------------- 消息渲染 --- */
  function hideEmptyState() {
    if (el.emptyState) el.emptyState.style.display = 'none';
  }

  function showEmptyState() {
    if (el.emptyState) el.emptyState.style.display = '';
  }

  function scrollToBottom(smooth) {
    var box = el.chatScroll;
    if (!box) return;
    if (smooth === false) {
      box.scrollTop = box.scrollHeight;
    } else {
      box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    }
  }

  function appendUserMessage(text) {
    var row = document.createElement('div');
    row.className = 'msg-row from-user';
    row.innerHTML =
      '<div class="avatar user">我</div>' +
      '<div class="msg-col">' +
        '<div class="bubble-user">' + U.escapeHtml(text) + '</div>' +
        '<div class="msg-time">' + U.formatTime(Date.now()) + '</div>' +
      '</div>';
    el.messageList.appendChild(row);
    scrollToBottom();
  }

  function appendThinking() {
    var row = document.createElement('div');
    row.className = 'msg-row';
    row.innerHTML =
      '<div class="avatar ai">AI</div>' +
      '<div class="msg-col">' +
        '<div class="bubble-ai">' +
          '<div class="thinking">' +
            '<span class="dots"><i></i><i></i><i></i></span>' +
            '<span class="think-text">正在检索知识库…</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    el.messageList.appendChild(row);
    scrollToBottom();
    return row;
  }

  /* 轻量 Markdown 渲染：粗体 / 列表 / 引用 / 行内引用角标 */
  function inlineFormat(text) {
    var s = U.escapeHtml(text);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[(\d+)\]/g, '<span class="cite-ref" data-cite="$1">$1</span>');
    return s;
  }

  function renderMarkdown(text) {
    var lines = String(text).split('\n');
    var html = '';
    var inList = false;

    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) {
        if (inList) { html += '</ul>'; inList = false; }
        return;
      }
      if (line.indexOf('- ') === 0) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + inlineFormat(line.slice(2)) + '</li>';
        return;
      }
      if (inList) { html += '</ul>'; inList = false; }
      if (line.indexOf('> ') === 0) {
        html += '<blockquote>' + inlineFormat(line.slice(2)) + '</blockquote>';
        return;
      }
      html += '<p>' + inlineFormat(line) + '</p>';
    });
    if (inList) html += '</ul>';
    return html;
  }

  /* 关键词高亮（占位符法，避免嵌套标签） */
  function highlight(text, keywords) {
    var escaped = U.escapeHtml(text);
    var store = [];
    (keywords || []).forEach(function (kw) {
      if (!kw || kw.length < 2) return;
      var ek = U.escapeHtml(kw);
      var re = new RegExp(U.escapeRegExp(ek), 'g');
      escaped = escaped.replace(re, function (m) {
        store.push(m);
        return '\u0000' + (store.length - 1) + '\u0000';
      });
    });
    return escaped.replace(/\u0000(\d+)\u0000/g, function (_, i) {
      return '<mark>' + store[Number(i)] + '</mark>';
    });
  }

  function scorePercent(score) {
    return Math.round(U.clamp(score * 1.7, 0.15, 0.96) * 100);
  }

  function buildCitationsHTML(hits, keywords) {
    if (!hits || !hits.length) return '';
    var items = hits.map(function (h, i) {
      var doc = h.chunk.docName;
      var page = h.chunk.page ? '第 ' + h.chunk.page + ' 页' : '';
      return (
        '<div class="cite-item" data-idx="' + i + '">' +
          '<div class="cite-top">' +
            '<span class="cite-index">' + (i + 1) + '</span>' +
            '<span class="cite-doc" title="' + U.escapeHtml(doc) + '">' + U.escapeHtml(doc) + '</span>' +
            (page ? '<span class="cite-page">' + page + '</span>' : '') +
            '<span class="cite-score">相关度 ' + scorePercent(h.score) + '%</span>' +
          '</div>' +
          '<div class="cite-text">' + highlight(h.chunk.text, keywords) + '</div>' +
          '<div class="cite-more">展开全文</div>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="citation-box">' +
        '<button class="citation-head" type="button">' +
          '<span style="display:flex;color:#2563eb">' + ICON.quote + '</span>' +
          '<span>引用来源</span>' +
          '<span class="citation-count">' + hits.length + '</span>' +
          '<span class="citation-chevron">' + ICON.chevron + '</span>' +
        '</button>' +
        '<div class="citation-list">' + items + '</div>' +
      '</div>'
    );
  }

  function bindCitationEvents(root) {
    var box = root.querySelector('.citation-box');
    if (!box) return;

    var head = box.querySelector('.citation-head');
    head.addEventListener('click', function () {
      box.classList.toggle('open');
    });

    box.querySelectorAll('.cite-more').forEach(function (more) {
      more.addEventListener('click', function (e) {
        e.stopPropagation();
        var item = more.closest('.cite-item');
        item.classList.toggle('expanded');
        more.textContent = item.classList.contains('expanded') ? '收起' : '展开全文';
      });
    });

    // 正文角标 → 展开并定位对应引用
    root.querySelectorAll('.cite-ref').forEach(function (ref) {
      ref.addEventListener('click', function () {
        var n = Number(ref.getAttribute('data-cite'));
        box.classList.add('open');
        var target = box.querySelector('.cite-item[data-idx="' + (n - 1) + '"]');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.style.transition = 'background .35s ease';
          target.style.background = '#eff6ff';
          setTimeout(function () { target.style.background = ''; }, 900);
        }
      });
    });
  }

  function renderAnswer(row, res, question) {
    var col = row.querySelector('.msg-col');
    var engineLabel = res.engine === 'remote' ? '大模型生成'
      : res.engine === 'local-fallback' ? '本地生成（接口异常降级）'
      : '本地生成';

    var trace =
      '<div class="rag-trace">' +
        '<span class="trace-dot"></span>' +
        '<span>检索 ' + res.hits.length + ' 个片段 · ' + res.retrieveMs + 'ms</span>' +
        '<span style="color:#94a3b8">|</span>' +
        '<span>' + engineLabel + '</span>' +
      '</div>';

    var keywords = T.keywords(question);
    var citations = buildCitationsHTML(res.hits, keywords);

    col.innerHTML =
      trace +
      '<div class="bubble-ai"><div class="answer-body">' + renderMarkdown(res.text) + '</div>' + citations + '</div>' +
      '<div class="msg-time">' + U.formatTime(Date.now()) + '</div>';

    bindCitationEvents(col);

    // 内容块渐入，营造"生成"节奏
    var blocks = col.querySelectorAll('.answer-body > *');
    blocks.forEach(function (b, i) {
      b.style.opacity = '0';
      b.style.transform = 'translateY(5px)';
      b.style.transition = 'opacity .28s ease, transform .28s ease';
      setTimeout(function () {
        b.style.opacity = '1';
        b.style.transform = 'translateY(0)';
      }, 60 + i * 55);
    });

    scrollToBottom();
  }

  /* ------------------------------------------------------------ 提问 --- */
  function send(question) {
    var q = String(question || '').trim();
    if (!q || state.busy) return;

    var st = window.KBStore.stats();
    if (!st.chunkCount) {
      toast('知识库为空，请先上传文档或载入示例文档', 'error');
      return;
    }

    state.busy = true;
    updateSendButton();
    el.input.value = '';
    autoResize();

    hideEmptyState();
    appendUserMessage(q);
    var row = appendThinking();
    var thinkText = row.querySelector('.think-text');

    setTimeout(function () { thinkText.textContent = '正在向量化问题并检索…'; }, 150);

    window.KBRag.ask(q, {
      settings: window.KBStore.getState().settings,
      topK: 4,
      onStage: function (stage) {
        if (stage === 'generating') thinkText.textContent = '正在生成答案…';
      }
    }).then(function (res) {
      renderAnswer(row, res, q);

      // 写入历史
      window.KBStore.addHistory({
        id: U.uid('h'),
        question: q,
        answer: res.text,
        engine: res.engine,
        ts: Date.now(),
        citations: res.hits.map(function (h) {
          return {
            docName: h.chunk.docName,
            page: h.chunk.page,
            score: Math.round(h.score * 1000) / 1000,
            text: h.chunk.text.slice(0, 400)
          };
        })
      });
      renderHistory();

      if (res.warning) toast('远程模型不可用，已使用本地生成：' + res.warning, 'error');
    }).catch(function (err) {
      console.error(err);
      var col = row.querySelector('.msg-col');
      col.innerHTML =
        '<div class="bubble-ai"><div class="answer-body"><p>抱歉，处理您的问题时出现异常：' +
        U.escapeHtml(err && err.message ? err.message : '未知错误') + '</p></div></div>';
    }).finally(function () {
      state.busy = false;
      updateSendButton();
    });
  }

  function updateSendButton() {
    el.btnSend.disabled = state.busy || !el.input.value.trim();
  }

  function autoResize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 132) + 'px';
  }

  /* ------------------------------------------------------------ 历史 --- */
  function renderHistory() {
    var s = window.KBStore.getState();
    if (!s.history.length) {
      el.historyList.innerHTML = '<div class="empty-tip">暂无问答记录<br/>发起提问后会自动保存在这里</div>';
      return;
    }

    el.historyList.innerHTML = s.history.map(function (h) {
      var brief = String(h.answer || '').replace(/[#*\->]/g, '').replace(/\s+/g, ' ').slice(0, 70);
      var cites = (h.citations || []).length;
      return (
        '<div class="history-item" data-hid="' + h.id + '">' +
          '<div class="history-q">' + U.escapeHtml(h.question) + '</div>' +
          '<div class="history-a">' + U.escapeHtml(brief) + '</div>' +
          '<div class="history-foot">' +
            '<span>' + U.formatTime(h.ts) + '</span>' +
            '<span>' + cites + ' 条引用</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    el.historyList.querySelectorAll('[data-hid]').forEach(function (node) {
      node.addEventListener('click', function () {
        var id = node.getAttribute('data-hid');
        var item = window.KBStore.getState().history.filter(function (h) { return h.id === id; })[0];
        if (item) replayHistory(item);
      });
    });
  }

  function replayHistory(item) {
    hideEmptyState();
    appendUserMessage(item.question);

    var hits = (item.citations || []).map(function (c, i) {
      return {
        score: c.score || 0.5,
        chunk: { docName: c.docName, page: c.page, text: c.text, index: i }
      };
    });

    var row = document.createElement('div');
    row.className = 'msg-row';
    row.innerHTML = '<div class="avatar ai">AI</div><div class="msg-col"></div>';
    el.messageList.appendChild(row);

    renderAnswer(row, {
      text: item.answer,
      engine: item.engine || 'local',
      hits: hits,
      retrieveMs: 0
    }, item.question);

    scrollToBottom();
    toast('已载入历史问答', 'info');
  }

  /* ------------------------------------------------------------ 导出 --- */
  function exportConversation() {
    var rows = el.messageList.querySelectorAll('.msg-row');
    if (!rows.length) {
      toast('当前没有可导出的对话', 'info');
      return;
    }

    var lines = ['# 企业智能知识库问答记录', '', '导出时间：' + new Date().toLocaleString('zh-CN'), ''];

    rows.forEach(function (row) {
      var isUser = row.classList.contains('from-user');
      if (isUser) {
        var q = row.querySelector('.bubble-user');
        lines.push('## 提问', '', q ? q.textContent : '', '');
      } else {
        var body = row.querySelector('.answer-body');
        lines.push('## 回答', '', body ? body.innerText.trim() : '', '');
        var cites = row.querySelectorAll('.cite-item');
        if (cites.length) {
          lines.push('**引用来源**', '');
          cites.forEach(function (c, i) {
            var doc = c.querySelector('.cite-doc');
            lines.push((i + 1) + '. ' + (doc ? doc.textContent : '') + ' — ' +
              c.querySelector('.cite-text').textContent.trim().slice(0, 120) + '…');
          });
          lines.push('');
        }
      }
    });

    U.download('知识库问答记录_' + Date.now() + '.md', lines.join('\n'), 'text/markdown');
    toast('对话记录已导出', 'success');
  }

  /* ------------------------------------------------------------ 设置 --- */
  function openSettings() {
    var s = window.KBStore.getState().settings;
    $('setBase').value = s.apiBase || '';
    $('setKey').value = s.apiKey || '';
    $('setModel').value = s.model || '';
    $('setUseRemote').classList.toggle('on', !!s.useRemote);
    el.settingsModal.classList.add('active');
  }

  function saveSettings() {
    var useRemote = $('setUseRemote').classList.contains('on');
    window.KBStore.updateSettings({
      useRemote: useRemote,
      apiBase: $('setBase').value.trim(),
      apiKey: $('setKey').value.trim(),
      model: $('setModel').value.trim()
    });
    el.settingsModal.classList.remove('active');
    toast(useRemote ? '已启用大模型生成（失败自动降级本地）' : '已切换为本地生成引擎', 'success');
  }

  /* ------------------------------------------------------------ 事件 --- */
  function bindEvents() {
    /* Tab 切换 */
    el.tabKb.addEventListener('click', function () { switchTab('kb'); });
    el.tabHistory.addEventListener('click', function () { switchTab('history'); });

    /* 上传 */
    el.dropZone.addEventListener('click', function () { el.fileInput.click(); });
    el.fileInput.addEventListener('change', function (e) {
      handleFiles(e.target.files);
      e.target.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      el.dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        el.dropZone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      el.dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (ev === 'dragleave' && el.dropZone.contains(e.relatedTarget)) return;
        el.dropZone.classList.remove('dragover');
      });
    });
    el.dropZone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });

    /* 全屏拖拽 */
    var dragDepth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') === -1) return;
      dragDepth += 1;
      el.dropOverlay.classList.add('active');
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) el.dropOverlay.classList.remove('active');
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      el.dropOverlay.classList.remove('active');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });

    /* 示例 / 清空知识库 */
    el.btnSamples.addEventListener('click', loadSamples);
    el.btnClearKb.addEventListener('click', function () {
      var st = window.KBStore.stats();
      if (!st.docCount) { toast('知识库已经是空的', 'info'); return; }
      confirmDialog('清空知识库', '将删除全部 ' + st.docCount + ' 份文档及 ' + st.chunkCount + ' 个切片，此操作不可恢复。', '清空')
        .then(function (ok) {
          if (!ok) return;
          window.KBStore.clearDocuments();
          rebuildIndex();
          renderDocs();
          toast('知识库已清空', 'success');
        });
    });

    /* 输入框 */
    el.input.addEventListener('input', function () {
      autoResize();
      updateSendButton();
    });
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (el.input.value.trim() && !state.busy) send(el.input.value);
      }
    });
    el.btnSend.addEventListener('click', function () { send(el.input.value); });

    /* 建议问题 */
    document.querySelectorAll('[data-suggest]').forEach(function (node) {
      node.addEventListener('click', function () {
        var q = node.getAttribute('data-suggest');
        if (state.busy) return;
        if (!window.KBStore.stats().chunkCount) {
          toast('请先上传文档或点击左侧「载入示例文档」', 'error');
          return;
        }
        send(q);
      });
    });

    /* 工具栏 */
    el.btnClearChat.addEventListener('click', function () {
      if (!el.messageList.children.length) { toast('当前对话为空', 'info'); return; }
      confirmDialog('清空对话', '将清空当前对话窗口的所有消息（历史问答记录仍会保留）。', '清空')
        .then(function (ok) {
          if (!ok) return;
          el.messageList.innerHTML = '';
          showEmptyState();
          toast('对话已清空', 'success');
        });
    });

    el.btnExport.addEventListener('click', exportConversation);
    el.btnSettings.addEventListener('click', openSettings);

    /* 历史 */
    el.btnClearHistory.addEventListener('click', function () {
      if (!window.KBStore.stats().historyCount) { toast('暂无历史记录', 'info'); return; }
      confirmDialog('清空历史', '将删除全部问答历史记录，此操作不可恢复。', '清空').then(function (ok) {
        if (!ok) return;
        window.KBStore.clearHistory();
        renderHistory();
        toast('历史记录已清空', 'success');
      });
    });

    /* 设置弹窗 */
    $('setUseRemote').addEventListener('click', function () {
      $('setUseRemote').classList.toggle('on');
    });
    $('btnSaveSettings').addEventListener('click', saveSettings);
    $('btnCancelSettings').addEventListener('click', function () {
      el.settingsModal.classList.remove('active');
    });
    el.settingsModal.addEventListener('click', function (e) {
      if (e.target === el.settingsModal) el.settingsModal.classList.remove('active');
    });

    /* 确认弹窗点击遮罩关闭 */
    el.confirmModal.addEventListener('click', function (e) {
      if (e.target === el.confirmModal) {
        el.confirmModal.classList.remove('active');
      }
    });

    /* Esc 关闭弹窗 */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        el.settingsModal.classList.remove('active');
        el.confirmModal.classList.remove('active');
      }
    });
  }

  function switchTab(tab) {
    state.activeTab = tab;
    var isKb = tab === 'kb';
    el.tabKb.classList.toggle('active', isKb);
    el.tabHistory.classList.toggle('active', !isKb);
    el.panelKb.style.display = isKb ? 'flex' : 'none';
    el.panelHistory.style.display = isKb ? 'none' : 'flex';
  }

  /* ------------------------------------------------------------ 启动 --- */
  function boot() {
    el = {
      docList: $('docList'),
      fileInput: $('fileInput'),
      dropZone: $('dropZone'),
      dropOverlay: $('dropOverlay'),
      btnSamples: $('btnSamples'),
      btnClearKb: $('btnClearKb'),
      tabKb: $('tabKb'),
      tabHistory: $('tabHistory'),
      panelKb: $('panelKb'),
      panelHistory: $('panelHistory'),
      historyList: $('historyList'),
      btnClearHistory: $('btnClearHistory'),
      chatScroll: $('chatScroll'),
      messageList: $('messageList'),
      emptyState: $('emptyState'),
      input: $('input'),
      btnSend: $('btnSend'),
      btnClearChat: $('btnClearChat'),
      btnExport: $('btnExport'),
      btnSettings: $('btnSettings'),
      settingsModal: $('settingsModal'),
      confirmModal: $('confirmModal'),
      toastStack: $('toastStack')
    };

    window.KBStore.load();
    rebuildIndex();
    renderDocs();
    renderHistory();
    bindEvents();
    updateSendButton();
    autoResize();

    // 首屏问候
    console.log(
      '%c 企业智能知识库问答平台 %c RAG Demo Ready ',
      'background:#1a4fb5;color:#fff;padding:3px 8px;border-radius:4px 0 0 4px;font-weight:600',
      'background:#dbeafe;color:#12457f;padding:3px 8px;border-radius:0 4px 4px 0'
    );
    console.log('索引维度：' + window.KBEmbed.DIM + '｜切片数：' + window.KBRag.stats().chunkCount +
      '｜构建耗时：' + window.KBRag.stats().buildMs + 'ms');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

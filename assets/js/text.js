/* ============================================================================
 * text.js — 文本处理层
 * 负责：文本清洗 → 句子切分 → 语义切片(Chunking) → 分词(Tokenize)
 * 中文采用「字符二元组(bigram)」分词，无需词典，对政企制度类文本效果好。
 * ==========================================================================*/
window.KBText = (function () {
  'use strict';

  /* 中文停用词 / 高频虚词：单字与二元组，检索时弱化 */
  var CN_STOP = new Set([
    '的', '了', '是', '在', '和', '与', '及', '或', '有', '就', '不', '也', '都', '而', '被', '把',
    '对', '从', '到', '为', '以', '于', '其', '之', '则', '等', '这', '那', '该', '此', '各',
    '我们', '你们', '他们', '自己', '可以', '一个', '这个', '那个', '什么', '怎么', '如何',
    '以及', '并且', '但是', '因为', '所以', '如果', '对于', '关于', '进行', '通过', '根据',
    '的是', '了的', '是在', '和的', '及其', '应当', '应该', '需要', '必须'
  ]);

  /* 英文停用词 */
  var EN_STOP = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'to', 'in', 'on',
    'at', 'for', 'with', 'by', 'from', 'as', 'and', 'or', 'but', 'if', 'then', 'that', 'this',
    'these', 'those', 'it', 'its', 'we', 'you', 'they', 'he', 'she', 'i', 'do', 'does', 'did',
    'not', 'no', 'can', 'will', 'would', 'should', 'could', 'have', 'has', 'had', 'what', 'how'
  ]);

  /* 疑问 / 口语化词缀，用于关键词提取时剔除 */
  var QUERY_NOISE = [
    '是多少', '是什么', '什么是', '有哪些', '有什么', '包括哪些', '包含哪些', '怎么样', '怎么办',
    '怎么', '如何', '哪些', '什么', '多少', '请问', '麻烦', '一下', '介绍', '说明', '告诉我',
    '我想知道', '想问', '公司', '我们', '具体', '相关', '规定', '吗', '呢', '啊', '呀', '的', '了'
  ];

  /** 文本清洗：统一换行、去除多余空白与控制字符 */
  function normalize(raw) {
    if (!raw) return '';
    var t = String(raw);
    t = t.replace(/\r\n?/g, '\n');
    t = t.replace(/\u00a0|\u3000/g, ' ');
    t = t.replace(/[\t\f\v]+/g, ' ');
    t = t.replace(/[ ]{2,}/g, ' ');
    t = t.replace(/\n[ ]+/g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    // 去除常见 PDF 页眉页脚残留（第 x 页 / 共 x 页）
    t = t.replace(/^\s*第\s*\d+\s*页\s*(共\s*\d+\s*页)?\s*$/gm, '');
    return t.trim();
  }

  /**
   * 句子切分：保留标点，兼顾中英文
   * @returns {string[]}
   */
  function splitSentences(text) {
    if (!text) return [];
    var src = String(text).replace(/\n+/g, '\n');
    var parts = src.split(/(?<=[。！？!?；;])|\n/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i] ? parts[i].trim() : '';
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * 语义切片：按段落聚合到目标长度，相邻切片保留重叠，保证上下文连续
   * @param {string} text 原文
   * @param {{size?:number, overlap?:number}} opts
   * @returns {{text:string,index:number}[]}
   */
  function chunkText(text, opts) {
    var size = (opts && opts.size) || 380;
    var overlap = (opts && opts.overlap) || 70;
    var clean = normalize(text);
    if (!clean) return [];

    // 1) 先切成"语义块"：优先按空行分段
    var paras = clean.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    var blocks = [];

    paras.forEach(function (p) {
      if (p.length <= size * 1.3) {
        blocks.push(p);
        return;
      }
      // 超长段落按句子重组
      var sents = splitSentences(p);
      var buf = '';
      sents.forEach(function (s) {
        if (buf && (buf.length + s.length) > size * 1.3) {
          blocks.push(buf.trim());
          buf = '';
        }
        buf += s;
      });
      if (buf.trim()) blocks.push(buf.trim());
    });

    // 2) 合并语义块为切片
    var chunks = [];
    var cur = '';
    blocks.forEach(function (b) {
      if (!cur) { cur = b; return; }
      if ((cur.length + b.length + 1) <= size) {
        cur += '\n' + b;
        return;
      }
      chunks.push(cur);
      // 重叠窗口对齐到句子起点，避免切片从半句开始（残句会严重拉低检索质量）
      var tail = cur.slice(Math.max(0, cur.length - overlap));
      var cut = -1;
      for (var i = 0; i < tail.length; i++) {
        if ('。！？；\n'.indexOf(tail.charAt(i)) !== -1) { cut = i; break; }
      }
      if (cut !== -1) tail = tail.slice(cut + 1);
      if (tail.replace(/\s/g, '').length < 12) tail = '';
      cur = tail ? (tail + '\n' + b) : b;
      if (cur.length > size * 1.6) cur = b;
    });
    if (cur.trim()) chunks.push(cur);

    return chunks
      .map(function (c) { return c.trim(); })
      .filter(function (c) { return c.replace(/\s/g, '').length >= 12; })
      .map(function (c, i) { return { text: c, index: i }; });
  }

  /**
   * 分词：中文 bigram + 英文/数字词，输出 token 数组（保留重复，用于 TF 统计）
   * @returns {string[]}
   */
  function tokenize(text) {
    if (!text) return [];
    var s = String(text).toLowerCase();
    var tokens = [];

    // 英文 / 数字
    var latin = s.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) || [];
    for (var i = 0; i < latin.length; i++) {
      var w = latin[i];
      if (w.length > 1) {
        if (!EN_STOP.has(w)) tokens.push(w);
      } else if (/\d/.test(w)) {
        tokens.push(w);
      }
    }

    // 中文：连续汉字串 → 二元组
    var segs = s.match(/[\u4e00-\u9fff]+/g) || [];
    for (var j = 0; j < segs.length; j++) {
      var seg = segs[j];
      if (seg.length === 1) {
        if (!CN_STOP.has(seg)) tokens.push(seg);
        continue;
      }
      for (var k = 0; k < seg.length - 1; k++) {
        var bg = seg.substr(k, 2);
        if (CN_STOP.has(bg)) continue;
        tokens.push(bg);
      }
    }
    return tokens;
  }

  /**
   * 提取用于高亮的关键词（按长度降序，便于最长匹配）
   * @returns {string[]}
   */
  function keywords(query) {
    var s = String(query || '');
    var noiseRe = new RegExp(QUERY_NOISE.map(function (w) {
      return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('|'), 'g');

    var out = [];
    var seen = {};

    function push(w) {
      var v = String(w || '').trim();
      if (v.length < 2) return;
      if (seen[v]) return;
      seen[v] = 1;
      out.push(v);
    }

    // 中文片段
    var cnSegs = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
    cnSegs.forEach(function (seg) {
      var cleaned = seg.replace(noiseRe, '');
      if (cleaned.length >= 2) push(cleaned);
      if (seg.length >= 2 && seg.length <= 8) push(seg);
    });

    // 英文 / 数字
    var enSegs = s.match(/[a-zA-Z0-9][a-zA-Z0-9._-]{1,}/g) || [];
    enSegs.forEach(function (w) { if (!EN_STOP.has(w.toLowerCase())) push(w); });

    return out.sort(function (a, b) { return b.length - a.length; });
  }

  /** 句子与查询词的覆盖率（用于抽取式答案选句） */
  function coverage(sentence, tokenSet) {
    var toks = tokenize(sentence);
    if (!toks.length) return 0;
    var hit = 0;
    var counted = {};
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (counted[t]) continue;
      counted[t] = 1;
      if (tokenSet.has(t)) hit += 1;
    }
    var uniq = Object.keys(counted).length || 1;
    return hit / uniq;
  }

  /** 统计中文字符数（用于展示） */
  function charCount(text) {
    return String(text || '').replace(/\s/g, '').length;
  }

  return {
    normalize: normalize,
    splitSentences: splitSentences,
    chunkText: chunkText,
    tokenize: tokenize,
    keywords: keywords,
    coverage: coverage,
    charCount: charCount
  };
})();

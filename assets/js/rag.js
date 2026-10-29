/* ============================================================================
 * rag.js — RAG 主流程编排
 *
 * 标准 RAG 流程：
 *   Query → [1] 向量化 → [2] 向量检索(Top-K) → [3] 上下文拼装 → [4] 生成答案 → [5] 引用溯源
 *
 * 生成环节说明：
 *   - 默认使用「本地抽取式生成器」：从检索到的片段中挑选与问题最相关的句子，
 *     按制度原文组织成结构化答案，并为每句标注 [n] 引用。优点是完全离线、绝不编造。
 *   - 可选接入任意 OpenAI 兼容大模型（设置面板填写 Base URL / Key），
 *     接入后走标准 Prompt 工程，失败时自动降级回本地生成器，保证演示不中断。
 * ==========================================================================*/
window.KBRag = (function () {
  'use strict';

  var index = null;
  var lastBuildMs = 0;
  var K1 = 1.2;   // BM25 词频饱和参数
  var B = 0.75;   // BM25 长度归一化参数

  var FALLBACK = [
    '抱歉，我在当前知识库中没有检索到与该问题直接相关的内容。',
    '',
    '**建议您：**',
    '- 确认相关制度文件是否已上传至知识库（支持 PDF / Word / TXT）',
    '- 尝试使用更具体的业务关键词重新提问，例如「差旅住宿标准」「密码策略」',
    '- 若知识库为空，可点击左侧「载入示例文档」快速体验完整 RAG 流程'
  ].join('\n');

  /* ------------------------------------------------------------ 索引 --- */
  function rebuild(chunks) {
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    index = new window.KBEmbed.VectorIndex(chunks || []);
    var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
    lastBuildMs = Math.max(1, Math.round(t1 - t0));
    return index;
  }

  function getIndex() { return index; }

  function retrieve(query, opts) {
    if (!index) return [];
    return index.search(query, opts || { topK: 4 });
  }

  /** 过滤明显弱相关的片段，避免噪声片段污染答案与引用列表 */
  function pruneHits(hits) {
    if (!hits || !hits.length) return hits || [];
    var top1 = hits[0].score;
    var strong = hits.filter(function (h) {
      if (h.score < top1 * 0.55) return false;
      // 优先采信主文档：跨文档片段需要更高相关度才纳入
      if (h.chunk.docName !== hits[0].chunk.docName && h.score < top1 * 0.8) return false;
      return true;
    });
    if (strong.length < 2 && hits.length > 1) strong = hits.slice(0, 2);
    return strong;
  }

  /* -------------------------------------------------- 本地答案生成器 --- */
  var STEP_WORDS = ['流程', '步骤', '怎么办', '如何办理', '怎么走', '先后', '顺序', '手续', '如何申请', '怎么申请'];

  function isStepQuestion(q) {
    for (var i = 0; i < STEP_WORDS.length; i++) if (q.indexOf(STEP_WORDS[i]) !== -1) return true;
    return false;
  }

  /** 识别问题焦点，用于给"信息型句子"加权 */
  function detectFocus(q) {
    var f = {};
    if (/多少|几|多长时间|多久|几天|标准|金额|比例|期限|时限|上限|额度|日期/.test(q)) f.number = 1;
    if (/可以吗|能否|是否|能不能|允许|需不需要|要不要/.test(q)) f.yesno = 1;
    if (/哪些|有什么|包括|清单|材料|内容|要求|条件/.test(q)) f.list = 1;
    if (/流程|步骤|怎么|如何|手续|办理/.test(q)) f.step = 1;
    return f;
  }

  function focusBoost(text, f) {
    var b = 1;
    if (f.number) {
      if (!/\d/.test(text)) {
        b *= 0.82; // 问数量/时限却无任何数字，多半不是答案句
      } else {
        var units = text.match(/\d+\s*(个月|月|天|年|小时|学时|分钟|工作日|元|%|位|次)/g);
        b *= 1.15 + Math.min(0.45, (units ? units.length : 0) * 0.12);
        // 定义式取值句：「试用期为 6 个月」是制度问答最典型的答案形态
        if (/[^\s，。；、]{2,8}(为|是)\s*[\d一二三四五六七八九十]/.test(text)) b *= 1.25;
      }
    }
    if (f.yesno && /可以|不得|须|应|禁止|允许|不予/.test(text)) b *= 1.22;
    if (f.list) {
      if (/：/.test(text)) b *= 1.3;        // 「xxx：清单…」通常就是答案本体
      else if (/、/.test(text)) b *= 1.12;
    }
    if (f.step && /先|然后|再|提交|审批|申请|办理|审核|完成|手续/.test(text)) b *= 1.2;
    return b;
  }

  /**
   * 句子相关度：IDF 加权 BM25 + 轻微长度奖励
   * 相比纯词覆盖率，IDF 能让"试用期""密码"这类低频关键信息占主导。
   */
  function sentenceScore(sentence, qTf, idfFn, avgdl) {
    var toks = window.KBText.tokenize(sentence);
    if (!toks.length) return 0;

    var tf = Object.create(null);
    for (var i = 0; i < toks.length; i++) tf[toks[i]] = (tf[toks[i]] || 0) + 1;

    var dl = toks.length;
    var SB = 0.35; // 句子层面的长度归一化要弱于整篇文档，否则短句无脑胜出
    var s = 0;
    var keys = Object.keys(qTf);
    for (var k = 0; k < keys.length; k++) {
      var t = keys[k];
      var f = tf[t];
      if (!f) continue;
      s += idfFn(t) * (f * (K1 + 1)) / (f + K1 * (1 - SB + SB * dl / (avgdl || 40)));
    }
    // 信息完整的句子略占优
    return s * (0.9 + 0.1 * Math.min(1, dl / 35));
  }

  /** 字符二元组相似度，用于句子级去重 */
  function bigramSim(a, b) {
    var A = a.replace(/\s/g, '');
    var B = b.replace(/\s/g, '');
    if (!A || !B) return 0;
    var setA = Object.create(null);
    for (var i = 0; i < A.length - 1; i++) setA[A.substr(i, 2)] = 1;
    var inter = 0;
    var totalB = 0;
    var seenB = Object.create(null);
    for (var j = 0; j < B.length - 1; j++) {
      var g = B.substr(j, 2);
      if (seenB[g]) continue;
      seenB[g] = 1;
      totalB += 1;
      if (setA[g]) inter += 1;
    }
    var totalA = Object.keys(setA).length;
    var union = totalA + totalB - inter;
    return union > 0 ? inter / union : 0;
  }

  /**
   * 列表项合并：制度文本中「（一）…；（二）…；（三）…。」常被分号切开，
   * 单独抽一条会丢失关键信息，这里向后合并同一条款下的并列项。
   */
  function mergeListItems(text, sents, startIndex) {
    if (!/；$/.test(text)) return text;
    var merged = text;
    var j = startIndex + 1;
    var extra = 0;
    while (j < sents.length && extra < 3) {
      if (!/；$/.test(merged)) break; // 上一句以分号结尾才继续，保证是同一条款的并列项
      var nxt = sents[j].replace(/\s+/g, ' ').trim();
      j += 1;
      if (!nxt) continue;
      if (/^第[一二三四五六七八九十百]+[条章节]/.test(nxt)) break;
      merged += nxt;
      extra += 1;
    }
    return merged;
  }

  /**
   * 句子聚合：制度文本常用「；」分隔并列项，逐句打分会让一条完整条款被拆散。
   * 这里先把以分号结尾的短句合并回一条，保证语义完整后再参与排序。
   */
  function groupSentences(sents) {
    var out = [];
    var buf = '';
    for (var i = 0; i < sents.length; i++) {
      var s = sents[i].replace(/\s+/g, ' ').trim();
      if (!s) continue;
      buf += s;
      if (/；$/.test(buf) && window.KBText.charCount(buf) < 60) continue;
      out.push(buf);
      buf = '';
    }
    if (buf) out.push(buf);
    return out;
  }

  /** 从检索结果中抽取最相关的句子 */
  function extractSentences(query, hits) {
    var qTf = Object.create(null);
    window.KBText.tokenize(query).forEach(function (t) { qTf[t] = (qTf[t] || 0) + 1; });

    var idx = index;
    var idfFn = idx ? function (t) { return idx.idf(t); } : function () { return 1; };
    var avgdl = idx ? idx.avgdl : 40;
    var focus = detectFocus(query);

    var picked = [];

    hits.forEach(function (hit, hi) {
      var sents = groupSentences(window.KBText.splitSentences(hit.chunk.text));
      var cands = [];

      sents.forEach(function (s, si) {
        var txt = s.replace(/\s+/g, ' ').trim();
        if (window.KBText.charCount(txt) < 10) return;
        // 过滤文档标题 / 章节标题：无标点且较短，不承载答案信息
        if (!/[。！？；，、：]/.test(txt) && window.KBText.charCount(txt) < 40) return;
        cands.push({
          text: txt,
          score: sentenceScore(txt, qTf, idfFn, avgdl) * focusBoost(txt, focus),
          cite: hi + 1,
          doc: hit.chunk.docName,
          page: hit.chunk.page,
          chunkIndex: hit.chunk.index,
          sentIndex: si,
          hitScore: hit.score
        });
      });

      cands.sort(function (a, b) { return b.score - a.score; });

      // 高相关片段最多贡献 2 句，边缘片段只贡献 1 句，控制噪声
      var maxTake = hit.score >= (hits[0].score * 0.7) ? 2 : 1;
      var taken = 0;
      for (var i = 0; i < cands.length && taken < maxTake; i++) {
        var c = cands[i];
        if (c.score <= 0) continue;
        var merged = mergeListItems(c.text, sents, c.sentIndex);

        var dup = picked.some(function (p) {
          // 已被更完整的句子覆盖（合并列表项后常出现）
          if (p.text.indexOf(c.text) !== -1) return true;
          return bigramSim(p.text, merged) > 0.5;
        });
        if (dup) continue;

        c.text = merged;
        picked.push(c);
        taken += 1;
      }
    });

    if (!picked.length) return [];

    // 丢弃明显弱于最优句的噪声句
    var maxScore = picked.reduce(function (m, p) { return Math.max(m, p.score); }, 0);
    return picked.filter(function (p) { return p.score >= maxScore * 0.32; });
  }

  function cleanDocName(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }

  /**
   * 本地抽取式生成
   * @returns {{text:string, usedCitations:number[]}}
   */
  function buildAnswer(query, hits) {
    if (!hits || !hits.length) {
      return { text: FALLBACK, usedCitations: [], fallback: true };
    }

    var picked = extractSentences(query, hits);
    if (!picked.length) {
      return { text: FALLBACK, usedCitations: [], fallback: true };
    }

    // 统一按相关度排序：制度类问答中"最相关"通常就是"最该先说"的
    picked.sort(function (a, b) { return b.score - a.score; });

    // 只保留与最优句同一量级的句子，避免把边缘片段塞进答案
    var top = picked.filter(function (p) {
      return p.score >= picked[0].score * 0.45;
    }).slice(0, 4);
    if (!top.length) top = picked.slice(0, 2);

    // 判断答案来源是否集中于单一文档
    var docSet = {};
    hits.slice(0, 3).forEach(function (h) { docSet[h.chunk.docName] = 1; });
    var docNames = Object.keys(docSet);
    var lead = docNames.length === 1
      ? '根据知识库中《' + cleanDocName(docNames[0]) + '》的相关记载，'
      : '根据知识库中检索到的相关资料，';

    var lines = [];
    var used = [];

    var first = top[0];
    lines.push(lead + first.text + ' [' + first.cite + ']');
    used.push(first.cite);

    if (top.length > 1) {
      var isList = top.length >= 2;
      lines.push('');
      if (isStepQuestion(query)) {
        lines.push('**具体办理流程如下：**');
      } else if (isList) {
        lines.push('**关键信息如下：**');
      }
      for (var i = 1; i < top.length; i++) {
        var p = top[i];
        lines.push('- ' + p.text + ' [' + p.cite + ']');
        if (used.indexOf(p.cite) === -1) used.push(p.cite);
      }
    }

    // 检索质量偏弱时给出提示，避免"一本正经地胡说"
    if (hits[0].score < 0.22) {
      lines.push('');
      lines.push('> 说明：该问题的匹配度较低，以上内容仅供参考，建议核对引用原文或补充相关制度文档。');
    }

    return { text: lines.join('\n'), usedCitations: used, fallback: false };
  }

  /* --------------------------------------------------- 远程大模型(可选) --- */
  function buildContext(hits) {
    return hits.map(function (h, i) {
      var src = h.chunk.docName + (h.chunk.page ? '（第 ' + h.chunk.page + ' 页）' : '');
      return '【片段 ' + (i + 1) + '｜来源：' + src + '】\n' + h.chunk.text;
    }).join('\n\n');
  }

  function callRemote(query, hits, settings) {
    var sys = [
      '你是政企内部知识库的问答助手，服务对象是本单位员工。',
      '请严格依据下面提供的「资料片段」回答问题，禁止使用资料之外的知识，禁止编造。',
      '要求：',
      '1. 语言简洁专业，使用中文；',
      '2. 每个结论句末尾用 [编号] 标注来源片段，例如 [1]、[2]；',
      '3. 若资料不足以回答，直接说明"知识库中未找到相关规定"，不要猜测；',
      '4. 涉及标准、时限、金额等数字时，必须与资料完全一致。'
    ].join('\n');

    var userMsg = '资料片段：\n' + buildContext(hits) + '\n\n用户问题：' + query;

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 60000);

    var url = String(settings.apiBase || '').replace(/\/+$/, '') + '/chat/completions';

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + settings.apiKey
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model || 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg }
        ]
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('模型接口返回 ' + res.status);
      return res.json();
    }).then(function (json) {
      var content = json && json.choices && json.choices[0] &&
        json.choices[0].message && json.choices[0].message.content;
      if (!content) throw new Error('模型返回内容为空');
      return String(content).trim();
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  /* ------------------------------------------------------------- 主流程 --- */
  /**
   * @param {string} query
   * @param {{settings?:Object, topK?:number, onStage?:(s:string)=>void}} opts
   */
  function ask(query, opts) {
    opts = opts || {};
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();

    if (opts.onStage) opts.onStage('retrieving');
    var hits = pruneHits(retrieve(query, { topK: opts.topK || 4 }));
    var tRetrieve = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;

    if (opts.onStage) opts.onStage('generating');

    var settings = opts.settings || {};
    var canRemote = !!(settings.useRemote && settings.apiBase && settings.apiKey);

    var generate;
    if (canRemote && hits.length) {
      generate = callRemote(query, hits, settings).then(function (text) {
        return { text: text, engine: 'remote' };
      }).catch(function (err) {
        console.warn('[KBRag] 远程模型调用失败，已降级为本地生成：', err.message);
        var local = buildAnswer(query, hits);
        return { text: local.text, engine: 'local-fallback', warning: err.message };
      });
    } else {
      generate = new Promise(function (resolve) {
        // 轻微延迟，模拟大模型推理过程，让 UI 的"思考中"动画有感知
        setTimeout(function () {
          var local = buildAnswer(query, hits);
          resolve({ text: local.text, engine: 'local' });
        }, 320);
      });
    }

    return generate.then(function (res) {
      var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
      return {
        text: res.text,
        engine: res.engine,
        warning: res.warning || null,
        hits: hits,
        retrieveMs: Math.max(1, Math.round(tRetrieve)),
        totalMs: Math.max(1, Math.round(t1 - t0))
      };
    });
  }

  return {
    rebuild: rebuild,
    getIndex: getIndex,
    retrieve: retrieve,
    ask: ask,
    buildAnswer: buildAnswer,
    // 供调试 / 单元测试使用
    _extract: extractSentences,
    _prune: pruneHits,
    FALLBACK: FALLBACK,
    stats: function () {
      return {
        built: !!index,
        chunkCount: index ? index.N : 0,
        dim: window.KBEmbed.DIM,
        buildMs: lastBuildMs
      };
    }
  };
})();

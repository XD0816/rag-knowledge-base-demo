/* ============================================================================
 * embedding.js — 轻量向量化与检索引擎
 *
 * 说明（面试可讲）：
 *   真实 RAG 使用 BGE / text-embedding 等模型产出稠密向量；本 Demo 为了
 *   "零后端、可双击运行"，采用 **特征哈希(TF-IDF + Hashing Trick)** 方案：
 *     1. 中文 bigram 分词（无需词典，适合制度类长文本）
 *     2. TF-IDF 加权，映射到固定 1024 维空间（FNV-1a 哈希 + 符号位）
 *     3. L2 归一化后，余弦相似度 == 向量点积
 *   这与向量库（如 Milvus / FAISS）的接口形态一致：embed() → cosine search()，
 *   后续替换为真实 Embedding 模型时，只需改写 embedTokens 即可。
 *   另外叠加 BM25 关键词得分做**混合检索(Hybrid Search)**，兼顾语义与精确匹配。
 * ==========================================================================*/
window.KBEmbed = (function () {
  'use strict';

  var DIM = 1024;          // 向量维度
  var K1 = 1.2;            // BM25 参数
  var B = 0.75;            // BM25 长度归一化参数
  var W_VEC = 0.68;        // 向量相似度权重
  var W_BM25 = 0.32;       // 关键词得分权重
  var MIN_SCORE = 0.08;    // 相关性阈值，低于此值视为不相关

  /**
   * @constructor
   * @param {{id:string,text:string,docId:string,docName:string,page?:number}[]} chunks
   */
  function VectorIndex(chunks) {
    this.chunks = chunks || [];
    this.dim = DIM;
    this.vectors = [];
    this.tokenLists = [];
    this.tfMaps = [];
    this.df = Object.create(null);
    this.N = 0;
    this.avgdl = 1;
    this.buildMs = 0;
    this.build();
  }

  /** 构建索引：统计 DF → 计算 IDF → 生成向量 */
  VectorIndex.prototype.build = function () {
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var self = this;
    var df = Object.create(null);
    var totalLen = 0;

    this.tokenLists = [];
    this.tfMaps = [];

    for (var i = 0; i < this.chunks.length; i++) {
      var tokens = window.KBText.tokenize(this.chunks[i].text);
      this.tokenLists.push(tokens);
      totalLen += tokens.length;

      var tf = Object.create(null);
      var seen = Object.create(null);
      for (var j = 0; j < tokens.length; j++) {
        var t = tokens[j];
        tf[t] = (tf[t] || 0) + 1;
        if (!seen[t]) { seen[t] = 1; df[t] = (df[t] || 0) + 1; }
      }
      this.tfMaps.push(tf);
    }

    this.df = df;
    this.N = this.chunks.length;
    this.avgdl = this.N ? (totalLen / this.N) : 1;

    this.vectors = this.tfMaps.map(function (tf) { return self._embedTF(tf); });

    var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
    this.buildMs = Math.max(1, Math.round(t1 - t0));
    return this;
  };

  /** IDF：平滑处理，避免除零 */
  VectorIndex.prototype.idf = function (token) {
    var n = this.df[token] || 0;
    return Math.log((this.N + 1) / (n + 0.5)) + 1;
  };

  /**
   * 由词频表生成归一化向量（特征哈希）
   * @param {Object} tf token -> 词频
   * @returns {Float32Array}
   */
  VectorIndex.prototype._embedTF = function (tf) {
    var v = new Float32Array(DIM);
    var self = this;
    Object.keys(tf).forEach(function (token) {
      var cnt = tf[token];
      var w = (1 + Math.log(cnt)) * self.idf(token);
      var h = window.KBUtil.hash32(token);
      var sign = (window.KBUtil.hash32(token + '#s') & 1) ? 1 : -1;
      v[h % DIM] += sign * w;
    });
    // L2 归一化
    var norm = 0;
    for (var i = 0; i < DIM; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm > 1e-8) {
      for (var k = 0; k < DIM; k++) v[k] /= norm;
    }
    return v;
  };

  /** 文本 → 向量（对外接口，等价于真实场景的 embedding API） */
  VectorIndex.prototype.embed = function (text) {
    var tokens = window.KBText.tokenize(text);
    var tf = Object.create(null);
    for (var i = 0; i < tokens.length; i++) tf[tokens[i]] = (tf[tokens[i]] || 0) + 1;
    return this._embedTF(tf);
  };

  /** 余弦相似度（向量已归一化，点积即余弦） */
  function cosine(a, b) {
    var s = 0;
    for (var i = 0; i < DIM; i++) s += a[i] * b[i];
    return s;
  }

  /** BM25 关键词得分 */
  VectorIndex.prototype._bm25 = function (qTokens, idx) {
    var tf = this.tfMaps[idx];
    var dl = this.tokenLists[idx].length || 1;
    var score = 0;
    var seen = Object.create(null);
    for (var i = 0; i < qTokens.length; i++) {
      var t = qTokens[i];
      if (seen[t]) continue;
      seen[t] = 1;
      var f = tf[t] || 0;
      if (!f) continue;
      var idf = this.idf(t);
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / this.avgdl));
    }
    return score;
  };

  /**
   * 检索
   * @param {string} query
   * @param {{topK?:number, minScore?:number}} opts
   * @returns {{chunk:Object, score:number, cosine:number, bm25:number, rank:number}[]}
   */
  VectorIndex.prototype.search = function (query, opts) {
    var topK = (opts && opts.topK) || 4;
    var minScore = (opts && opts.minScore !== undefined) ? opts.minScore : MIN_SCORE;
    if (!this.N) return [];

    var qTokens = window.KBText.tokenize(query);
    if (!qTokens.length) return [];
    var qVec = this._embedTF((function () {
      var tf = Object.create(null);
      for (var i = 0; i < qTokens.length; i++) tf[qTokens[i]] = (tf[qTokens[i]] || 0) + 1;
      return tf;
    })());

    var keys = window.KBText.keywords(query);
    var results = [];

    for (var i = 0; i < this.N; i++) {
      var cos = cosine(qVec, this.vectors[i]);
      var bm25 = this._bm25(qTokens, i);
      var bm25Norm = bm25 / (bm25 + 4);

      // 精确短语加成：关键词原样出现在片段中
      var bonus = 0;
      if (keys.length) {
        var text = this.chunks[i].text;
        for (var k = 0; k < keys.length; k++) {
          if (keys[k].length >= 2 && text.indexOf(keys[k]) !== -1) {
            bonus = Math.min(0.06, 0.02 * keys[k].length / 2);
            break;
          }
        }
      }

      var score = W_VEC * cos + W_BM25 * bm25Norm + bonus;
      if (score >= minScore) {
        results.push({
          chunk: this.chunks[i],
          score: score,
          cosine: cos,
          bm25: bm25,
          index: i
        });
      }
    }

    results.sort(function (a, b) { return b.score - a.score; });
    var top = results.slice(0, topK);
    top.forEach(function (r, idx) { r.rank = idx + 1; });
    return top;
  };

  /** 索引规模（字节，粗略估算） */
  VectorIndex.prototype.memoryBytes = function () {
    return this.N * DIM * 4;
  };

  return {
    VectorIndex: VectorIndex,
    DIM: DIM,
    MIN_SCORE: MIN_SCORE
  };
})();

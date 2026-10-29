/* ============================================================================
 * parsers.js — 文档解析层
 * 支持：PDF（pdf.js）、Word .docx（mammoth）、TXT / MD（原生 File API）
 * 全部在浏览器本地完成，文件不会上传到任何服务器。
 * ==========================================================================*/
window.KBParser = (function () {
  'use strict';

  var MAX_SIZE = 20 * 1024 * 1024; // 20MB

  /* ---------------------------------------------------------------- PDF --- */
  function initPdf() {
    if (!window.pdfjsLib) {
      throw new Error('PDF 解析库未加载，请确认 assets/vendor/pdf.min.js 存在');
    }
    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      // 本地 worker；file:// 协议下若无法创建 Worker，pdf.js 会自动降级为主线程解析
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdf.worker.min.js';
    }
  }

  /** 把一页的 textContent 还原为带换行的纯文本 */
  function pageToText(textContent) {
    var items = textContent.items || [];
    var out = '';
    var lastY = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (typeof it.str !== 'string') continue;
      var y = (it.transform && it.transform.length >= 6) ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
        out += '\n';
      }
      out += it.str;
      if (it.hasEOL) out += '\n';
      if (y !== null) lastY = y;
    }
    return out;
  }

  function parsePDF(file, onProgress) {
    initPdf();
    return file.arrayBuffer().then(function (buf) {
      return window.pdfjsLib.getDocument({
        data: new Uint8Array(buf),
        isEvalSupported: false,
        useSystemFonts: true
      }).promise;
    }).then(function (pdf) {
      var pages = [];
      var chain = Promise.resolve();
      for (var p = 1; p <= pdf.numPages; p++) {
        (function (pageNo) {
          chain = chain.then(function () {
            return pdf.getPage(pageNo).then(function (page) {
              return page.getTextContent();
            }).then(function (tc) {
              var txt = pageToText(tc);
              if (txt.trim()) pages.push({ no: pageNo, text: txt });
              if (onProgress) onProgress(pageNo, pdf.numPages);
            });
          });
        })(p);
      }
      return chain.then(function () {
        return {
          pages: pages,
          pageCount: pdf.numPages,
          text: pages.map(function (x) { return x.text; }).join('\n\n')
        };
      });
    });
  }

  /* --------------------------------------------------------------- DOCX --- */
  function parseDocx(file) {
    if (!window.mammoth) {
      throw new Error('Word 解析库未加载，请确认 assets/vendor/mammoth.browser.min.js 存在');
    }
    return file.arrayBuffer().then(function (buf) {
      return window.mammoth.extractRawText({ arrayBuffer: buf }).then(function (result) {
        var text = result.value || '';
        return {
          pages: [{ no: 1, text: text }],
          pageCount: 1,
          text: text
        };
      });
    });
  }

  /* ---------------------------------------------------------- TXT / MD --- */
  function decodeSmart(buf) {
    // 优先 UTF-8，失败回退 GBK（政企内部文档常见编码）
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      try {
        return new TextDecoder('gbk').decode(buf);
      } catch (e2) {
        return new TextDecoder('utf-8').decode(buf);
      }
    }
  }

  function parseTxt(file) {
    return file.arrayBuffer().then(function (buf) {
      var text = decodeSmart(buf);
      return {
        pages: [{ no: 1, text: text }],
        pageCount: 1,
        text: text
      };
    });
  }

  /* ------------------------------------------------------------ 入口 --- */
  function extOf(name) {
    var m = /\.([a-zA-Z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function typeLabel(ext) {
    if (ext === 'pdf') return 'PDF';
    if (ext === 'docx') return 'DOCX';
    if (ext === 'doc') return 'DOC';
    if (ext === 'txt') return 'TXT';
    if (ext === 'md') return 'MD';
    return ext ? ext.toUpperCase() : 'FILE';
  }

  /**
   * 解析单个文件
   * @param {File} file
   * @param {(page:number,total:number)=>void} onProgress
   */
  function parseFile(file, onProgress) {
    var ext = extOf(file.name);
    if (file.size > MAX_SIZE) {
      return Promise.reject(new Error('文件超过 20MB 限制'));
    }
    if (ext === 'doc') {
      return Promise.reject(new Error('暂不支持旧版 .doc，请另存为 .docx 后上传'));
    }
    if (ext === 'pdf') return parsePDF(file, onProgress);
    if (ext === 'docx') return parseDocx(file);
    if (ext === 'txt' || ext === 'md' || ext === 'text') return parseTxt(file);
    return Promise.reject(new Error('不支持的文件类型：.' + ext));
  }

  return {
    parseFile: parseFile,
    typeLabel: typeLabel,
    extOf: extOf,
    MAX_SIZE: MAX_SIZE
  };
})();

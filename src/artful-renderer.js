/**
 * =============================================================================
 * ArtfulRenderer - Universal Markdown & Knowledge Rendering System
 * Shared Library for ArtfulTypePro & ArtfulType Companion (Electron/Tauri)
 * =============================================================================
 * Supports:
 *   - GFM Tables (pipe syntax, column alignment, nested inline formatting)
 *   - GFM Task Lists (- [ ] / - [x]) with interactive status
 *   - Admonitions / Callouts (> [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION])
 *   - Fenced Code Blocks with language pills, syntax highlighting, and copy button
 *   - CriticMarkup ({++add++}, {--del--}, {~~old~>new~~}, {==hi==}, {>>comment<<})
 *   - PKM Highlights (==highlight==), Transclusions (![[...]]), and WikiLinks ([[...]])
 *   - Pandoc Spans ([text]{.class #id}) and Citations ([@cite] / @cite)
 *   - Footnotes (^[inline footnote] and [^1] references with definition list)
 *   - Frontmatter blocks (YAML ---, TOML +++, JSON ;;;)
 *   - Headings (# to ######) with slug IDs
 *   - Inline formatting (bold, italic, strikethrough, inline code, links, images)
 *   - Strict HTML Sanitization per security standards
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ArtfulMarkdownRenderer = factory();
    // Alias for convenience
    root.ArtfulRenderer = root.ArtfulMarkdownRenderer;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Sanitization & Utilities ───────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function slugify(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function sanitizeHtml(html) {
    if (!html) return '';
    // Strip dangerous tags and attributes
    const blockedTags = /<\/?(?:script|iframe|object|embed|applet|form|style)[^>]*>/gi;
    let clean = html.replace(blockedTags, '');

    // Neutralize javascript: protocol
    clean = clean.replace(/(href|src)\s*=\s*["']?\s*javascript:[^"'>]*/gi, '$1="blocked:javascript"');

    // Neutralize inline event handlers
    clean = clean.replace(/\son[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

    return clean;
  }

  // ── Inline Markdown Formatter ──────────────────────────────────────────────

  function formatInline(text, options) {
    if (!text) return '';
    let out = text;
    const opts = options || {};
    const availableTargets = opts.availableTargets || new Map();

    // 1. Protect inline code `code`
    const inlineCodes = [];
    out = out.replace(/(`+)((?:(?!\1)[\s\S])+?)\1/g, function (m, ticks, code) {
      inlineCodes.push(code);
      return `\uFFF0${inlineCodes.length - 1}\uFFF0`;
    });

    // 2. CriticMarkup (MultiMarkdown)
    out = out
      .replace(/\{\+\+([\s\S]*?)\+\+\}/g, '<ins class="critic critic-add">$1</ins>')
      .replace(/\{--([\s\S]*?)--\}/g, '<del class="critic critic-del">$1</del>')
      .replace(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g, '<span class="critic critic-sub"><del class="critic-old">$1</del><ins class="critic-new">$2</ins></span>')
      .replace(/\{==([\s\S]*?)==\}/g, '<mark class="critic critic-highlight">$1</mark>')
      .replace(/\{>>([\s\S]*?)<<\}/g, function (m, comment) {
        const esc = escapeHtml(comment);
        return `<span class="critic critic-comment" data-comment-text="${esc}" title="Comment: ${esc}"><span class="critic-icon">💬</span> ${esc}</span>`;
      });

    // 3. PKM Highlighting: ==highlight==
    out = out.replace(/==([^=\n]+)==/g, '<mark class="pkm-highlight">$1</mark>');

    // 4. PKM Transclusions: ![[image.png]] or ![[image.png|300]] or ![[Note Name]]
    out = out.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (m, target, opt) {
      const clean = target.trim();
      const lower = clean.toLowerCase();
      if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') ||
          lower.endsWith('.gif') || lower.endsWith('.svg') || lower.endsWith('.webp')) {
        let style = '';
        if (opt && /^\d+$/.test(opt.trim())) {
          style = ` style="max-width:${opt.trim()}px;"`;
        }
        return `<img class="transclusion-image" src="${escapeAttr(clean)}" alt="${escapeAttr(clean)}"${style} />`;
      }
      return `<div class="transclusion-card" data-transclude="${escapeAttr(clean)}"><div class="transclusion-header"><span class="transclusion-badge">Transclusion</span><span class="transclusion-title">📄 ${escapeHtml(clean)}</span></div><div class="transclusion-content">Embedded note: <em>${escapeHtml(clean)}</em></div></div>`;
    });

    // 5. WikiLinks: [[Target|Alias]] or [[Target#Anchor|Alias]] or [[Target]]
    out = out.replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, function (m, rawTarget, anchor, alias) {
      const target = rawTarget.trim();
      const anchorClean = anchor ? anchor.trim() : null;
      const label = alias ? alias.trim() : (anchorClean ? `${target} > ${anchorClean}` : target);

      const targetNorm = target.toLowerCase();
      const isResolved = availableTargets.size === 0 || availableTargets.has(targetNorm);
      const statusClass = isResolved ? 'wikilink-resolved' : 'wikilink-stub';
      const tooltip = isResolved ? `Open note: ${target}` : `Create note: ${target}`;
      const anchorAttr = anchorClean ? ` data-anchor="${escapeAttr(anchorClean)}"` : '';

      return `<a class="wikilink ${statusClass}" href="#" data-target="${escapeAttr(target)}"${anchorAttr} title="${escapeAttr(tooltip)}"><span class="wikilink-icon">📄</span> <span class="wikilink-label">${escapeHtml(label)}</span></a>`;
    });

    // 6. Pandoc Bracketed Spans: [text]{.class #id}
    out = out.replace(/\[([^\]\n]+)\]\{([^{}\n]+)\}/g, function (m, spanText, attrs) {
      const classes = [];
      let idAttr = '';
      for (const part of attrs.trim().split(/\s+/)) {
        if (part.startsWith('.')) classes.push(part.slice(1));
        else if (part.startsWith('#')) idAttr = ` id="${escapeAttr(part.slice(1))}"`;
      }
      const clsAttr = classes.length ? ` ${classes.join(' ')}` : '';
      return `<span class="pandoc-span${clsAttr}"${idAttr}>${spanText}</span>`;
    });

    // 7. Citations: [@cite] and @cite
    out = out.replace(/\[(@[a-zA-Z0-9_:-]+(?:,\s*[^\]]+)?(?:;\s*@[a-zA-Z0-9_:-]+)*)\]/g, '<cite class="citation citation-pandoc" data-cite="$1">$1</cite>');
    out = out.replace(/(^|[^\w@])@([a-zA-Z0-9_:-]+)/g, '$1<cite class="citation citation-pandoc" data-cite="$2">@$2</cite>');

    // 8. Footnote References: [^label]
    out = out.replace(/\[\^([a-zA-Z0-9_-]+)\]/g, function (m, label) {
      return `<sup class="footnote-ref"><a href="#fn-${slugify(label)}" id="fnref-${slugify(label)}">${escapeHtml(label)}</a></sup>`;
    });

    // 9. Standard Images: ![alt](url)
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (m, alt, url) {
      return `<img src="${escapeAttr(url.trim())}" alt="${escapeAttr(alt)}" class="markdown-image" loading="lazy" />`;
    });

    // 10. Standard Links: [text](url)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, label, url) {
      const cleanUrl = url.trim();
      const isExternal = cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://');
      const targetAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${escapeAttr(cleanUrl)}"${targetAttr}>${label}</a>`;
    });

    // 11. Bold, Italic, Strikethrough
    out = out
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 12. Restore inline codes
    out = out.replace(/\uFFF0(\d+)\uFFF0/g, function (m, idx) {
      return `<code>${escapeHtml(inlineCodes[parseInt(idx, 10)])}</code>`;
    });

    return out;
  }

  // ── Block-Level Markdown Parser ────────────────────────────────────────────

  function parseTable(lines, startIndex, options) {
    const headerLine = lines[startIndex].trim();
    if (startIndex + 1 >= lines.length) return null;
    const delimiterLine = lines[startIndex + 1].trim();

    // Check if delimiter line matches `| --- | --- |` or `--- | ---`
    if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(delimiterLine)) {
      return null;
    }

    function splitRow(rowStr) {
      let trimmed = rowStr.trim();
      if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
      if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);

      const cells = [];
      let current = '';
      let escaped = false;
      for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed[i];
        if (escaped) {
          current += c;
          escaped = false;
        } else if (c === '\\') {
          escaped = true;
        } else if (c === '|') {
          cells.push(current.trim());
          current = '';
        } else {
          current += c;
        }
      }
      cells.push(current.trim());
      return cells;
    }

    const headers = splitRow(headerLine);
    const delimiters = splitRow(delimiterLine);
    if (headers.length === 0 || delimiters.length === 0) return null;

    // Determine column alignments
    const alignments = delimiters.map(function (d) {
      const leftColon = d.startsWith(':');
      const rightColon = d.endsWith(':');
      if (leftColon && rightColon) return 'center';
      if (rightColon) return 'right';
      return 'left';
    });

    let consumed = 2;
    const bodyRows = [];

    for (let i = startIndex + 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || !line.includes('|')) break;
      bodyRows.push(splitRow(line));
      consumed++;
    }

    // Build Table HTML
    let tableHtml = '<div class="table-container"><table class="markdown-table">\n<thead>\n<tr>\n';
    for (let c = 0; c < headers.length; c++) {
      const align = alignments[c] || 'left';
      const cellContent = formatInline(headers[c] || '', options);
      tableHtml += `  <th align="${align}" style="text-align: ${align};">${cellContent}</th>\n`;
    }
    tableHtml += '</tr>\n</thead>\n<tbody>\n';

    for (let r = 0; r < bodyRows.length; r++) {
      const row = bodyRows[r];
      tableHtml += '<tr>\n';
      for (let c = 0; c < headers.length; c++) {
        const align = alignments[c] || 'left';
        const rawCell = row[c] !== undefined ? row[c] : '';
        const cellContent = formatInline(rawCell, options);
        tableHtml += `  <td align="${align}" style="text-align: ${align};">${cellContent}</td>\n`;
      }
      tableHtml += '</tr>\n';
    }
    tableHtml += '</tbody>\n</table></div>\n';

    return { html: tableHtml, consumedLines: consumed };
  }

  // ── Main Markdown to HTML Parser ───────────────────────────────────────────

  function parseMarkdown(markdownText, options) {
    if (!markdownText) return '';
    const opts = options || {};

    let text = String(markdownText);
    let frontmatterHtml = '';

    // 1. Extract Frontmatter (YAML, TOML, JSON)
    if (text.startsWith('---')) {
      const endMatch = text.slice(3).indexOf('\n---');
      if (endMatch !== -1) {
        const rawYml = text.slice(3, endMatch + 3).trim();
        text = text.slice(endMatch + 7);
        frontmatterHtml = `<div class="frontmatter-block" data-kind="yaml"><div class="frontmatter-header"><span class="frontmatter-badge">YAML Metadata</span><button type="button" class="frontmatter-toggle-btn" onclick="this.closest('.frontmatter-block').classList.toggle('expanded')">Toggle</button></div><pre class="frontmatter-raw"><code class="language-yaml">${escapeHtml(rawYml)}</code></pre></div>\n`;
      }
    } else if (text.startsWith('+++')) {
      const endMatch = text.slice(3).indexOf('\n+++');
      if (endMatch !== -1) {
        const rawToml = text.slice(3, endMatch + 3).trim();
        text = text.slice(endMatch + 7);
        frontmatterHtml = `<div class="frontmatter-block" data-kind="toml"><div class="frontmatter-header"><span class="frontmatter-badge">TOML Metadata</span><button type="button" class="frontmatter-toggle-btn" onclick="this.closest('.frontmatter-block').classList.toggle('expanded')">Toggle</button></div><pre class="frontmatter-raw"><code class="language-toml">${escapeHtml(rawToml)}</code></pre></div>\n`;
      }
    } else if (text.startsWith(';;;')) {
      const endMatch = text.slice(3).indexOf('\n;;;');
      if (endMatch !== -1) {
        const rawJson = text.slice(3, endMatch + 3).trim();
        text = text.slice(endMatch + 7);
        frontmatterHtml = `<div class="frontmatter-block" data-kind="json"><div class="frontmatter-header"><span class="frontmatter-badge">JSON Metadata</span><button type="button" class="frontmatter-toggle-btn" onclick="this.closest('.frontmatter-block').classList.toggle('expanded')">Toggle</button></div><pre class="frontmatter-raw"><code class="language-json">${escapeHtml(rawJson)}</code></pre></div>\n`;
      }
    }

    // 2. Preprocess inline footnotes ^[inline text]
    let inlineFnCount = 0;
    const collectedFootnotes = [];
    text = text.replace(/\^\[([^\]]+)\]/g, function (m, fnText) {
      inlineFnCount++;
      const label = `inline-${inlineFnCount}`;
      collectedFootnotes.push({ label: String(inlineFnCount), text: fnText });
      return `[^${inlineFnCount}]`;
    });

    const lines = text.split(/\r?\n/);
    let html = frontmatterHtml;
    let i = 0;
    let inList = false;
    let listType = 'ul';
    let isTaskList = false;

    function closeList() {
      if (inList) {
        html += `</${listType}>\n`;
        inList = false;
        isTaskList = false;
      }
    }

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Blank Line
      if (!trimmed) {
        closeList();
        i++;
        continue;
      }

      // ── Fenced Code Blocks (``` or ~~~) ────────────────────────────────────
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        closeList();
        const fenceChar = trimmed[0];
        const fenceTag = trimmed.slice(0, 3);
        const info = trimmed.slice(3).trim();
        const lang = info.split(/\s+/)[0].replace(/^language-/, '').toLowerCase();

        let codeLines = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fenceTag)) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // Consume closing fence

        const rawCode = codeLines.join('\n');
        const displayLang = lang || 'text';
        const langAttr = lang ? ` class="language-${escapeAttr(lang)}"` : '';

        // Diagram engines (mermaid, markmap, svgbob)
        const isDiagram = ['mermaid', 'markmap', 'svgbob', 'plantuml', 'd2'].includes(lang);
        const diagramClass = isDiagram ? ' diagram-block' : '';

        html += `<div class="code-block-wrapper${diagramClass}" data-lang="${escapeAttr(displayLang)}">\n` +
          `  <div class="code-block-header">\n` +
          `    <span class="code-block-lang">${escapeHtml(displayLang)}</span>\n` +
          `    <button type="button" class="code-block-copy-btn" onclick="ArtfulMarkdownRenderer.copyCode(this)">Copy</button>\n` +
          `  </div>\n` +
          `  <pre><code${langAttr}>${escapeHtml(rawCode)}</code></pre>\n` +
          `</div>\n`;
        continue;
      }

      // ── Footnote Definitions: [^1]: Footnote body ──────────────────────────
      const fnDefMatch = trimmed.match(/^\[\^([a-zA-Z0-9_-]+)\]:\s*(.*)$/);
      if (fnDefMatch) {
        closeList();
        const fnLabel = fnDefMatch[1];
        let fnBody = fnDefMatch[2];
        i++;
        // Support indented multiline footnote content
        while (i < lines.length && (lines[i].startsWith('    ') || lines[i].startsWith('\t'))) {
          fnBody += ' ' + lines[i].trim();
          i++;
        }
        collectedFootnotes.push({ label: fnLabel, text: fnBody });
        continue;
      }

      // ── GFM Table Detection ────────────────────────────────────────────────
      if (line.includes('|')) {
        const tableResult = parseTable(lines, i, opts);
        if (tableResult) {
          closeList();
          html += tableResult.html;
          i += tableResult.consumedLines;
          continue;
        }
      }

      // ── Admonitions / Callouts: > [!NOTE] ─────────────────────────────────
      const calloutMatch = line.match(/^>\s*\[!([a-zA-Z0-9_-]+)\]\s*(.*)$/i);
      if (calloutMatch) {
        closeList();
        const calloutType = calloutMatch[1].toLowerCase();
        let calloutTitle = calloutMatch[2].trim() || calloutType.toUpperCase();
        let calloutContentLines = [];

        i++;
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          const bodyLine = lines[i].replace(/^>\s?/, '');
          calloutContentLines.push(bodyLine);
          i++;
        }

        const iconMap = {
          note: 'ℹ️', info: 'ℹ️',
          tip: '💡', hint: '💡',
          important: '⚡', quote: '💬',
          warning: '⚠️', caution: '⚠️',
          danger: '🚨', bug: '🪲',
          success: '✅'
        };
        const icon = iconMap[calloutType] || '📝';
        const formattedContent = calloutContentLines
          .map(function (l) { return formatInline(l, opts); })
          .join('<br>\n');

        html += `<blockquote class="admonition admonition-${escapeAttr(calloutType)}">\n` +
          `  <div class="admonition-header">\n` +
          `    <span class="admonition-icon">${icon}</span>\n` +
          `    <span class="admonition-title">${escapeHtml(calloutTitle)}</span>\n` +
          `  </div>\n` +
          `  <div class="admonition-content">\n` +
          `    <p>${formattedContent}</p>\n` +
          `  </div>\n` +
          `</blockquote>\n`;
        continue;
      }

      // ── Standard Blockquotes: > quote ─────────────────────────────────────
      if (line.startsWith('>')) {
        closeList();
        let bqLines = [];
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          bqLines.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        const bqContent = bqLines.map(function (l) { return formatInline(l, opts); }).join('<br>\n');
        html += `<blockquote><p>${bqContent}</p></blockquote>\n`;
        continue;
      }

      // ── Headings: # to ###### ─────────────────────────────────────────────
      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        closeList();
        const level = headingMatch[1].length;
        const rawTitle = headingMatch[2].trim();
        const headingText = formatInline(rawTitle, opts);
        const headingId = slugify(rawTitle);
        html += `<h${level} id="${headingId}">${headingText}</h${level}>\n`;
        i++;
        continue;
      }

      // ── Horizontal Rule (---, ***, ___) ────────────────────────────────────
      if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
        closeList();
        html += '<hr class="divider">\n';
        i++;
        continue;
      }

      // ── Task Lists: - [ ] or - [x] ────────────────────────────────────────
      const taskMatch = line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/);
      if (taskMatch) {
        const isChecked = taskMatch[3].toLowerCase() === 'x';
        const checkedAttr = isChecked ? ' checked' : '';
        const taskDoneCls = isChecked ? ' task-done' : '';
        const itemContent = formatInline(taskMatch[4], opts);

        if (!inList || listType !== 'ul' || !isTaskList) {
          closeList();
          html += '<ul class="contains-task-list">\n';
          inList = true;
          listType = 'ul';
          isTaskList = true;
        }

        html += `  <li class="task-list-item${taskDoneCls}"><input type="checkbox"${checkedAttr} disabled /> <span>${itemContent}</span></li>\n`;
        i++;
        continue;
      }

      // ── Bullet Lists: - item or * item ────────────────────────────────────
      const bulletMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
      if (bulletMatch) {
        const itemContent = formatInline(bulletMatch[3], opts);
        if (!inList || listType !== 'ul' || isTaskList) {
          closeList();
          html += '<ul>\n';
          inList = true;
          listType = 'ul';
          isTaskList = false;
        }
        html += `  <li>${itemContent}</li>\n`;
        i++;
        continue;
      }

      // ── Numbered Lists: 1. item ───────────────────────────────────────────
      const numMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
      if (numMatch) {
        const itemContent = formatInline(numMatch[3], opts);
        if (!inList || listType !== 'ol') {
          closeList();
          html += '<ol>\n';
          inList = true;
          listType = 'ol';
          isTaskList = false;
        }
        html += `  <li>${itemContent}</li>\n`;
        i++;
        continue;
      }

      // ── Standard Paragraph ────────────────────────────────────────────────
      closeList();
      let paraLines = [trimmed];
      i++;
      while (i < lines.length) {
        const nextTrimmed = lines[i].trim();
        if (!nextTrimmed ||
            nextTrimmed.startsWith('#') ||
            nextTrimmed.startsWith('>') ||
            nextTrimmed.startsWith('```') ||
            nextTrimmed.startsWith('~~~') ||
            nextTrimmed.includes('|') ||
            /^[-*+]\s+/.test(nextTrimmed) ||
            /^\d+\.\s+/.test(nextTrimmed)) {
          break;
        }
        paraLines.push(nextTrimmed);
        i++;
      }
      const paraContent = formatInline(paraLines.join(' '), opts);
      html += `<p>${paraContent}</p>\n`;
    }

    closeList();

    // 3. Append Collected Footnotes Section
    if (collectedFootnotes.length > 0) {
      html += '<section class="footnotes"><ol>\n';
      for (let f = 0; f < collectedFootnotes.length; f++) {
        const fn = collectedFootnotes[f];
        const fnId = slugify(fn.label);
        const fnFormatted = formatInline(fn.text, opts);
        html += `  <li id="fn-${fnId}">${fnFormatted} <a href="#fnref-${fnId}" class="footnote-backref" title="Jump back to reference">↩</a></li>\n`;
      }
      html += '</ol></section>\n';
    }

    return sanitizeHtml(html);
  }

  // ── DOM Enhancement Pipeline ───────────────────────────────────────────────

  function enhanceDom(container, options) {
    if (!container) return;
    const opts = options || {};

    // 1. Syntax Highlighting via highlightCode (from highlighter.js)
    if (typeof highlightCode === 'function') {
      try {
        const codeElements = container.querySelectorAll('pre code');
        codeElements.forEach(function (codeEl) {
          const className = codeEl.className || '';
          const langMatch = className.match(/language-([a-zA-Z0-9_-]+)/);
          const lang = langMatch ? langMatch[1] : '';
          if (!lang) return;
          const rawCode = codeEl.textContent;
          const highlighted = highlightCode(rawCode, lang);
          if (highlighted && highlighted !== rawCode) {
            codeEl.innerHTML = highlighted;
          }
        });
      } catch (err) {
        console.warn('[ArtfulRenderer] Syntax highlighting warning:', err);
      }
    }

    // 2. Interactive Task List Checkboxes (optional toggle handler)
    const taskCheckboxes = container.querySelectorAll('.task-list-item input[type="checkbox"]');
    taskCheckboxes.forEach(function (cb) {
      if (opts.enableInteractiveTasks) {
        cb.removeAttribute('disabled');
        cb.addEventListener('change', function () {
          const li = cb.closest('.task-list-item');
          if (li) li.classList.toggle('task-done', cb.checked);
          if (typeof opts.onTaskToggled === 'function') {
            opts.onTaskToggled(cb.checked);
          }
        });
      }
    });

    // 3. Attach WikiLink click callbacks
    if (typeof opts.onWikiLinkClick === 'function') {
      const wikilinks = container.querySelectorAll('.wikilink');
      wikilinks.forEach(function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          const target = link.getAttribute('data-target');
          opts.onWikiLinkClick(target);
        });
      });
    }

    // 4. Render Mermaid diagrams if available
    if (typeof window !== 'undefined' && window.mermaid) {
      try {
        const mermaidBlocks = container.querySelectorAll('.code-block-wrapper[data-lang="mermaid"]');
        mermaidBlocks.forEach(function (block, idx) {
          const codeEl = block.querySelector('code');
          if (!codeEl) return;
          const src = codeEl.textContent;
          const id = 'mermaid-render-' + Date.now() + '-' + idx;
          window.mermaid.render(id, src).then(function (res) {
            block.innerHTML = res.svg;
          }).catch(function (e) {
            console.warn('[ArtfulRenderer] Mermaid error:', e);
          });
        });
      } catch (err) {
        console.warn('[ArtfulRenderer] Mermaid initialization error:', err);
      }
    }
  }

  // ── Unified Render & Mount ─────────────────────────────────────────────────

  async function render(markdownText, options) {
    const opts = options || {};
    // If running in Tauri with native parse_markdown available, prefer Tauri core
    if (opts.useNativeTauri && typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) {
      try {
        const nativeHtml = await window.__TAURI__.core.invoke('parse_markdown', {
          text: markdownText,
          compat: opts.compat || null
        });
        if (nativeHtml) return sanitizeHtml(nativeHtml);
      } catch (e) {
        console.warn('[ArtfulRenderer] Native Tauri parse_markdown fallback to JS engine:', e);
      }
    }

    return parseMarkdown(markdownText, options);
  }

  async function renderAndMount(container, markdownText, options) {
    if (!container) return;
    const opts = options || {};

    // Build available targets map from vault notes if provided
    if (opts.vaultNotes && Array.isArray(opts.vaultNotes)) {
      const targetMap = new Map();
      opts.vaultNotes.forEach(function (n) {
        if (n.title) targetMap.set(n.title.toLowerCase().trim(), n.relPath || n.rel_path);
        if (n.name) targetMap.set(n.name.replace(/\.md$/i, '').toLowerCase().trim(), n.relPath || n.rel_path);
      });
      opts.availableTargets = targetMap;
    }

    const html = await render(markdownText, opts);
    container.innerHTML = html;
    container.classList.add('artful-rendered-content');

    enhanceDom(container, opts);
    return html;
  }

  function copyCode(btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    if (!wrapper) return;
    const codeEl = wrapper.querySelector('code');
    if (!codeEl) return;
    const codeText = codeEl.textContent;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(codeText).then(function () {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      });
    }
  }

  return {
    render: render,
    parseMarkdown: parseMarkdown,
    formatInline: formatInline,
    enhance: enhanceDom,
    renderAndMount: renderAndMount,
    copyCode: copyCode,
    escapeHtml: escapeHtml,
    sanitizeHtml: sanitizeHtml,
    slugify: slugify
  };
});

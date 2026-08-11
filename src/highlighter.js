// ─────────────────────────────────────────────────────────────────────────────
// ArtfulType Pro — Ultra-Fast Pre-Compiled JIT Syntax Highlighter
// Supported languages & file extensions:
//   - bash ('.sh', '.ksh', '.bash', '.ebuild', '.eclass')
//   - c ('.c', '.h')
//   - cmake ('*.cmake', 'CMakeLists.txt')
//   - cpp ('.cpp', '.hpp', '.c++', '.h++', '.cc', '.hh', '.cxx', '.hxx', '*.pde')
//   - css ('*.css')
//   - go ('*.go')
//   - html ('.html', '.htm', '.xhtml', '.xslt')
//   - java ('*.java')
//   - js ('*.js', 'javascript')
//   - make ('.mak', 'Makefile', 'makefile', 'GNUmakefile')
//   - markdown ('*.md')
//   - python ('.py', '.pyw', '.sc', 'SConstruct', 'SConscript', '.tac')
//   - sql ('*.sql')
//   - tex ('.tex', '.aux', '*.toc')
//   - xml ('.xml', '.xsl', '.rss', '.xsd', '.wsdl')
//   - yaml ('.yaml', '.yml')
// ─────────────────────────────────────────────────────────────────────────────

const LANG_MAP = {
  // bash
  "sh": "bash", "ksh": "bash", "bash": "bash", "ebuild": "bash", "eclass": "bash", "zsh": "bash",
  // c
  "c": "c", "h": "c",
  // cmake
  "cmake": "cmake", "cmakelists.txt": "cmake", "cmakelists": "cmake",
  // cpp
  "cpp": "cpp", "hpp": "cpp", "c++": "cpp", "h++": "cpp", "cc": "cpp", "hh": "cpp", "cxx": "cpp", "hxx": "cpp", "pde": "cpp",
  // css
  "css": "css",
  // go
  "go": "go", "golang": "go",
  // html
  "html": "html", "htm": "html", "xhtml": "html", "xslt": "html",
  // java
  "java": "java",
  // js
  "js": "js", "javascript": "js",
  // make
  "make": "make", "mak": "make", "makefile": "make", "gnu": "make", "gnumakefile": "make",
  // markdown
  "md": "markdown", "markdown": "markdown",
  // python
  "py": "python", "python": "python", "pyw": "python", "sc": "python", "sconstruct": "python", "sconscript": "python", "tac": "python",
  // sql
  "sql": "sql",
  // tex
  "tex": "tex", "latex": "tex", "aux": "tex", "toc": "tex",
  // xml
  "xml": "xml", "xsl": "xml", "rss": "xml", "xsd": "xml", "wsdl": "xml",
  // yaml
  "yaml": "yaml", "yml": "yaml"
};

function normalizeLanguage(langStr) {
  if (!langStr) return "";
  let clean = langStr.toLowerCase().trim().replace(/^language-/, "").replace(/^\./, "");
  return LANG_MAP[clean] || clean;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function span(cls, text) {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function buildGrammar(rules) {
  const sources = rules.map(([_, regex], i) => `(?<K${i}>${regex.source})`);
  let isCaseInsensitive = rules.some(([_, r]) => r.flags.includes("i"));
  let isMultiline       = rules.some(([_, r]) => r.flags.includes("m"));
  let flags = "g" + (isCaseInsensitive ? "i" : "") + (isMultiline ? "m" : "");

  const masterRegex = new RegExp(sources.join("|"), flags);
  return { masterRegex, rules };
}

function runGrammar(code, grammar) {
  let result = "";
  let lastIndex = 0;
  let match;
  const { masterRegex, rules } = grammar;

  masterRegex.lastIndex = 0; // Reset global regex state

  while ((match = masterRegex.exec(code)) !== null) {
    if (match.index > lastIndex) {
      result += escapeHtml(code.slice(lastIndex, match.index));
    }
    const matchedText = match[0];
    if (matchedText.length === 0) {
      masterRegex.lastIndex++;
      continue;
    }

    let tokenType = "syn-text";
    for (let i = 0; i < rules.length; i++) {
      if (match.groups && match.groups[`K${i}`] !== undefined) {
        tokenType = rules[i][0];
        break;
      }
    }

    result += span(tokenType, matchedText);
    lastIndex = masterRegex.lastIndex;
  }

  if (lastIndex < code.length) {
    result += escapeHtml(code.slice(lastIndex));
  }

  return result;
}

// ─── Pre-compiled Grammar Definitions ─────────────────────────────────────────

const GRAMMARS = {
  bash: buildGrammar([
    ["syn-comment",  /#[^\n]*/],
    ["syn-string",   /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^\n`]+`/],
    ["syn-variable", /\$(?:\{[^}]+\}|[a-zA-Z_0-9?#*!@]+)/],
    ["syn-keyword",  /\b(?:if|then|else|elif|fi|for|while|in|do|done|case|esac|function|return|exit|echo|export|alias|local|cd|mkdir|rm|cp|mv)\b/],
    ["syn-operator", /&&|\|\||;|\||>|<|>>|==|!=/]
  ]),

  c: buildGrammar([
    ["syn-comment",  /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
    ["syn-string",   /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
    ["syn-tag",      /#(?:include|define|ifdef|ifndef|endif|pragma|undef|else|elif)\b/],
    ["syn-type",     /\b(?:int|char|float|double|void|long|short|unsigned|signed|struct|union|typedef|enum|const|static|extern|auto|register|volatile|bool|uint8_t|uint16_t|uint32_t|size_t)\b/],
    ["syn-keyword",  /\b(?:if|else|switch|case|default|for|while|do|break|continue|return|goto|sizeof|NULL)\b/],
    ["syn-number",   /\b0x[0-9a-fA-F]+\b|\b\d+(\.\d+)?([fF]|LL|ULL)?\b/]
  ]),

  cpp: buildGrammar([
    ["syn-comment",  /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
    ["syn-string",   /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
    ["syn-tag",      /#(?:include|define|ifdef|ifndef|endif|pragma|undef|else|elif)\b/],
    ["syn-type",     /\b(?:int|char|float|double|void|long|short|unsigned|signed|struct|union|typedef|enum|const|static|extern|auto|register|volatile|bool|uint8_t|uint16_t|uint32_t|size_t|std|string|vector|map)\b/],
    ["syn-keyword",  /\b(?:if|else|switch|case|default|for|while|do|break|continue|return|goto|sizeof|NULL|nullptr|class|public|private|protected|namespace|using|template|typename|virtual|override|constexpr|explicit|noexcept|new|delete|this|try|catch|throw|cout|cin|endl)\b/],
    ["syn-number",   /\b0x[0-9a-fA-F]+\b|\b\d+(\.\d+)?([fF]|LL|ULL)?\b/]
  ]),

  cmake: buildGrammar([
    ["syn-comment",  /#[^\n]*/],
    ["syn-string",   /"(?:[^"\\]|\\.)*"/],
    ["syn-variable", /\$\{[^}]+\}/],
    ["syn-keyword",  /\b(?:ON|OFF|TRUE|FALSE|REQUIRED|PUBLIC|PRIVATE|INTERFACE|BUILD_INTERFACE|INSTALL_INTERFACE|cmake_minimum_required|project|add_executable|add_library|target_link_libraries|target_include_directories|set|option|if|else|elseif|endif|foreach|endforeach|while|endwhile|macro|endmacro|function|endfunction|include|find_package|find_library|message)\b/i]
  ]),

  css: buildGrammar([
    ["syn-comment",  /\/\*[\s\S]*?\*\//],
    ["syn-string",   /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
    ["syn-number",   /#[0-9a-fA-F]{3,8}\b|\b\d+(\.\d+)?(px|em|rem|%|vh|vw|s|ms|deg)?\b/],
    ["syn-keyword",  /@(?:media|keyframes|import|supports|charset|font-face)\b/],
    ["syn-attr",     /[a-zA-Z-]+(?=\s*:)/]
  ]),

  go: buildGrammar([
    ["syn-comment",  /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
    ["syn-string",   /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/],
    ["syn-keyword",  /\b(?:package|import|func|type|struct|interface|var|const|return|if|else|switch|case|select|for|range|break|continue|go|defer|map|chan|make|new|len|append|nil|true|false|error)\b/],
    ["syn-type",     /\b(?:int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|string|bool|byte|rune)\b/],
    ["syn-number",   /\b0x[0-9a-fA-F]+\b|\b\d+(\.\d+)?\b/]
  ]),

  java: buildGrammar([
    ["syn-comment",  /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
    ["syn-string",   /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
    ["syn-keyword",  /\b(?:class|interface|extends|implements|public|private|protected|static|final|abstract|native|synchronized|transient|volatile|new|this|super|return|if|else|switch|case|default|for|while|do|break|continue|try|catch|finally|throw|throws|import|package|null|true|false|Override)\b/],
    ["syn-type",     /\b(?:boolean|byte|char|short|int|long|float|double|void|String|Object|Integer|Boolean|List|Map|Set|System|out|println)\b/],
    ["syn-number",   /\b0x[0-9a-fA-F]+\b|\b\d+(\.\d+)?[fFdD|L]?\b/]
  ]),

  js: buildGrammar([
    ["syn-comment",  /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
    ["syn-string",   /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[\s\S]*?`/],
    ["syn-keyword",  /\b(?:const|let|var|function|async|await|return|if|else|for|while|do|switch|case|default|break|continue|import|export|from|class|extends|constructor|super|this|new|try|catch|finally|throw|typeof|instanceof|null|undefined|true|false|NaN|console|log)\b/],
    ["syn-number",   /\b0x[0-9a-fA-F]+\b|\b\d+(\.\d+)?\b/]
  ]),

  make: buildGrammar([
    ["syn-comment",  /#[^\n]*/],
    ["syn-variable", /\$\([^)]+\)|\$@[^ ]*|\$<|\$\^|\$[0-9]/],
    ["syn-attr",     /^[a-zA-Z0-9_.-]+(?=\s*:)/m],
    ["syn-keyword",  /\b(?:include|-include|ifdef|ifndef|ifeq|ifneq|else|endif|export|unexport|override|all)\b/]
  ]),

  markdown: buildGrammar([
    ["syn-keyword",  /^#{1,6}\s+[^\n]*/m],
    ["syn-string",   /``[^`]+``|`[^`]+`/],
    ["syn-function", /!{0,1}\[[^\]]*\]\([^)]*\)/],
    ["syn-comment",  /^\s*[-*+]\s+|^\s*\d+\.\s+/m]
  ]),

  python: buildGrammar([
    ["syn-comment",  /#[^\n]*/],
    ["syn-string",   /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
    ["syn-variable", /@[a-zA-Z0-9_.]+/],
    ["syn-keyword",  /\b(?:def|class|import|from|as|return|if|elif|else|for|while|break|continue|try|except|finally|raise|with|yield|lambda|pass|assert|async|await|is|in|not|and|or|True|False|None|self|print|__name__|__main__)\b/],
    ["syn-number",   /\b0x[0-9a-fA-F]+\b|\b\d+(\.\d+)?\b/]
  ]),

  sql: buildGrammar([
    ["syn-comment",  /--[^\n]*|\/\*[\s\S]*?\*\//],
    ["syn-string",   /'(?:[^'\\]|\\.)*'/],
    ["syn-keyword",  /\b(?:SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|AND|OR|NOT|NULL|AS|PRIMARY|KEY|FOREIGN|INDEX|UNION|ALL|EXISTS|IN|LIKE|CASE|WHEN|THEN|END|VARCHAR|INT)\b/i],
    ["syn-number",   /\b\d+(\.\d+)?\b/]
  ]),

  tex: buildGrammar([
    ["syn-comment",  /%[^\n]*/],
    ["syn-keyword",  /\\[a-zA-Z]+/],
    ["syn-string",   /\$\$[\s\S]+?\$\$|\$[^$]+\$/],
    ["syn-function", /\\begin\{[^}]+\}|\\end\{[^}]+\}/]
  ]),

  yaml: buildGrammar([
    ["syn-comment",  /#[^\n]*/],
    ["syn-string",   /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
    ["syn-attr",     /^[ \t]*[a-zA-Z0-9_.-]+(?=\s*:)/m],
    ["syn-keyword",  /\b(?:true|false|null|~|True|False)\b/],
    ["syn-number",   /\b\d+(\.\d+)?\b/]
  ])
};

function highlightXml(code) {
  let result = "";
  let i = 0;
  const specialRegex = /[<&]/g;

  while (i < code.length) {
    if (code.startsWith("<!--", i)) {
      let end = code.indexOf("-->", i);
      if (end === -1) end = code.length;
      else end += 3;
      result += span("syn-comment", code.slice(i, end));
      i = end;
      continue;
    }

    if (code[i] === "<") {
      let tagEnd = code.indexOf(">", i);
      if (tagEnd === -1) tagEnd = code.length;
      else tagEnd += 1;

      let tagContent = code.slice(i, tagEnd);
      let highlightedTag = tagContent.replace(
        /^(<\/?[a-zA-Z0-9:-]+)([^>]*)(>?)$/,
        (m, tagName, attrs, endBracket) => {
          let attrHighlighted = attrs.replace(
            /([a-zA-Z0-9:-]+)(\s*=\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
            (m2, aName, eq, aVal) => span("syn-attr", aName) + escapeHtml(eq) + span("syn-string", aVal)
          );
          return span("syn-tag", tagName) + attrHighlighted + escapeHtml(endBracket);
        }
      );

      result += highlightedTag;
      i = tagEnd;
      continue;
    }

    if (code[i] === "&") {
      let semi = code.indexOf(";", i);
      if (semi !== -1 && semi - i < 10) {
        result += span("syn-variable", code.slice(i, semi + 1));
        i = semi + 1;
        continue;
      }
    }

    specialRegex.lastIndex = i + 1;
    const match = specialRegex.exec(code);
    let nextSpecial = match ? match.index : code.length;

    result += escapeHtml(code.slice(i, nextSpecial));
    i = nextSpecial;
  }

  return result;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

function highlightCode(code, langStr) {
  const lang = normalizeLanguage(langStr);
  if (!lang) return escapeHtml(code);

  if (lang === "html" || lang === "xml") {
    return highlightXml(code);
  }

  const grammar = GRAMMARS[lang];
  if (!grammar) {
    return escapeHtml(code);
  }

  return runGrammar(code, grammar);
}

if (typeof window !== "undefined") {
  window.normalizeLanguage = normalizeLanguage;
  window.highlightCode = highlightCode;
}

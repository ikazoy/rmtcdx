import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-css";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-cmake";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-git";
import "prismjs/components/prism-go";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-groovy";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-java";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-makefile";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-perl";
import "prismjs/components/prism-php";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";

type SyntaxCodeBlockProps = {
  code: string;
  language?: string | null;
  className?: string;
  showLineNumbers?: boolean;
  highlightedLineRange?: {
    startLine: number;
    endLine: number;
  } | null;
};

const syntaxAliasMap: Record<string, string> = {
  bash: "bash",
  c: "c",
  cjs: "javascript",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  cxx: "cpp",
  css: "css",
  docker: "docker",
  dockerfile: "docker",
  diff: "diff",
  git: "git",
  go: "go",
  groovy: "groovy",
  html: "markup",
  htm: "markup",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  ini: "ini",
  javascript: "javascript",
  js: "javascript",
  java: "java",
  kotlin: "kotlin",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  makefile: "makefile",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  mermaid: "mermaid",
  mjs: "javascript",
  perl: "perl",
  php: "php",
  powershell: "powershell",
  ps1: "powershell",
  py: "python",
  pyw: "python",
  python: "python",
  rb: "ruby",
  ruby: "ruby",
  rust: "rust",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  swift: "swift",
  sql: "sql",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  yaml: "yaml",
  xml: "markup",
  yml: "yaml",
  zsh: "bash"
};

const syntaxPathAliasMap: Record<string, string> = {
  ".gitattributes": "git",
  ".gitconfig": "git",
  ".gitignore": "git",
  ".gitmodules": "git",
  ".npmrc": "ini",
  ".yarnrc": "ini",
  "brewfile": "ruby",
  "cargo.lock": "toml",
  "cmakelists.txt": "cmake",
  "dockerfile": "docker",
  "gnumakefile": "makefile",
  "gemfile": "ruby",
  "go.mod": "go",
  "go.sum": "go",
  "gradle.properties": "ini",
  "jenkinsfile": "groovy",
  "justfile": "makefile",
  "makefile": "makefile",
  "podfile": "ruby",
  "procfile": "bash",
  "rakefile": "ruby",
  "vagrantfile": "ruby"
};

function normalizeSyntaxLanguage(language?: string | null) {
  if (!language) {
    return null;
  }

  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return syntaxAliasMap[normalized] ?? normalized;
}

function escapeHtml(code: string) {
  return code
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function highlightedHtmlForLine(code: string, grammar: Prism.Grammar | undefined, language: string | null) {
  const highlighted = grammar && language ? Prism.highlight(code, grammar, language) : escapeHtml(code);
  return highlighted || "&nbsp;";
}

export function syntaxLanguageFromMarkdownClassName(className?: string | null) {
  if (!className) {
    return null;
  }

  const languageClass = className
    .split(/\s+/)
    .find((value) => value.startsWith("language-"));

  if (!languageClass) {
    return null;
  }

  return normalizeSyntaxLanguage(languageClass.slice("language-".length));
}

export function inferSyntaxLanguageFromPath(filePath: string) {
  const normalized = filePath.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const basename = normalized.split(/[\\/]/).pop() ?? normalized;
  const exactMatch = syntaxPathAliasMap[basename];
  if (exactMatch) {
    return exactMatch;
  }

  if (basename.startsWith(".env")) {
    return "ini";
  }

  if (basename.startsWith("dockerfile")) {
    return "docker";
  }

  if (basename.endsWith(".gradle.kts")) {
    return "kotlin";
  }

  if (basename.endsWith(".gradle")) {
    return "groovy";
  }

  if (basename.endsWith(".cmake")) {
    return "cmake";
  }

  if (basename.endsWith(".conf") || basename.endsWith(".cfg") || basename.endsWith(".properties")) {
    return "ini";
  }

  const extension = normalized.split(".").pop() ?? "";

  if (basename === "dockerfile") {
    return "docker";
  }

  return normalizeSyntaxLanguage(extension);
}

export function SyntaxCodeBlock({
  code,
  language,
  className,
  showLineNumbers = false,
  highlightedLineRange = null
}: SyntaxCodeBlockProps) {
  const normalizedLanguage = normalizeSyntaxLanguage(language);
  const grammar = normalizedLanguage ? Prism.languages[normalizedLanguage] : undefined;
  const highlighted = grammar && normalizedLanguage ? Prism.highlight(code, grammar, normalizedLanguage) : escapeHtml(code);

  if (showLineNumbers || highlightedLineRange) {
    const lines = code.split("\n");

    return (
      <pre className={className ? `syntax-block ${className}` : "syntax-block"}>
        <code className={normalizedLanguage ? `language-${normalizedLanguage}` : undefined}>
          {lines.map((line, index) => {
            const lineNumber = index + 1;
            const isHighlighted =
              highlightedLineRange !== null &&
              lineNumber >= highlightedLineRange.startLine &&
              lineNumber <= highlightedLineRange.endLine;

            return (
              <span
                key={lineNumber}
                className={`syntax-block__line${isHighlighted ? " syntax-block__line--highlighted" : ""}`}
                data-line-number={lineNumber}
              >
                {showLineNumbers ? (
                  <span className="syntax-block__line-number" aria-hidden="true">
                    {lineNumber}
                  </span>
                ) : null}
                <span
                  className="syntax-block__line-content"
                  dangerouslySetInnerHTML={{
                    __html: highlightedHtmlForLine(line, grammar, normalizedLanguage)
                  }}
                />
              </span>
            );
          })}
        </code>
      </pre>
    );
  }

  return (
    <pre className={className ? `syntax-block ${className}` : "syntax-block"}>
      <code
        className={normalizedLanguage ? `language-${normalizedLanguage}` : undefined}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}

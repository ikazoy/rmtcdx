import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-css";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-python";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";

type SyntaxCodeBlockProps = {
  code: string;
  language?: string | null;
  className?: string;
};

const syntaxAliasMap: Record<string, string> = {
  bash: "bash",
  cjs: "javascript",
  css: "css",
  diff: "diff",
  html: "markup",
  htm: "markup",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  mermaid: "mermaid",
  mjs: "javascript",
  py: "python",
  python: "python",
  sh: "bash",
  shell: "bash",
  sql: "sql",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash"
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
  const extension = normalized.split(".").pop() ?? "";

  if (basename === "dockerfile") {
    return "bash";
  }

  return normalizeSyntaxLanguage(extension);
}

export function SyntaxCodeBlock({ code, language, className }: SyntaxCodeBlockProps) {
  const normalizedLanguage = normalizeSyntaxLanguage(language);
  const grammar = normalizedLanguage ? Prism.languages[normalizedLanguage] : undefined;
  const highlighted = grammar && normalizedLanguage ? Prism.highlight(code, grammar, normalizedLanguage) : escapeHtml(code);

  return (
    <pre className={className ? `syntax-block ${className}` : "syntax-block"}>
      <code
        className={normalizedLanguage ? `language-${normalizedLanguage}` : undefined}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}

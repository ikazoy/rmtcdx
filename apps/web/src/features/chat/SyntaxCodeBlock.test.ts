import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { inferSyntaxLanguageFromPath, SyntaxCodeBlock } from "./SyntaxCodeBlock";

describe("inferSyntaxLanguageFromPath", () => {
  const cases: Array<[string, string]> = [
    ["src/main.tsx", "tsx"],
    ["src/main.go", "go"],
    ["src/main.cpp", "cpp"],
    ["src/main.c", "c"],
    ["src/main.cs", "csharp"],
    ["src/main.rs", "rust"],
    ["src/main.java", "java"],
    ["src/main.kt", "kotlin"],
    ["src/main.rb", "ruby"],
    ["src/main.php", "php"],
    ["src/main.swift", "swift"],
    ["src/main.lua", "lua"],
    ["src/main.ps1", "powershell"],
    ["src/schema.graphql", "graphql"],
    ["Dockerfile", "docker"],
    ["Dockerfile.prod", "docker"],
    ["Makefile", "makefile"],
    ["Jenkinsfile", "groovy"],
    ["build.gradle", "groovy"],
    ["build.gradle.kts", "kotlin"],
    ["CMakeLists.txt", "cmake"],
    ["Gemfile", "ruby"],
    ["go.mod", "go"],
    [".gitignore", "git"],
    [".env.local", "ini"]
  ];

  for (const [filePath, expected] of cases) {
    test(filePath, () => {
      assert.equal(inferSyntaxLanguageFromPath(filePath), expected);
    });
  }

  test("SyntaxCodeBlock renders php without throwing", () => {
    assert.doesNotThrow(() => {
      const markup = renderToStaticMarkup(
        createElement(SyntaxCodeBlock, {
          code: "<?php echo 'hello'; ?>",
          language: "php"
        })
      );

      assert.match(markup, /language-php/);
    });
  });

  test("SyntaxCodeBlock renders line numbers and highlighted ranges when requested", () => {
    const markup = renderToStaticMarkup(
      createElement(SyntaxCodeBlock, {
        code: "const a = 1;\nconst b = 2;\nconst c = 3;",
        language: "typescript",
        showLineNumbers: true,
        highlightedLineRange: {
          startLine: 2,
          endLine: 3
        }
      })
    );

    assert.match(markup, /syntax-block__line-number/);
    assert.match(markup, /data-line-number="2"/);
    assert.match(markup, /syntax-block__line--highlighted/);
  });
});

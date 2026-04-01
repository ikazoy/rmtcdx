import { memo, useEffect, useId, useState } from "react";

type MermaidBlockProps = {
  code: string;
};

type MermaidRenderState = {
  svg: string | null;
  error: string | null;
  isRendering: boolean;
};

type MermaidModule = typeof import("mermaid");

let mermaidModulePromise: Promise<MermaidModule["default"]> | null = null;

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "neutral",
        fontFamily: "ui-sans-serif, system-ui, sans-serif"
      });
      return mermaid;
    });
  }

  return mermaidModulePromise;
}

async function renderDiagramSvg(id: string, code: string) {
  const mermaid = await loadMermaid();
  return mermaid.render(id, code);
}

export const MermaidBlock = memo(function MermaidBlock({ code }: MermaidBlockProps) {
  const [viewMode, setViewMode] = useState<"diagram" | "code">("diagram");
  const [state, setState] = useState<MermaidRenderState>({
    svg: null,
    error: null,
    isRendering: true
  });
  const renderId = useId().replaceAll(":", "-");

  useEffect(() => {
    let cancelled = false;

    setState({
      svg: null,
      error: null,
      isRendering: true
    });

    void renderDiagramSvg(`mermaid-${renderId}`, code)
      .then(({ svg }) => {
        if (cancelled) {
          return;
        }

        setState({
          svg,
          error: null,
          isRendering: false
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setViewMode("code");
        setState({
          svg: null,
          error: error instanceof Error ? error.message : "Unable to render this Mermaid diagram.",
          isRendering: false
        });
      });

    return () => {
      cancelled = true;
    };
  }, [code, renderId]);

  const showDiagram = viewMode === "diagram" && state.svg !== null;
  const showCode = viewMode === "code" || state.svg === null;

  return (
    <div className="mermaid-block">
      <div className="mermaid-block__toolbar">
        <div className="mermaid-block__switch" role="group" aria-label="Mermaid block view">
          <button
            type="button"
            className={`chip ${viewMode === "diagram" ? "is-active" : ""}`}
            onClick={() => setViewMode("diagram")}
            disabled={state.svg === null}
          >
            Diagram
          </button>
          <button
            type="button"
            className={`chip ${viewMode === "code" ? "is-active" : ""}`}
            onClick={() => setViewMode("code")}
          >
            Code
          </button>
        </div>
        <span className="mermaid-block__label">Mermaid</span>
      </div>

      {state.isRendering ? <p className="mermaid-block__status">Rendering diagram...</p> : null}
      {state.error ? <p className="mermaid-block__status">Diagram render failed. Showing source.</p> : null}

      {showDiagram ? (
        <div
          className="mermaid-block__diagram"
          dangerouslySetInnerHTML={{ __html: state.svg ?? "" }}
        />
      ) : null}

      {showCode ? (
        <pre className="mermaid-block__code">
          <code className="language-mermaid">{code}</code>
        </pre>
      ) : null}
    </div>
  );
});

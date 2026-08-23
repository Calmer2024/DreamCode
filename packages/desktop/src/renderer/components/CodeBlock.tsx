import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { grammarLoadCount, highlightToHtml, subscribeGrammarLoaded } from "../markdown/highlight";

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const trimmed = code.endsWith("\n") ? code.slice(0, -1) : code;
  const rootRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount);
  const html = highlightToHtml(trimmed, lang);
  const onCopy = useCallback(() => {
    if (copied) return;
    const text = rootRef.current?.querySelector("pre")?.textContent ?? trimmed;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1000);
    });
  }, [copied, trimmed]);

  return (
    <div ref={rootRef} className="md-code-block">
      <div className="md-code-block-banner-wrap">
        <div className="md-code-block-banner">
          <span className="md-code-block-language">{lang ?? ""}</span>
          <span className="md-code-block-actions">
            <button type="button" onClick={onCopy} aria-label={copied ? "复制成功" : "复制代码"}>
              {copied ? "复制成功" : "复制"}
            </button>
          </span>
        </div>
      </div>
      {html ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki emits escaped static token HTML.
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="md-code-block-plain">
          <code>{trimmed}</code>
        </pre>
      )}
    </div>
  );
}

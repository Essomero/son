/**
 * Markdown renderer for transcript bubbles and the composer preview.
 * GFM tables/footnotes included; links open in a new tab. All visual
 * styling lives under the .md scope in styles.css.
 */

import { memo } from "react";
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function MarkdownImpl({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Assistant text is model output: never let it mint javascript: or
          // data: links. Non-web schemes render as inert text.
          a: ({ href, children: c }: ComponentPropsWithoutRef<"a">) =>
            href != null && /^(https?:|mailto:)/i.test(href) ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {c}
              </a>
            ) : (
              <span>{c}</span>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);

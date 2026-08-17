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
          a: ({ href, children: c }: ComponentPropsWithoutRef<"a">) => (
            <a href={href} target="_blank" rel="noreferrer">
              {c}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);

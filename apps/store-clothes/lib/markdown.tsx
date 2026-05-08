/**
 * Strict-allow-list markdown renderer.
 *
 * Long descriptions on the storefront come from operator-controlled CMS
 * fields (Prompt 6 admin SPA). Even so, we render with `skipHtml: true`
 * and an explicit `allowedElements` list — defence in depth against any
 * content that ends up flowing through this surface (e.g. via a future
 * data import path) carrying raw `<script>` or event handlers.
 */
import * as React from 'react';
import ReactMarkdown from 'react-markdown';

const ALLOWED = [
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'strong',
  'em',
  'ul',
  'ol',
  'li',
  'a',
  'code',
  'pre',
  'blockquote',
  'br',
  'hr',
];

const components: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  a: ({ children, href }) => (
    <a
      href={href}
      // External links should be safe by default. Same-origin relative URLs
      // get `noopener` for free since the target is same-window.
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:text-[var(--brand-accent)]"
    >
      {children}
    </a>
  ),
};

export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose prose-neutral max-w-none">
      <ReactMarkdown
        skipHtml
        allowedElements={ALLOWED}
        unwrapDisallowed
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

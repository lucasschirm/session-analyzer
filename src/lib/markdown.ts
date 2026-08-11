/**
 * Markdown rendering with sanitization.
 *
 * Session transcripts contain arbitrary assistant/user content, so every
 * markdown string is converted via marked and then sanitized through
 * DOMPurify before it is ever inserted into the DOM.
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** Converts markdown to sanitized HTML safe for lit-html's unsafeHTML(). */
export function renderMarkdown(markdown: string): string {
  const rawHtml = marked.parse(markdown ?? '', { async: false }) as string;
  return DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['target'],
  });
}

/** Escapes HTML for contexts where markdown rendering is not desired. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

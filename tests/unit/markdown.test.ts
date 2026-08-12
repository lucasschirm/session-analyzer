// @vitest-environment jsdom
// DOMPurify's DOM handling is incompatible with happy-dom; jsdom matches
// browser behavior for sanitization.
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from '../../src/lib/markdown';

describe('renderMarkdown', () => {
  it('renders basic markdown to HTML', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text');

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```ts\nconst x = 1;\n```');

    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
    expect(html).toContain('const x = 1;');
  });

  it('strips script tags', () => {
    const html = renderMarkdown('Hello <script>alert("xss")</script> world');

    expect(html).not.toContain('<script');
    expect(html).toContain('Hello');
    expect(html).toContain('world');
  });

  it('strips inline event handlers', () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">');

    expect(html).not.toContain('onerror');
  });

  it('strips javascript: URLs', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');

    expect(html).not.toContain('javascript:');
  });

  it('handles empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
    );
  });
});

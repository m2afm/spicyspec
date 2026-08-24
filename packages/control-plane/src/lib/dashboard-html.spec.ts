import { describe, expect, it } from 'vitest';
import { renderDashboard } from './dashboard-html.js';

describe('renderDashboard', () => {
  it('embeds the project name and the CSRF token', () => {
    const html = renderDashboard('Acme Co', 'tok-123');
    expect(html).toContain('Acme Co');
    expect(html).toContain('"tok-123"');
  });

  it('escapes a hostile project name in the title', () => {
    const html = renderDashboard('<script>alert(1)</script>', 'tok');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('is a self-contained page — no external asset host', () => {
    const html = renderDashboard('X', 'tok');
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect(html).toContain('<!doctype html>');
  });

  it('carries the client-side escaper (the dashboard is not an injection sink)', () => {
    expect(renderDashboard('X', 'tok')).toContain('const esc =');
  });
});

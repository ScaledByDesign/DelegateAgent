/**
 * Tiny HTML rendering helpers for the /admin dashboard.
 *
 * No template engine dependency: literal `String.replaceAll` for placeholders
 * (e.g. {{groups_body}}) plus an `escape()` helper for untrusted strings.
 *
 * Templates live in src/web-ui/templates/*.html and are loaded from disk at
 * request time. Caching is intentionally left off — the dashboard is low-traffic
 * and reload-on-change is the desired developer ergonomic.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In dev (tsx): __dirname = src/web-ui. In built dist: __dirname = dist/web-ui.
// In both cases the templates are co-located under ./templates relative to this file.
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const STATIC_DIR = path.join(__dirname, 'static');

// Fallback for when running from dist/ but templates were not copied
// (tsc only emits .js; the build script must copy templates+static separately).
// We probe both and pick the first that exists.
function resolveTemplatesDir(): string {
  if (fs.existsSync(TEMPLATES_DIR)) return TEMPLATES_DIR;
  // Try sibling src/ from dist/
  const fromDist = path.resolve(__dirname, '../../src/web-ui/templates');
  if (fs.existsSync(fromDist)) return fromDist;
  return TEMPLATES_DIR;
}

function resolveStaticDir(): string {
  if (fs.existsSync(STATIC_DIR)) return STATIC_DIR;
  const fromDist = path.resolve(__dirname, '../../src/web-ui/static');
  if (fs.existsSync(fromDist)) return fromDist;
  return STATIC_DIR;
}

export function loadTemplate(name: string): string {
  const dir = resolveTemplatesDir();
  const filePath = path.join(dir, name);
  return fs.readFileSync(filePath, 'utf-8');
}

export function renderTemplate(
  name: string,
  vars: Record<string, string> = {},
): string {
  let html = loadTemplate(name);
  for (const [key, value] of Object.entries(vars)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}

export function escape(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve a static asset path under web-ui/static/. Returns null on path
 * traversal or missing-file. Caller is responsible for content-type and
 * authorization decisions.
 */
export function resolveStaticAsset(filename: string): {
  fullPath: string;
  contentType: string;
} | null {
  // Reject anything that isn't a flat filename
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return null;
  const ext = path.extname(filename).toLowerCase();
  // Whitelist: only allow JS and CSS — no HTML, fonts, images, etc.
  const ctMap: Record<string, string> = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  };
  const contentType = ctMap[ext];
  if (!contentType) return null;
  const dir = resolveStaticDir();
  const fullPath = path.resolve(dir, filename);
  // Defense in depth: ensure the resolved path is still inside the static dir
  if (!fullPath.startsWith(path.resolve(dir) + path.sep)) return null;
  if (!fs.existsSync(fullPath)) return null;
  return { fullPath, contentType };
}

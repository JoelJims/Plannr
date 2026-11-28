// The protocol path check for app://plannr/ (docs/cross-platform-plan.md §5.1): a URL path becomes a
// file inside public/, or null. Refused: anything that decodes to "..", a backslash, a NUL, a drive
// letter or a second leading slash, and any path that would land outside public/.
import path from 'node:path';

export function resolvePublicFile(publicDir, urlPathname) {
  let p;
  try { p = decodeURIComponent(String(urlPathname)); } catch { return null; }
  if (!p.startsWith('/') || p.startsWith('//')) return null;
  if (/[\\\0:]/.test(p)) return null;
  const parts = p.split('/').slice(1);
  if (parts.some((s) => s === '..' || s === '.')) return null;
  let rel = parts.join('/');
  if (rel === '') rel = 'home.html';
  if (path.isAbsolute(rel)) return null;
  const root = path.resolve(publicDir);
  const full = path.resolve(root, rel);
  const back = path.relative(root, full);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  return full;
}

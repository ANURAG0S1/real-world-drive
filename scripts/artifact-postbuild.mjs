// The artifact host wraps the page in its own <html>/<head>/<body>, so strip
// those wrappers from the single-file build and keep everything inside them.
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'dist-artifact/index.html';
let html = readFileSync(file, 'utf8');
html = html
  .replace(/<!doctype html>/i, '')
  .replace(/<html[^>]*>/i, '')
  .replace(/<\/html>/i, '')
  .replace(/<head>/i, '')
  .replace(/<\/head>/i, '')
  .replace(/<body>/i, '')
  .replace(/<\/body>/i, '')
  .replace(/<meta charset="UTF-8" \/>/i, '')
  .replace(/<meta name="viewport"[^>]*>/i, '');
writeFileSync(file, html.trim() + '\n');
console.log(`artifact page written: ${(html.length / 1e6).toFixed(2)} MB`);

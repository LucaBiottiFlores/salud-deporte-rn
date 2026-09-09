// Rewrites the static export so it works when served from a subpath
// (e.g. https://user.github.io/repo/) instead of the domain root.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

// GitHub Pages runs Jekyll by default and skips directories starting with "_".
// This file disables Jekyll so the `_expo` bundle is served as-is.
writeFileSync(join(dist, '.nojekyll'), '');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let changed = 0;
for (const file of walk(dist)) {
  if (!/\.(html|js)$/.test(file)) continue;
  let s = readFileSync(file, 'utf8');
  const before = s;
  if (file.endsWith('.html')) {
    // Normaliza rutas a _expo de forma idempotente:
    // "/_expo/", "../_expo/" y "./_expo/" terminan todas en "./_expo/".
    s = s
      .replace(/(src|href)="(?:\.\.\/|\/)?_expo\//g, '$1="./_expo/')
      .replace('href="/favicon.ico"', 'href="./favicon.ico"');
  } else {
    s = s.replace(/"\/assets\//g, '"./assets/');
  }
  if (s !== before) {
    writeFileSync(file, s);
    changed += 1;
  }
}
console.log(`prepare-pages: rewrote ${changed} file(s)`);

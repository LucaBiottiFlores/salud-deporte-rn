// Rewrites the static export so it works when served from a subpath
// (e.g. https://user.github.io/repo/) instead of the domain root.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

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
    s = s.replace(/\/_expo\//g, './_expo/').replace('href="/favicon.ico"', 'href="./favicon.ico"');
  } else {
    s = s.replace(/"\/assets\//g, '"./assets/');
  }
  if (s !== before) {
    writeFileSync(file, s);
    changed += 1;
  }
}
console.log(`prepare-pages: rewrote ${changed} file(s)`);

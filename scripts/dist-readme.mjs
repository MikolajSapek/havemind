// Build the distribution repo README from the monorepo README.
// Usage: node scripts/dist-readme.mjs <monorepo README> <distribution repo dir>
// Relative Markdown links to files the distribution repo does not ship are
// pointed at the monorepo, so they do not 404 on the plugin page.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MONOREPO_BLOB = 'https://github.com/MikolajSapek/havemind/blob/main/';

export function distributionReadme(markdown, exists) {
  return markdown.replace(/\]\(([^)#\s][^)\s]*)\)/g, (link, target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return link;
    const path = target.split('#')[0];
    return exists(path) ? link : `](${MONOREPO_BLOB}${target})`;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [readmePath, distDir] = process.argv.slice(2);
  const markdown = readFileSync(readmePath, 'utf8');
  process.stdout.write(distributionReadme(markdown, (path) => existsSync(join(distDir, path))));
}

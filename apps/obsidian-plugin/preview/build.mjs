/**
 * Bundles the first-run preview, and optionally serves it.
 *
 * The plugin build marks `obsidian` external because Obsidian supplies it at
 * runtime. Nothing supplies it in a browser, so here it resolves to the local
 * shim instead. That is the only substitution: the section renderers, the view
 * models and `styles.css` are the shipping files, so the preview cannot drift
 * from the pane without the build breaking.
 *
 * Usage:
 *   node preview/build.mjs          build once
 *   node preview/build.mjs --serve  build, watch, serve on localhost
 */

import { fileURLToPath } from 'node:url';

import { context } from 'esbuild';

const previewDirectory = fileURLToPath(new URL('.', import.meta.url));
// Served from the package root, not from `preview/`: the page loads the
// shipping `styles.css`, which lives a level up, and esbuild's server refuses
// to reach outside `servedir`. Serving the root keeps the real sheet in play.
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const serve = process.argv.includes('--serve');
const port = Number(process.env.PORT ?? 5173);

const ctx = await context({
  absWorkingDir: previewDirectory,
  bundle: true,
  entryPoints: ['preview.ts'],
  format: 'iife',
  logLevel: 'info',
  outfile: 'preview.js',
  platform: 'browser',
  sourcemap: true,
  target: 'es2020',
  // The one substitution: the API Obsidian would inject, on real browser DOM.
  alias: { obsidian: './obsidian-shim.ts' },
});

if (!serve) {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('Built preview/preview.js');
} else {
  // Serve BEFORE watch: esbuild throws on a taken port, and starting the
  // watcher first leaves a rebuilding process behind with nothing serving it,
  // which reads as "it started" right up until the browser says nothing is
  // there. Port 0 lets the OS pick a free one rather than failing outright.
  let served;
  try {
    served = await ctx.serve({
      servedir: packageDirectory,
      host: '127.0.0.1',
      port,
    });
  } catch (error) {
    if (!String(error).includes('address already in use')) {
      await ctx.dispose();
      throw error;
    }
    console.log(
      `\n  Port ${port} is already taken, probably by a preview you have ` +
        `still running.\n  Open http://127.0.0.1:${port}/preview/ to use it, ` +
        `or press Ctrl-C and\n  set PORT to pick another. Starting on a free ` +
        `port instead:\n`,
    );
    served = await ctx.serve({
      servedir: packageDirectory,
      host: '127.0.0.1',
      port: 0,
    });
  }

  await ctx.watch();
  console.log(
    `\n  Havemind first-run preview\n  http://127.0.0.1:${served.port}/preview/\n`,
  );
}

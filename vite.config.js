import { writeFile } from 'node:fs/promises';
import { defineConfig } from 'vite';

// js13k ships a zip, not a web server, so every separate file costs twice:
// once for the zip entry's own headers and filename, and again because each
// file is deflated as its own stream and cannot reuse the others' dictionary.
// Folding the CSS and JS back into index.html leaves a single entry that
// compresses as one continuous block.
// Local authoring convenience only. The production build has no editor entry,
// and this middleware is never emitted into the game archive.
function saveLevel() {
  return {
    name: 'save-level',
    configureServer(server) {
      server.middlewares.use('/__save-level', (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          return response.end();
        }
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
          body += chunk;
          if (body.length > 200000) request.destroy();
        });
        request.on('end', async () => {
          try {
            JSON.parse(body);
            await writeFile(new URL('./src/levels/level1.json', import.meta.url), body);
            response.statusCode = 204;
          } catch {
            response.statusCode = 400;
          }
          response.end();
        });
      });
    },
  };
}

function inlineEverything() {
  return {
    name: 'inline-everything',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(f => f.fileName.endsWith('.html'));
      if (!html) return;
      let source = html.source;

      for (const file of Object.values(bundle)) {
        if (file === html) continue;
        const name = file.fileName;
        const body = file.type === 'chunk' ? file.code : file.source;
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let pattern, replacement;

        if (name.endsWith('.js')) {
          // Vite hoists the entry script into <head>. `type="module"` is what
          // defers it until the DOM is parsed, so it has to survive inlining —
          // as a classic script it would run before #c exists.
          pattern = new RegExp(`<script[^>]*src="[^"]*${escapedName}"[^>]*></script>`);
          replacement = `<script type=module>${body}</script>`;
        } else if (name.endsWith('.css')) {
          pattern = new RegExp(`<link[^>]*href="[^"]*${escapedName}"[^>]*>`);
          replacement = `<style>${body}</style>`;
        } else {
          continue;
        }

        // A callback keeps `$&`, `$'`, and `$\`` inside generated code from
        // being interpreted as String.replace substitution patterns.
        const inlined = source.replace(pattern, () => replacement);
        if (inlined === source) this.error(`Could not inline emitted file: ${name}`);
        source = inlined;
        delete bundle[name];
      }

      html.source = source;
    },
  };
}

export default defineConfig({
  plugins: [saveLevel(), inlineEverything()],
  build: {
    // The entry is opened in whatever the judges are running today, so there
    // is no reason to spend bytes on syntax downlevelling or legacy helpers.
    target: 'esnext',
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    assetsInlineLimit: Infinity,
    reportCompressedSize: false,
    // Slower than the default esbuild pass, but it folds constants harder and
    // mangles the module's top-level names, which esbuild leaves alone.
    // Terser's `unsafe` family and booleans_as_integers were measured at a
    // combined 21 bytes here — not worth the changed semantics once there is
    // real gameplay logic to get wrong.
    minify: 'terser',
    terserOptions: {
      compress: { passes: 3, drop_console: true },
      mangle: { toplevel: true },
      format: { comments: false },
    },
  },
});

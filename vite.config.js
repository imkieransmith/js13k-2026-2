import { rename, rm, writeFile } from 'node:fs/promises';
import { defineConfig } from 'vite';
import { Packer } from 'roadroller';
import { unpackLevel } from './src/terrain.js';

// js13k ships a zip, not a web server, so every separate file costs twice:
// once for the zip entry's own headers and filename, and again because each
// file is deflated as its own stream and cannot reuse the others' dictionary.
// Folding the CSS and JS back into index.html leaves a single entry that
// compresses as one continuous block.
// Local authoring convenience only. The production build has no editor entry,
// and this middleware is never emitted into the game archive.
export function saveLevel(output = new URL('./src/levels/arena.json', import.meta.url)) {
  return {
    name: 'save-level',
    configureServer(server) {
      server.middlewares.use('/__save-level', (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          return response.end();
        }
        let body = '';
        let size = 0;
        let tooLarge = false;
        request.setEncoding('utf8');
        request.on('data', chunk => {
          size += Buffer.byteLength(chunk);
          if (size > 200000) tooLarge = true;
          else body += chunk;
        });
        request.on('end', async () => {
          if (tooLarge) response.statusCode = 413;
          else {
            try { unpackLevel(JSON.parse(body)); } catch {
              response.statusCode = 400;
              return response.end();
            }
            const temporary = new URL(`${output.href}.tmp`);
            try {
              await writeFile(temporary, body);
              await rename(temporary, output);
              response.statusCode = 204;
            } catch {
              await rm(temporary, { force: true });
              response.statusCode = 500;
            }
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
    async generateBundle(_options, bundle) {
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

      // Vite deliberately preserves authored HTML comments and formatting.
      // They are useful in the readable source but have no place in the 13KB
      // archive; remove only inter-tag whitespace so text/attribute semantics
      // remain untouched.
      source = source.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').trim();

      // Roadroller models the already tree-shaken/minified program as a whole.
      // This is production-only: development still executes the readable
      // module directly, while the inline module keeps its deferred execution
      // and therefore still starts after the DOM has been parsed.
      const script = source.match(/<script type=module>([\s\S]*?)<\/script>/);
      if (!script) this.error('Could not locate the inlined production module');
      const packer = new Packer([{ data: script[1], type: 'js', action: 'eval' }], { maxMemoryMB: 150 });
      // Selector search uses Math.random. Seed it locally so identical source
      // produces byte-identical archives rather than merely equivalent code.
      const random = Math.random;
      let seed = 0x13_2026;
      Math.random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296;
      try { await packer.optimize(1); } finally { Math.random = random; }
      const { firstLine, secondLine } = packer.makeDecoder();
      const packed = `${firstLine}\n${secondLine}`;
      if (packed.includes('</script>')) this.error('Packed module contains a closing script tag');
      html.source = source.replace(script[1], packed);
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
      // Browser/DOM built-ins remain reserved by Terser; only project-owned
      // object keys are shortened consistently across their definitions/uses.
      mangle: { toplevel: true, properties: {} },
      format: { comments: false },
    },
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
export default defineConfig({ plugins: [react(), {
  name: 'precache-shell', closeBundle() {
    const assets = readdirSync('dist/assets').filter(f => /\.(js|css)$/.test(f)).map(f => '/assets/' + f);
    const sw = readFileSync('public/sw.js', 'utf8').replace("'linko-shell-v1'", JSON.stringify('linko-' + assets.join('').replace(/[^a-z0-9]/gi, ''))).replace("['/',", JSON.stringify(assets).slice(0, -1) + ", '/',");
    writeFileSync('dist/sw.js', sw);
  }
}], server: { host: '127.0.0.1' } });

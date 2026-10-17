import { createServer as viteServer } from 'vite';
import express from 'express';
import { resolve } from 'node:path';
import { config } from './config';
import { createApp } from './app';
const { app, store, workflow, manual, monitor } = createApp(); store.recover(); workflow.archive.recover();
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve('dist'), { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile('index.html', { root: resolve('dist') }));
} else {
  const vite = await viteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = app.listen(config.port, config.host, () => console.log(`Linko workspace: http://${config.host}:${config.port}`));
monitor.start();
async function stop() { monitor.stop(); workflow.auth.cancel(); if (manual.lease) await manual.stop(manual.lease.owner); await workflow.browser.close(); server.close(); store.db.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);

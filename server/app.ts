import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { z } from 'zod';
import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';
import { Store } from './store';
import { Workflow } from './workflow';
import { privateDir, config } from './config';
import { savePhoto } from './photos';
import { WorkflowError } from './types';
import { AccessBoundary } from './access';
import { ManualBrowser } from './manual-browser';
import { codexStatus } from './codex';
import { ListingMonitor } from './listings';
const patchSchema = z.object({ revision: z.number().int(), title: z.string().max(120), description: z.string().max(6000), price: z.string().regex(/^(?:\d{0,8})(?:\.\d{0,2})?$/), currency: z.enum(['GEL', 'USD']), model: z.string().max(200), condition: z.string().max(100), location: z.string().max(200), category: z.array(z.string().max(120)).max(8), facts: z.record(z.string().max(100), z.string().max(500)), coverId: z.string().max(50) });
export function createApp(store = new Store(), workflow = new Workflow(store), access = new AccessBoundary()) {
  const app = express(); app.disable('x-powered-by');
  const manual = new ManualBrowser(workflow);
  const monitor = new ListingMonitor(workflow);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'blob:', 'data:'], connectSrc: ["'self'", ...(!access.origin ? ['ws://127.0.0.1:*', 'ws://localhost:*'] : [])], objectSrc: ["'none'"], upgradeInsecureRequests: null } }, strictTransportSecurity: access.origin ? { maxAge: 15552000, includeSubDomains: false } : false }));
  app.use(access.middleware);
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/auth/status', (req, res) => res.json(access.status(req)));
  app.get('/api/health', (_req, res) => res.json({ application: 'linko-mymarketer', version: '0.2.0', releaseId: config.releaseId, automationBusy: workflow.busy, manualBrowserActive: workflow.manualActive, publishingEnabled: config.publish }));
  app.post('/api/auth/login', (req, res) => access.login(req, res));
  app.post('/api/auth/logout', async (req, res) => { if (manual.lease?.owner === access.session(req)) await manual.stop(access.session(req)); access.logout(req, res); });
  app.get('/api/config', async (req, res) => res.json({ codex: await codexStatus(), publishEnabled: config.publish, mode: access.origin ? 'tailnet' : 'local', publicOrigin: access.origin, browser: manual.status(access.session(req)) }));
  app.get('/api/browser/status', (req, res) => res.json(manual.status(access.session(req))));
  const credentialsSchema = z.object({ identifier: z.string().trim().min(3).max(120), password: z.string().min(1).max(256) }).strict();
  app.get('/api/agent', (_req, res) => res.json(workflow.auth.status()));
  app.post('/api/agent/credentials', (req, res) => { workflow.auth.provideCredentials(credentialsSchema.parse(req.body)); res.json(workflow.auth.status()); });
  app.delete('/api/agent/credentials', (_req, res) => {
    if (workflow.busy) throw new WorkflowError('BUSY', 'Wait for the assistant to finish before removing your MyMarket details.');
    workflow.auth.vault.clear(); workflow.auth.say('Removed your MyMarket details from this server.'); res.json(workflow.auth.status());
  });
  app.post('/api/agent/login', (_req, res) => { workflow.auth.login(); res.status(202).json(workflow.auth.status()); });
  app.post('/api/agent/message', (req, res) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(200) }).strict().parse(req.body);
    if (workflow.auth.message(text) === 'login') workflow.auth.login();
    res.json(workflow.auth.status());
  });
  app.post('/api/browser/start', async (req, res) => res.json(await manual.start(access.session(req))));
  app.get('/api/browser/frame', async (req, res) => { res.set('Cache-Control', 'no-store'); res.type('jpeg').send(await manual.frame(access.session(req))); });
  app.post('/api/browser/control', async (req, res) => { await manual.control(access.session(req), req.body); res.json({ accepted: true }); });
  app.post('/api/browser/finish', async (req, res) => { await manual.stop(access.session(req)); res.json({ active: false, loginVerified: false }); });
  app.post('/api/drafts', (_req, res) => res.status(201).json(store.create()));
  app.get('/api/listings', (_req, res) => res.json({ autoRelistEnabled: config.autoRelist && config.publish, records: workflow.archive.all().map(({ recipe, ...r }) => ({ ...r, title: recipe.title })) }));
  app.post('/api/listings/check', (_req, res) => {
    if (workflow.busy || workflow.manualActive || workflow.prepared) throw new WorkflowError('BUSY', 'Finish the current browser task or form review before checking listings.');
    void monitor.check().catch(() => {}); res.status(202).json({ accepted: true });
  });
  app.patch('/api/listings/:id', (req, res) => {
    if (workflow.busy) throw new WorkflowError('BUSY', 'Wait for the listing check to finish before changing monitoring.');
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(workflow.archive.pause(req.params.id, enabled));
  });
  app.get('/api/listings/:id/record', (req, res) => {
    const r = workflow.archive.get(req.params.id);
    res.type('text/markdown').attachment(r.id + '.md').sendFile(r.id + '.md', { root: store.archiveDir });
  });
  app.get('/api/drafts/:id', (req, res) => res.json(store.get(req.params.id)));
  const editable = (id: string) => {
    const d = store.get(id);
    if (workflow.busy || ['publishing', 'published', 'unknown'].includes(d.state)) throw new WorkflowError('LOCKED', 'This draft is locked while running or after a publishing attempt. Wait or check your MyMarket receipt.');
    return d;
  };
  app.patch('/api/drafts/:id', (req, res) => {
    const d = editable(req.params.id); const patch = patchSchema.parse(req.body);
    if (patch.revision !== d.revision) throw new WorkflowError('CONFLICT', 'This draft changed in another tab. Reload before editing it.');
    if (patch.coverId && !d.photos.some(p => p.id === patch.coverId)) throw new WorkflowError('PHOTO', 'Choose a cover from this draft.');
    if (Object.keys(patch.facts).length > 40) throw new WorkflowError('FACT', 'Keep item details to 40 fields or fewer.');
    Object.assign(d, patch); d.revision++; d.state = d.category.length ? 'review' : 'draft'; delete d.preparedRevision;
    workflow.prepared = undefined; store.save(d); res.json(d);
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 8, fields: 0, parts: 8 } });
  app.post('/api/drafts/:id/photos', upload.array('photos', 8), async (req, res) => {
    const d = editable(String(req.params.id)); const files = req.files as Express.Multer.File[];
    if (!files?.length || d.photos.length + files.length > 8) throw new WorkflowError('PHOTO', 'Add between one and eight photos in total.');
    const added = [];
    try { for (const f of files) added.push(await savePhoto(f.buffer)); }
    catch (e) { for (const p of added) unlinkSync(join(privateDir, 'photos', p.id + '.jpg')); throw e; }
    d.photos.push(...added); if (!d.coverId) d.coverId = d.photos[0].id;
    d.revision++; d.state = 'draft'; delete d.preparedRevision; workflow.prepared = undefined;
    store.save(d); res.json(d);
  });
  app.get('/api/drafts/:id/photos/:photo', (req, res) => {
    const d = store.get(req.params.id);
    if (!d.photos.some(p => p.id === req.params.photo)) throw new WorkflowError('NOT_FOUND', 'Photo not found.');
    res.type('jpeg').send(readFileSync(join(privateDir, 'photos', req.params.photo + '.jpg')));
  });
  app.delete('/api/drafts/:id/photos/:photo', (req, res) => {
    const d = editable(req.params.id); const p = d.photos.find(p => p.id === req.params.photo);
    if (!p) throw new WorkflowError('NOT_FOUND', 'Photo not found.');
    d.photos = d.photos.filter(photo => photo.id !== p.id);
    if (d.coverId === p.id) d.coverId = d.photos[0]?.id || '';
    d.revision++; d.state = 'draft'; delete d.preparedRevision; workflow.prepared = undefined;
    store.save(d);
    if (!store.photoReferenced(p.id)) unlinkSync(join(privateDir, 'photos', p.id + '.jpg'));
    res.json(d);
  });
  app.post('/api/drafts/:id/:operation', (req, res) => {
    const operation = req.params.operation;
    if (!['analyze', 'prepare', 'publish'].includes(operation)) return res.status(404).json({ message: 'Unknown action.' });
    const d = store.get(req.params.id);
    if (workflow.busy || workflow.manualActive) throw new WorkflowError('BUSY', 'Finish manual MyMarket login or wait for the current listing first.');
    if (['published', 'unknown', 'publishing'].includes(d.state)) throw new WorkflowError('LOCKED', 'This item already has a publishing attempt. Check your MyMarket account.');
    if (!d.photos.length || !d.photos.some(p => p.id === d.coverId) || !d.description.trim() || !(Number(d.price) > 0)) throw new WorkflowError('INPUT', 'Add photos, choose a main photo, and provide a description and a price above zero.');
    if (req.body.revision !== d.revision) throw new WorkflowError('CONFLICT', 'Your draft changed. Save the latest details first.');
    if (operation === 'publish' && (req.body.confirm !== true || req.body.preparedAt !== d.preparedAt)) throw new WorkflowError('CONFIRM', 'Review the current prepared form and explicitly confirm publishing.');
    void workflow.run(d.id, operation as 'analyze' | 'prepare' | 'publish');
    res.status(202).json({ accepted: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ message: 'Action not found.' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof WorkflowError ? (err.code === 'NOT_FOUND' ? 404 : 409) : err instanceof z.ZodError || err instanceof multer.MulterError ? 400 : 500;
    // Never serialize provider, browser, request or database errors; they may contain secrets.
    res.status(status).json({ message: err instanceof WorkflowError ? err.message : status === 400 ? 'Check your input and photo size, then try again.' : 'The local server could not complete this action. Your saved draft is safe.' });
  });
  return { app, store, workflow, access, manual, monitor };
}

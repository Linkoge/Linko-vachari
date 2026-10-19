import { randomUUID } from 'node:crypto';
import type { Workflow } from './workflow';
import { WorkflowError } from './types';

export interface Job { id: string; draft: string; operation: 'analyze' | 'details' | 'submit'; status: string; createdAt: number }
/** Durable FIFO. The shared browser serializes all jobs, including every account's jobs. */
export class PublishQueue {
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  constructor(public workflow: Workflow) {}
  get store() { return this.workflow.store; }
  all(): Job[] { return this.store.db.prepare('SELECT * FROM jobs ORDER BY createdAt, rowid').all() as unknown as Job[]; }
  activeJob(id: string) { return this.all().find(j => j.draft === id && ['queued', 'running'].includes(j.status)); }
  active(id: string) { return !!this.activeJob(id); }
  /** Publish was pressed while a category/details job was running; it continues in that job's sequence. */
  publishAfter(id: string) { return !!this.store.db.prepare('SELECT 1 FROM publish_after WHERE draft=?').get(id); }
  /**
   * Publish is always accepted. With no job it queues one; during a category/details job it is attached to it
   * (a queued job becomes the publish job, a running one continues into it); a repeated press changes nothing.
   */
  requestPublish(id: string): { job: Job; attached: boolean; repeated: boolean } {
    const job = this.activeJob(id);
    if (!job) return { job: this.enqueue(id, 'submit'), attached: false, repeated: false };
    if (job.operation === 'submit' || this.publishAfter(id)) return { job, attached: false, repeated: true };
    if (job.status === 'running') {
      // The running job owns the draft; only a durable marker is written, which the job reads when its current step ends.
      this.store.db.prepare('INSERT OR IGNORE INTO publish_after VALUES (?)').run(id);
      return { job, attached: true, repeated: false };
    }
    const d = this.store.get(id);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare("UPDATE jobs SET operation='submit' WHERE id=?").run(job.id); job.operation = 'submit';
      this.store.event(d, 'Publish queued.');
      this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
    return { job, attached: true, repeated: false };
  }
  cancel(id: string) {
    const job = this.all().find(j => j.draft === id && j.operation === 'submit' && j.status === 'queued');
    if (!job) throw new WorkflowError('LOCKED', 'This listing has already started publishing.');
    const d = this.store.get(id);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.workflow.archive.snapshot(d);
      r.enabled = false; r.status = 'deleted_by_owner'; r.deleteRequestedAt = Date.now();
      r.message = 'Owner cancelled the queued listing. Never publish or re-list.';
      this.workflow.archive.write(r); this.finish(job, 'cancelled');
      d.state = 'blocked'; this.store.event(d, r.message);
      this.store.db.exec('COMMIT'); return r;
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
  }
  enqueue(id: string, operation: Job['operation']) {
    if (this.active(id)) throw new WorkflowError('LOCKED', 'This draft already has a queued job.');
    if (this.workflow.archive.all().some(r => r.id === id && r.deleteRequestedAt)) throw new WorkflowError('LOCKED', 'This listing was deleted by you and cannot be published again.');
    const d = this.store.get(id), job: Job = { id: randomUUID(), draft: id, operation, status: 'queued', createdAt: Date.now() };
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run(job.id, id, operation, job.status, job.createdAt);
      d.state = 'queued'; this.store.event(d, operation === 'submit' ? 'Publish queued.' : 'Category search queued.');
      this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
    return job;
  }
  recover() {
    for (const job of this.all().filter(j => j.status === 'running')) {
      const d = this.store.get(job.draft);
      if (!['unknown', 'published'].includes(d.state)) { d.state = 'blocked'; this.store.event(d, 'Job interrupted. Open this draft to continue.'); }
      this.finish(job, d.state === 'published' ? 'published' : d.state === 'unknown' ? 'unknown' : 'failed');
      this.workflow.telegram.notify(`Attention: ${d.title || 'Listing'} job was interrupted. ${d.message}`);
    }
  }
  private finish(job: Job, status: string) {
    this.store.db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, job.id);
    if (!['queued', 'running'].includes(status)) this.store.db.prepare('DELETE FROM publish_after WHERE draft=?').run(job.draft);
  }
  start() { this.timer = setInterval(() => { void this.drain(); }, 500); this.timer.unref(); }
  stop() { if (this.timer) clearInterval(this.timer); }
  async drain() {
    if (this.draining || this.workflow.busy) return;
    const job = this.all().find(j => j.status === 'queued'); if (!job) return;
    this.draining = true; this.finish(job, 'running');
    try {
      await this.workflow.run(job.draft, job.operation);
      let d = this.store.get(job.draft);
      // Publish pressed during a category/details job runs next, still inside the same job.
      if (job.operation !== 'submit' && this.publishAfter(job.draft) && d.state !== 'blocked' && d.category.length) {
        d.state = 'queued'; d.step = 'Publishing…'; this.store.save(d);
        await this.workflow.run(job.draft, 'submit'); d = this.store.get(job.draft);
      }
      this.finish(job, d.state === 'blocked' ? 'failed' : d.state);
    } catch {
      const d = this.store.get(job.draft);
      if (!['unknown', 'published'].includes(d.state)) { d.state = 'blocked'; this.store.event(d, 'Job stopped. Open this draft to continue.'); }
      this.finish(job, d.state === 'unknown' ? 'unknown' : 'failed');
      this.workflow.telegram.notify(`Attention: ${d.title || 'Listing'} job failed. ${d.message}`);
    } finally { this.draining = false; }
  }
}

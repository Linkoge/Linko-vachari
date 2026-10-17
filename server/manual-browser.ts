import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Workflow } from './workflow';
import { WorkflowError } from './types';
export const controlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: z.number().min(0).max(1360), y: z.number().min(0).max(900) }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('key'), key: z.enum(['Tab', 'Shift+Tab', 'Enter', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Control+A']) }),
  z.object({ type: z.literal('scroll'), delta: z.number().min(-1200).max(1200) }),
]);
export class ManualBrowser {
  lease?: { owner: string; id: string; expires: number; closing?: boolean };
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(public workflow: Workflow) {}
  status(owner: string) { return { active: !!this.lease, owned: this.lease?.owner === owner, viewport: { width: 1360, height: 900 } }; }
  touch() {
    clearTimeout(this.timer);
    if (this.lease) this.lease.expires = Date.now() + 10 * 60_000;
    this.timer = setTimeout(() => { this.lease = undefined; this.workflow.manualActive = false; }, 10 * 60_000); this.timer.unref();
  }
  check(owner: string) {
    if (!this.lease || this.lease.closing || this.lease.owner !== owner || this.lease.expires < Date.now()) throw new WorkflowError('MANUAL', 'Start your own private MyMarket login session first.');
    this.touch(); return this.lease.id;
  }
  async start(owner: string) {
    if (this.workflow.busy || (this.lease && this.lease.owner !== owner)) throw new WorkflowError('BUSY', 'The browser is in use. Wait for automation or the current login session to finish.');
    if (this.lease) { this.check(owner); return this.status(owner); }
    this.workflow.manualActive = true; this.workflow.prepared = undefined;
    this.lease = { owner, id: randomUUID(), expires: Date.now() + 10 * 60_000 }; this.touch();
    try {
      await this.workflow.browser.home();
      return this.status(owner);
    } catch { await this.stop(owner); throw new WorkflowError('MANUAL', 'The private browser could not open. Check Chromium and the dedicated display; then try again.'); }
  }
  serialized<T>(owner: string, action: () => Promise<T>): Promise<T> {
    const id = this.check(owner);
    const next = this.queue.then(async () => { if (this.check(owner) !== id) throw new WorkflowError('MANUAL', 'The login session ended.'); return action(); });
    this.queue = next.catch(() => {}); return next;
  }
  async frame(owner: string) { return this.serialized(owner, async () => { const page = this.workflow.browser.page; if (!page || page.isClosed()) throw new WorkflowError('MANUAL', 'The browser closed. Start a new login session.'); return page.screenshot({ type: 'jpeg', quality: 75, timeout: 8000 }); }); }
  async control(owner: string, raw: unknown) {
    const input = controlSchema.parse(raw);
    return this.serialized(owner, async () => {
      const page = this.workflow.browser.page!;
      // Coordinates are supplied by the human viewing the current frame; automation never uses them.
      if (input.type === 'click') await page.mouse.click(input.x, input.y);
      if (input.type === 'text') await page.keyboard.insertText(input.text);
      if (input.type === 'key') await page.keyboard.press(input.key);
      if (input.type === 'scroll') await page.mouse.wheel(0, input.delta);
    });
  }
  async stop(owner: string) {
    if (this.lease && this.lease.owner !== owner) throw new WorkflowError('MANUAL', 'Only the owner of this login session can finish it.');
    if (this.lease) this.lease.closing = true;
    clearTimeout(this.timer); await this.queue;
    clearTimeout(this.timer); this.lease = undefined; this.workflow.manualActive = false;
    // Keep this same persistent context for subsequent automation; never claim login success from a button click.
  }
}

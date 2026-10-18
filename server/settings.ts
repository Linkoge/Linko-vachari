import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { privateDir, config } from './config';
import { WorkflowError } from './types';
import { registerSecret } from './secrets';

export const slotSchema = z.object({ provider: z.enum(['codex', 'claude']), model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/), effort: z.enum(['low', 'medium', 'high']) }).strict();
export const aiSchema = z.object({ everyday: slotSchema, fixit: slotSchema }).strict();
export type AISlot = 'everyday' | 'fixit';
export type AIChoice = z.infer<typeof slotSchema>;
export const automationSchema = z.object({ publish: z.boolean(), autoRelist: z.boolean() }).strict();
const initialAutomation = () => ({ publish: config.publish, autoRelist: config.autoRelist });
const settingsSchema = z.object({ ai: aiSchema, telegram: z.object({ token: z.string().max(200), chatId: z.string().max(100) }).strict(), automation: automationSchema.default(initialAutomation) }).strict();
export type SettingsData = z.infer<typeof settingsSchema>;
export class SettingsStore {
  constructor(public file = join(privateDir, 'settings.json')) {}
  load(): SettingsData {
    if (!existsSync(this.file)) return { ai: { everyday: { provider: 'codex', model: 'gpt-5.4-mini', effort: 'low' }, fixit: { provider: 'codex', model: 'gpt-5.4', effort: 'high' } }, telegram: { token: '', chatId: '' }, automation: initialAutomation() };
    try { const data = settingsSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); registerSecret(data.telegram.token); return data; }
    catch { throw new WorkflowError('SETTINGS', 'Saved settings could not be read. Repair the private settings file before running jobs.'); }
  }
  save(data: SettingsData) {
    const parsed = settingsSchema.parse(data); mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify(parsed), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file);
    registerSecret(parsed.telegram.token); return this.view();
  }
  view() { const data = this.load(); return { ai: data.ai, automation: data.automation, telegram: { configured: !!data.telegram.token, chatId: data.telegram.chatId } }; }
}
export const settings = new SettingsStore();

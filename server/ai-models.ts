import { spawn } from 'node:child_process';
import { config } from './config';
import { codexEnvironment, providerStatus } from './codex';
import type { AIChoice, SettingsData } from './settings';
import { WorkflowError } from './types';
export type AIModel = { name: string; model: string; efforts: AIChoice['effort'][] };
export type AIModelCatalog = Record<AIChoice['provider'], AIModel[]>;
const efforts = ['low', 'medium', 'high'] as const;
const labels: Record<string, string> = { 'gpt-6-luna': 'Luna', 'gpt-6.1-sol': 'Sol', 'gpt-6-astra': 'Astra' };
let cached: { binary: string; until: number; models: AIModel[] } | undefined;
let pending: Promise<AIModel[]> | undefined;
// model/list is metadata only: no model turn, tools, marketplace or credential reads.
export async function codexModels(): Promise<AIModel[]> {
  const binary = config.codexBinary;
  if (cached?.binary === binary && cached.until > Date.now()) return cached.models;
  if (pending) return pending;
  pending = new Promise<AIModel[]>(resolve => {
    const child = spawn(binary, ['app-server', '--listen', 'stdio://', '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"'], { env: codexEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let buffer = '', done = false;
    const finish = (models: AIModel[]) => {
      if (done) return; done = true; clearTimeout(timer);
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      cached = { binary, until: Date.now() + (models.length ? 60_000 : 5000), models }; resolve(models);
    };
    const timer = setTimeout(() => finish([]), 8000);
    const send = (data: unknown) => child.stdin!.write(JSON.stringify(data) + '\n');
    child.on('error', () => finish([])); child.on('close', () => finish([]));
    child.stderr!.on('data', () => {}); child.stdin!.on('error', () => {});
    child.stdout!.on('data', chunk => {
      buffer += chunk; if (buffer.length > 500_000) return finish([]);
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && message.result) {
            send({ method: 'notifications/initialized' }); send({ id: 2, method: 'model/list', params: { includeHidden: false, limit: 100 } });
          }
          if (message.id === 2) {
            const models: AIModel[] = [];
            for (const m of message.result?.data || []) {
              if (m.hidden || typeof m.model !== 'string' || !Array.isArray(m.supportedReasoningEfforts)) continue;
              const supported = efforts.filter(e => m.supportedReasoningEfforts.some((r: any) => r.reasoningEffort === e));
              if (supported.length) models.push({ model: m.model, name: labels[m.model] || m.displayName || m.model, efforts: [...supported] });
            }
            // Keep the familiar three first; every other CLI-listed model remains selectable.
            models.sort((a, b) => (Object.keys(labels).indexOf(a.model) < 0 ? 99 : Object.keys(labels).indexOf(a.model)) - (Object.keys(labels).indexOf(b.model) < 0 ? 99 : Object.keys(labels).indexOf(b.model)));
            finish(models);
          }
        } catch { finish([]); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'linko-model-picker', version: '1.0' } } });
  });
  try { return await pending; } finally { pending = undefined; }
}
export async function providerModels(): Promise<AIModelCatalog> {
  const [codex, claude] = await Promise.all([codexModels(), providerStatus('claude')]);
  return { codex, claude: claude.installed ? ['haiku', 'sonnet', 'opus'].map(model => ({ name: model[0].toUpperCase() + model.slice(1), model, efforts: [...efforts] })) : [] };
}
export async function validateModelChanges(before: SettingsData['ai'], after: SettingsData['ai']) {
  const catalog = await providerModels();
  for (const slot of ['everyday', 'fixit'] as const) {
    const choice = after[slot]; if (JSON.stringify(before[slot]) === JSON.stringify(choice)) continue;
    if (!catalog[choice.provider].some(m => m.model === choice.model && m.efforts.includes(choice.effort))) throw new WorkflowError('SETTINGS', 'This model/effort is unavailable in the installed CLI catalog. Choose a listed model.');
  }
}

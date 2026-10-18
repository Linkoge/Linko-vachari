import { SettingsStore, settings } from './settings';
import { redact } from './browser';

export class Telegram {
  pending = 0;
  constructor(public source: SettingsStore = settings, public base = 'https://api.telegram.org', public timeout = 4000) {}
  async request(method: 'sendMessage' | 'getUpdates', body: object) {
    try {
      const { token } = this.source.load().telegram;
      if (!token) return undefined;
      const response = await fetch(`${this.base}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeout), redirect: 'error' });
      if (!response.ok) return undefined;
      // Bound response consumption as well as headers, without ever exposing raw Telegram errors/updates.
      const reader = response.body?.getReader(); if (!reader) return undefined;
      let text = '';
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += Buffer.from(chunk.value).toString('utf8'); if (text.length > 64_000) { await reader.cancel(); return undefined; } }
      const data = JSON.parse(text); return data.ok ? data.result : undefined;
    } catch { return undefined; }
  }
  async send(message: string) {
    try {
      const { chatId } = this.source.load().telegram;
      if (!chatId) return false;
      return !!await this.request('sendMessage', { chat_id: chatId, text: redact(message).slice(0, 3500), disable_web_page_preview: true });
    } catch { return false; }
  }
  // Notification work never participates in the monitor's browser queue. Cap concurrency and drop on failure.
  notify(message: string) {
    if (this.pending >= 8) return;
    this.pending++;
    void this.send(message).catch(() => false).finally(() => { this.pending--; });
  }
  async detect() {
    const updates = await this.request('getUpdates', { timeout: 0, limit: 20, allowed_updates: ['message'] });
    if (!Array.isArray(updates)) return [];
    return [...new Set(updates.map(u => u.message?.chat).filter(c => c?.type === 'private' && /^-?\d+$/.test(String(c.id))).map(c => String(c.id)))];
  }
}

import { useState, type KeyboardEvent } from 'react';
import type { AIChoice, AISlot } from '../server/settings';

// Presentation suggestions, not an account entitlement catalog. Exact saved IDs
// (including older and custom models) always remain visible and selectable.
const models = {
  codex: [{ name: 'Luna', model: 'gpt-6-luna' }, { name: 'Sol', model: 'gpt-6.1-sol' }, { name: 'Astra', model: 'gpt-6-astra' }],
  claude: [{ name: 'Haiku', model: 'haiku' }, { name: 'Sonnet', model: 'sonnet' }, { name: 'Opus', model: 'opus' }],
};
const names = { codex: 'Codex', claude: 'Claude' };
const title = (value: string) => value[0].toUpperCase() + value.slice(1);

function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

export function AIPicker({ slot, choice, disabled, status, onChoose }: {
  slot: AISlot; choice: AIChoice; disabled: boolean; status: string;
  onChoose: (choice: AIChoice) => Promise<boolean>;
}) {
  const label = slot === 'everyday' ? 'Everyday' : 'Fix-it';
  const [custom, setCustom] = useState('');
  const [provider, setProvider] = useState<AIChoice['provider']>(choice.provider);
  return <fieldset className="ai-slot" disabled={disabled}>
    <legend>{label}</legend>
    <p className="ai-slot-description">{slot === 'everyday' ? 'Categories and field matching.' : 'Repairs a script when the page changes.'}</p>
    {(['codex', 'claude'] as const).map(p => {
      const active = choice.provider === p;
      const choices = [...models[p]];
      if (active && !choices.some(m => m.model === choice.model)) choices.push({ name: choice.model, model: choice.model });
      return <div className="ai-provider" key={p}>
        <div className="model-choice-row" role="group" aria-label={`${label} ${names[p]} model`} onKeyDown={moveFocus}>
          {choices.map(m => <button type="button" className="model-family" key={m.model}
            title={`${names[p]} · ${m.model}`} aria-label={`${label} ${names[p]} ${m.name}`}
            aria-pressed={active && choice.model === m.model}
            onClick={() => { if (!active || choice.model !== m.model) void onChoose({ provider: p, model: m.model, effort: choice.effort }); }}>{m.name}</button>)}
        </div>
        <div className="model-choice-row" role="group" aria-label={`${label} ${names[p]} effort`} onKeyDown={moveFocus}>
          {(['low', 'medium', 'high'] as const).map(e => <button type="button" className="effort-choice" key={e}
            aria-label={`${label} ${names[p]} ${title(e)}`} aria-pressed={active && choice.effort === e} disabled={!active}
            onClick={() => { if (choice.effort !== e) void onChoose({ ...choice, effort: e }); }}>{title(e)}</button>)}
        </div>
      </div>;
    })}
    <p className="ai-saved-choice"><strong>{names[choice.provider]}</strong> · {choice.model} · {title(choice.effort)}</p>
    <p className="ai-provider-status">{status}</p>
    <details className="ai-custom"><summary>Use another model</summary>
      <form onSubmit={event => { event.preventDefault(); void onChoose({ provider, model: custom.trim(), effort: choice.effort }).then(saved => { if (saved) setCustom(''); }); }}>
        <label>Provider<select aria-label={`${label} custom provider`} value={provider} onChange={e => setProvider(e.target.value as AIChoice['provider'])}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
        <label>Exact model ID<input aria-label={`${label} custom model`} value={custom} onChange={e => setCustom(e.target.value)} required maxLength={100} pattern="[a-zA-Z0-9][a-zA-Z0-9._:\/\-]{0,99}" autoCapitalize="none" autoComplete="off" spellCheck={false}/></label>
        <small>This draft is applied only when you choose Save model. Model access is checked on use.</small>
        <button type="submit" className="button ghost" disabled={!custom.trim()}>Save model</button>
      </form>
    </details>
  </fieldset>;
}

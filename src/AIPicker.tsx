import { type KeyboardEvent } from 'react';
import type { AIModelCatalog } from '../server/ai-models';
import type { AIChoice, AISlot } from '../server/settings';

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

export function AIPicker({ slot, choice, disabled, models, onChoose }: {
  slot: AISlot; choice: AIChoice; disabled: boolean; models: AIModelCatalog;
  onChoose: (choice: AIChoice) => Promise<boolean>;
}) {
  const label = slot === 'everyday' ? 'Everyday' : 'Fix-it';

  return <fieldset className="ai-slot" disabled={disabled}>
    <legend>{label}</legend>
    {(['codex', 'claude'] as const).map(p => {
      const active = choice.provider === p;
      const choices = models[p];
      const selected = choices.find(m => active && m.model === choice.model);
      return <div className="ai-provider" key={p}>
        <div className="model-choice-row" role="group" aria-label={`${label} ${names[p]} model`} onKeyDown={moveFocus}>
          {choices.map(m => <button type="button" className="model-family" key={m.model}
            title={`${names[p]} · ${m.model}`} aria-label={`${label} ${names[p]} ${m.name}`}
            aria-pressed={active && choice.model === m.model}
            onClick={() => { if (!active || choice.model !== m.model) void onChoose({ provider: p, model: m.model, effort: m.efforts.includes(choice.effort) ? choice.effort : m.efforts[0] }); }}>{m.name}</button>)}
        </div>
        {active && !selected && <p>{choice.model} · unavailable in the installed CLI catalog. Choose a listed model.</p>}
        <div className="model-choice-row" role="group" aria-label={`${label} ${names[p]} effort`} onKeyDown={moveFocus}>
          {(['low', 'medium', 'high'] as const).map(e => <button type="button" className="effort-choice" key={e}
            aria-label={`${label} ${names[p]} ${title(e)}`} aria-pressed={active && choice.effort === e} disabled={!selected?.efforts.includes(e)}
            onClick={() => { if (choice.effort !== e) void onChoose({ ...choice, effort: e }); }}>{title(e)}</button>)}
        </div>
      </div>;
    })}
  </fieldset>;
}

// Runtime registry of owner secrets (marketplace credentials, one-time codes) so every redaction path can scrub them.
const secrets = new Set<string>();
export function registerSecret(value: string | undefined) { if (value && value.length > 3) secrets.add(value); }
export function unregisterSecret(value: string | undefined) { if (value) secrets.delete(value); }
export function redactSecrets(text: string) {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[private credential]');
  return text;
}

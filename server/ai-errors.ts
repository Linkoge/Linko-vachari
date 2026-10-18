import { redact } from './browser';

export type AIFailureKind = 'usage' | 'model' | 'timeout' | 'schema' | 'parse' | 'image' | 'output' | 'cli';
export class AIFailure extends Error {
  constructor(public kind: AIFailureKind, detail = '') { super(detail); }
}
// CLI transcripts can echo the whole prompt. Extract error records, never the transcript.
export function cliErrorDetail(stderr: string, stdout = ''): string {
  const messages: string[] = [];
  const extract = (data: any) => {
    if (typeof data?.error === 'string') messages.push(data.error);
    if (typeof data?.error?.message === 'string') messages.push(data.error.message);
    const issue = data?.error && typeof data.error === 'object' ? data.error : data;
    if (/usage[_ -]?limit|rate[_ -]?limit|quota/i.test(issue?.type || issue?.code || '')) messages.push('usage limit reached');
    const reset = issue?.resets_at ?? issue?.reset_at ?? data?.resets_at;
    if (typeof reset === 'number' && Number.isFinite(reset)) {
      const date = new Date(reset < 1e12 ? reset * 1000 : reset);
      if (!Number.isNaN(date.valueOf())) messages.unshift('Resets at ' + date.toISOString());
    } else if (typeof reset === 'string') messages.unshift('Resets at ' + reset);
    if (data?.type === 'error' && typeof data.message === 'string') messages.push(data.message);
    if (data?.is_error || (data?.subtype && data.subtype !== 'success')) {
      if (typeof data.result === 'string') messages.push(data.result);
      if (Array.isArray(data.errors)) messages.push(...data.errors.filter((v: unknown) => typeof v === 'string'));
    }
  };
  for (const line of [stderr, stdout].join('\n').split('\n')) {
    const value = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const body = value.replace(/^(?:error|fatal):\s*/i, '');
    try { extract(JSON.parse(body)); }
    catch { if (/^(?:error|fatal):/i.test(value)) messages.push(body); }
  }
  return [...new Set(messages)].join(' ').slice(0, 16_000);
}
export function redactAIDetail(detail: string): string {
  let safe = detail.replace(/\x1b\[[0-9;]*m/g, '');
  for (const [key, value] of Object.entries(process.env)) {
    if (/password|passwd|secret|token|api_?key|credential|proxy/i.test(key) && value && value.length > 3) safe = safe.split(value).join('[redacted]');
  }
  return redact(safe)
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]')
    .replace(/data:image\/[a-z+.-]+;base64,[a-z0-9+/=]+/gi, '[private image]')
    .replace(/\b(?:sk|sess|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(["']?(?:password|passwd|secret|token|api[ _-]?key|access[ _-]?token|authorization|cookie|session)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g, '[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[private URL]')
    .replace(/(?:\/[\w.@+-]+){2,}/g, '[private path]')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}
export function classifyAIError(error: unknown, stderr = '', stdout = '') {
  const detail = cliErrorDetail(stderr, stdout) || (error instanceof AIFailure ? error.message : '');
  let kind: AIFailureKind = error instanceof AIFailure ? error.kind : error instanceof SyntaxError ? 'parse' : error instanceof Error && error.name === 'ZodError' ? 'schema' : 'cli';
  if (/usage[_ -]?limit|rate[_ -]?limit|quota|too many requests|limit reached|hit your limit|out of (?:extra )?usage|resets? at|429/i.test(detail)) kind = 'usage';
  else if (/invalid.*schema|schema.*(?:invalid|unsupported)|additionalProperties|required.*(?:missing|supplied)|unsupported.*(?:keyword|minItems|maxItems)/i.test(detail)) kind = 'schema';
  else if (/\bimage\b|image_url|media_type|unsupported.*(?:jpeg|png|webp)|could not.*(?:decode|attach)/i.test(detail)) kind = 'image';
  else if (/model_not_found|model.*(?:not supported|not found|not available|unavailable|unknown|does not exist|not have access|invalid)|(?:unknown|invalid|unsupported).*model|reasoning.*(?:unsupported|not supported|invalid)/i.test(detail)) kind = 'model';
  else if (/timed?\s*out|timeout|deadline exceeded/i.test(detail)) kind = 'timeout';
  const labels: Record<AIFailureKind, string> = { usage: 'usage limit reached', model: 'unknown or unavailable model/effort', timeout: 'decision timed out', schema: 'invalid output schema', parse: 'non-JSON output or parse failure', image: 'cover image problem', output: 'CLI output exceeded size limit', cli: 'CLI execution failed' };
  // Parser/Zod errors may contain supplied values; never include their raw messages.
  return { kind, message: labels[kind], detail: redactAIDetail(detail) };
}

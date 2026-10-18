#!/usr/bin/env node
// Tests exercise a deterministic Codex execution failure without making account calls.
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({ authMethod: 'claude.ai' })); process.exit(0); }
if (process.argv.includes('app-server')) {
  const readline = await import('node:readline');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (message.id === 2) console.log(JSON.stringify({ id: 2, result: { data: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].map(model => ({ model, supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) })) } }));
  });
} else process.exit(1);

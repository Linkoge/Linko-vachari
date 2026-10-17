#!/usr/bin/env node
// Tests exercise a deterministic Codex execution failure without making account calls.
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
process.exit(1);

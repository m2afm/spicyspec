#!/usr/bin/env node
import { runCli } from './lib/cli.js';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error('spicyspec-runner:', err?.message ?? err);
    process.exitCode = 1;
  },
);

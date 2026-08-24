#!/usr/bin/env node
import { resolve, basename } from 'node:path';
import { scaffoldProject } from './lib/scaffold.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: create-spicyspec <project-directory>');
  process.exitCode = 2;
} else {
  const dir = resolve(target);
  scaffoldProject(dir, { projectName: basename(dir) }).then(
    (r) => {
      console.log(`created ${r.dir}`);
      for (const f of r.files) console.log(`  ${f}`);
      console.log('\nnext: cd ' + target + '  — then follow README.md (five commands to a running loop)');
    },
    (err) => {
      console.error('create-spicyspec:', err?.message ?? err);
      process.exitCode = 1;
    },
  );
}

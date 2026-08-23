import { describe, expect, it } from 'vitest';
import { cliJudgeProvider } from './cli-provider.js';
import { buildJudgePrompt, extractJson, judgeChain, type JudgeProvider } from './judge.js';

const VALID = JSON.stringify({
  assessment: 'run matches evidence',
  honest: true,
  claimsUnverified: [],
  action: 'continue',
  reason: 'commits and verification agree',
  confidence: 0.9,
});

const provider = (id: string, impl: () => Promise<string>): JudgeProvider => ({ id, invoke: impl });

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson(VALID)).toMatchObject({ honest: true });
  });

  it('digs the object out of chatty prose and fences', () => {
    const noisy = 'Sure! Here is my verdict:\n```json\n' + VALID + '\n```\nHope that helps!';
    expect(extractJson(noisy)).toMatchObject({ action: 'continue' });
  });

  it('handles braces inside strings', () => {
    const tricky = 'prefix {"assessment":"has { and } inside","honest":false,"claimsUnverified":[],"action":"park","reason":"x","confidence":0.5} suffix';
    expect(extractJson(tricky)).toMatchObject({ action: 'park' });
  });

  it('no object → throws (the chain records it as a failure)', () => {
    expect(() => extractJson('I cannot help with that')).toThrow(/no JSON object/);
  });
});

describe('judgeChain — C3: the honesty check must never silently vanish', () => {
  it('first provider wins when valid', async () => {
    const r = await judgeChain([provider('kimi', async () => VALID), provider('glm', async () => VALID)], 'p');
    expect(r.judgedBy).toBe('kimi');
    expect(r.failures).toHaveLength(0);
  });

  it('the 2026-08-23 shape: quota-dead first vendor falls through to the second', async () => {
    const r = await judgeChain(
      [
        provider('kimi', async () => {
          throw new Error("403 You've reached your usage limit for this billing cycle");
        }),
        provider('glm', async () => VALID),
      ],
      'p',
    );
    expect(r.judgedBy).toBe('glm');
    expect(r.failures).toEqual([{ id: 'kimi', error: expect.stringContaining('usage limit') }]);
  });

  it('schema mismatch is a failure, not a verdict', async () => {
    const r = await judgeChain(
      [
        provider('a', async () => '{"assessment":"x","action":"maybe"}'),
        provider('b', async () => VALID),
      ],
      'p',
    );
    expect(r.judgedBy).toBe('b');
    expect(r.failures[0].error).toContain('schema mismatch');
  });

  it('every provider dead → verdict null with EVERY failure recorded — UNKNOWN, never a pass', async () => {
    const r = await judgeChain(
      [
        provider('a', async () => {
          throw new Error('quota');
        }),
        provider('b', async () => 'not json at all'),
      ],
      'p',
    );
    expect(r.verdict).toBeNull();
    expect(r.judgedBy).toBeNull();
    expect(r.failures.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('an empty chain reports itself honestly', async () => {
    const r = await judgeChain([], 'p');
    expect(r.verdict).toBeNull();
    expect(r.failures).toHaveLength(0);
  });
});

describe('buildJudgePrompt — evidence first, story second, strict JSON out', () => {
  const prompt = buildJudgePrompt({
    projectName: 'Acme',
    specId: '006',
    runNumber: 4,
    classification: { exit: 'clean', commits: true, tasksClosed: 2, costUsd: 3.5, costKnown: true },
    harvest: {
      toolCalls: 88,
      toolErrors: 1,
      verificationCommandsRun: 3,
      verificationOutcomes: { passed: 2, failed: 1 },
      verificationCommands: [{ command: 'pnpm nx test api', outcome: 'failed' }],
      failingCommands: [{ command: 'pnpm nx test api', tail: '2 failed' }],
      subagentsDispatched: [{ subagent: 'qa-critic', description: 'wave gate', returned: true }],
      subagentVerdictTails: [],
      recordFilesWritten: [],
      redFirstResidue: [],
    },
    workerText: 'All suites green, gate approved.',
  });

  it('carries the facts the story must be judged against', () => {
    expect(prompt).toContain('"failed": 1');
    expect(prompt).toContain('pnpm nx test api');
    expect(prompt).toContain('All suites green');
  });

  it('demands exactly one JSON object and defines fabrication', () => {
    expect(prompt).toContain('EXACTLY ONE JSON object');
    expect(prompt).toContain('fabricated');
  });
});

describe('cliJudgeProvider', () => {
  it('appends the prompt as the FINAL argv element — array argv, never a shell (B4)', async () => {
    let seen: { bin: string; args: string[] } | null = null;
    const p = cliJudgeProvider({
      id: 'kimi',
      bin: 'C:/nodejs/node.exe',
      args: ['C:/kimi/main.mjs', '-p'],
      execFn: async (bin, args) => {
        seen = { bin, args };
        return VALID;
      },
    });
    await p.invoke('judge this && echo pwned');
    expect(seen!.bin).toBe('C:/nodejs/node.exe');
    expect(seen!.args).toEqual(['C:/kimi/main.mjs', '-p', 'judge this && echo pwned']);
  });
});

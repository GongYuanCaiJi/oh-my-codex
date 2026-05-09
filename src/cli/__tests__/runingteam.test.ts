import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runingTeamCommand } from '../runingteam.js';
import { writeCriticVerdict, writeFinalSynthesis } from '../../runingteam/runtime.js';

async function captureRuningTeam(args: string[], cwd: string): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...values: unknown[]) => logs.push(values.map(String).join(' '));
    await runingTeamCommand(args, cwd);
    return logs;
  } finally {
    console.log = originalLog;
  }
}

describe('runingteam CLI', () => {
  it('creates a direct first-class session without invoking team or ralplan commands', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runingteam-cli-'));
    try {
      const logs = await captureRuningTeam(['two', 'lane', 'fixture'], cwd);
      assert.match(logs.join('\n'), /RuningTeam session created: runingteam-/);
      const status = await captureRuningTeam(['status', '--json'], cwd);
      const parsed = JSON.parse(status.join('\n')) as { sessions: Array<{ status: string; plan_version: number }> };
      assert.equal(parsed.sessions.length, 1);
      assert.equal(parsed.sessions[0]?.status, 'planning');
      assert.equal(parsed.sessions[0]?.plan_version, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses finalize until final-synthesis.md exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runingteam-finalize-'));
    try {
      const logs = await captureRuningTeam(['finalize fixture'], cwd);
      const sessionId = /RuningTeam session created: (\S+)/.exec(logs.join('\n'))?.[1];
      assert.ok(sessionId);
      await assert.rejects(captureRuningTeam(['finalize', sessionId], cwd), /final-synthesis\.md/);
      await writeFinalSynthesis(cwd, sessionId, '# Final synthesis\n\nReady.');
      await assert.rejects(captureRuningTeam(['finalize', sessionId], cwd), /FINAL_SYNTHESIS_READY/);
      await writeCriticVerdict(cwd, sessionId, {
        iteration: 0,
        verdict: 'FINAL_SYNTHESIS_READY',
        acceptance_criteria_evidence: { ready: ['final synthesis'] },
        created_at: new Date().toISOString(),
      });
      const finalized = await captureRuningTeam(['finalize', sessionId], cwd);
      assert.match(finalized.join('\n'), /RuningTeam complete/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

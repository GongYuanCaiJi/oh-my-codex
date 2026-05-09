import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCheckpoint,
  createRuningTeamSession,
  ingestTeamEvidence,
  linkRuningTeamTeamAdapter,
  readRuningTeamSession,
  revisePlan,
  runingTeamPaths,
  transitionRuningTeamSession,
  validateCriticVerdictRecord,
  validatePlannerRevision,
  validateRuningTeamSession,
  writeCriticVerdict,
  writeFinalSynthesis,
} from '../runtime.js';
import { appendTeamEvent, initTeamState } from '../../team/state.js';

async function withTempRoot<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-runingteam-runtime-'));
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  try {
    return await fn(cwd);
  } finally {
    if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
    else delete process.env.OMX_TEAM_STATE_ROOT;
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('RuningTeam runtime contracts', () => {
  it('creates first-class session state and rejects completion without final-synthesis.md', async () => {
    await withTempRoot(async (cwd) => {
      const session = await createRuningTeamSession('two lane fixture task', cwd, { sessionId: 'rt-final-gate' });
      assert.equal(session.status, 'planning');
      assert.equal(session.plan_version, 1);
      assert.equal(session.team_name, null);

      await assert.rejects(
        transitionRuningTeamSession(cwd, session.session_id, 'complete'),
        /complete_requires_final_synthesis/,
      );

      await writeFinalSynthesis(cwd, session.session_id, '# Final synthesis\n\nAll evidence is supported.');
      const complete = await transitionRuningTeamSession(cwd, session.session_id, 'complete');
      assert.equal(complete.status, 'complete');
    });
  });

  it('validates schema enums and verdict/revision guardrails', () => {
    assert.throws(
      () => validateRuningTeamSession({ session_id: 's', task: 't', created_at: 'n', updated_at: 'n', status: 'bogus', iteration: 0, plan_version: 1, team_name: null, max_iterations: 10, terminal_reason: null }),
      /invalid_status/,
    );
    assert.throws(
      () => validateCriticVerdictRecord({ iteration: 1, verdict: 'ITERATE_PLAN', created_at: 'now' }),
      /required_changes/,
    );
    assert.throws(
      () => validateCriticVerdictRecord({ iteration: 1, verdict: 'FINAL_SYNTHESIS_READY', created_at: 'now' }),
      /acceptance_criteria_evidence/,
    );
    assert.throws(
      () => validatePlannerRevision({ iteration: 1, from_plan_version: 1, to_plan_version: 2, reason: 'r', changes: ['c'], preserved_acceptance_criteria: false, created_at: 'now' }),
      /preserved_acceptance_criteria/,
    );
  });

  it('ingests team events once, checkpoints evidence, and revises only after checkpoint plus verdict', async () => {
    await withTempRoot(async (cwd) => {
      await initTeamState('rt-team', 'fixture team', 'executor', 2, cwd);
      const session = await createRuningTeamSession('two lane fixture task', cwd, { sessionId: 'rt-e2e' });
      await linkRuningTeamTeamAdapter(cwd, session.session_id, {
        team_name: 'rt-team',
        cursor: '',
        lane_task_map: { tests: '1', implementation: '2' },
        evidence_guarantee: 'active',
      });

      await appendTeamEvent('rt-team', {
        type: 'task_completed',
        worker: 'worker-1',
        task_id: '1',
        reason: 'RED evidence emitted',
        metadata: { files_changed: ['src/runingteam/__tests__/runtime.test.ts'], commands: ['node --test'], tests: ['runtime.test.ts'] },
      }, cwd);
      const first = await ingestTeamEvidence(cwd, session.session_id);
      const second = await ingestTeamEvidence(cwd, session.session_id);
      assert.equal(first.length, 1);
      assert.equal(second.length, 0, 'stable cursor deduplicates already ingested events');

      const checkpoint = await createCheckpoint(cwd, session.session_id);
      assert.equal(checkpoint.iteration, 1);
      assert.deepEqual(checkpoint.evidence_ids, [first[0]?.evidence_id]);

      await assert.rejects(
        revisePlan(cwd, session.session_id, {
          iteration: 2,
          from_plan_version: 1,
          to_plan_version: 2,
          reason: 'missing checkpoint',
          changes: ['next batch'],
          preserved_acceptance_criteria: true,
          created_at: new Date().toISOString(),
        }),
        /revision_requires_checkpoint/,
      );

      await writeCriticVerdict(cwd, session.session_id, {
        iteration: 1,
        verdict: 'ITERATE_PLAN',
        required_changes: ['capture passing implementation evidence'],
        created_at: new Date().toISOString(),
      });
      const revised = await revisePlan(cwd, session.session_id, {
        iteration: 1,
        from_plan_version: 1,
        to_plan_version: 2,
        reason: 'critic requested iteration',
        changes: ['next implementation batch'],
        preserved_acceptance_criteria: true,
        created_at: new Date().toISOString(),
      });
      assert.equal(revised.plan_version, 2);
      assert.equal((await readRuningTeamSession(cwd, session.session_id)).plan_version, 2);
    });
  });

  it('simulates two-lane E2E through final synthesis completion', async () => {
    await withTempRoot(async (cwd) => {
      await initTeamState('rt-e2e-team', 'fixture team', 'executor', 2, cwd);
      const session = await createRuningTeamSession('two lane fixture task', cwd, { sessionId: 'rt-full-smoke' });
      await linkRuningTeamTeamAdapter(cwd, session.session_id, {
        team_name: 'rt-e2e-team',
        cursor: '',
        lane_task_map: { tests: '1', implementation: '2' },
        evidence_guarantee: 'active',
      });

      await appendTeamEvent('rt-e2e-team', { type: 'task_completed', worker: 'worker-1', task_id: '1', reason: 'tests lane RED', metadata: { commands: ['npm test'], tests: ['runingteam runtime'] } }, cwd);
      await ingestTeamEvidence(cwd, session.session_id);
      await createCheckpoint(cwd, session.session_id);
      await writeCriticVerdict(cwd, session.session_id, { iteration: 1, verdict: 'APPROVE_NEXT_BATCH', created_at: new Date().toISOString() });

      await appendTeamEvent('rt-e2e-team', { type: 'task_failed', worker: 'worker-2', task_id: '2', reason: 'implementation failed tests', metadata: { commands: ['npm test'], tests: ['failing runingteam runtime'] } }, cwd);
      await ingestTeamEvidence(cwd, session.session_id);
      await createCheckpoint(cwd, session.session_id);
      await writeCriticVerdict(cwd, session.session_id, { iteration: 2, verdict: 'ITERATE_PLAN', required_changes: ['fix implementation evidence'], created_at: new Date().toISOString() });
      await revisePlan(cwd, session.session_id, { iteration: 2, from_plan_version: 1, to_plan_version: 2, reason: 'failed implementation evidence', changes: ['rerun implementation lane'], preserved_acceptance_criteria: true, created_at: new Date().toISOString() });

      await appendTeamEvent('rt-e2e-team', { type: 'task_completed', worker: 'worker-2', task_id: '2', reason: 'implementation passing', metadata: { commands: ['npm test'], tests: ['passing runingteam runtime'] } }, cwd);
      await ingestTeamEvidence(cwd, session.session_id);
      await createCheckpoint(cwd, session.session_id);
      await writeCriticVerdict(cwd, session.session_id, { iteration: 3, verdict: 'FINAL_SYNTHESIS_READY', acceptance_criteria_evidence: { 'final synthesis is created before completion': ['worker-1', 'worker-2'] }, created_at: new Date().toISOString() });
      await writeFinalSynthesis(cwd, session.session_id, '# Final synthesis\n\nTwo-lane fixture completed.');
      const complete = await transitionRuningTeamSession(cwd, session.session_id, 'complete');
      assert.equal(complete.status, 'complete');
      assert.equal(existsSync(runingTeamPaths(cwd, session.session_id).finalSynthesis), true);
    });
  });

  it('preserves omx team state when RuningTeam is inactive', async () => {
    await withTempRoot(async (cwd) => {
      await initTeamState('plain-team', 'plain team task', 'executor', 1, cwd);
      const teamConfigPath = join(cwd, '.omx', 'state', 'team', 'plain-team', 'config.json');
      const before = await readFile(teamConfigPath, 'utf-8');
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      const sessions = await import('../runtime.js').then((m) => m.listRuningTeamSessions(cwd));
      assert.deepEqual(sessions, []);
      const after = await readFile(teamConfigPath, 'utf-8');
      assert.equal(after, before);
    });
  });
});

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  createCheckpoint,
  createRuningTeamSession,
  ingestTeamEvidence,
  listRuningTeamSessions,
  readRuningTeamSession,
  runingTeamPaths,
  assertRuningTeamCompletionReady,
  transitionRuningTeamSession,
  updateRuningTeamSession,
  writeFinalSynthesis,
} from '../runingteam/runtime.js';

export const RUNINGTEAM_HELP = `
Usage: omx runingteam "<task>"
       omx runingteam status <session> [--json]
       omx runingteam checkpoint <session> [--force]
       omx runingteam revise <session>
       omx runingteam finalize <session>
       omx runingteam cancel <session>

RuningTeam is a first-class dynamic planning controller. It owns session state,
checkpoint evidence, critic/planner loops, and the final-synthesis completion gate.
`;

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function requireSession(args: string[]): string {
  const session = args.find((arg) => !arg.startsWith('--'));
  if (!session) throw new Error('Missing RuningTeam session id');
  return session;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runingTeamCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    console.log(RUNINGTEAM_HELP.trim());
    return;
  }

  if (subcommand === 'status') {
    const json = hasFlag(args, '--json');
    const sessionId = args[1]?.startsWith('--') ? undefined : args[1];
    if (sessionId) {
      const session = await readRuningTeamSession(cwd, sessionId);
      const summary = {
        ...session,
        final_synthesis_present: existsSync(runingTeamPaths(cwd, sessionId).finalSynthesis),
      };
      if (json) printJson(summary);
      else console.log(`${summary.session_id}: ${summary.status} iteration=${summary.iteration} plan=${summary.plan_version} team=${summary.team_name ?? '-'}`);
      return;
    }
    const sessions = await listRuningTeamSessions(cwd);
    if (json) printJson({ sessions });
    else if (sessions.length === 0) console.log('No RuningTeam sessions.');
    else for (const session of sessions) console.log(`${session.session_id}: ${session.status} iteration=${session.iteration} plan=${session.plan_version}`);
    return;
  }

  if (subcommand === 'checkpoint') {
    const sessionId = requireSession(args.slice(1));
    await ingestTeamEvidence(cwd, sessionId).catch(() => []);
    const checkpoint = await createCheckpoint(cwd, sessionId, { force: hasFlag(args, '--force') });
    console.log(`RuningTeam checkpoint ${checkpoint.iteration} created for ${sessionId}`);
    return;
  }

  if (subcommand === 'revise') {
    const sessionId = requireSession(args.slice(1));
    await updateRuningTeamSession(cwd, sessionId, { status: 'revising' });
    console.log(`RuningTeam revision gate opened for ${sessionId}`);
    return;
  }

  if (subcommand === 'finalize') {
    const sessionId = requireSession(args.slice(1));
    const paths = runingTeamPaths(cwd, sessionId);
    try {
      await assertRuningTeamCompletionReady(cwd, sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'complete_requires_final_synthesis') {
        throw new Error('RuningTeam cannot complete without final-synthesis.md');
      }
      if (message === 'complete_requires_final_synthesis_ready_verdict') {
        throw new Error('RuningTeam cannot complete without FINAL_SYNTHESIS_READY verdict evidence');
      }
      throw err;
    }
    await transitionRuningTeamSession(cwd, sessionId, 'complete');
    const synthesis = await readFile(paths.finalSynthesis, 'utf-8');
    console.log(`RuningTeam complete: ${sessionId}\n${synthesis.trimEnd()}`);
    return;
  }

  if (subcommand === 'cancel') {
    const sessionId = requireSession(args.slice(1));
    await updateRuningTeamSession(cwd, sessionId, { status: 'cancelled', terminal_reason: 'cancelled by user' });
    console.log(`RuningTeam cancelled: ${sessionId}`);
    return;
  }

  const task = args.join(' ').trim();
  if (!task) throw new Error('Missing RuningTeam task');
  const session = await createRuningTeamSession(task, cwd);
  console.log(`RuningTeam session created: ${session.session_id}`);
  console.log(`State: ${runingTeamPaths(cwd, session.session_id).root}`);
}

export { writeFinalSynthesis };

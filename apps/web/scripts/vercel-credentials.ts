import { readFileSync } from 'node:fs';

/** Resolve Vercel project credentials from env (preferred) or the linked `.vercel/project.json`; throws if project/team/token are missing. Returns plain `string`s so callers see non-undefined types. Shared by the firewall scripts. */
export function resolveVercelCredentials(): {
  projectId: string;
  teamId: string;
  token: string;
} {
  let link: { projectId?: string; orgId?: string } = {};
  try {
    link = JSON.parse(
      readFileSync(new URL('../.vercel/project.json', import.meta.url), 'utf8'),
    );
  } catch {
    // .vercel/project.json is gitignored / absent on fresh clones & CI — fall back to env.
  }
  const projectId = process.env.VERCEL_PROJECT_ID ?? link.projectId;
  const teamId = process.env.VERCEL_TEAM_ID ?? link.orgId;
  const token = process.env.VERCEL_TOKEN;
  if (!projectId || !teamId) {
    throw new Error(
      'projectId/teamId not found — run `vercel link` or set VERCEL_PROJECT_ID + VERCEL_TEAM_ID',
    );
  }
  if (!token) {
    throw new Error(
      'VERCEL_TOKEN not set — create one at https://vercel.com/account/tokens',
    );
  }
  return { projectId, teamId, token };
}

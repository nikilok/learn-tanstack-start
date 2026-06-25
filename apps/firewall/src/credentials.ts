import { readFileSync } from 'node:fs';

/** Resolve Vercel credentials for the project this tool manages (the SponsorSearch web app). Prefers env (VERCEL_PROJECT_ID/TEAM_ID/TOKEN from the repo-root .env.local); falls back to the web app's `vercel link` for the project/team ids. Throws if any are missing. Returns plain `string`s so callers see non-undefined types. */
export function resolveVercelCredentials(): {
  projectId: string;
  teamId: string;
  token: string;
} {
  let link: { projectId?: string; orgId?: string } = {};
  try {
    // This tool manages the web app's WAF, so it reads the web app's Vercel link for the project/team ids.
    link = JSON.parse(
      readFileSync(
        new URL('../../web/.vercel/project.json', import.meta.url),
        'utf8',
      ),
    );
  } catch {
    // absent on fresh clones / CI — rely on the VERCEL_* env vars instead.
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

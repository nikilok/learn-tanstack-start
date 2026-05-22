/**
 * GET /.well-known/vercel/flags
 *
 * Discovery endpoint queried by the Vercel Flags Explorer (inside the Vercel
 * Toolbar) so it can render our flag definitions as overridable toggles. Not
 * called by our own code — purely an external contract with Vercel's toolbar.
 *
 * Auth: Authorization header signed with FLAGS_SECRET (verifyAccess). Any
 * non-toolbar caller gets 401.
 */
import { verifyAccess, version } from 'flags';
import { defineEventHandler } from 'h3';

import { flags } from '#/flags.server';

export default defineEventHandler(async (event) => {
  const auth = event.req.headers.get('authorization') ?? undefined;
  const access = await verifyAccess(auth);
  if (!access) {
    return new Response(null, { status: 401 });
  }

  const definitions = Object.fromEntries(
    Object.values(flags).map((spec) => [
      spec.key,
      {
        description: spec.description,
        defaultValue: spec.defaultValue,
        options: spec.options,
      },
    ]),
  );

  return new Response(JSON.stringify({ definitions }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-flags-sdk-version': version,
    },
  });
});

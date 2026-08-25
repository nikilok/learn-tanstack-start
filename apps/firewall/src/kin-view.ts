// Rendering the build-line report. Pure, so the case that matters is exercisable without traffic.

import {
  BROWSER_SHARE,
  type KinFamily,
  type KinMember,
  type KinReport,
  candidates,
} from './kin-report';
import { type Line, blank, line, seg } from './line-model';

/** What a member's rendering share says, in the operator's terms rather than a number alone. */
function reading(m: KinMember): { text: string; tone: 'bad' | 'good' | 'dim' } {
  if (m.verified) return { text: 'verified crawler', tone: 'good' };
  if (m.renderShare > BROWSER_SHARE)
    return { text: 'renders — a browser ran the app', tone: 'good' };
  return { text: 'renders nothing', tone: 'bad' };
}

function memberLines(f: KinFamily): Line[] {
  if (!f.members.length)
    return [line(seg('    no traffic in this window', 'dim'))];
  return f.members.map((m) => {
    const r = reading(m);
    const mark = m.standing ? `[${m.standing}]` : '';
    return line(
      seg(`    ${m.digest}`, m.standing ? 'dim' : 'bold'),
      seg(`  ${String(m.requests).padStart(6)} req`, 'dim'),
      seg(`  ${(m.renderShare * 100).toFixed(1).padStart(5)}% `, 'dim'),
      seg(` ${r.text}`, r.tone),
      mark ? seg(`  ${mark}`, 'dim') : seg(''),
    );
  });
}

/** The whole report as lines. */
export function kinLines(r: KinReport): Line[] {
  const L: Line[] = [
    line(
      seg(
        'Build lines — what shares a TLS build with something we acted on',
        'bold',
      ),
      seg(
        `  (${r.window.fromISO.slice(0, 16)}Z → ${r.window.toISO.slice(0, 16)}Z)`,
        'dim',
      ),
    ),
  ];
  // Before the zero is reported, because an unread list is why the zero might be there. Saying
  // "nothing is denied" on the strength of a config we failed to read is a claim about the WAF.
  for (const u of r.unreadable)
    L.push(line(seg(`  could not read ${u}`, 'bad')));
  if (!r.listed) {
    L.push(
      blank(),
      line(
        seg(
          r.unreadable.length
            ? 'no build line can be followed — the lists above could not be read, so this is not "nothing is listed"'
            : 'nothing is denied or challenged, so there is no build line to follow',
          'warn',
        ),
      ),
    );
    return L;
  }
  if (!r.complete)
    L.push(
      line(
        seg(
          '  a sample hit the group cap — a member, its rendering, or the proof that it is a verified crawler may be missing',
          'warn',
        ),
      ),
    );
  L.push(
    blank(),
    line(
      `${r.listed} listed identit(ies) across ${r.families.length} build line(s)`,
    ),
  );
  for (const f of r.families) {
    L.push(blank());
    L.push(
      line(
        seg(`  ${f.family}_*`, 'bold'),
        seg(`  ${f.members.length} member(s) seen`, 'dim'),
      ),
    );
    // Said once per line, not per digest. A denied member contributes no rows at all, so every
    // share below it is measured on traffic that survived our own mitigation.
    if (f.standing === 'denied')
      L.push(
        line(
          seg(
            '    a member of this line is DENIED — its traffic never reaches routing, so the shares below cannot see it',
            'warn',
          ),
        ),
      );
    else
      L.push(
        line(
          seg(
            '    a member of this line is CHALLENGED — a browser that meets the interstitial renders nothing, so a low share here may be ours',
            'warn',
          ),
        ),
      );
    L.push(...memberLines(f));
  }
  const unlisted = candidates(r);
  L.push(blank());
  // Three states, not two. On a capped sample a count of zero would mean "nobody to look at" when
  // it can equally mean the rows saying so never arrived.
  L.push(
    line(
      seg(
        !r.complete
          ? `${unlisted.length} member(s) not yet acted on — but the sample was capped, so treat that as a floor`
          : unlisted.length
            ? `${unlisted.length} member(s) not yet acted on — profile with: bun run firewall:ip <digest>`
            : 'every member of every line is already listed or verified',
        !r.complete || unlisted.length ? 'warn' : 'good',
      ),
    ),
  );
  return L;
}

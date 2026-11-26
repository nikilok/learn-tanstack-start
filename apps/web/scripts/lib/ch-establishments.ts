/**
 * The two Companies House reads a move makes before it writes: the
 * establishments listed under an overseas company, and a company's profile.
 * A 404 is an answer; any other failure is a throw, never an empty answer.
 */

import type { ChFetch } from '../../src/lib/hmrc-ch/ch-lookup.ts';
import type { MoveWrites } from '../../src/lib/hmrc-ch/establishment-move.ts';
import { listedEstablishments } from '../../src/lib/hmrc-ch/uk-establishment.ts';
import type { CHFullProfile } from '../../src/lib/phase5/decide.ts';

/** A Companies House call that failed without saying anything about the company, named by its status. */
export class ChStatus extends Error {
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = `HTTP ${status}`;
  }
}

/** An answer from Companies House that is not of the shape asked for, so says nothing about the company. */
export class ChUnreadable extends Error {
  constructor() {
    super('unreadable answer');
    this.name = 'unreadable answer';
  }
}

/** A move's reads over the given Companies House fetch. */
export function makeEstablishmentReads(
  askCh: ChFetch,
): Pick<MoveWrites, 'fetchEstablishments' | 'fetchProfile'> {
  return {
    fetchEstablishments: async (companyNumber) => {
      const res = await askCh(
        `/company/${encodeURIComponent(companyNumber)}/uk-establishments`,
      );
      if (res.ok) {
        const listed = listedEstablishments(res.data);
        if (listed === null) throw new ChUnreadable();
        return listed;
      }
      // A 404 is a company with no establishment listed.
      if (res.status === 404) return [];
      throw new ChStatus(res.status);
    },
    fetchProfile: async (companyNumber) => {
      const res = await askCh(`/company/${encodeURIComponent(companyNumber)}`);
      if (res.ok) return res.data as CHFullProfile;
      if (res.status === 404) return null;
      throw new ChStatus(res.status);
    },
  };
}

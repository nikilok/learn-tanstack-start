import { describe, expect, test } from 'bun:test';

import { companyWebsites } from '@ss/db/schema';
import { drizzle } from 'drizzle-orm/pg-proxy';

import { upgradeOnlyPredicateSql } from './decide';
import type { RegistryWrite } from './registry-import';
import { makeWriteRegistryRows } from './registry-import-sql';

type Db = Parameters<typeof makeWriteRegistryRows>[0];

const write = (over: Partial<RegistryWrite> = {}): RegistryWrite => ({
  companyNumber: '09990117',
  url: 'https://www.quillmere.co.uk',
  status: 'verified',
  evidence: 'registry',
  confidence: '0.950',
  source: 'cqc',
  verifiedAt: new Date('2026-11-16T12:00:00Z'),
  ...over,
});

/** A database that records each statement as it would be sent, and answers with the rows given. */
function recordingDb(applied: string[] = []) {
  const statements: { text: string; params: unknown[] }[] = [];
  const db = drizzle(async (text, params) => {
    statements.push({ text: text.replace(/\s+/g, ' '), params });
    return { rows: applied.map((companyNumber) => [companyNumber]) };
  }) as unknown as Db;
  return { db, statements };
}

/** The assignment a statement makes to one column on conflict. */
function assigned(text: string, column: string): string | undefined {
  const set = text.slice(text.indexOf(' do update set ') + 15);
  return new RegExp(`"${column}" = (.*?)(?:, "|\\s+where )`).exec(set)?.[1];
}

describe('makeWriteRegistryRows', () => {
  test('inserts the batch in one statement, keyed on the company number', async () => {
    const { db, statements } = recordingDb(['09990117', '09990118']);
    await makeWriteRegistryRows(db)([
      write(),
      write({ companyNumber: '09990118', url: 'https://hestwick.co.uk' }),
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0].text).toStartWith('insert into "company_websites" (');
    expect(statements[0].text).toContain(
      ' on conflict ("company_number") do update set ',
    );
    expect(statements[0].params).toContain('https://hestwick.co.uk');
  });

  test('what the register says replaces what the row said', async () => {
    const { db, statements } = recordingDb();
    await makeWriteRegistryRows(db)([write()]);
    for (const column of [
      'url',
      'status',
      'evidence',
      'confidence',
      'source',
      'verified_at',
    ]) {
      expect(assigned(statements[0].text, column)).toBe(`excluded.${column}`);
    }
  });

  test('everything that describes the address is reset when the address changes, and kept when it does not', async () => {
    // The walk marker was left out once: a site the register moved read as already walked.
    const { db, statements } = recordingDb();
    await makeWriteRegistryRows(db)([write()]);
    const resets: [column: { name: string }, reset: string][] = [
      [companyWebsites.checkedAt, 'NULL'],
      [companyWebsites.failureCount, '0'],
      [companyWebsites.evidenceUrl, 'NULL'],
      [companyWebsites.walkVersion, 'NULL'],
      [companyWebsites.walkAttempts, '0'],
      [companyWebsites.walkedAt, 'NULL'],
    ];
    for (const [{ name }, reset] of resets) {
      expect(assigned(statements[0].text, name)).toBe(
        `CASE WHEN company_websites.url IS DISTINCT FROM excluded.url THEN ${reset} ELSE company_websites.${name} END`,
      );
    }
  });

  test('assigns no other column, so nothing else of the row is touched', async () => {
    const { db, statements } = recordingDb();
    await makeWriteRegistryRows(db)([write()]);
    const set = statements[0].text.slice(
      statements[0].text.indexOf(' do update set ') + 15,
      statements[0].text.indexOf(' where '),
    );
    expect([...set.matchAll(/"(\w+)" = /g)].map((m) => m[1]).sort()).toEqual([
      'checked_at',
      'confidence',
      'evidence',
      'evidence_url',
      'failure_count',
      'source',
      'status',
      'url',
      'verified_at',
      'walk_attempts',
      'walk_version',
      'walked_at',
    ]);
  });

  test('is an upgrade only, by the ladder decideWebsite applies', async () => {
    const { db, statements } = recordingDb();
    await makeWriteRegistryRows(db)([write()]);
    expect(statements[0].text).toContain(
      ` where ${upgradeOnlyPredicateSql()} returning "company_number"`,
    );
  });

  test('counts the rows the guard let through, not the rows sent', async () => {
    const { db } = recordingDb(['09990117']);
    const applied = await makeWriteRegistryRows(db)([
      write(),
      write({ companyNumber: '09990118' }),
    ]);
    expect(applied).toBe(1);
  });

  test('an empty batch sends nothing', async () => {
    const { db, statements } = recordingDb();
    expect(await makeWriteRegistryRows(db)([])).toBe(0);
    expect(statements).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';

import { collectSicCodes, curateTimeline, TRACKING_SINCE } from './curate.ts';
import type { TimelineEvent, TrailRow } from './types.ts';

const row = (over: Partial<TrailRow> = {}): TrailRow => ({
  columnName: 'postalCode',
  oldValue: 'AA1 1AA',
  newValue: 'BB2 2BB',
  createdAt: '2026-06-08 10:01:07.263411',
  publishedAt: null,
  ...over,
});

const curate = (
  rows: TrailRow[],
  over: Partial<Parameters<typeof curateTimeline>[0]> = {},
) =>
  curateTimeline({
    rows,
    dateOfCreation: '2016-02-03',
    sicDescriptions: new Map(),
    ...over,
  });

const changes = (events: TimelineEvent[]) =>
  events.filter(
    (e) => e.kind !== 'tracking-start' && e.kind !== 'incorporated',
  );

describe('grouping', () => {
  test('same created_at rows collapse into one event', () => {
    const events = changes(
      curate([
        row({ columnName: 'postalCode' }),
        row({
          columnName: 'locality',
          oldValue: 'Maldon',
          newValue: 'Reading',
        }),
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Registered address changed');
  });

  test('different created_at days produce separate events', () => {
    const events = changes(
      curate([
        row({ createdAt: '2026-06-01 10:00:00.000001' }),
        row({
          createdAt: '2026-06-02 10:00:00.000001',
          oldValue: 'BB2 2BB',
          newValue: 'CC3 3CC',
        }),
      ]),
    );
    expect(events).toHaveLength(2);
  });
});

describe('mixed-group split', () => {
  test('one CH event touching four categories yields four events', () => {
    const ts = '2026-06-08 07:27:11.852734';
    const events = changes(
      curate([
        row({
          columnName: 'accountsLastMadeUpTo',
          createdAt: ts,
          oldValue: '2024-12-31',
          newValue: '2025-12-31',
        }),
        row({
          columnName: 'accountsNextMadeUpTo',
          createdAt: ts,
          oldValue: '2025-12-31',
          newValue: '2026-12-31',
        }),
        row({
          columnName: 'addressLine1',
          createdAt: ts,
          oldValue: 'Old House',
          newValue: 'New House',
        }),
        row({
          columnName: 'companyStatus',
          createdAt: ts,
          oldValue: 'active',
          newValue: 'administration',
        }),
        row({
          columnName: 'hasInsolvencyHistory',
          createdAt: ts,
          oldValue: 'false',
          newValue: 'true',
        }),
      ]),
    );
    expect(events.map((e) => e.kind).sort()).toEqual([
      'accounts',
      'address',
      'insolvency',
      'status',
    ]);
  });
});

describe('accounts folding', () => {
  test('filing with deadline recalc folds into one positive event', () => {
    const ts = '2026-05-12 09:00:00.000001';
    const events = changes(
      curate([
        row({
          columnName: 'accountsLastMadeUpTo',
          createdAt: ts,
          oldValue: null,
          newValue: '2025-12-31',
        }),
        row({
          columnName: 'accountsNextMadeUpTo',
          createdAt: ts,
          oldValue: '2025-12-31',
          newValue: '2026-12-31',
        }),
        row({
          columnName: 'accountsOverdue',
          createdAt: ts,
          oldValue: 'true',
          newValue: 'false',
        }),
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Annual accounts filed');
    expect(events[0].detail).toBe('Made up to 31 December 2025');
    expect(events[0].tone).toBe('positive');
  });

  test('deadline-recalc-only group is suppressed', () => {
    const events = changes(
      curate([
        row({
          columnName: 'accountsNextMadeUpTo',
          oldValue: '2025-12-31',
          newValue: '2026-12-31',
        }),
      ]),
    );
    expect(events).toHaveLength(0);
  });

  test('overdue flag alone maps to warning / cleared', () => {
    const overdue = changes(
      curate([
        row({
          columnName: 'accountsOverdue',
          oldValue: 'false',
          newValue: 'true',
        }),
      ]),
    );
    expect(overdue[0].title).toBe('Annual accounts overdue');
    expect(overdue[0].tone).toBe('warning');

    const cleared = changes(
      curate([
        row({
          columnName: 'accountsOverdue',
          oldValue: 'true',
          newValue: 'false',
        }),
      ]),
    );
    expect(cleared[0].title).toBe('Accounts overdue flag cleared');
    expect(cleared[0].tone).toBe('positive');
  });
});

describe('net-zero same-day collapse', () => {
  const maldon = (ts: string): TrailRow[] => [
    row({
      columnName: 'addressLine1',
      createdAt: ts,
      oldValue: 'Unit 8',
      newValue: 'Stud Farm',
    }),
    row({
      columnName: 'locality',
      createdAt: ts,
      oldValue: 'Reading',
      newValue: 'Maldon',
    }),
    row({
      columnName: 'postalCode',
      createdAt: ts,
      oldValue: 'RG1 2AN',
      newValue: 'CM9 6PN',
    }),
  ];
  const reading = (ts: string): TrailRow[] => [
    row({
      columnName: 'addressLine1',
      createdAt: ts,
      oldValue: 'Stud Farm',
      newValue: 'Unit 8',
    }),
    row({
      columnName: 'locality',
      createdAt: ts,
      oldValue: 'Maldon',
      newValue: 'Reading',
    }),
    row({
      columnName: 'postalCode',
      createdAt: ts,
      oldValue: 'CM9 6PN',
      newValue: 'RG1 2AN',
    }),
  ];

  test('A→B→A→B flip-flop in one day nets to a single A→B event', () => {
    const events = changes(
      curate([
        ...reading('2026-06-08 10:01:07.263411'),
        ...maldon('2026-06-08 10:54:17.100234'),
        ...reading('2026-06-08 10:54:25.247631'),
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0].from).toBe('Stud Farm, Maldon, CM9 6PN');
    expect(events[0].to).toBe('Unit 8, Reading, RG1 2AN');
  });

  test('pure A→B→A day drops entirely', () => {
    const events = changes(
      curate([
        ...reading('2026-06-08 10:01:07.263411'),
        ...maldon('2026-06-08 11:30:00.000001'),
      ]),
    );
    expect(events).toHaveLength(0);
  });

  test('the same reversal across midnight stays two events', () => {
    const events = changes(
      curate([
        ...reading('2026-06-08 23:59:00.000001'),
        ...maldon('2026-06-09 00:01:00.000001'),
      ]),
    );
    expect(events).toHaveLength(2);
  });

  test('collapse keys on the published day, not the ingestion day', () => {
    // Replay after downtime: ingested on different days, published same day.
    const events = changes(
      curate([
        ...reading('2026-06-10 09:00:00.000001').map((r) => ({
          ...r,
          publishedAt: '2026-06-08 10:01:07',
        })),
        ...maldon('2026-06-11 09:00:00.000001').map((r) => ({
          ...r,
          publishedAt: '2026-06-08 10:54:17',
        })),
      ]),
    );
    expect(events).toHaveLength(0);
  });
});

describe('address composition', () => {
  test('joins available fields in canonical order, skipping nulls per side', () => {
    const ts = '2026-06-08 10:01:07.263411';
    const events = changes(
      curate([
        row({
          columnName: 'addressLine1',
          createdAt: ts,
          oldValue: 'Stud Farm Mundon Road',
          newValue: 'Unit 8  The Aquarium Building',
        }),
        row({
          columnName: 'addressLine2',
          createdAt: ts,
          oldValue: 'Mundon',
          newValue: 'King Street',
        }),
        row({
          columnName: 'locality',
          createdAt: ts,
          oldValue: 'Maldon',
          newValue: 'Reading',
        }),
        row({
          columnName: 'region',
          createdAt: ts,
          oldValue: null,
          newValue: 'Berkshire',
        }),
        row({
          columnName: 'postalCode',
          createdAt: ts,
          oldValue: 'CM9 6PN',
          newValue: 'RG1 2AN',
        }),
        row({
          columnName: 'country',
          createdAt: ts,
          oldValue: 'England',
          newValue: null,
        }),
      ]),
    );
    expect(events[0].from).toBe(
      'Stud Farm Mundon Road, Mundon, Maldon, CM9 6PN, England',
    );
    expect(events[0].to).toBe(
      'Unit 8  The Aquarium Building, King Street, Reading, Berkshire, RG1 2AN',
    );
  });

  test('partial change renders the changed fields only', () => {
    const events = changes(curate([row()]));
    expect(events[0].from).toBe('AA1 1AA');
    expect(events[0].to).toBe('BB2 2BB');
  });

  test('address appearing from nothing reads as recorded', () => {
    const events = changes(
      curate([row({ oldValue: null, newValue: 'BB2 2BB' })]),
    );
    expect(events[0].title).toBe('Registered address recorded');
    expect(events[0].detail).toBe('BB2 2BB');
  });

  test('a value shuffled between address columns is suppressed as a no-op', () => {
    const ts = '2026-06-25 10:00:00.000001';
    const events = changes(
      curate([
        row({
          columnName: 'addressLine2',
          createdAt: ts,
          oldValue: 'Maldon',
          newValue: null,
        }),
        row({
          columnName: 'locality',
          createdAt: ts,
          oldValue: null,
          newValue: 'Maldon',
        }),
      ]),
    );
    expect(events).toHaveLength(0);
  });

  test('address cleared to nothing reads as removed, not an empty arrow', () => {
    const events = changes(
      curate([row({ oldValue: 'BB2 2BB', newValue: null })]),
    );
    expect(events[0].title).toBe('Registered address removed');
    expect(events[0].detail).toBe('BB2 2BB');
    expect(events[0].from).toBeUndefined();
  });

  test('mappable only when both sides carry a postcode', () => {
    const withPostcode = changes(curate([row()]));
    expect(withPostcode[0].mappable).toBe(true);

    const lineOnly = changes(
      curate([
        row({ columnName: 'addressLine1', oldValue: 'Old', newValue: 'New' }),
      ]),
    );
    expect(lineOnly[0].mappable).toBeUndefined();

    const gained = changes(
      curate([row({ oldValue: null, newValue: 'BB2 2BB' })]),
    );
    expect(gained[0].mappable).toBeUndefined();
  });
});

describe('SIC changes', () => {
  test('added and removed codes render with descriptions, falling back to codes', () => {
    const events = changes(
      curate(
        [
          row({
            columnName: 'sicCodes',
            oldValue: '["62012","99999"]',
            newValue: '["62012","62020"]',
          }),
        ],
        { sicDescriptions: new Map([['62020', 'Business consultancy']]) },
      ),
    );
    expect(events[0].title).toBe('Industry classification updated');
    expect(events[0].detail).toBe('+ Business consultancy\n− 99999');
  });

  test('malformed JSON degrades to a title-only event', () => {
    const events = changes(
      curate([
        row({
          columnName: 'sicCodes',
          oldValue: 'not-json',
          newValue: 'also-bad',
        }),
      ]),
    );
    expect(events[0].title).toBe('Industry classification updated');
    expect(events[0].detail).toBeUndefined();
  });

  test('collectSicCodes gathers codes from both sides of sic rows only', () => {
    expect(
      collectSicCodes([
        row({
          columnName: 'sicCodes',
          oldValue: '["11111"]',
          newValue: '["22222"]',
        }),
        row({ columnName: 'locality', oldValue: '["33333"]', newValue: null }),
      ]).sort(),
    ).toEqual(['11111', '22222']);
  });
});

describe('renames', () => {
  test('a name entering previous_company_names reads as the given-up name', () => {
    const events = changes(
      curate([
        row({
          columnName: 'previousCompanyNames',
          oldValue: '[]',
          newValue: '["OLD NAME LTD"]',
        }),
      ]),
    );
    expect(events[0].title).toBe('Company renamed');
    expect(events[0].detail).toBe('Formerly Old Name LTD');
  });

  test('removal-only diffs are suppressed as CH data fixes', () => {
    const events = changes(
      curate([
        row({
          columnName: 'previousCompanyNames',
          oldValue: '["OLD NAME LTD"]',
          newValue: '[]',
        }),
      ]),
    );
    expect(events).toHaveLength(0);
  });
});

describe('flags, deletion, and unknown columns', () => {
  test('insolvency and liquidation flags carry negative tone', () => {
    const events = changes(
      curate([
        row({
          columnName: 'hasInsolvencyHistory',
          oldValue: 'false',
          newValue: 'true',
        }),
        row({
          columnName: 'hasBeenLiquidated',
          createdAt: '2026-06-09 10:00:00.000001',
          oldValue: null,
          newValue: 'true',
        }),
      ]),
    );
    expect(events.map((e) => [e.title, e.tone])).toEqual([
      ['Liquidation recorded', 'negative'],
      ['Insolvency history recorded', 'negative'],
    ]);
  });

  test('_deleted tombstone dates from its stored published_at', () => {
    const events = changes(
      curate([
        row({
          columnName: '_deleted',
          oldValue: null,
          newValue: '2026-06-20T14:00:00',
          createdAt: '2026-06-21 08:00:00.000001',
        }),
      ]),
    );
    expect(events[0].title).toBe('Removed from the Companies House register');
    expect(events[0].dateISO).toBe('2026-06-20');
    expect(events[0].tone).toBe('negative');
  });

  test('unknown future columns are suppressed, not mislabeled', () => {
    const events = changes(curate([row({ columnName: 'someFutureColumn' })]));
    expect(events).toHaveLength(0);
  });

  test('null→false flag rows are suppressed, never rendered as cleared', () => {
    const events = changes(
      curate([
        row({
          columnName: 'hasInsolvencyHistory',
          oldValue: null,
          newValue: 'false',
        }),
        row({
          columnName: 'hasCharges',
          createdAt: '2026-06-09 10:00:00.000001',
          oldValue: null,
          newValue: 'false',
        }),
        row({
          columnName: 'accountsOverdue',
          createdAt: '2026-06-10 10:00:00.000001',
          oldValue: null,
          newValue: 'false',
        }),
      ]),
    );
    expect(events).toHaveLength(0);
  });

  test('true→false flags still render as cleared', () => {
    const events = changes(
      curate([
        row({
          columnName: 'hasInsolvencyHistory',
          oldValue: 'true',
          newValue: 'false',
        }),
      ]),
    );
    expect(events[0].title).toBe('Insolvency history flag cleared');
  });

  test('null-old enum fields read as recorded with the new value visible', () => {
    const events = changes(
      curate([
        row({ columnName: 'companyType', oldValue: null, newValue: 'ltd' }),
      ]),
    );
    expect(events[0].title).toBe('Company type recorded');
    expect(events[0].detail).toBe('LTD');
    expect(events[0].from).toBeUndefined();
  });

  test('replayed _deleted tombstones across midnight dedupe to one event', () => {
    const events = changes(
      curate([
        row({
          columnName: '_deleted',
          oldValue: null,
          newValue: '2026-05-01T18:00:00',
          createdAt: '2026-05-01 23:58:00.000001',
        }),
        row({
          columnName: '_deleted',
          oldValue: null,
          newValue: '2026-05-01T18:00:00',
          createdAt: '2026-05-02 00:03:00.000001',
        }),
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Removed from the Companies House register');
  });
});

describe('anchors and ordering', () => {
  test('anchors render for an empty history, tracking marker above older incorporation', () => {
    const events = curate([]);
    expect(events.map((e) => e.kind)).toEqual([
      'tracking-start',
      'incorporated',
    ]);
    expect(events[0].dateISO).toBe(TRACKING_SINCE);
    expect(events[1].dateLabel).toBe('3 February 2016');
  });

  test('incorporated is omitted without a date_of_creation', () => {
    const events = curate([], { dateOfCreation: null });
    expect(events.map((e) => e.kind)).toEqual(['tracking-start']);
  });

  test('a company incorporated after tracking began sorts above the marker', () => {
    const events = curate([], { dateOfCreation: '2026-05-01' });
    expect(events.map((e) => e.kind)).toEqual([
      'incorporated',
      'tracking-start',
    ]);
  });

  test('change events sort newest first, above same-date anchors', () => {
    const events = curate([
      row({ createdAt: '2026-04-14 09:00:00.000001' }),
      row({
        createdAt: '2026-06-01 09:00:00.000001',
        oldValue: 'BB2 2BB',
        newValue: 'CC3 3CC',
      }),
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      'address',
      'address',
      'tracking-start',
      'incorporated',
    ]);
    expect(events[0].dateISO).toBe('2026-06-01');
  });
});

describe('truncated history', () => {
  test('the tracking anchor stops asserting completeness when rows were capped', () => {
    const events = curate([row({ createdAt: '2026-06-01 10:00:00.000001' })], {
      truncated: true,
    });
    const anchor = events.find((e) => e.kind === 'tracking-start');
    expect(anchor?.title).toBe('Earlier changes not shown');
    expect(anchor?.dateISO).toBe('2026-06-01');
    expect(anchor?.detail).toBeUndefined();
  });
});

describe('display dates', () => {
  test('published_at wins over created_at when present', () => {
    const events = changes(
      curate([
        row({
          createdAt: '2026-06-08 10:54:25.247631',
          publishedAt: '2026-06-01 09:00:00',
        }),
      ]),
    );
    expect(events[0].dateISO).toBe('2026-06-01');
    expect(events[0].dateLabel).toBe('1 June 2026');
  });
});

describe('status tones', () => {
  test.each([
    ['liquidation', 'negative'],
    ['administration', 'warning'],
    ['active', 'positive'],
    ['converted-closed', 'neutral'],
  ] as const)('status → %s renders %s tone', (status, tone) => {
    const events = changes(
      curate([
        row({
          columnName: 'companyStatus',
          oldValue: 'dissolved',
          newValue: status,
        }),
      ]),
    );
    expect(events[0].tone).toBe(tone);
    expect(events[0].from).toBe('Dissolved');
  });
});

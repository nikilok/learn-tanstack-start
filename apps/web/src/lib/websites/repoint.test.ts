import { describe, expect, test } from 'bun:test';

import { parseRepoints, type RepointEntry, repointRow } from './repoint';

const OLD = 'https://www.quillmere-old.co.uk';
const NEW = 'https://www.quillmere.co.uk';

const entry = (over: Partial<RepointEntry> = {}): RepointEntry => ({
  companyNumber: '09990117',
  url: OLD,
  newUrl: NEW,
  newEvidenceUrl: `${NEW}/contact`,
  keepLive: false,
  ...over,
});

const row = (
  over: Partial<Parameters<typeof repointRow>[0]> = {},
): Parameters<typeof repointRow>[0] => ({
  url: OLD,
  evidence: 'registry_confirmed',
  pinned: false,
  ...over,
});

describe('repointRow', () => {
  test('a row on the listed address moves to the new one, with its proof page and the status its tier lands at', () => {
    expect(repointRow(row(), entry())).toEqual({
      kind: 'move',
      url: NEW,
      evidenceUrl: `${NEW}/contact`,
      status: 'verified',
      keepLive: false,
    });
  });

  test('a verdict the sweep reached about the old address does not follow the row', () => {
    // Held, unreachable or dead there: the new address has not been read.
    expect(
      repointRow(row({ evidence: 'registry_unconfirmed' }), entry()),
    ).toMatchObject({ kind: 'move', status: 'candidate' });
    expect(repointRow(row({ evidence: 'crn_on_page' }), entry())).toMatchObject(
      { kind: 'move', status: 'verified' },
    );
  });

  test('carries what the list says of the new address: no proof page, or read and live', () => {
    expect(
      repointRow(row(), entry({ newEvidenceUrl: null, keepLive: true })),
    ).toMatchObject({ kind: 'move', evidenceUrl: null, keepLive: true });
  });

  test('a row already on the new address is only pinned there', () => {
    // Moved before there was a pin, or listed with one address to pin it where it is.
    expect(repointRow(row({ url: NEW }), entry())).toEqual({ kind: 'pin' });
    expect(repointRow(row({ url: NEW }), entry({ url: NEW }))).toEqual({
      kind: 'pin',
    });
  });

  test('a row already pinned on the new address is done', () => {
    expect(repointRow(row({ url: NEW, pinned: true }), entry())).toBe(
      'already',
    );
  });

  test('a row pinned on the listed address still moves: the owner is moving their own pin', () => {
    expect(repointRow(row({ pinned: true }), entry())).toMatchObject({
      kind: 'move',
      url: NEW,
    });
  });

  test('a row holding neither address is left: the list is out of date', () => {
    for (const url of [
      'https://www.hestwick.co.uk',
      null,
      // The same site spelled another way is not the address listed.
      'https://quillmere-old.co.uk',
    ]) {
      expect(repointRow(row({ url }), entry())).toBe('differs');
    }
  });
});

describe('parseRepoints', () => {
  test('a list of repoints, as given, with nothing said of proof or liveness read as none', () => {
    expect(
      parseRepoints([
        { companyNumber: '09990117', url: OLD, newUrl: NEW, note: 'x' },
        {
          companyNumber: '09990118',
          url: NEW,
          newUrl: NEW,
          newEvidenceUrl: `${NEW}/contact`,
          keepLive: true,
        },
      ]),
    ).toEqual([
      entry({ newEvidenceUrl: null }),
      entry({ companyNumber: '09990118', url: NEW, keepLive: true }),
    ]);
  });

  test('refuses anything that is not a list of repoints', () => {
    for (const json of [
      {},
      [null],
      [{ companyNumber: '09990117', url: OLD }],
      [{ companyNumber: 9990117, url: OLD, newUrl: NEW }],
      [{ ...entry(), newEvidenceUrl: 7 }],
      [{ ...entry(), keepLive: 'yes' }],
    ]) {
      expect(parseRepoints(json)).toBe(
        'the list must be [{ companyNumber, url, newUrl, newEvidenceUrl?, keepLive? }]',
      );
    }
  });

  test('refuses a company listed twice', () => {
    expect(parseRepoints([entry(), entry({ url: NEW })])).toBe(
      'a company is listed twice; list its other move in a second run',
    );
  });

  test('refuses a new address that is not one as a row stores it, naming the entry by its place in the list', () => {
    for (const newUrl of [
      'www.quillmere.co.uk',
      'http://www.quillmere.co.uk',
      'https://www.quillmere.co.uk/',
      'https://WWW.quillmere.co.uk',
      'https://www.quillmere.co.uk/about?ref=1',
      'https://www.facebook.com/quillmere',
      'not a url',
    ]) {
      expect(
        parseRepoints([entry(), entry({ companyNumber: '1', newUrl })]),
      ).toBe(
        'entry 2: newUrl must be an address as a row stores it, https://host[/path]',
      );
    }
  });

  test('refuses a directory as the new address', () => {
    expect(
      parseRepoints([
        entry({
          newUrl: 'https://www.yell.com/biz/quillmere',
          newEvidenceUrl: null,
        }),
      ]),
    ).toBe("entry 1: newUrl is a directory's address, not a company's site");
  });

  test('refuses a proof page that is not on the new site', () => {
    for (const newEvidenceUrl of [`${OLD}/contact`, 'not a url']) {
      expect(parseRepoints([entry({ newEvidenceUrl })])).toBe(
        'entry 1: newEvidenceUrl must be a page of the new site',
      );
    }
    // With or without www, it is the same site.
    expect(
      parseRepoints([
        entry({ newEvidenceUrl: 'https://quillmere.co.uk/contact' }),
      ]),
    ).toEqual([entry({ newEvidenceUrl: 'https://quillmere.co.uk/contact' })]);
  });

  test('refuses a proof address on the new site that is not a web page', () => {
    // The host is the site's, so a check of the host alone passed these.
    for (const scheme of ['ftp', 'ws', 'file']) {
      expect(
        parseRepoints([
          entry({ newEvidenceUrl: `${scheme}://www.quillmere.co.uk/contact` }),
        ]),
      ).toBe('entry 1: newEvidenceUrl must be a page of the new site');
    }
    // A page the site serves without https is still one of its pages.
    const plain = 'http://www.quillmere.co.uk/contact';
    expect(parseRepoints([entry({ newEvidenceUrl: plain })])).toEqual([
      entry({ newEvidenceUrl: plain }),
    ]);
  });
});

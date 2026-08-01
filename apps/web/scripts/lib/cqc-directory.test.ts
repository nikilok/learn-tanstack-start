import { describe, expect, test } from 'bun:test';

import { newestCqcOdsUrl } from './cqc-directory.ts';

const link = (prefix: string, folder: string, file: string) =>
  `<a href="https://www.cqc.org.uk/${prefix}/${folder}/${file}_HSCA_Active_Locations.ods">Download</a>`;

describe('newestCqcOdsUrl', () => {
  test('finds the file under the new /system/files/ path', () => {
    // The live breakage: CQC moved the files here and the importer, pinned to
    // /sites/default/files/, reported "the page layout or file name changed"
    // and imported nothing from the source behind most of our rows.
    const html = link('system/files', '2026-07', '01_July_2026');
    expect(newestCqcOdsUrl(html)).toBe(
      'https://www.cqc.org.uk/system/files/2026-07/01_July_2026_HSCA_Active_Locations.ods',
    );
  });

  test('still finds it under the old /sites/default/files/ path', () => {
    // Kept matched rather than replaced: these feeds have reverted a format
    // change within days before.
    const html = link('sites/default/files', '2026-06', '01_June_2026');
    expect(newestCqcOdsUrl(html)).toContain('/sites/default/files/2026-06/');
  });

  test('orders by the date folder, not by the URL string', () => {
    // The trap a lexical sort falls into: 'sites' < 'system', so sorting whole
    // URLs ranks EVERY old-path file above every new-path one. Here the newer
    // file is the /system/ one, which a string sort would rank second and
    // silently import a month-old directory as if it were current.
    const html = [
      link('sites/default/files', '2026-06', '01_June_2026'),
      link('system/files', '2026-07', '01_July_2026'),
    ].join('\n');
    expect(newestCqcOdsUrl(html)).toContain('/system/files/2026-07/');
  });

  test('picks the newest when both are on the same path', () => {
    const html = [
      link('system/files', '2026-05', '01_May_2026'),
      link('system/files', '2026-07', '01_July_2026'),
      link('system/files', '2026-06', '01_June_2026'),
    ].join('\n');
    expect(newestCqcOdsUrl(html)).toContain('2026-07');
  });

  test('returns null when the page carries no directory file', () => {
    // The importer turns this into a loud failure. It must stay distinguishable
    // from "found something", or a redesigned page imports zero rows quietly.
    expect(newestCqcOdsUrl('<html><body>no downloads here</body></html>')).toBe(
      null,
    );
  });

  test('ignores the other .ods files published alongside it', () => {
    // Latest_ratings and Deactivated_Locations sit on the same page and carry
    // neither a company number nor a web address.
    const html = [
      '<a href="https://www.cqc.org.uk/system/files/2026-07/01_July_2026_Latest_ratings.ods">a</a>',
      '<a href="https://www.cqc.org.uk/system/files/2026-07/01_July_2026_Deactivated_Locations.ods">b</a>',
      link('system/files', '2026-07', '01_July_2026'),
    ].join('\n');
    expect(newestCqcOdsUrl(html)).toContain('HSCA_Active_Locations.ods');
  });

  test('is not left stateful by the global regex between calls', () => {
    // A module-level /g regex carries lastIndex. matchAll clones it, but a
    // future refactor to .exec or .test would not, and the symptom is an
    // intermittent null on every other call.
    const html = link('system/files', '2026-07', '01_July_2026');
    expect(newestCqcOdsUrl(html)).toBe(newestCqcOdsUrl(html));
  });
});

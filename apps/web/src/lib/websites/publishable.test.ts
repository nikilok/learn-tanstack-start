import { describe, expect, test } from 'bun:test';

import { PUBLISHABLE_EVIDENCE } from './publishable';

describe('PUBLISHABLE_EVIDENCE', () => {
  test('publishes only self-proving evidence and owner decisions', () => {
    // `registry` is a third party saying so; `crn_on_page` is the company
    // publishing its own registration number. Promoting `registry` is a
    // product decision gated on a measured precision sample, so it must not
    // drift in by accident.
    expect([...PUBLISHABLE_EVIDENCE].sort()).toEqual(['crn_on_page', 'manual']);
  });
});

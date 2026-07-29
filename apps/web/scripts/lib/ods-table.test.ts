import { describe, expect, test } from 'bun:test';

import { parseOdsRowCells } from './ods-table';

const cell = (value: string) =>
  `<table:table-cell office:value-type="string"><text:p>${value}</text:p></table:table-cell>`;

describe('parseOdsRowCells', () => {
  test('reads a plain row', () => {
    const row = `<table:table-row>${cell('03260168')}${cell('www.example.co.uk')}</table:table-row>`;
    expect(parseOdsRowCells(row)).toEqual(['03260168', 'www.example.co.uk']);
  });

  test('expands repeated columns so later indices stay aligned', () => {
    // This is what makes header-by-position wrong: the CQC header expands to
    // 322 slots while the visible labels number far fewer.
    const row = `<table:table-row>${cell('a')}<table:table-cell table:number-columns-repeated="3"/>${cell('b')}</table:table-row>`;
    expect(parseOdsRowCells(row)).toEqual(['a', '', '', '', 'b']);
  });

  test('repeats a non-empty value too', () => {
    const row = `<table:table-row><table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell></table:table-row>`;
    expect(parseOdsRowCells(row)).toEqual(['x', 'x']);
  });

  test('caps a pathological trailing repeat', () => {
    const row = `<table:table-row>${cell('a')}<table:table-cell table:number-columns-repeated="16384"/></table:table-row>`;
    expect(parseOdsRowCells(row, 10)).toHaveLength(10);
  });

  test('handles self-closing and covered cells', () => {
    const row = `<table:table-row>${cell('a')}<table:covered-table-cell/>${cell('b')}</table:table-row>`;
    expect(parseOdsRowCells(row)).toEqual(['a', '', 'b']);
  });

  test('decodes entities', () => {
    const row = `<table:table-row>${cell('Bill &amp; Ben &lt;Care&gt; &#39;Ltd&#39;')}</table:table-row>`;
    expect(parseOdsRowCells(row)).toEqual(["Bill & Ben <Care> 'Ltd'"]);
  });

  test('joins multiple text runs within one cell', () => {
    const row = `<table:table-row><table:table-cell><text:p>Line one</text:p><text:p>Line two</text:p></table:table-cell></table:table-row>`;
    expect(parseOdsRowCells(row)).toEqual(['Line one Line two']);
  });

  test('keeps explicit space and tab elements', () => {
    const row = `<table:table-row><table:table-cell><text:p>a<text:s/>b<text:tab/>c</text:p></table:table-cell></table:table-row>`;
    expect(parseOdsRowCells(row)).toEqual(['a b c']);
  });

  test('strips inline formatting without eating the text', () => {
    const row = `<table:table-row><table:table-cell><text:p><text:span text:style-name="T1">Acme</text:span> Care</text:p></table:table-cell></table:table-row>`;
    expect(parseOdsRowCells(row)).toEqual(['Acme Care']);
  });

  test('is not terminated early by a > inside an attribute value', () => {
    const row = `<table:table-row><table:table-cell table:formula="of:=[.A1]&gt;0" office:value-type="string"><text:p>ok</text:p></table:table-cell></table:table-row>`;
    expect(parseOdsRowCells(row)).toEqual(['ok']);
  });

  test('returns no cells for an empty row', () => {
    expect(parseOdsRowCells('<table:table-row/>')).toEqual([]);
  });
});

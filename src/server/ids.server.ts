import Sqids from 'sqids';

const sqids = new Sqids({ minLength: 6 });

export function encodeId(id: number): string {
  return sqids.encode([id]);
}

export function decodeId(slug: string): number | null {
  const ids = sqids.decode(slug);
  return ids.length > 0 ? ids[0] : null;
}

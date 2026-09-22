import { DEVICE_KEY_RE } from '../../src/lib/device/key';

/** Answers a device-keyed ping (`/api/p|v|e/:hash`): 204 for a well-formed key, 404 for anything else, never cached. Nothing is read, stored or logged here. */
export function devicePingResponse(key: string | undefined): Response {
  return new Response(null, {
    status: DEVICE_KEY_RE.test(key ?? '') ? 204 : 404,
    headers: { 'cache-control': 'no-store' },
  });
}

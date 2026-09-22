import FingerprintJS from '@fingerprintjs/fingerprintjs';

import { DEVICE_KEY_RE } from './key';

/** Computes the device key, or null on any failure. */
export async function computeDeviceKey(): Promise<string | null> {
  try {
    const agent = await FingerprintJS.load({ monitoring: false });
    const { visitorId } = await agent.get();
    return DEVICE_KEY_RE.test(visitorId) ? visitorId : null;
  } catch {
    return null;
  }
}

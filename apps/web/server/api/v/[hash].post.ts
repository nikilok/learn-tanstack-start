import { defineEventHandler } from 'h3';

import { devicePingResponse } from '../../utils/devicePing';

// POST /api/v/:hash. The edge middleware passes only well-formed keys through
// (DEVICE_PING_RE).
export default defineEventHandler((event) =>
  devicePingResponse(event.context.params?.hash as string | undefined),
);

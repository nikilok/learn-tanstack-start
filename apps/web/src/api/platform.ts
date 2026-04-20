import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';
import { parsePlatform } from '../hooks/usePlatform';

/**
 * Server fn that parses the request's `user-agent` header into a
 * `{ platform, isMobile }` shape. Used to render correct keyboard-shortcut
 * labels during SSR before client JS runs.
 */
export const getPlatform = createServerFn().handler(async () => {
  const ua = getRequestHeader('user-agent') ?? '';
  return parsePlatform(ua);
});

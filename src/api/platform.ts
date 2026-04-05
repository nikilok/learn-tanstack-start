import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';
import { parsePlatform } from '../hooks/usePlatform';

export const getPlatform = createServerFn().handler(async () => {
  const ua = getRequestHeader('user-agent') ?? '';
  return parsePlatform(ua);
});

import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { companyExtrasQueryOptions } from '../api/companyExtras';
import type { ExtrasPage } from '../lib/company/extras-loader';
import { type ExtrasState, extrasState } from '../lib/company/extras-view';
import { readinessSnapshot, subscribeReadiness } from '../lib/device/beacons';
import { WAITING } from '../lib/device/readiness';

/** The server snapshot: SSR and hydration always render the pending state. */
const serverSnapshot = () => WAITING;

/** A company page's licence numbers and website, requested once this document holds a device key and the visitor has engaged, and only when `wanted` (see extrasWanted). */
export function useCompanyExtras(
  page: ExtrasPage,
  wanted: boolean,
): ExtrasState {
  const readiness = useSyncExternalStore(
    subscribeReadiness,
    readinessSnapshot,
    serverSnapshot,
  );
  const key = readiness.status === 'ready' && wanted ? readiness.key : null;
  const { data, isError } = useQuery(companyExtrasQueryOptions(page, key));
  return extrasState(readiness.status, data, isError);
}

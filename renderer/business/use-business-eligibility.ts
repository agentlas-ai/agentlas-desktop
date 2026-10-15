'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import { captureBusinessRendererBridge, currentBusinessRendererBridge, type BusinessRendererBridge } from './renderer-bridge';
import { isBusinessEligibility, type BusinessEligibility } from '../../shared/business/eligibility';

/** Display-only, instance-bound current read. No module cache, plan inference,
 * authority, session producer or background recurring check. */
export function useBusinessEligibility({ enabled = true, suppliedBridge }: { enabled?: boolean; suppliedBridge?: BusinessRendererBridge | null } = {}) {
  const bridge = useMemo(() => suppliedBridge === undefined ? currentBusinessRendererBridge() : captureBusinessRendererBridge(suppliedBridge), [suppliedBridge]);
  // An opening/enabling cycle cannot display a prior opening's positive result.
  const cycle = useMemo(() => ({}), [bridge, enabled]);
  const [value, setValue] = useState<{ eligibility: BusinessEligibility; cycle: object } | null>(null);
  const generation = useRef(0), mounted = useRef(false);
  const invalidate = useCallback(() => { generation.current++; setValue(null); }, []);
  const refresh = useCallback(async (): Promise<BusinessEligibility | null> => {
    const ticket = ++generation.current;
    if (mounted.current) setValue(null);
    if (!bridge?.readEligibility) return null;
    try {
      const raw = await bridge.readEligibility();
      if (!mounted.current || ticket !== generation.current || !isBusinessEligibility(raw)) return null;
      const exact = structuredClone(raw);
      if (!isBusinessEligibility(exact) || ticket !== generation.current) return null;
      setValue({ eligibility: exact, cycle }); return exact;
    } catch { return null; }
  }, [bridge, cycle]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  useEffect(() => {
    invalidate();
    if (!enabled) return;
    const changed = () => { invalidate(); void refresh(); };
    const sourceInvalidated = () => invalidate();
    let off: (() => void) | undefined, authOff: (() => void) | undefined;
    try { off = bridge?.onInvalidated?.(sourceInvalidated); authOff = ipc()?.auth.onSessionChanged?.(changed); }
    catch { invalidate(); }
    window.addEventListener('focus', changed);
    window.addEventListener('agentlas:auth-changed', changed);
    void refresh();
    return () => { generation.current++; off?.(); authOff?.(); window.removeEventListener('focus', changed); window.removeEventListener('agentlas:auth-changed', changed); };
  }, [bridge, enabled, invalidate, refresh]);
  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(invalidate, Math.max(0, Date.parse(value.eligibility.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [value, invalidate]);
  const eligibility = enabled && value?.cycle === cycle ? value.eligibility : null;
  return { eligibility, eligible: !!eligibility && isBusinessEligibility(eligibility) && eligibility.eligible === true, refresh, invalidate };
}

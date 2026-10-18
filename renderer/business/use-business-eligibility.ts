'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import { captureBusinessRendererBridge, currentBusinessRendererBridge, type BusinessRendererBridge } from './renderer-bridge';
import { isBusinessEligibility, type BusinessEligibility } from '../../shared/business/eligibility';

const REFRESH_LEAD_MS = 5_000;
const MIN_REFRESH_LEASE_MS = 10_000;
/** Display metadata only. Current operation owners still authorize every action.
 * A visible normal lease gets one early read; failed/short leases never retry. */
export function useBusinessEligibility({ enabled = true, suppliedBridge }: { enabled?: boolean; suppliedBridge?: BusinessRendererBridge | null } = {}) {
  const bridge = useMemo(() => suppliedBridge === undefined ? currentBusinessRendererBridge() : captureBusinessRendererBridge(suppliedBridge), [suppliedBridge]);
  const cycle = useMemo(() => ({}), [bridge, enabled]);
  const [value, setValue] = useState<{ eligibility: BusinessEligibility; cycle: object } | null>(null);
  const generation = useRef(0), mounted = useRef(false), inFlight = useRef<Promise<BusinessEligibility | null> | null>(null);
  const lastReadStartedAt = useRef(-Infinity);
  const invalidate = useCallback(() => { generation.current++; inFlight.current = null; setValue(null); }, []);
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const read = useCallback((preserveDisplay = false): Promise<BusinessEligibility | null> => {
    if (!enabled || !visible() || !bridge?.readEligibility) { invalidate(); return Promise.resolve(null); }
    if (preserveDisplay && inFlight.current) return inFlight.current;
    const ticket = ++generation.current;
    lastReadStartedAt.current = Date.now();
    if (!preserveDisplay && mounted.current) setValue(null);
    const pending = (async () => {
      try {
        const raw = await bridge.readEligibility!();
        if (!mounted.current || ticket !== generation.current) return null;
        if (!visible() || !isBusinessEligibility(raw)) { invalidate(); return null; }
        const exact = structuredClone(raw);
        if (!isBusinessEligibility(exact) || ticket !== generation.current) { invalidate(); return null; }
        setValue({ eligibility: exact, cycle }); return exact;
      } catch { if (mounted.current && ticket === generation.current) invalidate(); return null; }
      finally { if (ticket === generation.current) inFlight.current = null; }
    })();
    inFlight.current = pending;
    return pending;
  }, [bridge, cycle, enabled, invalidate]);
  const refresh = useCallback(() => read(false), [read]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; inFlight.current = null; };
  }, []);
  useEffect(() => {
    invalidate();
    if (!enabled) return;
    const changed = () => { invalidate(); if (visible()) void refresh(); };
    const sourceChanged = () => {
      invalidate();
      if (visible() && Date.now() - lastReadStartedAt.current >= MIN_REFRESH_LEASE_MS) void refresh();
    };
    let off: (() => void) | undefined, authOff: (() => void) | undefined;
    try { off = bridge?.onInvalidated?.(sourceChanged); authOff = ipc()?.auth.onSessionChanged?.(changed); }
    catch { invalidate(); }
    window.addEventListener('focus', changed);
    window.addEventListener('agentlas:auth-changed', changed);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', changed);
    if (visible()) void refresh();
    return () => { generation.current++; inFlight.current = null; off?.(); authOff?.(); window.removeEventListener('focus', changed); window.removeEventListener('agentlas:auth-changed', changed); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', changed); };
  }, [bridge, enabled, invalidate, refresh]);
  useEffect(() => {
    if (!value) return;
    const remaining = Date.parse(value.eligibility.expiresAt) - Date.now();
    const expiry = setTimeout(invalidate, Math.max(0, remaining));
    const renewal = remaining >= MIN_REFRESH_LEASE_MS && value.eligibility.eligible
      ? setTimeout(() => { if (visible()) void read(true); }, remaining - REFRESH_LEAD_MS) : null;
    return () => { clearTimeout(expiry); if (renewal !== null) clearTimeout(renewal); };
  }, [value, invalidate, read]);
  const eligibility = enabled && value?.cycle === cycle && isBusinessEligibility(value.eligibility) ? value.eligibility : null;
  return { eligibility, eligible: eligibility?.eligible === true, refresh, invalidate };
}

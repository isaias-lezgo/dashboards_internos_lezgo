"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { DashboardPayload } from "@/lib/types";
import { fetchStream } from "./fetch-stream";

export type StepKey =
  | "config"
  | "contacts"
  | "opportunities"
  | "pautas"
  | "appointments"
  | "tasks";

export interface StepState {
  status: "pending" | "loading" | "done";
  count?: number;
}

export type StepMap = Record<StepKey, StepState>;

const INITIAL_STEPS: StepMap = {
  config: { status: "pending" },
  contacts: { status: "pending" },
  opportunities: { status: "pending" },
  pautas: { status: "pending" },
  appointments: { status: "pending" },
  tasks: { status: "pending" },
};

// The payload the sync produces, the cache stores and the browser receives — one
// definition in lib/types.ts so the three cannot drift apart. Kept as an alias
// because several components import DashboardData by name.
export type DashboardData = DashboardPayload;

export function useDashboardData(params?: {
  startDate?: string;
  endDate?: string;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [progress, setProgress] = useState<string>("Iniciando sincronización…");
  const [locationName, setLocationName] = useState<string>("");
  const [steps, setSteps] = useState<StepMap>(INITIAL_STEPS);
  const abortRef = useRef<AbortController | null>(null);

  const startDate = params?.startDate;
  const endDate = params?.endDate;

  const load = useCallback(async (sd?: string, ed?: string, fresh?: boolean) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const searchParams = new URLSearchParams();
    if (sd) searchParams.set("startDate", sd);
    if (ed) searchParams.set("endDate", ed);
    // The cache serves everyone by default; this is the escape hatch for someone
    // who just changed something in the CRM and wants to see it now.
    if (fresh) searchParams.set("fresh", "1");
    const qs = searchParams.toString();
    const url = `/api/dashboard${qs ? `?${qs}` : ""}`;

    setIsLoading(true);
    setIsError(false);
    setProgress("Iniciando sincronización…");
    setSteps(INITIAL_STEPS);

    try {
      const result = await fetchStream<DashboardData>(
        url,
        setProgress,
        ctrl.signal,
        setLocationName,
        (step) =>
          setSteps((prev) => ({
            ...prev,
            [step.key]: { status: step.status, count: step.count },
          }))
      );
      // Ignore the result of a fetch that has since been superseded (e.g. the
      // mount→abort→remount cycle from React StrictMode in dev or router.refresh
      // after login). Otherwise a stale fetch can clobber the newer one's state.
      if (ctrl.signal.aborted) return;
      setData(result);
      if (result.locationName) setLocationName(result.locationName);
      setProgress("");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setIsError(true);
        setProgress("");
      }
    } finally {
      // Only the current (non-aborted) fetch may flip loading off. A superseded
      // fetch's finally must not turn off the spinner while the newer fetch is
      // still in flight — that was surfacing the empty dashboard behind the
      // loading screen.
      if (!ctrl.signal.aborted) setIsLoading(false);
    }
  }, []);

  // Load on mount and when date params change
  useEffect(() => {
    load(startDate, endDate);
    return () => {
      abortRef.current?.abort();
    };
  }, [load, startDate, endDate]);

  // Defaults to fresh: the "Actualizar" button exists precisely to bypass the
  // cache. A refresh that returned the same thing already on screen would feel
  // broken.
  const refresh = useCallback(
    (opts?: { fresh?: boolean }) => {
      load(startDate, endDate, opts?.fresh ?? true);
    },
    [load, startDate, endDate],
  );

  return {
    data,
    isLoading,
    isError,
    progress,
    locationName,
    steps,
    refresh,
  };
}

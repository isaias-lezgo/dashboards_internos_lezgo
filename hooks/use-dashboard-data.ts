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
  | "tasks"
  // Solo se emite cuando el proyecto tiene Meta conectado y cuenta asignada.
  | "meta";

export interface StepState {
  status: "pending" | "loading" | "done" | "partial" | "error";
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
  meta: { status: "pending" },
};

// The payload the sync produces, the cache stores and the browser receives — one
// definition in lib/types.ts so the three cannot drift apart. Kept as an alias
// because several components import DashboardData by name.
export type DashboardData = DashboardPayload;

// El refresco en segundo plano: cada cuánto se pregunta si ya terminó, cuánto se
// espera a que el servidor tome el candado (after() corre DESPUÉS de mandar la
// respuesta, así que la primera consulta puede llegar antes) y cuándo rendirse.
// El tope va por encima de los 300 s de maxDuration de la ruta.
const POLL_MS = 5_000;
const CLAIM_GRACE_MS = 30_000;
const GIVE_UP_MS = 6 * 60_000;

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
  // El servidor mandó un caché vencido y está sincronizando detrás: hay banner,
  // "Actualizar" se bloquea y los datos se cambian solos cuando termine.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const startDate = params?.startDate;
  const endDate = params?.endDate;

  // `silent`: el cambio de datos al terminar el refresco. No prende isLoading ni
  // reinicia los pasos — la persona sigue trabajando sobre lo que ya ve, y un
  // fallo aquí no es un error en pantalla: se queda con el caché que tenía.
  const load = useCallback(async (sd?: string, ed?: string, fresh?: boolean, silent?: boolean) => {
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

    if (!silent) {
      setIsLoading(true);
      setIsError(false);
      setProgress("Iniciando sincronización…");
      setSteps(INITIAL_STEPS);
      setIsRefreshing(false);
    }
    let refreshing = false;

    try {
      const result = await fetchStream<DashboardData>(
        url,
        setProgress,
        ctrl.signal,
        setLocationName,
        (step) =>
          setSteps((prev) => ({
            ...prev,
            [step.key as StepKey]: { status: step.status, count: step.count },
          })),
        () => { refreshing = true; }
      );
      // Ignore the result of a fetch that has since been superseded (e.g. the
      // mount→abort→remount cycle from React StrictMode in dev or router.refresh
      // after login). Otherwise a stale fetch can clobber the newer one's state.
      if (ctrl.signal.aborted) return;
      setData(result);
      setIsRefreshing(refreshing);
      if (result.locationName) setLocationName(result.locationName);
      setProgress("");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        if (silent) {
          setIsRefreshing(false);
        } else {
          setIsError(true);
          setProgress("");
        }
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

  // Mientras corre el refresco en segundo plano, pregunta si ya terminó. Tres
  // salidas: el caché avanzó → se traen los datos nuevos sin pantalla de carga;
  // el candado se soltó sin avanzar (el refresco falló y dejó el último caché
  // bueno) → se retira el banner; nadie tomó el candado o pasó el tope → igual.
  // Un fallo de red al preguntar no es ninguna de las tres: se reintenta.
  const shownAt = data?.meta?.fetchedAt;
  useEffect(() => {
    if (!isRefreshing || !shownAt) return;
    const startedAt = Date.now();
    let sawSyncing = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const res = await fetch("/api/dashboard/status", { cache: "no-store" });
        if (stopped) return;
        if (res.ok) {
          const s = (await res.json()) as { syncedAt: string | null; syncing: boolean };
          if (stopped) return;
          if (s.syncedAt && new Date(s.syncedAt).getTime() > new Date(shownAt).getTime()) {
            load(startDate, endDate, false, true);
            return;
          }
          if (s.syncing) sawSyncing = true;
          else if (sawSyncing || Date.now() - startedAt > CLAIM_GRACE_MS) {
            setIsRefreshing(false);
            return;
          }
        } else if (res.status === 401) {
          setIsRefreshing(false);
          return;
        }
      } catch {
        if (stopped) return;
      }
      if (Date.now() - startedAt > GIVE_UP_MS) {
        setIsRefreshing(false);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };

    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [isRefreshing, shownAt, load, startDate, endDate]);

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
    isRefreshing,
    isError,
    progress,
    locationName,
    steps,
    refresh,
  };
}

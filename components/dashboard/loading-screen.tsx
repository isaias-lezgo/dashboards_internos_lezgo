"use client"

import Image from "next/image"
import { motion, AnimatePresence } from "framer-motion"
import { useEffect, useState } from "react"
import type { StepKey, StepMap } from "@/hooks/use-dashboard-data"

interface LoadingScreenProps {
  progress: string
  /** Name of the GHL sub-account being opened. Empty until resolved. */
  locationName?: string
  /** Live per-dataset progress. Only ever advances on the cold path. */
  steps?: StepMap
}

// The datasets /api/dashboard fetches concurrently. They are no longer listed
// one row each — the screen only counts them, to size the progress rail.
const STEP_KEYS: StepKey[] = [
  "config",
  "contacts",
  "opportunities",
  "pautas",
  "appointments",
  "tasks",
]

const IDLE_STEPS: StepMap = {
  config: { status: "pending" },
  contacts: { status: "pending" },
  opportunities: { status: "pending" },
  pautas: { status: "pending" },
  appointments: { status: "pending" },
  tasks: { status: "pending" },
}

// ease-out-expo. Everything here decelerates; nothing overshoots.
const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

// How long a silent wait may run before the screen admits something is slow.
// Under this the warm cache has almost always landed and there is nothing true
// to report, so the screen says nothing.
const PATIENCE_MS = 5000

/**
 * The one moving element. Indeterminate (`ratio === null`) while we are waiting
 * on the cache, determinate once a live sync is actually reporting datasets —
 * a percentage during a one-second cache read would be invented.
 */
function Rail({ ratio }: { ratio: number | null }) {
  return (
    <div
      className="relative h-[3px] w-44 overflow-hidden rounded-full bg-border"
      aria-hidden
    >
      {ratio === null ? (
        <motion.div
          // Travel stops short of the full width at both ends, and runs at a
          // constant speed: an ease-in-out that parks the segment outside the
          // rail leaves it visibly blank at every turn, which reads as stalled.
          className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary"
          animate={{ x: ["-70%", "270%"] }}
          transition={{ duration: 1.25, repeat: Infinity, ease: "linear" }}
        />
      ) : (
        <motion.div
          // scaleX, not width: width is a layout property and animating it
          // forces a reflow on every frame of the sync.
          className="absolute inset-0 origin-left rounded-full bg-primary"
          initial={{ scaleX: 0.04 }}
          animate={{ scaleX: Math.max(ratio, 0.04) }}
          transition={{ duration: 0.5, ease: EASE_OUT_EXPO }}
        />
      )}
    </div>
  )
}

export function LoadingScreen({ progress, locationName, steps }: LoadingScreenProps) {
  const resolved = steps ?? IDLE_STEPS

  // A step frame only ever arrives on the cold path — the cached response is a
  // single `data` frame. So the first frame that moves off "pending" is the
  // signal that this is a real GHL sync and not a sub-second cache read.
  const syncing = STEP_KEYS.some((k) => resolved[k].status !== "pending")
  const done = STEP_KEYS.filter((k) => resolved[k].status === "done").length

  const [patienceSpent, setPatienceSpent] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setPatienceSpent(true), PATIENCE_MS)
    return () => clearTimeout(id)
  }, [])

  // One status line, and only when there is something true to put in it. The
  // sync's own messages already carry the dataset name and its running count,
  // which is what the six rows used to do.
  const detail = syncing
    ? progress || "Sincronizando"
    : patienceSpent
      ? "Conectando con Lezgo Suite CRM"
      : ""

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background"
      // Opaque from the first frame (no enter fade) so the empty dashboard
      // behind it never shows through on initial load / after login. The exit
      // fade still plays to reveal the populated dashboard once data arrives.
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: EASE_OUT_EXPO }}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {/* The app's own identity block, centered — the same mark, wordmark and
          kicker that take their place in the header a second later. */}
      <div className="flex flex-col items-center px-8">
        {/* The mark is a white "L" inside an amber outline: designed for the dark
            header, invisible on a light background. It keeps its own navy plate
            here — the same #0D172F as the header — so it reads in both themes. */}
        <div
          className="flex h-[60px] w-[60px] items-center justify-center rounded-[14px] border border-white/10 bg-[#0D172F]"
          aria-hidden
        >
          <Image
            src="/logo-mark.png"
            alt=""
            width={2851}
            height={3371}
            priority
            className="h-8 w-auto"
          />
        </div>

        <h2 className="mt-4 text-[17px] font-semibold leading-tight tracking-tight text-foreground">
          Lezgo Suite Analíticas
        </h2>

        {/* No skeleton placeholder: on the cached path the sub-account name
            never arrives before the data does, so a pill that pulses and then
            vanishes would be promising something that was never coming. */}
        <p className="mt-1.5 h-4 text-[12px] font-medium tracking-wide text-muted-foreground">
          {locationName || "Marketing y Ventas"}
        </p>

        <div className="mt-8">
          <Rail ratio={syncing ? done / STEP_KEYS.length : null} />
        </div>

        {/* Reserved height so the line appearing on a slow sync doesn't shift
            the block that is already on screen. */}
        <div className="mt-4 flex h-4 items-center justify-center">
          <AnimatePresence mode="wait">
            {detail && (
              <motion.span
                key={detail}
                className="max-w-[22rem] truncate text-[12px] tabular-nums text-muted-foreground"
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.18, ease: EASE_OUT_EXPO }}
              >
                {detail}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}

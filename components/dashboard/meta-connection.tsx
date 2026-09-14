// components/dashboard/meta-connection.tsx
// La píldora "Meta" del header: conectar, ver el estado, asignar cuentas al
// proyecto abierto, reconectar o desconectar. Es el ÚNICO lugar de la UI que
// sabe del OAuth; las cards de costo (entrega ②) solo miran data.metaAds.
//
// Todos ven el estado; solo `canManage` (alcance all) ve acciones. Ámbar solo
// en `partial` — DESIGN.md: ámbar marca dónde va la atención.
"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Check, ChevronDown, Loader2, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { MetaAdsStatus } from "@/lib/types"

interface AccountRow {
  id: string
  name: string
  currency: string
  status: number
  selected: boolean
}

type ConnectionState =
  | { connected: false; canManage: boolean; reason?: "not_configured" | "no_db" | "preview" }
  | {
      connected: true
      canManage: boolean
      connectedBy: string | null
      connectedAt: string
      tokenKind: "system_user" | "user"
      tokenExpiresAt: string | null
      accounts: AccountRow[]
    }

const ERROR_COPY: Record<string, string> = {
  state_invalid: "La conexión expiró. Inténtalo de nuevo.",
  denied: "Conexión cancelada.",
  token_exchange: "Meta no aceptó la autorización. Inténtalo de nuevo.",
  token_invalid: "Meta devolvió un token inválido. Inténtalo de nuevo.",
  no_accounts: "Esa empresa no compartió cuentas publicitarias.",
  db: "No se pudo guardar la conexión.",
}

const DISABLED_COPY: Record<NonNullable<Extract<ConnectionState, { connected: false }>["reason"]>, string> = {
  not_configured: "Meta no configurado",
  no_db: "Requiere base de datos",
  preview: "Conecta desde producción",
}

const PILL = "h-8 gap-1.5 rounded-lg border-white/20 bg-white/10 text-xs font-medium text-white hover:bg-white/15"

export function MetaConnectionPill({
  status,
  onChanged,
}: {
  /** metaAdsStatus del último sync (viaja en el payload, también en caliente). */
  status: MetaAdsStatus | undefined
  /** Tras conectar, asignar o desconectar: el panel debe re-sincronizar en fresco. */
  onChanged: () => void
}) {
  const [state, setState] = useState<ConnectionState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/meta/connection")
      if (res.ok) setState((await res.json()) as ConnectionState)
    } catch {
      /* la píldora simplemente no aparece */
    }
  }, [])

  // Al montar, y al regresar del callback (?meta=connected | error).
  useEffect(() => {
    void load()
    const url = new URL(window.location.href)
    const meta = url.searchParams.get("meta")
    if (!meta) return
    const reason = url.searchParams.get("reason") ?? ""
    url.searchParams.delete("meta")
    url.searchParams.delete("reason")
    window.history.replaceState(null, "", url.toString())
    if (meta === "connected") {
      setNotice("Meta conectado")
      onChanged()
    } else {
      setNotice(ERROR_COPY[reason] ?? "No se pudo conectar con Meta.")
    }
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
    // onChanged cambia de identidad en cada render; solo interesa al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const revoked = status?.state === "error" && status.reason !== "failed"
  const failedIds = status?.state === "partial" ? status.failedAccounts.map((f) => f.id) : []

  const openDialog = () => {
    if (!state?.connected) return
    setDraft(state.accounts.filter((a) => a.selected).map((a) => a.id))
    setDialogOpen(true)
  }

  const saveAccounts = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/meta/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: draft }),
      })
      if (res.ok) {
        setDialogOpen(false)
        await load()
        onChanged()
      } else {
        setNotice("No se pudo guardar la asignación.")
      }
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async () => {
    if (
      !window.confirm(
        "¿Desconectar Meta? El gasto dejará de actualizarse en TODOS los proyectos. Las cuentas asignadas se conservan. Esto no revoca el acceso en Meta; eso se hace desde el Business Manager."
      )
    )
      return
    await fetch("/api/meta/connection", { method: "DELETE" })
    await load()
    onChanged()
  }

  if (!state) return null

  // Sin conexión: los que no administran no ven nada; el admin ve el botón.
  if (!state.connected) {
    if (!state.canManage) return null
    const disabled = state.reason ? DISABLED_COPY[state.reason] : null
    return (
      <div className="flex items-center gap-2">
        {notice && <span className="text-xs text-white/80">{notice}</span>}
        <Button variant="outline" size="sm" className={PILL} disabled={!!disabled} asChild={!disabled}>
          {disabled ? <span>{disabled}</span> : <a href="/api/meta/connect">Conectar con Meta</a>}
        </Button>
      </div>
    )
  }

  const selected = state.accounts.filter((a) => a.selected)
  const tone = revoked
    ? "border-red-400/60 text-red-200"
    : failedIds.length > 0
      ? "border-[#F59B1B]/70 text-[#F59B1B]"
      : selected.length === 0
        ? "text-white/60"
        : ""
  const label = revoked
    ? "Meta desconectado"
    : failedIds.length > 0
      ? `Meta · ${failedIds.length === 1 ? "una cuenta no respondió" : `${failedIds.length} cuentas no respondieron`}`
      : selected.length === 0
        ? "Meta · sin cuenta"
        : `Meta · ${selected.length} ${selected.length === 1 ? "cuenta" : "cuentas"}`

  const pill = (
    <Button variant="outline" size="sm" className={`${PILL} ${tone}`}>
      {revoked || failedIds.length > 0 ? <AlertTriangle className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
      {label}
      {state.canManage && <ChevronDown className="h-3 w-3 opacity-70" />}
    </Button>
  )

  // Los alcances de agencia solo ven el estado.
  if (!state.canManage) return <div className="flex items-center gap-2">{pill}</div>

  return (
    <div className="flex items-center gap-2">
      {notice && <span className="text-xs text-white/80">{notice}</span>}
      <Popover>
        <PopoverTrigger asChild>{pill}</PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-2 text-sm">
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {state.connectedBy ? `Conectado por ${state.connectedBy}` : "Conectado"} ·{" "}
            {new Date(state.connectedAt).toLocaleDateString("es-MX")}
          </p>
          {revoked && (
            <p className="px-2 py-1 text-xs text-red-600 dark:text-red-400">
              {status?.state === "error" && status.reason === "token_unreadable"
                ? "El token ya no se puede leer (cambió el secreto). Vuelve a conectar."
                : "Meta revocó el acceso o el token dejó de ser válido. Vuelve a conectar."}
            </p>
          )}
          {failedIds.length > 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Sin respuesta: {failedIds.join(", ")}. Si la cuenta es de otra empresa, hay que compartirla en el Business Manager.
            </p>
          )}
          {state.tokenExpiresAt && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Token de usuario: caduca el {new Date(state.tokenExpiresAt).toLocaleDateString("es-MX")}.
            </p>
          )}
          {revoked ? (
            <Button variant="default" size="sm" className="w-full justify-start" asChild>
              <a href="/api/meta/connect">Reconectar</a>
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={openDialog}>
                {selected.length === 0 ? "Asignar cuenta a este proyecto" : "Cambiar cuentas de este proyecto"}
              </Button>
              <Button variant="ghost" size="sm" className="w-full justify-start" asChild>
                <a href="/api/meta/connect">Reconectar</a>
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" className="w-full justify-start text-red-600" onClick={disconnect}>
            <Unplug className="mr-1.5 h-3.5 w-3.5" /> Desconectar
          </Button>
        </PopoverContent>
      </Popover>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cuentas publicitarias de este proyecto</DialogTitle>
            <DialogDescription>
              De las cuentas que la empresa compartió, elige cuáles alimentan a este proyecto. Una cuenta
              puede estar en varios proyectos. Sin ninguna, el proyecto no muestra gasto. Para compartir más
              cuentas, vuelve a conectar.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {state.accounts.map((a) => (
              <label key={a.id} className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={draft.includes(a.id)}
                  onCheckedChange={(v) => setDraft((d) => (v ? [...d, a.id] : d.filter((x) => x !== a.id)))}
                />
                <span className="flex-1 truncate">{a.name}</span>
                <span className="text-xs text-muted-foreground">
                  {a.id} · {a.currency}
                  {a.status !== 1 ? " · inactiva" : ""}
                </span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveAccounts} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Guardar y sincronizar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

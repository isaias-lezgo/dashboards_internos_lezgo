import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { TOOL_DEFINITIONS, WRITE_TOOL_DEFINITIONS } from "@/lib/ai-tools";
import { ASSISTANT_SYSTEM_PROMPT, WRITE_MODE_RULES } from "@/lib/ai-context";
import { forbiddenTab, scopeHasTab } from "@/lib/session";

// Server-side, one Anthropic turn per request. The client runs the agent
// loop: when we return tool_use blocks, the client executes them locally
// against the dashboard data and POSTs back with tool_result blocks.

interface ChatRequestBody {
  // The dataset summary built on the client and pinned for caching. We accept
  // it instead of regenerating server-side so the cache key stays stable
  // across turns in a single session.
  datasetSummary: string;
  // Full conversation history including any tool_use / tool_result blocks.
  messages: Anthropic.MessageParam[];
  // Optional: cap output tokens.
  maxTokens?: number;
  // IANA timezone from the user's browser. Falls back to America/Mexico_City.
  userTimezone?: string;
  // Modo edición: envía las herramientas de escritura + reglas de escritura.
  writeEnabled?: boolean;
}

export const runtime = "nodejs";

function translateAnthropicError(error: InstanceType<typeof Anthropic.APIError>): string {
  // The SDK parses the JSON body into error.error; fall back to error.message.
  const body = error.error as { error?: { type?: string; message?: string } } | null | undefined;
  const inner = body?.error?.message ?? error.message;

  if (/credit balance/i.test(inner))
    return "Saldo de crédito insuficiente. Recarga tu cuenta en console.anthropic.com para continuar.";
  if (/overloaded/i.test(inner))
    return "El servicio de IA está sobrecargado. Espera un momento e intenta de nuevo.";
  if (/invalid api key/i.test(inner))
    return "API key de Anthropic inválida. Revisa la configuración del servidor.";
  if (/context length|too many tokens|too large/i.test(inner))
    return "La conversación es demasiado larga. Reinicia el chat para continuar.";
  if (/not found/i.test(inner) && error.status === 404)
    return "Modelo o recurso no encontrado. Revisa la configuración.";
  return `Error del servicio de IA (código ${error.status}). Intenta de nuevo.`;
}

// Attach a rolling cache breakpoint to the most-recently-appended turn. In the
// agent loop the message history is append-only, so the cached prefix stays
// byte-stable and every turn reads the prior conversation from cache (~0.1x)
// instead of reprocessing the accumulated tool_use/tool_result history at full
// input price. The static system+tools prefix keeps its own breakpoint; this is
// the second of the 4 allowed per request.
function withRollingCacheBreakpoint(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];

  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : [...last.content];

  if (blocks.length === 0) return messages;

  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: "ephemeral" },
  } as Anthropic.ContentBlockParam;

  const next = [...messages];
  next[lastIndex] = { ...last, content: blocks };
  return next;
}

export async function POST(req: Request) {
  // El asistente no existe para un alcance que oculta su pestaña (lib/scopes.ts).
  if (!(await scopeHasTab("conversations"))) return forbiddenTab();
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY no está configurada en el servidor" },
      { status: 500 }
    );
  }

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "Faltan messages" }, { status: 400 });
  }
  if (typeof body.datasetSummary !== "string") {
    return NextResponse.json({ error: "Falta datasetSummary" }, { status: 400 });
  }

  const client = new Anthropic();

  try {
    const tz = body.userTimezone ?? "America/Mexico_City";
    const now = new Date();
    const today = now.toLocaleDateString("es-MX", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: tz,
    });
    const time = now.toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: tz,
    });

    const tools = body.writeEnabled
      ? [...TOOL_DEFINITIONS, ...WRITE_TOOL_DEFINITIONS]
      : TOOL_DEFINITIONS;

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: body.maxTokens ?? 4096,
      system: [
        {
          type: "text",
          text: ASSISTANT_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: body.datasetSummary,
          cache_control: { type: "ephemeral" },
        },
        // El bloque de reglas de escritura va DESPUÉS de los dos breakpoints
        // cacheados y sin cache_control, así que el toggle no invalida el prefijo.
        ...(body.writeEnabled ? [{ type: "text" as const, text: WRITE_MODE_RULES }] : []),
        {
          type: "text",
          text: `Fecha y hora actuales: ${today}, ${time} (zona horaria ${tz}). Usa esto para resolver referencias relativas como "hoy", "ayer", "esta semana", "esta mañana" o "ahora".`,
        },
      ],
      tools: tools as unknown as Anthropic.Tool[],
      messages: withRollingCacheBreakpoint(body.messages),
    });

    return NextResponse.json({
      stopReason: response.stop_reason,
      content: response.content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({ error: "API key de Anthropic inválida" }, { status: 500 });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "Límite de tasa alcanzado, intenta de nuevo en un momento" },
        { status: 429 }
      );
    }
    if (error instanceof Anthropic.APIError) {
      console.error("[/api/chat] Anthropic error:", error.status, error.message);
      return NextResponse.json(
        { error: translateAnthropicError(error) },
        { status: 502 }
      );
    }
    console.error("[/api/chat] Unknown error:", error);
    return NextResponse.json(
      { error: "Error desconocido en el chat" },
      { status: 500 }
    );
  }
}

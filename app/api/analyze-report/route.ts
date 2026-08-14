import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

// ─── Request types ────────────────────────────────────────────────────────────

interface SectionPayload {
  id: string;
  title: string;
  data: unknown[];
}

interface AnalyzeReportBody {
  reportType: "marketing" | "ventas";
  periodLabel?: string;
  filtersLabel?: string;
  kpis: { label: string; value: string }[];
  sections: SectionPayload[];
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un analista senior de marketing y ventas para inmobiliarias que usan Lezgo Suite CRM. Recibirás los datos agregados (KPIs y series de gráficos) de un dashboard, ya filtrados al periodo indicado.

Responde ÚNICAMENTE con JSON válido, sin markdown ni texto extra, con esta forma exacta:
{"summary": "...", "sections": [{"id": "...", "analysis": "..."}]}

Reglas:
- "summary": resumen ejecutivo de 3 a 5 oraciones con los hallazgos más importantes del periodo (volumen, conversión, mejores/peores fuentes, riesgos) y una recomendación concreta.
- OBLIGATORIO: una entrada en "sections" por CADA sección recibida, usando su mismo "id". Ninguna sección puede quedarse sin análisis: cada gráfica del reporte debe ir explicada.
- Cada "analysis": 2 a 3 oraciones que expliquen ESA gráfica: qué está pasando en los datos (tendencias, concentraciones, caídas de conversión, causas de pérdida), no qué tipo de gráfica es. Sé específico con números y porcentajes de los datos. Termina con una implicación o acción cuando aplique.
- Todo en español. Tono profesional y directo.
- NUNCA menciones "GoHighLevel" ni "GHL" (la plataforma es "Lezgo Suite CRM").
- No inventes datos que no estén en el payload. Si una sección tiene muy pocos datos, dilo brevemente.`;

// ─── JSON extraction ──────────────────────────────────────────────────────────

interface AiJson {
  summary?: unknown;
  sections?: Array<{ id?: unknown; analysis?: unknown }>;
}

// Tolerate code fences or stray prose around the JSON object.
function extractJson(text: string): AiJson | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as AiJson;
  } catch {
    return null;
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY no está configurada en el servidor" },
      { status: 500 }
    );
  }

  let body: AnalyzeReportBody;
  try {
    body = (await req.json()) as AnalyzeReportBody;
  } catch {
    return NextResponse.json({ error: "Cuerpo de petición inválido" }, { status: 400 });
  }

  if (!body.reportType || !Array.isArray(body.sections) || body.sections.length === 0) {
    return NextResponse.json(
      { error: "Faltan campos requeridos: reportType, sections" },
      { status: 400 }
    );
  }

  const userContent = [
    `Tipo de reporte: ${body.reportType === "marketing" ? "Marketing (adquisición)" : "Ventas (comercial)"}`,
    `Periodo: ${body.periodLabel ?? "Todo el historial"}`,
    // Sin esto el modelo lee un subconjunto filtrado como si fuera el total del
    // periodo y concluye caídas que no existen.
    `Filtros aplicados: ${body.filtersLabel ?? "ninguno (todo el panel)"}`,
    `KPIs: ${JSON.stringify(body.kpis ?? [])}`,
    `Secciones a analizar:`,
    JSON.stringify(body.sections),
  ].join("\n\n");

  const client = new Anthropic();

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      // Every panel chart is now a section (~13 for marketing, ~8 for ventas),
      // each needing 2–3 sentences plus the executive summary.
      max_tokens: 8000,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
    });

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    const parsed = textBlock ? extractJson(textBlock.text) : null;
    if (!parsed) {
      return NextResponse.json(
        { error: "La IA no devolvió JSON válido" },
        { status: 502 }
      );
    }

    const analyses: Record<string, string> = {};
    for (const s of parsed.sections ?? []) {
      if (typeof s?.id === "string" && typeof s?.analysis === "string" && s.analysis.trim()) {
        analyses[s.id] = s.analysis.trim();
      }
    }

    return NextResponse.json({
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      analyses,
    });
  } catch (error) {
    console.error("[analyze-report]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al generar el análisis" },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { extractText, getDocumentProxy } from "unpdf";
import { buildTableSummary, type ProcessedAttachment } from "@/lib/attachments";
import { forbiddenTab, scopeHasTab } from "@/lib/session";

// Parses PDF (unpdf) and CSV/Excel (xlsx) uploads into normalized
// ProcessedAttachment objects for the AI assistant. Touches no GHL — only the
// middleware gate applies (no requireClient/withClient needed).

export const runtime = "nodejs";

const MAX_PDF = 32 * 1024 * 1024;
const MAX_TABULAR = 25 * 1024 * 1024;

// Below this many non-whitespace chars we treat a PDF as scanned/imagey and fall
// back to sending it as a native document block so Claude can read it visually.
const MIN_PDF_TEXT = 40;

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

async function processPdf(filename: string, buf: Uint8Array): Promise<ProcessedAttachment> {
  const pdf = await getDocumentProxy(buf);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  if (text.replace(/\s/g, "").length >= MIN_PDF_TEXT) {
    return { kind: "pdf_text", filename, text, pageCount: totalPages };
  }
  const base64 = Buffer.from(buf).toString("base64");
  return { kind: "pdf_visual", filename, mediaType: "application/pdf", dataBase64: base64 };
}

function processTabular(filename: string, buf: Uint8Array): ProcessedAttachment[] {
  const wb = XLSX.read(buf, { type: "array" });
  const out: ProcessedAttachment[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    if (rows.length === 0) continue;
    const { schema, stats, sampleRows } = buildTableSummary(rows, { sampleSize: 8 });
    out.push({
      kind: "table",
      filename,
      sheetName: wb.SheetNames.length > 1 ? sheetName : undefined,
      schema,
      rowCount: rows.length,
      sampleRows,
      stats,
      rows,
    });
  }
  return out;
}

export async function POST(req: Request) {
  // El asistente no existe para un alcance que oculta su pestaña (lib/scopes.ts).
  if (!(await scopeHasTab("conversations"))) return forbiddenTab();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Se esperaba multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo" }, { status: 400 });
  }

  const name = file.name || "archivo";
  const kind = ext(name);
  const buf = new Uint8Array(await file.arrayBuffer());

  try {
    if (kind === "pdf") {
      if (buf.byteLength > MAX_PDF) return NextResponse.json({ error: "PDF supera 32 MB" }, { status: 413 });
      return NextResponse.json({ results: [await processPdf(name, buf)] });
    }
    if (kind === "csv" || kind === "xlsx" || kind === "xls") {
      if (buf.byteLength > MAX_TABULAR) return NextResponse.json({ error: "Archivo supera 25 MB" }, { status: 413 });
      const results = processTabular(name, buf);
      if (results.length === 0)
        return NextResponse.json({ error: "El archivo no tiene filas legibles" }, { status: 422 });
      return NextResponse.json({ results });
    }
    return NextResponse.json({ error: `Tipo no soportado: .${kind}` }, { status: 415 });
  } catch (err) {
    console.error("[/api/attachments/process] error:", err);
    return NextResponse.json({ error: "No se pudo procesar el archivo" }, { status: 500 });
  }
}

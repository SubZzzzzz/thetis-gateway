/**
 * read_pdf tool — Extract text from PDFs with automatic OCR fallback and chunking.
 *
 * Works from TUI and gateways (WhatsApp/Discord).
 * Non-blocking: returns one chunk at a time to avoid context overflow.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_CHUNK_SIZE = 5;
const MAX_TEXT_LENGTH = 10_000; // Max characters per chunk
const MIN_TEXT_RATIO = 0.1; // If extracted text < 10% of expected, trigger OCR

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface PdfInfo {
  pages: number;
  title?: string;
  author?: string;
}

/** Check if a binary is available in PATH */
async function hasBinary(name: string): Promise<boolean> {
  try {
    await execFileAsync("which", [name]);
    return true;
  } catch {
    return false;
  }
}

/** Get PDF metadata (page count, etc.) via pdfinfo */
async function getPdfInfo(pdfPath: string): Promise<PdfInfo> {
  const { stdout } = await execFileAsync("pdfinfo", [pdfPath], {
    timeout: 10_000,
  });

  const pages = parseInt(
    stdout.split("\n").find((l) => l.startsWith("Pages:"))?.split(":")[1]?.trim() || "0",
    10
  );

  const title = stdout
    .split("\n")
    .find((l) => l.startsWith("Title:"))
    ?.split(":")
    .slice(1)
    .join(":")
    .trim();

  const author = stdout
    .split("\n")
    .find((l) => l.startsWith("Author:"))
    ?.split(":")
    .slice(1)
    .join(":")
    .trim();

  if (!pages || pages <= 0) {
    throw new Error("Impossible de déterminer le nombre de pages du PDF.");
  }

  return { pages, title, author };
}

/** Extract text from specific pages using pdftotext */
async function extractText(pdfPath: string, firstPage: number, lastPage: number): Promise<string> {
  const { stdout } = await execFileAsync(
    "pdftotext",
    ["-f", String(firstPage), "-l", String(lastPage), "-layout", pdfPath, "-"],
    { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout;
}

/** OCR a range of pages using pdftoppm + tesseract */
async function ocrPages(pdfPath: string, firstPage: number, lastPage: number): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-pdf-ocr-"));
  const texts: string[] = [];

  try {
    // Convert pages to images (one at a time to limit memory)
    for (let page = firstPage; page <= lastPage; page++) {
      const imgPrefix = path.join(tmpDir, `page-${page}`);

      // Convert single page to PNG at 300 DPI
      await execFileAsync(
        "pdftoppm",
        ["-png", "-r", "300", "-f", String(page), "-l", String(page), pdfPath, imgPrefix],
        { timeout: 30_000 }
      );

      // Find the generated image file
      const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`page-${page}`));
      if (files.length === 0) continue;

      const imgPath = path.join(tmpDir, files[0]);

      // Run tesseract OCR
      try {
        const { stdout } = await execFileAsync(
          "tesseract",
          [imgPath, "stdout", "-l", "fra+eng"],
          { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 }
        );
        texts.push(`--- Page ${page} ---\n${stdout.trim()}`);
      } catch (err: any) {
        texts.push(`--- Page ${page} ---\n[OCR error: ${err.message}]`);
      }

      // Clean up image file immediately
      try {
        fs.unlinkSync(imgPath);
      } catch {}
    }
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  return texts.join("\n\n");
}

/** Parse a page range string like "1-5" or "1,3,7" into an array of page numbers */
function parsePageRange(pagesStr: string, totalPages: number): number[] {
  const pages = new Set<number>();

  const parts = pagesStr.split(",").map((s) => s.trim());
  for (const part of parts) {
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = Math.max(1, parseInt(startStr, 10));
      const end = Math.min(totalPages, parseInt(endStr, 10));
      if (isNaN(start) || isNaN(end) || start > end) continue;
      for (let i = start; i <= end; i++) pages.add(i);
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= 1 && num <= totalPages) pages.add(num);
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

/** Truncate text to max length, trying to break at a word boundary */
function truncateText(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (text.length <= maxLen) return { text, truncated: false };
  const truncated = text.slice(0, maxLen);
  // Try to break at last newline before limit
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > maxLen * 0.8) {
    return { text: truncated.slice(0, lastNewline), truncated: true };
  }
  // Otherwise break at last space
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.8) {
    return { text: truncated.slice(0, lastSpace) + "...", truncated: true };
  }
  return { text: truncated + "...", truncated: true };
}

/* ------------------------------------------------------------------ */
/*  Tool definition                                                    */
/* ------------------------------------------------------------------ */

const ReadPdfParams = Type.Object({
  path: Type.String({ description: "Chemin absolu ou relatif vers le fichier PDF" }),
  pages: Type.Optional(
    Type.String({
      description:
        'Pages à extraire : "1-5" ou "1,3,7" ou "all" (défaut: utilise le chunking automatique)',
    })
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("ocr")], {
      description:
        'Mode d\'extraction : "text" (défaut, avec fallback OCR auto si le texte est insuffisant), "ocr" (force OCR)',
    })
  ),
  chunk: Type.Optional(
    Type.Number({
      description: `Nombre de pages par chunk (défaut: ${DEFAULT_CHUNK_SIZE})`,
    })
  ),
  chunkIndex: Type.Optional(
    Type.Number({
      description: "Index du chunk à retourner (0-based). Omettre pour obtenir le premier chunk.",
    })
  ),
});

export function registerReadPdfTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_pdf",
    label: "Read PDF",
    description:
      "Extrait le texte d'un fichier PDF avec chunking automatique et OCR fallback. Utilisez cet outil pour lire les PDFs — ne pas utiliser pdftotext/pdftoppm manuellement.",
    promptGuidelines: [
      "Use read_pdf to extract text from PDF files. Do NOT use pdftotext or pdftoppm manually.",
      "The tool returns one chunk at a time (default: 5 pages). If hasMore is true, call read_pdf again with chunkIndex incremented.",
      "OCR is automatic when text extraction yields insufficient content. You can force OCR with mode: 'ocr'.",
      "For large PDFs, iterate through chunks: chunkIndex 0, 1, 2, etc. until hasMore is false.",
    ],
    parameters: ReadPdfParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await executeReadPdf(params);

      if (result.error) {
        return {
          content: [{ type: "text", text: `❌ Erreur : ${result.error}` }],
          details: result,
          isError: true,
        };
      }

      // Format output for the LLM
      let output = `📄 PDF : ${result.path}\n`;
      output += `📊 Pages totales : ${result.totalPages}\n`;
      if (result.title) output += `📌 Titre : ${result.title}\n`;
      if (result.author) output += `✍️ Auteur : ${result.author}\n`;
      output += `\n--- Chunk ${result.chunk + 1}/${result.totalChunks} (pages ${result.pages}) `;
      if (result.usedOcr) output += "[OCR] ";
      output += `---\n\n`;
      output += result.content;

      if (result.hasMore) {
        output += `\n\n⏩ Il reste ${result.totalChunks - result.chunk - 1} chunk(s). Appelez read_pdf avec chunkIndex: ${result.chunk + 1} pour la suite.`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: result,
      };
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Core logic (separated for testability)                             */
/* ------------------------------------------------------------------ */

interface ReadPdfResult {
  success: boolean;
  error?: string;
  path: string;
  totalPages: number;
  title?: string;
  author?: string;
  chunk: number;
  totalChunks: number;
  pages: string;
  content: string;
  hasMore: boolean;
  usedOcr: boolean;
}

async function executeReadPdf(params: Static<typeof ReadPdfParams>): Promise<ReadPdfResult> {
  // Resolve path
  let pdfPath = params.path;
  if (!path.isAbsolute(pdfPath)) {
    pdfPath = path.resolve(process.cwd(), pdfPath);
  }

  // Check file exists
  if (!fs.existsSync(pdfPath)) {
    return {
      success: false,
      error: `Fichier introuvable : ${pdfPath}`,
      path: pdfPath,
      totalPages: 0,
      chunk: 0,
      totalChunks: 0,
      pages: "",
      content: "",
      hasMore: false,
      usedOcr: false,
    };
  }

  // Check it's a PDF
  if (!pdfPath.toLowerCase().endsWith(".pdf")) {
    return {
      success: false,
      error: "Le fichier n'est pas un PDF (extension .pdf requise).",
      path: pdfPath,
      totalPages: 0,
      chunk: 0,
      totalChunks: 0,
      pages: "",
      content: "",
      hasMore: false,
      usedOcr: false,
    };
  }

  // Get PDF info
  let info: PdfInfo;
  try {
    info = await getPdfInfo(pdfPath);
  } catch (err: any) {
    return {
      success: false,
      error: `PDF invalide ou corrompu : ${err.message}`,
      path: pdfPath,
      totalPages: 0,
      chunk: 0,
      totalChunks: 0,
      pages: "",
      content: "",
      hasMore: false,
      usedOcr: false,
    };
  }

  const totalPages = info.pages;
  const chunkSize = params.chunk || DEFAULT_CHUNK_SIZE;

  // Determine page range
  let pageStart: number;
  let pageEnd: number;
  let chunkIndex: number;
  let totalChunks: number;
  let pagesLabel: string;

  if (params.pages && params.pages !== "all") {
    // Explicit page range — no chunking
    const pageList = parsePageRange(params.pages, totalPages);
    if (pageList.length === 0) {
      return {
        success: false,
        error: `Aucune page valide dans la plage "${params.pages}" (PDF a ${totalPages} pages).`,
        path: pdfPath,
        totalPages,
        chunk: 0,
        totalChunks: 1,
        pages: params.pages,
        content: "",
        hasMore: false,
        usedOcr: false,
      };
    }
    pageStart = pageList[0];
    pageEnd = pageList[pageList.length - 1];
    chunkIndex = 0;
    totalChunks = 1;
    pagesLabel = pageList.join(", ");
  } else {
    // Chunking mode
    chunkIndex = params.chunkIndex || 0;
    totalChunks = Math.ceil(totalPages / chunkSize);

    if (chunkIndex >= totalChunks) {
      return {
        success: false,
        error: `chunkIndex ${chunkIndex} hors limites (totalChunks: ${totalChunks}, index max: ${totalChunks - 1}).`,
        path: pdfPath,
        totalPages,
        chunk: chunkIndex,
        totalChunks,
        pages: "",
        content: "",
        hasMore: false,
        usedOcr: false,
      };
    }

    pageStart = chunkIndex * chunkSize + 1;
    pageEnd = Math.min((chunkIndex + 1) * chunkSize, totalPages);
    pagesLabel = pageStart === pageEnd ? `${pageStart}` : `${pageStart}-${pageEnd}`;
  }

  // Extract text
  const forceOcr = params.mode === "ocr";
  let content = "";
  let usedOcr = false;

  try {
    if (forceOcr) {
      // Force OCR mode
      const tesseractAvailable = await hasBinary("tesseract");
      if (!tesseractAvailable) {
        return {
          success: false,
          error: "Mode OCR forcé mais tesseract n'est pas installé. Installez-le avec : sudo apt install tesseract-ocr tesseract-ocr-fra",
          path: pdfPath,
          totalPages,
          chunk: chunkIndex,
          totalChunks,
          pages: pagesLabel,
          content: "",
          hasMore: false,
          usedOcr: false,
        };
      }
      content = await ocrPages(pdfPath, pageStart, pageEnd);
      usedOcr = true;
    } else {
      // Try text extraction first
      content = await extractText(pdfPath, pageStart, pageEnd);

      // Check if text is sufficient
      const expectedChars = (pageEnd - pageStart + 1) * 200; // rough estimate: 200 chars/page minimum
      if (content.trim().length < expectedChars * MIN_TEXT_RATIO) {
        // Text extraction yielded too little — fallback to OCR
        const tesseractAvailable = await hasBinary("tesseract");
        if (tesseractAvailable) {
          content = await ocrPages(pdfPath, pageStart, pageEnd);
          usedOcr = true;
        }
        // If tesseract not available, return whatever text we got
      }
    }
  } catch (err: any) {
    return {
      success: false,
      error: `Erreur lors de l'extraction : ${err.message}`,
      path: pdfPath,
      totalPages,
      chunk: chunkIndex,
      totalChunks,
      pages: pagesLabel,
      content: "",
      hasMore: chunkIndex < totalChunks - 1,
      usedOcr: false,
    };
  }

  // Truncate if too long
  const { text: truncatedContent, truncated } = truncateText(content, MAX_TEXT_LENGTH);

  if (truncated) {
    truncatedContent += `\n\n[Texte tronqué à ${MAX_TEXT_LENGTH} caractères. Appelez read_pdf avec pages: "${pageStart}-${pageEnd}" et mode: "ocr" pour plus de détails si nécessaire.]`;
  }

  const hasMore = chunkIndex < totalChunks - 1;

  return {
    success: true,
    path: pdfPath,
    totalPages,
    title: info.title,
    author: info.author,
    chunk: chunkIndex,
    totalChunks,
    pages: pagesLabel,
    content: truncatedContent,
    hasMore,
    usedOcr,
  };
}

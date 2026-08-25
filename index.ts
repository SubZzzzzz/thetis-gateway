/**
 * Thetis Gateway Extension — Full Featured
 *
 * Discord & WhatsApp gateway for Pi with:
 * - Per-channel conversation threads (no cross-talk)
 * - Image relay (Discord attachments, WhatsApp media)
 * - Persistent thread history
 * - Memory integration (memory/learn_wizard results relayed back)
 * - Polite queuing (followUp when Pi is busy)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerReadPdfTool } from "./read-pdf";
// NOTE: @earendil-works/pi-tui (Container, Text) is imported dynamically
// below to avoid TypeScript resolution issues — pi's module loader resolves
// it at runtime, but it's not a direct dependency in the extension's
// package.json.

/* ------------------------------------------------------------------ */
/*  Paths                                                              */
/* ------------------------------------------------------------------ */

const EXT_DIR = path.join(__dirname);
// Data directory OUTSIDE the git repo to survive `pi update --extensions`
// (which runs `git clean -fdx` and deletes ignored files like config.json)
const DATA_DIR = path.join(homedir(), ".pi", "agent", "extensions-data", "thetis-gateway");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const THREADS_DIR = path.join(DATA_DIR, "threads");
const FILES_DIR = path.join(DATA_DIR, "files");

// Ensure DATA_DIR exists on module load
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Migrate existing data from EXT_DIR to DATA_DIR if needed (one-time)
function migrateFromExtDir() {
  const migrations = [
    { src: path.join(EXT_DIR, "config.json"), dst: path.join(DATA_DIR, "config.json") },
    { src: path.join(EXT_DIR, "threads"), dst: path.join(DATA_DIR, "threads") },
    { src: path.join(EXT_DIR, "files"), dst: path.join(DATA_DIR, "files") },
  ];
  // Also migrate any .baileys_auth_* directories
  try {
    for (const entry of fs.readdirSync(EXT_DIR)) {
      if (entry.startsWith(".baileys_auth_")) {
        migrations.push({
          src: path.join(EXT_DIR, entry),
          dst: path.join(DATA_DIR, entry),
        });
      }
    }
  } catch {}

  for (const { src, dst } of migrations) {
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.renameSync(src, dst);
        console.log(`[thetis-gateway] Migrated ${src} → ${dst}`);
      } catch (e) {
        console.error(`[thetis-gateway] Migration failed for ${src}:`, e);
      }
    }
  }
}
migrateFromExtDir();

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

interface GatewayConfig {
  discord?: {
    enabled: boolean;
    token?: string;
    allowedUserIds?: string[];
  };
  whatsapp?: {
    enabled: boolean;
    sessionName?: string;
    allowedPhoneNumbers?: string[];
  };
  autoStart?: boolean;
  maxHistoryPerThread?: number;
}

function loadConfig(): GatewayConfig {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as GatewayConfig;
  } catch {
    return {};
  }
}

function saveConfig(cfg: GatewayConfig): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

let config: GatewayConfig = loadConfig();

/* ------------------------------------------------------------------ */
/*  Authorization helpers                                              */
/* ------------------------------------------------------------------ */

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

function isDiscordAuthorized(userId: string): boolean {
  const allowed = config.discord?.allowedUserIds;
  if (!allowed || allowed.length === 0) return false;
  return allowed.includes(userId);
}

function isWhatsAppAuthorized(jidOrKey: string | { remoteJid?: string; remoteJidAlt?: string; participant?: string; participantAlt?: string }): boolean {
  const allowed = config.whatsapp?.allowedPhoneNumbers;
  if (!allowed || allowed.length === 0) return false;
  const allowedSet = new Set(allowed.map((a) => normalizePhone(a)));

  // Build a list of candidate identifiers (digits-only) from whichever
  // format the incoming message uses. Baileys v7 sends messages in
  // "addressingMode: lid" (new multi-device) with the LID as remoteJid and
  // the legacy phone-number JID as remoteJidAlt; older clients send the
  // reverse. We accept the message if ANY of these identifiers matches an
  // allowed phone number.
  const candidates = new Set<string>();
  const collect = (raw?: string) => {
    if (!raw) return;
    candidates.add(normalizePhone(raw.split("@")[0]));
    // For LIDs like "317877915898:11@lid" the part before ":" is opaque and
    // does not correspond to a phone number — skip it. Only the legacy
    // s.whatsapp.net JIDs (and group participant JIDs) carry phone numbers.
    if (raw.includes("@s.whatsapp.net")) {
      const phone = raw.split("@")[0].split(":")[0];
      candidates.add(normalizePhone(phone));
    }
  };

  if (typeof jidOrKey === "string") {
    collect(jidOrKey);
  } else {
    collect(jidOrKey.remoteJid);
    collect(jidOrKey.remoteJidAlt);
    collect(jidOrKey.participant);
    collect(jidOrKey.participantAlt);
  }

  for (const candidate of candidates) {
    if (candidate && allowedSet.has(candidate)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Thread Manager — per-channel conversation isolation                */
/* ------------------------------------------------------------------ */

function clearAllThreadHistories(): void {
  if (!fs.existsSync(THREADS_DIR)) return;
  for (const entry of fs.readdirSync(THREADS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      try {
        fs.unlinkSync(path.join(THREADS_DIR, entry.name));
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Files cleanup — remove uploaded files older than 24h               */
/* ------------------------------------------------------------------ */

const FILES_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function cleanupFilesDir(): void {
  if (!fs.existsSync(FILES_DIR)) return;
  const now = Date.now();
  let cleaned = 0;
  try {
    for (const entry of fs.readdirSync(FILES_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(FILES_DIR, entry.name);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > FILES_MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore directory read errors
  }
  if (cleaned > 0) {
    console.log(`[thetis-gateway] Cleaned up ${cleaned} stale file(s) from FILES_DIR`);
  }
}

// Periodic cleanup every hour
setInterval(cleanupFilesDir, 60 * 60 * 1000);

interface ThreadMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  hasImage?: boolean;
  imageUrl?: string;
}

interface ChannelThread {
  platform: "discord" | "whatsapp";
  channelId: string;
  messages: ThreadMessage[];
  pendingQueue: { text: string; images?: any[] }[];
  processing: boolean;
  pendingMessageId?: string;
  typingInterval?: NodeJS.Timeout;
  retryCount?: number;
  maxRetries?: number;
  lastUserMessage?: { text: string; images?: any[] };
  retryTimer?: NodeJS.Timeout;
  // Error handling improvements
  isProcessingRetry?: boolean; // Flag to prevent retry loops
  errorCycles?: number; // Number of consecutive error cycles
  circuitBreakerUntil?: number; // Timestamp until which retries are blocked
  lastErrorMessage?: string; // For deduplication
  lastErrorTimestamp?: number; // Timestamp of last error
  lastProcessedMessage?: { text: string; images?: any[]; timestamp: number }; // For message deduplication
  hasFatalContextError?: boolean; // True when an error is caused by message content (e.g. invalid image). Blocks retries until a clean message is sent.
  piExhaustedRetries?: boolean; // True when agent_end fires with willRetry=false (pi's System A done)
  errorMessagesSent?: number; // Error messages sent per episode (max 3 visible)
  errorEpisodeActive?: boolean; // True during an error episode — prevents "stop" from resetting counters
}

const threads = new Map<string, ChannelThread>();
let currentThreadId: string | null = null;
let activeCtx: ExtensionContext | null = null;

const fallbackCtx: ExtensionContext = {
  mode: "rpc",
  hasUI: false,
  ui: {
    notify: () => {},
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingIndicator: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setWidget: () => {},
    setTitle: () => {},
    setEditorComponent: () => {},
    setEditorText: () => {},
    getEditorText: async () => "",
    getAllThemes: async () => [],
    getTheme: async () => undefined,
    setTheme: async () => ({ success: false, error: "No UI" }),
    pasteToEditor: () => {},
    custom: async () => undefined,
    getToolsExpanded: async () => false,
    setToolsExpanded: () => {},
  },
} as unknown as ExtensionContext;

function getGatewayCtx(): ExtensionContext {
  return activeCtx ?? fallbackCtx;
}

let lastActiveThreadId: string | null = null;
let restartNotified = false;

// Track current model info for /new confirmation messages
let currentModelInfo = { name: "default", provider: "unknown", contextWindow: 128000 };
// Track IDs of messages we sent so we can ignore their Baileys echoes
// (every outgoing sendMessage triggers a messages.upsert with fromMe=true).
const sentMessageIds = new Set<string>();
const SENT_ID_TTL_MS = 60_000;

function getThreadId(platform: "discord" | "whatsapp", channelId: string): string {
  return `${platform}:${channelId}`;
}

function getOrCreateThread(platform: "discord" | "whatsapp", channelId: string): ChannelThread {
  const id = getThreadId(platform, channelId);
  if (!threads.has(id)) {
    const thread: ChannelThread = {
      platform,
      channelId,
      messages: loadThreadHistory(id),
      pendingQueue: [],
      processing: false,
      retryCount: 0,
      maxRetries: 5,
      isProcessingRetry: false,
      errorCycles: 0,
      circuitBreakerUntil: undefined,
      lastErrorMessage: undefined,
      lastErrorTimestamp: undefined,
      lastProcessedMessage: undefined,
      hasFatalContextError: false,
      piExhaustedRetries: false,
      errorMessagesSent: 0,
      errorEpisodeActive: false,
    };
    threads.set(id, thread);
  }
  return threads.get(id)!;
}

function loadThreadHistory(threadId: string): ThreadMessage[] {
  const file = path.join(THREADS_DIR, `${threadId}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function saveThreadHistory(threadId: string, messages: ThreadMessage[]): void {
  if (!fs.existsSync(THREADS_DIR)) fs.mkdirSync(THREADS_DIR, { recursive: true });
  const max = config.maxHistoryPerThread ?? 100;
  const trimmed = messages.slice(-max);
  fs.writeFileSync(
    path.join(THREADS_DIR, `${threadId}.json`),
    JSON.stringify(trimmed, null, 2) + "\n",
    "utf8"
  );
}

function isTextFile(filename: string): boolean {
  const textExts = [".txt", ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".py", ".sh", ".bash", ".zsh", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".log", ".csv", ".html", ".css", ".sql", ".c", ".cpp", ".h", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".swift", ".r", ".dart", ".lua"];
  const ext = path.extname(filename).toLowerCase();
  return textExts.includes(ext);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/* ------------------------------------------------------------------ */
/*  Pending Questions — for gateway_question tool                       */
/* ------------------------------------------------------------------ */

interface PendingQuestion {
  question: string;
  options: string[];
  resolve: (value: { answer: string; wasCustom: boolean }) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  waitingForCustom: boolean;
  platform: "discord" | "whatsapp";
  messageId?: string;
}

const pendingQuestions = new Map<string, PendingQuestion>();

function resolveQuestion(threadId: string, answer: string, wasCustom: boolean): void {
  const pending = pendingQuestions.get(threadId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingQuestions.delete(threadId);
  pending.resolve({ answer, wasCustom });
}

function rejectQuestion(threadId: string, reason: string): void {
  const pending = pendingQuestions.get(threadId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingQuestions.delete(threadId);
  pending.reject(new Error(reason));
}

/* ------------------------------------------------------------------ */
/*  Memory Confirmation (cross-extension)                            */
/* ------------------------------------------------------------------ */

interface PendingMemoryConfirmation {
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
  messageId?: string;
}

const pendingMemoryConfirmations = new Map<string, PendingMemoryConfirmation>();

function resolveMemoryConfirmation(threadId: string, approved: boolean): void {
  const pending = pendingMemoryConfirmations.get(threadId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingMemoryConfirmations.delete(threadId);
  pending.resolve(approved);
}

async function sendDiscordMemoryConfirmation(channelId: string, question: string): Promise<string | null> {
  if (!isDiscordReady()) return null;
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");

  const embed = new EmbedBuilder()
    .setTitle("🛡️ Memory vault")
    .setDescription(question)
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("gateway_mem:yes").setLabel("✅ Confirm").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("gateway_mem:no").setLabel("❌ Refuse").setStyle(ButtonStyle.Danger)
  );

  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;
  const msg = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
  return msg?.id ?? null;
}

async function disableDiscordMemoryButtons(channelId: string, messageId: string): Promise<void> {
  if (!isDiscordReady() || !messageId) return;
  const { ActionRowBuilder, ButtonBuilder } = await import("discord.js");
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.messages?.fetch !== "function") return;
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg || typeof msg.edit !== "function") return;
  const disabledRows = msg.components?.map((row: any) => {
    const newRow = new ActionRowBuilder();
    row.components.forEach((comp: any) => {
      if (comp.data?.type === 2) {
        const btn = new ButtonBuilder(comp.data).setDisabled(true);
        newRow.addComponents(btn);
      } else {
        newRow.addComponents(comp);
      }
    });
    return newRow;
  }) ?? [];
  await msg.edit({ components: disabledRows }).catch(() => null);
}

async function sendWhatsAppMemoryConfirmation(jid: string, question: string): Promise<void> {
  if (!isWhatsAppReady()) return;

  await whatsappSock.sendMessage(jid, {
    text: `🛡️ ${question}`,
    footer: "Memory vault confirmation",
    title: "Confirm action",
    buttonText: "Choose",
    sections: [{
      title: "Confirm or refuse",
      rows: [
        { title: "✅ Confirm", description: "Apply the change", rowId: "gateway_mem_yes" },
        { title: "❌ Refuse", description: "Cancel the change", rowId: "gateway_mem_no" },
      ],
    }],
  }).catch(() => null);
}

// Exposed to thetis-memory extension (same Node process)
(globalThis as any).__gatewayConfirm = async (question: string): Promise<boolean | null> => {
  const threadId = currentThreadId;
  if (!threadId) return null;
  const thread = threads.get(threadId);
  if (!thread) return null;

  let messageId: string | undefined;
  if (thread.platform === "discord") {
    messageId = await sendDiscordMemoryConfirmation(thread.channelId, question) ?? undefined;
  } else if (thread.platform === "whatsapp") {
    await sendWhatsAppMemoryConfirmation(thread.channelId, question);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const p = pendingMemoryConfirmations.get(threadId);
      if (p) {
        if (p.messageId) disableDiscordMemoryButtons(thread.channelId, p.messageId);
        pendingMemoryConfirmations.delete(threadId);
      }
      resolve(false);
    }, 120_000);
    pendingMemoryConfirmations.set(threadId, { resolve, timeout, messageId });
  });
};

/* ------------------------------------------------------------------ */
/*  Discord Poll — interactive buttons                                */
/* ------------------------------------------------------------------ */

async function sendDiscordPoll(channelId: string, question: string, options: string[]): Promise<string | null> {
  if (!isDiscordReady()) return null;
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");

  const embed = new EmbedBuilder()
    .setTitle("🗳️ Sondage")
    .setDescription(question)
    .setColor(0x5865f2);

  const rows: any[] = [];
  const chunkSize = 5;
  let otherBtnPlaced = false;

  for (let i = 0; i < options.length; i += chunkSize) {
    const row = new ActionRowBuilder();
    const chunk = options.slice(i, i + chunkSize);
    for (let j = 0; j < chunk.length; j++) {
      const btn = new ButtonBuilder()
        .setCustomId(`gateway_q:${i + j}`)
        .setLabel(`${i + j + 1}. ${chunk[j].slice(0, 80)}`)
        .setStyle(ButtonStyle.Primary);
      row.addComponents(btn);
    }
    // If last chunk and there's room, add "Autres..." button
    if (i + chunk.length >= options.length && chunk.length < chunkSize) {
      const otherBtn = new ButtonBuilder()
        .setCustomId("gateway_q:other")
        .setLabel("✏️ Autres...")
        .setStyle(ButtonStyle.Secondary);
      row.addComponents(otherBtn);
      otherBtnPlaced = true;
    }
    rows.push(row);
  }

  if (!otherBtnPlaced) {
    const otherRow = new ActionRowBuilder();
    const otherBtn = new ButtonBuilder()
      .setCustomId("gateway_q:other")
      .setLabel("✏️ Autres...")
      .setStyle(ButtonStyle.Secondary);
    otherRow.addComponents(otherBtn);
    rows.push(otherRow);
  }

  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;
  const msg = await channel.send({ embeds: [embed], components: rows }).catch(() => null);
  return msg?.id ?? null;
}

async function disableDiscordPollButtons(channelId: string, messageId: string): Promise<void> {
  if (!isDiscordReady() || !messageId) return;
  const { ActionRowBuilder, ButtonBuilder } = await import("discord.js");
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.messages?.fetch !== "function") return;
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg || typeof msg.edit !== "function") return;
  const disabledRows = msg.components?.map((row: any) => {
    const newRow = new ActionRowBuilder();
    row.components.forEach((comp: any) => {
      if (comp.data?.type === 2) {
        const btn = new ButtonBuilder(comp.data).setDisabled(true);
        newRow.addComponents(btn);
      } else {
        newRow.addComponents(comp);
      }
    });
    return newRow;
  }) ?? [];
  await msg.edit({ components: disabledRows }).catch(() => null);
}

/* ------------------------------------------------------------------ */
/*  WhatsApp Poll — interactive list message                          */
/* ------------------------------------------------------------------ */

async function sendWhatsAppPoll(jid: string, question: string, options: string[]): Promise<boolean> {
  if (!isWhatsAppReady()) {
    console.error('[gateway] sendWhatsAppPoll: WhatsApp not ready');
    return false;
  }

  try {
    // WhatsApp doesn't support buttons/lists for non-Business accounts
    // Always use numbered text format with fallback
    const optionsText = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
    const messageText = `🗳️ *${question}*\n\n${optionsText}\n${options.length + 1}. ✏️ Autres...\n\n_Répondez avec le numéro de votre choix (1-${options.length + 1})._`;
    
    const result = await whatsappSock.sendMessage(jid, { text: messageText });
    console.log(`[gateway] sendWhatsAppPoll: text poll sent to ${jid}, messageId: ${result?.key?.id}`);
    return true;
  } catch (err) {
    console.error('[gateway] sendWhatsAppPoll: failed to send poll:', err);
    return false;
  }
}

function checkQuestionResponse(threadId: string, text: string): { handled: boolean; consume: boolean } {
  const pending = pendingQuestions.get(threadId);
  if (!pending) return { handled: false, consume: false };

  const trimmed = text.trim();

  // Phase 2 : on attend un texte libre après "Autres..."
  if (pending.waitingForCustom) {
    resolveQuestion(threadId, trimmed, true);
    return { handled: true, consume: true };
  }

  // Discord: les boutons gèrent la sélection directe. Le texte ici n'est
  // interprété que pour "Autres..." (déclenché par interaction) ou fallback.
  // WhatsApp: la listResponseMessage est traitée avant d'arriver ici.
  // Donc on ne traite que le fallback texte libre si l'utilisateur écrit
  // explicitement une réponse sans passer par le menu.

  const otherIndex = pending.options.length;
  const num = parseInt(trimmed, 10);

  // Détection "Autres" par numéro ou mot-clé (fallback uniquement)
  const isOtherByNumber = !isNaN(num) && num === otherIndex + 1;
  const isOtherByText = /^autre/i.test(trimmed);

  if (isOtherByNumber || isOtherByText) {
    pending.waitingForCustom = true;
    const thread = threads.get(threadId);
    if (thread?.platform === "discord") {
      sendDiscordReply(thread.channelId, "💬 Veuillez écrire votre réponse personnalisée :");
    } else if (thread?.platform === "whatsapp") {
      sendWhatsAppReply(thread.channelId, "💬 Veuillez écrire votre réponse personnalisée :");
    }
    return { handled: true, consume: true };
  }

  // Fallback : match par numéro d'option (WhatsApp si list message non supporté)
  if (!isNaN(num) && num >= 1 && num <= pending.options.length) {
    resolveQuestion(threadId, pending.options[num - 1], false);
    return { handled: true, consume: true };
  }

  // Fallback : match par texte exact
  const exactMatch = pending.options.find(
    (opt) => opt.toLowerCase() === trimmed.toLowerCase()
  );
  if (exactMatch) {
    resolveQuestion(threadId, exactMatch, false);
    return { handled: true, consume: true };
  }

  return { handled: false, consume: false };
}

/* ------------------------------------------------------------------ */
/*  Pi Command Interceptor                                             */
/* ------------------------------------------------------------------ */

async function replyToThread(thread: ChannelThread, text: string): Promise<void> {
  if (thread.platform === "discord") {
    await sendDiscordReply(thread.channelId, text);
  } else if (thread.platform === "whatsapp") {
    await sendWhatsAppReply(thread.channelId, text);
  }
}

const PI_TUI_ONLY_COMMANDS = new Set([
  "tree", "settings", "trust", "scoped-models", "hotkeys", "journey",
  "sk", "skin", "indicator", "timestamps", "ts", "statusbar", "sb",
  "snapshot", "snap", "paste", "image", "billing", "commands",
  "handoff", "prompt", "compose", "redraw", "history", "save",
  "quit", "exit", "cron", "plugins", "browser", "tools", "toolsets",
  "pet", "hatch",
]);

const PI_SILENT_COMMANDS = new Set([
  "new", "model", "name", "title", "compact", "stop",
  "thinking", "fork", "clone", "export", "import", "copy",
  "reload", "reload-mcp", "reload-skills", "learn", "personality",
  "fast", "verbose", "footer", "yolo", "reasoning", "codex-runtime",
  "voice", "update", "version", "debug", "kanban", "goal", "subgoal",
  "moa", "queue", "steer", "q", "background", "bg", "btw", "agents",
  "tasks", "memory", "skills", "bundles", "suggestions", "blueprint",
  "bp", "curator", "approve", "deny", "platform", "sethome",
  "usage", "credits", "insights", "topic", "retry", "undo",
  "restart",
]);

async function handlePiCommand(
  text: string,
  thread: ChannelThread,
  pi: ExtensionAPI
): Promise<{ handled: boolean; passthrough?: string }> {
  if (!text.startsWith("/")) return { handled: false };

  const match = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/);
  if (!match) return { handled: false };

  const cmd = match[1].toLowerCase();
  const args = (match[2] || "").trim();

  // TUI-only commands
  if (PI_TUI_ONLY_COMMANDS.has(cmd)) {
    await replyToThread(
      thread,
      `❌ La commande \`/${cmd}\` nécessite l'interface TUI. Veuillez l'utiliser depuis le terminal.`
    );
    return { handled: true };
  }

  // Commands that need arguments
  if ((cmd === "resume" || cmd === "switch") && !args) {
    await replyToThread(
      thread,
      `💡 Veuillez spécifier un nom de session : \`/${cmd} <nom>\``
    );
    return { handled: true };
  }

  // Silent commands that need gateway confirmation
  if (PI_SILENT_COMMANDS.has(cmd)) {
    // For /new, create a real new session via IPC (write to command file)
    // The wrapper script reads the file and sends the command to Pi via stdin
    // This avoids sending the command text to the LLM (saves tokens)
    if (cmd === "new") {
      thread.messages = [];
      saveThreadHistory(getThreadId(thread.platform, thread.channelId), []);
      
      // Send confirmation message immediately with current model info
      const usage = activeCtx?.getContextUsage?.();
      let tokens = "?";
      let window = currentModelInfo.contextWindow;
      let percent = "?";
      if (usage) {
        tokens = String(usage.tokens ?? "?");
        window = usage.contextWindow;
        percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
      }

      const modelName = currentModelInfo.name;
      const provider = currentModelInfo.provider;

      const infoMsg =
        `🆕 **Nouvelle session**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🤖 Modèle : **${modelName}** (${provider})\n` +
        `📊 Contexte : ${percent} (${tokens} / ${window} tokens)\n` +
        `🧹 Historique : vidé`;

      if (thread.platform === "discord") {
        await sendDiscordReply(thread.channelId, infoMsg);
      } else if (thread.platform === "whatsapp") {
        await sendWhatsAppReply(thread.channelId, infoMsg);
      }
      
      // Write new_session command to the command file
      // The wrapper script (pi-rpc-wrapper.sh) reads this and sends it to Pi
      const platform = process.env.GATEWAY_PLATFORM || "default";
      const cmdFile = `/tmp/thetis-gateway-cmd-${platform}`;
      try {
        fs.appendFileSync(cmdFile, '{"type": "new_session"}\n');
        console.log(`[thetis-gateway] Wrote new_session command to ${cmdFile}`);
      } catch (err) {
        console.error(`[thetis-gateway] Failed to write to ${cmdFile}:`, err);
      }
      
      // DO NOT send to LLM - just return handled
      return { handled: true };
    }

    // For /model, use Pi's model API directly instead of sending to LLM
    if (cmd === "model") {
      if (args) {
        // Change model: /model <name>
        const model = activeCtx?.modelRegistry?.find(null, args) || activeCtx?.modelRegistry?.find(args, null);
        if (model) {
          const success = await pi.setModel(model);
          if (success) {
            currentModelInfo = {
              name: model.name ?? model.id ?? args,
              provider: model.provider ?? "unknown",
              contextWindow: model.context_window ?? 128000,
            };
            await replyToThread(thread, `🤖 Modèle changé : **${currentModelInfo.name}** (${currentModelInfo.provider})`);
          } else {
            await replyToThread(thread, `❌ Impossible de changer de modèle (pas de clé API pour ${args})`);
          }
        } else {
          await replyToThread(thread, `❌ Modèle introuvable : ${args}`);
        }
      } else {
        // Show current model: /model
        const model = activeCtx?.model;
        const usage = activeCtx?.getContextUsage?.();
        if (model) {
          const modelName = model.name ?? model.id ?? "unknown";
          const provider = model.provider ?? "unknown";
          const contextWindow = usage?.contextWindow ?? model.context_window ?? 128000;
          const tokens = usage?.tokens ?? 0;
          const percent = usage?.percent ?? 0;
          await replyToThread(thread, `🤖 Modèle actuel : **${modelName}** (${provider})\n📊 Contexte : ${tokens} / ${contextWindow} tokens (${percent.toFixed(1)}%)`);
        } else {
          await replyToThread(thread, `🤖 Modèle actuel : ${currentModelInfo.name} (${currentModelInfo.provider})`);
        }
      }
      return { handled: true };
    }

    // For /restart, restart ALL gateway services
    if (cmd === "restart") {
      // Send confirmation message before restart
      await replyToThread(thread, `🔄 Redémarrage de tous les gateways en cours...`);
      
      // Restart all gateway services
      const { exec } = await import("child_process");
      exec(`systemctl --user restart thetis-gateway-discord thetis-gateway-whatsapp 2>/dev/null || true`, (error) => {
        if (error) {
          console.error(`[thetis-gateway] Failed to restart gateways:`, error);
        }
      });
      
      return { handled: true };
    }

    // For other silent commands, send confirmation and DO NOT send to LLM
    // This saves tokens by not wasting them on command text
    const confirmations: Record<string, string> = {
        name: args ? `🏷️ Nom de session défini : *${args}*` : `🏷️ Nom demandé…`,
        title: args ? `🏷️ Titre défini : *${args}*` : `🏷️ Titre demandé…`,
        compact: `🗜️ Compression du contexte en cours…`,
        stop: `🛑 Arrêt demandé.`,
        thinking: args ? `🧠 Réflexion : *${args}*` : `🧠 Niveau de réflexion demandé…`,
        fork: args ? `🔀 Session branchée : *${args}*` : `🔀 Session branchée.`,
        clone: `📋 Session clonée.`,
        export: args ? `📤 Export en cours…` : `📤 Export demandé…`,
        import: `📥 Import en cours…`,
        copy: `📋 Dernière réponse copiée.`,
        reload: `🔄 Rechargement de la configuration…`,
        "reload-mcp": `🔄 Rechargement des serveurs MCP…`,
        "reload-skills": `🔄 Rechargement des skills…`,
        learn: `📚 Apprentissage en cours…`,
        personality: args ? `🎭 Personnalité : *${args}*` : `🎭 Personnalités demandées…`,
        fast: `⚡ Mode rapide changé.`,
        verbose: `📊 Affichage des outils changé.`,
        footer: `📋 Pied de page changé.`,
        yolo: `⚠️ Mode YOLO changé.`,
        reasoning: args ? `🧠 Réflexion : *${args}*` : `🧠 Réflexion demandée…`,
        "codex-runtime": `💻 Runtime Codex changé.`,
        voice: args ? `🔊 Mode vocal : *${args}*` : `🔊 Mode vocal demandé…`,
        update: `🔄 Mise à jour en cours…`,
        version: `ℹ️ Version demandée…`,
        debug: `🐛 Rapport de debug en cours…`,
        kanban: `📋 Kanban demandé…`,
        goal: args ? `🎯 Objectif : *${args}*` : `🎯 Objectif demandé…`,
        subgoal: args ? `🎯 Sous-objectif : *${args}*` : `🎯 Sous-objectif demandé…`,
        moa: `🧠 Mixture of Agents en cours…`,
        queue: `⏳ Message mis en file d'attente.`,
        q: `⏳ Message mis en file d'attente.`,
        steer: `⏳ Message injecté dans le prochain appel d'outil.`,
        background: `🌙 Tâche en arrière-plan lancée.`,
        bg: `🌙 Tâche en arrière-plan lancée.`,
        btw: `🌙 Tâche en arrière-plan lancée.`,
        agents: `👥 Agents demandés…`,
        tasks: `👥 Tâches demandées…`,
        memory: `🧠 Mémoire demandée…`,
        skills: `🔧 Skills demandées…`,
        bundles: `📦 Bundles demandés…`,
        suggestions: `💡 Suggestions demandées…`,
        blueprint: `📐 Blueprint demandé…`,
        bp: `📐 Blueprint demandé…`,
        curator: `🎓 Curateur demandé…`,
        approve: `✅ Approbation accordée.`,
        deny: `❌ Approbation refusée.`,
        platform: `📡 Plateformes demandées…`,
        sethome: `🏠 Canal home défini.`,
        usage: `📊 Usage demandé…`,
        credits: `💰 Crédits demandés…`,
        insights: `📈 Insights demandés…`,
        topic: `💬 Topic demandé…`,
        retry: `🔄 Retry en cours…`,
        undo: `↩️ Dernier échange supprimé.`,
      };
    
    await replyToThread(thread, confirmations[cmd] || `⚡ Commande \`/${cmd}\` exécutée.`);
    
    // DO NOT send to LLM - just return handled
    return { handled: true };
  }

  // Let everything else pass through normally (help, whoami, status, etc.)
  return { handled: false, passthrough: text };
}

/* ------------------------------------------------------------------ */
/*  Discord                                                            */
/* ------------------------------------------------------------------ */

let discordClient: any = null;

function isDiscordReady(): boolean {
  return discordClient && discordClient.isReady?.();
}

function splitDiscordChunks(text: string, limit = 2000): string[] {
  const chunks: string[] = [];
  while (text.length > limit) {
    let slice = text.slice(0, limit);
    const lastNewline = slice.lastIndexOf("\n");
    if (lastNewline > limit * 0.8) slice = text.slice(0, lastNewline);
    chunks.push(slice);
    text = text.slice(slice.length);
  }
  if (text) chunks.push(text);
  return chunks;
}

interface OutgoingAttachment {
  name: string;
  data: Buffer;
  contentType: string;
}

async function sendDiscordReply(channelId: string, text: string, attachments?: OutgoingAttachment[]): Promise<string | null> {
  if (!isDiscordReady()) return null;
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.send !== "function") return null;

  const { AttachmentBuilder } = await import("discord.js");

  const files: any[] = [];
  if (attachments?.length) {
    for (const att of attachments) {
      try {
        files.push(new AttachmentBuilder(att.data, { name: att.name }));
      } catch {
        // Skip failed attachments
      }
    }
  }

  // Send text (chunked if needed)
  let lastMessageId: string | null = null;
  const chunks = splitDiscordChunks(text, 2000);
  for (let i = 0; i < chunks.length; i++) {
    const opts: any = { content: chunks[i] };
    // Attach files only to last text chunk
    if (i === chunks.length - 1 && files.length) {
      opts.files = files;
    }
    const msg = await channel.send(opts).catch(() => null);
    if (msg?.id) lastMessageId = msg.id;
  }
  return lastMessageId;
}

async function editDiscordMessage(channelId: string, messageId: string, text: string): Promise<void> {
  if (!isDiscordReady() || !messageId) return;
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.messages?.fetch !== "function") return;
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg || typeof msg.edit !== "function") return;
  await msg.edit({ content: text }).catch(() => null);
}

async function startDiscord(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!isGatewayEnabled("discord")) {
    ctx.ui.notify("Discord gateway is disabled in config. Run /gateway setup to enable it.", "warning");
    return;
  }

  if (runtimeState.discord.fatalError) {
    ctx.ui.notify(`Discord gateway has a fatal error and will not retry: ${runtimeState.discord.fatalError}`, "warning");
    return;
  }

  const token = config.discord?.token || process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    ctx.ui.notify("Discord token missing. Set DISCORD_BOT_TOKEN or run /gateway setup", "error");
    return;
  }

  let client: any;
  try {
    const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = await import("discord.js");
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on("messageCreate", async (message: any) => {
      if (message.author.bot) return;
      if (message.author.id === client.user?.id) return;
      if (!isDiscordAuthorized(message.author.id)) return;
      if (!message.channel.isDMBased?.()) return;

      // Acknowledge with eye reaction
      try { await message.react("👁"); } catch {}

      // Strip bot mention
      let text: string = message.content ?? "";
      if (client.user) {
        text = text.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
      }

      const threadId = getThreadId("discord", message.channel.id);
      currentThreadId = threadId; // set EARLY so pi replies can be routed back

      // Intercept pending question responses before normal routing
      const qCheck = checkQuestionResponse(threadId, text);
      if (qCheck.consume) return;

      // Intercept gateway slash commands
      if (text.startsWith("/gateway") || text.startsWith("/gateway-boot")) {
        currentThreadId = threadId;
        const isBoot = text.startsWith("/gateway-boot");
        const cmdArgs = isBoot ? text.slice(13).trim() : text.slice(9).trim();
        const result = isBoot
          ? await runGatewayBootCommand(cmdArgs, pi, activeCtx ?? undefined)
          : await runGatewayCommand(cmdArgs, pi, activeCtx ?? undefined);
        if (result) {
          await sendDiscordReply(message.channel.id, result.text);
        }
        return;
      }

      // Intercept pi slash commands
      const thread = getOrCreateThread("discord", message.channel.id);
      const piCheck = await handlePiCommand(text, thread, pi);
      if (piCheck.handled) return;
      if (piCheck.passthrough) text = piCheck.passthrough;

      // Collect attachments
      const attachments: any[] = [];
      let fileContentText = "";
      if (message.attachments?.size > 0) {
        for (const [, att] of message.attachments) {
          if (att.contentType?.startsWith("image/")) {
            // Toujours télécharger les images Discord et les convertir en JPEG base64.
            // Les URLs CDN Discord ne sont pas accessibles depuis tous les providers IA,
            // et certains formats (GIF, PNG animé, etc.) ne sont pas supportés.
            try {
              const sharp = require("sharp");
              const response = await fetch(att.url);
              if (response.ok) {
                const imgBuffer = Buffer.from(await response.arrayBuffer());
                const jpegBuffer = await sharp(imgBuffer).jpeg({ quality: 90 }).toBuffer();
                const b64 = jpegBuffer.toString("base64");
                attachments.push({ type: "image", source: { type: "base64", mediaType: "image/jpeg", data: b64 } });
              } else {
                console.error(`Failed to download Discord image: ${response.status} ${response.statusText}`);
                // Fallback: URL directe (peut échouer côté provider)
                attachments.push({ type: "image", source: { type: "url", url: att.url } });
              }
            } catch (e) {
              console.error(`Failed to convert Discord image: ${e}`);
              // Fallback: URL directe
              attachments.push({ type: "image", source: { type: "url", url: att.url } });
            }
          } else if (att.size < 500_000 && isTextFile(att.name)) {
            try {
              const response = await fetch(att.url);
              if (response.ok) {
                const content = await response.text();
                fileContentText += `\n\n--- File: ${att.name} ---\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``;
              }
            } catch {
              fileContentText += `\n\n[File attached: ${att.name} — could not read]`;
            }
          } else {
            fileContentText += `\n\n[File attached: ${att.name} (${att.contentType || "unknown"}, ${formatBytes(att.size)})]`;
          }
        }
      }

      // Check for stop keywords — cancel retries instead of processing as normal message
      const fullTextForStopCheck = (text || "(attachment)") + fileContentText;
      if (isStopKeyword(fullTextForStopCheck)) {
        await handleStopKeyword(thread, pi);
        return;
      }

      // Show thinking indicator
      await startThinkingIndicator(thread);

      const fullText = fullTextForStopCheck;
      // Queue the message
      thread.pendingQueue.push({ text: fullText, images: attachments.length ? attachments : undefined });
      thread.messages.push({ role: "user", text: fullText.slice(0, 10000), timestamp: Date.now(), hasImage: attachments.length > 0 });
      saveThreadHistory(getThreadId("discord", message.channel.id), thread.messages);

      // Activate this thread and process
      await processThreadQueue(pi, thread);
    });

    // Register slash commands for auto-completion
    client.once("ready", async () => {
      if (!client.application) return;
      const commands = [
        {
          name: "gateway",
          description: "Contrôle le gateway Discord/WhatsApp",
          options: [
            { name: "status", type: 1, description: "État des connexions" },
            { name: "threads", type: 1, description: "Lister les conversations actives" },
            { name: "clear", type: 1, description: "Vider l’historique d’un canal", options: [{ name: "id", type: 3, description: "ID du canal (laisser vide pour tout vider)", required: false }] },
            { name: "qr", type: 1, description: "(Re)lancer la connexion WhatsApp et afficher un QR code" },
            { name: "reset-whatsapp", type: 1, description: "Supprimer les credentials WhatsApp et forcer un nouveau QR" },
            { name: "setup", type: 1, description: "Configurer le gateway (requiert le TUI)" },
          ],
        },
        {
          name: "gateway-boot",
          description: "Gère le service systemd du gateway",
          options: [
            { name: "install", type: 1, description: "Installer le service de démarrage" },
            { name: "remove", type: 1, description: "Supprimer le service" },
            { name: "start", type: 1, description: "Démarrer le service maintenant" },
            { name: "stop", type: 1, description: "Arrêter le service" },
            { name: "status", type: 1, description: "État du service systemd" },
            { name: "linger", type: 1, description: "Activer le démarrage au boot" },
          ],
        },
      ];
      try {
        await client.application.commands.set(commands);
      } catch {
        // Ignore if slash-command registration fails (e.g. missing scope)
      }

      restartNotified = true;
    });

    // Handle slash commands and interactive buttons
    client.on("interactionCreate", async (interaction: any) => {
      if (!isDiscordAuthorized(interaction.user?.id)) return;

      // --- Slash commands ---
      if (interaction.isChatInputCommand?.()) {
        const threadId = getThreadId("discord", interaction.channelId);
        const commandName = interaction.commandName;
        const sub = interaction.options?.getSubcommand?.() ?? "";

        // Acknowledge immediately to avoid timeout
        await interaction.deferReply?.({ ephemeral: false }).catch(() => null);

        let args = sub;
        if (commandName === "gateway") {
          const target = interaction.options?.getString?.("target") ?? "";
          const id = interaction.options?.getString?.("id") ?? "";
          if (target) args += ` ${target}`;
          if (id) args += ` ${id}`;
        }

        let result: CommandResult | null = null;
        if (commandName === "gateway") {
          result = await runGatewayCommand(args, pi, activeCtx ?? undefined);
        } else if (commandName === "gateway-boot") {
          result = await runGatewayBootCommand(args, pi, activeCtx ?? undefined);
        }

        if (result) {
          await interaction.editReply?.({ content: result.text.slice(0, 2000) }).catch(() => {
            interaction.followUp?.({ content: result!.text.slice(0, 2000) }).catch(() => null);
          });
        }
        return;
      }

      // --- Memory confirmation buttons ---
      if (interaction.isButton?.() && interaction.customId?.startsWith("gateway_mem:")) {
        const threadId = getThreadId("discord", interaction.channelId);
        const pending = pendingMemoryConfirmations.get(threadId);
        if (!pending) return;

        const action = interaction.customId.split(":")[1];
        const approved = action === "yes";

        await interaction.deferUpdate().catch(() => null);
        await interaction.followUp({
          content: approved ? "✅ Confirmed — applying change." : "❌ Refused — change cancelled.",
          ephemeral: true,
        }).catch(() => null);

        await disableDiscordMemoryButtons(interaction.channelId, pending.messageId ?? "");
        resolveMemoryConfirmation(threadId, approved);
        return;
      }

      // --- Poll button clicks ---
      if (!interaction.isButton()) return;
      const customId: string = interaction.customId;
      if (!customId.startsWith("gateway_q:")) return;

      const threadId = getThreadId("discord", interaction.channelId);
      const pending = pendingQuestions.get(threadId);
      if (!pending) return;

      const parts = customId.split(":");
      const action = parts[1];

      // Defer to avoid "interaction failed" toast in Discord
      await interaction.deferUpdate().catch(() => null);

      if (action === "other") {
        pending.waitingForCustom = true;
        await interaction.followUp({
          content: "💬 Veuillez écrire votre réponse personnalisée :",
          ephemeral: true,
        }).catch(() => null);
        return;
      }

      const idx = parseInt(action, 10);
      if (!isNaN(idx) && idx >= 0 && idx < pending.options.length) {
        // Disable buttons to show the poll is closed
        await disableDiscordPollButtons(interaction.channelId, pending.messageId ?? "");
        resolveQuestion(threadId, pending.options[idx], false);
      }
    });

    await client.login(token);
    if (!client.isReady?.()) {
      await new Promise<void>((resolve) => client.once("ready", resolve));
    }
    discordClient = client;
    ctx.ui.notify(`Discord connected as ${client.user?.tag ?? "bot"}`, "info");
  } catch (err: any) {
    const msg = err.message ?? String(err);
    if (msg.includes("disallowed intents")) {
      // Retry without MessageContent so the bot can stay online
      try {
        const { Client, GatewayIntentBits, Partials } = await import("discord.js");
        client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
          ],
          partials: [Partials.Channel, Partials.Message],
        });
        await client.login(token);
        if (!client.isReady?.()) {
          await new Promise<void>((resolve) => client.once("ready", resolve));
        }
        discordClient = client;
        ctx.ui.notify(
          `Discord connected as ${client.user?.tag ?? "bot"} (without MessageContent intent). The bot will not be able to read message text. To fix: enable "Message Content Intent" in the Discord Developer Portal (Bot > Privileged Gateway Intents).`,
          "warning"
        );
      } catch (fallbackErr: any) {
        runtimeState.discord.fatalError =
          "Used disallowed intents — go to the Discord Developer Portal, select your application, open Bot > Privileged Gateway Intents, and enable \"Message Content Intent\". Then restart the gateway.";
        ctx.ui.notify(`Discord fatal error: ${runtimeState.discord.fatalError}`, "error");
      }
    } else {
      ctx.ui.notify(`Discord start failed: ${msg}`, "error");
    }
  }
}

async function stopDiscord(ctx: ExtensionContext) {
  if (!discordClient) return;
  try { await discordClient.destroy(); ctx.ui.notify("Discord disconnected", "info"); } catch {}
  discordClient = null;
}

/* ------------------------------------------------------------------ */
/*  Gateway runtime state                                              */
/* ------------------------------------------------------------------ */

interface GatewayRuntimeState {
  discord: {
    fatalError: string | null;
  };
  whatsapp: {
    fatalError: string | null;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
  };
}

const runtimeState: GatewayRuntimeState = {
  discord: { fatalError: null },
  whatsapp: { fatalError: null, reconnectAttempts: 0, maxReconnectAttempts: 50 },
};

function resetGatewayRuntimeState() {
  runtimeState.discord.fatalError = null;
  runtimeState.whatsapp.fatalError = null;
  runtimeState.whatsapp.reconnectAttempts = 0;
  restartNotified = false;
}

function isGatewayEnabled(platform: "discord" | "whatsapp"): boolean {
  if (platform === "discord") return config.discord?.enabled ?? false;
  return config.whatsapp?.enabled ?? false;
}

function getWhatsAppAuthDir(): string {
  const sessionName = config.whatsapp?.sessionName ?? "thetis-gateway";
  return path.join(DATA_DIR, `.baileys_auth_${sessionName}`);
}

function resetWhatsAppAuth(): { deleted: boolean; path: string } {
  const authDir = getWhatsAppAuthDir();
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    return { deleted: true, path: authDir };
  }
  return { deleted: false, path: authDir };
}

/* ------------------------------------------------------------------ */
/*  WhatsApp (Baileys)                                                 */
/* ------------------------------------------------------------------ */

let whatsappSock: any = null;

function isWhatsAppReady(): boolean {
  if (!whatsappSock) return false;
  // Baileys v7 uses a WebSocketClient wrapper exposing `isOpen` (getter),
  // not `ws.readyState` (the raw WebSocket attribute). Checking the wrong
  // attribute made isWhatsAppReady() always return false, which silently
  // dropped every outgoing reply (sendWhatsAppReply returned null with
  // no error). Fall back to `user` (set only after successful login) if
  // `isOpen` is missing for any reason.
  const ws = (whatsappSock as any).ws;
  if (ws && typeof ws.isOpen === "boolean") return ws.isOpen;
  if (ws && typeof ws.readyState === "number") return ws.readyState === 1;
  return !!(whatsappSock as any).user;
}

async function sendWhatsAppReply(jid: string, text: string, attachments?: OutgoingAttachment[]): Promise<string | null> {
  if (!isWhatsAppReady()) return null;

  let lastMessageId: string | null = null;

  if (attachments?.length) {
    for (const att of attachments) {
      try {
        if (att.contentType.startsWith("image/")) {
          const sent = await whatsappSock.sendMessage(jid, { image: att.data, caption: text });
          if (sent?.key?.id) lastMessageId = sent.key.id;
          text = ""; // caption sent with first image only
        } else {
          const sent = await whatsappSock.sendMessage(jid, {
            document: att.data,
            mimetype: att.contentType || "application/octet-stream",
            fileName: att.name,
            caption: text,
          });
          if (sent?.key?.id) lastMessageId = sent.key.id;
          text = "";
        }
      } catch (e) {
        console.error("WhatsApp attachment failed:", e);
      }
    }
  }

  if (text) {
    const sent = await whatsappSock.sendMessage(jid, { text }).catch(() => null);
    if (sent?.key?.id) {
      lastMessageId = sent.key.id;
      // Track this id so the messages.upsert echo can be ignored.
      sentMessageIds.add(sent.key.id);
      setTimeout(() => sentMessageIds.delete(sent.key!.id!), SENT_ID_TTL_MS);
    }
  }
  return lastMessageId;
}

async function deleteWhatsAppMessage(jid: string, messageId: string): Promise<void> {
  if (!isWhatsAppReady() || !messageId) return;
  try {
    await whatsappSock.sendMessage(jid, { delete: messageId }).catch(() => null);
  } catch {}
}

async function startWhatsApp(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!isGatewayEnabled("whatsapp")) {
    ctx.ui.notify("WhatsApp gateway is disabled in config. Run /gateway setup to enable it.", "warning");
    return;
  }

  if (runtimeState.whatsapp.fatalError) {
    ctx.ui.notify(`WhatsApp gateway has a fatal error and will not retry: ${runtimeState.whatsapp.fatalError}`, "warning");
    return;
  }

  try {
    const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, Browsers } =
      await import("@whiskeysockets/baileys");
    const { default: qrcode } = await import("qrcode-terminal");

    const authDir = getWhatsAppAuthDir();

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
    });
    const currentSock = sock; // capture to detect stale events after manual stop

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update: any) => {
      if (whatsappSock !== currentSock) return; // stale socket, ignore

      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        ctx.ui.notify("WhatsApp QR printed in the TUI — scan with your phone", "info");
        // Render the QR inside the TUI as a widget above the editor.
        //
        // We pass a **factory function** (not a string[]) to setWidget.
        // pi's setWidget truncates string[] widgets to MAX_WIDGET_LINES = 10
        // (and appends a "(widget truncated)" notice), which was clipping the
        // bottom half of the QR. The factory path returns a Container with
        // one Text per line and is NOT subject to that limit.
        //
        // Each Text uses paddingX=0 to avoid wrapping the 35-column QR code
        // (Text normally word-wraps at the parent's content width; with
        // paddingX=0 the line is rendered as-is, and the widget area in
        // practice is the full terminal width which comfortably fits 35 cols).
        //
        // We also fix qrcode-terminal's small-mode bug where the bottom
        // border is emitted without a terminating \n, so we normalize that
        // here to keep the QR visually consistent.
        qrcode.generate(qr, { small: true }, (qrString: string) => {
          const normalized = qrString.endsWith("\n") ? qrString : qrString + "\n";
          const lines = normalized.split("\n");
          // Drop the trailing empty element produced by the final "\n" so the
          // widget doesn't render an extra blank line.
          if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
          if (ctx.mode === "tui") {
            (async () => {
              try {
                // Dynamic import: @earendil-works/pi-tui is resolved by pi's
                // module loader at runtime; not declared in package.json to
                // keep the extension's dependency surface minimal.
                const { Container, Text } = await import(
                  "@earendil-works/pi-tui" as string
                );
                const container = new Container();
                for (const line of lines) {
                  // paddingX=0 / paddingY=0 → render lines verbatim, no wrap,
                  // no vertical spacing between QR lines.
                  container.addChild(new Text(line, 0, 0));
                }
                ctx.ui.setWidget(
                  "whatsapp-qr",
                  () => container,
                  { placement: "aboveEditor" },
                );
              } catch {
                // If pi-tui can't be resolved for any reason, fall back to
                // stderr so the user still has a way to scan the QR.
                process.stderr.write(normalized + "\n");
              }
            })();
          } else {
            // Non-TUI modes (rpc, print): fall back to plain stderr so the
            // QR is still visible in the terminal/log.
            process.stderr.write(normalized + "\n");
          }
        });
        // Also deliver the QR as an image to the currently active gateway thread
        // so users on Discord/WhatsApp don't need to look at the terminal.
        const activeThread = currentThreadId ? threads.get(currentThreadId) : null;
        if (activeThread) {
          (async () => {
            try {
              const { default: QRCode } = await import("qrcode");
              const buffer = await QRCode.toBuffer(qr, { type: "png", margin: 1, scale: 6 });
              const caption = "📱 Scannez ce QR code avec WhatsApp (Appareils liés → Lier un appareil)";
              if (activeThread.platform === "discord") {
                await sendDiscordReply(activeThread.channelId, caption, [{
                  name: "whatsapp-qr.png",
                  data: buffer,
                  contentType: "image/png",
                }]);
              } else if (activeThread.platform === "whatsapp") {
                await currentSock.sendMessage(activeThread.channelId, { image: buffer, caption }).catch(() => null);
              }
            } catch {
              // Best-effort delivery; terminal QR is the source of truth
            }
          })();
        }
      }
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.outputStatusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          ctx.ui.notify("WhatsApp logged out — not retrying.", "warning");
          if (ctx.mode === "tui") ctx.ui.setWidget("whatsapp-qr", undefined);
          runtimeState.whatsapp.fatalError = "Logged out";
          return;
        }

        runtimeState.whatsapp.reconnectAttempts++;
        if (runtimeState.whatsapp.reconnectAttempts > runtimeState.whatsapp.maxReconnectAttempts) {
          // Last resort: exit the process so systemd restarts it cleanly
          ctx.ui.notify(`WhatsApp: ${runtimeState.whatsapp.maxReconnectAttempts} failed attempts — exiting for systemd restart.`, "error");
          setTimeout(() => process.exit(1), 2000);
          return;
        }

        // Exponential backoff: 5s → 15s → 45s → 2min → 5min (capped)
        const baseDelay = 5000;
        const delay = Math.min(baseDelay * Math.pow(3, runtimeState.whatsapp.reconnectAttempts - 1), 300000);
        const delaySec = Math.round(delay / 1000);
        ctx.ui.notify(`WhatsApp closed (attempt ${runtimeState.whatsapp.reconnectAttempts}) — retry in ${delaySec}s.`, "warning");
        setTimeout(() => startWhatsApp(pi, ctx), delay);
      } else if (connection === "open") {
        runtimeState.whatsapp.reconnectAttempts = 0;
        // Clear the QR widget now that the device is paired.
        if (ctx.mode === "tui") ctx.ui.setWidget("whatsapp-qr", undefined);
        ctx.ui.notify("WhatsApp connected", "info");
      }
    });

    sock.ev.on("messages.upsert", async (m: any) => {
      const msg = m.messages[0];
      if (!msg || !msg.message) return;

      // Ignore Baileys' echo of messages we just sent (fromMe === true
      // events that mirror our own sendMessage calls). We track ids in
      // sentMessageIds; this avoids spurious "rejected unauthorized" logs
      // and any chance of double-processing our own replies.
      if (msg.key.fromMe && sentMessageIds.has(msg.key.id)) {
        return;
      }

      const jid = msg.key.remoteJid;
      // Reject messages from non-authorized JIDs (defence in depth: even if a
      // future bug let through someone else's message, isWhatsAppAuthorized
      // ensures only the numbers in config.whatsapp.allowedPhoneNumbers can
      // interact with the bot). This is the ONLY security gate — we accept
      // self-messages (fromMe === true) so the owner can chat with their own
      // bot in a self-chat setup.
      // Pass the whole key (not just remoteJid) so the check can also try
      // remoteJidAlt / participantAlt: Baileys v7 routes self-messages via
      // the LID while keeping the legacy phone JID in remoteJidAlt.
      if (!isWhatsAppAuthorized(msg.key)) {
        console.log(`[whatsapp-gw] rejected unauthorized jid=${jid} fromMe=${msg.key.fromMe}`);
        return;
      }
      console.log(`[whatsapp-gw] accepted jid=${jid} fromMe=${msg.key.fromMe} type=${m.type}`);

      const threadId = getThreadId("whatsapp", jid);
      currentThreadId = threadId; // set EARLY so pi replies can be routed back

      // Handle interactive list selection (confirmation / poll)
      const listResponse = msg.message.listResponseMessage;
      if (listResponse) {
        const selectedRowId = listResponse.singleSelectReply?.selectedRowId;

        // Memory confirmation
        if (selectedRowId?.startsWith("gateway_mem_")) {
          const pending = pendingMemoryConfirmations.get(threadId);
          if (pending) {
            const approved = selectedRowId === "gateway_mem_yes";
            await sendWhatsAppReply(jid, approved ? "✅ Confirmed — applying change." : "❌ Refused — change cancelled.");
            resolveMemoryConfirmation(threadId, approved);
            return;
          }
        }

        if (selectedRowId?.startsWith("gateway_q_")) {
          const pending = pendingQuestions.get(threadId);
          if (pending) {
            if (selectedRowId === "gateway_q_other") {
              pending.waitingForCustom = true;
              await sendWhatsAppReply(jid, "💬 Veuillez écrire votre réponse personnalisée :");
            } else {
              const idx = parseInt(selectedRowId.replace("gateway_q_", ""), 10);
              if (!isNaN(idx) && idx >= 0 && idx < pending.options.length) {
                resolveQuestion(threadId, pending.options[idx], false);
              }
            }
            return;
          }
        }
      }

      let text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      // Intercept pending question responses before normal routing
      const qCheck = checkQuestionResponse(threadId, text);
      if (qCheck.consume) return;

      // Intercept gateway slash commands
      if (text.startsWith("/gateway") || text.startsWith("/gateway-boot")) {
        currentThreadId = threadId;
        const isBoot = text.startsWith("/gateway-boot");
        const cmdArgs = isBoot ? text.slice(13).trim() : text.slice(9).trim();
        const result = isBoot
          ? await runGatewayBootCommand(cmdArgs, pi, activeCtx ?? undefined)
          : await runGatewayCommand(cmdArgs, pi, activeCtx ?? undefined);
        if (result) {
          await sendWhatsAppReply(jid, result.text);
        }
        return;
      }

      // Intercept pi slash commands
      const thread = getOrCreateThread("whatsapp", jid);
      const piCheck = await handlePiCommand(text, thread, pi);
      if (piCheck.handled) return;
      if (piCheck.passthrough) text = piCheck.passthrough;

      // Acknowledge with eye reaction + thinking indicator
      // Handle media attachments
      const attachments: any[] = [];
      if (msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          if (buffer) {
            const b64 = Buffer.from(buffer).toString("base64");
            let mediaType = "application/octet-stream";
            if (msg.message.imageMessage) mediaType = msg.message.imageMessage.mimetype || "image/jpeg";
            else if (msg.message.videoMessage) mediaType = msg.message.videoMessage.mimetype || "video/mp4";
            else if (msg.message.documentMessage) mediaType = msg.message.documentMessage.mimetype || "application/octet-stream";

            if (mediaType.startsWith("image/")) {
              let finalBuffer = buffer;
              let finalMediaType = mediaType;
              // Convertir WebP en JPEG (seul format non supporté par les providers IA)
              if (mediaType === "image/webp") {
                const sharp = require("sharp");
                finalBuffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
                finalMediaType = "image/jpeg";
              }
              const finalB64 = Buffer.from(finalBuffer).toString("base64");
              attachments.push({ type: "image", source: { type: "base64", mediaType: finalMediaType, data: finalB64 } });
            } else if (mediaType.startsWith("text/") || isTextFile(msg.message.documentMessage?.fileName || "")) {
              const content = buffer.toString("utf8");
              text += `\n\n--- File: ${msg.message.documentMessage?.fileName || "attachment"} ---\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``;
            } else {
              // Save non-image, non-text files to disk
              if (!fs.existsSync(FILES_DIR)) {
                fs.mkdirSync(FILES_DIR, { recursive: true });
              }
              const fileName = msg.message.documentMessage?.fileName || `file_${Date.now()}`;
              const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
              const filePath = path.join(FILES_DIR, safeFileName);
              fs.writeFileSync(filePath, buffer);
              text += `\n\n[File saved: ${filePath} (${mediaType})]`;
            }
          }
        } catch {
          // Media download failed, continue without it
        }
      }

      const fullText = text || "(attachment)";

      // Check for stop keywords — cancel retries instead of processing as normal message
      if (isStopKeyword(fullText)) {
        await handleStopKeyword(thread, pi);
        return;
      }

      thread.pendingQueue.push({ text: fullText, images: attachments.length ? attachments : undefined });
      thread.messages.push({ role: "user", text: fullText.slice(0, 10000), timestamp: Date.now(), hasImage: attachments.length > 0 });
      saveThreadHistory(getThreadId("whatsapp", jid), thread.messages);

      await processThreadQueue(pi, thread);
    });

    whatsappSock = sock;
  } catch (err: any) {
    ctx.ui.notify(`WhatsApp start failed: ${err.message ?? err}`, "error");
  }
}

async function stopWhatsApp(ctx: ExtensionContext) {
  if (!whatsappSock) return;
  try { await whatsappSock.end(undefined); ctx.ui.notify("WhatsApp disconnected", "info"); } catch {}
  whatsappSock = null;
}

/* ------------------------------------------------------------------ */
/*  Stop keyword detection                                             */
/* ------------------------------------------------------------------ */

const STOP_KEYWORDS = new Set(["stop", "annuler", "annule", "cancel", "arrête", "arrête tout", "stop tout"]);

function isStopKeyword(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return STOP_KEYWORDS.has(trimmed);
}

/**
 * Handle a stop keyword: cancel retries, reset state, clean image context.
 * Returns true if the message was a stop keyword and was handled.
 */
async function handleStopKeyword(
  thread: ChannelThread,
  pi: ExtensionAPI
): Promise<boolean> {
  // Cancel any pending retry timer
  if (thread.retryTimer) {
    clearTimeout(thread.retryTimer);
    thread.retryTimer = undefined;
  }

  // Reset all retry/error state
  thread.isProcessingRetry = false;
  thread.retryCount = 0;
  thread.errorCycles = 0;
  thread.hasFatalContextError = false;
  thread.lastUserMessage = undefined;

  // Clear pending queue to prevent stale messages from being processed
  thread.pendingQueue.length = 0;
  thread.processing = false;

  // Send confirmation
  await replyToThread(thread, "✅ Opération annulée.");

  console.log(`[thetis-gateway] Stop keyword received — retries cancelled, context cleaned`);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Thread Queue Processor                                             */
/* ------------------------------------------------------------------ */

async function processThreadQueue(pi: ExtensionAPI, thread: ChannelThread) {
  if (thread.processing) return;
  thread.processing = true;

  // Clear any pending retry timer when new messages arrive
  if (thread.retryTimer) {
    clearTimeout(thread.retryTimer);
    thread.retryTimer = undefined;
  }

  // Reset error episode state for new user interaction
  // (circuitBreakerUntil and errorCycles are preserved — only the per-episode message counter resets)
  thread.errorEpisodeActive = false;
  thread.errorMessagesSent = 0;

  while (thread.pendingQueue.length > 0) {
    const item = thread.pendingQueue.shift()!;

    // Deduplication: check if this is the same message processed recently (< 2 min)
    const now = Date.now();
    const isDuplicate = thread.lastProcessedMessage &&
      thread.lastProcessedMessage.text === item.text &&
      JSON.stringify(thread.lastProcessedMessage.images) === JSON.stringify(item.images) &&
      (now - thread.lastProcessedMessage.timestamp) < 120_000; // 2 minutes

    if (isDuplicate) {
      console.log(`[thetis-gateway] Skipping duplicate message (processed ${((now - thread.lastProcessedMessage!.timestamp) / 1000).toFixed(0)}s ago)`);
      continue;
    }

    // hasFatalContextError check: if the previous error was caused by content (e.g. invalid image),
    // block messages that contain images/files until a clean text-only message is sent.
    if (thread.hasFatalContextError) {
      if (item.images && item.images.length > 0) {
        // User sent another image while flag is active — reject it
        console.log(`[thetis-gateway] Blocking message: hasFatalContextError is active and message contains images`);
        await replyToThread(thread, "❌ Le format du fichier envoyé n'est pas supporté. Veuillez essayer avec un autre format (JPG, PNG) ou envoyer un message texte.");
        continue;
      } else {
        // User sent a clean text message — reset the flag and proceed
        console.log(`[thetis-gateway] hasFatalContextError reset: user sent a clean text message`);
        thread.hasFatalContextError = false;
      }
    }

    // Store the message for potential retry and deduplication
    thread.lastUserMessage = { text: item.text, images: item.images };
    thread.lastProcessedMessage = { text: item.text, images: item.images, timestamp: now };

    try {
      // Check if this is a Pi command (starts with /)
      // Commands need to be sent without deliverAs to be processed correctly
      const isCommand = typeof item.text === 'string' && item.text.startsWith('/');
      
      if (item.images && item.images.length > 0) {
        // Send as content array with images
        const content = [{ type: "text", text: item.text }, ...item.images];
        if (isCommand) {
          pi.sendUserMessage(content as any);
        } else {
          pi.sendUserMessage(content as any, { deliverAs: "followUp" });
        }
      } else {
        if (isCommand) {
          pi.sendUserMessage(item.text);
        } else {
          pi.sendUserMessage(item.text, { deliverAs: "followUp" });
        }
      }
    } catch {
      // If send fails, re-queue for later
      thread.pendingQueue.unshift(item);
      break;
    }
  }

  thread.processing = false;
}

/* ------------------------------------------------------------------ */
/*  Reply Routing — assistant -> gateway                               */
/* ------------------------------------------------------------------ */

async function routeAssistantReply(pi: ExtensionAPI, text: string, attachments?: OutgoingAttachment[]) {
  if (!currentThreadId) return;

  const thread = threads.get(currentThreadId);
  if (!thread) return;

  // Save to thread history
  thread.messages.push({ role: "assistant", text, timestamp: Date.now() });
  saveThreadHistory(currentThreadId, thread.messages);

  if (thread.platform === "discord") {
    await sendDiscordReply(thread.channelId, text, attachments);
  } else if (thread.platform === "whatsapp") {
    await sendWhatsAppReply(thread.channelId, text, attachments);
  }
}

/* ------------------------------------------------------------------ */
/*  Thinking indicators (typing + ephemeral status message)          */
/* ------------------------------------------------------------------ */

async function startThinkingIndicator(thread: ChannelThread) {
  await stopThinkingIndicator(thread);

  // Discord: just typing indicator (no ephemeral message)
  if (thread.platform === "discord" && isDiscordReady()) {
    const pulse = async () => {
      try {
        const channel = await discordClient.channels.fetch(thread.channelId);
        if (channel && typeof channel.sendTyping === "function") {
          await channel.sendTyping();
          // Schedule next pulse just before the 10s expiry to avoid overlap
          if (thread.typingInterval) {
            thread.typingInterval = setTimeout(pulse, 9000);
          }
        }
      } catch {
        // If sendTyping fails (e.g. rate limit), retry sooner
        if (thread.typingInterval) {
          thread.typingInterval = setTimeout(pulse, 5000);
        }
      }
    };
    thread.typingInterval = setTimeout(pulse, 0);
  }

  // WhatsApp: send a placeholder text (we can't delete it cleanly, so keep it minimal)
  if (thread.platform === "whatsapp" && isWhatsAppReady() && !thread.pendingMessageId) {
    try {
      const sent = await whatsappSock.sendMessage(thread.channelId, { text: "💭 Réflexion..." });
      if (sent?.key?.id) thread.pendingMessageId = sent.key.id;
    } catch {}
  }
}

async function stopThinkingIndicator(thread: ChannelThread) {
  // Clear typing interval
  if (thread.typingInterval) {
    clearInterval(thread.typingInterval);
    thread.typingInterval = undefined;
  }

  // WhatsApp: delete the ephemeral "💭 Réflexion..." message
  if (thread.platform === "whatsapp" && thread.pendingMessageId && isWhatsAppReady()) {
    try {
      await whatsappSock.sendMessage(thread.channelId, { delete: thread.pendingMessageId }).catch(() => null);
    } catch {}
  }
  thread.pendingMessageId = undefined;
}

/* ------------------------------------------------------------------ */
/*  Memory Integration — detect memory tool usage                      */
/* ------------------------------------------------------------------ */

function extractToolResults(text: string): { toolName: string; result: string }[] {
  const results: { toolName: string; result: string }[] = [];
  
  // Match common tool result patterns in assistant output
  const memoryMatch = text.match(/memory\/(read|list|search)[\s\S]*?Result:([\s\S]*?)(?=\n\n|\n\z|$)/i);
  if (memoryMatch) {
    results.push({ toolName: "memory", result: memoryMatch[2].trim() });
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  Slash-command helpers (usable from TUI and from gateways)        */
/* ------------------------------------------------------------------ */

interface CommandResult {
  text: string;
  error?: boolean;
}

async function runGatewayCommand(
  args: string,
  pi: ExtensionAPI,
  _ctx?: ExtensionContext
): Promise<CommandResult | null> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const gCtx = getGatewayCtx();

  if (sub === "qr") {
    if (!isGatewayEnabled("whatsapp")) {
      return { text: "⚠️ WhatsApp est désactivé dans la config. Lancez `/gateway setup` pour l'activer.", error: true };
    }
    // Force a fresh connection attempt: stop if running, clear fatal-error
    // state from a previous logged-out / failed session, then start. If valid
    // creds are present, WhatsApp reconnects silently; otherwise a QR code
    // is printed to the terminal (and sent as an image to the active thread).
    // Wrapped in try-catch so any failure in Baileys/QR generation is
    // surfaced as a command error instead of crashing the Pi process.
    try {
      if (whatsappSock) {
        try { await stopWhatsApp(gCtx); } catch { /* ignore stop errors */ }
      }
      runtimeState.whatsapp.fatalError = null;
      runtimeState.whatsapp.reconnectAttempts = 0;
      await startWhatsApp(pi, gCtx);
    } catch (err: any) {
      return {
        text: `❌ Échec du démarrage WhatsApp : \`${err?.message ?? err}\``,
        error: true,
      };
    }
    return {
      text:
        "📱 Connexion WhatsApp en cours…\n" +
        "• Si des credentials valides existent : reconnexion automatique.\n" +
        "• Sinon : un QR code va s'afficher dans le terminal (et sera aussi envoyé en image dans ce canal).",
    };
  }

  if (sub === "reset-whatsapp" || sub === "reset-wa") {
    if (!isGatewayEnabled("whatsapp")) {
      return { text: "⚠️ WhatsApp est désactivé dans la config. Lancez `/gateway setup` pour l'activer.", error: true };
    }
    // Destructive: wipe the local Baileys auth folder so the next connection
    // forces a fresh QR pairing. Useful after a logged-out session, when
    // switching the linked device, or to recover from a corrupted auth state.
    let result: { deleted: boolean; path: string };
    try {
      if (whatsappSock) {
        try { await stopWhatsApp(gCtx); } catch { /* ignore stop errors */ }
      }
      result = resetWhatsAppAuth();
      runtimeState.whatsapp.fatalError = null;
      runtimeState.whatsapp.reconnectAttempts = 0;
      await startWhatsApp(pi, gCtx);
    } catch (err: any) {
      return {
        text: `❌ Échec du reset WhatsApp : \`${err?.message ?? err}\``,
        error: true,
      };
    }
    return {
      text:
        (result.deleted
          ? `🗑️ Credentials WhatsApp supprimés (\`${result.path}\`).\n`
          : `ℹ️ Aucun credentials local trouvé — démarrage d'une nouvelle session.\n`) +
        "📱 Un QR code va s'afficher dans le terminal (et sera aussi envoyé en image dans ce canal). Scannez-le avec WhatsApp pour relier l'appareil.",
    };
  }

  if (sub === "status") {
    const d = isDiscordReady()
      ? "🟢 connected"
      : runtimeState.discord.fatalError
      ? `⛔ ${runtimeState.discord.fatalError}`
      : !isGatewayEnabled("discord")
      ? "⚪ disabled"
      : "🔴 offline";
    const w = isWhatsAppReady()
      ? "🟢 connected"
      : runtimeState.whatsapp.fatalError
      ? `⛔ ${runtimeState.whatsapp.fatalError}`
      : !isGatewayEnabled("whatsapp")
      ? "⚪ disabled"
      : "🔴 offline";
    return { text: `Discord: ${d}\nWhatsApp: ${w}\nActive threads: ${threads.size}` };
  }

  if (sub === "threads") {
    if (threads.size === 0) return { text: "No active threads." };
    const lines = Array.from(threads.entries()).map(([id, t]) => {
      return `- ${id}: ${t.messages.length} msgs, ${t.pendingQueue.length} pending`;
    });
    return { text: lines.join("\n") };
  }

  if (sub === "clear") {
    const target = parts[1];
    if (target) {
      const id = getThreadId("discord", target) in [...threads.keys()]
        ? getThreadId("discord", target)
        : getThreadId("whatsapp", target);
      threads.delete(id);
      const file = path.join(THREADS_DIR, `${id}.json`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { text: `Thread ${target} cleared.` };
    } else {
      threads.clear();
      clearAllThreadHistories();
      return { text: "All threads cleared." };
    }
  }

  if (sub === "setup") {
    if (!gCtx.hasUI) {
      return {
        text: `Inline setup not supported from gateway.\nUse TUI command /gateway setup, or edit:\n${CONFIG_PATH}`,
        error: true,
      };
    }
    const prevDiscordEnabled = config.discord?.enabled ?? true;
    const discordEnabled = await gCtx.ui.confirm(
      "Enable Discord gateway?",
      prevDiscordEnabled
    );

    let discordToken = "";
    let discordUserIds = "";
    if (discordEnabled) {
      const prevDiscordToken = config.discord?.token || process.env.DISCORD_BOT_TOKEN || "";
      const discordTokenRaw = await gCtx.ui.input(
        "Discord bot token (leave empty to keep previous):",
        prevDiscordToken
      );
      discordToken = discordTokenRaw.trim() || prevDiscordToken;

      const prevDiscordUserIds = config.discord?.allowedUserIds?.join(", ") || "";
      const discordUserIdsRaw = await gCtx.ui.input(
        "Authorized Discord user IDs (comma-separated, REQUIRED if Discord enabled):",
        prevDiscordUserIds
      );
      discordUserIds = discordUserIdsRaw.trim() || prevDiscordUserIds;
    }

    const prevWhatsappEnabled = config.whatsapp?.enabled ?? true;
    const whatsappEnabled = await gCtx.ui.confirm(
      "Enable WhatsApp gateway?",
      prevWhatsappEnabled
    );

    const prevWhatsappPhones = config.whatsapp?.allowedPhoneNumbers?.join(", ") || "";
    const whatsappPhonesRaw = await gCtx.ui.input(
      "Authorized WhatsApp phone numbers (comma-separated, REQUIRED if WhatsApp enabled):",
      prevWhatsappPhones
    );
    const whatsappPhones = whatsappPhonesRaw.trim() || prevWhatsappPhones;

    const prevSessionName = config.whatsapp?.sessionName ?? "thetis-gateway";
    const sessionNameRaw = await gCtx.ui.input(
      `WhatsApp session name [${prevSessionName}]:`,
      prevSessionName
    );
    const sessionName = sessionNameRaw.trim() || prevSessionName;

    const prevMaxHistory = String(config.maxHistoryPerThread ?? 100);
    const maxHistoryRaw = await gCtx.ui.input(
      "Max messages per thread history [100]:",
      prevMaxHistory
    );
    const maxHistory = maxHistoryRaw.trim() || prevMaxHistory;

    const parsedDiscordIds = discordUserIds
      ? discordUserIds.split(/[,;\-\s]+/).map((s) => s.trim()).filter(Boolean)
      : [];
    const parsedWhatsappPhones = whatsappPhones
      ? whatsappPhones.split(/[,;\-\s]+/).map((s) => s.trim()).filter(Boolean)
      : [];

    if (discordEnabled && !discordToken) {
      return { text: "Discord is enabled but no bot token was provided. Setup aborted.", error: true };
    }
    if (discordEnabled && parsedDiscordIds.length === 0) {
      return { text: "Discord is enabled but no authorized user IDs were provided. Setup aborted.", error: true };
    }
    if (whatsappEnabled && parsedWhatsappPhones.length === 0) {
      return { text: "WhatsApp is enabled but no authorized phone numbers were provided. Setup aborted.", error: true };
    }

    const newConfig: GatewayConfig = {
      autoStart: true,
      maxHistoryPerThread: parseInt(maxHistory, 10) || 100,
      discord: discordEnabled
        ? {
            enabled: true,
            token: discordToken,
            allowedUserIds: parsedDiscordIds,
          }
        : { enabled: false },
      whatsapp: whatsappEnabled
        ? {
            enabled: true,
            sessionName,
            allowedPhoneNumbers: parsedWhatsappPhones,
          }
        : { enabled: false },
    };

    saveConfig(newConfig);
    config = newConfig;
    return { text: "Gateway config saved. Use /gateway-boot start to launch the service." };
  }

  // Unknown sub-command — return help
  return {
    text:
      `Usage: /gateway qr|reset-whatsapp|status|threads|clear|setup [options]\n` +
      `  qr              : (re)lance la connexion WhatsApp (affiche un QR si pas de creds)\n` +
      `  reset-whatsapp  : supprime les creds WhatsApp et force un nouveau QR`,
    error: true,
  };
}

async function runGatewayBootCommand(
  args: string,
  _pi?: ExtensionAPI,
  _ctx?: ExtensionContext
): Promise<CommandResult | null> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const installScript = path.join(EXT_DIR, "scripts", "install-boot.sh");
  const discordService = "thetis-gateway-discord";
  const whatsappService = "thetis-gateway-whatsapp";
  const gCtx = getGatewayCtx();

  // Helper: get list of enabled services based on config
  const getEnabledServices = (): string[] => {
    const services: string[] = [];
    if (config.discord?.enabled) services.push(discordService);
    if (config.whatsapp?.enabled) services.push(whatsappService);
    return services;
  };

  if (sub === "install" || sub === "enable") {
    if (!gCtx.hasUI) {
      return {
        text: `Run in terminal:\n  bash "${installScript}" install`,
        error: true,
      };
    }
    try {
      const { execSync } = await import("node:child_process");
      execSync(`"${installScript}" install`, { stdio: "inherit" });
      return { text: "Boot services installed. Run /gateway-boot start to launch." };
    } catch {
      return { text: "Boot service installation failed.", error: true };
    }
  }

  if (sub === "remove" || sub === "disable") {
    if (!gCtx.hasUI) {
      return {
        text: `Run in terminal:\n  bash "${installScript}" remove`,
        error: true,
      };
    }
    try {
      const { execSync } = await import("node:child_process");
      execSync(`"${installScript}" remove`, { stdio: "inherit" });
      return { text: "Boot services removed." };
    } catch {
      return { text: "Boot service removal failed.", error: true };
    }
  }

  if (sub === "start") {
    const enabled = getEnabledServices();
    if (enabled.length === 0) {
      return { text: "No gateway enabled in config. Run /gateway setup to enable Discord or WhatsApp.", error: true };
    }
    try {
      const { execSync } = await import("node:child_process");
      const started: string[] = [];
      for (const svc of enabled) {
        try {
          execSync(`systemctl --user start ${svc}`, { stdio: "pipe" });
          started.push(svc);
        } catch (e: any) {
          return { text: `Failed to start ${svc}: ${e.stderr?.toString() || e.message}`, error: true };
        }
      }
      return { text: `Started: ${started.join(", ")}` };
    } catch {
      return { text: "Failed to start gateway services.", error: true };
    }
  }

  if (sub === "stop") {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`systemctl --user stop ${discordService} ${whatsappService} 2>/dev/null || true`, { stdio: "pipe" });
      return { text: "Gateway services stopped." };
    } catch {
      return { text: "Failed to stop gateway services.", error: true };
    }
  }

  if (sub === "status") {
    try {
      const { execSync } = await import("node:child_process");
      let out = "";
      for (const svc of [discordService, whatsappService]) {
        try {
          out += `=== ${svc} ===\n`;
          out += execSync(`systemctl --user status ${svc} --no-pager`, { encoding: "utf8" });
          out += "\n";
        } catch (err: any) {
          out += `=== ${svc} ===\n`;
          out += err.stdout?.toString() || "Not running";
          out += "\n\n";
        }
      }
      return { text: out.slice(0, 3000) };
    } catch {
      return { text: "Failed to get status.", error: true };
    }
  }

  if (sub === "linger") {
    if (!gCtx.hasUI) {
      return {
        text: `Run in terminal:\n  loginctl enable-linger $USER`,
        error: true,
      };
    }
    try {
      const { execSync } = await import("node:child_process");
      execSync(`loginctl enable-linger $USER`, { stdio: "inherit" });
      return { text: "User linger enabled. Services will start at boot even before login." };
    } catch {
      return { text: "Failed to enable linger. You may need sudo.", error: true };
    }
  }

  return {
    text: `Usage: /gateway-boot install | remove | start | stop | status | linger`,
    error: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Tool counters (gateway)                                          */
/* ------------------------------------------------------------------ */

interface ToolCounter {
  count: number;
  discordMessageId?: string;
  whatsappMessageId?: string;
}

const toolCounters = new Map<string, ToolCounter>();

function counterKey(threadId: string, toolName: string): string {
  return `${threadId}:${toolName}`;
}

/* ------------------------------------------------------------------ */
/*  Error Classification & Retry Logic                                 */
/* ------------------------------------------------------------------ */

type ErrorType = "rate_limit" | "payment_required" | "client_error" | "server_error" | "network_error" | "unknown";

/**
 * Classify an error from the raw error text returned by the API.
 * Parses common error patterns to determine the error category.
 */
function classifyError(errorText: string): ErrorType {
  const lower = errorText.toLowerCase();

  // Rate limit / quota errors (429, GoUsageLimitError, quota)
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("gousagelimiterror") ||
    lower.includes("quota") ||
    lower.includes("usage limit") ||
    lower.includes("too many requests")
  ) {
    return "rate_limit";
  }

  // Payment required (402)
  if (
    lower.includes("402") ||
    lower.includes("payment required") ||
    lower.includes("insufficient funds") ||
    lower.includes("no credits") ||
    lower.includes("billing")
  ) {
    return "payment_required";
  }

  // Server errors (500, 502, 503, 504)
  if (
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("internal server error") ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable") ||
    lower.includes("gateway timeout") ||
    lower.includes("server error")
  ) {
    return "server_error";
  }

  // Network errors / timeouts
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("network") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("dns") ||
    lower.includes("connection") ||
    lower.includes("aborted")
  ) {
    return "network_error";
  }

  // Client errors (4xx) — specific patterns
  if (
    lower.includes("400") ||
    lower.includes("invalid_parameter") ||
    lower.includes("invalid_request") ||
    lower.includes("bad request") ||
    lower.includes("image format") ||
    lower.includes("cannot be opened") ||
    lower.includes("illegal")
  ) {
    return "client_error";
  }

  // Client errors (4xx) — generic fallback for any 4xx HTTP code
  if (/\b4(?:0[0-9]|1[0-9]|2[0-2])\b/.test(errorText)) {
    return "client_error";
  }

  return "unknown";
}

/**
 * Get the maximum number of retries for a given error type.
 * - rate_limit: 0 (don't retry, quota won't refill in seconds)
 * - payment_required: 0 (don't retry, billing issue)
 * - server_error: 2 (might be transient)
 * - network_error: 3 (likely transient)
 * - unknown: 1 (conservative)
 */
function getMaxRetriesForErrorType(errorType: ErrorType): number {
  switch (errorType) {
    case "rate_limit": return 0;
    case "payment_required": return 0;
    case "client_error": return 0;
    case "server_error": return 2;
    case "network_error": return 3;
    case "unknown": return 1;
  }
}

/**
 * Get a user-friendly error message for a given error type.
 */
function getErrorMessageForErrorType(errorType: ErrorType): string {
  switch (errorType) {
    case "rate_limit":
      return "Quota IA épuisé. Veuillez attendre ou vérifier votre abonnement.";
    case "payment_required":
      return "Crédits IA épuisés. Veuillez recharger votre compte.";
    case "server_error":
      return "Erreur serveur IA. Le service est temporairement indisponible.";
    case "client_error":
      return "❌ Le format du fichier envoyé n'est pas supporté. Veuillez essayer avec un autre format (JPG, PNG).";
    case "network_error":
      return "Erreur réseau. Vérifiez votre connexion.";
    case "unknown":
      return "Erreur IA inconnue. Réessayez plus tard.";
  }
}

/* ------------------------------------------------------------------ */
/*  Extension factory                                                  */
/* ------------------------------------------------------------------ */

export default function thetisGatewayExtension(pi: ExtensionAPI) {

  /* ----  Detect TUI input — disable external relay  ---- */
  pi.on("input", async (event) => {
    if (event.source === "interactive") {
      currentThreadId = null; // TUI takes priority
    }
    return { action: "continue" };
  });

  /* ----  Count tool usage for gateway notifications  ---- */
  pi.on("tool_execution_start", async (event) => {
    // Relancer le typing indicator sur Discord pendant l'exécution des outils
    if (currentThreadId) {
      const thread = threads.get(currentThreadId);
      if (thread?.platform === "discord") {
        await startThinkingIndicator(thread);
      }
    }

    if ((event.toolName === "memory" || event.toolName === "learn_wizard") && currentThreadId) {
      const key = counterKey(currentThreadId, event.toolName);
      let counter = toolCounters.get(key);
      if (!counter) {
        counter = { count: 0 };
        toolCounters.set(key, counter);
      }
      counter.count++;
      const thread = threads.get(currentThreadId);
      if (!thread) return;
      const label = event.toolName === "learn_wizard" ? "🧠 Apprentissage" : "🔧 Mémoire";
      const text = `${label} utilisé (x${counter.count})`;
      if (thread.platform === "discord") {
        if (counter.discordMessageId) {
          await editDiscordMessage(thread.channelId, counter.discordMessageId, text);
        } else {
          counter.discordMessageId = (await sendDiscordReply(thread.channelId, text)) ?? undefined;
        }
      } else if (thread.platform === "whatsapp") {
        if (counter.whatsappMessageId) {
          await deleteWhatsAppMessage(thread.channelId, counter.whatsappMessageId);
        }
        counter.whatsappMessageId = (await sendWhatsAppReply(thread.channelId, text)) ?? undefined;
      }
    }
  });

  pi.on("turn_end", async () => {
    toolCounters.clear();
    if (currentThreadId) {
      const thread = threads.get(currentThreadId);
      if (thread) await stopThinkingIndicator(thread);
    }
  });

  /* ----  Track pi's internal retry state (System A)  ---- */
  pi.on("agent_start", async () => {
    if (!currentThreadId) return;
    const thread = threads.get(currentThreadId);
    if (thread) thread.piExhaustedRetries = false;
  });

  pi.on("agent_end", async (event) => {
    if (!currentThreadId) return;
    const thread = threads.get(currentThreadId);
    if (!thread) return;
    if ((event as any).willRetry === false) {
      thread.piExhaustedRetries = true;
      console.log(`[thetis-gateway] Pi agent run ended — willRetry=false (System A exhausted)`);
    }
  });

  /* ----  Capture assistant replies and route them  ---- */
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    if (!currentThreadId) return;

    const content = event.message.content;
    let text = "";
    const attachments: OutgoingAttachment[] = [];

    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const c of content as any[]) {
        if (c.type === "text") text += (text ? "\n" : "") + c.text;
        else if (c.type === "image" && c.source?.type === "base64" && c.source.data) {
          try {
            const buffer = Buffer.from(c.source.data, "base64");
            const mediaType = c.source.media_type || "image/png";
            attachments.push({
              name: "image." + (mediaType.split("/")[1] || "png"),
              data: buffer,
              contentType: mediaType,
            });
          } catch {
            // Skip failed image
          }
        }
      }
    }

    // Strip thinking/reflection blocks from final text
    let cleanedText = text
      .replace(/<think[\s\S]*?<\/think>/gi, "")
      .replace(/<thinking[\s\S]*?<\/thinking>/gi, "")
      .trim();

    // Check for API errors — NO gateway retry (pi already handles auto_retry internally)
    // Pi's System A does up to 3 auto_retries transparently before message_end fires.
    // The gateway's System B retry was creating infinite loops (each gateway retry → 3 new pi auto_retries).
    const stopReason = (event.message as any).stopReason;
    if (stopReason === "error" && !cleanedText && !attachments.length) {
      const thread = threads.get(currentThreadId!);
      if (!thread) return;

      const errorText = text || "Unknown error";
      const errorType = classifyError(errorText);
      console.log(`[thetis-gateway] Error classified as: ${errorType} - ${errorText.slice(0, 200)}`);

      // Fatal context error: strip images to prevent retry loop on bad content
      const errorLower = errorText.toLowerCase();
      const isContentError = errorType === "client_error" && (
        errorLower.includes("image format") ||
        errorLower.includes("invalid_parameter") ||
        errorLower.includes("cannot be opened") ||
        errorLower.includes("illegal") ||
        errorLower.includes("400")
      );

      if (isContentError && thread.lastUserMessage?.images && thread.lastUserMessage.images.length > 0) {
        console.log(`[thetis-gateway] Fatal context error: stripping images from lastUserMessage`);
        thread.lastUserMessage = { text: thread.lastUserMessage.text, images: undefined };
        thread.hasFatalContextError = true;
      }

      const now = Date.now();

      // ── 1. CIRCUIT BREAKER — checked FIRST, before any other logic ──
      if (thread.circuitBreakerUntil && now < thread.circuitBreakerUntil) {
        const waitTime = Math.ceil((thread.circuitBreakerUntil - now) / 1000);
        // Respect error message limit even for circuit breaker messages
        if ((thread.errorMessagesSent ?? 0) < 3) {
          await routeAssistantReply(pi, `⚠️ Service temporairement indisponible. Réessayez dans ${waitTime}s.`);
          thread.errorMessagesSent = (thread.errorMessagesSent ?? 0) + 1;
        }
        return;
      }

      // ── 2. Pi exhausted its auto_retries (System A) — do NOT gateway-retry ──
      // message_end with stopReason="error" only fires after pi's internal auto_retries
      // complete. Retrying from the gateway would trigger a NEW agent run → more auto_retries
      // → infinite loop (1686 auto_retry_start in 2 days). So we just send ONE error message.
      if (thread.piExhaustedRetries) {
        console.log(`[thetis-gateway] Pi exhausted retries (agent_end willRetry=false) — skipping gateway retry`);
      }

      // ── 3. Mark error episode as active ──
      thread.errorEpisodeActive = true;

      // ── 4. Error message limit — max 3 visible messages per episode ──
      if ((thread.errorMessagesSent ?? 0) >= 3) {
        console.log(`[thetis-gateway] Error message limit reached (3/3), staying silent`);
        // Still track error cycles for circuit breaker even when silent
        thread.errorCycles = (thread.errorCycles ?? 0) + 1;
        thread.lastErrorTimestamp = now;
        thread.lastErrorMessage = errorText;
        if (thread.errorCycles >= 3) {
          thread.circuitBreakerUntil = now + 600_000;
          thread.errorCycles = 0;
          console.log(`[thetis-gateway] Circuit breaker activated until ${new Date(thread.circuitBreakerUntil).toISOString()}`);
        }
        thread.retryCount = 0;
        thread.isProcessingRetry = false;
        return;
      }

      // ── 5. Send ONE error message — NO gateway retry ──
      const nonRetryableTypes: ErrorType[] = ["rate_limit", "payment_required", "client_error"];

      if (nonRetryableTypes.includes(errorType)) {
        await routeAssistantReply(pi, `❌ ${getErrorMessageForErrorType(errorType)}`);
      } else {
        // server_error, network_error, unknown — pi already retried internally
        await routeAssistantReply(pi, `❌ Erreur IA (${errorType}). Réessayez plus tard.`);
      }
      thread.errorMessagesSent = (thread.errorMessagesSent ?? 0) + 1;

      // ── 6. Update error cycle tracking for circuit breaker ──
      thread.errorCycles = (thread.errorCycles ?? 0) + 1;
      thread.lastErrorTimestamp = now;
      thread.lastErrorMessage = errorText;

      if (thread.errorCycles >= 3) {
        thread.circuitBreakerUntil = now + 600_000; // 10 minutes
        thread.errorCycles = 0;
        console.log(`[thetis-gateway] Circuit breaker activated until ${new Date(thread.circuitBreakerUntil).toISOString()}`);
      }

      thread.retryCount = 0;
      thread.isProcessingRetry = false;
      // Clear any pending retry timer from previous cycles
      if (thread.retryTimer) {
        clearTimeout(thread.retryTimer);
        thread.retryTimer = undefined;
      }
      return;
    }

    // Reset retry state on successful response — but preserve error counters during error episodes
    // This prevents "stop" (which succeeds) from resetting errorCycles/circuitBreaker
    if (currentThreadId) {
      const thread = threads.get(currentThreadId);
      if (thread) {
        thread.retryCount = 0;
        thread.isProcessingRetry = false;
        // Only reset error cycles if NOT in an active error episode
        // (errorEpisodeActive is reset by processThreadQueue on new user messages)
        if (!thread.errorEpisodeActive) {
          thread.errorCycles = 0;
          thread.errorMessagesSent = 0;
        }
      }
    }

    if (cleanedText) await routeAssistantReply(pi, cleanedText, attachments);
    else if (attachments.length) await routeAssistantReply(pi, "(image)", attachments);
  });

  /* ----  Session lifecycle  ---- */
  pi.on("session_start", async (event, ctx) => {
    activeCtx = ctx;
    resetGatewayRuntimeState();

    // Clean up stale uploaded files on session start
    cleanupFilesDir();

    // Capture current model info at session start
    // This ensures we have the model info for /new confirmation messages
    if (ctx.model) {
      currentModelInfo = {
        name: ctx.model.name ?? ctx.model.id ?? "default",
        provider: ctx.model.provider ?? "unknown",
        contextWindow: ctx.model.context_window ?? 128000,
      };
      console.log(`[thetis-gateway] Model captured at session start: ${currentModelInfo.name} (${currentModelInfo.provider}), window=${currentModelInfo.contextWindow}`);
    }

    // Auto-start gateways only when Pi runs as a service (RPC mode).
    // In TUI mode the user must start them manually with /gateway start.
    // GATEWAY_PLATFORM env var restricts which gateway to start (set by systemd services).
    if (config.autoStart && ctx.mode === "rpc") {
      const platform = process.env.GATEWAY_PLATFORM;
      
      if (platform === "discord") {
        // Only start Discord
        if (isGatewayEnabled("discord")) await startDiscord(pi, ctx);
      } else if (platform === "whatsapp") {
        // Only start WhatsApp
        if (isGatewayEnabled("whatsapp")) await startWhatsApp(pi, ctx);
      } else {
        // No platform restriction (backward compat or TUI mode)
        if (isGatewayEnabled("discord")) await startDiscord(pi, ctx);
        if (isGatewayEnabled("whatsapp")) await startWhatsApp(pi, ctx);
      }
      
      // Send startup confirmation ONLY on actual service startup (not on /new)
      // event.reason is "startup" for service start, "new" for /new command
      // Use a flag file to ensure message is sent only once across all gateways
      if (event.reason === "startup" || event.reason === "resume") {
        const flagFile = `/tmp/thetis-gateway-startup-flag`;
        const now = Date.now();
        let shouldSend = false;
        
        if (fs.existsSync(flagFile)) {
          const flagTime = parseInt(fs.readFileSync(flagFile, "utf8"));
          // If flag is older than 10 seconds, it's stale - send message
          if (now - flagTime > 10000) {
            shouldSend = true;
          }
        } else {
          shouldSend = true;
        }
        
        if (shouldSend) {
          fs.writeFileSync(flagFile, String(now));
          
          const startupMsg = `✅ Gateway redémarré avec succès !`;
          if (fs.existsSync(THREADS_DIR)) {
            const threadFiles = fs.readdirSync(THREADS_DIR).filter(f => f.endsWith(".json"));
            for (const file of threadFiles) {
              try {
                const threadId = file.replace(".json", "");
                const threadData = JSON.parse(fs.readFileSync(path.join(THREADS_DIR, file), "utf8"));
                // Extract platform and channelId from threadId (format: "platform:channelId")
                const [threadPlatform, ...channelIdParts] = threadId.split(":");
                const channelId = channelIdParts.join(":");
                
                if (threadPlatform === "discord") {
                  await sendDiscordReply(channelId, startupMsg);
                } else if (threadPlatform === "whatsapp") {
                  await sendWhatsAppReply(channelId, startupMsg);
                }
              } catch (err) {
                console.error(`[thetis-gateway] Failed to send startup message to thread ${file}:`, err);
              }
            }
          }
        }
      }
    }

    lastActiveThreadId = null;
  });

  /* ----  Model select — track current model for /new confirmation  ---- */
  pi.on("model_select", async (event, _ctx) => {
    currentModelInfo = {
      name: event.model.name ?? "default",
      provider: event.model.provider ?? "unknown",
      contextWindow: event.model.context_window ?? 128000,
    };
    console.log(`[thetis-gateway] Model tracked: ${currentModelInfo.name} (${currentModelInfo.provider}), window=${currentModelInfo.contextWindow}`);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await stopDiscord(ctx);
    await stopWhatsApp(ctx);
    activeCtx = null;
  });

  /* ----  Tool: read_pdf (extract text from PDFs with OCR + chunking)  ---- */
  registerReadPdfTool(pi);

  /* ----  Tool: gateway_send_file (send a file to the user)  ---- */
  pi.registerTool({
    name: "gateway_send_file",
    label: "Send File via Gateway",
    description:
      "Envoie un fichier à l'utilisateur via la gateway active (WhatsApp ou Discord). Utilisez cet outil pour renvoyer un fichier traité, généré ou sauvegardé.",
    promptGuidelines: [
      "Use gateway_send_file to send a file to the user when they ask for a file, when you've generated a file, or when you need to return a processed document.",
      "Provide the absolute path to the file. You can optionally provide a caption/description.",
      "Supported file types: any (PDF, DOCX, images, text files, etc.)",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Chemin absolu ou relatif vers le fichier à envoyer" }),
      caption: Type.Optional(Type.String({ description: "Légende ou description du fichier (optionnel)" })),
      deleteAfterSend: Type.Optional(Type.Boolean({ description: "Supprimer le fichier après l'envoi (défaut: false)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!currentThreadId) {
        return {
          content: [{ type: "text", text: "Erreur : aucun thread gateway actif." }],
          details: { sent: false, error: "no_active_thread" },
          isError: true,
        };
      }

      const thread = threads.get(currentThreadId);
      if (!thread) {
        return {
          content: [{ type: "text", text: "Erreur : thread actif introuvable." }],
          details: { sent: false, error: "thread_not_found" },
          isError: true,
        };
      }

      // Resolve path
      let filePath = params.path;
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(process.cwd(), filePath);
      }

      // Check file exists
      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `Erreur : fichier introuvable : ${filePath}` }],
          details: { sent: false, error: "file_not_found", path: filePath },
          isError: true,
        };
      }

      // Read file
      let fileBuffer: Buffer;
      try {
        fileBuffer = fs.readFileSync(filePath);
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Erreur lors de la lecture du fichier : ${e.message}` }],
          details: { sent: false, error: "read_error", path: filePath },
          isError: true,
        };
      }

      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase().slice(1);

      // Guess MIME type from extension
      const mimeMap: Record<string, string> = {
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        txt: "text/plain",
        md: "text/markdown",
        json: "application/json",
        csv: "text/csv",
        html: "text/html",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        zip: "application/zip",
        gz: "application/gzip",
        tar: "application/x-tar",
        mp3: "audio/mpeg",
        mp4: "video/mp4",
        wav: "audio/wav",
        ogg: "audio/ogg",
      };
      const contentType = mimeMap[ext] || "application/octet-stream";

      const caption = params.caption || "";

      try {
        if (thread.platform === "discord") {
          await sendDiscordReply(thread.channelId, caption, [{ name: fileName, data: fileBuffer, contentType }]);
        } else if (thread.platform === "whatsapp") {
          await sendWhatsAppReply(thread.channelId, caption, [{ name: fileName, data: fileBuffer, contentType }]);
        }

        // Delete file after sending if requested
        if (params.deleteAfterSend) {
          try {
            fs.unlinkSync(filePath);
          } catch (e: any) {
            console.error(`Failed to delete file after sending: ${e.message}`);
          }
        }

        return {
          content: [{ type: "text", text: `✅ Fichier envoyé${params.deleteAfterSend ? " et supprimé" : ""} : ${fileName} (${(fileBuffer.length / 1024).toFixed(1)} KB)` }],
          details: { sent: true, path: filePath, fileName, size: fileBuffer.length, contentType, deleted: params.deleteAfterSend },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Erreur lors de l'envoi du fichier : ${e.message}` }],
          details: { sent: false, error: "send_error", path: filePath },
          isError: true,
        };
      }
    },
  });

  /* ----  System Prompt Injection  ---- */
  pi.on("before_agent_start", async (event, _ctx) => {
    let injection = "";

    if (currentThreadId || _ctx.mode === "rpc") {
      injection += "\n\n⚠️ GATEWAY MODE ACTIVE (WhatsApp/Discord)";
    }

    const hasFileMention = event.prompt.includes("[File saved:");

    if (hasFileMention) {
      let fileInstruction = "\n\nIMPORTANT : Des fichiers ont été sauvegardés sur le disque.";
      if (event.prompt.includes(".pdf")) {
        fileInstruction += "\n\n🚨 PDF DÉTECTÉ — Utilisez UNIQUEMENT le tool `read_pdf` pour lire les PDF. N'utilisez JAMAIS `pdftotext`, `pdftoppm`, `tesseract` ou tout autre commande manuelle. `read_pdf` gère automatiquement l'extraction texte, l'OCR fallback, et le chunking pour ne pas surcharger le contexte.";
      }
      fileInstruction += " Vous pouvez utiliser `read` ou `bash` pour accéder aux autres fichiers sauvegardés.";
      fileInstruction += " Pour renvoyer un fichier à l'utilisateur, utilisez le tool `gateway_send_file` avec le chemin du fichier. Utilisez `deleteAfterSend: true` si le fichier est temporaire.";
      injection += fileInstruction;
    }

    if (injection) {
      return {
        systemPrompt: event.systemPrompt + injection,
      };
    }

    return {};
  });

  /* ----  Commands  ---- */
  pi.registerCommand("gateway", {
    description: "Control the Discord/WhatsApp gateway",
    handler: async (args, ctx) => {
      try {
        const result = await runGatewayCommand(args, pi, ctx);
        if (result) {
          ctx.ui.notify(result.text, result.error ? "warning" : "info");
        }
      } catch (err: any) {
        // Never let an exception escape the command handler — it would
        // crash the Pi process (and trigger the "Select a session to
        // restore" loop on the next start). Surface it as a notification.
        ctx.ui.notify(`Gateway command error: ${err?.message ?? err}`, "error");
      }
    },
  });

  /* ----  Boot command  ---- */
  pi.registerCommand("gateway-boot", {
    description: "Configure systemd boot service for the gateway",
    handler: async (args, ctx) => {
      try {
        const result = await runGatewayBootCommand(args, pi, ctx);
        if (result) {
          ctx.ui.notify(result.text, result.error ? "warning" : "info");
        }
      } catch (err: any) {
        ctx.ui.notify(`Gateway-boot command error: ${err?.message ?? err}`, "error");
      }
    },
  });
}

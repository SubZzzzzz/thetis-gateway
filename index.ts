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

/* ------------------------------------------------------------------ */
/*  Paths                                                              */
/* ------------------------------------------------------------------ */

const EXT_DIR = path.join(homedir(), ".pi", "agent", "extensions", "thetis-gateway");
const CONFIG_PATH = path.join(EXT_DIR, "config.json");
const THREADS_DIR = path.join(EXT_DIR, "threads");

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
  if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });
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

function isWhatsAppAuthorized(jid: string): boolean {
  const allowed = config.whatsapp?.allowedPhoneNumbers;
  if (!allowed || allowed.length === 0) return false;
  const phone = normalizePhone(jid.split("@")[0]);
  return allowed.some((a) => normalizePhone(a) === phone);
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
  replyJid?: string;
  messages: ThreadMessage[];
  pendingQueue: { text: string; images?: any[] }[];
  processing: boolean;
  pendingMessageId?: string;
  typingInterval?: NodeJS.Timeout;
}

const threads = new Map<string, ChannelThread>();
let currentThreadId: string | null = null;
let activeCtx: ExtensionContext | null = null;
let lastActiveThreadId: string | null = null;
let lastActivePlatform: "discord" | "whatsapp" | null = null;
let lastActiveChannelId: string | null = null;
let restartNotified = false;
let isFreshNewSession = false;

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

  const sent = await whatsappSock.sendMessage(jid, {
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
  if (sent?.key?.id) trackSentWhatsAppId(sent.key.id);
}

// Exposed to thetis-memory extension (same Node process)
(globalThis as any).__gatewayConfirm = async (question: string): Promise<boolean> => {
  const threadId = currentThreadId;
  if (!threadId) return false;
  const thread = threads.get(threadId);
  if (!thread) return false;

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

async function sendWhatsAppPoll(jid: string, question: string, options: string[]): Promise<void> {
  if (!isWhatsAppReady()) return;

  const rows = options.map((opt, i) => ({
    title: `${i + 1}. ${opt.slice(0, 72)}`,
    description: "",
    rowId: `gateway_q_${i}`,
  }));

  rows.push({
    title: `${options.length + 1}. ✏️ Autres...`,
    description: "Écrivez votre propre réponse",
    rowId: "gateway_q_other",
  });

  const sent = await whatsappSock.sendMessage(jid, {
    text: `🗳️ ${question}`,
    footer: "Sélectionnez une option ci-dessous",
    title: "Sondage",
    buttonText: "Voir les options",
    sections: [{ title: "Options disponibles", rows }],
  }).catch(() => null);
  if (sent?.key?.id) trackSentWhatsAppId(sent.key.id);
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
  "new", "reset", "model", "name", "title", "compact", "stop",
  "thinking", "fork", "clone", "export", "import", "copy",
  "reload", "reload-mcp", "reload-skills", "learn", "personality",
  "fast", "verbose", "footer", "yolo", "reasoning", "codex-runtime",
  "voice", "update", "version", "debug", "kanban", "goal", "subgoal",
  "moa", "queue", "steer", "q", "background", "bg", "btw", "agents",
  "tasks", "memory", "skills", "bundles", "suggestions", "blueprint",
  "bp", "curator", "approve", "deny", "platform", "sethome",
  "usage", "credits", "insights", "topic", "retry", "undo",
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
    // For /new and /reset, clear the thread history and show model+context info
    if (cmd === "new" || cmd === "reset") {
      thread.messages = [];
      saveThreadHistory(getThreadId(thread.platform, thread.channelId), []);

      // Build rich info message directly from the active context
      const ctx = activeCtx;
      const modelName = ctx?.model?.name ?? "(inconnu)";
      const provider = ctx?.model?.provider ?? "—";
      const usage = ctx?.getContextUsage?.();
      let infoMsg = `🆕 **Nouvelle session initialisée**\n🤖 Modèle : **${modelName}** (${provider})`;
      if (usage) {
        const tokens = usage.tokens ?? "?";
        const window = usage.contextWindow;
        const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
        infoMsg += `\n📊 Contexte : ${tokens} / ${window} tokens (${percent})`;
      }
      infoMsg += `\n\n🧹 *L'historique de ce canal a été vidé. Le contexte global de Pi reste inchangé.*`;
      await replyToThread(thread, infoMsg);
      return { handled: true };
    }

    // Send to pi
    pi.sendUserMessage(text, { deliverAs: "followUp" });

    // Send immediate confirmation for other silent commands
    const confirmations: Record<string, string> = {
        model: args ? `🤖 Changement de modèle en cours…` : `🤖 Modèle actuel demandé…`,
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
            attachments.push({ type: "image", source: { type: "url", url: att.url } });
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

      // Show thinking indicator
      await startThinkingIndicator(thread);

      const fullText = (text || "(attachment)") + fileContentText;
      // Queue the message
      thread.pendingQueue.push({ text: fullText, images: attachments.length ? attachments : undefined });
      thread.messages.push({ role: "user", text: fullText.slice(0, 200), timestamp: Date.now(), hasImage: attachments.length > 0 });
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
            { name: "restart", type: 1, description: "Redémarrer le service gateway" },
            { name: "setup", type: 1, description: "Configurer le gateway (requiert le TUI)" },
            { name: "pair", type: 1, description: "Appairer WhatsApp par QR code", options: [{ name: "target", type: 3, description: "Plateforme à appairer", required: true, choices: [{ name: "whatsapp", value: "whatsapp" }] }] },
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
    discordClient = client;
    ctx.ui.notify(`Discord connected as ${client.user?.tag ?? "bot"}`, "success");
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
  whatsapp: { fatalError: null, reconnectAttempts: 0, maxReconnectAttempts: 3 },
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

/* ------------------------------------------------------------------ */
/*  WhatsApp (Baileys)                                                 */
/* ------------------------------------------------------------------ */

let whatsappSock: any = null;

const sentWhatsAppMessageIds = new Set<string>();

function trackSentWhatsAppId(id: string | undefined | null): void {
  if (!id) return;
  if (sentWhatsAppMessageIds.size > 200) {
    const last100 = Array.from(sentWhatsAppMessageIds).slice(-100);
    sentWhatsAppMessageIds.clear();
    last100.forEach((x) => sentWhatsAppMessageIds.add(x));
  }
  sentWhatsAppMessageIds.add(id);
}

function isWhatsAppReady(): boolean {
  // Baileys v7: ws.readyState is undefined, use ws.socket.readyState
  return whatsappSock && (whatsappSock.ws?.readyState === 1 || whatsappSock.ws?.socket?.readyState === 1);
}

function hasWhatsAppCredentials(authDir: string): boolean {
  const credsPath = path.join(authDir, "creds.json");
  if (!fs.existsSync(credsPath)) return false;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    // Baileys may not set registered=true after pairing;
    // only me.id is populated. Accept either flag.
    return !!((creds.registered || creds.me?.id) && creds.me && creds.me.id);
  } catch {
    return false;
  }
}

async function sendWhatsAppReply(jid: string, text: string, attachments?: OutgoingAttachment[]): Promise<string | null> {
  if (!isWhatsAppReady()) {
    console.log("[WA DEBUG sendWhatsAppReply] sock not ready");
    return null;
  }

  let lastMessageId: string | null = null;

  if (attachments?.length) {
    for (const att of attachments) {
      try {
        if (att.contentType.startsWith("image/")) {
          const sent = await whatsappSock.sendMessage(jid, { image: att.data, caption: text });
          if (sent?.key?.id) {
            lastMessageId = sent.key.id;
            trackSentWhatsAppId(sent.key.id);
          }
          text = ""; // caption sent with first image only
        } else {
          const sent = await whatsappSock.sendMessage(jid, {
            document: att.data,
            mimetype: att.contentType || "application/octet-stream",
            fileName: att.name,
            caption: text,
          });
          if (sent?.key?.id) {
            lastMessageId = sent.key.id;
            trackSentWhatsAppId(sent.key.id);
          }
          text = "";
        }
      } catch (e: any) {
        console.error("[WA DEBUG sendWhatsAppReply] attachment failed:", e?.message || e);
      }
    }
  }

  if (text) {
    try {
      const sent = await whatsappSock.sendMessage(jid, { text });
      if (sent?.key?.id) {
        lastMessageId = sent.key.id;
        trackSentWhatsAppId(sent.key.id);
      }
      console.log(`[WA DEBUG sendWhatsAppReply] text sent to ${jid} id=${sent?.key?.id}`);
    } catch (e: any) {
      console.error(`[WA DEBUG sendWhatsAppReply] text send FAILED to ${jid}:`, e?.message || e);
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

    const sessionName = config.whatsapp?.sessionName ?? "thetis-gateway";
    const authDir = path.join(EXT_DIR, `.baileys_auth_${sessionName}`);

    if (!hasWhatsAppCredentials(authDir)) {
      ctx.ui.notify(
        "WhatsApp not paired yet. Run /gateway pair whatsapp to pair via QR code.",
        "warning"
      );
      return;
    }

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

      const { connection, lastDisconnect } = update;
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.outputStatusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const errMsg = lastDisconnect?.error?.message || "unknown";

        if (isLoggedOut) {
          ctx.ui.notify("WhatsApp logged out — not retrying.", "warning");
          runtimeState.whatsapp.fatalError = "Logged out";
          return;
        }

        runtimeState.whatsapp.reconnectAttempts++;
        if (runtimeState.whatsapp.reconnectAttempts > runtimeState.whatsapp.maxReconnectAttempts) {
          runtimeState.whatsapp.fatalError = `Connection failed after ${runtimeState.whatsapp.maxReconnectAttempts} attempts (code ${statusCode}: ${errMsg})`;
          ctx.ui.notify(`WhatsApp fatal error: ${runtimeState.whatsapp.fatalError}`, "error");
          return;
        }

        ctx.ui.notify(`WhatsApp closed (attempt ${runtimeState.whatsapp.reconnectAttempts}/${runtimeState.whatsapp.maxReconnectAttempts}, code ${statusCode}) — retry in 5s.`, "warning");
        setTimeout(() => startWhatsApp(pi, ctx), 5000);
      } else if (connection === "open") {
        runtimeState.whatsapp.reconnectAttempts = 0;
        ctx.ui.notify("WhatsApp connected", "success");
      }
    });

    sock.ev.on("messages.upsert", async (m: any) => {
      const msg = m.messages[0];
      if (!msg) {
        console.log("[WA DEBUG] messages.upsert: empty message");
        return;
      }
      console.log(`[WA DEBUG] raw msg: jid=${msg.key?.remoteJid} fromMe=${msg.key?.fromMe} id=${msg.key?.id} hasMessage=${!!msg.message}`);
      if (!msg.message) {
        console.log("[WA DEBUG] no msg.message — skipping");
        return;
      }

      // Ignore messages sent by this Baileys instance to avoid loops
      if (msg.key.fromMe && sentWhatsAppMessageIds.has(msg.key.id)) {
        console.log("[WA DEBUG] ignoring message sent by this Baileys instance");
        return;
      }

      // For fromMe messages from other devices (phone), only allow self-conversation
      let isSelfConversation = false;
      if (msg.key.fromMe) {
        const myPhone = whatsappSock.user?.id?.split("@")[0]?.split(":")[0];
        const myLid = whatsappSock.user?.lid?.split("@")[0]?.split(":")[0];
        const remoteId = msg.key.remoteJid?.split("@")[0];
        console.log(`[WA DEBUG] fromMe check: myPhone=${myPhone} myLid=${myLid} remoteId=${remoteId}`);
        isSelfConversation = myPhone === remoteId || myLid === remoteId;
        if (!isSelfConversation) {
          console.log("[WA DEBUG] fromMe to someone else — skipping");
          return;
        }
      }

      const jid = msg.key.remoteJid;
      const authorized = isSelfConversation || isWhatsAppAuthorized(jid);
      console.log(`[WA DEBUG] authorization check: jid=${jid} isSelf=${isSelfConversation} authorized=${authorized}`);
      if (!authorized) return;

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
      // Ensure we have a usable reply JID (LIDs cannot receive messages)
      if (!thread.replyJid) {
        thread.replyJid = resolveWhatsAppReplyJid(jid);
        console.log(`[WA DEBUG] resolved replyJid for ${jid} -> ${thread.replyJid}`);
      }
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
              attachments.push({ type: "image", source: { type: "base64", mediaType, data: b64 } });
            } else if (mediaType.startsWith("text/") || isTextFile(msg.message.documentMessage?.fileName || "")) {
              const content = buffer.toString("utf8");
              text += `\n\n--- File: ${msg.message.documentMessage?.fileName || "attachment"} ---\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``;
            } else {
              text += `\n\n[File attached: ${msg.message.documentMessage?.fileName || "attachment"} (${mediaType})]`;
            }
          }
        } catch {
          // Media download failed, continue without it
        }
      }

      const fullText = text || "(attachment)";
      thread.pendingQueue.push({ text: fullText, images: attachments.length ? attachments : undefined });
      thread.messages.push({ role: "user", text: fullText.slice(0, 200), timestamp: Date.now(), hasImage: attachments.length > 0 });
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
/*  Thread Queue Processor                                             */
/* ------------------------------------------------------------------ */

async function processThreadQueue(pi: ExtensionAPI, thread: ChannelThread) {
  if (thread.processing) return;
  thread.processing = true;

  while (thread.pendingQueue.length > 0) {
    const item = thread.pendingQueue.shift()!;

    try {
      if (item.images && item.images.length > 0) {
        // Send as content array with images
        const content = [{ type: "text", text: item.text }, ...item.images];
        pi.sendUserMessage(content as any, { deliverAs: "followUp" });
      } else {
        pi.sendUserMessage(item.text, { deliverAs: "followUp" });
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

function resolveWhatsAppReplyJid(jid: string): string {
  if (!jid.endsWith("@lid")) return jid;
  const lid = jid.split("@")[0];
  const sessionName = config.whatsapp?.sessionName ?? "thetis-gateway";
  const authDir = path.join(EXT_DIR, `.baileys_auth_${sessionName}`);
  // 1. Check if this is our own LID (self-conversation) — use plain JID (no device suffix)
  const myLid = whatsappSock?.user?.lid?.split("@")[0]?.split(":")[0];
  if (myLid === lid) {
    const credsPath = path.join(authDir, "creds.json");
    if (fs.existsSync(credsPath)) {
      try {
        const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
        const meId = creds.me?.id;
        if (meId && typeof meId === "string") {
          // Strip device suffix: 33786161438:9@s.whatsapp.net → 33786161438@s.whatsapp.net
          return meId.replace(/:\d+@/, "@");
        }
      } catch {}
    }
    const plainJid = whatsappSock?.user?.id?.replace(/:\d+@/, "@");
    if (plainJid) return plainJid;
  }
  // 2. For other contacts, read the reverse LID mapping
  const reverseMap = path.join(authDir, `lid-mapping-${lid}_reverse.json`);
  if (fs.existsSync(reverseMap)) {
    try {
      const phone = JSON.parse(fs.readFileSync(reverseMap, "utf8"));
      if (phone && typeof phone === "string") return `${phone}@s.whatsapp.net`;
    } catch {}
  }
  return jid;
}

async function routeAssistantReply(pi: ExtensionAPI, text: string, attachments?: OutgoingAttachment[]) {
  console.log(`[WA DEBUG routeAssistantReply] currentThreadId=${currentThreadId}`);
  if (!currentThreadId) {
    console.log("[WA DEBUG routeAssistantReply] no currentThreadId — aborting");
    return;
  }

  const thread = threads.get(currentThreadId);
  if (!thread) {
    console.log(`[WA DEBUG routeAssistantReply] thread not found for ${currentThreadId} — aborting`);
    return;
  }
  const targetJid = thread.replyJid || thread.channelId;
  console.log(`[WA DEBUG routeAssistantReply] thread=${thread.platform}:${thread.channelId} replyJid=${thread.replyJid} target=${targetJid} text="${text.slice(0,50)}"`);

  // Save to thread history
  thread.messages.push({ role: "assistant", text, timestamp: Date.now() });
  saveThreadHistory(currentThreadId, thread.messages);

  if (thread.platform === "discord") {
    await sendDiscordReply(thread.channelId, text, attachments);
  } else if (thread.platform === "whatsapp") {
    console.log(`[WA DEBUG routeAssistantReply] calling sendWhatsAppReply(${targetJid}, text.length=${text.length})`);
    await sendWhatsAppReply(targetJid, text, attachments);
    console.log(`[WA DEBUG routeAssistantReply] sendWhatsAppReply done`);
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
      if (sent?.key?.id) {
        thread.pendingMessageId = sent.key.id;
        trackSentWhatsAppId(sent.key.id);
      }
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
/*  WhatsApp QR Pairing                                                */
/* ------------------------------------------------------------------ */

async function pairWhatsApp(pi: ExtensionAPI, ctx?: ExtensionContext): Promise<CommandResult> {
  if (!ctx?.hasUI) {
    return {
      text: `WhatsApp QR pairing requires the TUI. Please run /gateway pair whatsapp from the terminal.`,
      error: true,
    };
  }

  const sessionName = config.whatsapp?.sessionName ?? "thetis-gateway";
  const authDir = path.join(EXT_DIR, `.baileys_auth_${sessionName}`);

  // Clear existing auth to force fresh pairing
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }

  return new Promise(async (resolve) => {
    let pairingSock: any = null;
    let socketId = 0;
    let qrCount = 0;
    let resolved = false;
    let timeout: NodeJS.Timeout;
    let restartAttempts = 0;
    const MAX_RESTART_ATTEMPTS = 3;
    let hasOpened = false;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (pairingSock) {
        const deadSock = pairingSock;
        pairingSock = null;
        try { deadSock.ev.removeAllListeners("creds.update"); } catch {}
        try { deadSock.ev.removeAllListeners("connection.update"); } catch {}
        try { deadSock.ws?.socket?.close(); } catch {}
        try { deadSock.ws?.close(); } catch {}
        try { deadSock.end(); } catch {}
      }
    };

    const resolveOnce = (result: CommandResult) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      // Clear the QR widget from TUI
      try { ctx.ui.setWidget("gateway-qr", []); } catch {}
      resolve(result);
    };

    // 3-minute timeout for the whole pairing process
    timeout = setTimeout(() => {
      resolveOnce({ text: "⏱️ WhatsApp pairing timed out after 3 minutes. Please try again.", error: true });
    }, 180_000);

    const startPairing = async () => {
      // ── 1. Nuke any lingering previous socket  ──
      if (pairingSock) {
        const oldSock = pairingSock;
        pairingSock = null;
        try { oldSock.ev.removeAllListeners("creds.update"); } catch {}
        try { oldSock.ev.removeAllListeners("connection.update"); } catch {}
        try { oldSock.ws?.socket?.terminate(); } catch {}
        try { oldSock.ws?.close(); } catch {}
        try { oldSock.end(); } catch {}
        // Let the TCP stack clean up before we create a new socket
        await new Promise((r) => setTimeout(r, 800));
      }

      // ── 2. Peek at the credentials file on disk  ──
      try {
        const credsPath = path.join(authDir, "creds.json");
        if (fs.existsSync(credsPath)) {
          const raw = fs.readFileSync(credsPath, "utf8");
          const parsed = JSON.parse(raw);
          ctx.ui.notify(
            `[WA] disk creds: me=${parsed.me?.id ? "yes" : "no"} registered=${parsed.registered ? "yes" : "no"} ` +
            `keys=${Object.keys(parsed).length}`,
            "info"
          );
        } else {
          ctx.ui.notify(`[WA] disk creds: none (fresh pairing)`, "info");
        }
      } catch (e: any) {
        ctx.ui.notify(`[WA] disk creds read error: ${e.message}`, "warning");
      }

      try {
        const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, Browsers } =
          await import("@whiskeysockets/baileys");

        const { state, saveCreds } = await useMultiFileAuthState(authDir);

        // Log credential state so we know if Baileys loaded partial or full creds
        ctx.ui.notify(
          `[WA] socket #${socketId + 1} memory creds: me=${state.creds.me?.id ? "yes" : "no"} registered=${state.creds.registered ? "yes" : "no"}`,
          "info"
        );

        // Silence Baileys internal logs so they don't corrupt the TUI display
        const silentLogger = {
          info: () => {},
          error: () => {},
          debug: () => {},
          warn: () => {},
          trace: () => {},
          child: () => silentLogger,
          level: "silent",
        };

        const sock = makeWASocket({
          auth: state,
          printQRInTerminal: false,
          browser: Browsers.ubuntu('Chrome'),
          logger: silentLogger as any,
        });

        const thisSocketId = ++socketId;
        pairingSock = sock;

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update: any) => {
          // Ignore events from dead sockets (both the old reference check and the ID check)
          if (pairingSock !== sock || socketId !== thisSocketId) return;

          const { connection, lastDisconnect, qr } = update;

          if (qr) {
            qrCount++;
            const qrImagePath = path.join(EXT_DIR, `whatsapp-qr-${qrCount}.png`);
            // Save QR as image file
            try {
              const QRCode = await import("qrcode");
              await QRCode.default.toFile(qrImagePath, qr, { width: 400, margin: 2 });
              ctx.ui.notify(
                `📱 WhatsApp QR code #${qrCount} generated.\n` +
                `   Scan it with WhatsApp → Settings → Linked Devices → Link a device.\n` +
                `   Image: ${qrImagePath}`,
                "info"
              );
            } catch (qrErr: any) {
              ctx.ui.notify(
                `📱 WhatsApp QR code #${qrCount} (image save failed: ${qrErr.message}).\n` +
                `   Raw QR string: ${qr}`,
                "info"
              );
            }

            // Render QR as a chat message so it gets full vertical space and isn't truncated
            try {
              const QRCode = await import("qrcode");
              const qrAscii = await QRCode.default.toString(qr, { type: "terminal", small: true });
              pi.sendMessage(
                {
                  customType: "gateway-qr",
                  content: qrAscii,
                  display: true,
                },
                { triggerTurn: false }
              );
            } catch (qrErr: any) {
              pi.sendMessage(
                {
                  customType: "gateway-qr",
                  content: qr,
                  display: true,
                },
                { triggerTurn: false }
              );
            }
          }

          if (connection === "open") {
            hasOpened = true;
            resolveOnce({
              text: `✅ WhatsApp paired successfully!\nSession: ${sessionName}\nYou can now start the gateway with /gateway restart whatsapp or /gateway-boot start.`,
            });
            return;
          }

          if (connection === "close") {
            const rawError = lastDisconnect?.error as any;
            const statusCode = rawError?.output?.statusCode ?? rawError?.statusCode;
            const errMsg: string = rawError?.message || rawError?.output?.payload?.message || "unknown";

            const isLoggedOut =
              statusCode === DisconnectReason.loggedOut ||
              /logged\s*out/i.test(errMsg);

            if (isLoggedOut) {
              resolveOnce({ text: `❌ WhatsApp pairing failed: logged out.`, error: true });
              return;
            }

            // ── Socket death & credential flush ──
            // Mark this socket dead immediately so late events are ignored
            const dyingSock = sock;
            pairingSock = null;
            try { dyingSock.ev.removeAllListeners("creds.update"); } catch {}
            try { dyingSock.ev.removeAllListeners("connection.update"); } catch {}
            try { dyingSock.ws?.socket?.terminate(); } catch {}

            // Force-flush credentials to disk NOW before we recreate the socket
            try {
              await saveCreds();
              ctx.ui.notify(`[WA] credentials flushed to disk after close`, "info");
            } catch (flushErr: any) {
              ctx.ui.notify(`[WA] credentials flush error: ${flushErr.message}`, "warning");
            }

            restartAttempts++;
            if (restartAttempts > MAX_RESTART_ATTEMPTS) {
              resolveOnce({ text: `❌ WhatsApp pairing failed: too many reconnection attempts (${MAX_RESTART_ATTEMPTS}).`, error: true });
              return;
            }

            ctx.ui.notify(
              `🔄 WhatsApp reconnecting (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}).\n` +
              `   Enter your PIN on the phone if asked. A new QR will appear shortly if needed.`,
              "info"
            );

            // Wait 4 seconds before reconnecting:
            //  • saveCreds already flushed above, but give the FS a moment
            //  • WhatsApp needs a beat to propagate the companion-pairing state
            setTimeout(() => {
              if (!resolved) startPairing();
            }, 4_000);
            return;
          }
        });
      } catch (err: any) {
        resolveOnce({ text: `❌ WhatsApp pairing error: ${err.message ?? err}`, error: true });
      }
    };

    ctx.ui.notify("🔵 Starting WhatsApp QR pairing… Wait for the QR code to appear.", "info");
    await startPairing();
  });
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
  ctx?: ExtensionContext
): Promise<CommandResult | null> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();

  if (sub === "pair") {
    const target = parts[1]?.toLowerCase();
    if (target === "whatsapp") {
      return await pairWhatsApp(pi, ctx);
    }
    if (!target) {
      return { text: `Usage: /gateway pair whatsapp\nStarts QR code pairing for WhatsApp.`, error: true };
    }
    return { text: `Unknown pairing target: ${target}. Available: whatsapp`, error: true };
  }

  if (sub === "restart") {
    const target = parts[1]?.toLowerCase();
    // Soft restart: reconnect Discord/WhatsApp without killing the Pi session
    if (ctx) {
      if (!target || target === "discord") { await stopDiscord(ctx); await startDiscord(pi, ctx); }
      if (!target || target === "whatsapp") { await stopWhatsApp(ctx); await startWhatsApp(pi, ctx); }
    }
    const d = isDiscordReady() ? "🟢" : (runtimeState.discord.fatalError ? "⛔" : "🔴");
    const w = isWhatsAppReady() ? "🟢" : (runtimeState.whatsapp.fatalError ? "⛔" : "🔴");
    return { text: `🔄 Gateway reconnecté.\nDiscord: ${d} | WhatsApp: ${w}` };
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
    if (!ctx?.hasUI) {
      return {
        text: `Inline setup not supported from gateway.\nUse TUI command /gateway setup, or edit:\n${CONFIG_PATH}`,
        error: true,
      };
    }

    // ---------- Discord ----------
    const prevDiscordEnabled = config.discord?.enabled ?? false;
    const discordEnabled = await ctx.ui.confirm(
      "Enable Discord gateway?",
      prevDiscordEnabled
    );

    let discordToken = "";
    let discordUserIds = "";

    if (discordEnabled) {
      const prevDiscordToken = config.discord?.token || process.env.DISCORD_BOT_TOKEN || "";
      const discordTokenRaw = await ctx.ui.input(
        "Discord bot token (leave empty to keep previous):",
        prevDiscordToken
      );
      if (discordTokenRaw === undefined) return { text: "Setup cancelled.", error: true };
      discordToken = discordTokenRaw.trim() || prevDiscordToken;

      const prevDiscordUserIds = config.discord?.allowedUserIds?.join(", ") || "";
      const discordUserIdsRaw = await ctx.ui.input(
        "Authorized Discord user IDs (comma-separated, REQUIRED):",
        prevDiscordUserIds
      );
      if (discordUserIdsRaw === undefined) return { text: "Setup cancelled.", error: true };
      discordUserIds = discordUserIdsRaw.trim() || prevDiscordUserIds;
    }

    // ---------- WhatsApp ----------
    const prevWhatsappEnabled = config.whatsapp?.enabled ?? false;
    const whatsappEnabled = await ctx.ui.confirm(
      "Enable WhatsApp gateway?",
      prevWhatsappEnabled
    );

    let whatsappPhones = "";
    let sessionName = "thetis-gateway";

    if (whatsappEnabled) {
      const prevWhatsappPhones = config.whatsapp?.allowedPhoneNumbers?.join(", ") || "";
      const whatsappPhonesRaw = await ctx.ui.input(
        "Authorized WhatsApp phone numbers (comma-separated, REQUIRED):",
        prevWhatsappPhones
      );
      if (whatsappPhonesRaw === undefined) return { text: "Setup cancelled.", error: true };
      whatsappPhones = whatsappPhonesRaw.trim() || prevWhatsappPhones;

      const prevSessionName = config.whatsapp?.sessionName ?? "thetis-gateway";
      const sessionNameRaw = await ctx.ui.input(
        `WhatsApp session name [${prevSessionName}]:`,
        prevSessionName
      );
      if (sessionNameRaw === undefined) return { text: "Setup cancelled.", error: true };
      sessionName = sessionNameRaw.trim() || prevSessionName;
    }

    // ---------- Global ----------
    const prevMaxHistory = String(config.maxHistoryPerThread ?? 100);
    const maxHistoryRaw = await ctx.ui.input(
      "Max messages per thread history [100]:",
      prevMaxHistory
    );
    if (maxHistoryRaw === undefined) return { text: "Setup cancelled.", error: true };
    const maxHistory = maxHistoryRaw.trim() || prevMaxHistory;

    const parsedDiscordIds = discordUserIds
      ? discordUserIds.split(",").map((s: string) => s.trim()).filter(Boolean)
      : [];
    const parsedWhatsappPhones = whatsappPhones
      ? whatsappPhones.split(",").map((s: string) => s.trim()).filter(Boolean)
      : [];

    if (discordEnabled && discordToken && parsedDiscordIds.length === 0) {
      return { text: "Discord is enabled but no authorized user IDs were provided. Setup aborted.", error: true };
    }
    if (whatsappEnabled && parsedWhatsappPhones.length === 0) {
      return { text: "WhatsApp is enabled but no authorized phone numbers were provided. Setup aborted.", error: true };
    }

    const newConfig: GatewayConfig = {
      autoStart: true,
      maxHistoryPerThread: parseInt(maxHistory, 10) || 100,
      discord: discordEnabled && discordToken
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



    return { text: "Gateway config saved. Use /gateway-boot start to connect." };
  }

  // Unknown sub-command — return help
  return {
    text: `Usage: /gateway restart|status|threads|clear|setup|pair`,
    error: true,
  };
}

async function runGatewayBootCommand(
  args: string,
  _pi?: ExtensionAPI,
  ctx?: ExtensionContext
): Promise<CommandResult | null> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const installScript = path.join(EXT_DIR, "scripts", "install-boot.sh");
  const serviceName = "thetis-gateway";

  if (sub === "install" || sub === "enable") {
    if (!ctx?.hasUI) {
      return {
        text: `Run in terminal:\n  bash "${installScript}" install`,
        error: true,
      };
    }
    try {
      const { execSync } = await import("node:child_process");
      execSync(`"${installScript}" install`, { stdio: "inherit" });
      return { text: "Boot service installed. Run /gateway-boot start to launch." };
    } catch {
      return { text: "Boot service installation failed.", error: true };
    }
  }

  if (sub === "remove" || sub === "disable") {
    if (!ctx?.hasUI) {
      return {
        text: `Run in terminal:\n  bash "${installScript}" remove`,
        error: true,
      };
    }
    try {
      const { execSync } = await import("node:child_process");
      execSync(`"${installScript}" remove`, { stdio: "inherit" });
      return { text: "Boot service removed." };
    } catch {
      return { text: "Boot service removal failed.", error: true };
    }
  }

  if (sub === "start") {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`systemctl --user start ${serviceName}`, { stdio: "pipe" });
      return { text: "Gateway service started." };
    } catch {
      return { text: "Failed to start gateway service.", error: true };
    }
  }

  if (sub === "stop") {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`systemctl --user stop ${serviceName}`, { stdio: "pipe" });
      return { text: "Gateway service stopped." };
    } catch {
      return { text: "Failed to stop gateway service.", error: true };
    }
  }

  if (sub === "status") {
    try {
      const { execSync } = await import("node:child_process");
      const out = execSync(`systemctl --user status ${serviceName} --no-pager`, { encoding: "utf8" });
      return { text: out.slice(0, 1800) };
    } catch (err: any) {
      return { text: err.stdout?.toString()?.slice(0, 1800) || "Service not running.", error: true };
    }
  }

  if (sub === "linger") {
    if (!ctx?.hasUI) {
      return {
        text: `Run in terminal:\n  loginctl enable-linger $USER`,
        error: true,
      };
    }
    try {
      const { execSync } = await import("node:child_process");
      execSync(`loginctl enable-linger $USER`, { stdio: "inherit" });
      return { text: "User linger enabled. Service will start at boot even before login." };
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
/*  Extension factory                                                  */
/* ------------------------------------------------------------------ */

export default function thetisGatewayExtension(pi: ExtensionAPI) {

  /* ----  Custom message renderer for QR codes  ---- */
  pi.registerMessageRenderer("gateway-qr", (message, _options, _theme) => {
    const lines = (message.content || "").split("\n");
    return {
      render: (_width: number) => lines,
      invalidate: () => {},
    };
  });

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

  /* ----  Capture assistant replies and route them  ---- */
  pi.on("message_end", async (event) => {
    console.log(`[WA DEBUG message_end] role=${event.message.role} currentThreadId=${currentThreadId}`);
    if (event.message.role !== "assistant") return;
    if (!currentThreadId) {
      console.log("[WA DEBUG message_end] currentThreadId is null — skipping");
      return;
    }

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

    if (cleanedText) await routeAssistantReply(pi, cleanedText, attachments);
    else if (attachments.length) await routeAssistantReply(pi, "(image)", attachments);
  });

  /* ----  Session lifecycle  ---- */
  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    threads.clear();
    currentThreadId = null;
    resetGatewayRuntimeState();

    // Auto-start gateways only when Pi runs as a service (RPC mode).
    // In TUI mode the user must start them manually with /gateway-boot start.
    if (config.autoStart && ctx.mode === "rpc") {
      if (isGatewayEnabled("discord")) await startDiscord(pi, ctx);
      if (isGatewayEnabled("whatsapp")) await startWhatsApp(pi, ctx);
    }

    // Reset session tracking (but keep lastActivePlatform/lastActiveChannelId
    // for model_select to pick up and send the rich session-info message)
    lastActiveThreadId = null;
  });

  /* ----  Model select — notify gateway when model is selected after /new  ---- */
  pi.on("model_select", async (event, ctx) => {
    if (!isFreshNewSession) return; // ignore model changes not triggered by /new
    if (!lastActivePlatform || !lastActiveChannelId) return;

    const modelName = event.model.name ?? "default";
    const provider = event.model.provider ?? "unknown";
    const usage = ctx.getContextUsage?.();
    let infoMsg = `🆕 **Nouvelle session prête**\n🤖 Modèle : **${modelName}** (${provider})`;
    if (usage) {
      const tokens = usage.tokens ?? "?";
      const window = usage.contextWindow;
      const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
      infoMsg += `\n📊 Contexte : ${tokens} / ${window} tokens (${percent})`;
    }

    if (lastActivePlatform === "discord") {
      await sendDiscordReply(lastActiveChannelId, infoMsg);
    } else if (lastActivePlatform === "whatsapp") {
      await sendWhatsAppReply(lastActiveChannelId, infoMsg);
    }

    isFreshNewSession = false;
    lastActivePlatform = null;
    lastActiveChannelId = null;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await stopDiscord(ctx);
    await stopWhatsApp(ctx);
    activeCtx = null;
    currentThreadId = null;
    threads.clear();
  });

  /* ----  Question Tool  ---- */
  pi.registerTool({
    name: "gateway_question",
    label: "Question Gateway",
    description:
      "Pose une question interactive à l'utilisateur via Discord ou WhatsApp avec des options prédéfinies. L'utilisateur peut choisir une option ou fournir une réponse personnalisée. Utilisez cet outil quand vous avez besoin d'une clarification ou d'un choix de l'utilisateur via la gateway.",
    parameters: Type.Object({
      question: Type.String({ description: "La question à poser à l'utilisateur" }),
      options: Type.Array(Type.String({ description: "Les options de réponse proposées" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Délai d'attente en secondes (défaut: 300)" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!currentThreadId) {
        return {
          content: [{ type: "text", text: "Erreur : aucun thread gateway actif. Connectez-vous via /gateway-boot start." }],
          details: { question: params.question, options: params.options, answer: null, wasCustom: false },
        };
      }

      const thread = threads.get(currentThreadId);
      if (!thread) {
        return {
          content: [{ type: "text", text: "Erreur : thread actif introuvable." }],
          details: { question: params.question, options: params.options, answer: null, wasCustom: false },
        };
      }

      const timeoutMs = (params.timeoutSeconds ?? 300) * 1000;
      const threadId = currentThreadId;

      const result = await new Promise<{
        answer: string | null;
        wasCustom: boolean;
        error?: string;
      }>((resolve) => {
        const timeout = setTimeout(() => {
          const pending = pendingQuestions.get(threadId);
          if (pending?.platform === "discord" && pending.messageId) {
            disableDiscordPollButtons(thread.channelId, pending.messageId);
          }
          pendingQuestions.delete(threadId);
          resolve({
            answer: null,
            wasCustom: false,
            error: "Timeout : l'utilisateur n'a pas répondu dans le délai imparti.",
          });
        }, timeoutMs);

        if (signal) {
          signal.addEventListener("abort", () => {
            const pending = pendingQuestions.get(threadId);
            if (pending?.platform === "discord" && pending.messageId) {
              disableDiscordPollButtons(thread.channelId, pending.messageId);
            }
            clearTimeout(timeout);
            pendingQuestions.delete(threadId);
            resolve({ answer: null, wasCustom: false, error: "Aborted" });
          }, { once: true });
        }

        pendingQuestions.set(threadId, {
          question: params.question,
          options: params.options,
          resolve: (val) => {
            const pending = pendingQuestions.get(threadId);
            if (pending?.platform === "discord" && pending.messageId) {
              disableDiscordPollButtons(thread.channelId, pending.messageId);
            }
            clearTimeout(timeout);
            pendingQuestions.delete(threadId);
            resolve({ answer: val.answer, wasCustom: val.wasCustom });
          },
          reject: (err) => {
            const pending = pendingQuestions.get(threadId);
            if (pending?.platform === "discord" && pending.messageId) {
              disableDiscordPollButtons(thread.channelId, pending.messageId);
            }
            clearTimeout(timeout);
            pendingQuestions.delete(threadId);
            resolve({ answer: null, wasCustom: false, error: err.message });
          },
          timeout,
          waitingForCustom: false,
          platform: thread.platform,
          messageId: undefined,
        });

        // Send interactive poll
        if (thread.platform === "discord") {
          sendDiscordPoll(thread.channelId, params.question, params.options).then((msgId) => {
            const pending = pendingQuestions.get(threadId);
            if (pending && msgId) pending.messageId = msgId;
          });
        } else {
          sendWhatsAppPoll(thread.channelId, params.question, params.options);
        }
      });

      if (result.error) {
        return {
          content: [{ type: "text", text: result.error }],
          details: {
            question: params.question,
            options: params.options,
            answer: result.answer,
            wasCustom: result.wasCustom,
            error: result.error,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: result.wasCustom
              ? `Réponse personnalisée : ${result.answer}`
              : `Réponse choisie : ${result.answer}`,
          },
        ],
        details: {
          question: params.question,
          options: params.options,
          answer: result.answer,
          wasCustom: result.wasCustom,
        },
      };
    },
  });

  /* ----  Commands  ---- */
  pi.registerCommand("gateway", {
    description: "Control the Discord/WhatsApp gateway",
    handler: async (args, ctx) => {
      const result = await runGatewayCommand(args, pi, ctx);
      if (result) {
        ctx.ui.notify(result.text, result.error ? "warning" : "info");
      }
    },
  });

  /* ----  Boot command  ---- */
  pi.registerCommand("gateway-boot", {
    description: "Configure systemd boot service for the gateway",
    handler: async (args, ctx) => {
      const result = await runGatewayBootCommand(args, pi, ctx);
      if (result) {
        ctx.ui.notify(result.text, result.error ? "warning" : "info");
      }
    },
  });
}

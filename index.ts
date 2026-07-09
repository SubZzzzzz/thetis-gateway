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
    mode?: "dm" | "mention" | "all" | "channels";
    allowedChannelIds?: string[];
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

  await whatsappSock.sendMessage(jid, {
    text: `🗳️ ${question}`,
    footer: "Sélectionnez une option ci-dessous",
    title: "Sondage",
    buttonText: "Voir les options",
    sections: [{ title: "Options disponibles", rows }],
  }).catch(() => null);
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

      const mode = config.discord!.mode ?? "mention";
      let shouldProcess = false;

      if (mode === "dm" && message.channel.isDMBased?.()) shouldProcess = true;
      else if (mode === "mention" && message.mentions?.has(client.user!.id)) shouldProcess = true;
      else if (mode === "all") shouldProcess = true;
      else if (config.discord!.allowedChannelIds?.includes(message.channel.id)) shouldProcess = true;

      if (!shouldProcess) return;

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
            { name: "start", type: 1, description: "Démarrer le gateway", options: [{ name: "target", type: 3, description: "discord ou whatsapp", required: false }] },
            { name: "stop", type: 1, description: "Arrêter le gateway", options: [{ name: "target", type: 3, description: "discord ou whatsapp", required: false }] },
            { name: "status", type: 1, description: "État des connexions" },
            { name: "threads", type: 1, description: "Lister les conversations actives" },
            { name: "clear", type: 1, description: "Vider l’historique d’un canal", options: [{ name: "id", type: 3, description: "ID du canal (laisser vide pour tout vider)", required: false }] },
            { name: "restart", type: 1, description: "Redémarrer le service gateway" },
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

      // Notify allowed channels that the gateway is back online.
      // Only channels (not DMs) to avoid duplicate messages for users
      // who are both in allowedUserIds and in an allowed channel.
      if (restartNotified) return;
      restartNotified = true;
      const restartMsg = `🔄 **Gateway redémarré**\nLe service Pi est en ligne et prêt.`;
      try {
        for (const channelId of config.discord?.allowedChannelIds ?? []) {
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (channel && typeof channel.send === "function") {
            await channel.send(restartMsg).catch(() => null);
          }
        }
      } catch {
        // Non-fatal: notification failure should not break startup
      }
    });

    // Handle slash commands and interactive buttons
    client.on("interactionCreate", async (interaction: any) => {
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

function isWhatsAppReady(): boolean {
  return whatsappSock && whatsappSock.ws?.readyState === 1;
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
    if (sent?.key?.id) lastMessageId = sent.key.id;
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
    const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } =
      await import("@whiskeysockets/baileys");
    const { default: qrcode } = await import("qrcode-terminal");

    const sessionName = config.whatsapp?.sessionName ?? "thetis-gateway";
    const authDir = path.join(EXT_DIR, `.baileys_auth_${sessionName}`);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ["ThetisGateway", "Chrome", "1.0"],
    });
    const currentSock = sock; // capture to detect stale events after manual stop

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update: any) => {
      if (whatsappSock !== currentSock) return; // stale socket, ignore

      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        ctx.ui.notify("WhatsApp QR printed to terminal — scan with your phone", "info");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.outputStatusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          ctx.ui.notify("WhatsApp logged out — not retrying.", "warning");
          runtimeState.whatsapp.fatalError = "Logged out";
          return;
        }

        runtimeState.whatsapp.reconnectAttempts++;
        if (runtimeState.whatsapp.reconnectAttempts > runtimeState.whatsapp.maxReconnectAttempts) {
          runtimeState.whatsapp.fatalError = `Connection failed after ${runtimeState.whatsapp.maxReconnectAttempts} attempts (${lastDisconnect?.error?.message || "unknown error"})`;
          ctx.ui.notify(`WhatsApp fatal error: ${runtimeState.whatsapp.fatalError}`, "error");
          return;
        }

        ctx.ui.notify(`WhatsApp closed (attempt ${runtimeState.whatsapp.reconnectAttempts}/${runtimeState.whatsapp.maxReconnectAttempts}) — will retry in 5s.`, "warning");
        setTimeout(() => startWhatsApp(pi, ctx), 5000);
      } else if (connection === "open") {
        runtimeState.whatsapp.reconnectAttempts = 0;
        ctx.ui.notify("WhatsApp connected", "success");
      }
    });

    sock.ev.on("messages.upsert", async (m: any) => {
      const msg = m.messages[0];
      if (!msg || !msg.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!isWhatsAppAuthorized(jid)) return;

      const threadId = getThreadId("whatsapp", jid);
      currentThreadId = threadId; // set EARLY so pi replies can be routed back

      // Handle interactive list selection (poll)
      const listResponse = msg.message.listResponseMessage;
      if (listResponse) {
        const selectedRowId = listResponse.singleSelectReply?.selectedRowId;
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
      try { await sock.sendMessage(jid, { react: { text: "👁", key: msg.key } }); } catch {}
      await startThinkingIndicator(thread);

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
  ctx?: ExtensionContext
): Promise<CommandResult | null> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();

  if (sub === "start") {
    const target = parts[1]?.toLowerCase();
    // Reset fatal errors on explicit manual start so user can retry after fixing config
    resetGatewayRuntimeState();
    if (ctx) {
      if (!target || target === "discord") await startDiscord(pi, ctx);
      if (!target || target === "whatsapp") await startWhatsApp(pi, ctx);
    }
    const d = isDiscordReady() ? "🟢" : (runtimeState.discord.fatalError ? "⛔" : "🔴");
    const w = isWhatsAppReady() ? "🟢" : (runtimeState.whatsapp.fatalError ? "⛔" : "🔴");
    return { text: `Starting gateways...\nDiscord: ${d} | WhatsApp: ${w}` };
  }

  if (sub === "stop") {
    const target = parts[1]?.toLowerCase();
    if (ctx) {
      if (!target || target === "discord") await stopDiscord(ctx);
      if (!target || target === "whatsapp") await stopWhatsApp(ctx);
    }
    return { text: "Gateways stopped." };
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
    const prevDiscordToken = config.discord?.token || process.env.DISCORD_BOT_TOKEN || "";
    const discordTokenRaw = await ctx.ui.input(
      "Discord bot token (leave empty to keep previous / skip Discord):",
      prevDiscordToken
    );
    const discordToken = discordTokenRaw.trim() || prevDiscordToken;

    const prevDiscordMode = config.discord?.mode ?? "mention";
    const discordModeRaw = await ctx.ui.input(
      `Discord mode (dm / mention / all / channels) [${prevDiscordMode}]:`,
      prevDiscordMode
    );
    const discordMode = discordModeRaw.trim() || prevDiscordMode;

    const prevDiscordUserIds = config.discord?.allowedUserIds?.join(", ") || "";
    const discordUserIdsRaw = await ctx.ui.input(
      "Authorized Discord user IDs (comma-separated, REQUIRED if Discord enabled):",
      prevDiscordUserIds
    );
    const discordUserIds = discordUserIdsRaw.trim() || prevDiscordUserIds;

    const prevDiscordChannels = config.discord?.allowedChannelIds?.join(", ") || "";
    const discordChannelsRaw = await ctx.ui.input(
      "Allowed Discord channel IDs (comma-separated, optional):",
      prevDiscordChannels
    );
    const discordChannels = discordChannelsRaw.trim() || prevDiscordChannels;

    const prevWhatsappEnabled = config.whatsapp?.enabled ?? true;
    const whatsappEnabled = await ctx.ui.confirm(
      "Enable WhatsApp gateway?",
      prevWhatsappEnabled
    );

    const prevWhatsappPhones = config.whatsapp?.allowedPhoneNumbers?.join(", ") || "";
    const whatsappPhonesRaw = await ctx.ui.input(
      "Authorized WhatsApp phone numbers (comma-separated, REQUIRED if WhatsApp enabled):",
      prevWhatsappPhones
    );
    const whatsappPhones = whatsappPhonesRaw.trim() || prevWhatsappPhones;

    const prevSessionName = config.whatsapp?.sessionName ?? "thetis-gateway";
    const sessionNameRaw = await ctx.ui.input(
      `WhatsApp session name [${prevSessionName}]:`,
      prevSessionName
    );
    const sessionName = sessionNameRaw.trim() || prevSessionName;

    const prevMaxHistory = String(config.maxHistoryPerThread ?? 100);
    const maxHistoryRaw = await ctx.ui.input(
      "Max messages per thread history [100]:",
      prevMaxHistory
    );
    const maxHistory = maxHistoryRaw.trim() || prevMaxHistory;

    const parsedDiscordIds = discordUserIds
      ? discordUserIds.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const parsedDiscordChannels = discordChannels
      ? discordChannels.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const parsedWhatsappPhones = whatsappPhones
      ? whatsappPhones.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    if (discordToken && parsedDiscordIds.length === 0) {
      return { text: "Discord is enabled but no authorized user IDs were provided. Setup aborted.", error: true };
    }
    if (whatsappEnabled && parsedWhatsappPhones.length === 0) {
      return { text: "WhatsApp is enabled but no authorized phone numbers were provided. Setup aborted.", error: true };
    }

    const newConfig: GatewayConfig = {
      autoStart: false,
      maxHistoryPerThread: parseInt(maxHistory, 10) || 100,
      discord: discordToken
        ? {
            enabled: true,
            token: discordToken,
            mode: ["dm", "mention", "all", "channels"].includes(discordMode)
              ? (discordMode as any)
              : "mention",
            allowedUserIds: parsedDiscordIds,
            allowedChannelIds: parsedDiscordChannels.length ? parsedDiscordChannels : undefined,
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
    return { text: "Gateway config saved. Use /gateway start to connect." };
  }

  // Unknown sub-command — return help
  return {
    text: `Usage: /gateway start|stop|restart|status|threads|clear|setup [options]`,
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
    // In TUI mode the user must start them manually with /gateway start.
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
          content: [{ type: "text", text: "Erreur : aucun thread gateway actif. Connectez-vous via /gateway start." }],
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

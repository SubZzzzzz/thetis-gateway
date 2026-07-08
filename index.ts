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
}

const threads = new Map<string, ChannelThread>();
let currentThreadId: string | null = null;
let activeCtx: ExtensionContext | null = null;
let lastToolCall: { name: string; args: any } | null = null;

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

async function sendDiscordReply(channelId: string, text: string, attachments?: OutgoingAttachment[]) {
  if (!isDiscordReady()) return;
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.send !== "function") return;

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
  const chunks = splitDiscordChunks(text, 2000);
  for (let i = 0; i < chunks.length; i++) {
    const opts: any = { content: chunks[i] };
    // Attach files only to last text chunk
    if (i === chunks.length - 1 && files.length) {
      opts.files = files;
    }
    await channel.send(opts).catch(() => null);
  }
}

async function startDiscord(pi: ExtensionAPI, ctx: ExtensionContext) {
  const token = config.discord?.token || process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    ctx.ui.notify("Discord token missing. Set DISCORD_BOT_TOKEN or run /gateway setup", "error");
    return;
  }

  try {
    const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = await import("discord.js");
    const client = new Client({
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

      // Strip bot mention
      let text: string = message.content ?? "";
      if (client.user) {
        text = text.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
      }

      // Intercept gateway slash commands
      if (text.startsWith("/gateway") || text.startsWith("/gateway-boot")) {
        currentThreadId = getThreadId("discord", message.channel.id);
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

      const thread = getOrCreateThread("discord", message.channel.id);

      // Show typing
      try { await message.channel.sendTyping(); } catch {}

      const fullText = (text || "(attachment)") + fileContentText;
      // Queue the message
      thread.pendingQueue.push({ text: fullText, images: attachments.length ? attachments : undefined });
      thread.messages.push({ role: "user", text: fullText.slice(0, 200), timestamp: Date.now(), hasImage: attachments.length > 0 });
      saveThreadHistory(getThreadId("discord", message.channel.id), thread.messages);

      // Activate this thread and process
      currentThreadId = getThreadId("discord", message.channel.id);
      await processThreadQueue(pi, thread);
    });

    await client.login(token);
    discordClient = client;
    ctx.ui.notify(`Discord connected as ${client.user?.tag ?? "bot"}`, "success");
  } catch (err: any) {
    ctx.ui.notify(`Discord start failed: ${err.message ?? err}`, "error");
  }
}

async function stopDiscord(ctx: ExtensionContext) {
  if (!discordClient) return;
  try { await discordClient.destroy(); ctx.ui.notify("Discord disconnected", "info"); } catch {}
  discordClient = null;
}

/* ------------------------------------------------------------------ */
/*  WhatsApp (Baileys)                                                 */
/* ------------------------------------------------------------------ */

let whatsappSock: any = null;

function isWhatsAppReady(): boolean {
  return whatsappSock && whatsappSock.ws?.readyState === 1;
}

async function sendWhatsAppReply(jid: string, text: string, attachments?: OutgoingAttachment[]) {
  if (!isWhatsAppReady()) return;

  if (attachments?.length) {
    for (const att of attachments) {
      try {
        if (att.contentType.startsWith("image/")) {
          await whatsappSock.sendMessage(jid, { image: att.data, caption: text });
          text = ""; // caption sent with first image only
        } else {
          await whatsappSock.sendMessage(jid, {
            document: att.data,
            mimetype: att.contentType || "application/octet-stream",
            fileName: att.name,
            caption: text,
          });
          text = "";
        }
      } catch (e) {
        console.error("WhatsApp attachment failed:", e);
      }
    }
  }

  if (text) {
    await whatsappSock.sendMessage(jid, { text }).catch(() => null);
  }
}

async function startWhatsApp(pi: ExtensionAPI, ctx: ExtensionContext) {
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

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        ctx.ui.notify("WhatsApp QR printed to terminal — scan with your phone", "info");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.outputStatusCode !== DisconnectReason.loggedOut;
        ctx.ui.notify(`WhatsApp closed (${shouldReconnect ? "will retry" : "logged out"}).`, "warning");
        if (shouldReconnect) setTimeout(() => startWhatsApp(pi, ctx), 5000);
      } else if (connection === "open") {
        ctx.ui.notify("WhatsApp connected", "success");
      }
    });

    sock.ev.on("messages.upsert", async (m: any) => {
      const msg = m.messages[0];
      if (!msg || !msg.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!isWhatsAppAuthorized(jid)) return;
      let text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      // Intercept gateway slash commands
      if (text.startsWith("/gateway") || text.startsWith("/gateway-boot")) {
        currentThreadId = getThreadId("whatsapp", jid);
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

      const thread = getOrCreateThread("whatsapp", jid);

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

      currentThreadId = getThreadId("whatsapp", jid);
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

async function routeToolCallPreview(toolName: string, args: any) {
  if (!currentThreadId) return;
  lastToolCall = { name: toolName, args };
  const thread = threads.get(currentThreadId);
  if (!thread) return;

  let preview = `🔧 **${toolName}**`;
  if (args.command) preview += `\n\`\`\`\n${args.command}\n\`\`\``;
  else if (args.path) preview += ` → \`${args.path}\``;
  else if (args.id) preview += ` → \`${args.id}\``;
  else preview += ` → ${JSON.stringify(args).slice(0, 200)}`;

  if (thread.platform === "discord") {
    await sendDiscordReply(thread.channelId, preview);
  } else if (thread.platform === "whatsapp") {
    await sendWhatsAppReply(thread.channelId, preview);
  }
}

async function routeToolResult(toolName: string, result: any, isError: boolean, toolArgs?: any) {
  if (!currentThreadId) return;
  const thread = threads.get(currentThreadId);
  if (!thread) return;

  const icon = isError ? "❌" : "✅";
  let summary = `${icon} **${toolName}** result:`;

  // Extract text from result
  let resultText = "";
  if (typeof result === "string") resultText = result;
  else if (result?.content) {
    resultText = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  } else if (result?.text) resultText = result.text;
  else resultText = JSON.stringify(result).slice(0, 500);

  // Truncate long results
  const maxLen = 1800;
  if (resultText.length > maxLen) {
    resultText = resultText.slice(0, maxLen) + "\n... [truncated]";
  }

  summary += "\n" + resultText;

  // Attach file if write/edit created one
  const attachments: OutgoingAttachment[] = [];
  if ((toolName === "write" || toolName === "edit") && toolArgs?.path) {
    try {
      const filePath = toolArgs.path;
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.size < 8 * 1024 * 1024) {
          const data = fs.readFileSync(filePath);
          const name = path.basename(filePath);
          const ext = path.extname(filePath).toLowerCase();
          let contentType = "application/octet-stream";
          const mimeMap: Record<string, string> = {
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
            ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
            ".js": "text/javascript", ".ts": "text/typescript", ".html": "text/html",
            ".css": "text/css", ".csv": "text/csv", ".zip": "application/zip",
          };
          if (mimeMap[ext]) contentType = mimeMap[ext];
          attachments.push({ name, data, contentType });
        }
      }
    } catch {
      // Failed to read file, skip attachment
    }
  }

  if (thread.platform === "discord") {
    await sendDiscordReply(thread.channelId, summary, attachments);
  } else if (thread.platform === "whatsapp") {
    await sendWhatsAppReply(thread.channelId, summary, attachments);
  }
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
    if (ctx) {
      if (!target || target === "discord") await startDiscord(pi, ctx);
      if (!target || target === "whatsapp") await startWhatsApp(pi, ctx);
    }
    const d = isDiscordReady() ? "🟢" : "🔴";
    const w = isWhatsAppReady() ? "🟢" : "🔴";
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

  if (sub === "status") {
    const d = isDiscordReady() ? "🟢 connected" : "🔴 offline";
    const w = isWhatsAppReady() ? "🟢 connected" : "🔴 offline";
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
      if (fs.existsSync(THREADS_DIR)) {
        for (const f of fs.readdirSync(THREADS_DIR)) {
          fs.unlinkSync(path.join(THREADS_DIR, f));
        }
      }
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
    const discordToken = await ctx.ui.input(
      "Discord bot token (leave empty to skip Discord):",
      config.discord?.token || process.env.DISCORD_BOT_TOKEN || ""
    );
    const discordMode = await ctx.ui.input(
      "Discord mode (dm / mention / all / channels):",
      config.discord?.mode ?? "mention"
    );
    const discordUserIds = await ctx.ui.input(
      "Authorized Discord user IDs (comma-separated, REQUIRED if Discord is enabled):",
      config.discord?.allowedUserIds?.join(", ") || ""
    );
    const whatsappEnabled = await ctx.ui.confirm(
      "Enable WhatsApp gateway?",
      config.whatsapp?.enabled ?? true
    );
    const whatsappPhones = await ctx.ui.input(
      "Authorized WhatsApp phone numbers (comma-separated, REQUIRED if WhatsApp is enabled):",
      config.whatsapp?.allowedPhoneNumbers?.join(", ") || ""
    );
    const maxHistory = await ctx.ui.input(
      "Max messages per thread history (default 100):",
      String(config.maxHistoryPerThread ?? 100)
    );

    const parsedDiscordIds = discordUserIds
      ? discordUserIds.split(",").map((s) => s.trim()).filter(Boolean)
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
      autoStart: true,
      maxHistoryPerThread: parseInt(maxHistory || "100", 10) || 100,
      discord: discordToken
        ? {
            enabled: true,
            token: discordToken,
            mode: ["dm", "mention", "all", "channels"].includes(discordMode ?? "")
              ? (discordMode as any)
              : "mention",
            allowedUserIds: parsedDiscordIds,
          }
        : { enabled: false },
      whatsapp: whatsappEnabled
        ? {
            enabled: true,
            sessionName: "thetis-gateway",
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
    text: `Usage: /gateway start|stop|status|threads|clear|setup [options]`,
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

    if (text.trim()) await routeAssistantReply(pi, text.trim(), attachments);
    else if (attachments.length) await routeAssistantReply(pi, "(image)", attachments);
  });

  /* ----  Tool execution preview — show what's happening  ---- */
  pi.on("tool_execution_start", async (event) => {
    if (!currentThreadId) return;
    await routeToolCallPreview(event.toolName, event.args);
  });

  /* ----  Tool result relay — send tool output to gateway  ---- */
  pi.on("tool_execution_end", async (event) => {
    if (!currentThreadId) return;
    await routeToolResult(event.toolName, event.result, event.isError, lastToolCall?.args);
    lastToolCall = null;
  });

  /* ----  Session lifecycle  ---- */
  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    threads.clear();
    currentThreadId = null;
    clearAllThreadHistories(); // reset gateway threads on every new Pi session

    if (config.autoStart) {
      if (config.discord?.enabled) await startDiscord(pi, ctx);
      if (config.whatsapp?.enabled) await startWhatsApp(pi, ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await stopDiscord(ctx);
    await stopWhatsApp(ctx);
    activeCtx = null;
    currentThreadId = null;
    threads.clear();
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

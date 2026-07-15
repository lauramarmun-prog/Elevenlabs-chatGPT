import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const APP_NAME = "ElevenLabs Audio for ChatGPT";
const APP_VERSION = "0.1.0";
const TEMPLATE_URI = "ui://widget/elevenlabs-audio-v1.html";
const ELEVENLABS_API_BASE = (process.env.ELEVENLABS_API_BASE ?? "https://api.elevenlabs.io").replace(/\/$/, "");
const ELEVENLABS_API_KEY = requiredEnv("ELEVENLABS_API_KEY");
const MCP_PATH_SECRET = validatePathSecret(requiredEnv("MCP_PATH_SECRET"));
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID?.trim() || undefined;
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2";
const PORT = boundedInteger(process.env.PORT, 3000, 1, 65_535);
const MAX_TEXT_LENGTH = boundedInteger(process.env.MAX_TEXT_LENGTH, 5_000, 1, 40_000);
const AUDIO_TTL_SECONDS = boundedInteger(process.env.AUDIO_TTL_SECONDS, 900, 60, 86_400);
const MAX_CACHED_AUDIO_BYTES = boundedInteger(
  process.env.MAX_CACHED_AUDIO_BYTES,
  50 * 1024 * 1024,
  1 * 1024 * 1024,
  500 * 1024 * 1024,
);
const MAX_SINGLE_AUDIO_BYTES = Math.min(MAX_CACHED_AUDIO_BYTES, 25 * 1024 * 1024);
const MAX_GENERATIONS_PER_MINUTE = boundedInteger(process.env.MAX_GENERATIONS_PER_MINUTE, 10, 1, 120);
const MAX_CONCURRENT_GENERATIONS = boundedInteger(process.env.MAX_CONCURRENT_GENERATIONS, 2, 1, 20);
const PERSISTENT_DATA_DIR =
  process.env.DATA_DIR?.trim() || process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || undefined;
const HAS_PERSISTENT_DATA_DIR = Boolean(PERSISTENT_DATA_DIR);
const DATA_DIR = resolve(PERSISTENT_DATA_DIR || "data");
const PREFERENCE_FILE = resolve(DATA_DIR, "voice-preference.json");

const widgetHtml = readFileSync(
  fileURLToPath(new URL("../public/audio-widget.html", import.meta.url)),
  "utf8",
);

type CachedAudio = {
  bytes: Buffer;
  contentType: string;
  fileName: string;
  expiresAt: number;
};

type VoicePreference = {
  voiceId: string;
  voiceName: string;
  updatedAt: string;
};

const audioCache = new Map<string, CachedAudio>();
let cachedAudioBytes = 0;
const recentGenerations: number[] = [];
let activeGenerations = 0;
let voicePreference: VoicePreference | null = null;
let voicePreferenceLoaded = false;

const outputFormatSchema = z.enum([
  "mp3_22050_32",
  "mp3_44100_64",
  "mp3_44100_96",
  "mp3_44100_128",
  "mp3_44100_192",
]);

const voiceSettingsSchema = z
  .object({
    stability: z.number().min(0).max(1).optional().describe("Voice stability from 0 to 1."),
    similarity_boost: z.number().min(0).max(1).optional().describe("Similarity boost from 0 to 1."),
    style: z.number().min(0).max(1).optional().describe("Style exaggeration from 0 to 1."),
    use_speaker_boost: z.boolean().optional().describe("Whether to boost similarity to the speaker."),
    speed: z.number().min(0.7).max(1.2).optional().describe("Speech speed from 0.7 to 1.2."),
  })
  .optional();

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function validatePathSecret(value: string): string {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(value)) {
    throw new Error("MCP_PATH_SECRET must contain 24-128 URL-safe characters (letters, numbers, _ or -). ");
  }
  return value;
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer between ${min} and ${max}, received ${raw ?? fallback}.`);
  }
  return parsed;
}

function requestOrigin(req: IncomingMessage): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return new URL(configured).origin;

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railwayDomain) return `https://${railwayDomain}`;

  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]?.trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? `localhost:${PORT}`)
    .split(",")[0]
    ?.trim();
  return new URL(`${forwardedProto}://${forwardedHost}`).origin;
}

function mcpPath(): string {
  return `/${MCP_PATH_SECRET}/mcp`;
}

function pruneAudioCache(now = Date.now()): void {
  for (const [id, entry] of audioCache) {
    if (entry.expiresAt <= now) {
      cachedAudioBytes -= entry.bytes.length;
      audioCache.delete(id);
    }
  }

  while (cachedAudioBytes > MAX_CACHED_AUDIO_BYTES && audioCache.size > 0) {
    const oldestId = audioCache.keys().next().value as string | undefined;
    if (!oldestId) break;
    const oldest = audioCache.get(oldestId);
    if (oldest) cachedAudioBytes -= oldest.bytes.length;
    audioCache.delete(oldestId);
  }
}

function cacheAudio(bytes: Buffer, contentType: string): { id: string; expiresAt: number; fileName: string } {
  pruneAudioCache();
  if (bytes.length > MAX_SINGLE_AUDIO_BYTES) {
    throw new Error(`Generated audio is too large (${bytes.length} bytes).`);
  }

  const id = randomUUID();
  const expiresAt = Date.now() + AUDIO_TTL_SECONDS * 1000;
  const fileName = `elevenlabs-${id}.mp3`;
  audioCache.set(id, { bytes, contentType, fileName, expiresAt });
  cachedAudioBytes += bytes.length;
  pruneAudioCache();
  return { id, expiresAt, fileName };
}

function signAudio(id: string, expiresAt: number): string {
  return createHmac("sha256", MCP_PATH_SECRET).update(`${id}.${expiresAt}`).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signedAudioUrl(origin: string, id: string, expiresAt: number): string {
  const signature = signAudio(id, expiresAt);
  return `${origin}/${MCP_PATH_SECRET}/audio/${id}?expires=${expiresAt}&signature=${signature}`;
}

async function withGenerationLimit<T>(operation: () => Promise<T>): Promise<T> {
  const now = Date.now();
  while (recentGenerations.length > 0 && (recentGenerations[0] ?? now) <= now - 60_000) {
    recentGenerations.shift();
  }
  if (recentGenerations.length >= MAX_GENERATIONS_PER_MINUTE) {
    throw new Error("The deployment's speech generation rate limit has been reached. Please try again in a minute.");
  }
  if (activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
    throw new Error("The deployment is already generating audio. Please try again in a moment.");
  }

  recentGenerations.push(now);
  activeGenerations += 1;
  try {
    return await operation();
  } finally {
    activeGenerations -= 1;
  }
}

async function getSavedVoicePreference(): Promise<VoicePreference | null> {
  if (voicePreferenceLoaded) return voicePreference;
  voicePreferenceLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(PREFERENCE_FILE, "utf8")) as Partial<VoicePreference>;
    if (typeof parsed.voiceId === "string" && typeof parsed.voiceName === "string") {
      voicePreference = {
        voiceId: parsed.voiceId,
        voiceName: parsed.voiceName,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Could not load the saved voice preference; continuing without it.");
    }
  }
  return voicePreference;
}

async function saveVoicePreference(preference: VoicePreference): Promise<"persistent" | "ephemeral" | "memory"> {
  voicePreference = preference;
  voicePreferenceLoaded = true;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const temporaryFile = `${PREFERENCE_FILE}.${randomUUID()}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(preference, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryFile, PREFERENCE_FILE);
    return HAS_PERSISTENT_DATA_DIR ? "persistent" : "ephemeral";
  } catch {
    console.warn("Could not write the voice preference to disk; keeping it in memory for this process.");
    return "memory";
  }
}

async function elevenLabsRequest(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${ELEVENLABS_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "xi-api-key": ELEVENLABS_API_KEY,
      ...init.headers,
    },
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = (await response.json()) as { detail?: unknown };
      detail = typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail ?? payload);
    } catch {
      // Keep the HTTP status text when ElevenLabs does not return JSON.
    }
    throw new Error(`ElevenLabs request failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response;
}

function createMcpServer(origin: string): McpServer {
  const server = new McpServer(
    { name: "elevenlabs-audio", version: APP_VERSION },
    {
      instructions:
        "When no voice is named, call get_preferred_voice. If none is configured, call list_voices, ask the user which voice they want, and call save_preferred_voice only after they choose. Use generate_speech only when the user explicitly wants audio. Generated audio is temporary.",
    },
  );

  registerAppResource(server, "elevenlabs-audio-widget", TEMPLATE_URI, {}, async () => ({
    contents: [
      {
        uri: TEMPLATE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml,
        _meta: {
          ui: {
            prefersBorder: true,
            domain: origin,
            csp: {
              connectDomains: [origin],
              resourceDomains: [origin],
            },
          },
          "openai/widgetDescription":
            "A compact audio player for speech generated with the deployer's ElevenLabs account.",
        },
      },
    ],
  }));

  registerAppTool(
    server,
    "list_voices",
    {
      title: "List ElevenLabs voices",
      description:
        "Use this when the user wants to discover or choose an ElevenLabs voice before generating speech.",
      inputSchema: {
        search: z.string().max(100).optional().describe("Optional name, description, label, or category search."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of voices to return."),
      },
      outputSchema: {
        voices: z.array(
          z.object({
            voice_id: z.string(),
            name: z.string(),
            category: z.string().nullable(),
            description: z.string().nullable(),
            labels: z.record(z.string(), z.string()),
          }),
        ),
        has_more: z.boolean(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Looking for voices…",
        "openai/toolInvocation/invoked": "Voices ready.",
      },
    },
    async ({ search, limit }) => {
      const params = new URLSearchParams({ page_size: String(limit), sort: "name", sort_direction: "asc" });
      if (search?.trim()) params.set("search", search.trim());
      const response = await elevenLabsRequest(`/v2/voices?${params}`, { method: "GET" });
      const payload = (await response.json()) as {
        voices?: Array<{
          voice_id?: string;
          name?: string;
          category?: string | null;
          description?: string | null;
          labels?: Record<string, string>;
        }>;
        has_more?: boolean;
      };
      const voices = (payload.voices ?? [])
        .filter((voice) => voice.voice_id && voice.name)
        .map((voice) => ({
          voice_id: voice.voice_id as string,
          name: voice.name as string,
          category: voice.category ?? null,
          description: voice.description ?? null,
          labels: voice.labels ?? {},
        }));
      return {
        structuredContent: { voices, has_more: Boolean(payload.has_more) },
        content: [{ type: "text", text: `Found ${voices.length} available voice${voices.length === 1 ? "" : "s"}.` }],
      };
    },
  );

  registerAppTool(
    server,
    "get_preferred_voice",
    {
      title: "Get preferred ElevenLabs voice",
      description:
        "Use this when the user asks which voice is preferred, or before generating speech when no voice was specified.",
      inputSchema: {},
      outputSchema: {
        configured: z.boolean(),
        voice_id: z.string().nullable(),
        voice_name: z.string().nullable(),
        source: z.enum(["saved", "environment", "none"]),
        storage: z.enum(["persistent", "ephemeral"]),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Checking the preferred voice…",
        "openai/toolInvocation/invoked": "Voice preference checked.",
      },
    },
    async () => {
      const saved = await getSavedVoicePreference();
      const result = saved
        ? {
            configured: true,
            voice_id: saved.voiceId,
            voice_name: saved.voiceName,
            source: "saved" as const,
            storage: HAS_PERSISTENT_DATA_DIR ? ("persistent" as const) : ("ephemeral" as const),
          }
        : DEFAULT_VOICE_ID
          ? {
              configured: true,
              voice_id: DEFAULT_VOICE_ID,
              voice_name: null,
              source: "environment" as const,
              storage: HAS_PERSISTENT_DATA_DIR ? ("persistent" as const) : ("ephemeral" as const),
            }
          : {
              configured: false,
              voice_id: null,
              voice_name: null,
              source: "none" as const,
              storage: HAS_PERSISTENT_DATA_DIR ? ("persistent" as const) : ("ephemeral" as const),
            };

      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: result.configured
              ? `The preferred ElevenLabs voice is ${result.voice_name ?? result.voice_id}.`
              : "No preferred ElevenLabs voice has been configured yet.",
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "save_preferred_voice",
    {
      title: "Save preferred ElevenLabs voice",
      description:
        "Use this after the user explicitly chooses an ElevenLabs voice and wants it used automatically for future speech generation.",
      inputSchema: {
        voice_id: z.string().min(1).describe("The ElevenLabs voice ID selected by the user."),
      },
      outputSchema: {
        saved: z.literal(true),
        voice_id: z.string(),
        voice_name: z.string(),
        storage: z.enum(["persistent", "ephemeral", "memory"]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Saving the preferred voice…",
        "openai/toolInvocation/invoked": "Preferred voice saved.",
      },
    },
    async ({ voice_id }) => {
      const selectedVoiceId = voice_id.trim();
      const response = await elevenLabsRequest(`/v1/voices/${encodeURIComponent(selectedVoiceId)}`, { method: "GET" });
      const voice = (await response.json()) as { voice_id?: string; name?: string };
      if (!voice.voice_id || !voice.name) throw new Error("ElevenLabs returned an incomplete voice record.");

      const preference: VoicePreference = {
        voiceId: voice.voice_id,
        voiceName: voice.name,
        updatedAt: new Date().toISOString(),
      };
      const storage = await saveVoicePreference(preference);
      return {
        structuredContent: {
          saved: true as const,
          voice_id: preference.voiceId,
          voice_name: preference.voiceName,
          storage,
        },
        content: [
          {
            type: "text",
            text: `${preference.voiceName} is now the preferred ElevenLabs voice for this deployment.`,
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "generate_speech",
    {
      title: "Generate speech with ElevenLabs",
      description:
        "Use this when the user explicitly asks to turn text into spoken audio with an ElevenLabs voice. This consumes the deployer's ElevenLabs credits.",
      inputSchema: {
        text: z.string().min(1).max(MAX_TEXT_LENGTH).describe("The exact text to speak."),
        voice_id: z
          .string()
          .min(1)
          .optional()
          .describe("ElevenLabs voice ID. Omit only when the deployment has a default voice."),
        model_id: z.string().min(1).optional().describe("ElevenLabs text-to-speech model ID."),
        language_code: z.string().length(2).optional().describe("Optional ISO 639-1 language code, such as en or es."),
        output_format: outputFormatSchema.default("mp3_44100_128").describe("MP3 quality and bitrate."),
        voice_settings: voiceSettingsSchema,
      },
      outputSchema: {
        status: z.literal("ready"),
        voice_id: z.string(),
        model_id: z.string(),
        output_format: z.string(),
        character_count: z.number().int(),
        expires_at: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: {
        ui: { resourceUri: TEMPLATE_URI },
        "openai/outputTemplate": TEMPLATE_URI,
        "openai/toolInvocation/invoking": "Giving the words a voice…",
        "openai/toolInvocation/invoked": "Your audio is ready.",
      },
    },
    async ({ text, voice_id, model_id, language_code, output_format, voice_settings }) => {
      const savedPreference = await getSavedVoicePreference();
      const selectedVoiceId = voice_id?.trim() || savedPreference?.voiceId || DEFAULT_VOICE_ID;
      if (!selectedVoiceId) {
        throw new Error("A voice_id is required because ELEVENLABS_VOICE_ID is not configured.");
      }
      const selectedModelId = model_id?.trim() || DEFAULT_MODEL_ID;
      const body: Record<string, unknown> = { text, model_id: selectedModelId };
      if (language_code) body.language_code = language_code;
      if (voice_settings && Object.keys(voice_settings).length > 0) body.voice_settings = voice_settings;

      const response = await withGenerationLimit(() =>
        elevenLabsRequest(
          `/v1/text-to-speech/${encodeURIComponent(selectedVoiceId)}?output_format=${encodeURIComponent(output_format)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify(body),
          },
        ),
      );

      const advertisedLength = Number(response.headers.get("content-length") ?? 0);
      if (advertisedLength > MAX_SINGLE_AUDIO_BYTES) throw new Error("Generated audio exceeds the configured size limit.");
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type")?.split(";")[0] || "audio/mpeg";
      const cached = cacheAudio(bytes, contentType);
      const expiresAtIso = new Date(cached.expiresAt).toISOString();
      const audioUrl = signedAudioUrl(origin, cached.id, cached.expiresAt);

      return {
        structuredContent: {
          status: "ready" as const,
          voice_id: selectedVoiceId,
          model_id: selectedModelId,
          output_format,
          character_count: text.length,
          expires_at: expiresAtIso,
        },
        content: [
          {
            type: "text",
            text: `The ElevenLabs audio is ready in the player and remains available until ${expiresAtIso}.`,
          },
        ],
        _meta: {
          audio: {
            url: audioUrl,
            mimeType: contentType,
            fileName: cached.fileName,
          },
        },
      };
    },
  );

  return server;
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, accept, authorization, mcp-protocol-version, mcp-session-id",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function serveAudio(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const prefix = `/${MCP_PATH_SECRET}/audio/`;
  if (!url.pathname.startsWith(prefix)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end("Method Not Allowed");
    return true;
  }

  const id = url.pathname.slice(prefix.length);
  const expiresAt = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  if (!id || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || !safeEqual(signature, signAudio(id, expiresAt))) {
    res.writeHead(403).end("Audio link is invalid or expired.");
    return true;
  }

  pruneAudioCache();
  const entry = audioCache.get(id);
  if (!entry || entry.expiresAt !== expiresAt) {
    res.writeHead(404).end("Audio is no longer available.");
    return true;
  }

  res.writeHead(200, {
    "Content-Type": entry.contentType,
    "Content-Length": entry.bytes.length,
    "Content-Disposition": `inline; filename="${entry.fileName}"`,
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else res.end(entry.bytes);
  return true;
}

const httpServer = createServer(async (req, res) => {
  try {
    const origin = requestOrigin(req);
    const url = new URL(req.url ?? "/", origin);

    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ status: "ok", service: "elevenlabs-audio-mcp", version: APP_VERSION }));
      return;
    }

    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`${APP_NAME} is running. The private MCP URL is available in your deployment instructions.`);
      return;
    }

    if (serveAudio(req, res, url)) return;

    if (url.pathname === mcpPath() && req.method === "OPTIONS") {
      setCors(res);
      res.writeHead(204).end();
      return;
    }

    if (url.pathname === mcpPath() && req.method && new Set(["POST", "GET", "DELETE"]).has(req.method)) {
      setCors(res);
      const server = createMcpServer(origin);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
  } catch (error) {
    console.error("Request failed:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    } else {
      res.end();
    }
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`${APP_NAME} listening on port ${PORT}`);
  console.log("Private MCP endpoint configured.");
});


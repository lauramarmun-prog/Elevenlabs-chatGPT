import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const pathSecret = "smoke_test_secret_1234567890abcdef";
const fakeAudio = Buffer.from("ID3-fake-mp3-audio");
const dataDir = await mkdtemp(join(tmpdir(), "elevenlabs-mcp-smoke-"));
let lastSpeechPath = "";
let lastSpeechBody = null;
let speechRequestCount = 0;

const missingVoiceEnv = {
  ...process.env,
  ELEVENLABS_API_KEY: "test-api-key",
  MCP_PATH_SECRET: pathSecret,
};
delete missingVoiceEnv.ELEVENLABS_VOICE_ID;
const missingVoiceChild = spawn(process.execPath, ["dist/server.js"], {
  env: missingVoiceEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
let missingVoiceOutput = "";
missingVoiceChild.stdout.on("data", (chunk) => (missingVoiceOutput += chunk));
missingVoiceChild.stderr.on("data", (chunk) => (missingVoiceOutput += chunk));
const missingVoiceExit = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    missingVoiceChild.kill();
    reject(new Error("Server did not reject a missing ELEVENLABS_VOICE_ID."));
  }, 5_000);
  missingVoiceChild.once("exit", (code) => {
    clearTimeout(timeout);
    resolve(code);
  });
});
assert.notEqual(missingVoiceExit, 0);
assert.match(missingVoiceOutput, /ELEVENLABS_VOICE_ID is required/);

const mockApi = createServer((req, res) => {
  if (req.headers["xi-api-key"] !== "test-api-key") {
    res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ detail: "bad key" }));
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/v2/voices")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        voices: [
          {
            voice_id: "voice-smoke",
            name: "Smoke Voice",
            category: "generated",
            description: "A test voice",
            labels: { language: "en" },
          },
        ],
        has_more: false,
      }),
    );
    return;
  }

  if (req.method === "GET" && req.url === "/v1/voices/new-voice") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ voice_id: "new-voice", name: "Saved Voice" }));
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/v1/text-to-speech/")) {
    speechRequestCount += 1;
    lastSpeechPath = req.url;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      lastSpeechBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": fakeAudio.length });
      res.end(fakeAudio);
    });
    return;
  }

  res.writeHead(404).end();
});

await new Promise((resolve) => mockApi.listen(0, "127.0.0.1", resolve));
const mockAddress = mockApi.address();
assert(mockAddress && typeof mockAddress === "object");

const appPort = 31_000 + Math.floor(Math.random() * 2_000);
const child = spawn(process.execPath, ["dist/server.js"], {
  env: {
    ...process.env,
    PORT: String(appPort),
    ELEVENLABS_API_KEY: "test-api-key",
    ELEVENLABS_API_BASE: `http://127.0.0.1:${mockAddress.port}`,
    MCP_PATH_SECRET: pathSecret,
    ELEVENLABS_VOICE_ID: "voice-smoke",
    DATA_DIR: dataDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let childOutput = "";
child.stdout.on("data", (chunk) => (childOutput += chunk));
child.stderr.on("data", (chunk) => (childOutput += chunk));

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/health`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy.\n${childOutput}`);
}

let requestId = 0;
async function mcpRequest(method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${appPort}/${pathSecret}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body);
}

async function flushBridgeTasks() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

try {
  await waitForHealth();

  const health = await fetch(`http://127.0.0.1:${appPort}/health`).then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.version, "0.2.6");

  const initialized = await mcpRequest("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "elevenlabs-audio");
  assert.match(
    initialized.result.instructions.slice(0, 512),
    /immediately call render_audio exactly once with the returned audio_id/,
  );
  assert.match(initialized.result.instructions, /natural conversational phrasing/);
  assert.match(initialized.result.instructions, /Never use SSML <break> tags with eleven_v3/);

  const tools = await mcpRequest("tools/list");
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name).sort(),
    ["generate_speech", "get_preferred_voice", "list_voices", "render_audio", "save_preferred_voice"],
  );
  const toolDefinitions = Object.fromEntries(tools.result.tools.map((tool) => [tool.name, tool]));
  assert.equal(toolDefinitions.generate_speech._meta.ui, undefined);
  assert.equal(toolDefinitions.generate_speech._meta["openai/outputTemplate"], undefined);
  assert.deepEqual(toolDefinitions.generate_speech.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(toolDefinitions.render_audio._meta.ui.resourceUri, "ui://widget/elevenlabs-audio-v6.html");
  assert.equal(
    toolDefinitions.render_audio._meta["openai/outputTemplate"],
    "ui://widget/elevenlabs-audio-v6.html",
  );
  assert.deepEqual(toolDefinitions.render_audio.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });

  const voices = await mcpRequest("tools/call", {
    name: "list_voices",
    arguments: { limit: 10 },
  });
  assert.equal(voices.result.structuredContent.voices[0].name, "Smoke Voice");

  const saved = await mcpRequest("tools/call", {
    name: "save_preferred_voice",
    arguments: { voice_id: "new-voice" },
  });
  assert.equal(saved.result.structuredContent.voice_name, "Saved Voice");
  assert.equal(saved.result.structuredContent.storage, "persistent");

  const preference = await mcpRequest("tools/call", {
    name: "get_preferred_voice",
    arguments: {},
  });
  assert.equal(preference.result.structuredContent.voice_id, "new-voice");
  assert.equal(preference.result.structuredContent.source, "saved");
  const preferenceFile = JSON.parse(await readFile(join(dataDir, "voice-preference.json"), "utf8"));
  assert.equal(preferenceFile.voiceId, "new-voice");

  const speech = await mcpRequest("tools/call", {
    name: "generate_speech",
    arguments: { text: "Hello from the smoke test.", output_format: "mp3_44100_128" },
  });
  assert.equal(speech.result.structuredContent.status, "ready");
  assert.match(speech.result.structuredContent.audio_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(speech.result.structuredContent.model_id, "eleven_v3");
  assert.equal(speech.result.structuredContent.audio.url, speech.result._meta.audio.url);
  assert.equal(speech.result.structuredContent.audio.mime_type, "audio/mpeg");
  assert.equal(speech.result.structuredContent.audio.size_bytes, fakeAudio.length);
  assert.match(lastSpeechPath, /\/v1\/text-to-speech\/new-voice/);
  assert.equal(lastSpeechBody.model_id, "eleven_v3");
  assert.match(speech.result._meta.audio.url, /\/audio\//);
  assert.doesNotMatch(speech.result._meta.audio.url, new RegExp(`/${pathSecret}/`));
  const audioResource = speech.result.content.find((item) => item.type === "resource_link");
  assert(audioResource, "generate_speech should expose a native resource_link fallback");
  assert.equal(audioResource.uri, speech.result._meta.audio.url);
  assert.equal(audioResource.mimeType, "audio/mpeg");
  assert.equal(audioResource.size, fakeAudio.length);
  assert.equal(speechRequestCount, 1);

  const rendered = await mcpRequest("tools/call", {
    name: "render_audio",
    arguments: { audio_id: speech.result.structuredContent.audio_id },
  });
  assert.equal(rendered.result.structuredContent.audio_id, speech.result.structuredContent.audio_id);
  assert.deepEqual(rendered.result.structuredContent.audio, speech.result.structuredContent.audio);
  assert.equal(rendered.result.structuredContent.expires_at, speech.result.structuredContent.expires_at);
  assert.deepEqual(rendered.result._meta.audio, speech.result._meta.audio);
  assert.equal(
    rendered.result.content.find((item) => item.type === "resource_link")?.uri,
    speech.result.structuredContent.audio.url,
  );
  assert.equal(speechRequestCount, 1, "render_audio must not make another ElevenLabs request");

  const renderedAgain = await mcpRequest("tools/call", {
    name: "render_audio",
    arguments: { audio_id: speech.result.structuredContent.audio_id },
  });
  assert.equal(renderedAgain.result.structuredContent.audio.url, rendered.result.structuredContent.audio.url);
  assert.equal(speechRequestCount, 1, "render_audio must remain idempotent");

  const missingAudio = await mcpRequest("tools/call", {
    name: "render_audio",
    arguments: { audio_id: "00000000-0000-4000-8000-000000000000" },
  });
  assert.equal(missingAudio.result.isError, true);
  assert.match(missingAudio.result.content[0].text, /Audio is no longer available/);

  const audioResponse = await fetch(speech.result._meta.audio.url);
  assert.equal(audioResponse.status, 200);
  assert.equal(audioResponse.headers.get("accept-ranges"), "bytes");
  assert.equal(audioResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(audioResponse.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), fakeAudio);

  const partialAudioResponse = await fetch(speech.result._meta.audio.url, {
    headers: { Range: "bytes=0-2" },
  });
  assert.equal(partialAudioResponse.status, 206);
  assert.equal(partialAudioResponse.headers.get("content-range"), `bytes 0-2/${fakeAudio.length}`);
  assert.deepEqual(Buffer.from(await partialAudioResponse.arrayBuffer()), fakeAudio.subarray(0, 3));

  const resources = await mcpRequest("resources/list");
  assert.equal(resources.result.resources[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resources.result.resources[0].uri, /elevenlabs-audio-v6\.html$/);
  const widget = await mcpRequest("resources/read", { uri: resources.result.resources[0].uri });
  assert.deepEqual(widget.result.contents[0]._meta.ui.csp.resourceDomains, [
    `http://127.0.0.1:${appPort}`,
  ]);
  assert.equal(widget.result.contents[0]._meta.ui.domain, undefined);
  assert.equal(widget.result.contents[0]._meta["openai/widgetDomain"], undefined);
  assert.equal(widget.result.contents[0]._meta["openai/widgetCSP"].connect_domains, undefined);
  assert.deepEqual(widget.result.contents[0]._meta["openai/widgetCSP"].redirect_domains, [
    `http://127.0.0.1:${appPort}`,
  ]);
  const widgetHtml = widget.result.contents[0].text;
  const widgetBytes = Buffer.byteLength(widgetHtml, "utf8");
  assert.doesNotMatch(widgetHtml, /__ELEVENLABS_WIDGET_BUNDLE__/);
  assert.doesNotMatch(widgetHtml, /app-with-deps|PostMessageTransport/);
  assert.match(widgetHtml, /ui\/initialize/);
  assert.match(widgetHtml, /2026-01-26/);
  assert.match(widgetHtml, /ui\/notifications\/initialized/);
  assert.match(widgetHtml, /ui\/notifications\/tool-result/);
  assert.match(widgetHtml, /ui\/notifications\/size-changed/);
  assert.match(widgetHtml, /ui\/open-link/);
  assert.match(widgetHtml, /openExternal/);
  assert.match(widgetHtml, /openai:set_globals/);
  assert.ok(widgetBytes < 20 * 1024, `Widget must stay under 20 KB; received ${widgetBytes} bytes.`);

  const moduleMatch = widgetHtml.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert(moduleMatch?.[1], "The built widget must include its manual bridge module.");
  const postedMessages = [];
  const listeners = new Map();
  let renderedToolResult;
  let intrinsicHeight;
  let fallbackHref;
  const parentWindow = {
    postMessage(message) {
      postedMessages.push(message);
    },
  };
  const fakeWindow = {
    parent: parentWindow,
    innerWidth: 320,
    openai: {
      notifyIntrinsicHeight(value) {
        intrinsicHeight = value;
      },
      async openExternal({ href }) {
        fallbackHref = href;
      },
    },
    __renderElevenLabsAudio(result) {
      renderedToolResult = result;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) {
      callback();
    },
  };
  const fakeDocument = {
    documentElement: {
      clientWidth: 320,
      scrollHeight: 180,
      style: { height: "" },
      getBoundingClientRect() {
        return { height: 180 };
      },
    },
    body: { scrollHeight: 180 },
  };
  class FakeResizeObserver {
    observe() {}
  }

  runInNewContext(moduleMatch[1], {
    window: fakeWindow,
    document: fakeDocument,
    ResizeObserver: FakeResizeObserver,
    console,
    Error,
    Map,
    Math,
    Promise,
  });
  await flushBridgeTasks();

  const initializeMessage = postedMessages.find((message) => message.method === "ui/initialize");
  assert(initializeMessage, "The widget bridge must start with ui/initialize.");
  assert.equal(initializeMessage.params.protocolVersion, "2026-01-26");
  assert.deepEqual(JSON.parse(JSON.stringify(initializeMessage.params.appInfo)), {
    name: "ElevenLabs Audio",
    version: "0.2.6",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(initializeMessage.params.appCapabilities)), {});

  const onBridgeMessage = listeners.get("message");
  assert(onBridgeMessage, "The widget bridge must listen for host messages.");
  onBridgeMessage({
    source: parentWindow,
    data: {
      jsonrpc: "2.0",
      id: initializeMessage.id,
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "smoke-host", version: "1.0.0" },
        hostCapabilities: { openLinks: {} },
        hostContext: {},
      },
    },
  });
  await flushBridgeTasks();

  assert(
    postedMessages.some((message) => message.method === "ui/notifications/initialized"),
    "The widget bridge must notify the host after initialization.",
  );
  assert(
    postedMessages.some((message) => message.method === "ui/notifications/size-changed"),
    "The widget bridge must report its intrinsic size.",
  );
  assert.equal(intrinsicHeight.height, 180);

  onBridgeMessage({
    source: parentWindow,
    data: {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: speech.result,
    },
  });
  assert.equal(renderedToolResult.structuredContent.audio.url, speech.result.structuredContent.audio.url);

  const openLinkPromise = fakeWindow.__elevenLabsOpenLink(speech.result.structuredContent.audio.url);
  const openLinkMessage = postedMessages.find((message) => message.method === "ui/open-link");
  assert(openLinkMessage, "The bridge must use the standard ui/open-link request when supported.");
  onBridgeMessage({
    source: parentWindow,
    data: { jsonrpc: "2.0", id: openLinkMessage.id, result: {} },
  });
  await openLinkPromise;

  const fallbackLinkPromise = fakeWindow.__elevenLabsOpenLink(speech.result.structuredContent.audio.url);
  const fallbackLinkMessage = postedMessages.filter((message) => message.method === "ui/open-link").at(-1);
  assert(fallbackLinkMessage, "The fallback test must receive an MCP open-link request first.");
  onBridgeMessage({
    source: parentWindow,
    data: {
      jsonrpc: "2.0",
      id: fallbackLinkMessage.id,
      error: { code: -32_000, message: "Host link policy rejected the request." },
    },
  });
  await fallbackLinkPromise;
  assert.equal(fallbackHref, speech.result.structuredContent.audio.url);

  const invalidPostedMessages = [];
  const invalidListeners = new Map();
  const invalidParentWindow = {
    postMessage(message) {
      invalidPostedMessages.push(message);
    },
  };
  const invalidWindow = {
    ...fakeWindow,
    parent: invalidParentWindow,
    openai: {},
    __renderElevenLabsAudio() {},
    addEventListener(type, listener) {
      invalidListeners.set(type, listener);
    },
  };
  runInNewContext(moduleMatch[1], {
    window: invalidWindow,
    document: fakeDocument,
    ResizeObserver: FakeResizeObserver,
    console: { error() {} },
    Error,
    Map,
    Math,
    Promise,
  });
  await flushBridgeTasks();
  const invalidInitializeMessage = invalidPostedMessages.find((message) => message.method === "ui/initialize");
  assert(invalidInitializeMessage, "The malformed-handshake test must receive ui/initialize.");
  invalidListeners.get("message")({
    source: invalidParentWindow,
    data: {
      jsonrpc: "2.0",
      id: invalidInitializeMessage.id,
      result: {
        protocolVersion: 20_260_126,
        hostInfo: { name: "invalid-host" },
        hostCapabilities: null,
        hostContext: null,
      },
    },
  });
  await flushBridgeTasks();
  assert.equal(
    invalidPostedMessages.some((message) => message.method === "ui/notifications/initialized"),
    false,
    "The bridge must reject a malformed initialize result before announcing initialized.",
  );

  console.log(
    `Smoke test passed: health, decoupled MCP tools, one-shot ElevenLabs generation, signed audio, ${widgetBytes}-byte manual bridge widget, and initialize-to-tool-result lifecycle.`,
  );
} finally {
  child.kill();
  await new Promise((resolve) => mockApi.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}

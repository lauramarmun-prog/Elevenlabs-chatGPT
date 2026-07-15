import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pathSecret = "smoke_test_secret_1234567890abcdef";
const fakeAudio = Buffer.from("ID3-fake-mp3-audio");
const dataDir = await mkdtemp(join(tmpdir(), "elevenlabs-mcp-smoke-"));
let lastSpeechPath = "";
let lastSpeechBody = null;

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

try {
  await waitForHealth();

  const health = await fetch(`http://127.0.0.1:${appPort}/health`).then((response) => response.json());
  assert.equal(health.status, "ok");

  const initialized = await mcpRequest("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "elevenlabs-audio");
  assert.match(initialized.result.instructions, /natural conversational phrasing/);
  assert.match(initialized.result.instructions, /Never use SSML <break> tags with eleven_v3/);

  const tools = await mcpRequest("tools/list");
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name).sort(),
    ["generate_speech", "get_preferred_voice", "list_voices", "save_preferred_voice"],
  );

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
  assert.equal(speech.result.structuredContent.model_id, "eleven_v3");
  assert.match(lastSpeechPath, /\/v1\/text-to-speech\/new-voice/);
  assert.equal(lastSpeechBody.model_id, "eleven_v3");
  assert.match(speech.result._meta.audio.url, /\/audio\//);

  const audioResponse = await fetch(speech.result._meta.audio.url);
  assert.equal(audioResponse.status, 200);
  assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), fakeAudio);

  const resources = await mcpRequest("resources/list");
  assert.equal(resources.result.resources[0].mimeType, "text/html;profile=mcp-app");

  console.log("Smoke test passed: health, MCP tools, saved voice preference, ElevenLabs mock, signed audio, and widget resource.");
} finally {
  child.kill();
  await new Promise((resolve) => mockApi.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}

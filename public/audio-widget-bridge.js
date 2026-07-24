const PROTOCOL_VERSION = "2026-01-26";
const APP_INFO = { name: "ElevenLabs Audio", version: "0.2.6" };
const pendingRequests = new Map();
let nextRequestId = 0;
let initialized = false;
let hostCapabilities = {};
let resizeScheduled = false;
let lastMcpSize = "";
let lastOpenAIHeight = 0;

function post(message) {
  window.parent.postMessage(message, "*");
}

function notify(method, params) {
  post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
}

function request(method, params) {
  const id = `elevenlabs-${++nextRequestId}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`${method} timed out.`));
    }, 10_000);
    pendingRequests.set(id, { resolve, reject, timeout });
    post({ jsonrpc: "2.0", id, method, params });
  });
}

function render(result) {
  window.__renderElevenLabsAudio?.(result);
}

function renderFromOpenAI() {
  render({
    structuredContent: window.openai?.toolOutput,
    toolResponseMetadata: window.openai?.toolResponseMetadata,
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInitializeResult(value) {
  return (
    isRecord(value) &&
    typeof value.protocolVersion === "string" &&
    isRecord(value.hostInfo) &&
    typeof value.hostInfo.name === "string" &&
    typeof value.hostInfo.version === "string" &&
    isRecord(value.hostCapabilities) &&
    isRecord(value.hostContext)
  );
}

function reportSize() {
  if (resizeScheduled) return;
  resizeScheduled = true;
  window.requestAnimationFrame(() => {
    resizeScheduled = false;
    const root = document.documentElement;
    const previousHeight = root.style.height;
    root.style.height = "max-content";
    const height = Math.ceil(root.getBoundingClientRect().height);
    root.style.height = previousHeight;
    const width = Math.ceil(window.innerWidth || root.clientWidth || 0);
    const size = `${width}x${height}`;
    if (height <= 0) return;
    if (initialized && size !== lastMcpSize) {
      lastMcpSize = size;
      notify("ui/notifications/size-changed", { width, height });
    }
    if (height !== lastOpenAIHeight) {
      lastOpenAIHeight = height;
      window.openai?.notifyIntrinsicHeight?.({ height });
    }
  });
}

function installOpenLink() {
  const supportsMcpOpenLink = Boolean(hostCapabilities?.openLinks);
  const supportsOpenAI = typeof window.openai?.openExternal === "function";
  if (!supportsMcpOpenLink && !supportsOpenAI) return;

  window.__elevenLabsOpenLink = async (url) => {
    if (supportsMcpOpenLink) {
      try {
        const result = await request("ui/open-link", { url });
        if (!result?.isError) return;
      } catch {
        // Continue to the ChatGPT compatibility fallback when available.
      }
    }
    if (typeof window.openai?.openExternal === "function") {
      await window.openai.openExternal({ href: url });
      return;
    }
    throw new Error("The host declined to open this audio link.");
  };
}

function handleMessage(event) {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;

  if (message.id !== undefined && pendingRequests.has(message.id)) {
    const pending = pendingRequests.get(message.id);
    pendingRequests.delete(message.id);
    window.clearTimeout(pending.timeout);
    if (message.error) pending.reject(message.error);
    else pending.resolve(message.result);
    return;
  }

  if (message.method === "ping" && message.id !== undefined) {
    post({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.method === "ui/notifications/tool-result") {
    render(message.params);
    reportSize();
  }
}

window.addEventListener("message", handleMessage, { passive: true });
window.addEventListener(
  "openai:set_globals",
  () => {
    renderFromOpenAI();
    installOpenLink();
    reportSize();
  },
  { passive: true },
);

if (typeof ResizeObserver === "function") {
  const observer = new ResizeObserver(reportSize);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
}

async function connect() {
  try {
    const result = await request("ui/initialize", {
      protocolVersion: PROTOCOL_VERSION,
      appInfo: APP_INFO,
      appCapabilities: {},
    });
    if (!isInitializeResult(result)) {
      throw new Error("The host returned an invalid ui/initialize result.");
    }
    hostCapabilities = result?.hostCapabilities ?? {};
    notify("ui/notifications/initialized");
    initialized = true;
  } catch (error) {
    console.error("Could not initialize the MCP Apps bridge; using compatibility fallbacks.", error);
  }

  installOpenLink();
  renderFromOpenAI();
  reportSize();
}

void connect();

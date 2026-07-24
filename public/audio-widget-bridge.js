import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-with-deps";

const app = new App(
  { name: "ElevenLabs Audio", version: "0.2.5" },
  {},
  { autoResize: true },
);

app.ontoolresult = (params) => window.__renderElevenLabsAudio?.(params);
app.onerror = (error) => console.error("ElevenLabs MCP Apps bridge:", error);

try {
  await app.connect(new PostMessageTransport(window.parent, window.parent));
  window.__renderElevenLabsAudio?.({
    structuredContent: window.openai?.toolOutput,
    toolResponseMetadata: window.openai?.toolResponseMetadata,
  });

  if (app.getHostCapabilities()?.openLinks) {
    window.__elevenLabsOpenLink = async (url) => {
      const result = await app.openLink({ url });
      if (result?.isError) throw new Error("The host declined to open this audio link.");
    };
  }
} catch (error) {
  console.error("Could not initialize the MCP Apps bridge; using compatibility fallbacks.", error);
}

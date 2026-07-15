# ElevenLabs Audio MCP for ChatGPT

A small, self-hosted MCP app that lets ChatGPT turn text into ElevenLabs speech and return a playable, downloadable MP3 inside the conversation.

Each person deploys their own private instance and supplies their own ElevenLabs API key. The key stays in Railway and is never sent to ChatGPT or the audio widget.

> This is an independent, community-built project. It is not affiliated with or endorsed by ElevenLabs or OpenAI.

## What it includes

- `generate_speech`: creates temporary MP3 audio with an ElevenLabs voice.
- `list_voices`: searches the voices available to the deployer's account.
- `get_preferred_voice`: checks whether the person has already chosen a default voice.
- `save_preferred_voice`: validates and saves a voice after the person chooses it in chat.
- A compact audio player rendered inside ChatGPT through the MCP Apps bridge.
- Short-lived, signed audio URLs.
- A secret, unguessable MCP path to protect the deployer's ElevenLabs credits.
- A Railway health check and configuration-as-code file.
- No analytics, database, user accounts, or permanent audio storage.

## Deploy on Railway

The public template should define these service variables:

| Variable | Required | Template value |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | Yes | Ask the person deploying the template |
| `MCP_PATH_SECRET` | Yes | Generate with `${{ secret(48) }}` |
| `ELEVENLABS_VOICE_ID` | No | Optional default voice ID |
| `ELEVENLABS_MODEL_ID` | No | `eleven_multilingual_v2` |
| `AUDIO_TTL_SECONDS` | No | `900` |
| `DATA_DIR` | No | Not needed on Railway; attached volumes are detected automatically |

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/elevenlabs-audio-mcp-for-chatgpt?utm_medium=integration&utm_source=template&utm_campaign=elevenlabs-chatgpt-mcp)

### Create the Railway template

1. Publish this repository on GitHub.
2. In Railway, create a project from the repository and enable public HTTP networking.
3. Add `ELEVENLABS_API_KEY` as a required template variable.
4. Add `MCP_PATH_SECRET` with the template function `${{ secret(48) }}`.
5. Recommended: attach a small volume at `/data`. Railway exposes its path automatically, so the person deploying the template does not need to configure it.
6. Generate a template from the project and publish it.
7. Copy Railway's template code into the Deploy button in this README.

Railway reads [`railway.json`](./railway.json), runs the TypeScript build, starts the server, and checks `/health` before completing the deployment.

## Connect it to ChatGPT

After deployment, construct the private MCP URL:

```text
https://YOUR-RAILWAY-DOMAIN/YOUR-MCP_PATH_SECRET/mcp
```

Then:

1. Enable Developer Mode in ChatGPT settings.
2. Create a new developer-mode app/connector.
3. Paste the private MCP URL above.
4. Add the app to a new conversation.
5. Try: “Help me choose an ElevenLabs voice and remember my choice.” The model can list the voices, ask which one you prefer, and save it after you answer.
6. Later, simply ask: “Read this aloud: Hello world.” The saved voice is used automatically.

Keep the full MCP URL private. Anyone who obtains it could consume the ElevenLabs credits attached to that deployment. Rotate `MCP_PATH_SECRET` immediately if the URL is exposed.

The saved preference belongs to the deployment, not to a ChatGPT account. This is ideal for the intended one-person-per-deployment model. If several people share one deployment, they will also share its preferred voice.

## Run locally

Requirements: Node.js 20 or newer and an ElevenLabs API key with Text to Speech and Voices read permissions.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Edit `.env` before starting. The local MCP URL will be:

```text
http://localhost:3000/YOUR-MCP_PATH_SECRET/mcp
```

ChatGPT requires a public HTTPS address, so use a tunnel for local testing and append the same secret path plus `/mcp`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | — | Required ElevenLabs API key. |
| `MCP_PATH_SECRET` | — | Required 24–128 character URL-safe secret. |
| `ELEVENLABS_VOICE_ID` | — | Default voice when a tool call omits `voice_id`. |
| `ELEVENLABS_MODEL_ID` | `eleven_multilingual_v2` | Default TTS model. |
| `MAX_TEXT_LENGTH` | `5000` | Maximum characters accepted per generation. |
| `AUDIO_TTL_SECONDS` | `900` | How long generated audio remains available. |
| `MAX_CACHED_AUDIO_BYTES` | `52428800` | Maximum total in-memory audio cache. |
| `MAX_GENERATIONS_PER_MINUTE` | `10` | Per-instance burst limit protecting ElevenLabs credits. |
| `MAX_CONCURRENT_GENERATIONS` | `2` | Maximum simultaneous TTS requests. |
| `DATA_DIR` | Railway volume or local `data/` | Optional preference storage override. Railway volumes are detected automatically through `RAILWAY_VOLUME_MOUNT_PATH`. |
| `PUBLIC_BASE_URL` | auto-detected | Optional canonical public origin. |
| `PORT` | `3000` | HTTP port; Railway supplies this automatically. |

## Privacy and storage

Text submitted to `generate_speech` is sent directly to ElevenLabs using the deployer's API key. Generated audio is held only in the running process memory and is removed after its expiry window or when the service restarts. The preferred voice record contains only its ElevenLabs ID, display name, and update time. This project does not include telemetry or a database.

Review ElevenLabs' own data handling and API terms before making a deployment available to other people.

## Development checks

```powershell
npm run check
npm test
```

The smoke test uses a local mock of the ElevenLabs API. It does not consume credits.

## Relevant documentation

- [OpenAI Apps SDK quickstart](https://developers.openai.com/apps-sdk/quickstart/)
- [Build an MCP server](https://developers.openai.com/apps-sdk/build/mcp-server/)
- [Build a ChatGPT UI](https://developers.openai.com/apps-sdk/build/chatgpt-ui/)
- [ElevenLabs create speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [ElevenLabs list voices API](https://elevenlabs.io/docs/api-reference/voices/search)
- [Railway templates](https://docs.railway.com/templates/create)

## License

MIT — see [`LICENSE`](./LICENSE).

---

## Español

Esta plantilla crea una instancia privada del conector para cada persona. Railway solicita su propia clave de ElevenLabs, genera un camino MCP secreto y entrega el audio mediante un reproductor integrado en ChatGPT. La voz no es una variable obligatoria: el modelo puede mostrar las voces, preguntar cuál prefiere la persona y guardar su elección mediante `save_preferred_voice`. No hay una cuenta central ni una base de datos compartida.


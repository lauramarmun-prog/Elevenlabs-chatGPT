# Security policy

## Secrets

- Never commit `ELEVENLABS_API_KEY`, `MCP_PATH_SECRET`, or a complete private MCP URL.
- Use a restricted ElevenLabs key with only the permissions this project needs.
- Set a usage or character limit on the ElevenLabs key when possible.
- Rotate both secrets if a deployment URL, log, screenshot, or configuration is exposed.

## Audio links

Generated audio links are signed and expire. They are bearer links: anyone who has a valid link before it expires can retrieve that audio.

## Saved preference

The voice preference is deployment-wide and contains only the ElevenLabs voice ID, display name, and update time. Do not use one instance for unrelated users who need separate preferences.

## Reporting a vulnerability

Please report vulnerabilities privately to the repository owner instead of opening a public issue containing exploit details or secrets.

# Multi viewer Youtube / Chat Twitch

Minimal static viewer for live streams with optional chat.

<img width="2255" height="1303" alt="image" src="https://github.com/user-attachments/assets/28147a2d-6235-4380-91f9-89b03e9baaff" />


## Features

- Twitch or YouTube live video embed.
- Twitch chat in two modes: official Twitch embed or custom IRC + 7TV emotes.
- Compact source selector (desktop and mobile).

## Run locally

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## Query parameters

- `youtube`: YouTube channel ID (`UC...`) or channel URL (`/channel/UC...`).
- `twitch`: Twitch channel name or Twitch URL.
- `video`: `twitch` or `youtube`.
- `chat`: `twitch-official`, `twitch-7tv` (or legacy `twitch`) or `none`.

## Notes

- Chat emotes are loaded from `https://emotes.crippled.dev` (global + channel 7TV sets).
- If no valid source is available, the viewer falls back to an empty frame.

## Example

```text
http://localhost:8080/?twitch=illojuan&video=twitch&chat=twitch-official
```

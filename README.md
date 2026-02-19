# Multi viewer YouTube / Twitch

Visor estático para directos de YouTube o Twitch, con chat opcional de Twitch.

## Uso rápido

1. Levanta un servidor local:

```bash
python3 -m http.server 8080
```

2. Abre:

```text
http://localhost:8080
```

3. Configura la URL con parámetros:

- `youtube`: Channel ID de YouTube (`UC...`) o URL tipo `/channel/UC...`.
- `twitch`: nombre de canal de Twitch o URL de Twitch.
- `video`: `youtube` o `twitch`.
- `chat`: `twitch-official`, `twitch-7tv` o `none`.

## Cómo sacar el `channelId` de YouTube

Este proyecto solo acepta `channelId` tipo `UC...` (no `@handle`).

Opciones:

1. Desde la URL del canal: entra al canal y usa la URL que contiene `/channel/UC...`.
2. Desde el código fuente de la página del canal: busca `"channelId"` y copia el valor `UC...`.

Ejemplo válido:

```text
http://localhost:8080/?youtube=UC_x5XG1OV2P6uZZ5FSM9Ttw&video=youtube&chat=none
```

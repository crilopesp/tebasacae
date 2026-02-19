(function () {
  function createTwitchChatClient({ messagesEl, statusEl, channelEl, pinnedEl }) {
    const MAX_LINES = 250;
    const emotes = new Map();
    const globalBadges = new Map();
    const channelBadges = new Map();
    const GLOBAL_BADGE_ENDPOINTS = [
      "https://badges.twitch.tv/v1/badges/global/display",
      "https://api.ivr.fi/v2/twitch/badges/global",
    ];
    const CHANNEL_BADGE_ENDPOINTS = (roomId) => [
      `https://badges.twitch.tv/v1/badges/channels/${encodeURIComponent(roomId)}/display`,
      `https://api.ivr.fi/v2/twitch/badges/channel?id=${encodeURIComponent(roomId)}`,
    ];

    let currentChannel = "";
    let currentRoomId = "";
    let socket = null;
    let reconnectTimer = null;
    let shouldReconnect = false;

    function start(channel) {
      const normalized = cleanChannel(channel).toLowerCase();
      if (!normalized) {
        stop();
        setStatus("sin canal");
        channelEl.textContent = "-";
        return;
      }

      shouldReconnect = true;

      if (normalized === currentChannel && socket && socket.readyState <= 1) {
        return;
      }

      currentChannel = normalized;
      currentRoomId = "";
      channelEl.textContent = `#${currentChannel}`;
      clearMessages();
      clearPinnedMessage();
      setStatus("cargando assets...");

      Promise.allSettled([loadEmotes(currentChannel), loadBadges()]).finally(connect);
    }

    function stop() {
      shouldReconnect = false;
      currentChannel = "";
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      disconnectSocket();
      clearPinnedMessage();
      setStatus("offline");
      channelEl.textContent = "-";
    }

    function connect() {
      if (!currentChannel) {
        return;
      }

      disconnectSocket();
      setStatus("conectando...");

      socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

      socket.addEventListener("open", () => {
        if (!socket) {
          return;
        }

        const nick = `justinfan${Math.floor(Math.random() * 90000 + 10000)}`;
        socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
        socket.send("PASS SCHMOOPIIE");
        socket.send(`NICK ${nick}`);
        socket.send(`JOIN #${currentChannel}`);
        setStatus("online");
      });

      socket.addEventListener("message", (event) => {
        const lines = String(event.data || "").split("\r\n");

        lines.forEach((line) => {
          if (!line) {
            return;
          }

          if (line.startsWith("PING")) {
            socket.send(line.replace("PING", "PONG"));
            return;
          }

          const parsed = parsePrivmsg(line);
          if (parsed) {
            if (parsed.isPinned) {
              setPinnedMessage(parsed);
            }
            appendMessage(parsed);
            return;
          }

          const pinned = parsePinnedEvent(line);
          if (pinned) {
            setPinnedMessage(pinned);
          }
        });
      });

      socket.addEventListener("close", () => {
        socket = null;

        if (!shouldReconnect || !currentChannel) {
          setStatus("offline");
          return;
        }

        setStatus("reconectando...");
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 2000);
      });

      socket.addEventListener("error", () => {
        setStatus("error");
      });
    }

    function disconnectSocket() {
      if (!socket) {
        return;
      }

      if (socket.readyState <= 1) {
        socket.close();
      }

      socket = null;
    }

    async function loadEmotes(channel) {
      emotes.clear();

      const [global, channelEmotes] = await Promise.allSettled([
        fetchSevenTvList("https://emotes.crippled.dev/v1/global/7tv"),
        fetchSevenTvList(`https://emotes.crippled.dev/v1/channel/${encodeURIComponent(channel)}/7tv`),
      ]);

      [global, channelEmotes].forEach((result) => {
        if (result.status !== "fulfilled") {
          return;
        }

        result.value.forEach((entry) => {
          if (entry.code && entry.url) {
            emotes.set(entry.code, entry.url);
          }
        });
      });

      setStatus(emotes.size ? `online · ${emotes.size} emotes` : "online");
    }

    async function loadBadges() {
      globalBadges.clear();
      channelBadges.clear();
      currentRoomId = "";

      try {
        const payload = await fetchJsonAny(GLOBAL_BADGE_ENDPOINTS);
        indexBadgePayload(payload, globalBadges);
      } catch {
        // Keep chat usable even if global badges fail.
      }
    }

    async function ensureChannelBadges(roomId) {
      const normalized = clean(roomId);
      if (!normalized || normalized === currentRoomId) {
        return;
      }

      try {
        const payload = await fetchJsonAny(CHANNEL_BADGE_ENDPOINTS(normalized));
        channelBadges.clear();
        indexBadgePayload(payload, channelBadges);
        currentRoomId = normalized;
      } catch {
        // Ignore channel badge failures and keep fallbacks.
      }
    }

    function indexBadgePayload(payload, target) {
      const normalizedSets = normalizeBadgeSets(payload);
      if (!normalizedSets.length) {
        return;
      }

      normalizedSets.forEach(({ setId, versions }) => {
        if (!setId || !versions.length) {
          return;
        }

        const byVersion = new Map();
        versions.forEach(({ id, badge }) => {
          const version = clean(id || "1");
          const url1x = clean(badge?.image_url_1x || "");
          const url2x = clean(badge?.image_url_2x || "");
          const url4x = clean(badge?.image_url_4x || "");
          const url = url2x || url1x || url4x;
          if (!url) {
            return;
          }

          const srcset = [url1x ? `${url1x} 1x` : "", url2x ? `${url2x} 2x` : "", url4x ? `${url4x} 4x` : ""]
            .filter(Boolean)
            .join(", ");

          byVersion.set(version || "1", {
            url,
            srcset,
            title: clean(badge?.title || setId),
          });
        });

        if (byVersion.size) {
          target.set(setId, byVersion);
        }
      });
    }

    function normalizeBadgeSets(payload) {
      const sets = [];

      if (payload?.badge_sets && typeof payload.badge_sets === "object") {
        Object.entries(payload.badge_sets).forEach(([setId, setValue]) => {
          const versions = normalizeVersions(setValue?.versions);
          sets.push({ setId, versions });
        });
        return sets;
      }

      const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
      list.forEach((item) => {
        const setId = clean(item?.set_id || item?.setId || item?.id || "");
        const versions = normalizeVersions(item?.versions || item?.version || []);
        if (setId) {
          sets.push({ setId, versions });
        }
      });

      return sets;
    }

    function normalizeVersions(rawVersions) {
      if (!rawVersions) {
        return [];
      }

      if (Array.isArray(rawVersions)) {
        return rawVersions
          .map((badge) => ({
            id: clean(badge?.id || badge?.version || badge?.set_version || "1"),
            badge,
          }))
          .filter((item) => item.badge);
      }

      if (typeof rawVersions === "object") {
        return Object.entries(rawVersions).map(([id, badge]) => ({ id, badge }));
      }

      return [];
    }

    async function fetchJsonAny(urls) {
      let lastError = null;
      for (const url of urls) {
        try {
          return await fetchJson(url);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("No badge endpoint available");
    }

    async function fetchJson(url) {
      const response = await fetch(url, { mode: "cors" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    }

    async function fetchSevenTvList(url) {
      try {
        const response = await fetch(url, { mode: "cors" });
        if (!response.ok) {
          return [];
        }

        const data = await response.json();
        if (!Array.isArray(data)) {
          return [];
        }

        return data
          .map((item) => {
            const code = clean(item?.code);
            const path = pickEmoteUrl(item?.urls);

            if (!code || !path) {
              return null;
            }

            return {
              code,
              url: path.startsWith("http") ? path : `https:${path}`,
            };
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    }

    function pickEmoteUrl(urls) {
      if (!Array.isArray(urls) || !urls.length) {
        return "";
      }

      const normalized = urls
        .map((entry) => {
          if (Array.isArray(entry)) {
            return { url: entry[0], size: entry[1] };
          }
          if (entry && typeof entry === "object") {
            return { url: entry.url, size: entry.size };
          }
          return null;
        })
        .filter(Boolean);

      if (!normalized.length) {
        return "";
      }

      const preferred =
        normalized.find((entry) => entry.size === "2x") ||
        normalized.find((entry) => entry.size === "1x") ||
        normalized[0];

      return clean(preferred?.url || "");
    }

    function parsePrivmsg(line) {
      const match = line.match(/^(?:@([^ ]+) )?:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.*)$/);
      if (!match) {
        return null;
      }

      const [, rawTags = "", fallbackName, text = ""] = match;
      const tags = parseTags(rawTags);

      return {
        name: tags["display-name"] || fallbackName || "user",
        color: tags.color || "#b3b3b3",
        text,
        badges: parseBadges(tags.badges),
        roomId: clean(tags["room-id"] || ""),
        isPinned: hasPinnedTags(tags) || isPinnedMsgId(tags["msg-id"]),
      };
    }

    function parsePinnedEvent(line) {
      const match = line.match(/^(?:@([^ ]+) )?:[^ ]+ (USERNOTICE|NOTICE) [^ ]+(?: :(.*))?$/);
      if (!match) {
        return null;
      }

      const [, rawTags = "", , rawText = ""] = match;
      const tags = parseTags(rawTags);
      const msgId = clean((tags["msg-id"] || "").toLowerCase());

      const noticeText = clean(rawText) || clean(tags["system-msg"] || "");
      const isPinned = isPinnedMsgId(msgId) || hasPinnedTags(tags) || looksPinnedText(noticeText);
      if (!isPinned) {
        return null;
      }

      const text = noticeText;
      if (!text) {
        return null;
      }

      return {
        name: tags["display-name"] || tags.login || "Twitch",
        color: tags.color || "#ffe4a2",
        text,
        badges: parseBadges(tags.badges),
        roomId: clean(tags["room-id"] || ""),
      };
    }

    function isPinnedMsgId(msgId) {
      return /(pin|pinned|hype-chat)/.test(clean(String(msgId || "").toLowerCase()));
    }

    function hasPinnedTags(tags) {
      return Object.keys(tags).some((key) => key.toLowerCase().includes("pinned"));
    }

    function looksPinnedText(text) {
      return /(pinned|pinneado|fijad[oa])/i.test(clean(String(text || "")));
    }

    function parseBadges(rawBadges) {
      if (!rawBadges) {
        return [];
      }

      return rawBadges
        .split(",")
        .map((entry) => {
          const [setId, version = "1"] = entry.split("/");
          if (!setId) {
            return null;
          }
          return { setId, version };
        })
        .filter(Boolean);
    }

    function parseTags(raw) {
      if (!raw) {
        return {};
      }

      return raw.split(";").reduce((acc, part) => {
        const separator = part.indexOf("=");
        const key = separator === -1 ? part : part.slice(0, separator);
        const value = separator === -1 ? "" : part.slice(separator + 1);
        if (key) {
          acc[key] = decodeTagValue(value);
        }
        return acc;
      }, {});
    }

    function decodeTagValue(value) {
      return String(value || "")
        .replace(/\\s/g, " ")
        .replace(/\\:/g, ";")
        .replace(/\\\\/g, "\\")
        .replace(/\\r/g, "\r")
        .replace(/\\n/g, "\n");
    }

    function appendMessage({ name, color, text, badges, roomId }) {
      const keepBottom = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 32;
      void ensureChannelBadges(roomId);

      const role = detectRole(badges);
      const line = document.createElement("div");
      line.className = "chat-line";
      if (role === "mod") {
        line.classList.add("is-moderator");
      } else if (role === "streamer") {
        line.classList.add("is-streamer");
      }

      if (role) {
        const roleTag = document.createElement("p");
        roleTag.className = `chat-role chat-role-${role}`;
        roleTag.textContent = role;
        line.append(roleTag);
      }

      const row = document.createElement("p");
      row.className = "chat-row";

      const time = document.createElement("span");
      time.className = "chat-time";
      time.textContent = nowHHMM();

      const user = document.createElement("span");
      user.className = "chat-name";
      user.style.color = color;
      user.textContent = `${name}:`;

      const badgesEl = renderBadges(badges);
      const body = document.createElement("span");
      body.className = "chat-body";
      appendRichContent(body, text);

      row.append(time);
      if (badgesEl.childElementCount) {
        row.append(badgesEl);
      }
      row.append(user, body);
      line.append(row);
      messagesEl.append(line);

      while (messagesEl.children.length > MAX_LINES) {
        messagesEl.removeChild(messagesEl.firstChild);
      }

      if (keepBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function setPinnedMessage({ name, color, text, badges, roomId }) {
      if (!pinnedEl) {
        return;
      }

      void ensureChannelBadges(roomId);
      pinnedEl.hidden = false;
      pinnedEl.textContent = "";

      const label = document.createElement("p");
      label.className = "chat-pin-label";
      label.textContent = "Mensaje fijado";

      const row = document.createElement("p");
      row.className = "chat-pin-row";

      const time = document.createElement("span");
      time.className = "chat-time";
      time.textContent = nowHHMM();

      const badgesEl = renderBadges(badges);

      const user = document.createElement("span");
      user.className = "chat-name";
      user.style.color = color;
      user.textContent = `${name}:`;

      const body = document.createElement("p");
      body.className = "chat-pin-body";
      appendRichContent(body, text);

      row.append(time);
      if (badgesEl.childElementCount) {
        row.append(badgesEl);
      }
      row.append(user);

      pinnedEl.append(label, row, body);
    }

    function clearPinnedMessage() {
      if (!pinnedEl) {
        return;
      }
      pinnedEl.hidden = true;
      pinnedEl.textContent = "";
    }

    function appendRichContent(container, text) {
      tokenize(text).forEach((token) => {
        if (token.type === "space") {
          container.append(token.value);
          return;
        }

        const emoteUrl = emotes.get(token.value);
        if (!emoteUrl) {
          const link = parseLinkToken(token.value);
          if (link) {
            container.append(renderLink(link));
          } else {
            container.append(token.value);
          }
          return;
        }

        const img = document.createElement("img");
        img.className = "chat-emote";
        img.src = emoteUrl;
        img.alt = token.value;
        img.loading = "lazy";
        container.append(img);
      });
    }

    function detectRole(badges) {
      const set = new Set((badges || []).map((item) => item.setId));
      if (set.has("broadcaster")) {
        return "streamer";
      }
      if (set.has("moderator")) {
        return "mod";
      }
      return "";
    }

    function renderBadges(badges) {
      const container = document.createElement("span");
      container.className = "chat-badges";

      badges.forEach(({ setId, version }) => {
        const badge = findBadge(setId, version);
        if (badge?.url) {
          const img = document.createElement("img");
          img.className = "chat-badge";
          img.src = badge.url;
          if (badge.srcset) {
            img.srcset = badge.srcset;
          }
          img.alt = badge.title || setId;
          img.title = badge.title || setId;
          img.loading = "lazy";
          container.append(img);
          return;
        }

        const fallback = renderBadgeFallback(setId);
        if (fallback) {
          container.append(fallback);
        }
      });

      return container;
    }

    function renderBadgeFallback(setId) {
      const icon = badgeFallbackIcon(setId);
      if (!icon) {
        return null;
      }

      const img = document.createElement("img");
      img.className = "chat-badge chat-badge-local";
      img.src = icon.src;
      img.alt = icon.title;
      img.title = icon.title;
      img.loading = "lazy";
      return img;
    }

    function badgeFallbackIcon(setId) {
      const map = {
        broadcaster: { src: "assets/badges/broadcaster.svg", title: "Streamer" },
        moderator: { src: "assets/badges/moderator.svg", title: "Moderator" },
        vip: { src: "assets/badges/vip.svg", title: "VIP" },
        subscriber: { src: "assets/badges/subscriber.svg", title: "Subscriber" },
        founder: { src: "assets/badges/founder.svg", title: "Founder" },
        artist: { src: "assets/badges/artist.svg", title: "Artist" },
        partner: { src: "assets/badges/partner.svg", title: "Partner" },
        staff: { src: "assets/badges/staff.svg", title: "Staff" },
        admin: { src: "assets/badges/admin.svg", title: "Admin" },
        turbo: { src: "assets/badges/turbo.svg", title: "Turbo" },
        premium: { src: "assets/badges/premium.svg", title: "Prime Gaming" },
      };

      return map[setId] || null;
    }

    function findBadge(setId, version) {
      return (
        pickBadge(channelBadges, setId, version) ||
        pickBadge(globalBadges, setId, version) ||
        null
      );
    }

    function pickBadge(index, setId, version) {
      const versions = index.get(setId);
      if (!versions) {
        return null;
      }
      return versions.get(version) || versions.values().next().value || null;
    }

    function tokenize(text) {
      return String(text || "")
        .split(/(\s+)/)
        .filter(Boolean)
        .map((part) => ({
          type: /^\s+$/.test(part) ? "space" : "word",
          value: part,
        }));
    }

    function parseLinkToken(token) {
      const value = String(token || "");
      if (!value) {
        return null;
      }

      const trailingMatch = value.match(/[),.!?:;]+$/);
      const trailing = trailingMatch ? trailingMatch[0] : "";
      const candidate = trailing ? value.slice(0, -trailing.length) : value;
      const href = normalizeLinkHref(candidate);
      if (!href) {
        return null;
      }

      return {
        href,
        label: candidate,
        trailing,
      };
    }

    function normalizeLinkHref(raw) {
      const trimmed = clean(raw);
      if (!trimmed) {
        return "";
      }

      if (/^https?:\/\//i.test(trimmed)) {
        return isSafeUrl(trimmed) ? trimmed : "";
      }

      if (/^www\./i.test(trimmed)) {
        const prefixed = `https://${trimmed}`;
        return isSafeUrl(prefixed) ? prefixed : "";
      }

      return "";
    }

    function isSafeUrl(url) {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }

    function renderLink({ href, label, trailing }) {
      const link = document.createElement("a");
      link.className = "chat-link";
      if (label.length > 28) {
        link.classList.add("chat-link-scroll");
      }
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer ugc";
      link.dataset.preview = href;

      const text = document.createElement("span");
      text.className = "chat-link-label";
      text.textContent = label;
      link.append(text);

      const fragment = document.createDocumentFragment();
      fragment.append(link);
      if (trailing) {
        fragment.append(trailing);
      }

      return fragment;
    }

    function clearMessages() {
      messagesEl.textContent = "";
    }

    function setStatus(label) {
      statusEl.textContent = label;
    }

    return { start, stop };
  }

  function cleanChannel(value) {
    return clean(value.replace(/^@/, "").split(/[?&#/]/)[0]);
  }

  function clean(value) {
    return value ? value.trim() : "";
  }

  function nowHHMM() {
    const date = new Date();
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }

  window.createTwitchChatClient = createTwitchChatClient;
})();

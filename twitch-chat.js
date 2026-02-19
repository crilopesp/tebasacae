(function () {
  function createTwitchChatClient({ messagesEl, statusEl, channelEl, pinnedEl }) {
    const MAX_RENDER_LINES = 400;
    const MAX_HISTORY_LINES = 2500;
    const RECENT_USER_MESSAGES_LIMIT = 8;
    const HISTORY_STORAGE_PREFIX = "tebasacae:chat-history:v1:";
    const SESSION_TOKEN_KEY = "tebasacae:chat-session-token:v1";
    const DB_ESTIMATE_KEY = "tebasacae:chat-db-estimate:v1";
    const MESSAGE_DB_NAME = "tebasacae-chat";
    const MESSAGE_DB_VERSION = 1;
    const MESSAGE_STORE = "messages";
    const MAX_DB_BYTES = 20 * 1024 * 1024;
    const emotes = new Map();
    const emotesInsensitive = new Map();
    const globalBadges = new Map();
    const channelBadges = new Map();
    const hoverUserCache = new Map();
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
    let userCardSequence = 0;
    let userCardLayer = 1200;
    const openUserCards = new Map();
    const openUserCardsByIdentity = new Map();
    let sessionHistory = [];
    let historyFlushTimer = null;
    let renderedLineCount = 0;
    const sessionToken = getSessionToken();
    let messageDbPromise = null;
    let dbEstimatedBytes = readDbEstimate();
    let emotesReadyPromise = Promise.resolve();
    const EMOTE_PREVIEW_SIZE = 134;
    const emotePreview = createEmotePreview();

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

      flushSessionHistory();
      currentChannel = normalized;
      currentRoomId = "";
      hoverUserCache.clear();
      channelEl.textContent = `#${currentChannel}`;
      clearMessages();
      restoreSessionHistory(currentChannel);
      clearPinnedMessage();
      closeAllUserCards();
      setStatus("cargando assets...");

      const emotesPromise = loadEmotes(currentChannel);
      emotesReadyPromise = emotesPromise.then(() => undefined, () => undefined);
      Promise.allSettled([emotesPromise, loadBadges()]).finally(connect);
    }

    function stop() {
      shouldReconnect = false;
      flushSessionHistory();
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      disconnectSocket();
      hoverUserCache.clear();
      clearPinnedMessage();
      closeAllUserCards();
      hideEmotePreview();
      setStatus("offline");
      channelEl.textContent = "-";
      currentChannel = "";
      sessionHistory = [];
      emotesReadyPromise = Promise.resolve();
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
            void indexMessageForLookup(parsed);
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
      emotesInsensitive.clear();

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
            const key = entry.code.toLowerCase();
            if (key && !emotesInsensitive.has(key)) {
              emotesInsensitive.set(key, { code: entry.code, url: entry.url });
            }
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
        login: clean((tags.login || fallbackName || "").toLowerCase()),
        userId: clean(tags["user-id"] || ""),
        color: tags.color || "#b3b3b3",
        text,
        badges: parseBadges(tags.badges),
        subscriber: tags.subscriber === "1",
        turbo: tags.turbo === "1",
        firstMsg: tags["first-msg"] === "1",
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

    function appendMessage({ name, login, userId, color, text, badges, roomId, subscriber, turbo, firstMsg }) {
      const keepBottom = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 32;
      void ensureChannelBadges(roomId);
      const timeLabel = nowHHMM();

      const line = renderMessageLine({
        name,
        login,
        userId,
        color,
        text,
        badges,
        subscriber,
        turbo,
        firstMsg,
        timeLabel,
      });
      if (!line) {
        return;
      }

      messagesEl.append(line);
      trimRenderedMessages();
      pushHistoryEntry({
        name,
        login,
        userId,
        color,
        text,
        badges,
        roomId,
        subscriber,
        turbo,
        firstMsg,
        timeLabel,
      });
      pushMessageToOpenUserCards({ login, userId, text, timeLabel });

      if (keepBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function renderMessageLine({ name, login, userId, color, text, badges, subscriber, turbo, firstMsg, timeLabel }) {
      const normalizedBadges = Array.isArray(badges) ? badges : [];
      const line = document.createElement("div");
      line.className = "chat-line";
      line.classList.add(renderedLineCount % 2 === 0 ? "chat-line-even" : "chat-line-odd");
      renderedLineCount += 1;

      const role = detectRole(normalizedBadges);
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
      time.textContent = timeLabel || nowHHMM();

      const user = document.createElement("span");
      user.className = "chat-name";
      user.style.color = color;
      user.textContent = `${name}:`;
      user.dataset.userName = clean(name);
      user.dataset.userLogin = clean(login);
      user.dataset.userId = clean(userId);
      user.dataset.userColor = color || "#b3b3b3";
      user.dataset.userBadges = serializeBadges(normalizedBadges);
      user.dataset.userSubscriber = subscriber ? "1" : "0";
      user.dataset.userTurbo = turbo ? "1" : "0";
      user.dataset.userFirstMsg = firstMsg ? "1" : "0";
      user.addEventListener("click", onUserClick);

      const badgesEl = renderBadges(normalizedBadges);
      const body = document.createElement("span");
      body.className = "chat-body";
      appendRichContent(body, text);

      row.append(time);
      if (badgesEl.childElementCount) {
        row.append(badgesEl);
      }
      row.append(user, body);
      line.append(row);
      return line;
    }

    function trimRenderedMessages() {
      while (messagesEl.children.length > MAX_RENDER_LINES) {
        messagesEl.removeChild(messagesEl.firstChild);
      }
    }

    function restoreSessionHistory(channel) {
      sessionHistory = loadSessionHistory(channel);
      if (!sessionHistory.length) {
        return;
      }

      const fragment = document.createDocumentFragment();
      sessionHistory.slice(-MAX_RENDER_LINES).forEach((entry) => {
        const line = renderMessageLine(entry);
        if (line) {
          fragment.append(line);
        }
      });
      messagesEl.append(fragment);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function pushHistoryEntry(entry) {
      sessionHistory.push({
        name: clean(entry.name || "user"),
        login: clean(entry.login || ""),
        userId: clean(entry.userId || ""),
        color: clean(entry.color || "#b3b3b3"),
        text: String(entry.text || ""),
        badges: normalizeStoredBadges(entry.badges),
        roomId: clean(entry.roomId || ""),
        subscriber: Boolean(entry.subscriber),
        turbo: Boolean(entry.turbo),
        firstMsg: Boolean(entry.firstMsg),
        timeLabel: clean(entry.timeLabel || nowHHMM()),
      });

      if (sessionHistory.length > MAX_HISTORY_LINES) {
        sessionHistory = sessionHistory.slice(-MAX_HISTORY_LINES);
      }

      scheduleHistoryFlush();
    }

    function normalizeStoredBadges(badges) {
      return (Array.isArray(badges) ? badges : [])
        .map((badge) => ({
          setId: clean(badge?.setId || ""),
          version: clean(badge?.version || "1"),
        }))
        .filter((badge) => badge.setId);
    }

    function loadSessionHistory(channel) {
      const key = historyStorageKey(channel);
      if (!key) {
        return [];
      }

      try {
        const raw = sessionStorage.getItem(key);
        if (!raw) {
          return [];
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          return [];
        }

        return parsed
          .map((entry) => ({
            name: clean(entry?.name || "user"),
            login: clean(entry?.login || ""),
            userId: clean(entry?.userId || ""),
            color: clean(entry?.color || "#b3b3b3"),
            text: String(entry?.text || ""),
            badges: normalizeStoredBadges(entry?.badges),
            roomId: clean(entry?.roomId || ""),
            subscriber: Boolean(entry?.subscriber),
            turbo: Boolean(entry?.turbo),
            firstMsg: Boolean(entry?.firstMsg),
            timeLabel: clean(entry?.timeLabel || ""),
          }))
          .slice(-MAX_HISTORY_LINES);
      } catch {
        return [];
      }
    }

    function scheduleHistoryFlush() {
      if (historyFlushTimer) {
        return;
      }
      historyFlushTimer = setTimeout(flushSessionHistory, 300);
    }

    function flushSessionHistory() {
      if (historyFlushTimer) {
        clearTimeout(historyFlushTimer);
        historyFlushTimer = null;
      }

      const key = historyStorageKey(currentChannel);
      if (!key) {
        return;
      }

      try {
        sessionStorage.setItem(key, JSON.stringify(sessionHistory.slice(-MAX_HISTORY_LINES)));
      } catch {
        // Ignore storage quota and private-mode failures.
      }
    }

    function historyStorageKey(channel) {
      const normalized = clean((channel || "").toLowerCase());
      return normalized ? `${HISTORY_STORAGE_PREFIX}${normalized}` : "";
    }

    function readDbEstimate() {
      try {
        const raw = sessionStorage.getItem(DB_ESTIMATE_KEY);
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      } catch {
        return 0;
      }
    }

    function writeDbEstimate() {
      try {
        sessionStorage.setItem(DB_ESTIMATE_KEY, String(dbEstimatedBytes));
      } catch {
        // Ignore private-mode/sessionStorage failures.
      }
    }

    function getSessionToken() {
      try {
        const existing = clean(sessionStorage.getItem(SESSION_TOKEN_KEY) || "");
        if (existing) {
          return existing;
        }

        const generated = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem(SESSION_TOKEN_KEY, generated);
        return generated;
      } catch {
        return `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
    }

    async function indexMessageForLookup(entry) {
      if (!currentChannel) {
        return;
      }

      const login = clean((entry?.login || "").toLowerCase());
      const userId = clean(entry?.userId || "");
      const text = clean(entry?.text || "");
      if ((!login && !userId) || !text) {
        return;
      }

      const record = {
        sessionToken,
        channel: currentChannel,
        login,
        userId,
        name: clean(entry?.name || login || "user"),
        text,
        timeLabel: nowHHMM(),
        timestamp: Date.now(),
      };

      try {
        const db = await ensureMessageDb();
        await runIdbRequest(addMessageRecord(db, record));
        dbEstimatedBytes += estimateBytes(record);
        writeDbEstimate();

        if (dbEstimatedBytes > MAX_DB_BYTES) {
          await clearMessageStore(db);
          await runIdbRequest(addMessageRecord(db, record));
          dbEstimatedBytes = estimateBytes(record);
          writeDbEstimate();
        }
      } catch {
        // Ignore IndexedDB failures and keep chat flow.
      }
    }

    async function fetchRecentMessages(profile, limit) {
      const login = clean((profile?.login || "").toLowerCase());
      const userId = clean(profile?.userId || "");
      if (!currentChannel || (!login && !userId)) {
        return [];
      }

      try {
        const db = await ensureMessageDb();
        const index = db
          .transaction(MESSAGE_STORE, "readonly")
          .objectStore(MESSAGE_STORE)
          .index(userId ? "bySessionChannelUserId" : "bySessionChannelLogin");
        const key = userId
          ? [sessionToken, currentChannel, userId]
          : [sessionToken, currentChannel, login];
        const cursor = index.openCursor(IDBKeyRange.only(key), "prev");
        const rows = [];

        await collectFromCursor(cursor, limit, (value) => {
          rows.push({
            text: clean(value?.text || ""),
            timeLabel: clean(value?.timeLabel || ""),
          });
        });

        return rows
          .filter((row) => row.text)
          .reverse();
      } catch {
        return [];
      }
    }

    function ensureMessageDb() {
      if (messageDbPromise) {
        return messageDbPromise;
      }

      messageDbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new Error("IndexedDB unavailable"));
          return;
        }

        const request = indexedDB.open(MESSAGE_DB_NAME, MESSAGE_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (db.objectStoreNames.contains(MESSAGE_STORE)) {
            db.deleteObjectStore(MESSAGE_STORE);
          }
          const store = db.createObjectStore(MESSAGE_STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("bySessionChannelLogin", ["sessionToken", "channel", "login"], { unique: false });
          store.createIndex("bySessionChannelUserId", ["sessionToken", "channel", "userId"], { unique: false });
        };
        request.onsuccess = async () => {
          const db = request.result;
          try {
            await deleteOtherSessions(db);
            resolve(db);
          } catch (error) {
            reject(error);
          }
        };
        request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
      });

      return messageDbPromise;
    }

    async function deleteOtherSessions(db) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(MESSAGE_STORE, "readwrite");
        const cursor = tx.objectStore(MESSAGE_STORE).openCursor();

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("Transaction error"));
        tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));

        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) {
            return;
          }

          if (clean(row.value?.sessionToken || "") !== sessionToken) {
            row.delete();
          }
          row.continue();
        };
        cursor.onerror = () => reject(cursor.error || new Error("Cursor error"));
      });
    }

    function addMessageRecord(db, record) {
      return db.transaction(MESSAGE_STORE, "readwrite").objectStore(MESSAGE_STORE).add(record);
    }

    async function clearMessageStore(db) {
      await runIdbRequest(db.transaction(MESSAGE_STORE, "readwrite").objectStore(MESSAGE_STORE).clear());
    }

    function estimateBytes(value) {
      try {
        return JSON.stringify(value).length * 2;
      } catch {
        return 512;
      }
    }

    function collectFromCursor(request, limit, onValue) {
      return new Promise((resolve, reject) => {
        let count = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || count >= limit) {
            resolve();
            return;
          }
          onValue(cursor.value, cursor);
          count += 1;
          if (count >= limit) {
            resolve();
            return;
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error("Cursor error"));
      });
    }

    function runIdbRequest(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
      });
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

    async function onUserClick(event) {
      const target = event.currentTarget;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const profile = readProfileFromNode(target);
      if (!profile) {
        return;
      }

      const card = createUserCard(profile);
      renderUserCard(card, { ...profile, recentMessages: [] }, true);

      const token = ++card.requestToken;
      const recentMessages = await fetchRecentMessages(profile, RECENT_USER_MESSAGES_LIMIT);
      if (!openUserCards.has(card.id) || token !== card.requestToken) {
        return;
      }
      await emotesReadyPromise;
      if (!openUserCards.has(card.id) || token !== card.requestToken) {
        return;
      }
      renderUserCard(card, { ...profile, recentMessages }, true);

      const remoteProfile = await fetchUserDetails(profile);
      if (!openUserCards.has(card.id) || token !== card.requestToken) {
        return;
      }
      if (!remoteProfile) {
        renderUserCard(card, { ...profile }, false);
        return;
      }

      renderUserCard(card, { ...profile, ...remoteProfile }, false);
    }

    function createUserCard(profile) {
      const id = `card-${Date.now()}-${++userCardSequence}`;
      const cardEl = document.createElement("aside");
      cardEl.className = "chat-user-card";
      const card = {
        id,
        el: cardEl,
        requestToken: 0,
        profile: { ...profile },
        recentMessages: [],
        identities: new Set(),
      };

      focusUserCard(cardEl);
      cardEl.addEventListener("pointerdown", () => focusUserCard(cardEl));
      setUserCardIdentities(card, profile);
      positionUserCard(cardEl, openUserCards.size);
      openUserCards.set(id, card);
      document.body.append(cardEl);
      return card;
    }

    function renderUserCard(card, profile, loading) {
      if (!card || !openUserCards.has(card.id)) {
        return;
      }

      card.profile = { ...card.profile, ...profile };
      if (Array.isArray(profile.recentMessages)) {
        card.recentMessages = normalizeRecentMessages(profile.recentMessages);
      }
      setUserCardIdentities(card, card.profile);

      const cardEl = card.el;
      const data = card.profile;

      cardEl.textContent = "";

      const grip = document.createElement("div");
      grip.className = "chat-user-card-grip";
      bindUserCardDragging(card, grip);

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "chat-user-card-close chat-user-card-close-floating";
      closeButton.setAttribute("aria-label", "Cerrar dialogo");
      closeButton.textContent = "X";
      closeButton.addEventListener("click", () => closeUserCard(card.id));

      const layout = document.createElement("div");
      layout.className = "chat-user-card-layout";

      const media = document.createElement("div");
      media.className = "chat-user-card-media";

      if (data.avatarUrl) {
        const avatar = document.createElement("img");
        avatar.className = "chat-user-card-avatar";
        avatar.src = data.avatarUrl;
        avatar.alt = data.name || "Avatar";
        avatar.loading = "lazy";
        media.append(avatar);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "chat-user-card-avatar chat-user-card-avatar-placeholder";
        placeholder.textContent = "?";
        media.append(placeholder);
      }

      const info = document.createElement("div");
      info.className = "chat-user-card-info";

      const title = document.createElement("p");
      title.className = "chat-user-card-title";
      title.textContent = data.name || "Usuario";
      title.style.color = data.color || "#efeff1";
      info.append(title);

      if (data.login) {
        const handle = document.createElement("p");
        handle.className = "chat-user-card-handle";
        handle.textContent = `@${data.login}`;
        info.append(handle);
      }

      const docId = document.createElement("p");
      docId.className = "chat-user-card-docid";
      docId.textContent = formatUserDocumentId(data);
      info.append(docId);

      const lines = [];
      const traits = [];
      if (data.role === "streamer") {
        traits.push("Streamer");
      } else if (data.role === "mod") {
        traits.push("Moderador");
      }
      if (data.subscriber) {
        traits.push("Suscriptor");
      }
      if (data.turbo) {
        traits.push("Turbo");
      }
      if (data.firstMsg) {
        traits.push("Primer mensaje");
      }

      if (traits.length) {
        const traitsRow = document.createElement("div");
        traitsRow.className = "chat-user-card-chips";
        traits.forEach((trait) => {
          const chip = document.createElement("span");
          chip.className = "chat-user-card-chip";
          chip.textContent = trait;
          traitsRow.append(chip);
        });
        info.append(traitsRow);
      }

      if (data.createdAt) {
        lines.push({ label: "Cuenta creada", value: formatDate(data.createdAt) });
      }
      if (data.type) {
        lines.push({ label: "Tipo", value: data.type });
      }
      if (data.subSince) {
        lines.push({ label: "Sub desde", value: formatDate(data.subSince) });
      }
      if (typeof data.subMonths === "number" && Number.isFinite(data.subMonths) && data.subMonths >= 0) {
        lines.push({ label: "Meses sub", value: String(data.subMonths) });
      }
      if (typeof data.subTier === "string" && data.subTier) {
        lines.push({ label: "Tier", value: data.subTier });
      }

      if (data.badges.length) {
        const badgesEl = renderBadges(data.badges);
        if (badgesEl.childElementCount) {
          const badgesRow = document.createElement("div");
          badgesRow.className = "chat-user-card-row";
          const label = document.createElement("span");
          label.className = "chat-user-card-label";
          label.textContent = "Badges";
          const value = document.createElement("div");
          value.className = "chat-user-card-badges";
          value.append(badgesEl);
          badgesRow.append(label, value);
          info.append(badgesRow);
        }
      }

      lines.forEach((line) => {
        const row = document.createElement("div");
        row.className = "chat-user-card-row";
        const label = document.createElement("span");
        label.className = "chat-user-card-label";
        label.textContent = line.label;
        const value = document.createElement("span");
        value.className = "chat-user-card-value";
        value.textContent = line.value;
        row.append(label, value);
        info.append(row);
      });

      if (data.description) {
        const about = document.createElement("p");
        about.className = "chat-user-card-about";
        about.textContent = data.description;
        info.append(about);
      }

      if (loading) {
        const loadingLabel = document.createElement("p");
        loadingLabel.className = "chat-user-card-about chat-user-card-muted";
        loadingLabel.textContent = "Cargando info de Twitch...";
        info.append(loadingLabel);
      }

      if (data.login) {
        const link = document.createElement("a");
        link.className = "chat-user-card-link";
        link.href = `https://www.twitch.tv/${encodeURIComponent(data.login)}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Abrir perfil en Twitch";
        info.append(link);
      }

      layout.append(media, info);
      cardEl.append(grip, closeButton, layout, renderRecentMessagesBlock(card));
    }

    function normalizeRecentMessages(rows) {
      return (Array.isArray(rows) ? rows : [])
        .map((entry) => ({
          text: clean(entry?.text || ""),
          timeLabel: clean(entry?.timeLabel || ""),
        }))
        .filter((entry) => entry.text);
    }

    function renderRecentMessagesBlock(card) {
      const recentWrap = document.createElement("section");
      recentWrap.className = "chat-user-card-recent chat-user-card-chat-tail";

      const recentHeader = document.createElement("div");
      recentHeader.className = "chat-user-card-recent-header chat-header";

      const recentLabel = document.createElement("p");
      recentLabel.className = "chat-title";
      recentLabel.textContent = "Ultimos mensajes";

      const recentCount = document.createElement("p");
      recentCount.className = "chat-meta chat-user-card-recent-count";
      recentCount.textContent = String(card.recentMessages.length);
      recentHeader.append(recentLabel, recentCount);

      const recentList = document.createElement("div");
      recentList.className = "chat-user-card-recent-list chat-messages chat-user-card-chat-tail-messages";
      recentList.dataset.cardId = card.id;
      card.recentMessages.forEach((entry) => {
        recentList.append(renderRecentMessageLine(entry, card.profile.name || "Usuario"));
      });

      if (!card.recentMessages.length) {
        const empty = document.createElement("p");
        empty.className = "chat-user-card-recent-empty chat-line";
        empty.textContent = "Sin mensajes recientes en esta sesion";
        recentList.append(empty);
      } else {
        recentList.scrollTop = recentList.scrollHeight;
      }

      recentWrap.append(recentHeader, recentList);
      return recentWrap;
    }

    function renderRecentMessageLine(entry, displayName) {
      const line = document.createElement("p");
      line.className = "chat-user-card-recent-line chat-line";

      const row = document.createElement("span");
      row.className = "chat-row";

      const time = document.createElement("span");
      time.className = "chat-time";
      time.textContent = entry.timeLabel || "--:--";
      row.append(time);

      const user = document.createElement("span");
      user.className = "chat-name";
      user.textContent = `${displayName}:`;
      row.append(user);

      const body = document.createElement("span");
      body.className = "chat-body";
      appendRichContent(body, entry.text || "");
      row.append(body);

      line.append(row);
      return line;
    }

    function profileIdentityList(profile) {
      const keys = new Set();
      const userId = clean(profile?.userId || "");
      const login = clean((profile?.login || "").toLowerCase());
      if (userId) {
        keys.add(`id:${userId}`);
      }
      if (login) {
        keys.add(`login:${login}`);
      }
      return keys;
    }

    function setUserCardIdentities(card, profile) {
      const next = profileIdentityList(profile);
      card.identities.forEach((key) => {
        if (next.has(key)) {
          return;
        }
        const set = openUserCardsByIdentity.get(key);
        if (!set) {
          return;
        }
        set.delete(card.id);
        if (!set.size) {
          openUserCardsByIdentity.delete(key);
        }
      });

      next.forEach((key) => {
        if (card.identities.has(key)) {
          return;
        }
        if (!openUserCardsByIdentity.has(key)) {
          openUserCardsByIdentity.set(key, new Set());
        }
        openUserCardsByIdentity.get(key).add(card.id);
      });

      card.identities = next;
    }

    function positionUserCard(cardEl, index) {
      const x = index % 4;
      const y = Math.floor(index / 4) % 6;
      cardEl.style.top = `${24 + y * 26}px`;
      cardEl.style.right = `${24 + x * 22}px`;
      cardEl.style.left = "auto";
      cardEl.style.bottom = "auto";
    }

    function focusUserCard(cardEl) {
      userCardLayer += 1;
      cardEl.style.zIndex = String(userCardLayer);
    }

    function bindUserCardDragging(card, handleEl) {
      handleEl.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        if (event.target instanceof Element && event.target.closest(".chat-user-card-close")) {
          return;
        }

        const cardEl = card.el;
        const rect = cardEl.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        const pointerId = event.pointerId;

        focusUserCard(cardEl);
        cardEl.style.right = "auto";
        cardEl.style.left = `${rect.left}px`;
        cardEl.style.top = `${rect.top}px`;

        const onMove = (moveEvent) => {
          if (moveEvent.pointerId !== pointerId) {
            return;
          }

          const maxLeft = Math.max(0, window.innerWidth - rect.width);
          const maxTop = Math.max(0, window.innerHeight - rect.height);
          const nextLeft = clamp(moveEvent.clientX - offsetX, 0, maxLeft);
          const nextTop = clamp(moveEvent.clientY - offsetY, 0, maxTop);
          cardEl.style.left = `${nextLeft}px`;
          cardEl.style.top = `${nextTop}px`;
        };

        const onStop = (stopEvent) => {
          if (stopEvent.pointerId !== pointerId) {
            return;
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onStop);
          window.removeEventListener("pointercancel", onStop);
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onStop);
        window.addEventListener("pointercancel", onStop);
        event.preventDefault();
      });
    }

    function closeUserCard(cardId) {
      const card = openUserCards.get(cardId);
      if (!card) {
        return;
      }

      card.requestToken += 1;
      card.identities.forEach((key) => {
        const set = openUserCardsByIdentity.get(key);
        if (!set) {
          return;
        }
        set.delete(card.id);
        if (!set.size) {
          openUserCardsByIdentity.delete(key);
        }
      });

      openUserCards.delete(card.id);
      card.el.remove();
    }

    function closeAllUserCards() {
      Array.from(openUserCards.keys()).forEach((cardId) => closeUserCard(cardId));
    }

    function pushMessageToOpenUserCards({ login, userId, text, timeLabel }) {
      const payload = {
        text: clean(text || ""),
        timeLabel: clean(timeLabel || nowHHMM()),
      };
      if (!payload.text) {
        return;
      }

      const ids = new Set();
      const normalizedLogin = clean((login || "").toLowerCase());
      const normalizedUserId = clean(userId || "");

      if (normalizedLogin) {
        const byLogin = openUserCardsByIdentity.get(`login:${normalizedLogin}`);
        if (byLogin) {
          byLogin.forEach((cardId) => ids.add(cardId));
        }
      }
      if (normalizedUserId) {
        const byUserId = openUserCardsByIdentity.get(`id:${normalizedUserId}`);
        if (byUserId) {
          byUserId.forEach((cardId) => ids.add(cardId));
        }
      }

      ids.forEach((cardId) => {
        const card = openUserCards.get(cardId);
        if (!card) {
          return;
        }

        card.recentMessages.push(payload);
        if (card.recentMessages.length > 80) {
          card.recentMessages = card.recentMessages.slice(-80);
        }

        const list = card.el.querySelector(".chat-user-card-recent-list");
        const count = card.el.querySelector(".chat-user-card-recent-count");
        if (!(list instanceof HTMLElement)) {
          return;
        }

        const empty = list.querySelector(".chat-user-card-recent-empty");
        if (empty) {
          empty.remove();
        }

        list.append(renderRecentMessageLine(payload, card.profile.name || "Usuario"));
        if (list.children.length > 80) {
          list.removeChild(list.firstChild);
        }
        list.scrollTop = list.scrollHeight;

        if (count instanceof HTMLElement) {
          count.textContent = String(card.recentMessages.length);
        }
      });
    }

    function readProfileFromNode(node) {
      const name = clean(node.dataset.userName || node.textContent?.replace(/:$/, "") || "");
      const login = clean((node.dataset.userLogin || "").toLowerCase());
      const userId = clean(node.dataset.userId || "");
      const badges = parseSerializedBadges(node.dataset.userBadges || "");

      if (!name && !login && !userId) {
        return null;
      }

      return {
        name: name || login || "Usuario",
        login,
        userId,
        color: node.dataset.userColor || "#efeff1",
        badges,
        role: detectRole(badges),
        subscriber: node.dataset.userSubscriber === "1",
        turbo: node.dataset.userTurbo === "1",
        firstMsg: node.dataset.userFirstMsg === "1",
      };
    }

    async function fetchUserDetails(profile) {
      const cacheKey = profile.userId ? `id:${profile.userId}` : profile.login ? `login:${profile.login}` : "";
      if (!cacheKey) {
        return null;
      }
      if (hoverUserCache.has(cacheKey)) {
        return hoverUserCache.get(cacheKey);
      }

      const urls = [];
      if (profile.userId) {
        urls.push(`https://api.ivr.fi/v2/twitch/user?id=${encodeURIComponent(profile.userId)}`);
      }
      if (profile.login) {
        urls.push(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(profile.login)}`);
      }

      for (const url of urls) {
        try {
          const payload = await fetchJson(url);
          const normalized = normalizeRemoteUser(payload);
          if (normalized) {
            const sub = await fetchSubDetails(normalized.login || profile.login);
            const merged = sub ? { ...normalized, ...sub } : normalized;
            hoverUserCache.set(cacheKey, merged);
            return merged;
          }
        } catch {
          // Ignore endpoint failures and keep local info.
        }
      }

      return null;
    }

    function normalizeRemoteUser(payload) {
      const candidate = Array.isArray(payload)
        ? payload[0]
        : Array.isArray(payload?.users)
          ? payload.users[0]
          : Array.isArray(payload?.data)
            ? payload.data[0]
            : payload?.user || payload;

      if (!candidate || typeof candidate !== "object") {
        return null;
      }

      const login = clean((candidate.login || candidate.name || candidate.username || "").toLowerCase());
      const name = clean(candidate.displayName || candidate.display_name || candidate.name || "");
      const userId = clean(candidate.id || candidate.userId || "");
      const createdAt = clean(candidate.createdAt || candidate.created_at || "");
      const description = clean(candidate.bio || candidate.description || "");
      const type = clean(candidate.type || candidate.user_type || "");
      const avatarUrl = toFastAvatarUrl(clean(
        candidate.logo || candidate.profileImageURL || candidate.profileImageUrl || candidate.profile_image_url || ""
      ));

      if (!login && !name && !userId) {
        return null;
      }

      return { login, name, userId, createdAt, description, type, avatarUrl };
    }

    async function fetchSubDetails(login) {
      const normalizedLogin = clean((login || "").toLowerCase());
      if (!normalizedLogin || !currentChannel) {
        return null;
      }

      const channel = encodeURIComponent(currentChannel);
      const user = encodeURIComponent(normalizedLogin);
      const urls = [
        `https://api.ivr.fi/v2/twitch/subage/${channel}/${user}`,
        `https://api.ivr.fi/v2/twitch/subage/${user}/${channel}`,
      ];

      for (const url of urls) {
        try {
          const payload = await fetchJson(url);
          const normalized = normalizeSubDetails(payload);
          if (normalized) {
            return normalized;
          }
        } catch {
          // Try next subage endpoint shape.
        }
      }

      return null;
    }

    function normalizeSubDetails(payload) {
      if (!payload || typeof payload !== "object") {
        return null;
      }

      const subscribed = Boolean(
        payload.subscribed ??
        payload.isSub ??
        payload.status ??
        payload.cumulative ??
        payload.streak ??
        payload.followedSince
      );
      if (!subscribed) {
        return null;
      }

      const subSince = clean(
        payload.subscribedAt ||
        payload.subscribedSince ||
        payload.subscribeDate ||
        payload.meta?.subscribeDate ||
        ""
      );
      const subMonthsRaw =
        payload.cumulative?.months ??
        payload.months ??
        payload.monthCount ??
        payload.totalMonths ??
        payload.meta?.months;
      const subMonths = Number(subMonthsRaw);
      const subTier = clean(
        payload.subPlanName ||
        payload.tier ||
        payload.plan ||
        payload.meta?.subPlanName ||
        ""
      );

      return {
        subSince: subSince || "",
        subMonths: Number.isFinite(subMonths) ? subMonths : undefined,
        subTier: subTier || "",
      };
    }

    function toFastAvatarUrl(url) {
      const value = clean(url);
      if (!value) {
        return "";
      }

      // Twitch CDN avatars are commonly served as WxH. Request a smaller one for hover cards.
      return value.replace(/(\d+)x(\d+)(\.(?:png|jpg|jpeg|webp))/i, "70x70$3");
    }

    function serializeBadges(badges) {
      return (Array.isArray(badges) ? badges : [])
        .map((badge) => `${clean(badge?.setId || "")}/${clean(badge?.version || "1")}`)
        .filter((entry) => entry !== "/")
        .join(",");
    }

    function parseSerializedBadges(raw) {
      if (!raw) {
        return [];
      }
      return raw
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

    function formatDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }
      return date.toLocaleDateString("es-ES");
    }

    function formatUserDocumentId(profile) {
      const source = clean(profile?.userId || profile?.login || profile?.name || "");
      if (!source) {
        return "ID 0000 0000";
      }
      const compact = source.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8).padEnd(8, "0");
      return `ID ${compact.slice(0, 4)} ${compact.slice(4)}`;
    }

    function appendRichContent(container, text) {
      tokenize(text).forEach((token) => {
        if (token.type === "space") {
          container.append(token.value);
          return;
        }

        const emote = parseEmoteToken(token.value);
        if (!emote) {
          const link = parseLinkToken(token.value);
          if (link) {
            container.append(renderLink(link));
            return;
          }

          const mention = parseMentionToken(token.value);
          if (mention) {
            container.append(renderMention(mention));
            return;
          }

          container.append(token.value);
          return;
        }

        if (emote.leading) {
          container.append(emote.leading);
        }
        const img = document.createElement("img");
        img.className = "chat-emote";
        img.src = emote.url;
        img.alt = emote.code;
        img.loading = "lazy";
        img.addEventListener("mouseenter", () => showEmotePreview(img));
        img.addEventListener("mouseleave", hideEmotePreview);
        img.addEventListener("pointerdown", hideEmotePreview);
        container.append(img);
        if (emote.trailing) {
          container.append(emote.trailing);
        }
      });
    }

    function parseEmoteToken(token) {
      const raw = String(token || "");
      if (!raw) {
        return null;
      }

      const normalized = raw.replace(/[\u0000-\u001f\u007f]/g, "");
      if (!normalized) {
        return null;
      }

      const direct = resolveEmote(normalized);
      if (direct) {
        return {
          code: direct.code,
          url: direct.url,
          leading: "",
          trailing: "",
        };
      }

      const leadingMatch = normalized.match(/^[([{'"`<]+/);
      const trailingMatch = normalized.match(/[)\]}'"`>,.!?:;]+$/);
      const leading = leadingMatch ? leadingMatch[0] : "";
      const trailing = trailingMatch ? trailingMatch[0] : "";
      const code = normalized.slice(leading.length, normalized.length - trailing.length);
      if (!code) {
        return null;
      }

      const resolved = resolveEmote(code);
      if (!resolved) {
        return null;
      }

      return { code: resolved.code, url: resolved.url, leading, trailing };
    }

    function resolveEmote(code) {
      const normalized = String(code || "");
      if (!normalized) {
        return null;
      }

      const exact = emotes.get(normalized);
      if (exact) {
        return { code: normalized, url: exact };
      }

      const insensitive = emotesInsensitive.get(normalized.toLowerCase());
      if (insensitive) {
        return insensitive;
      }

      return null;
    }

    function createEmotePreview() {
      const root = document.createElement("div");
      root.className = "chat-emote-preview";
      root.setAttribute("aria-hidden", "true");

      const label = document.createElement("p");
      label.className = "chat-emote-preview-label";

      const media = document.createElement("div");
      media.className = "chat-emote-preview-media";
      const image = document.createElement("img");
      image.alt = "";
      media.append(image);
      root.append(label, media);
      document.body.append(root);

      return { root, image, label };
    }

    function showEmotePreview(anchor) {
      if (!(anchor instanceof HTMLImageElement)) {
        return;
      }

      emotePreview.image.src = anchor.currentSrc || anchor.src;
      emotePreview.image.alt = anchor.alt || "emote";
      emotePreview.label.textContent = anchor.alt || "emote";
      emotePreview.root.classList.add("visible");
      positionEmotePreview(anchor);
    }

    function positionEmotePreview(anchor) {
      if (!(anchor instanceof Element)) {
        return;
      }

      const rect = anchor.getBoundingClientRect();
      let left = rect.left + rect.width / 2 - EMOTE_PREVIEW_SIZE / 2;
      left = clamp(left, 8, window.innerWidth - EMOTE_PREVIEW_SIZE - 8);

      let top = rect.top - EMOTE_PREVIEW_SIZE - 10;
      if (top < 8) {
        top = rect.bottom + 10;
      }
      top = clamp(top, 8, window.innerHeight - EMOTE_PREVIEW_SIZE - 8);

      emotePreview.root.style.left = `${Math.round(left)}px`;
      emotePreview.root.style.top = `${Math.round(top)}px`;
    }

    function hideEmotePreview() {
      emotePreview.root.classList.remove("visible");
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

    function parseMentionToken(token) {
      const value = String(token || "");
      if (!value || value[0] !== "@") {
        return null;
      }

      const trailingMatch = value.match(/[),.!?:;]+$/);
      const trailing = trailingMatch ? trailingMatch[0] : "";
      const candidate = trailing ? value.slice(0, -trailing.length) : value;
      if (!/^@[a-z0-9_]{2,25}$/i.test(candidate)) {
        return null;
      }

      const login = candidate.slice(1).toLowerCase();
      if (!login) {
        return null;
      }

      return {
        login,
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
      link.title = href;
      link.setAttribute("aria-label", href);
      link.target = "_blank";
      link.rel = "noopener noreferrer ugc";

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

    function renderMention({ login, label, trailing }) {
      const mention = document.createElement("span");
      mention.className = "chat-mention";
      mention.textContent = label;
      mention.dataset.userName = login;
      mention.dataset.userLogin = login;
      mention.dataset.userId = "";
      mention.dataset.userColor = "#8bc8ff";
      mention.dataset.userBadges = "";
      mention.dataset.userSubscriber = "0";
      mention.dataset.userTurbo = "0";
      mention.dataset.userFirstMsg = "0";
      mention.addEventListener("click", onUserClick);

      const fragment = document.createDocumentFragment();
      fragment.append(mention);
      if (trailing) {
        fragment.append(trailing);
      }

      return fragment;
    }

    function clearMessages() {
      messagesEl.textContent = "";
      renderedLineCount = 0;
      hideEmotePreview();
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

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  window.createTwitchChatClient = createTwitchChatClient;
})();

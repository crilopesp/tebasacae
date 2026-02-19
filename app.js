const params = new URLSearchParams(window.location.search);

const SOURCE = {
  TWITCH: "twitch",
  YOUTUBE: "youtube",
  NONE: "none",
  TWITCH_OFFICIAL_CHAT: "twitch-official",
  TWITCH_7TV_CHAT: "twitch-7tv",
};
const APP_TITLE = "TEBASACAE";

const available = {
  youtube: normalizeYouTubeChannel(params.get("youtube")),
  twitch: normalizeTwitch(params.get("twitch")),
};

const ui = {
  videoFrame: byId("videoFrame"),
  layout: byId("layout"),
  chatPane: byId("chatPane"),
  officialChat: byId("officialChat"),
  officialChatFrame: byId("officialChatFrame"),
  customChat: byId("customChat"),
  chatStatus: byId("chatStatus"),
  chatChannelLabel: byId("chatChannelLabel"),
  chatPinned: byId("chatPinned"),
  chatMessages: byId("chatMessages"),
  dock: document.querySelector(".dock"),
  settingsButton: document.querySelector(".settings-btn"),
  dockBackdrop: byId("dockBackdrop"),
  chatOverlayToggle: byId("chatOverlayToggle"),
  videoButtons: Array.from(document.querySelectorAll('[data-kind="video-source"]')),
  chatButtons: Array.from(document.querySelectorAll('[data-kind="chat-source"]')),
};

const mobilePortraitQuery = window.matchMedia("(max-width: 640px)");
const mobileLandscapeQuery = window.matchMedia(
  "(orientation: landscape) and (pointer: coarse) and (max-width: 960px) and (max-height: 540px)",
);
const host = window.location.hostname || "localhost";

const state = {
  video: normalizeVideo(params.get("video")),
  chatType: normalizeChatType(params.get("chat")),
  chatPanelOpen: true,
};

const twitchChat = createTwitchChatClient({
  messagesEl: ui.chatMessages,
  statusEl: ui.chatStatus,
  channelEl: ui.chatChannelLabel,
  pinnedEl: ui.chatPinned,
});

sanitizeState();
render();
wireEvents();

function wireEvents() {
  bindSourceButtons(ui.videoButtons, "video");
  bindSourceButtons(ui.chatButtons, "chatType");
  wireVideoTitleUpdates();

  if (ui.settingsButton && ui.dock) {
    ui.settingsButton.setAttribute("aria-expanded", "false");
    ui.settingsButton.addEventListener("click", (event) => {
      if (!isMobileDock()) {
        return;
      }

      event.preventDefault();
      const isOpen = ui.dock.classList.toggle("mobile-open");
      ui.settingsButton.setAttribute("aria-expanded", String(isOpen));
    });
  }

  document.addEventListener("click", (event) => {
    if (!isMobileDock() || !ui.dock || !ui.dock.classList.contains("mobile-open")) {
      return;
    }
    if (ui.dock.contains(event.target)) {
      return;
    }
    closeMobileDock();
  });

  if (ui.dockBackdrop) {
    ui.dockBackdrop.addEventListener("click", () => {
      if (isMobileDock()) {
        closeMobileDock();
      }
    });
  }

  if (ui.chatOverlayToggle) {
    ui.chatOverlayToggle.addEventListener("click", (event) => {
      event.preventDefault();
      state.chatPanelOpen = !state.chatPanelOpen;
      renderChat();
    });
  }

  const onViewportChange = () => {
    closeMobileDock();
    render();
  };

  [mobilePortraitQuery, mobileLandscapeQuery].forEach((query) => {
    if (query.addEventListener) {
      query.addEventListener("change", onViewportChange);
    } else if (query.addListener) {
      query.addListener(onViewportChange);
    }
  });
}

function wireVideoTitleUpdates() {
  if (!ui.videoFrame) {
    return;
  }

  ui.videoFrame.addEventListener("load", () => {
    document.title = getCurrentStreamTitle();
  });
}

function bindSourceButtons(buttons, stateKey) {
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) {
        return;
      }

      const source = button.dataset.source;
      if (!source) {
        return;
      }

      state[stateKey] = source;
      if (stateKey === "chatType" && source !== SOURCE.NONE) {
        state.chatPanelOpen = true;
      }
      sanitizeState();
      pushQuery();
      render();
      closeMobileDock();
    });
  });
}

function sanitizeState() {
  if (!hasVideoSource(state.video)) {
    state.video = fallbackVideo();
  }

  if (state.chatType !== SOURCE.NONE && !hasChatSource(state.chatType)) {
    state.chatType = SOURCE.NONE;
  }
}

function render() {
  renderVideo();
  renderChat();
  renderButtons();
}

function renderVideo() {
  document.title = APP_TITLE;
  setFrameSrc(ui.videoFrame, buildVideoSrc(state.video));
}

function renderChat() {
  const shouldShow = state.chatType !== SOURCE.NONE;
  const overlayMode = isMobileLandscape();
  const forceOpenInMobilePortrait = shouldShow && isMobileDock() && !overlayMode;
  const panelOpen = shouldShow ? (forceOpenInMobilePortrait ? true : state.chatPanelOpen) : false;
  const overlayOpen = overlayMode ? panelOpen : false;
  const splitOpen = !overlayMode ? panelOpen : false;

  ui.chatPane.hidden = !shouldShow || (!overlayMode && !splitOpen);
  ui.layout.classList.toggle("chat-visible", shouldShow && !overlayMode && splitOpen);
  ui.layout.classList.toggle("chat-overlay-mode", shouldShow && overlayMode);
  ui.layout.classList.toggle("chat-overlay-open", overlayOpen);
  renderChatOverlayToggle(shouldShow, panelOpen, overlayMode);

  if (state.chatType === SOURCE.TWITCH_OFFICIAL_CHAT && available.twitch) {
    ui.officialChat.hidden = false;
    ui.customChat.hidden = true;
    twitchChat.stop();
    setFrameSrc(ui.officialChatFrame, buildOfficialChatSrc());
    return;
  }

  if (state.chatType === SOURCE.TWITCH_7TV_CHAT && available.twitch) {
    ui.officialChat.hidden = true;
    ui.customChat.hidden = false;
    setFrameSrc(ui.officialChatFrame, "");
    twitchChat.start(available.twitch);
    return;
  }

  ui.officialChat.hidden = true;
  ui.customChat.hidden = true;
  setFrameSrc(ui.officialChatFrame, "");
  twitchChat.stop();
}

function renderButtons() {
  ui.videoButtons.forEach((button) => {
    const source = button.dataset.source;
    if (!source) {
      return;
    }

    button.disabled = !hasVideoSource(source);
    button.classList.toggle("active", state.video === source);
  });

  ui.chatButtons.forEach((button) => {
    const source = button.dataset.source;
    if (!source) {
      return;
    }

    button.disabled = source !== SOURCE.NONE && !hasChatSource(source);
    button.classList.toggle("active", state.chatType === source);
  });
}

function hasVideoSource(source) {
  return source === SOURCE.TWITCH
    ? Boolean(available.twitch)
    : source === SOURCE.YOUTUBE
      ? Boolean(available.youtube.channelId)
      : false;
}

function hasChatSource(source) {
  return (
    source === SOURCE.NONE ||
    ((source === SOURCE.TWITCH_OFFICIAL_CHAT || source === SOURCE.TWITCH_7TV_CHAT) && Boolean(available.twitch))
  );
}

function buildVideoSrc(source) {
  if (source === SOURCE.YOUTUBE && available.youtube.channelId) {
    const channel = encodeURIComponent(available.youtube.channelId);
    return `https://www.youtube.com/embed/live_stream?channel=${channel}&autoplay=1&playsinline=1`;
  }

  if (source === SOURCE.TWITCH && available.twitch) {
    const channel = encodeURIComponent(available.twitch);
    return `https://player.twitch.tv/?channel=${channel}&parent=${encodeURIComponent(host)}&autoplay=true`;
  }

  return "";
}

function getCurrentStreamTitle() {
  if (state.video === SOURCE.TWITCH && available.twitch) {
    return `${available.twitch} - ${APP_TITLE}`;
  }

  if (state.video === SOURCE.YOUTUBE && available.youtube.channelId) {
    return `${available.youtube.channelId} - ${APP_TITLE}`;
  }

  return APP_TITLE;
}

function pushQuery() {
  params.set("video", state.video);
  params.set("chat", state.chatType);

  if (available.youtube.channelId) {
    params.set("youtube", available.youtube.channelId);
  }
  if (available.twitch) {
    params.set("twitch", available.twitch);
  }

  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

function normalizeVideo(raw) {
  return raw === SOURCE.TWITCH || raw === SOURCE.YOUTUBE ? raw : fallbackVideo();
}

function normalizeChatType(raw) {
  if (raw === SOURCE.TWITCH_7TV_CHAT || raw === SOURCE.TWITCH) {
    return SOURCE.TWITCH_7TV_CHAT;
  }
  if (raw === SOURCE.TWITCH_OFFICIAL_CHAT) {
    return SOURCE.TWITCH_OFFICIAL_CHAT;
  }
  return SOURCE.NONE;
}

function buildOfficialChatSrc() {
  if (!available.twitch) {
    return "";
  }

  const channel = encodeURIComponent(available.twitch);
  return `https://www.twitch.tv/embed/${channel}/chat?parent=${encodeURIComponent(host)}&darkpopout`;
}

function fallbackVideo() {
  if (available.twitch) {
    return SOURCE.TWITCH;
  }
  if (available.youtube.channelId) {
    return SOURCE.YOUTUBE;
  }
  return SOURCE.TWITCH;
}

function normalizeYouTubeChannel(raw) {
  const value = clean(raw);
  if (!value) {
    return { channelId: "" };
  }

  const url = parseUrl(value);
  if (url) {
    const hostName = url.hostname.replace(/^www\./, "");
    if (hostName.endsWith("youtube.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "channel" && parts[1]) {
        const channelId = cleanChannel(parts[1]);
        return { channelId: isUcChannelId(channelId) ? channelId : "" };
      }
    }
  }

  const channelId = cleanChannel(value);
  return { channelId: isUcChannelId(channelId) ? channelId : "" };
}

function normalizeTwitch(raw) {
  const value = clean(raw);
  if (!value) {
    return "";
  }

  const url = parseUrl(value);
  if (url && url.hostname.replace(/^www\./, "").endsWith("twitch.tv")) {
    const [channel = ""] = url.pathname.split("/").filter(Boolean);
    return isValidTwitchChannel(channel) ? cleanChannel(channel) : "";
  }

  if (value.includes("twitch.tv/")) {
    const tail = value.split("twitch.tv/")[1] || "";
    const candidate = cleanChannel(tail.split(/[/?#]/)[0]);
    return isValidTwitchChannel(candidate) ? candidate : "";
  }

  const candidate = cleanChannel(value);
  return isValidTwitchChannel(candidate) ? candidate : "";
}

function isValidTwitchChannel(value) {
  return /^[a-z0-9_]{4,25}$/i.test(clean(value));
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    try {
      return new URL(`https://${value}`);
    } catch {
      return null;
    }
  }
}

function isUcChannelId(value) {
  return /^UC[A-Za-z0-9_-]{20,}$/.test(value);
}

function cleanChannel(value) {
  return clean(value.replace(/^@/, "").split(/[?&#/]/)[0]);
}

function setFrameSrc(frame, src) {
  const next = src || "about:blank";
  if (frame.src !== next) {
    frame.src = next;
  }
}

function byId(id) {
  return document.getElementById(id);
}

function clean(value) {
  return value ? value.trim() : "";
}

function isMobileDock() {
  return mobilePortraitQuery.matches || mobileLandscapeQuery.matches;
}

function isMobileLandscape() {
  return mobileLandscapeQuery.matches;
}

function closeMobileDock() {
  if (!ui.dock) {
    return;
  }

  ui.dock.classList.remove("mobile-open");
  if (ui.settingsButton) {
    ui.settingsButton.setAttribute("aria-expanded", "false");
  }
}

function renderChatOverlayToggle(shouldShow, panelOpen, overlayMode) {
  if (!ui.chatOverlayToggle) {
    return;
  }

  const visible = shouldShow && (overlayMode || !isMobileDock());
  ui.chatOverlayToggle.classList.toggle("overlay-mode", shouldShow && overlayMode);
  ui.chatOverlayToggle.hidden = !visible;
  if (!visible) {
    ui.chatOverlayToggle.setAttribute("aria-expanded", "false");
    ui.chatOverlayToggle.setAttribute("aria-label", "Mostrar chat");
    return;
  }

  ui.chatOverlayToggle.setAttribute("aria-expanded", String(panelOpen));
  ui.chatOverlayToggle.setAttribute("aria-label", panelOpen ? "Ocultar chat" : "Mostrar chat");
}

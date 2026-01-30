const TOGGLE_COMMAND = "toggle-voice-input";
const TOGGLE_MESSAGE = "TOGGLE_RECOGNITION";
const RESET_MESSAGE = "RESET_UI_POSITION";
const UI_POSITIONS_KEY = "uiPositions";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["speechSettings"]).then(({ speechSettings }) => {
    if (!speechSettings) {
      chrome.storage.local.set({
        speechSettings: {
          autoPunctuation: true,
          honorPunctuationCommands: true
        }
      });
    }
  }).catch(() => {
    // Ignore storage errors during first install.
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== TOGGLE_COMMAND) {
    return;
  }

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });

    if (!activeTab?.id) {
      return;
    }

    await chrome.tabs.sendMessage(activeTab.id, { type: TOGGLE_MESSAGE });
  } catch (error) {
    // Content script might not be injected yet; ignore.
    console.debug("Failed to toggle voice input:", error);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) {
    return;
  }

  const siteKey = getSiteKeyFromTab(tab);
  if (siteKey) {
    try {
      const { uiPositions } = await chrome.storage.local.get({
        [UI_POSITIONS_KEY]: {}
      });
      const positions = uiPositions ?? {};
      if (positions[siteKey]) {
        delete positions[siteKey];
        await chrome.storage.local.set({ [UI_POSITIONS_KEY]: positions });
      }
    } catch (error) {
      console.debug("Failed to reset stored UI position:", error);
    }
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: RESET_MESSAGE });
  } catch (error) {
    // Content script might not be injected yet; ignore.
    console.debug("Failed to notify UI reset:", error);
  }
});

function getSiteKeyFromTab(tab) {
  const url = tab?.url;
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.origin && parsed.origin !== "null") {
      return parsed.origin;
    }
    return parsed.href;
  } catch (error) {
    return url;
  }
}

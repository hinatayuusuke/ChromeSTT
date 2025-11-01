const TOGGLE_COMMAND = "toggle-voice-input";
const TOGGLE_MESSAGE = "TOGGLE_RECOGNITION";

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

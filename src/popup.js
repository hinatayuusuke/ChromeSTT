const resetButton = document.getElementById("resetButton");
const status = document.getElementById("status");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });
  return tab;
}

function describeOrigin(url) {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch (error) {
    return "";
  }
}

async function resetUiPosition() {
  resetButton.disabled = true;
  status.textContent = "リセット中…";

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      status.textContent = "有効なタブが見つかりませんでした。";
      return;
    }

    await chrome.tabs.sendMessage(tab.id, { type: "RESET_UI_POSITION" });
    const origin = describeOrigin(tab.url);
    status.textContent = origin
      ? `${origin} の位置をリセットしました。`
      : "位置をリセットしました。";
  } catch (error) {
    status.textContent = "このページでは位置をリセットできません。";
  } finally {
    resetButton.disabled = false;
  }
}

resetButton.addEventListener("click", resetUiPosition);

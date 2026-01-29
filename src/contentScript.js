(() => {
  if (window.__chromeSttInitialized) {
    return;
  }
  window.__chromeSttInitialized = true;

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  const settings = {
    autoPunctuation: true,
    honorPunctuationCommands: true
  };

  chrome.storage?.local
    ?.get(["speechSettings"])
    .then(({ speechSettings }) => {
      if (speechSettings) {
        Object.assign(settings, speechSettings);
      }
    })
    .catch(() => {
      // Ignore storage read errors; defaults remain in place.
    });

  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.speechSettings?.newValue) {
      return;
    }
    Object.assign(settings, changes.speechSettings.newValue);
  });

  const punctuationCommands = new Map([
    ["読点", "、"],
    ["句点", "。"],
    ["かいぎょう", "\n"],
    ["かっこ", "「"],
    ["かっことじ", "」"]
  ]);

  const dom = buildUi();
  setUiVisible(false);
  const uiPositioning = setupUiPositioning();

  const recognition = SpeechRecognition ? new SpeechRecognition() : null;

  if (!recognition) {
    dom.status.textContent =
      "このブラウザは音声認識（Web Speech API）に対応していません。";
    dom.status.classList.add("chrome-stt-status--error");
    dom.button.disabled = true;
  } else {
    recognition.lang = "ja-JP";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = true;
  }

  let isActive = false;
  let manuallyStopping = false;
  let lastInterimText = "";
  let isUiDragging = false;

  if (recognition) {
    recognition.onstart = () => {
      dom.button.classList.add("chrome-stt-button--listening");
      dom.status.textContent = "音声入力中…";
      dom.status.classList.remove("chrome-stt-status--error");
      dom.status.classList.add("chrome-stt-status--visible");
    };

    recognition.onerror = (event) => {
      dom.status.textContent = `音声認識エラー: ${event.error}`;
      dom.status.classList.add("chrome-stt-status--error");
      stopRecognitionInternal(true);
    };

    recognition.onend = () => {
      dom.button.classList.remove("chrome-stt-button--listening");
      if (isActive && !manuallyStopping) {
        // Chrome stops recognition automatically after a pause; restart to keep listening.
        safeStart();
        return;
      }
      isActive = false;
      manuallyStopping = false;
      dom.status.textContent = "音声入力は停止しました。";
      lastInterimText = "";
      setTimeout(() => {
        if (!isActive) {
          dom.status.classList.remove("chrome-stt-status--visible");
        }
      }, 1500);
    };

    recognition.onresult = (event) => {
      let finalTextBuffer = "";
      let interimTextBuffer = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const { transcript } = result[0];
        if (result.isFinal) {
          const converted = applyTextConversions(transcript);
          if (converted.type === "command" && converted.payload === "\n") {
            insertLineBreak();
          } else {
            commitText(converted.payload);
          }
          finalTextBuffer += converted.display;
        } else {
          interimTextBuffer += transcript;
        }
      }

      if (interimTextBuffer) {
        lastInterimText = interimTextBuffer;
        dom.status.textContent = `${interimTextBuffer} …`;
        dom.status.classList.add("chrome-stt-status--visible");
      } else if (finalTextBuffer) {
        dom.status.textContent = finalTextBuffer;
        dom.status.classList.add("chrome-stt-status--visible");
        lastInterimText = "";
      }
    };
  }

  let suppressNextClick = false;
  dom.button.addEventListener("click", () => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    toggleRecognition();
  });

  document.addEventListener("focusin", handleFocusChange, true);
  document.addEventListener("focusout", handleFocusChange, true);
  handleFocusChange();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TOGGLE_RECOGNITION") {
      toggleRecognition();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "RESET_UI_POSITION") {
      uiPositioning?.resetPosition();
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });

  function toggleRecognition() {
    if (!recognition) {
      return;
    }
    if (isActive) {
      stopRecognitionInternal(false);
    } else {
      startRecognition();
    }
  }

  function startRecognition() {
    if (isActive) {
      return;
    }
    if (!recognition) {
      return;
    }
    if (!getEditableTarget()) {
      return;
    }
    isActive = true;
    manuallyStopping = false;
    updateButtonState(true);
    safeStart();
  }

  function safeStart() {
    if (!recognition) {
      return;
    }
    try {
      recognition.start();
    } catch (error) {
      // Chrome throws when start() is called twice rapidly; retry shortly.
      console.debug("Speech recognition start failed, retrying:", error);
      setTimeout(() => {
        if (isActive && !manuallyStopping) {
          safeStart();
        }
      }, 500);
    }
  }

  function stopRecognitionInternal(isError) {
    manuallyStopping = !isError;
    isActive = false;
    updateButtonState(false);
    if (!recognition) {
      return;
    }
    try {
      recognition.stop();
    } catch (error) {
      console.debug("Speech recognition stop failed:", error);
    }
  }

  function applyTextConversions(rawTranscript) {
    const trimmed = rawTranscript.trim();
    if (
      settings.honorPunctuationCommands &&
      punctuationCommands.has(trimmed)
    ) {
      const punctuation = punctuationCommands.get(trimmed);
      const display = punctuation === "\n" ? "改行" : punctuation;
      return {
        type: "command",
        payload: punctuation,
        display
      };
    }

    let processed = rawTranscript;

    if (settings.autoPunctuation) {
      processed = maybeAddPunctuation(processed);
    }

    return {
      type: "text",
      payload: processed,
      display: processed
    };
  }

  function maybeAddPunctuation(text) {
    const trimmed = text.trim();
    if (!trimmed) {
      return text;
    }
    const hasTerminator = /[。！？]$/.test(trimmed);
    if (hasTerminator) {
      return trimmed;
    }
    // Heuristic: add 。 when ending with polite verbs.
    if (/[ますですでした]$/.test(trimmed)) {
      return `${trimmed}。`;
    }
    return trimmed;
  }

  function commitText(text) {
    const target = getEditableTarget();
    if (!target) {
      dom.status.textContent = "入力可能な欄が見つかりません。";
      dom.status.classList.add("chrome-stt-status--error");
      return;
    }

    if (isInputLike(target)) {
      const control = target;
      const start = control.selectionStart ?? control.value.length;
      const end = control.selectionEnd ?? start;
      const value = control.value ?? "";
      const nextValue = value.slice(0, start) + text + value.slice(end);
      const cursor = start + text.length;
      control.value = nextValue;
      control.selectionStart = cursor;
      control.selectionEnd = cursor;
      control.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: text,
          inputType: "insertText"
        })
      );
      return;
    }

    if (target.isContentEditable) {
      insertIntoContentEditable(target, text);
    }
  }

  function insertLineBreak() {
    const target = getEditableTarget();
    if (!target) {
      dom.status.textContent = "入力可能な欄が見つかりません。";
      dom.status.classList.add("chrome-stt-status--error");
      return;
    }

    if (isInputLike(target)) {
      commitText("\n");
      return;
    }

    if (target.isContentEditable) {
      if (document.queryCommandSupported("insertLineBreak")) {
        document.execCommand("insertLineBreak");
      } else {
        insertIntoContentEditable(target, "\n");
      }
    }
  }

  function insertIntoContentEditable(root, text) {
    const selection = root.getRootNode().getSelection?.() ?? window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      root.append(document.createTextNode(text));
      return;
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStart(node, node.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    root.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: text,
        inputType: "insertText"
      })
    );
  }

  function getEditableTarget() {
    const active = getDeepActiveElement();
    if (!active) {
      return null;
    }

    if (isEditable(active)) {
      return active;
    }

    return active.closest?.("input, textarea, [contenteditable=''], [contenteditable='true']");
  }

  function getDeepActiveElement(root = document) {
    const active = root.activeElement;
    if (!active) {
      return null;
    }

    if (active.shadowRoot) {
      return getDeepActiveElement(active.shadowRoot) ?? active;
    }

    return active;
  }

  function isEditable(element) {
    if (isInputLike(element)) {
      return !element.readOnly && !element.disabled;
    }
    return Boolean(element.isContentEditable);
  }

  function isInputLike(element) {
    return (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    );
  }

  function buildUi() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chrome-stt-button";
    button.setAttribute("aria-live", "polite");
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("title", "音声入力を開始/停止（Ctrl+Shift+.)");
    button.innerHTML =
      '<span class="chrome-stt-button__icon" aria-hidden="true"></span><span class="chrome-stt-button__label">音声入力</span>';

    const status = document.createElement("div");
    status.className = "chrome-stt-status";
    status.setAttribute("aria-live", "polite");

    const container = document.createElement("div");
    container.className = "chrome-stt-root";
    container.append(button, status);

    const host = document.body ?? document.documentElement;
    host.append(container);

    return { button, status, container };
  }

  function setupUiPositioning() {
    const uiPositionStorageKey = `chromeSttUiPosition:${location.origin}`;
    const dragState = {
      pointerId: null,
      startX: 0,
      startY: 0,
      originX: 0,
      originY: 0,
      dragging: false,
      rafId: 0,
      pendingX: 0,
      pendingY: 0
    };
    // WHY: Small cursor jitter should not cancel click-to-toggle.
    const dragThresholdPx = 6;
    let storedPosition = null;

    restorePosition();

    dom.container.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      dragState.pointerId = event.pointerId;
      dragState.startX = event.clientX;
      dragState.startY = event.clientY;
      const rect = dom.container.getBoundingClientRect();
      dragState.originX = rect.left;
      dragState.originY = rect.top;
      dragState.dragging = false;
      dom.container.setPointerCapture(event.pointerId);
    });

    dom.container.addEventListener("pointermove", (event) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }
      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (!dragState.dragging) {
        if (Math.hypot(deltaX, deltaY) < dragThresholdPx) {
          return;
        }
        dragState.dragging = true;
        isUiDragging = true;
        setUiVisible(true);
        dom.container.classList.add("chrome-stt-root--dragging");
      }
      schedulePositionUpdate(dragState.originX + deltaX, dragState.originY + deltaY);
      event.preventDefault();
    });

    dom.container.addEventListener("pointerup", (event) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }
      if (dragState.dragging) {
        suppressNextClick = true;
        if (storedPosition) {
          savePosition(storedPosition);
        }
      }
      endDrag();
    });

    dom.container.addEventListener("pointercancel", (event) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }
      endDrag();
    });

    window.addEventListener("resize", () => {
      if (!storedPosition) {
        return;
      }
      const clamped = clampPosition(storedPosition.x, storedPosition.y);
      applyPosition(clamped, true);
    });

    function endDrag() {
      if (dragState.pointerId !== null) {
        dom.container.releasePointerCapture(dragState.pointerId);
      }
      dragState.pointerId = null;
      dragState.dragging = false;
      isUiDragging = false;
      dom.container.classList.remove("chrome-stt-root--dragging");
      if (dragState.rafId) {
        cancelAnimationFrame(dragState.rafId);
        dragState.rafId = 0;
      }
      handleFocusChange();
    }

    function schedulePositionUpdate(x, y) {
      dragState.pendingX = x;
      dragState.pendingY = y;
      if (dragState.rafId) {
        return;
      }
      dragState.rafId = requestAnimationFrame(() => {
        dragState.rafId = 0;
        const clamped = clampPosition(dragState.pendingX, dragState.pendingY);
        applyPosition(clamped, false);
      });
    }

    function clampPosition(x, y) {
      const rect = dom.container.getBoundingClientRect();
      const maxX = Math.max(0, window.innerWidth - rect.width);
      const maxY = Math.max(0, window.innerHeight - rect.height);
      return {
        x: Math.max(0, Math.min(x, maxX)),
        y: Math.max(0, Math.min(y, maxY))
      };
    }

    function applyPosition(position, persist) {
      dom.container.style.left = `${position.x}px`;
      dom.container.style.top = `${position.y}px`;
      dom.container.style.right = "auto";
      dom.container.style.bottom = "auto";
      storedPosition = { x: position.x, y: position.y };
      if (persist) {
        savePosition(storedPosition);
      }
    }

    function resetPosition() {
      storedPosition = null;
      dom.container.style.left = "";
      dom.container.style.top = "";
      dom.container.style.right = "";
      dom.container.style.bottom = "";
      chrome.storage?.local?.remove?.(uiPositionStorageKey);
    }

    function restorePosition() {
      chrome.storage?.local
        ?.get([uiPositionStorageKey])
        .then((result) => {
          const position = result?.[uiPositionStorageKey];
          if (!isValidPosition(position)) {
            return;
          }
          const clamped = clampPosition(position.x, position.y);
          applyPosition(clamped, false);
        })
        .catch(() => {
          // Ignore storage read errors; fall back to default position.
        });
    }

    function savePosition(position) {
      if (!isValidPosition(position)) {
        return;
      }
      chrome.storage?.local?.set?.({ [uiPositionStorageKey]: position });
    }

    function isValidPosition(position) {
      return (
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y)
      );
    }

    function refreshPosition() {
      if (!storedPosition) {
        return;
      }
      const clamped = clampPosition(storedPosition.x, storedPosition.y);
      applyPosition(clamped, false);
    }

    return {
      resetPosition,
      refreshPosition
    };
  }

  function updateButtonState(active) {
    dom.button.setAttribute("aria-pressed", active ? "true" : "false");
  }

  function setUiVisible(visible) {
    dom.container.classList.toggle("chrome-stt-root--hidden", !visible);
  }

  function handleFocusChange() {
    setTimeout(() => {
      if (isUiDragging) {
        setUiVisible(true);
        return;
      }
      const target = getEditableTarget();
      const shouldShow = Boolean(target);
      setUiVisible(shouldShow);
      if (shouldShow) {
        uiPositioning?.refreshPosition();
      }
      if (!shouldShow && isActive) {
        stopRecognitionInternal(false);
      }
    }, 0);
  }
})();

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
  const UI_POSITIONS_KEY = "uiPositions";
  const DRAG_THRESHOLD = 6;
  const POSITION_MARGIN = 12;

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
  const siteKey = getSiteKey();
  let suppressNextClick = false;
  let hasPositioned = false;
  let currentPosition = null;
  let pendingPosition = null;
  let positionRaf = null;
  const dragState = {
    pointerId: null,
    startX: 0,
    startY: 0,
    originLeft: 0,
    originTop: 0,
    pending: false,
    dragging: false
  };

  initStoredPosition();
  setupPositionObservers();

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

  dom.button.addEventListener("click", (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    toggleRecognition();
  });
  dom.button.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  dom.button.addEventListener("pointerdown", handlePointerDown);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);

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
      resetPosition();
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

  function updateButtonState(active) {
    dom.button.setAttribute("aria-pressed", active ? "true" : "false");
  }

  function setUiVisible(visible) {
    dom.container.classList.toggle("chrome-stt-root--hidden", !visible);
    if (visible) {
      ensurePositionInViewport();
    }
  }

  function handleFocusChange() {
    setTimeout(() => {
      const target = getEditableTarget();
      const shouldShow = Boolean(target);
      setUiVisible(shouldShow);
      if (!shouldShow && isActive) {
        stopRecognitionInternal(false);
      }
    }, 0);
  }

  function getSiteKey() {
    if (location.origin && location.origin !== "null") {
      return location.origin;
    }
    return location.href;
  }

  function isValidPosition(position) {
    return (
      position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
    );
  }

  function setupPositionObservers() {
    const resizeObserver = new ResizeObserver(() => {
      if (hasPositioned) {
        ensurePositionInViewport();
      }
    });
    resizeObserver.observe(dom.container);

    window.addEventListener("resize", () => {
      if (hasPositioned) {
        ensurePositionInViewport();
      }
    });

    window.visualViewport?.addEventListener("resize", () => {
      if (hasPositioned) {
        ensurePositionInViewport();
      }
    });
  }

  function handlePointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    dragState.pointerId = event.pointerId;
    dragState.startX = event.clientX;
    dragState.startY = event.clientY;
    const rect = dom.container.getBoundingClientRect();
    dragState.originLeft = rect.left;
    dragState.originTop = rect.top;
    dragState.pending = true;
    dragState.dragging = false;
    dom.button.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    if (!dragState.pending || dragState.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (!dragState.dragging) {
      if (Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) {
        return;
      }
      dragState.dragging = true;
      dom.container.classList.add("chrome-stt-root--dragging");
      applyPosition(dragState.originLeft, dragState.originTop);
    }

    const nextLeft = dragState.originLeft + deltaX;
    const nextTop = dragState.originTop + deltaY;
    applyPosition(nextLeft, nextTop);
  }

  function handlePointerUp(event) {
    if (!dragState.pending || dragState.pointerId !== event.pointerId) {
      return;
    }
    dom.button.releasePointerCapture?.(event.pointerId);
    if (dragState.dragging) {
      suppressNextClick = true;
      if (currentPosition) {
        savePosition(currentPosition.x, currentPosition.y);
      }
    }
    dragState.pointerId = null;
    dragState.pending = false;
    dragState.dragging = false;
    dom.container.classList.remove("chrome-stt-root--dragging");
  }

  function getViewportMetrics() {
    const viewport = window.visualViewport;
    return {
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight,
      offsetLeft: viewport?.offsetLeft ?? 0,
      offsetTop: viewport?.offsetTop ?? 0
    };
  }

  function getContainerRect() {
    const rect = dom.container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return rect;
    }
    const buttonRect = dom.button.getBoundingClientRect();
    if (buttonRect.width > 0 && buttonRect.height > 0) {
      return buttonRect;
    }
    return rect;
  }

  function clampToViewport(left, top, rect) {
    const viewport = getViewportMetrics();
    const minX = viewport.offsetLeft + POSITION_MARGIN;
    const minY = viewport.offsetTop + POSITION_MARGIN;
    const maxX = viewport.offsetLeft + viewport.width - rect.width - POSITION_MARGIN;
    const maxY = viewport.offsetTop + viewport.height - rect.height - POSITION_MARGIN;
    const boundedMaxX = Math.max(maxX, minX);
    const boundedMaxY = Math.max(maxY, minY);
    return {
      x: Math.min(Math.max(left, minX), boundedMaxX),
      y: Math.min(Math.max(top, minY), boundedMaxY)
    };
  }

  function applyPosition(left, top) {
    const rect = getContainerRect();
    let next = { x: left, y: top };
    if (rect.width > 0 && rect.height > 0) {
      next = clampToViewport(left, top, rect);
    }
    schedulePositionUpdate(next.x, next.y);
  }

  function schedulePositionUpdate(left, top) {
    pendingPosition = { x: left, y: top };
    if (positionRaf) {
      return;
    }
    positionRaf = requestAnimationFrame(() => {
      positionRaf = null;
      if (!pendingPosition) {
        return;
      }
      applyPositionStyles(pendingPosition.x, pendingPosition.y);
    });
  }

  function applyPositionStyles(left, top) {
    hasPositioned = true;
    currentPosition = { x: left, y: top };
    dom.container.classList.add("chrome-stt-root--positioned");
    dom.container.style.left = `${left}px`;
    dom.container.style.top = `${top}px`;
    dom.container.style.right = "auto";
    dom.container.style.bottom = "auto";
  }

  function ensurePositionInViewport() {
    if (!hasPositioned || !currentPosition) {
      return;
    }
    applyPosition(currentPosition.x, currentPosition.y);
  }

  function initStoredPosition() {
    if (!chrome.storage?.local) {
      return;
    }
    chrome.storage.local
      .get({ [UI_POSITIONS_KEY]: {} })
      .then((result) => {
        const positions = result[UI_POSITIONS_KEY] ?? {};
        const saved = positions[siteKey];
        if (!isValidPosition(saved)) {
          return;
        }
        applyPosition(saved.x, saved.y);
      })
      .catch(() => {
        // Ignore storage read errors.
      });
  }

  function savePosition(left, top) {
    if (!chrome.storage?.local) {
      return;
    }
    chrome.storage.local
      .get({ [UI_POSITIONS_KEY]: {} })
      .then((result) => {
        const positions = result[UI_POSITIONS_KEY] ?? {};
        positions[siteKey] = {
          x: left,
          y: top,
          updatedAt: Date.now()
        };
        return chrome.storage.local.set({ [UI_POSITIONS_KEY]: positions });
      })
      .catch(() => {
        // Ignore storage errors.
      });
  }

  function resetPosition() {
    suppressNextClick = false;
    hasPositioned = false;
    currentPosition = null;
    pendingPosition = null;
    if (positionRaf) {
      cancelAnimationFrame(positionRaf);
      positionRaf = null;
    }
    dom.container.classList.remove("chrome-stt-root--positioned");
    dom.container.classList.remove("chrome-stt-root--dragging");
    dom.container.style.left = "";
    dom.container.style.top = "";
    dom.container.style.right = "";
    dom.container.style.bottom = "";
    removeStoredPosition();
  }

  function removeStoredPosition() {
    if (!chrome.storage?.local) {
      return;
    }
    chrome.storage.local
      .get({ [UI_POSITIONS_KEY]: {} })
      .then((result) => {
        const positions = result[UI_POSITIONS_KEY] ?? {};
        if (positions[siteKey]) {
          delete positions[siteKey];
          return chrome.storage.local.set({ [UI_POSITIONS_KEY]: positions });
        }
        return undefined;
      })
      .catch(() => {
        // Ignore storage errors.
      });
  }
})();

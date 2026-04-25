/*
 * content script - hooks into chatgpt/claude/gemini to intercept sends.
 * anti-paste guard, cooldown timer, ghost reflection judge, context keeper.
 */

(function () {
  'use strict';

  if (window.__frictionModeLoaded) return;
  window.__frictionModeLoaded = true;

  const PLATFORM = (function detectPlatform() {
    const hostname = window.location.hostname;
    if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) return 'chatgpt';
    if (hostname.includes('claude.ai')) return 'claude';
    if (hostname.includes('gemini.google.com')) return 'gemini';
    return null;
  })();

  if (!PLATFORM) return;

  const DEFAULT_STATE = {
    enabled: true,
    cooldownThreshold: 150
  };

  const GHOST_STAGE_TITLES = [
    'Specify the core topic',
    'Provide the exact requirements',
    'Mention the tools, stack, or environment',
    'Share progress and the roadblock',
    'Define the desired answer format'
  ];

  const CONFIGS = {
    chatgpt: {
      color: '#10a37f',
      inputs: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
      submits: ['#composer-submit-button', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]']
    },
    claude: {
      color: '#d4a97c',
      inputs: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][aria-label]', 'div[contenteditable="true"]'],
      submits: ['button[aria-label="Send Message"]', 'button[aria-label="Send message"]', 'button[type="submit"]']
    },
    gemini: {
      color: '#4285f4',
      inputs: ['div.ql-editor[contenteditable="true"]', 'rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]'],
      submits: ['button[aria-label="Send message"]', 'button.send-button', 'button[jsname="Qx7uuf"]']
    }
  };

  const cfg = CONFIGS[PLATFORM];

  const CONTEXT_LIMITS = {
    chatgpt: 96000,
    claude: 150000,
    gemini: 750000
  };
  const CONTEXT_PLATFORM_LABELS = {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    gemini: 'Gemini'
  };
  const SESSION_WORDS_STORAGE_KEY = `frictionSessionWords:${PLATFORM}`;
  const CK_APPROACHING = 0.75;
  const CK_CRITICAL = 0.95;
  const CK_SCAN_DELAY = 5000;
  const ATTACH_SCAN_DELAY = 1500;
  const FLOATING_BADGES_STORAGE_KEY = 'frictionFloatingBadgePositions';
  const LEGACY_FLOATING_DOCK_STORAGE_KEY = 'frictionFloatingDockPosition';
  const FLOATING_BADGE_DEFAULTS = {
    'fm-word-badge': { left: 200, top: 14 },
    'fm-context-badge': { left: 200, top: 64 }
  };
  const FLOATING_BADGE_MARGIN = 8;

  let state = { ...DEFAULT_STATE };
  let blocking = false;
  let passingThrough = false;
  let attached = new WeakSet();
  let largePasteDetected = false;
  let lastPastedText = '';
  let cooldownActive = false;
  let cooldownTimerId = null;
  let sessionWordCount = 0;
  let attachScanTimer = null;
  let contextScanTimer = null;
  let floatingBadgesStorageLoaded = false;
  let floatingBadgePositions = { ...FLOATING_BADGE_DEFAULTS };
  let floatingBadgeUserMoved = {};
  let floatingBadgeSaveTimer = null;
  let floatingBadgeDrag = null;
  let suppressFloatingBadgeClick = {};
  let floatingBadgeResizeBound = false;
  let domObserver = null;

  loadState();
  loadSessionWords();
  listenForStateChanges();
  listenForSessionWordChanges();
  scan();
  domObserver = new MutationObserver(() => { scheduleAttachScan(); scheduleContextScan(); });
  domObserver.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(renderWordBadge, 800);
  setTimeout(() => { renderContextBadge(); scheduleContextScan(true); }, 900);

  function loadState() {
    try {
      chrome.storage.local.get('frictionState', ({ frictionState }) => {
        if (chrome.runtime.lastError) return;
        state = mergeState(frictionState);
        updateWordBadge();
        syncContextKeeperVisibility();
      });
    } catch (error) {}
  }

  function listenForStateChanges() {
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes.frictionState) {
          const wasEnabled = state.enabled;
          state = mergeState(changes.frictionState.newValue);
          updateWordBadge();
          syncContextKeeperVisibility();
          if (wasEnabled && !state.enabled) {
            shutdownAllFeatures();
          }
        }
        if (changes[SESSION_WORDS_STORAGE_KEY]) {
          sessionWordCount = changes[SESSION_WORDS_STORAGE_KEY].newValue || 0;
          updateWordBadge();
        }
      });
    } catch (error) {}
  }

  function loadSessionWords() {
    try {
      chrome.storage.local.get(SESSION_WORDS_STORAGE_KEY, (res) => {
        sessionWordCount = (res && res[SESSION_WORDS_STORAGE_KEY]) || 0;
        updateWordBadge();
      });
    } catch (error) {}
  }

  // leftover from earlier refactor - session word stuff is actually handled in listenForStateChanges now but keeping this so nothing breaks
  function listenForSessionWordChanges() {}

  function mergeState(nextState) {
    return {
      ...DEFAULT_STATE,
      ...(nextState || {})
    };
  }

  function initFloatingBadgeDrag(badge) {
    if (!badge || badge.dataset.fmDragBound === 'true') return;
    badge.dataset.fmDragBound = 'true';

    const id = badge.id;
    const fallback = FLOATING_BADGE_DEFAULTS[id] || { left: 200, top: 14 };
    applyFloatingBadgePosition(badge, fallback.left, fallback.top);
    loadFloatingBadgePositions();
    applyKnownFloatingBadgePosition(badge);

    if (!floatingBadgeResizeBound) {
      floatingBadgeResizeBound = true;
      window.addEventListener('resize', clampAllFloatingBadges);
    }

    badge.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;

      const rect = badge.getBoundingClientRect();
      floatingBadgeDrag = {
        id,
        element: badge,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        moved: false
      };

      try {
        badge.setPointerCapture(event.pointerId);
      } catch (error) {}
    });

    badge.addEventListener('pointermove', (event) => {
      if (!floatingBadgeDrag || floatingBadgeDrag.element !== badge || event.pointerId !== floatingBadgeDrag.pointerId) return;

      const dx = event.clientX - floatingBadgeDrag.startX;
      const dy = event.clientY - floatingBadgeDrag.startY;
      if (!floatingBadgeDrag.moved && Math.hypot(dx, dy) < 5) return;

      floatingBadgeDrag.moved = true;
      floatingBadgeUserMoved[id] = true;
      badge.classList.add('fm-dragging');
      event.preventDefault();

      const next = clampFloatingBadgePosition(
        floatingBadgeDrag.startLeft + dx,
        floatingBadgeDrag.startTop + dy,
        badge
      );
      applyFloatingBadgePosition(badge, next.left, next.top);
      positionContextDetails();
    });

    function finishDrag(event) {
      if (!floatingBadgeDrag || floatingBadgeDrag.element !== badge || event.pointerId !== floatingBadgeDrag.pointerId) return;

      const wasMoved = floatingBadgeDrag.moved;
      floatingBadgeDrag = null;
      badge.classList.remove('fm-dragging');

      try {
        if (badge.hasPointerCapture(event.pointerId)) badge.releasePointerCapture(event.pointerId);
      } catch (error) {}

      if (!wasMoved) return;

      floatingBadgeUserMoved[id] = true;
      suppressFloatingBadgeClick[id] = true;
      saveFloatingBadgePosition(id, badge);
      setTimeout(() => {
        delete suppressFloatingBadgeClick[id];
      }, 250);
    }

    badge.addEventListener('pointerup', finishDrag);
    badge.addEventListener('pointercancel', finishDrag);
  }

  function loadFloatingBadgePositions() {
    if (floatingBadgesStorageLoaded) return;
    floatingBadgesStorageLoaded = true;

    try {
      chrome.storage.local.get([FLOATING_BADGES_STORAGE_KEY, LEGACY_FLOATING_DOCK_STORAGE_KEY], (res) => {
        if (chrome.runtime.lastError) return;
        const saved = res && res[FLOATING_BADGES_STORAGE_KEY];
        const legacy = res && res[LEGACY_FLOATING_DOCK_STORAGE_KEY];

        if (saved && typeof saved === 'object') {
          Object.keys(FLOATING_BADGE_DEFAULTS).forEach((id) => {
            if (isValidFloatingBadgePosition(saved[id])) {
              floatingBadgePositions[id] = saved[id];
            }
          });
        } else if (isValidFloatingBadgePosition(legacy)) {
          floatingBadgePositions['fm-word-badge'] = { left: legacy.left, top: legacy.top };
          floatingBadgePositions['fm-context-badge'] = { left: legacy.left, top: legacy.top + 50 };
        }

        applyKnownFloatingBadgePositions();
        clampAllFloatingBadges();
      });
    } catch (error) {}
  }

  function isValidFloatingBadgePosition(position) {
    return position &&
      typeof position.left === 'number' &&
      typeof position.top === 'number' &&
      Number.isFinite(position.left) &&
      Number.isFinite(position.top);
  }

  function applyKnownFloatingBadgePositions() {
    Object.keys(FLOATING_BADGE_DEFAULTS).forEach((id) => {
      const badge = document.getElementById(id);
      if (badge && !floatingBadgeUserMoved[id]) applyKnownFloatingBadgePosition(badge);
    });
  }

  function applyKnownFloatingBadgePosition(badge) {
    const id = badge.id;
    const position = floatingBadgePositions[id] || FLOATING_BADGE_DEFAULTS[id];
    if (!position) return;
    applyFloatingBadgePosition(badge, position.left, position.top);
  }

  function applyFloatingBadgePosition(badge, left, top) {
    if (!badge) return;
    badge.style.setProperty('left', `${Math.round(left)}px`, 'important');
    badge.style.setProperty('top', `${Math.round(top)}px`, 'important');
    badge.style.setProperty('right', 'auto', 'important');
    badge.style.setProperty('bottom', 'auto', 'important');
  }

  function clampAllFloatingBadges() {
    Object.keys(FLOATING_BADGE_DEFAULTS).forEach((id) => {
      const badge = document.getElementById(id);
      if (!badge) return;
      const rect = badge.getBoundingClientRect();
      const next = clampFloatingBadgePosition(rect.left, rect.top, badge);
      applyFloatingBadgePosition(badge, next.left, next.top);
      floatingBadgePositions[id] = next;
    });
    positionContextDetails();
  }

  function clampFloatingBadgePosition(left, top, badge) {
    const width = Math.max(1, badge.offsetWidth || badge.getBoundingClientRect().width || 1);
    const height = Math.max(1, badge.offsetHeight || badge.getBoundingClientRect().height || 1);
    return {
      left: clampNumber(left, FLOATING_BADGE_MARGIN, Math.max(FLOATING_BADGE_MARGIN, window.innerWidth - width - FLOATING_BADGE_MARGIN)),
      top: clampNumber(top, FLOATING_BADGE_MARGIN, Math.max(FLOATING_BADGE_MARGIN, window.innerHeight - height - FLOATING_BADGE_MARGIN))
    };
  }

  function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function saveFloatingBadgePosition(id, badge) {
    if (!badge) return;

    const rect = badge.getBoundingClientRect();
    floatingBadgePositions[id] = {
      left: Math.round(rect.left),
      top: Math.round(rect.top)
    };

    if (floatingBadgeSaveTimer) clearTimeout(floatingBadgeSaveTimer);
    floatingBadgeSaveTimer = setTimeout(() => {
      floatingBadgeSaveTimer = null;
      try {
        chrome.storage.local.set({ [FLOATING_BADGES_STORAGE_KEY]: floatingBadgePositions });
      } catch (error) {}
    }, 120);
  }

  function consumeFloatingBadgeClick(id) {
    if (!suppressFloatingBadgeClick[id]) return false;
    delete suppressFloatingBadgeClick[id];
    return true;
  }

  // Prompt DNA tracker - counts vague words, missing context, etc so the popup can render the radar chart
  const DNA_STORAGE_KEY = 'frictionDNA';
  const DNA_VERSION = 1;
  const VAGUE_VERB_REGEX = /\b(help|make|do|fix|improve|better|nice|good|stuff|thing|something|anything)\b/i;

  const DNA = (function createDna() {
    let cache = null;
    let loaded = false;
    let pendingWrite = null;

    function today() {
      return new Date().toISOString().slice(0, 10);
    }

    function emptyData() {
      const d = today();
      return {
        version: DNA_VERSION,
        firstUseDate: d,
        totals: {
          promptsSeen: 0,
          submissions: 0,
          edits: 0,
          wordsBefore: 0,
          wordsAfter: 0,
          missingWho: 0,
          missingWhat: 0,
          missingWhy: 0,
          vagueVerbs: 0,
          antiPasteTriggers: 0,
          cooldownTriggers: 0,
          aiVersionsChosen: 0
        },
        daily: {}
      };
    }

    function ensureLoaded(cb) {
      if (loaded) { cb(); return; }
      try {
        chrome.storage.local.get(DNA_STORAGE_KEY, (res) => {
          cache = normalize(res && res[DNA_STORAGE_KEY]);
          loaded = true;
          cb();
        });
      } catch (error) {
        cache = emptyData();
        loaded = true;
        cb();
      }
    }

    function normalize(raw) {
      if (!raw || typeof raw !== 'object' || raw.version !== DNA_VERSION) {
        return emptyData();
      }
      const base = emptyData();
      return {
        version: DNA_VERSION,
        firstUseDate: raw.firstUseDate || base.firstUseDate,
        totals: { ...base.totals, ...(raw.totals || {}) },
        daily: raw.daily && typeof raw.daily === 'object' ? raw.daily : {}
      };
    }

    function bumpDaily(key) {
      const d = today();
      if (!cache.daily[d]) cache.daily[d] = { prompts: 0, edits: 0, cooldowns: 0, antiPaste: 0 };
      if (key) cache.daily[d][key] = (cache.daily[d][key] || 0) + 1;
    }

    function scheduleWrite() {
      if (pendingWrite) return;
      pendingWrite = setTimeout(() => {
        pendingWrite = null;
        try {
          chrome.storage.local.set({ [DNA_STORAGE_KEY]: cache });
        } catch (error) {}
      }, 150);
    }

    function update(mutator) {
      ensureLoaded(() => {
        mutator(cache);
        scheduleWrite();
      });
    }

    function recordPromptSeen(text) {
      const t = (text || '').trim();
      if (!t) return;
      const words = countWords(t);
      const missing = detectClientMissingContext(t);
      const hasVague = VAGUE_VERB_REGEX.test(t) && words < 25;

      update((c) => {
        c.totals.promptsSeen += 1;
        c.totals.wordsBefore += words;
        if (missing.includes('Who')) c.totals.missingWho += 1;
        if (missing.includes('What')) c.totals.missingWhat += 1;
        if (missing.includes('Why')) c.totals.missingWhy += 1;
        if (hasVague) c.totals.vagueVerbs += 1;
        bumpDaily('prompts');
      });
    }

    function recordCooldown() {
      update((c) => {
        c.totals.cooldownTriggers += 1;
        bumpDaily('cooldowns');
      });
    }

    function recordAntiPaste() {
      update((c) => {
        c.totals.antiPasteTriggers += 1;
        bumpDaily('antiPaste');
      });
    }

    function recordSubmission(originalText, editedText) {
      const o = (originalText || '').trim();
      const e = (editedText || o).trim();
      const editedWords = countWords(e);
      const wasEdited = !!o && e !== o;

      update((c) => {
        c.totals.submissions += 1;
        c.totals.wordsAfter += editedWords;
        if (wasEdited) {
          c.totals.edits += 1;
          bumpDaily('edits');
        }
      });
    }

    function recordAiVersionChosen() {
      update((c) => {
        c.totals.aiVersionsChosen += 1;
      });
    }

    // preload cache or the first prompt races storage and we lose stats
    ensureLoaded(() => {});

    // sync cache when popup hits reset or another tab mutates DNA
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes[DNA_STORAGE_KEY]) return;
        if (pendingWrite) return; // our own write bounced back, skip it
        cache = normalize(changes[DNA_STORAGE_KEY].newValue);
        loaded = true;
      });
    } catch (error) {}

    return {
      recordPromptSeen,
      recordCooldown,
      recordAntiPaste,
      recordSubmission,
      recordAiVersionChosen
    };
  })();

  // Context Keeper - tracks how much of the AI's context window we've burned through
  let ckDismissedApproaching = false;
  let ckDismissedCritical = false;
  let ckScannedResponses = new WeakSet();
  let ckLastStats = {
    words: 0,
    limit: CONTEXT_LIMITS[PLATFORM] || 1,
    ratio: 0,
    updatedAt: 0
  };
  let ckDetailsHideTimer = null;

  function scheduleAttachScan() {
    if (attachScanTimer) return;
    attachScanTimer = setTimeout(() => {
      attachScanTimer = null;
      scan();
    }, ATTACH_SCAN_DELAY);
  }

  function scheduleContextScan(force) {
    if (!state.enabled) return;
    if (force && contextScanTimer) {
      clearTimeout(contextScanTimer);
      contextScanTimer = null;
    }
    if (contextScanTimer) return;
    contextScanTimer = setTimeout(() => {
      runWhenIdle(() => {
        contextScanTimer = null;
        contextScan();
      });
    }, force ? 0 : CK_SCAN_DELAY);
  }

  function runWhenIdle(callback) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(callback, { timeout: 1200 });
      return;
    }
    callback();
  }

  function contextScan() {
    if (!PLATFORM || !state.enabled) return;
    const limit = CONTEXT_LIMITS[PLATFORM];
    if (!limit) return;
    const words = countThreadWords();
    const ratio = words / limit;
    updateContextBadge(words, limit, ratio);
    checkContextBanners(ratio, words, limit);
    if (ratio >= CK_CRITICAL) scanForContextLoss();
  }

  function countThreadWords() {
    let text = '';
    const inputs = pick(cfg.inputs);
    if (PLATFORM === 'chatgpt') {
      document.querySelectorAll('[data-message-author-role]').forEach((turn) => {
        if (isInputDescendant(turn, inputs)) return;
        text += ' ' + (turn.textContent || '');
      });
    } else if (PLATFORM === 'claude') {
      document.querySelectorAll('.message, [class*="message_"]').forEach((msg) => {
        if (isInputDescendant(msg, inputs)) return;
        text += ' ' + (msg.textContent || '');
      });
    } else if (PLATFORM === 'gemini') {
      document.querySelectorAll('.conversation-turn, [data-testid="turn"]').forEach((turn) => {
        if (isInputDescendant(turn, inputs)) return;
        text += ' ' + (turn.textContent || '');
      });
    }
    return countWords(text);
  }

  function isInputDescendant(el, cachedInputs) {
    const inputs = cachedInputs || pick(cfg.inputs);
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (input && (el === input || input.contains(el) || el.contains(input))) return true;
    }
    return false;
  }

  function renderContextBadge() {
    if (!state.enabled) return;
    if (document.getElementById('fm-context-badge')) {
      renderContextDetails();
      return;
    }
    const badge = document.createElement('div');
    badge.id = 'fm-context-badge';
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    badge.setAttribute('aria-controls', 'fm-context-details');
    badge.setAttribute('aria-expanded', 'false');
    badge.setAttribute('aria-label', 'Show context window details');
    badge.innerHTML =
      '<span class="fm-cb-icon">&#128203;</span>' +
      '<span class="fm-cb-bar-wrap"><span class="fm-cb-bar" id="fm-cb-bar"></span></span>' +
      '<span class="fm-cb-pct" id="fm-cb-pct">0%</span>';
    document.body.appendChild(badge);
    initFloatingBadgeDrag(badge);
    renderContextDetails();
    badge.addEventListener('click', (event) => {
      if (consumeFloatingBadgeClick('fm-context-badge')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
      toggleContextDetails();
    });
    badge.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideContextDetails();
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      toggleContextDetails();
    });
    document.addEventListener('click', (event) => {
      const panel = document.getElementById('fm-context-details');
      if (!panel || panel.hidden) return;
      if (badge.contains(event.target) || panel.contains(event.target)) return;
      hideContextDetails();
    }, true);
    updateContextBadge(0, CONTEXT_LIMITS[PLATFORM] || 1, 0);
  }

  function updateContextBadge(words, limit, ratio) {
    const badge = document.getElementById('fm-context-badge');
    if (!badge) return;
    ckLastStats = {
      words: Math.max(0, Math.round(words || 0)),
      limit: Math.max(1, Math.round(limit || 1)),
      ratio: Number.isFinite(ratio) ? Math.max(0, ratio) : 0,
      updatedAt: Date.now()
    };
    if (!state.enabled) {
      badge.style.display = 'none';
      hideContextDetails();
      return;
    }
    badge.style.display = 'flex';
    const bar = badge.querySelector('#fm-cb-bar');
    const pct = badge.querySelector('#fm-cb-pct');
    const safeRatio = Math.min(ckLastStats.ratio, 1);
    if (bar) bar.style.width = `${safeRatio * 100}%`;
    if (pct) pct.textContent = `${Math.round(safeRatio * 100)}%`;
    badge.classList.remove('fm-cb-low', 'fm-cb-mid', 'fm-cb-high', 'fm-cb-full');
    if (ckLastStats.ratio >= 1) {
      badge.classList.add('fm-cb-full');
    } else if (ckLastStats.ratio >= CK_CRITICAL) {
      badge.classList.add('fm-cb-high');
    } else if (ckLastStats.ratio >= CK_APPROACHING) {
      badge.classList.add('fm-cb-mid');
    } else {
      badge.classList.add('fm-cb-low');
    }
    badge.title = `Approx. ${Math.round(ckLastStats.ratio * 100)}% of context window used (~${ckLastStats.words.toLocaleString()} / ~${ckLastStats.limit.toLocaleString()} words)`;
    updateContextDetails();
  }

  function renderContextDetails() {
    let panel = document.getElementById('fm-context-details');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'fm-context-details';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Context window details');
    document.body.appendChild(panel);
    updateContextDetails();
    return panel;
  }

  function toggleContextDetails() {
    const panel = renderContextDetails();
    if (panel && !panel.hidden && panel.classList.contains('fm-cd-visible')) {
      hideContextDetails();
      return;
    }
    showContextDetails();
  }

  function showContextDetails() {
    if (!state.enabled) return;
    const panel = renderContextDetails();
    const limit = CONTEXT_LIMITS[PLATFORM] || 1;
    const words = countThreadWords();

    updateContextBadge(words, limit, words / limit);

    if (ckDetailsHideTimer) {
      clearTimeout(ckDetailsHideTimer);
      ckDetailsHideTimer = null;
    }

    panel.hidden = false;
    positionContextDetails();
    requestAnimationFrame(() => panel.classList.add('fm-cd-visible'));

    const badge = document.getElementById('fm-context-badge');
    if (badge) {
      badge.classList.add('fm-cb-open');
      badge.setAttribute('aria-expanded', 'true');
    }
  }

  function hideContextDetails() {
    const panel = document.getElementById('fm-context-details');
    const badge = document.getElementById('fm-context-badge');

    if (badge) {
      badge.classList.remove('fm-cb-open');
      badge.setAttribute('aria-expanded', 'false');
    }

    if (!panel || panel.hidden) return;
    panel.classList.remove('fm-cd-visible');
    if (ckDetailsHideTimer) clearTimeout(ckDetailsHideTimer);
    ckDetailsHideTimer = setTimeout(() => {
      if (!panel.classList.contains('fm-cd-visible')) panel.hidden = true;
      ckDetailsHideTimer = null;
    }, 160);
  }

  function updateContextDetails() {
    const panel = document.getElementById('fm-context-details');
    if (!panel || panel.hidden) return;

    const status = getContextStatus(ckLastStats.ratio);
    const remaining = Math.max(0, ckLastStats.limit - ckLastStats.words);
    const overflow = Math.max(0, ckLastStats.words - ckLastStats.limit);
    const estimatedTokens = estimateTokensFromWords(ckLastStats.words);
    const estimatedRemainingTokens = estimateTokensFromWords(remaining);
    const nextMilestone = getNextContextMilestone(ckLastStats.words, ckLastStats.limit, ckLastStats.ratio, remaining, overflow);
    const usedWidth = Math.min(ckLastStats.ratio, 1) * 100;

    panel.classList.remove('fm-cd-low', 'fm-cd-mid', 'fm-cd-high', 'fm-cd-full');
    panel.classList.add(`fm-cd-${status.tone}`);
    panel.innerHTML =
      '<div class="fm-cd-header">' +
        '<div>' +
          '<div class="fm-cd-kicker">Context Keeper</div>' +
          '<div class="fm-cd-title">' + esc(CONTEXT_PLATFORM_LABELS[PLATFORM] || PLATFORM || 'Current chat') + '</div>' +
        '</div>' +
        '<button class="fm-cd-close" type="button" aria-label="Close context details">&#215;</button>' +
      '</div>' +
      '<div class="fm-cd-meter">' +
        '<div class="fm-cd-meter-meta">' +
          '<span>Used</span>' +
          '<strong>' + esc(formatContextPercent(ckLastStats.ratio)) + '</strong>' +
        '</div>' +
        '<div class="fm-cd-meter-track"><span class="fm-cd-meter-fill" style="width:' + usedWidth + '%"></span></div>' +
      '</div>' +
      '<div class="fm-cd-grid">' +
        '<div class="fm-cd-tile"><span>Thread words</span><strong>' + formatContextNumber(ckLastStats.words) + '</strong></div>' +
        '<div class="fm-cd-tile"><span>Est. tokens</span><strong>' + formatContextNumber(estimatedTokens) + '</strong></div>' +
        '<div class="fm-cd-tile"><span>Context limit</span><strong>' + formatContextNumber(ckLastStats.limit) + '</strong></div>' +
        '<div class="fm-cd-tile"><span>Remaining</span><strong>' + formatContextNumber(remaining) + '</strong></div>' +
        '<div class="fm-cd-tile"><span>Est. tokens left</span><strong>' + formatContextNumber(estimatedRemainingTokens) + '</strong></div>' +
        '<div class="fm-cd-tile"><span>Status</span><strong class="fm-cd-status">' + esc(status.label) + '</strong></div>' +
      '</div>' +
      '<div class="fm-cd-rows">' +
        '<div class="fm-cd-row"><span>Next alert</span><strong>' + esc(nextMilestone) + '</strong></div>' +
        '<div class="fm-cd-row"><span>75% warning</span><strong>' + formatContextNumber(Math.round(ckLastStats.limit * CK_APPROACHING)) + ' words</strong></div>' +
        '<div class="fm-cd-row"><span>95% critical</span><strong>' + formatContextNumber(Math.round(ckLastStats.limit * CK_CRITICAL)) + ' words</strong></div>' +
        '<div class="fm-cd-row"><span>Last scan</span><strong>' + esc(formatContextUpdatedAt(ckLastStats.updatedAt)) + '</strong></div>' +
      '</div>' +
      '<div class="fm-cd-note">' + esc(status.detail) + '</div>';

    const closeBtn = panel.querySelector('.fm-cd-close');
    if (closeBtn) closeBtn.addEventListener('click', hideContextDetails);
    positionContextDetails();
  }

  function positionContextDetails() {
    const panel = document.getElementById('fm-context-details');
    if (!panel || panel.hidden) return;

    const anchor = document.getElementById('fm-context-badge');
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const width = Math.min(330, Math.max(240, window.innerWidth - 28));
    panel.style.width = `${width}px`;

    const height = panel.offsetHeight || 0;
    const left = clampNumber(rect.left, 14, Math.max(14, window.innerWidth - width - 14));
    let top = rect.bottom + 8;

    if (height && top + height > window.innerHeight - 14) {
      top = Math.max(14, rect.top - height - 8);
    }

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function getContextStatus(ratio) {
    if (ratio >= 1) {
      return { label: 'Full', tone: 'full', detail: 'Estimated context limit reached. Compress the thread before continuing.' };
    }
    if (ratio >= CK_CRITICAL) {
      return { label: 'Critical', tone: 'high', detail: 'Very little context remains. Compress or restart soon.' };
    }
    if (ratio >= CK_APPROACHING) {
      return { label: 'Approaching', tone: 'mid', detail: 'Context is getting tight. Prepare a summary before the chat gets much longer.' };
    }
    return { label: 'Healthy', tone: 'low', detail: 'Plenty of estimated context remains for this thread.' };
  }

  function getNextContextMilestone(words, limit, ratio, remaining, overflow) {
    if (ratio < CK_APPROACHING) {
      return `${formatContextNumber(Math.max(0, Math.ceil(limit * CK_APPROACHING - words)))} words until 75%`;
    }
    if (ratio < CK_CRITICAL) {
      return `${formatContextNumber(Math.max(0, Math.ceil(limit * CK_CRITICAL - words)))} words until 95%`;
    }
    if (ratio < 1) {
      return `${formatContextNumber(remaining)} words until full`;
    }
    return `${formatContextNumber(overflow)} words over limit`;
  }

  function formatContextNumber(value) {
    return Math.max(0, Math.round(value || 0)).toLocaleString();
  }

  function estimateTokensFromWords(words) {
    return Math.round(Math.max(0, words || 0) / 0.75);
  }

  function formatContextPercent(ratio) {
    const percent = Math.max(0, ratio || 0) * 100;
    if (percent > 0 && percent < 0.1) return '<0.1%';
    return `${percent.toFixed(1)}%`;
  }

  function formatContextUpdatedAt(timestamp) {
    if (!timestamp) return 'Not scanned yet';
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 3) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.round(seconds / 60)}m ago`;
  }

  function syncContextKeeperVisibility() {
    const badge = document.getElementById('fm-context-badge');
    if (!state.enabled) {
      if (badge) badge.style.display = 'none';
      hideContextDetails();
      removeContextBanners();
      return;
    }
    renderContextBadge();
    scheduleContextScan(true);
  }

  function checkContextBanners(ratio, words, limit) {
    if (ratio >= CK_CRITICAL && !ckDismissedCritical) {
      showCriticalBanner(words, limit);
    } else if (ratio >= CK_APPROACHING && !ckDismissedApproaching && !ckDismissedCritical) {
      showApproachingBanner(words, limit);
    }
  }

  function showApproachingBanner(words, limit) {
    const current = document.getElementById('fm-context-banner');
    if (current && current.classList.contains('fm-approach-banner')) return;
    removeContextBanners();
    const banner = document.createElement('div');
    banner.id = 'fm-context-banner';
    banner.className = 'fm-approach-banner';
    banner.innerHTML =
      '<div class="fm-cb-banner-inner">' +
        '<div class="fm-cb-banner-text">This thread is ~' + Math.round((words / limit) * 100) + '% full. Context may soon be lost.</div>' +
        '<div class="fm-cb-banner-actions">' +
          '<button class="fm-cb-btn fm-cb-btn-primary" id="fm-ck-summarize">Summarize past turns</button>' +
          '<button class="fm-cb-btn fm-cb-btn-secondary" id="fm-ck-model">Switch to lower-cost model</button>' +
          '<button class="fm-cb-btn fm-cb-btn-ghost" id="fm-ck-dismiss">Dismiss for this chat</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => banner.classList.add('fm-cb-visible'));
    });
    banner.querySelector('#fm-ck-summarize').addEventListener('click', () => {
      injectCompressionPrompt('standard');
      removeContextBanners();
    });
    banner.querySelector('#fm-ck-model').addEventListener('click', () => {
      const lastPrompt = getText();
      const note = 'For long tasks, try a model with a larger context window or split into multiple chats.';
      navigator.clipboard.writeText((lastPrompt ? lastPrompt + '\n\n' : '') + note).catch(() => {});
      removeContextBanners();
    });
    banner.querySelector('#fm-ck-dismiss').addEventListener('click', () => {
      ckDismissedApproaching = true;
      removeContextBanners();
    });
  }

  function showCriticalBanner(words, limit) {
    const current = document.getElementById('fm-context-banner');
    if (current && current.classList.contains('fm-critical-banner')) return;
    removeContextBanners();
    const banner = document.createElement('div');
    banner.id = 'fm-context-banner';
    banner.className = 'fm-critical-banner';
    banner.innerHTML =
      '<div class="fm-cb-banner-inner">' +
        '<div class="fm-cb-banner-text">Context window is nearly full. The model may have already lost earlier turns.</div>' +
        '<div class="fm-cb-banner-actions">' +
          '<button class="fm-cb-btn fm-cb-btn-primary" id="fm-ck-compress">Compress & restart</button>' +
          '<button class="fm-cb-btn fm-cb-btn-secondary" id="fm-ck-newchat">Start new chat</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => banner.classList.add('fm-cb-visible'));
    });
    banner.querySelector('#fm-ck-compress').addEventListener('click', () => {
      injectCompressionPrompt('urgent');
      removeContextBanners();
    });
    banner.querySelector('#fm-ck-newchat').addEventListener('click', () => {
      triggerNewChat();
      removeContextBanners();
    });
  }

  function removeContextBanners() {
    const banner = document.getElementById('fm-context-banner');
    if (!banner) return;
    banner.classList.remove('fm-cb-visible');
    setTimeout(() => {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    }, 250);
  }

  function injectCompressionPrompt(variant) {
    const prompt = variant === 'urgent'
      ? 'We are near the context limit. Before we continue, summarize everything critical from our conversation so far into a single compact paragraph so we can continue without losing context.'
      : 'Summarize the key facts, decisions, and code blocks from our conversation so far into a single compact paragraph so we can continue without losing context.';
    setInputText(prompt);
    const input = pick(cfg.inputs)[0];
    if (input) input.focus();
  }

  function triggerNewChat() {
    if (PLATFORM === 'chatgpt') {
      const btn = document.querySelector('button[aria-label="New chat"]') || document.querySelector('[data-testid="create-new-chat-button"]');
      if (btn) btn.click();
    } else if (PLATFORM === 'claude') {
      const btn = document.querySelector('button[aria-label="New chat"]') || document.querySelector('[aria-label="Start new chat"]');
      if (btn) btn.click();
    } else if (PLATFORM === 'gemini') {
      const btn = document.querySelector('button[aria-label="New chat"]') || document.querySelector('.new-chat-button');
      if (btn) btn.click();
    }
  }

  function scanForContextLoss() {
    if (!PLATFORM || !state.enabled) return;
    const responses = getAssistantResponses();
    responses.forEach((el) => {
      if (ckScannedResponses.has(el)) return;
      ckScannedResponses.add(el);
      const text = (el.textContent || '').trim();
      if (!text) return;
      if (detectContextLossInResponse(text)) {
        injectContextLossNotice(el);
      }
    });
  }

  function getAssistantResponses() {
    if (PLATFORM === 'chatgpt') {
      return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    } else if (PLATFORM === 'claude') {
      return Array.from(document.querySelectorAll('.message, [class*="message_"]')).filter((el) => {
        if (isInputDescendant(el)) return false;
        const txt = (el.textContent || '').trim();
        return txt.length > 50 && !/^(Hi|Hello|Hey)/i.test(txt);
      });
    } else if (PLATFORM === 'gemini') {
      return Array.from(document.querySelectorAll('.conversation-turn, [data-testid="turn"]')).filter((el) => {
        return el.querySelector('model-response') || el.querySelector('[data-testid="model-response"]');
      });
    }
    return [];
  }

  function detectContextLossInResponse(text) {
    const patterns = [
      /I (no longer|don't) (see|have) (earlier|previous|prior)/i,
      /I can only see the last/i,
      /the conversation is too long/i,
      /context (window|limit) (is|has been) (reached|exhausted|full)/i,
      /I (don't|do not) (remember|recall) (earlier|previous|prior)/i,
      /my context (is|was) (truncated|cut off|limited)/i
    ];
    return patterns.some((re) => re.test(text));
  }

  function injectContextLossNotice(targetEl) {
    if (targetEl.nextElementSibling && targetEl.nextElementSibling.classList.contains('fm-context-loss-inline')) return;
    const summary = generateRecoverySummary();
    const notice = document.createElement('div');
    notice.className = 'fm-context-loss-inline';
    notice.innerHTML =
      '<div class="fm-cl-icon">&#9888;</div>' +
      '<div class="fm-cl-body">' +
        '<div class="fm-cl-title">This response suggests the model lost earlier context.</div>' +
        '<button class="fm-cl-btn" id="fm-cl-copy">Copy recovery prompt</button>' +
      '</div>';
    targetEl.parentNode.insertBefore(notice, targetEl.nextSibling);
    notice.querySelector('#fm-cl-copy').addEventListener('click', () => {
      const recovery = 'Here is what we established so far:\n\n' + summary;
      navigator.clipboard.writeText(recovery).catch(() => {});
      const btn = notice.querySelector('#fm-cl-copy');
      if (btn) btn.textContent = 'Copied!';
      setTimeout(() => { if (btn) btn.textContent = 'Copy recovery prompt'; }, 2000);
    });
  }

  function generateRecoverySummary() {
    let userTexts = [];
    let assistantTexts = [];
    const inputs = pick(cfg.inputs);
    if (PLATFORM === 'chatgpt') {
      document.querySelectorAll('[data-message-author-role]').forEach((turn) => {
        if (isInputDescendant(turn, inputs)) return;
        const role = turn.getAttribute('data-message-author-role');
        const text = (turn.textContent || '').trim();
        if (!text) return;
        if (role === 'user') userTexts.push(text);
        else if (role === 'assistant') assistantTexts.push(text);
      });
    } else if (PLATFORM === 'claude') {
      document.querySelectorAll('.message, [class*="message_"]').forEach((msg, idx) => {
        if (isInputDescendant(msg, inputs)) return;
        const text = (msg.textContent || '').trim();
        if (!text) return;
        if (idx % 2 === 0) userTexts.push(text);
        else assistantTexts.push(text);
      });
    } else if (PLATFORM === 'gemini') {
      document.querySelectorAll('.conversation-turn, [data-testid="turn"]').forEach((turn) => {
        if (isInputDescendant(turn, inputs)) return;
        const text = (turn.textContent || '').trim();
        if (!text) return;
        const isAssistant = turn.querySelector('model-response') || turn.querySelector('[data-testid="model-response"]');
        if (isAssistant) assistantTexts.push(text);
        else userTexts.push(text);
      });
    }
    const firstUser = userTexts.slice(0, 3).join('\n\n');
    const lastAssistant = assistantTexts.slice(-3).join('\n\n');
    let summary = firstUser;
    if (lastAssistant) summary += '\n\n...\n\n' + lastAssistant;
    const words = (summary || '').split(/\s+/);
    if (words.length > 500) {
      summary = words.slice(0, 500).join(' ') + '... [truncated]';
    }
    return summary;
  }

  function scan() {
    pick(cfg.inputs).forEach((el) => {
      if (attached.has(el)) return;
      attached.add(el);
      el.addEventListener('keydown', onKeyDown, true);
      el.addEventListener('paste', onPaste, true);
    });

    pick(cfg.submits).forEach((btn) => {
      if (attached.has(btn)) return;
      attached.add(btn);
      btn.addEventListener('click', onSubmit, true);
    });
  }

  function onPaste(event) {
    if (!state.enabled) return;

    const pastedText = (event.clipboardData || window.clipboardData).getData('text');
    if (pastedText && pastedText.length > 300) {
      largePasteDetected = true;
      lastPastedText = pastedText;
    }
  }

  function onKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    tryBlock(event);
  }

  function onSubmit(event) {
    tryBlock(event);
  }

  function tryBlock(event) {
    if (passingThrough) {
      passingThrough = false;
      return;
    }

    if (blocking || !state.enabled) return;

    const text = getText();
    if (!text || text.length < 2) return;

    if (cooldownActive) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const threshold = state.cooldownThreshold || 150;

    DNA.recordPromptSeen(text);

    if (sessionWordCount >= threshold) {
      DNA.recordCooldown();
      blocking = true;
      showCooldownOverlay(text, sessionWordCount, threshold);
      return;
    }

    const flow = evaluate(text);
    if (!flow.block) return;

    if (flow.type === 'ANTI_PASTE') DNA.recordAntiPaste();

    blocking = true;
    showOverlay(flow, text);
  }

  function saveSessionWordCount(count) {
    sessionWordCount = Math.max(0, count);
    try {
      chrome.storage.local.set({ [SESSION_WORDS_STORAGE_KEY]: sessionWordCount });
    } catch (error) {}
    updateWordBadge();
  }

  function addSessionWords(wordCount) {
    saveSessionWordCount(sessionWordCount + wordCount);
  }

  function renderWordBadge() {
    if (document.getElementById('fm-word-badge')) return;
    if (!state.enabled) return;

    const badge = document.createElement('div');
    badge.id = 'fm-word-badge';
    badge.innerHTML =
      '<span class="fm-wb-icon">&#9889;</span>' +
      '<span class="fm-wb-count" id="fm-wb-count">0</span>' +
      '<span class="fm-wb-sep">/</span>' +
      '<span class="fm-wb-max" id="fm-wb-max">150</span>' +
      '<span class="fm-wb-label">words</span>';
    document.body.appendChild(badge);
    initFloatingBadgeDrag(badge);
    updateWordBadge();
  }

  function updateWordBadge() {
    const badge = document.getElementById('fm-word-badge');
    if (!badge) return;

    if (!state.enabled) {
      badge.style.display = 'none';
      return;
    }

    badge.style.display = 'flex';

    const countEl = badge.querySelector('#fm-wb-count');
    const maxEl = badge.querySelector('#fm-wb-max');
    const threshold = state.cooldownThreshold || 150;

    if (countEl) countEl.textContent = sessionWordCount;
    if (maxEl) maxEl.textContent = threshold;
    badge.title = `${CONTEXT_PLATFORM_LABELS[PLATFORM] || PLATFORM} session words: ${sessionWordCount.toLocaleString()} / ${threshold.toLocaleString()}`;

    const ratio = threshold > 0 ? sessionWordCount / threshold : 0;

    badge.classList.remove('fm-wb-low', 'fm-wb-mid', 'fm-wb-high', 'fm-wb-full');

    if (ratio >= 1) {
      badge.classList.add('fm-wb-full');
    } else if (ratio >= 0.7) {
      badge.classList.add('fm-wb-high');
    } else if (ratio >= 0.4) {
      badge.classList.add('fm-wb-mid');
    } else {
      badge.classList.add('fm-wb-low');
    }
  }

  function evaluate(text) {
    if (shouldTriggerAntiPaste(text)) {
      return {
        block: true,
        type: 'ANTI_PASTE',
        icon: '&#9940;',
        title: 'Analyzing pasted content...',
        message: 'Determining whether this is code or text to give you the best guidance.',
        primaryHtml: 'Summarize & Submit &rarr;',
        editableText: '',
        placeholder: 'Summarize the pasted content and the outcome you want...',
        allowSkip: false,
        isLoading: false
      };
    }

    return {
      block: true,
      type: 'GHOST_REFLECTION',
      icon: '&#129504;',
      title: 'Running AI 5-Verdict Judge',
      message: 'The Oracle is sending your prompt to AI and collecting 5 verdicts that can help you improve it.',
      primaryHtml: 'Apply & Next &rarr;',
      editableText: text,
      placeholder: 'Tighten your prompt while the judge works...',
      allowSkip: true,
      isLoading: true
    };
  }

  function shouldTriggerAntiPaste(text) {
    if (!largePasteDetected || !lastPastedText) return false;

    const normalizedText = normalizeForMatch(text);
    const normalizedPaste = normalizeForMatch(lastPastedText);

    if (!normalizedText || !normalizedPaste) return false;
    if (normalizedText.length < 80) return false;

    return normalizedText.includes(normalizedPaste.slice(0, Math.min(80, normalizedPaste.length)));
  }

  function detectClientMissingContext(promptText) {
    const text = (promptText || '').trim();
    const words = countWords(text);
    const missing = [];

    const hasAudience = /\b(audience|persona|target user|reader|customer|client|stakeholder|manager|developer|designer|student|beginner|expert|team|for (?:a|an|the|my|our)\b|as a\b)\b/i.test(text);
    const hasGoal = /\b(goal|outcome|success|need|needs|want|wants|trying to|so that|in order to|because|purpose|objective)\b/i.test(text);
    const hasWhat = words >= 5 && /\b(app|site|website|feature|bug|code|script|prompt|article|email|plan|analysis|design|strategy|dashboard|copy|report|video|lesson|outline|post|point|difference|comparison)\b/i.test(text);

    if (!hasAudience) missing.push('Who');
    if (!hasWhat) missing.push('What');
    if (!hasGoal) missing.push('Why');

    return missing;
  }

  function inspectClientPrompt(promptText) {
    const text = (promptText || '').trim();
    const words = countWords(text);

    return {
      text,
      words,
      preview: text.length > 70 ? `${text.slice(0, 67)}...` : text,
      hasFormat: /\b(table|bullet|bullets|list|json|step-by-step|steps|code|summary|format)\b/i.test(text),
      hasConstraint: /\b(exactly|under|at least|tone|style|formal|casual|concise|detailed|must|avoid)\b/i.test(text),
      hasExample: /\b(example|examples|sample|samples|for instance)\b/i.test(text),
      hasReference: /\b(using|based on|from|according to|reference|context|background|stack|language|framework)\b/i.test(text),
      looksLikeQuestion: /\?$/.test(text) && words <= 12
    };
  }

  function buildClientStages(promptText, missingContext) {
    const signals = inspectClientPrompt(promptText);
    const preview = signals.preview || 'this prompt';

    return [
      {
        stage: GHOST_STAGE_TITLES[0],
        verdict: missingContext.includes('What')
          ? `State exactly which part of "${preview}" you need help with so the AI knows the real topic.`
          : signals.words < 10 || signals.looksLikeQuestion
            ? 'Narrow the prompt down to one specific task, deliverable, or concept instead of leaving it broad.'
            : 'Tighten the main topic so the AI cannot misread what you actually want.'
      },
      {
        stage: GHOST_STAGE_TITLES[1],
        verdict: missingContext.includes('Who')
          ? 'Paste the assignment instructions, constraints, or success criteria so the AI can target the real requirement.'
          : 'Add the exact requirements, constraints, or grading expectations that the answer must satisfy.'
      },
      {
        stage: GHOST_STAGE_TITLES[2],
        verdict: missingContext.includes('Why')
          ? 'Tell the AI what tools, platform, language, or environment this work belongs to so the answer fits your setup.'
          : 'Mention the relevant tools, language, platform, or environment so the answer becomes more concrete.'
      },
      {
        stage: GHOST_STAGE_TITLES[3],
        verdict: !signals.hasReference && !signals.hasConstraint
          ? 'Explain what you already tried and where you are stuck so the AI can help with the real roadblock.'
          : !signals.hasExample
            ? 'Share your current progress and the exact point of confusion so the AI does not waste time repeating basics.'
            : 'Point out the current roadblock or confusion so the advice can be targeted instead of generic.'
      },
      {
        stage: GHOST_STAGE_TITLES[4],
        verdict: !signals.hasFormat
          ? 'Specify how you want the answer delivered, such as bullet points, step-by-step guidance, code, or an outline.'
          : 'Define the final answer format more clearly so the output comes back in the exact shape you need.'
      }
    ];
  }

  function buildClientGhostFallback(promptText, reason) {
    const text = (promptText || '').trim();
    const missingContext = detectClientMissingContext(text);
    const stages = buildClientStages(text, missingContext);

    return {
      stages,
      verdicts: stages.map((stage) => stage.verdict),
      perfectPrompt: buildClientPerfectPrompt(text, missingContext),
      missingContext,
      meta: {
        source: 'local-fallback',
        reason: reason || 'Background Oracle unavailable. The local 5-verdict judge took over.'
      }
    };
  }

  function buildClientPerfectPrompt(promptText, missingContext) {
    let text = (promptText || '').replace(/\s+/g, ' ').trim();
    if (!text) text = 'Help me improve this request.';

    text = text
      .replace(/^can you\s+/i, '')
      .replace(/^could you\s+/i, '')
      .replace(/^please\s+/i, '');

    text = text.charAt(0).toUpperCase() + text.slice(1);

    if (/^(Teach|Explain|Write|Draft|Fix|Compare|Summarize|Show|Help)\b/.test(text)) {
      text = text.replace(/\?$/, '.');
    }

    if (!/[.?!]$/.test(text)) text += '.';

    const parts = [text];

    if (missingContext.includes('Who')) {
      parts.push('Assume the explanation should be beginner-friendly unless the topic clearly needs an advanced answer.');
    }

    if (missingContext.includes('Why')) {
      parts.push('Make the answer practical and immediately useful, not generic.');
    }

    if (missingContext.includes('What')) {
      parts.push('If the request is still ambiguous, make the most reasonable assumption and state it briefly before answering.');
    }

    if (/\b(compare|comparison|difference|differences|vs\b|versus|faster|slower|advantages|disadvantages)\b/i.test(text)) {
      parts.push('Start with a simple comparison, then explain the main differences clearly.');
    } else if (/\b(teach|explain|understand|learn|what is|how does|why does)\b/i.test(text)) {
      parts.push('Explain it in simple language first, then go deeper.');
    } else {
      parts.push('Give a clear and concrete answer instead of a vague overview.');
    }

    parts.push('Use at least one practical example.');
    parts.push('Keep the response easy to scan.');

    return parts.join(' ');
  }

  function showOverlay(flow, originalText) {
    removeOverlay();

    const color = cfg.color || '#6366f1';
    const loadingHtml = flow.isLoading
      ? '<div class="fm-loading-panel" id="fm-loading-panel">' +
          '<div class="fm-loading-header">' +
            '<span class="fm-loading-kicker">BACKGROUND ANALYSIS</span>' +
            '<span class="fm-loading-percent" id="fm-progress-value">8%</span>' +
          '</div>' +
          '<div class="fm-progress-track"><div class="fm-progress-fill" id="fm-progress-fill"></div></div>' +
          '<div class="fm-progress-meta">' +
            '<span class="fm-progress-stage" id="fm-progress-stage">Queued in background</span>' +
            '<span class="fm-progress-badge">Estimated</span>' +
          '</div>' +
          '<div class="fm-progress-note" id="fm-progress-note">Keep refining while the AI judge works.</div>' +
        '</div>'
      : '';

    const editHtml =
      '<div class="fm-edit-section">' +
        '<div class="fm-edit-header"><span class="fm-edit-label">EDIT YOUR PROMPT</span><span class="fm-word-count" id="fm-word-count">0 words</span></div>' +
        '<textarea id="fm-edit-textarea" class="fm-edit-textarea" placeholder="' + esc(flow.placeholder || '') + '">' + esc(flow.editableText || '') + '</textarea>' +
      '</div>';

    const overlay = document.createElement('div');
    overlay.id = 'friction-mode-overlay';
    overlay.innerHTML =
      '<div class="fm-backdrop">' +
        '<div class="fm-card" style="--accent:' + color + '">' +
          '<div class="fm-header">' +
            '<div class="fm-logo"><span class="fm-logo-icon">&#9889;</span><span class="fm-logo-text">Friction Mode</span></div>' +
            '<button id="fm-close" class="fm-close">&#10005;</button>' +
          '</div>' +
          '<div class="fm-body">' +
            '<div class="fm-icon-large">' + flow.icon + '</div>' +
            '<h2 class="fm-title" id="fm-title">' + esc(flow.title) + '</h2>' +
            '<p class="fm-message" id="fm-message">' + esc(flow.message) + '</p>' +
            loadingHtml +
            editHtml +
          '</div>' +
          '<div class="fm-footer">' +
            '<div class="fm-actions">' +
              '<button id="fm-go" class="fm-btn fm-btn-primary fm-btn-disabled" disabled>' + (flow.primaryHtml || esc(flow.primaryLabel || 'Continue')) + '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => overlay.classList.add('fm-visible'));
    });

    const card = overlay.querySelector('.fm-card');
    const goBtn = overlay.querySelector('#fm-go');
    const closeBtn = overlay.querySelector('#fm-close');
    const editArea = overlay.querySelector('#fm-edit-textarea');
    const wordCountEl = overlay.querySelector('#fm-word-count');
    const progressFill = overlay.querySelector('#fm-progress-fill');
    const progressValue = overlay.querySelector('#fm-progress-value');
    const progressStage = overlay.querySelector('#fm-progress-stage');
    const progressNote = overlay.querySelector('#fm-progress-note');

    let cleanupGhostListener = function noop() {};
    let cleanupClassifyListener = function noop() {};

    function updateWordCount() {
      if (!wordCountEl) return;
      wordCountEl.textContent = `${countWords(editArea.value)} words`;
    }

    function setPrimaryReady(ready, html) {
      goBtn.disabled = !ready;
      goBtn.classList.toggle('fm-btn-disabled', !ready);
      goBtn.classList.toggle('fm-btn-ready', !!ready);
      if (html) goBtn.innerHTML = html;
    }

    function setGhostProgress(percent, stage, note) {
      const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
      if (progressFill) progressFill.style.width = `${safePercent}%`;
      if (progressValue) progressValue.textContent = `${safePercent}%`;
      if (progressStage) progressStage.textContent = stage || 'Analyzing prompt';
      if (progressNote && note) progressNote.textContent = note;
    }

    function removeLoadingPanel() {
      const panel = overlay.querySelector('#fm-loading-panel');
      if (panel) panel.remove();
    }

    function buildComparisonView(perfectPrompt) {
      const oldCritique = overlay.querySelector('.fm-challenge-box');
      if (oldCritique) oldCritique.remove();

      overlay.querySelector('#fm-title').textContent = 'Human vs. AI';
      overlay.querySelector('#fm-message').textContent = 'Compare your revised prompt with the Oracle rewrite and submit the stronger version.';
      overlay.querySelector('.fm-icon-large').innerHTML = '<span class="fm-vs-badge">&#9878;&#65039;</span>';

      editArea.closest('.fm-edit-section').style.display = 'none';
      card.classList.add('fm-wide');

      const currentText = editArea.value || originalText;
      const comparison = document.createElement('div');
      comparison.className = 'fm-comparison-grid';
      comparison.innerHTML =
        '<div class="fm-comp-col fm-comp-human">' +
          '<div class="fm-comp-head">' +
            '<div class="fm-edit-label"><span class="fm-comp-icon">&#9997;&#65039;</span> YOUR REVISED PROMPT</div>' +
            '<div class="fm-comp-meta fm-comp-meta-human" id="fm-comp-meta-mine">' + countWords(currentText) + ' words</div>' +
          '</div>' +
          '<textarea id="fm-comp-textarea-mine" class="fm-comp-textarea">' + esc(currentText) + '</textarea>' +
          '<button id="fm-submit-mine" class="fm-btn fm-btn-human">&#9997;&#65039; Submit My Version</button>' +
        '</div>' +
        '<div class="fm-comp-col fm-comp-ai">' +
          '<div class="fm-comp-head">' +
            '<div class="fm-edit-label"><span class="fm-comp-icon">&#129302;</span> AI\'S PERFECT PROMPT</div>' +
            '<div class="fm-comp-meta fm-comp-meta-ai" id="fm-comp-meta-ai">' + countWords(perfectPrompt) + ' words</div>' +
          '</div>' +
          '<textarea id="fm-comp-textarea-ai" class="fm-comp-textarea">' + esc(perfectPrompt) + '</textarea>' +
          '<button id="fm-submit-ai" class="fm-btn fm-btn-ai">&#129302; Submit AI Version</button>' +
        '</div>';

      overlay.querySelector('.fm-body').appendChild(comparison);
      overlay.querySelector('.fm-actions').style.display = 'none';

      const myTextarea = comparison.querySelector('#fm-comp-textarea-mine');
      const aiTextarea = comparison.querySelector('#fm-comp-textarea-ai');
      const myMeta = comparison.querySelector('#fm-comp-meta-mine');
      const aiMeta = comparison.querySelector('#fm-comp-meta-ai');

      function syncCompMeta(textarea, metaEl) {
        if (!textarea || !metaEl) return;
        metaEl.textContent = `${countWords(textarea.value)} words`;
      }

      function autoSizeTextarea(textarea) {
        if (!textarea) return;
        textarea.style.height = '0px';
        const nextHeight = Math.max(190, Math.min(textarea.scrollHeight, 320));
        textarea.style.height = `${nextHeight}px`;
      }

      [myTextarea, aiTextarea].forEach((textarea) => {
        autoSizeTextarea(textarea);
        textarea.addEventListener('input', () => {
          autoSizeTextarea(textarea);
          if (textarea === myTextarea) syncCompMeta(myTextarea, myMeta);
          if (textarea === aiTextarea) syncCompMeta(aiTextarea, aiMeta);
        });
      });

      comparison.querySelector('#fm-submit-mine').addEventListener('click', () => {
        DNA.recordSubmission(originalText, myTextarea.value);
        doSubmit(myTextarea.value);
      });

      comparison.querySelector('#fm-submit-ai').addEventListener('click', () => {
        DNA.recordAiVersionChosen();
        DNA.recordSubmission(originalText, aiTextarea.value);
        doSubmit(aiTextarea.value);
      });
    }

    function renderGhostWizard(result) {
      const parsed = normalizeGhostResult(result, originalText);
      const stages = parsed.stages;
      const perfectPrompt = parsed.perfectPrompt;
      const isRemote = parsed.meta?.source !== 'local-fallback';
      const sourceNote = isRemote
        ? 'The AI Oracle returned 5 verdicts for your prompt.'
        : (parsed.meta?.reason || 'Remote Oracle unavailable, so the local 5-verdict judge filled the steps.');

      if (!isRemote) {
        console.warn('[Friction] Oracle fallback:', parsed.meta?.reason);
      }

      let currentStep = 0;

      removeLoadingPanel();
      setGhostProgress(100, isRemote ? 'AI Judge ready' : 'Local judge (API unavailable)', sourceNote);

      const existingBanner = overlay.querySelector('#fm-fallback-banner');
      if (existingBanner) existingBanner.remove();
      if (!isRemote) {
        const banner = document.createElement('div');
        banner.id = 'fm-fallback-banner';
        banner.style.cssText = 'margin:10px 0;padding:10px 12px;border-radius:8px;background:rgba(255,180,60,0.12);border:1px solid rgba(255,180,60,0.4);color:#b07800;font-size:12px;line-height:1.4;';
        banner.innerHTML =
          '<strong>&#9888;&#65039; Remote Oracle unavailable &mdash; showing local verdicts.</strong><br>' +
          '<span style="opacity:.85">Reason: ' + esc(parsed.meta?.reason || 'Unknown') + '</span>';
        const body = overlay.querySelector('.fm-body');
        if (body) body.insertBefore(banner, body.firstChild);
      }

      function renderStep() {
        if (currentStep >= stages.length) {
          buildComparisonView(perfectPrompt);
          return;
        }

        const stage = stages[currentStep];
        const oldCritique = overlay.querySelector('.fm-challenge-box');
        if (oldCritique) oldCritique.remove();

        overlay.querySelector('#fm-title').textContent = `Verdict ${currentStep + 1} of ${stages.length}`;
        overlay.querySelector('#fm-message').textContent = `Verdict ${currentStep + 1} of ${stages.length}. ${sourceNote}`;
        overlay.querySelector('.fm-icon-large').innerHTML = '&#129504;';

        const box = document.createElement('div');
        box.className = 'fm-challenge-box';
        box.innerHTML =
          '<div class="fm-challenge-label">AI VERDICT</div>' +
          (stage.stage
            && !/^Verdict\s+\d+$/i.test(stage.stage)
            && stage.stage.trim().toLowerCase() !== stage.verdict.trim().toLowerCase()
            ? '<div class="fm-challenge-title">' + esc(stage.stage) + '</div>'
            : '') +
          '<div class="fm-challenge-text">' + esc(stage.verdict) + '</div>';

        overlay.querySelector('.fm-body').insertBefore(box, editArea.closest('.fm-edit-section'));
        goBtn.style.display = 'inline-flex';
        
        flow.stepInitialText = editArea.value.trim();
        setPrimaryReady(false, 'Edit to Continue &rarr;');
      }

      flow.wizardAdvance = function wizardAdvance() {
        currentStep += 1;
        renderStep();
      };

      renderStep();
    }

    function updateAntiPasteButton() {
      if (flow.type !== 'ANTI_PASTE') return;
      setPrimaryReady(editArea.value.trim().length >= 8, flow.primaryHtml);
    }

    function updateGhostButton() {
      if (flow.type !== 'GHOST_REFLECTION') return;
      if (flow.stepInitialText !== undefined) {
        const hasEdited = editArea.value.trim() !== flow.stepInitialText;
        setPrimaryReady(hasEdited, hasEdited ? 'Apply & Next &rarr;' : 'Edit to Continue &rarr;');
      }
    }

    updateWordCount();

    editArea.addEventListener('input', () => {
      updateWordCount();
      updateAntiPasteButton();
      updateGhostButton();
    });

    editArea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.stopPropagation();
      }
    }, true);

    if (flow.type === 'ANTI_PASTE') {
      updateAntiPasteButton();
    }

    if (flow.isLoading) {
      goBtn.style.display = 'none';
      setGhostProgress(8, 'Queued in background', 'Keep refining while the AI judge works.');

      const ghostListener = (message) => {
        if (message.type === 'GHOST_REFLECTION_PROGRESS') {
          setGhostProgress(message.percent, message.stage, message.note);
          return;
        }

        if (message.type !== 'GHOST_REFLECTION_READY') return;

        cleanupGhostListener();
        renderGhostWizard(message.result);
      };

      cleanupGhostListener = function cleanup() {
        chrome.runtime.onMessage.removeListener(ghostListener);
        cleanupGhostListener = function noopCleanup() {};
      };

      chrome.runtime.onMessage.addListener(ghostListener);

      try {
        chrome.runtime.sendMessage({ type: 'START_GHOST_API', prompt: originalText }, () => {
          if (!chrome.runtime.lastError) return;

          console.warn('[Friction] START_GHOST_API failed:', chrome.runtime.lastError?.message);
          cleanupGhostListener();
          renderGhostWizard(buildClientGhostFallback(
            editArea.value || originalText,
            'Background analysis could not connect, so the local 5-verdict judge took over.'
          ));
        });
      } catch (error) {
        console.warn('[Friction] START_GHOST_API threw:', error);
        cleanupGhostListener();
        renderGhostWizard(buildClientGhostFallback(
          editArea.value || originalText,
          'Background analysis could not start, so the local 5-verdict judge took over.'
        ));
      }
    }

    if (flow.type === 'ANTI_PASTE' && lastPastedText) {
      const classifyText = lastPastedText.slice(0, 2000);

      const classifyListener = (message) => {
        if (message.type !== 'PASTE_CLASSIFIED') return;
        cleanupClassifyListener();
        if (classifyTimeout) clearTimeout(classifyTimeout);

        const titleEl = overlay.querySelector('#fm-title');
        const messageEl = overlay.querySelector('#fm-message');

        if (message.classification === 'code') {
          if (titleEl) titleEl.textContent = 'Code Detected';
          if (messageEl) messageEl.textContent = 'You pasted a large block of code. Please specify the error or behavior you want to fix.';
          if (editArea) editArea.placeholder = 'Describe the bug or expected behavior...';
        } else if (message.classification === 'text') {
          if (titleEl) titleEl.textContent = 'Text Detected';
          if (messageEl) messageEl.textContent = 'You pasted a large block of text. Please specify what you want the AI to do with it.';
          if (editArea) editArea.placeholder = 'Summarize the content and the outcome you want...';
        }
      };

      cleanupClassifyListener = function cleanup() {
        chrome.runtime.onMessage.removeListener(classifyListener);
        cleanupClassifyListener = function noop() {};
      };

      chrome.runtime.onMessage.addListener(classifyListener);

      const classifyTimeout = setTimeout(() => {
        cleanupClassifyListener();
      }, 15000);

      try {
        chrome.runtime.sendMessage({ type: 'CLASSIFY_PASTE', text: classifyText }, () => {
          if (chrome.runtime.lastError) {
            cleanupClassifyListener();
            if (classifyTimeout) clearTimeout(classifyTimeout);
          }
        });
      } catch (error) {
        cleanupClassifyListener();
        if (classifyTimeout) clearTimeout(classifyTimeout);
      }
    }

    goBtn.addEventListener('click', () => {
      if (goBtn.disabled) return;

      if (flow.type === 'GHOST_REFLECTION' && flow.wizardAdvance) {
        flow.wizardAdvance();
        return;
      }

      if (flow.type === 'ANTI_PASTE') {
        const summary = editArea.value.trim();
        if (summary.length < 8) return;

        largePasteDetected = false;
        lastPastedText = '';
        cleanupGhostListener();
        cleanupClassifyListener();
        const finalText = `User context: ${summary}\n\nPasted source:\n${originalText}`;
        DNA.recordSubmission(originalText, finalText);
        doSubmit(finalText, countWords(originalText));
      }
    });

    closeBtn.addEventListener('click', () => {
      cleanupGhostListener();
      cleanupClassifyListener();
      removeOverlay();
      blocking = false;
    });
  }

  function normalizeGhostStage(entry, index) {
    if (typeof entry === 'string') {
      return {
        stage: GHOST_STAGE_TITLES[index] || `Verdict ${index + 1}`,
        verdict: entry.trim()
      };
    }

    if (!entry || typeof entry !== 'object') return null;

    const verdict = entry.verdict || entry.question || entry.critique || entry.text || entry.message || entry.feedback || '';
    return {
      stage: `${entry.stage || entry.title || entry.name || GHOST_STAGE_TITLES[index] || `Verdict ${index + 1}`}`.trim(),
      verdict: `${verdict || ''}`.trim()
    };
  }

  function normalizeGhostResult(result, originalText) {
    const fallback = buildClientGhostFallback(originalText);

    if (typeof result === 'string') {
      return buildClientGhostFallback(originalText, result);
    }

    const rawStages = Array.isArray(result?.stages) && result.stages.length
      ? result.stages
      : Array.isArray(result?.verdicts) && result.verdicts.length
        ? result.verdicts
        : fallback.stages;

    const stages = GHOST_STAGE_TITLES.map((title, index) => {
      const candidate = normalizeGhostStage(rawStages[index], index);
      const fallbackStage = fallback.stages[index];

      return {
        stage: candidate?.stage || title || fallbackStage.stage,
        verdict: candidate?.verdict || fallbackStage.verdict
      };
    });

    return {
      stages,
      verdicts: stages.map((stage) => stage.verdict),
      perfectPrompt: result?.perfectPrompt || buildClientPerfectPrompt(originalText, detectClientMissingContext(originalText)),
      meta: result?.meta || { source: 'remote' }
    };
  }

  function showCooldownOverlay(pendingText, totalWords, threshold) {
    removeOverlay();
    cooldownActive = true;

    const COOLDOWN_SECONDS = 30;

    const overlay = document.createElement('div');
    overlay.id = 'friction-mode-overlay';
    overlay.classList.add('fm-cooldown-mode');
    overlay.innerHTML =
      '<div class="fm-cooldown-banner">' +
        '<div class="fm-cooldown-banner-left">' +
          '<div class="fm-cooldown-banner-icon">&#9203;</div>' +
          '<div class="fm-cooldown-banner-info">' +
            '<div class="fm-cooldown-banner-title" id="fm-cooldown-title">&#9889; Cognitive Cooldown</div>' +
            '<div class="fm-cooldown-banner-desc" id="fm-cooldown-sub">You\'ve sent <strong>' + totalWords + '</strong> words. Read the AI\'s response for <strong>30s</strong>.</div>' +
          '</div>' +
        '</div>' +
        '<div class="fm-cooldown-banner-right">' +
          '<div class="fm-cooldown-mini-ring">' +
            '<svg class="fm-cooldown-mini-svg" viewBox="0 0 64 64">' +
              '<circle class="fm-cooldown-track" cx="32" cy="32" r="26" />' +
              '<circle class="fm-cooldown-progress" id="fm-cooldown-circle" cx="32" cy="32" r="26" />' +
            '</svg>' +
            '<div class="fm-cooldown-mini-digits" id="fm-cooldown-digits">' + COOLDOWN_SECONDS + '</div>' +
          '</div>' +
          '<button id="fm-cooldown-go" class="fm-btn fm-btn-primary fm-btn-disabled fm-cooldown-banner-btn" disabled>Locked &#128274;</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => overlay.classList.add('fm-visible'));
    });

    const circle = overlay.querySelector('#fm-cooldown-circle');
    const digits = overlay.querySelector('#fm-cooldown-digits');
    const goBtn = overlay.querySelector('#fm-cooldown-go');
    const circumference = 2 * Math.PI * 26;

    if (circle) {
      circle.style.strokeDasharray = circumference;
      circle.style.strokeDashoffset = '0';
    }

    let remaining = COOLDOWN_SECONDS;

    if (cooldownTimerId) clearInterval(cooldownTimerId);
    cooldownTimerId = setInterval(() => {
      remaining -= 1;

      if (digits) digits.textContent = remaining;

      if (circle) {
        const progress = 1 - (remaining / COOLDOWN_SECONDS);
        circle.style.strokeDashoffset = (circumference * progress).toString();
      }

      if (remaining <= 0) {
        clearInterval(cooldownTimerId);
        cooldownTimerId = null;

        if (digits) digits.textContent = '\u2713';
        if (goBtn) {
          goBtn.disabled = false;
          goBtn.classList.remove('fm-btn-disabled');
          goBtn.classList.add('fm-btn-ready');
          goBtn.innerHTML = 'Continue &#8594;';
        }

        const sub = overlay.querySelector('#fm-cooldown-sub');
        if (sub) sub.innerHTML = 'Cooldown complete. You may continue.';

        const title = overlay.querySelector('#fm-cooldown-title');
        if (title) title.innerHTML = '&#10003; Ready to Continue';
      }
    }, 1000);

    goBtn.addEventListener('click', () => {
      if (goBtn.disabled) return;
      if (cooldownTimerId) { clearInterval(cooldownTimerId); cooldownTimerId = null; }
      saveSessionWordCount(0);
      cooldownActive = false;
      removeOverlay();
      blocking = false;

      // double RAF so the cooldown banner is fully gone before we throw up the judge overlay, otherwise it looks glitchy
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const flow = evaluate(pendingText);
          if (!flow.block) return;
          blocking = true;
          showOverlay(flow, pendingText);
        });
      });
    });
  }

  function doSubmit(editedText, rawWordCount) {
    removeOverlay();
    blocking = false;
    passingThrough = true;

    const wordsToAdd = rawWordCount || countWords(editedText || '');
    if (wordsToAdd > 0) {
      addSessionWords(wordsToAdd);
    }

    setTimeout(() => {
      if (editedText) {
        setInputText(editedText);
      }

      setTimeout(() => {
        const btn = pick(cfg.submits)[0];
        if (btn) {
          btn.click();
        } else {
          passingThrough = false;
          const input = pick(cfg.inputs)[0];
          if (input) {
            input.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              bubbles: true,
              cancelable: false
            }));
          }
        }

        setTimeout(() => {
          passingThrough = false;
        }, 500);
      }, 80);
    }, 120);
  }

  function setInputText(text) {
    const input = pick(cfg.inputs)[0];
    if (!input) return;

    if (input.contentEditable === 'true') {
      input.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      if (!input.innerText || input.innerText.trim() !== text.trim()) {
        input.innerText = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function removeOverlay() {
    const element = document.getElementById('friction-mode-overlay');
    if (!element) return;

    if (cooldownTimerId) { clearInterval(cooldownTimerId); cooldownTimerId = null; }
    element.classList.remove('fm-visible');
    setTimeout(() => {
      if (element.parentNode) element.parentNode.removeChild(element);
    }, 220);
  }

  function shutdownAllFeatures() {
    removeOverlay();
    if (cooldownTimerId) { clearInterval(cooldownTimerId); cooldownTimerId = null; }
    cooldownActive = false;
    blocking = false;
  }

  function countWords(text) {
    return (text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  function normalizeForMatch(text) {
    return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function getText() {
    const input = pick(cfg.inputs)[0];
    if (!input) return '';
    return (input.innerText || input.textContent || input.value || '').trim();
  }

  function pick(selectors) {
    const out = [];

    for (let index = 0; index < selectors.length; index += 1) {
      try {
        document.querySelectorAll(selectors[index]).forEach((element) => {
          if (!out.includes(element)) out.push(element);
        });
      } catch (error) {}
    }

    return out;
  }

  function esc(text) {
    return (text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();

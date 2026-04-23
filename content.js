// ============================================================
// FRICTION MODE - content.js
// Only two engines remain:
// - Anti-Paste Engine
// - 5-Step Verdict Judge
// ============================================================

(function () {
  'use strict';

  if (window.__frictionModeLoaded) return;
  window.__frictionModeLoaded = true;

  const PLATFORM = (function () {
    const hostname = window.location.hostname;
    if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) return 'chatgpt';
    if (hostname.includes('claude.ai')) return 'claude';
    if (hostname.includes('gemini.google.com')) return 'gemini';
    return null;
  })();

  if (!PLATFORM) return;
  console.log('[Friction Mode] Active on:', PLATFORM);

  const DEFAULT_STATE = {
    enabled: true
  };

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

  let state = { ...DEFAULT_STATE };
  let blocking = false;
  let passingThrough = false;
  let attached = new WeakSet();
  let largePasteDetected = false;
  let lastPastedText = '';

  loadState();
  listenForStateChanges();

  function loadState() {
    try {
      chrome.storage.local.get('frictionState', ({ frictionState }) => {
        if (chrome.runtime.lastError) return;
        state = mergeState(frictionState);
      });
    } catch (error) {}
  }

  function listenForStateChanges() {
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes.frictionState) return;
        state = mergeState(changes.frictionState.newValue);
      });
    } catch (error) {}
  }

  function mergeState(nextState) {
    return {
      ...DEFAULT_STATE,
      ...(nextState || {})
    };
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

  scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });

  function onPaste(e) {
    if (!state.enabled) return;

    const pastedText = (e.clipboardData || window.clipboardData).getData('text');
    if (pastedText && pastedText.length > 300) {
      largePasteDetected = true;
      lastPastedText = pastedText;
    }
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    tryBlock(e);
  }

  function onSubmit(e) {
    tryBlock(e);
  }

  function tryBlock(e) {
    if (passingThrough) {
      passingThrough = false;
      return;
    }

    if (blocking || !state.enabled) return;

    const text = getText();
    if (!text || text.length < 2) return;

    const flow = evaluate(text);
    if (!flow.block) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    blocking = true;
    showOverlay(flow, text);
  }

  function evaluate(text) {
    if (shouldTriggerAntiPaste(text)) {
      return {
        block: true,
        type: 'ANTI_PASTE',
        icon: '⛔',
        title: 'Anti-Paste Check',
        message: 'You pasted a large block of text. Add one sentence explaining what it is and what you want the AI to do with it.',
        primaryLabel: 'Summarize & Submit →',
        editableText: '',
        placeholder: 'Summarize the pasted content and the outcome you want...',
        allowSkip: false,
        isLoading: false
      };
    }

    return {
      block: true,
      type: 'GHOST_REFLECTION',
      icon: '🧠',
      title: 'Running 5-Step Verdict Judge',
      message: 'Background analysis is working. Tighten your prompt while the judge prepares the verdicts.',
      primaryLabel: 'Apply & Next →',
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

  function buildClientGhostFallback(promptText, reason) {
    const text = (promptText || '').trim();
    const words = countWords(text);
    const missingContext = detectClientMissingContext(text);
    const verdicts = [];

    if (missingContext.includes('What')) {
      verdicts.push('You still did not clearly say what output you want back.');
    }
    if (missingContext.includes('Who')) {
      verdicts.push('You never said who this answer is for or what level it should target.');
    }
    if (missingContext.includes('Why')) {
      verdicts.push('The goal is missing, so the AI has no target for what a good answer looks like.');
    }
    if (words < 10) {
      verdicts.push('This prompt is too short to reliably produce a sharp answer.');
    }
    if (!/\b(table|bullet|bullets|list|json|step-by-step|steps|code|summary|format)\b/i.test(text)) {
      verdicts.push('You did not specify the response format, so the answer may come back generic.');
    }
    if (!/\b(example|examples|sample|samples|for instance)\b/i.test(text)) {
      verdicts.push('Ask for an example if you want the explanation to be easier to understand.');
    }
    if (!/\b(exactly|under|at least|tone|style|formal|casual|concise|detailed|must)\b/i.test(text)) {
      verdicts.push('There are no useful constraints here. Add scope, tone, or must-include details.');
    }
    verdicts.push('Turn this from a casual question into a direct instruction.');
    verdicts.push('Add one detail that would stop the answer from being vague.');

    return {
      verdicts: dedupeStrings(verdicts).slice(0, 5),
      perfectPrompt: buildClientPerfectPrompt(text, missingContext),
      missingContext,
      meta: {
        source: 'local-fallback',
        reason: reason || 'Background Oracle unavailable. The local 5-step judge took over.'
      }
    };
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
    const messageHtml = esc(flow.message).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

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
          '<div class="fm-progress-note" id="fm-progress-note">Keep refining while the judge works.</div>' +
        '</div>'
      : '';

    const editHtml =
      '<div class="fm-edit-section">' +
        '<div class="fm-edit-header"><span class="fm-edit-label">EDIT YOUR PROMPT</span><span class="fm-word-count" id="fm-word-count">0 words</span></div>' +
        '<textarea id="fm-edit-textarea" class="fm-edit-textarea" placeholder="' + esc(flow.placeholder || '') + '">' + esc(flow.editableText || '') + '</textarea>' +
      '</div>';

    const skipHtml = flow.allowSkip
      ? '<button id="fm-skip" class="fm-btn fm-btn-ghost">Send now</button>'
      : '';

    const div = document.createElement('div');
    div.id = 'friction-mode-overlay';
    div.innerHTML =
      '<div class="fm-backdrop">' +
        '<div class="fm-card" style="--accent:' + color + '">' +
          '<div class="fm-header">' +
            '<div class="fm-logo"><span class="fm-logo-icon">&#9889;</span><span class="fm-logo-text">Friction Mode</span></div>' +
            '<button id="fm-close" class="fm-close">&#x2715;</button>' +
          '</div>' +
          '<div class="fm-body">' +
            '<div class="fm-icon-large">' + flow.icon + '</div>' +
            '<h2 class="fm-title" id="fm-title">' + esc(flow.title) + '</h2>' +
            '<p class="fm-message" id="fm-message">' + messageHtml + '</p>' +
            loadingHtml +
            editHtml +
          '</div>' +
          '<div class="fm-footer">' +
            '<div class="fm-actions">' +
              skipHtml +
              '<button id="fm-go" class="fm-btn fm-btn-primary fm-btn-disabled" disabled>' + esc(flow.primaryLabel) + '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(div);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => div.classList.add('fm-visible'));
    });

    const card = div.querySelector('.fm-card');
    const goBtn = div.querySelector('#fm-go');
    const skipBtn = div.querySelector('#fm-skip');
    const closeBtn = div.querySelector('#fm-close');
    const editArea = div.querySelector('#fm-edit-textarea');
    const wordCountEl = div.querySelector('#fm-word-count');
    const progressFill = div.querySelector('#fm-progress-fill');
    const progressValue = div.querySelector('#fm-progress-value');
    const progressStage = div.querySelector('#fm-progress-stage');
    const progressNote = div.querySelector('#fm-progress-note');

    let cleanupGhostListener = function () {};

    function updateWordCount() {
      if (wordCountEl) {
        wordCountEl.textContent = countWords(editArea.value) + ' words';
      }
    }

    function setPrimaryReady(ready, label) {
      goBtn.disabled = !ready;
      goBtn.classList.toggle('fm-btn-disabled', !ready);
      if (ready) {
        goBtn.classList.add('fm-btn-ready');
      } else {
        goBtn.classList.remove('fm-btn-ready');
      }
      if (label) goBtn.innerHTML = label;
    }

    function setGhostProgress(percent, stage, note) {
      const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
      if (progressFill) progressFill.style.width = safePercent + '%';
      if (progressValue) progressValue.textContent = safePercent + '%';
      if (progressStage) progressStage.textContent = stage || 'Analyzing prompt';
      if (progressNote && note) progressNote.textContent = note;
    }

    function removeLoadingPanel() {
      const panel = div.querySelector('#fm-loading-panel');
      if (panel) panel.remove();
    }

    function buildComparisonView(perfectPrompt) {
      const oldCritique = div.querySelector('.fm-challenge-box');
      if (oldCritique) oldCritique.remove();

      div.querySelector('#fm-title').innerHTML = 'Human vs. AI';
      div.querySelector('#fm-message').innerHTML = 'Compare your revised prompt with the judge\'s improved prompt and submit the stronger version.';
      div.querySelector('.fm-icon-large').innerHTML = '⚖️';

      if (editArea) {
        editArea.closest('.fm-edit-section').style.display = 'none';
      }

      card.classList.add('fm-wide');

      const currentText = editArea ? editArea.value : originalText;
      const comparison = document.createElement('div');
      comparison.className = 'fm-comparison-grid';
      comparison.innerHTML =
        '<div class="fm-comp-col">' +
          '<div class="fm-edit-label">YOUR REVISED PROMPT</div>' +
          '<textarea id="fm-comp-textarea-mine" class="fm-comp-textarea">' + esc(currentText) + '</textarea>' +
          '<button id="fm-submit-mine" class="fm-btn fm-btn-primary">Submit My Version</button>' +
        '</div>' +
        '<div class="fm-comp-col">' +
          '<div class="fm-edit-label">AI\'S PERFECT PROMPT</div>' +
          '<textarea id="fm-comp-textarea-ai" class="fm-comp-textarea">' + esc(perfectPrompt) + '</textarea>' +
          '<button id="fm-submit-ai" class="fm-btn fm-btn-primary">Submit AI Version</button>' +
        '</div>';

      div.querySelector('.fm-body').appendChild(comparison);
      div.querySelector('.fm-actions').style.display = 'none';

      comparison.querySelector('#fm-submit-mine').addEventListener('click', () => {
        doSubmit(comparison.querySelector('#fm-comp-textarea-mine').value);
      });

      comparison.querySelector('#fm-submit-ai').addEventListener('click', () => {
        doSubmit(comparison.querySelector('#fm-comp-textarea-ai').value);
      });
    }

    function renderGhostWizard(result) {
      const parsed = normalizeGhostResult(result, originalText);
      const verdicts = parsed.verdicts;
      const perfectPrompt = parsed.perfectPrompt;
      const sourceNote = parsed.meta?.source === 'local-fallback'
        ? (parsed.meta.reason || 'The local 5-step judge took over.')
        : 'The AI Oracle challenges your prompt:';

      let currentStep = 0;

      removeLoadingPanel();
      setGhostProgress(100, 'Judge ready', sourceNote);

      function renderStep() {
        if (currentStep >= verdicts.length) {
          buildComparisonView(perfectPrompt);
          return;
        }

        const oldCritique = div.querySelector('.fm-challenge-box');
        if (oldCritique) oldCritique.remove();

        div.querySelector('.fm-title').innerHTML = 'Verdict ' + (currentStep + 1) + ' of ' + verdicts.length;
        div.querySelector('.fm-message').innerHTML = esc(sourceNote);
        div.querySelector('.fm-icon-large').innerHTML = '🧠';

        const box = document.createElement('div');
        box.className = 'fm-challenge-box';
        box.innerHTML =
          '<div class="fm-challenge-label">CRITIQUE</div>' +
          '<div class="fm-challenge-text">' + esc(verdicts[currentStep]) + '</div>';

        div.querySelector('.fm-body').insertBefore(box, editArea.closest('.fm-edit-section'));
        goBtn.style.display = 'inline-flex';
        setPrimaryReady(true, 'Apply & Next →');

        if (skipBtn) {
          skipBtn.textContent = 'Skip →';
          skipBtn.style.display = 'inline-flex';
        }
      }

      flow.wizardAdvance = function () {
        currentStep += 1;
        renderStep();
      };

      renderStep();
    }

    function updateAntiPasteButton() {
      if (flow.type !== 'ANTI_PASTE') return;
      const ready = editArea.value.trim().length >= 8;
      setPrimaryReady(ready, flow.primaryLabel);
    }

    updateWordCount();

    editArea.addEventListener('input', () => {
      updateWordCount();
      updateAntiPasteButton();
    });

    editArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.stopPropagation();
      }
    }, true);

    if (flow.type === 'ANTI_PASTE') {
      updateAntiPasteButton();
    }

    if (flow.isLoading) {
      goBtn.style.display = 'none';
      if (skipBtn) skipBtn.style.display = 'inline-flex';
      setGhostProgress(8, 'Queued in background', 'Keep refining while the judge works.');

      const ghostListener = (msg) => {
        if (msg.type === 'GHOST_REFLECTION_PROGRESS') {
          setGhostProgress(msg.percent, msg.stage, msg.note);
          return;
        }

        if (msg.type !== 'GHOST_REFLECTION_READY') return;

        cleanupGhostListener();
        renderGhostWizard(msg.result);
      };

      cleanupGhostListener = function () {
        chrome.runtime.onMessage.removeListener(ghostListener);
        cleanupGhostListener = function () {};
      };

      chrome.runtime.onMessage.addListener(ghostListener);

      try {
        chrome.runtime.sendMessage({ type: 'START_GHOST_API', prompt: originalText }, () => {
          if (!chrome.runtime.lastError) return;

          cleanupGhostListener();
          renderGhostWizard(buildClientGhostFallback(
            editArea ? editArea.value : originalText,
            'Background analysis could not connect, so the local 5-step judge took over.'
          ));
        });
      } catch (error) {
        cleanupGhostListener();
        renderGhostWizard(buildClientGhostFallback(
          editArea ? editArea.value : originalText,
          'Background analysis could not start, so the local 5-step judge took over.'
        ));
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
        doSubmit('User context: ' + summary + '\n\nPasted source:\n' + originalText);
      }
    });

    if (skipBtn) {
      skipBtn.addEventListener('click', () => {
        if (flow.type === 'GHOST_REFLECTION' && flow.wizardAdvance) {
          flow.wizardAdvance();
          return;
        }

        cleanupGhostListener();
        doSubmit(editArea.value.trim() || originalText);
      });
    }

    closeBtn.addEventListener('click', () => {
      cleanupGhostListener();
      removeOverlay();
      blocking = false;
    });
  }

  function normalizeGhostResult(result, originalText) {
    if (typeof result === 'string') {
      return buildClientGhostFallback(originalText, result);
    }

    const verdicts = Array.isArray(result?.verdicts) && result.verdicts.length
      ? dedupeStrings(result.verdicts).slice(0, 5)
      : buildClientGhostFallback(originalText).verdicts;

    return {
      verdicts,
      perfectPrompt: result?.perfectPrompt || buildClientPerfectPrompt(originalText, detectClientMissingContext(originalText)),
      meta: result?.meta || { source: 'remote' }
    };
  }

  function doSubmit(editedText) {
    removeOverlay();
    blocking = false;
    passingThrough = true;

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
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);

      if (!input.innerText || input.innerText.trim() !== text.trim()) {
        input.innerText = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function removeOverlay() {
    const el = document.getElementById('friction-mode-overlay');
    if (!el) return;

    el.classList.remove('fm-visible');
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  }

  function countWords(text) {
    return (text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  function normalizeForMatch(text) {
    return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function dedupeStrings(items) {
    const seen = new Set();
    return (items || []).filter((item) => {
      const cleaned = (item || '').trim();
      if (!cleaned) return false;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getText() {
    const input = pick(cfg.inputs)[0];
    if (!input) return '';
    return (input.innerText || input.textContent || input.value || '').trim();
  }

  function pick(selectors) {
    const out = [];
    for (let i = 0; i < selectors.length; i += 1) {
      try {
        document.querySelectorAll(selectors[i]).forEach((el) => {
          if (!out.includes(el)) out.push(el);
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

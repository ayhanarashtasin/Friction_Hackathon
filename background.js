// ============================================================
// FRICTION MODE - background.js
// Minimal background service worker:
// - stores minimal extension state
// - runs the 5-step verdict Oracle
// ============================================================

const DEFAULT_STATE = {
  enabled: true,
  apiProvider: 'gemini',
  apiModel: '',
  apiKey: ''
};

const GHOST_VERDICT_COUNT = 5;
const GHOST_REQUEST_TIMEOUT_MS = 12000;
const GHOST_PROGRESS_STAGES = [
  { delay: 0, percent: 8, stage: 'Queued in background' },
  { delay: 350, percent: 18, stage: 'Checking prompt context' },
  { delay: 900, percent: 36, stage: 'Finding weak spots' },
  { delay: 1700, percent: 58, stage: 'Drafting verdicts' },
  { delay: 3000, percent: 78, stage: 'Rewriting the prompt' },
  { delay: 4500, percent: 92, stage: 'Finalizing the judge output' }
];

chrome.runtime.onInstalled.addListener(async () => {
  const { frictionState } = await chrome.storage.local.get('frictionState');
  await chrome.storage.local.set({ frictionState: ensureState(frictionState) });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_GHOST_API') {
    handleGhostApiCall(message.prompt, sender, sendResponse);
    return true;
  }

  sendResponse({ success: false, error: 'Unknown message type.' });
  return false;
});

function ensureState(state) {
  return {
    ...DEFAULT_STATE,
    ...(state || {})
  };
}

function sendTabMessage(tabId, message) {
  if (!tabId) return;

  try {
    chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);
  } catch (error) {}
}

function createGhostProgressReporter(tabId) {
  let lastPercent = 0;
  let disposed = false;
  const timers = [];

  function send(percent, stage, note) {
    if (disposed || !tabId) return;

    const safePercent = Math.max(lastPercent, Math.min(100, Math.round(percent || 0)));
    lastPercent = safePercent;

    sendTabMessage(tabId, {
      type: 'GHOST_REFLECTION_PROGRESS',
      percent: safePercent,
      stage: stage || 'Analyzing prompt',
      note: note || ''
    });
  }

  GHOST_PROGRESS_STAGES.forEach(({ delay, percent, stage }) => {
    timers.push(setTimeout(() => send(percent, stage), delay));
  });

  return {
    send,
    finish(stage, note) {
      send(100, stage || 'Judge ready', note);
      this.dispose();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      timers.forEach(clearTimeout);
    }
  };
}

async function fetchJson(url, options, timeoutMs = GHOST_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const details = data?.error?.message || data?.error?.type || `HTTP ${response.status}`;
      throw new Error(details);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function cleanJsonEnvelope(rawText) {
  let cleaned = (rawText || '').trim();

  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  return cleaned.trim();
}

function dedupeVerdicts(verdicts) {
  const seen = new Set();

  return verdicts.filter((verdict) => {
    const cleaned = (verdict || '').trim();
    if (!cleaned) return false;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function detectMissingContext(promptText) {
  const text = (promptText || '').trim();
  const wordCount = text ? text.split(/\s+/).length : 0;
  const missing = [];

  const hasAudience = /\b(audience|persona|target user|reader|customer|client|stakeholder|manager|developer|designer|student|beginner|expert|team|for (?:a|an|the|my|our)\b|as a\b)\b/i.test(text);
  const hasGoal = /\b(goal|outcome|success|need|needs|want|wants|trying to|so that|in order to|because|purpose|objective)\b/i.test(text);
  const hasWhat = wordCount >= 5 && /\b(app|site|website|feature|bug|code|script|prompt|article|email|plan|analysis|design|strategy|dashboard|copy|report|video|lesson|outline|post|comparison|difference|point)\b/i.test(text);

  if (!hasAudience) missing.push('Who');
  if (!hasWhat) missing.push('What');
  if (!hasGoal) missing.push('Why');

  return missing;
}

function buildLocalVerdicts(promptText, missingContext) {
  const trimmed = (promptText || '').trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const preview = trimmed.length > 70 ? `${trimmed.slice(0, 67)}...` : trimmed;
  const verdicts = [];
  const hasFormat = /\b(table|bullet|bullets|json|list|step-by-step|steps|code|email|message|essay|outline|summary|format)\b/i.test(trimmed);
  const hasConstraint = /\b(exactly|under|at least|limit|constraints?|tone|style|formal|casual|concise|detailed|must|avoid)\b/i.test(trimmed);
  const hasExample = /\b(example|examples|sample|samples|for instance|like this)\b/i.test(trimmed);
  const hasReference = /\b(using|based on|from|according to|reference|context|background|stack|language|framework)\b/i.test(trimmed);

  if (missingContext.includes('What')) {
    verdicts.push(`What exactly should the AI produce beyond "${preview || 'this prompt'}"?`);
  }

  if (missingContext.includes('Who')) {
    verdicts.push('Who is this for, and what level of expertise should the answer assume?');
  }

  if (missingContext.includes('Why')) {
    verdicts.push('What outcome are you chasing, and how will you know the answer worked?');
  }

  if (words < 10) {
    verdicts.push('This prompt is still too thin. Add context, constraints, and a clearer ask.');
  }

  if (!hasFormat) {
    verdicts.push('You did not specify the response format, so the answer may come back generic.');
  }

  if (!hasConstraint) {
    verdicts.push('There is no real constraint here. Add tone, scope, limits, or must-include details.');
  }

  if (!hasExample) {
    verdicts.push('Ask for an example if you want the answer to be easier to understand or reuse.');
  }

  if (!hasReference) {
    verdicts.push('What background details, assumptions, or references is the AI supposed to use?');
  }

  if (/\?$/.test(trimmed) && words <= 12) {
    verdicts.push('This reads like a quick question, not a strong instruction. Turn it into a direct prompt.');
  }

  verdicts.push('What one detail would stop the answer from being vague?');
  verdicts.push('What would make the final response immediately useful for you today, not just informative?');

  return dedupeVerdicts(verdicts).slice(0, GHOST_VERDICT_COUNT);
}

function normalizePromptText(promptText) {
  let text = (promptText || '').replace(/\s+/g, ' ').trim();

  if (!text) return 'Help me improve this request.';

  text = text
    .replace(/^can you\s+/i, '')
    .replace(/^could you\s+/i, '')
    .replace(/^please\s+/i, '');

  text = text.charAt(0).toUpperCase() + text.slice(1);

  if (/^(Teach|Explain|Write|Draft|Fix|Compare|Summarize|Show|Help)\b/.test(text)) {
    text = text.replace(/\?$/, '.');
  }

  if (!/[.?!]$/.test(text)) {
    text += '.';
  }

  return text;
}

function looksLikePromptTemplate(text) {
  const raw = (text || '').trim();
  if (!raw) return true;

  const templateLabels = /(^|\n)\s*(task|deliverable|audience|goal|context|constraints|output format)\s*:/im;
  const placeholderLabels = /\[[^\]]+\]/;

  return templateLabels.test(raw) || placeholderLabels.test(raw);
}

function buildLocalPerfectPrompt(promptText, missingContext) {
  const text = normalizePromptText(promptText);
  const sentences = [text];

  if (missingContext.includes('Who')) {
    sentences.push('Assume the explanation should be beginner-friendly unless the topic clearly needs an advanced answer.');
  }

  if (missingContext.includes('Why')) {
    sentences.push('Make the answer practical and immediately useful, not generic.');
  }

  if (missingContext.includes('What')) {
    sentences.push('If the request is still ambiguous, make the most reasonable assumption and state it briefly before answering.');
  }

  if (/\b(compare|comparison|difference|differences|vs\b|versus|faster|slower|advantages|disadvantages)\b/i.test(text)) {
    sentences.push('Start with a plain-language comparison, then break down the main differences clearly.');
  } else if (/\b(teach|explain|understand|learn|what is|how does|why does)\b/i.test(text)) {
    sentences.push('Explain it simply first, then add a deeper explanation.');
  } else if (/\b(write|draft|email|message|essay|post|caption|article|script)\b/i.test(text)) {
    sentences.push('Write it in a polished, natural way that is ready to use.');
  } else if (/\b(code|bug|debug|fix|refactor|javascript|typescript|python|react|api|sql|css|html)\b/i.test(text)) {
    sentences.push('Give a concrete solution with clear steps and examples where useful.');
  } else {
    sentences.push('Give a precise answer with concrete details instead of a vague overview.');
  }

  sentences.push('Use at least one practical example.');
  sentences.push('Keep the response easy to scan.');

  return sentences.join(' ');
}

function sanitizePerfectPrompt(perfectPrompt, promptText, missingContext) {
  const candidate = cleanJsonEnvelope(perfectPrompt).replace(/\n{3,}/g, '\n\n').trim();

  if (!candidate || looksLikePromptTemplate(candidate)) {
    return buildLocalPerfectPrompt(promptText, missingContext);
  }

  return candidate;
}

function normalizeVerdicts(verdicts, promptText, missingContext) {
  const supplied = Array.isArray(verdicts) ? verdicts : [];
  const local = buildLocalVerdicts(promptText, missingContext);
  const merged = dedupeVerdicts([...supplied, ...local]);
  return merged.slice(0, GHOST_VERDICT_COUNT);
}

function buildGhostFallback(promptText, reason) {
  const missingContext = detectMissingContext(promptText);

  return {
    missingContext,
    verdicts: normalizeVerdicts([], promptText, missingContext),
    perfectPrompt: buildLocalPerfectPrompt(promptText, missingContext),
    meta: {
      source: 'local-fallback',
      reason: reason || 'The AI Oracle was unavailable, so the local 5-step judge took over.'
    }
  };
}

function parseGhostResult(resultText, promptText) {
  try {
    const parsed = JSON.parse(cleanJsonEnvelope(resultText));
    const missingContext = Array.isArray(parsed.missingContext) ? parsed.missingContext : [];

    return {
      missingContext,
      verdicts: normalizeVerdicts(parsed.verdicts, promptText, missingContext),
      perfectPrompt: sanitizePerfectPrompt(parsed.perfectPrompt || promptText, promptText, missingContext),
      meta: {
        source: 'remote'
      }
    };
  } catch (error) {
    console.error('Failed to parse Ghost API JSON:', error);
    return buildGhostFallback(promptText, 'The AI Oracle returned unreadable JSON, so the local 5-step judge took over.');
  }
}

async function handleGhostApiCall(promptText, sender, sendResponse) {
  const { frictionState } = await chrome.storage.local.get('frictionState');
  const state = ensureState(frictionState);
  const key = state.apiKey;
  let provider = state.apiProvider || 'gemini';
  const customModel = state.apiModel;
  const tabId = sender?.tab?.id;
  const progress = createGhostProgressReporter(tabId);

  if (key && key.startsWith('sk-or-')) {
    provider = 'openrouter';
  }

  if (!key) {
    const fallback = buildGhostFallback(promptText, 'Add an API key to use the remote Oracle. The local 5-step judge is active.');
    progress.finish('Judge ready', fallback.meta.reason);
    sendTabMessage(tabId, {
      type: 'GHOST_REFLECTION_READY',
      result: fallback
    });
    sendResponse({ success: false, fallback: true });
    return;
  }

  const systemInstruction = [
    'You are a prompt engineering judge.',
    'Return ONLY valid JSON with keys missingContext, verdicts, and perfectPrompt.',
    'missingContext must contain zero or more of: Who, What, Why.',
    `verdicts must contain exactly ${GHOST_VERDICT_COUNT} short critiques.`,
    'Each critique must be specific, direct, and useful for improving the prompt.',
    'perfectPrompt must be a final, ready-to-paste rewritten prompt based on the user request.',
    'Do not return headings like Task:, Audience:, Goal:, Context:, Constraints:, or Output format:.',
    'Do not use placeholders or square brackets.',
    'Do not return a template or structure outline.'
  ].join(' ');

  let resultText = '';
  let parsedResult;

  try {
    if (provider === 'gemini') {
      progress.send(22, 'Connecting to Gemini');
      const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 320
          }
        })
      });

      if (data.candidates && data.candidates.length > 0) {
        resultText = data.candidates[0].content.parts[0].text;
      }
    } else if (provider === 'openai' || provider === 'openrouter') {
      const isOpenRouter = provider === 'openrouter';
      const endpoint = isOpenRouter
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';
      const defaultModel = isOpenRouter ? 'openai/gpt-4o-mini' : 'gpt-4o-mini';
      const modelToUse = customModel || defaultModel;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      };

      if (isOpenRouter) {
        headers['HTTP-Referer'] = 'https://frictionmode.extension';
        headers['X-Title'] = 'Friction Mode';
      }

      progress.send(22, isOpenRouter ? 'Connecting to OpenRouter' : 'Connecting to OpenAI');
      const data = await fetchJson(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelToUse,
          temperature: 0.2,
          max_tokens: 320,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: promptText }
          ]
        })
      });

      if (data.choices && data.choices.length > 0) {
        resultText = data.choices[0].message.content;
      }
    } else if (provider === 'anthropic') {
      progress.send(22, 'Connecting to Anthropic');
      const data = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: customModel || 'claude-3-haiku-20240307',
          max_tokens: 320,
          temperature: 0.2,
          system: systemInstruction,
          messages: [
            { role: 'user', content: promptText }
          ]
        })
      });

      if (data.content && data.content.length > 0) {
        resultText = data.content[0].text;
      }
    } else {
      throw new Error(`Unsupported API provider: ${provider}`);
    }

    progress.send(96, 'Parsing judge output');
    parsedResult = parseGhostResult(resultText, promptText);
  } catch (error) {
    console.error('Ghost API Error:', error);
    parsedResult = buildGhostFallback(
      promptText,
      error?.name === 'AbortError'
        ? 'The remote Oracle took too long, so the local 5-step judge took over.'
        : 'The remote Oracle could not be reached, so the local 5-step judge took over.'
    );
  }

  progress.finish(
    'Judge ready',
    parsedResult?.meta?.source === 'local-fallback'
      ? parsedResult.meta.reason
      : 'Remote 5-step judge is ready.'
  );

  sendTabMessage(tabId, {
    type: 'GHOST_REFLECTION_READY',
    result: parsedResult
  });

  sendResponse({ success: true });
}

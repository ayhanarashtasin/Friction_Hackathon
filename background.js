/*
 * background.js - service worker that handles the 5-verdict Oracle calls
 * supports Gemini, OpenAI, OpenRouter, Anthropic. most of the pain is in the retry logic.
 */

// try to load local config.js (gitignored) so devs don't have to use the popup
try {
  importScripts('config.js');
} catch (_configErr) {
  // nope, no config.js - fall back to whatever the popup stored
}

const DEFAULT_STATE = {
  enabled: true,
  apiProvider: 'gemini',
  apiModel: '',
  apiKey: '',
  cooldownThreshold: 150
};

const GHOST_VERDICT_COUNT = 5;
const GHOST_STAGE_BLUEPRINT = [
  'Specify the core topic',
  'Provide the exact requirements',
  'Mention the tools, stack, or environment',
  'Share progress and the roadblock',
  'Define the desired answer format'
];
const GHOST_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts', 'perfectPrompt'],
  properties: {
    verdicts: {
      type: 'array',
      minItems: GHOST_VERDICT_COUNT,
      maxItems: GHOST_VERDICT_COUNT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'verdict'],
        properties: {
          title: { type: 'string' },
          verdict: { type: 'string' }
        }
      }
    },
    perfectPrompt: {
      type: 'string'
    }
  }
};

// Gemini chokes on additionalProperties in responseSchema so we strip it out here
const GHOST_RESPONSE_GEMINI_SCHEMA = {
  type: 'object',
  required: ['verdicts', 'perfectPrompt'],
  properties: {
    verdicts: {
      type: 'array',
      minItems: GHOST_VERDICT_COUNT,
      maxItems: GHOST_VERDICT_COUNT,
      items: {
        type: 'object',
        required: ['title', 'verdict'],
        properties: {
          title: { type: 'string' },
          verdict: { type: 'string' }
        }
      }
    },
    perfectPrompt: {
      type: 'string'
    }
  }
};

// OpenAI structured outputs barfs on minItems/maxItems - system prompt handles the count anyway
const GHOST_RESPONSE_OPENAI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts', 'perfectPrompt'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'verdict'],
        properties: {
          title: { type: 'string' },
          verdict: { type: 'string' }
        }
      }
    },
    perfectPrompt: {
      type: 'string'
    }
  }
};
const GHOST_REQUEST_TIMEOUT_MS = 45000;
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

  if (message.type === 'CLASSIFY_PASTE') {
    handleClassifyPaste(message.text, sender, sendResponse);
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

function getProviderLabel(provider) {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'anthropic') return 'Anthropic';
  return 'Gemini';
}

function formatGhostFailureReason(provider, error, fallbackLabel = 'local 5-verdict judge') {
  const providerLabel = getProviderLabel(provider);
  const detail = `${error?.message || ''}`.trim();

  if (!detail) {
    return `The remote ${providerLabel} Oracle could not be reached, so the ${fallbackLabel} took over.`;
  }

  return `${providerLabel} Oracle error: ${detail}. The ${fallbackLabel} took over.`;
}

async function fetchJson(url, options, timeoutMs = GHOST_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const rawText = await response.text();
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (_parseErr) {
      data = {};
    }

    if (!response.ok) {
      const baseMessage = data?.error?.message || data?.error?.type || `HTTP ${response.status}`;
      // OpenRouter loves burying the actual error in metadata.raw - dig it out so the user sees something useful
      const metadata = data?.error?.metadata;
      let extra = '';
      if (metadata) {
        const raw = typeof metadata.raw === 'string' ? metadata.raw : '';
        const providerName = metadata.provider_name ? ` [${metadata.provider_name}]` : '';
        if (raw) {
          const rawSnippet = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
          extra = `${providerName} ${rawSnippet}`.trim();
        } else if (providerName) {
          extra = providerName.trim();
        }
      }
      const details = extra ? `${baseMessage} - ${extra}` : baseMessage;
      const err = new Error(details);
      err.status = response.status;
      err.body = (rawText || '').slice(0, 500);
      throw err;
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

function extractFirstJsonObject(rawText) {
  const text = (rawText || '').trim();
  const start = text.indexOf('{');
  if (start === -1) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return '';
}

function parseJsonLenient(rawText) {
  const cleaned = cleanJsonEnvelope(rawText)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim();

  const candidates = [cleaned, extractFirstJsonObject(cleaned)].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {}
  }

  throw new Error('Unable to parse AI response as JSON.');
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

function inspectPrompt(promptText) {
  const text = (promptText || '').trim();
  const words = text ? text.split(/\s+/).length : 0;

  return {
    text,
    words,
    preview: text.length > 70 ? `${text.slice(0, 67)}...` : text,
    hasAudience: /\b(audience|persona|target user|reader|customer|client|stakeholder|manager|developer|designer|student|beginner|expert|team|for (?:a|an|the|my|our)\b|as a\b)\b/i.test(text),
    hasGoal: /\b(goal|outcome|success|need|needs|want|wants|trying to|so that|in order to|because|purpose|objective)\b/i.test(text),
    hasWhat: words >= 5 && /\b(app|site|website|feature|bug|code|script|prompt|article|email|plan|analysis|design|strategy|dashboard|copy|report|video|lesson|outline|post|comparison|difference|point)\b/i.test(text),
    hasFormat: /\b(table|bullet|bullets|json|list|step-by-step|steps|code|email|message|essay|outline|summary|format)\b/i.test(text),
    hasConstraint: /\b(exactly|under|at least|limit|constraints?|tone|style|formal|casual|concise|detailed|must|avoid)\b/i.test(text),
    hasExample: /\b(example|examples|sample|samples|for instance|like this)\b/i.test(text),
    hasReference: /\b(using|based on|from|according to|reference|context|background|stack|language|framework)\b/i.test(text),
    looksLikeQuestion: /\?$/.test(text) && words <= 12
  };
}

function detectMissingContext(promptText) {
  const signals = inspectPrompt(promptText);
  const missing = [];

  if (!signals.hasAudience) missing.push('Who');
  if (!signals.hasWhat) missing.push('What');
  if (!signals.hasGoal) missing.push('Why');

  return missing;
}

function buildLocalStages(promptText, missingContext) {
  const signals = inspectPrompt(promptText);
  const preview = signals.preview || 'this prompt';

  return [
    {
      stage: GHOST_STAGE_BLUEPRINT[0],
      verdict: missingContext.includes('What')
        ? `State exactly which part of "${preview}" you need help with so the AI knows the real topic.`
        : signals.words < 10 || signals.looksLikeQuestion
          ? 'Narrow the prompt down to one specific task, deliverable, or concept instead of leaving it broad.'
          : 'Tighten the main topic so the AI cannot misread what you actually want.'
    },
    {
      stage: GHOST_STAGE_BLUEPRINT[1],
      verdict: missingContext.includes('Who')
        ? 'Paste the assignment instructions, constraints, or success criteria so the AI can target the real requirement.'
        : 'Add the exact requirements, constraints, or grading expectations that the answer must satisfy.'
    },
    {
      stage: GHOST_STAGE_BLUEPRINT[2],
      verdict: missingContext.includes('Why')
        ? 'Tell the AI what tools, platform, language, or environment this work belongs to so the answer fits your setup.'
        : 'Mention the relevant tools, language, platform, or environment so the answer becomes more concrete.'
    },
    {
      stage: GHOST_STAGE_BLUEPRINT[3],
      verdict: !signals.hasReference && !signals.hasConstraint
        ? 'Explain what you already tried and where you are stuck so the AI can help with the real roadblock.'
        : !signals.hasExample
          ? 'Share your current progress and the exact point of confusion so the AI does not waste time repeating basics.'
          : 'Point out the current roadblock or confusion so the advice can be targeted instead of generic.'
    },
    {
      stage: GHOST_STAGE_BLUEPRINT[4],
      verdict: !signals.hasFormat
        ? 'Specify how you want the answer delivered, such as bullet points, step-by-step guidance, code, or an outline.'
        : 'Define the final answer format more clearly so the output comes back in the exact shape you need.'
    }
  ];
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

function normalizeMissingContext(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeStageLabel(stageName, index) {
  const raw = `${stageName || ''}`.trim();
  if (!raw) return `Verdict ${index + 1}`;
  return raw;
}

function coerceStageEntry(entry, index) {
  if (typeof entry === 'string') {
    return {
      stage: `Verdict ${index + 1}`,
      verdict: entry.trim()
    };
  }

  if (!entry || typeof entry !== 'object') return null;

  const verdict = entry.verdict || entry.question || entry.critique || entry.text || entry.message || entry.feedback || '';
  return {
    stage: normalizeStageLabel(entry.stage || entry.title || entry.name || entry.label, index),
    verdict: typeof verdict === 'string' ? verdict.trim() : ''
  };
}

function extractVerdictArray(parsed) {
  if (Array.isArray(parsed?.verdicts)) return parsed.verdicts;
  if (Array.isArray(parsed?.critiques)) return parsed.critiques;
  if (Array.isArray(parsed?.judgments)) return parsed.judgments;

  if (Array.isArray(parsed?.stages)) {
    return parsed.stages
      .map((stage) => {
        if (typeof stage === 'string') return stage;
        return stage?.verdict || stage?.critique || stage?.text || stage?.message || '';
      })
      .filter(Boolean);
  }

  const grouped = parsed?.verdicts || parsed?.critiques || parsed?.judgments;
  if (grouped && typeof grouped === 'object') {
    return Object.keys(grouped)
      .sort()
      .map((key) => grouped[key])
      .filter((value) => typeof value === 'string' && value.trim());
  }

  const numberedKeys = Object.keys(parsed || {})
    .filter((key) => /^verdict[_ ]?\d+$/i.test(key) || /^critique[_ ]?\d+$/i.test(key))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (numberedKeys.length > 0) {
    return numberedKeys.map((key) => parsed[key]).filter((value) => typeof value === 'string' && value.trim());
  }

  return [];
}

function extractStageArray(parsed) {
  if (Array.isArray(parsed?.stages)) {
    return parsed.stages
      .map((entry, index) => coerceStageEntry(entry, index))
      .filter((entry) => entry?.verdict);
  }

  const verdicts = extractVerdictArray(parsed);
  return verdicts
    .map((entry, index) => coerceStageEntry(entry, index))
    .filter((entry) => entry?.verdict);
}

function extractPerfectPrompt(parsed, promptText) {
  return parsed?.perfectPrompt
    || parsed?.perfect_prompt
    || parsed?.rewrittenPrompt
    || parsed?.rewritten_prompt
    || parsed?.improvedPrompt
    || parsed?.improved_prompt
    || promptText;
}

function extractPerfectPromptFromText(resultText, promptText) {
  const text = cleanJsonEnvelope(resultText).replace(/\r/g, '').trim();
  const patterns = [
    /(?:perfect|improved|rewritten)\s+prompt\s*[:\-]\s*([\s\S]+)$/i,
    /final\s+prompt\s*[:\-]\s*([\s\S]+)$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return promptText;
}

function extractNumberedStages(resultText) {
  const text = cleanJsonEnvelope(resultText).replace(/\r/g, '').trim();
  const matches = [...text.matchAll(/(?:^|\n)\s*(\d+)[.)]\s+([^\n]+)([\s\S]*?)(?=(?:\n\s*\d+[.)]\s+)|$)/g)];

  if (matches.length === 0) return [];

  return matches.slice(0, GHOST_VERDICT_COUNT).map((match, index) => {
    const title = (match[2] || '').trim();
    const body = (match[3] || '').trim().replace(/\n{3,}/g, '\n\n');

    return {
      stage: title || `Verdict ${index + 1}`,
      verdict: body || title || ''
    };
  }).filter((entry) => entry.verdict);
}

function extractBulletStages(resultText) {
  const text = cleanJsonEnvelope(resultText).replace(/\r/g, '').trim();
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^[*-]\s+|^•\s+/.test(line))
    .map((line) => line.replace(/^[*-]\s+|^•\s+/, '').trim());

  if (lines.length < GHOST_VERDICT_COUNT) return [];

  return lines.slice(0, GHOST_VERDICT_COUNT).map((line, index) => ({
    stage: `Verdict ${index + 1}`,
    verdict: line
  }));
}

function extractBulletStagesNormalized(resultText) {
  const text = cleanJsonEnvelope(resultText).replace(/\r/g, '').trim();
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^[-*•]\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, '').trim());

  if (lines.length < GHOST_VERDICT_COUNT) return [];

  return lines.slice(0, GHOST_VERDICT_COUNT).map((line, index) => ({
    stage: `Verdict ${index + 1}`,
    verdict: line
  }));
}

function normalizeVerdicts(verdicts, promptText, missingContext) {
  const supplied = Array.isArray(verdicts) ? verdicts : [];
  const local = buildLocalStages(promptText, missingContext).map((stage) => stage.verdict);
  const merged = dedupeVerdicts([...supplied, ...local]);
  return merged.slice(0, GHOST_VERDICT_COUNT);
}

function normalizeStages(stages, promptText, missingContext) {
  const fallback = buildLocalStages(promptText, missingContext);

  return fallback.map((fallbackStage, index) => {
    const candidate = coerceStageEntry(stages?.[index], index);
    return {
      stage: candidate?.stage || fallbackStage.stage,
      verdict: candidate?.verdict || fallbackStage.verdict
    };
  });
}

function buildGhostFallback(promptText, reason) {
  const missingContext = detectMissingContext(promptText);
  const stages = buildLocalStages(promptText, missingContext);

  return {
    missingContext,
    stages,
    verdicts: stages.map((stage) => stage.verdict),
    perfectPrompt: buildLocalPerfectPrompt(promptText, missingContext),
    meta: {
      source: 'local-fallback',
      reason: reason || 'The AI Oracle was unavailable, so the local 5-verdict judge took over.'
    }
  };
}

function parseGhostResult(resultText, promptText) {
  const localMissingContext = detectMissingContext(promptText);

  try {
    const parsed = parseJsonLenient(resultText);
    const missingContext = normalizeMissingContext(parsed.missingContext || parsed.missing_context);
    const effectiveMissingContext = missingContext.length ? missingContext : localMissingContext;
    const stages = normalizeStages(extractStageArray(parsed), promptText, effectiveMissingContext);

    return {
      missingContext: effectiveMissingContext,
      stages,
      verdicts: stages.map((stage) => stage.verdict),
      perfectPrompt: sanitizePerfectPrompt(extractPerfectPrompt(parsed, promptText), promptText, effectiveMissingContext),
      meta: {
        source: 'remote'
      }
    };
  } catch (error) {
    console.error('Failed to parse Ghost API JSON:', error);

    const textStages = extractStageArray({ verdicts: extractNumberedStages(resultText) });
    const bulletStages = textStages.length ? [] : extractStageArray({ verdicts: extractBulletStagesNormalized(resultText) });
    const extractedStages = textStages.length ? textStages : bulletStages;

    if (extractedStages.length > 0) {
      const stages = normalizeStages(extractedStages, promptText, localMissingContext);
      return {
        missingContext: localMissingContext,
        stages,
        verdicts: stages.map((stage) => stage.verdict),
        perfectPrompt: sanitizePerfectPrompt(
          extractPerfectPromptFromText(resultText, promptText),
          promptText,
          localMissingContext
        ),
        meta: {
          source: 'remote'
        }
      };
    }

    return buildGhostFallback(promptText, 'The AI Oracle returned unreadable verdicts, so the local 5-verdict judge took over.');
  }
}

function buildGhostUserPrompt(promptText) {
  return [
    'Please analyze the user prompt enclosed in <user_prompt> tags.',
    'Give me exactly 5 verdicts that help the user improve this prompt before sending it to AI.',
    'Each verdict must have a short title and a tailored explanation.',
    'Make the verdicts concrete, varied, and specific to this exact prompt.',
    'Then write one improved final prompt the user could copy and submit immediately.',
    '',
    '<user_prompt>',
    promptText,
    '</user_prompt>'
  ].join('\n');
}

function extractJoinedText(parts) {
  return (parts || [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

// OpenRouter reasoning_details shape changes per provider - just grab whatever text we can find
function extractReasoningDetailsText(details) {
  if (!Array.isArray(details) || details.length === 0) return '';

  return details
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!entry || typeof entry !== 'object') return '';
      return entry.text
        || entry.content
        || entry.summary
        || entry.response
        || '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractAssistantMessageText(content) {
  if (typeof content === 'string') return content.trim();

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        return item?.text || item?.content || '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

async function handleGhostApiCall(promptText, sender, sendResponse) {
  const { frictionState } = await chrome.storage.local.get('frictionState');
  const state = ensureState(frictionState);

  // if config.js has a value it wins over popup state
  const config = (typeof self !== 'undefined' && self.FRICTION_CONFIG) || {};
  const key = config.apiKey || state.apiKey;
  let provider = config.apiProvider || state.apiProvider || 'gemini';
  const customModel = config.apiModel || state.apiModel;
  const tabId = sender?.tab?.id;

  const progress = createGhostProgressReporter(tabId);

  // sniff the key prefix so users don't get "Missing Authentication" when they picked the wrong provider in the popup
  if (key) {
    if (key.startsWith('sk-or-')) {
      provider = 'openrouter';
    } else if (key.startsWith('AIza')) {
      provider = 'gemini';
    } else if (key.startsWith('sk-ant-')) {
      provider = 'anthropic';
    } else if (key.startsWith('sk-')) {
      provider = 'openai';
    }
  }

  if (!key) {
    const fallback = buildGhostFallback(promptText, 'No API key found. Paste your OpenRouter key into config.js (apiKey field) and reload the extension. The local 5-verdict judge is active in the meantime.');
    progress.finish('Judge ready', fallback.meta.reason);
    sendTabMessage(tabId, {
      type: 'GHOST_REFLECTION_READY',
      result: fallback
    });
    sendResponse({ success: false, fallback: true });
    return;
  }

  const verdictExamples = GHOST_STAGE_BLUEPRINT
    .map((item, index) => `${index + 1}. ${item}`)
    .join(' ');

  const systemInstruction = [
    'You are a prompt improvement judge.',
    'For any user prompt, think like a human mentor who wants the user to improve that prompt before sending it to AI.',
    'Return ONLY valid JSON with keys verdicts and perfectPrompt.',
    `verdicts must contain exactly ${GHOST_VERDICT_COUNT} items.`,
    'Each verdict item must be an object with title and verdict.',
    'Each title must be short, distinct, and useful.',
    'Each verdict must be specific, direct, useful, and tailored to the exact user prompt.',
    'Do not reuse the same canned wording for every prompt.',
    `Examples of useful verdict angles: ${verdictExamples}`,
    'perfectPrompt must be a final, ready-to-paste rewritten prompt based on the user request.',
    'IMPORTANT: The perfectPrompt MUST ONLY contain the improved user prompt. Do NOT include any instructions about "5 verdicts" or "improve this prompt" inside the perfectPrompt. The perfectPrompt is what the user will send to the AI for their actual task.',
    'Do not return headings like Task:, Audience:, Goal:, Context:, Constraints:, or Output format: in perfectPrompt.',
    'Do not use placeholders or square brackets.',
    'Do not return a template or structure outline.',
    'Do not wrap the JSON in markdown fences.',
    'If the prompt is already decent, still return 5 useful verdicts that make it sharper.',
    'Example output schema: {"verdicts":[{"title":"Specify the core topic","verdict":"State exactly which part needs help so the answer stays focused."},{"title":"Provide the exact requirements","verdict":"Add the real instructions, constraints, or grading criteria."},{"title":"Mention the tools or environment","verdict":"Say which language, platform, or tooling the answer should assume."},{"title":"Share your progress and roadblock","verdict":"Explain what you already tried and where you are stuck."},{"title":"Define the desired format","verdict":"Say whether you want bullets, steps, code, or an outline."}],"perfectPrompt":"..."}'
  ].join(' ');
  const userInstruction = buildGhostUserPrompt(promptText);

  let resultText = '';
  let parsedResult;

  try {
    if (provider === 'gemini') {
      const modelToUse = customModel || 'gemini-2.5-flash';
      progress.send(22, 'Connecting to Gemini');
      const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: [{ parts: [{ text: userInstruction }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 800,
            responseMimeType: 'application/json',
            responseSchema: GHOST_RESPONSE_GEMINI_SCHEMA
          }
        })
      });

      if (data.candidates && data.candidates.length > 0) {
        resultText = extractJoinedText(data.candidates[0]?.content?.parts);
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

      const requestBody = {
        model: modelToUse,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userInstruction }
        ]
      };

      if (isOpenRouter) {
        // reasoning models on OpenRouter hate temperature and burn tokens thinking silently, so we bump max_tokens and drop temp
        requestBody.max_tokens = 4000;
      } else {
        requestBody.temperature = 0.2;
        requestBody.max_tokens = 1200;
        requestBody.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'friction_mode_verdicts',
            strict: true,
            schema: GHOST_RESPONSE_OPENAI_SCHEMA
          }
        };
      }

      progress.send(22, isOpenRouter ? 'Connecting to OpenRouter' : 'Connecting to OpenAI');

      let data;
      try {
        data = await fetchJson(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody)
        });
      } catch (firstErr) {
        const message = firstErr?.message || '';
        const body = firstErr?.body || '';
        const status = firstErr?.status;

        // OpenAI rejected json_schema (usually gpt-4-turbo), retry plain old text
        const isSchemaRejection = !isOpenRouter
          && requestBody.response_format
          && (status === 400
            || /response_format|json_schema|schema|unsupported|invalid_request_error/i.test(message)
            || /response_format|json_schema|schema|unsupported/i.test(body));

        // free OpenRouter models flake constantly - 429/502/etc, one retry usually saves it
        const isOpenRouterFlake = isOpenRouter
          && (status === 429 || status === 502 || status === 503 || status === 504
            || /provider returned error|upstream|timeout|temporar|overloaded|rate.?limit/i.test(message)
            || /provider returned error|upstream|timeout|overloaded/i.test(body));

        if (isSchemaRejection) {
          console.warn('[Friction] OpenAI rejected strict schema; retrying plain.', { model: modelToUse, status });
          delete requestBody.response_format;
          data = await fetchJson(endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody) });
        } else if (isOpenRouterFlake) {
          console.warn('[Friction] OpenRouter flake; retrying once.', { model: modelToUse, status });
          await new Promise((resolve) => setTimeout(resolve, 750));
          data = await fetchJson(endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody) });
        } else {
          throw firstErr;
        }
      }

      if (data.choices && data.choices.length > 0) {
        const choice = data.choices[0] || {};
        const msg = choice.message || {};
        resultText = extractAssistantMessageText(msg.content);

        // o1/deepseek-r1 sometimes puts the answer in reasoning fields instead of content, gotta check all the weird keys
        if (!resultText.trim()) {
          resultText = extractAssistantMessageText(msg.reasoning)
            || extractAssistantMessageText(msg.reasoning_content)
            || extractAssistantMessageText(msg.text)
            || extractReasoningDetailsText(msg.reasoning_details)
            || '';
        }

        // still nothing? probably hit max_tokens on a reasoning model, throw a helpful error for the overlay
        if (!resultText.trim()) {
          const finish = choice.finish_reason || choice.native_finish_reason || 'unknown';
          const usage = data.usage || {};
          const hint = finish === 'length'
            ? 'The model hit max_tokens before producing any output (common with reasoning models). Try a non-reasoning model like meta-llama/llama-3.3-70b-instruct:free.'
            : `Model "${modelToUse}" returned no text. Verify the model id at openrouter.ai/models, or try meta-llama/llama-3.3-70b-instruct:free.`;
          const err = new Error(`Empty response (finish_reason=${finish}, tokens=${usage.completion_tokens ?? '?'}). ${hint}`);
          err.status = 200;
          err.body = JSON.stringify(data).slice(0, 500);
          throw err;
        }
      } else if (data.error) {
        // some providers send 200 with an error in the body instead of a proper 4xx, fun
        const err = new Error(data.error?.message || 'OpenRouter returned an error with no choices.');
        err.status = 200;
        err.body = JSON.stringify(data).slice(0, 500);
        throw err;
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
          max_tokens: 800,
          temperature: 0.2,
          system: systemInstruction,
          messages: [
            { role: 'user', content: userInstruction }
          ]
        })
      });

      if (data.content && data.content.length > 0) {
        resultText = extractJoinedText(data.content);
      }
    } else {
      throw new Error(`Unsupported API provider: ${provider}`);
    }

    if (!resultText.trim()) {
      throw new Error('The provider returned an empty response');
    }

    progress.send(96, 'Parsing judge output');
    parsedResult = parseGhostResult(resultText, promptText);
  } catch (error) {
    console.error('[Friction] Oracle request failed.', { provider, status: error?.status, message: error?.message });
    parsedResult = buildGhostFallback(
      promptText,
      error?.name === 'AbortError'
        ? `The remote ${getProviderLabel(provider)} Oracle took too long, so the local 5-verdict judge took over.`
        : formatGhostFailureReason(provider, error)
    );
  }

  progress.finish(
    'Judge ready',
    parsedResult?.meta?.source === 'local-fallback'
      ? parsedResult.meta.reason
      : 'Remote 5-verdict judge is ready.'
  );

  sendTabMessage(tabId, {
    type: 'GHOST_REFLECTION_READY',
    result: parsedResult
  });

  sendResponse({ success: true });
}

async function handleClassifyPaste(pastedText, sender, sendResponse) {
  const { frictionState } = await chrome.storage.local.get('frictionState');
  const state = ensureState(frictionState);
  const config = (typeof self !== 'undefined' && self.FRICTION_CONFIG) || {};
  const key = config.apiKey || state.apiKey;
  let provider = config.apiProvider || state.apiProvider || 'gemini';
  const customModel = config.apiModel || state.apiModel;
  const tabId = sender?.tab?.id;

  if (key) {
    if (key.startsWith('sk-or-')) provider = 'openrouter';
    else if (key.startsWith('AIza')) provider = 'gemini';
    else if (key.startsWith('sk-ant-')) provider = 'anthropic';
    else if (key.startsWith('sk-')) provider = 'openai';
  }

  if (!key) {
    sendTabMessage(tabId, { type: 'PASTE_CLASSIFIED', classification: 'unknown', error: true });
    sendResponse({ success: false, error: 'No API key' });
    return;
  }

  const truncated = (pastedText || '').slice(0, 2000);
  const prompt = `Classify the following content as either 'code' or 'text'. Return exactly one word: code or text.\n\nContent:\n${truncated}`;

  try {
    let resultText = '';

    if (provider === 'gemini') {
      const modelToUse = customModel || 'gemini-2.5-flash';
      const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 10
          }
        })
      });
      if (data.candidates && data.candidates.length > 0) {
        resultText = extractJoinedText(data.candidates[0]?.content?.parts);
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
      const data = await fetchJson(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelToUse,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 10,
          temperature: 0.1
        })
      });
      if (data.choices && data.choices.length > 0) {
        resultText = extractAssistantMessageText(data.choices[0]?.message?.content);
      }
    } else if (provider === 'anthropic') {
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
          max_tokens: 10,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (data.content && data.content.length > 0) {
        resultText = extractJoinedText(data.content);
      }
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    const normalized = (resultText || '').toLowerCase().trim();
    let classification = 'unknown';
    if (normalized.includes('code')) classification = 'code';
    else if (normalized.includes('text')) classification = 'text';

    sendTabMessage(tabId, { type: 'PASTE_CLASSIFIED', classification });
    sendResponse({ success: true, classification });
  } catch (error) {
    console.error('[Friction] Paste classification failed.', { provider, message: error?.message });
    sendTabMessage(tabId, { type: 'PASTE_CLASSIFIED', classification: 'unknown', error: true });
    sendResponse({ success: false, error: error?.message });
  }
}

const DEFAULT_STATE = {
  enabled: true,
  cooldownThreshold: 150
};

let currentState = { ...DEFAULT_STATE };

document.addEventListener('DOMContentLoaded', async () => {
  currentState = await loadState();
  renderUI(currentState);
  bindControls();
  initDna();
});

async function loadState() {
  const { frictionState } = await chrome.storage.local.get('frictionState');
  const merged = {
    ...DEFAULT_STATE,
    ...(frictionState || {})
  };

  // old builds stored keys in frictionState, now they live in config.js. clean up so we don't leak creds by accident
  const hadLegacy = 'apiKey' in merged || 'apiProvider' in merged || 'apiModel' in merged;
  if (hadLegacy) {
    delete merged.apiKey;
    delete merged.apiProvider;
    delete merged.apiModel;
    await chrome.storage.local.set({ frictionState: merged });
  } else if (!frictionState) {
    await chrome.storage.local.set({ frictionState: merged });
  }

  return merged;
}

async function saveState(nextState) {
  currentState = {
    ...DEFAULT_STATE,
    ...currentState,
    ...nextState
  };

  await chrome.storage.local.set({ frictionState: currentState });
}

function renderUI(state) {
  document.getElementById('master-enabled').checked = !!state.enabled;

  const threshold = state.cooldownThreshold || 150;
  const slider = document.getElementById('cooldown-threshold');
  const valueEl = document.getElementById('threshold-value');
  if (slider) slider.value = threshold;
  if (valueEl) valueEl.textContent = `${threshold} words`;

  updateStatusBanner(state.enabled);
}

function bindControls() {
  document.getElementById('master-enabled').addEventListener('change', async (e) => {
    await saveState({ enabled: e.target.checked });
    updateStatusBanner(e.target.checked);
  });

  const slider = document.getElementById('cooldown-threshold');
  const valueEl = document.getElementById('threshold-value');

  if (slider) {
    slider.addEventListener('input', () => {
      const val = parseInt(slider.value, 10);
      if (valueEl) valueEl.textContent = `${val} words`;
    });

    slider.addEventListener('change', async () => {
      const val = parseInt(slider.value, 10);
      await saveState({ cooldownThreshold: val });
    });
  }
}

function updateStatusBanner(enabled) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url || '';
    let platform = '';

    if (url.includes('chatgpt.com') || url.includes('openai.com')) {
      platform = 'ChatGPT';
    } else if (url.includes('claude.ai')) {
      platform = 'Claude';
    } else if (url.includes('gemini.google.com')) {
      platform = 'Gemini';
    }

    if (!enabled) {
      dot.className = 'status-dot off';
      text.textContent = 'Friction Mode is off';
      return;
    }

    if (platform) {
      dot.className = 'status-dot on';
      text.textContent = `Active on ${platform}`;
      return;
    }

    dot.className = 'status-dot idle';
    text.textContent = 'Open ChatGPT, Claude, or Gemini';
  });
}

/*
 * Prompt DNA dashboard - renders the radar, score ring, sparkline, etc from
 * whatever content.js has been dumping into storage
 */
const DNA_STORAGE_KEY = 'frictionDNA';

function initDna() {
  renderDna();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[DNA_STORAGE_KEY]) renderDna();
    });
  } catch (error) {}

  const resetBtn = document.getElementById('dna-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Reset your Prompt DNA stats? This cannot be undone.')) return;
      try {
        await chrome.storage.local.remove(DNA_STORAGE_KEY);
      } catch (error) {}
      renderDna();
    });
  }
}

async function renderDna() {
  let raw;
  try {
    const res = await chrome.storage.local.get(DNA_STORAGE_KEY);
    raw = res[DNA_STORAGE_KEY];
  } catch (error) {}

  const data = normalizeDna(raw);
  const metrics = computeDnaMetrics(data);
  paintDnaScore(metrics.score);
  paintDnaRadar(metrics.radar);
  paintDnaStats(data, metrics);
  paintDnaSparkline(data);
  paintDnaInsight(data, metrics);
}

function normalizeDna(raw) {
  const base = {
    version: 1,
    firstUseDate: new Date().toISOString().slice(0, 10),
    totals: {
      promptsSeen: 0, submissions: 0, edits: 0,
      wordsBefore: 0, wordsAfter: 0,
      missingWho: 0, missingWhat: 0, missingWhy: 0,
      vagueVerbs: 0, antiPasteTriggers: 0,
      cooldownTriggers: 0, aiVersionsChosen: 0
    },
    daily: {}
  };
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    totals: { ...base.totals, ...(raw.totals || {}) },
    daily: raw.daily && typeof raw.daily === 'object' ? raw.daily : {}
  };
}

function computeDnaMetrics(data) {
  const t = data.totals;
  const n = Math.max(1, t.promptsSeen);
  const subs = Math.max(1, t.submissions);

  const clarity    = clamp01(1 - t.missingWhat / n) * 100;
  const context    = clamp01(1 - t.missingWho  / n) * 100;
  const purpose    = clamp01(1 - t.missingWhy  / n) * 100;
  const specificity= clamp01(1 - t.vagueVerbs  / n) * 100;
  const discipline = clamp01(1 - (t.cooldownTriggers + t.antiPasteTriggers) / subs) * 100;

  const radar = { clarity, context, purpose, specificity, discipline };

  // average the 5 axes, give a tiny bonus if the user actually bothers to edit their prompts
  const avg = (clarity + context + purpose + specificity + discipline) / 5;
  const editRate = t.submissions > 0 ? t.edits / t.submissions : 0;
  const score = t.promptsSeen === 0 ? 0 : Math.round(clamp01(avg / 100 + editRate * 0.05) * 100);

  return { radar, score, editRate };
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function paintDnaScore(score) {
  const valueEl = document.getElementById('dna-score-value');
  const ring = document.getElementById('dna-ring-fill');
  if (valueEl) valueEl.textContent = score > 0 ? String(score) : '--';

  if (ring) {
    const r = 52;
    const circumference = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(100, score)) / 100;
    ring.style.strokeDasharray = String(circumference);
    ring.style.strokeDashoffset = String(circumference * (1 - pct));

    const color = score >= 75 ? '#1fb08b' : score >= 45 ? '#f0b24a' : '#ff845f';
    ring.style.stroke = color;
    if (valueEl) valueEl.style.color = color;
  }
}

function paintDnaRadar(radar) {
  const shape = document.getElementById('dna-radar-shape');
  if (!shape) return;

  const values = [radar.clarity, radar.context, radar.purpose, radar.specificity, radar.discipline];
  // pentagon points start straight up and go clockwise
  const angles = [-Math.PI / 2, -Math.PI / 2 + (2 * Math.PI) / 5, -Math.PI / 2 + (4 * Math.PI) / 5,
                  -Math.PI / 2 + (6 * Math.PI) / 5, -Math.PI / 2 + (8 * Math.PI) / 5];

  const points = values.map((v, i) => {
    const r = (Math.max(0, Math.min(100, v)) / 100) * 100;
    const x = r * Math.cos(angles[i]);
    const y = r * Math.sin(angles[i]);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  shape.setAttribute('points', points);
}

function paintDnaStats(data, metrics) {
  const promptsEl = document.getElementById('dna-stat-prompts');
  const editsEl = document.getElementById('dna-stat-edits');
  const streakEl = document.getElementById('dna-stat-streak');

  if (promptsEl) promptsEl.textContent = String(data.totals.promptsSeen);
  if (editsEl) editsEl.textContent = data.totals.submissions > 0
    ? `${Math.round(metrics.editRate * 100)}%`
    : '--';
  if (streakEl) streakEl.textContent = String(computeStreak(data.daily));
}

function computeStreak(daily) {
  let streak = 0;
  const day = new Date();
  for (let i = 0; i < 60; i += 1) {
    const key = day.toISOString().slice(0, 10);
    const entry = daily[key];
    if (entry && entry.prompts > 0) {
      streak += 1;
    } else if (i === 0) {
      // today being empty is fine, start counting from yesterday
    } else {
      break;
    }
    day.setDate(day.getDate() - 1);
  }
  return streak;
}

function paintDnaSparkline(data) {
  const svg = document.getElementById('dna-spark');
  if (!svg) return;

  const days = [];
  const cursor = new Date();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(cursor);
    d.setDate(cursor.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, prompts: (data.daily[key] && data.daily[key].prompts) || 0 });
  }

  const max = Math.max(1, ...days.map((d) => d.prompts));
  const barW = 140 / 7;
  const gap = 3;

  svg.innerHTML = days.map((d, i) => {
    const h = Math.max(2, (d.prompts / max) * 28);
    const x = i * barW + gap / 2;
    const y = 30 - h;
    const w = barW - gap;
    const cls = d.prompts > 0 ? 'dna-spark-bar dna-spark-bar-on' : 'dna-spark-bar';
    return `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2"></rect>`;
  }).join('');
}

function paintDnaInsight(data, metrics) {
  const el = document.getElementById('dna-insight');
  if (!el) return;

  const t = data.totals;
  if (t.promptsSeen === 0) {
    el.textContent = 'Send your first prompt to build your Prompt DNA.';
    return;
  }

  const dims = [
    { name: 'Context (Who)',  key: 'context',    tip: 'Name the audience or persona in your prompts (e.g., "for a beginner", "as a hiring manager").' },
    { name: 'Clarity (What)', key: 'clarity',    tip: 'State the exact deliverable up front, e.g. "a 200-word summary", "a SQL query", or "5 headline options".' },
    { name: 'Purpose (Why)',  key: 'purpose',    tip: 'Explain the goal or outcome so the AI optimizes for the right thing.' },
    { name: 'Specificity',    key: 'specificity', tip: 'Replace vague verbs like "help", "fix", "make it better" with precise actions.' },
    { name: 'Discipline',     key: 'discipline', tip: 'Slow down between prompts and summarize long pastes before sending.' }
  ];
  const worst = dims.reduce((a, b) => (metrics.radar[a.key] <= metrics.radar[b.key] ? a : b));
  const worstScore = Math.round(metrics.radar[worst.key]);

  if (metrics.score >= 85) {
    el.textContent = `Strong DNA (${metrics.score}/100). Keep sharpening ${worst.name.toLowerCase()}.`;
  } else {
    el.innerHTML = `<strong>Weakest: ${worst.name} (${worstScore}/100).</strong> ${worst.tip}`;
  }
}

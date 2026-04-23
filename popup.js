const DEFAULT_STATE = {
  enabled: true,
  apiProvider: 'gemini',
  apiModel: '',
  apiKey: ''
};

let currentState = { ...DEFAULT_STATE };

document.addEventListener('DOMContentLoaded', async () => {
  currentState = await loadState();
  renderUI(currentState);
  bindControls();
});

async function loadState() {
  const { frictionState } = await chrome.storage.local.get('frictionState');
  const merged = {
    ...DEFAULT_STATE,
    ...(frictionState || {})
  };

  if (!frictionState) {
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
  document.getElementById('api-provider').value = state.apiProvider || 'gemini';
  document.getElementById('api-model').value = state.apiModel || '';
  document.getElementById('api-key').value = state.apiKey || '';
  updateStatusBanner(state.enabled);
}

function bindControls() {
  document.getElementById('master-enabled').addEventListener('change', async (e) => {
    await saveState({ enabled: e.target.checked });
    updateStatusBanner(e.target.checked);
  });

  document.getElementById('save-api-btn').addEventListener('click', async () => {
    const provider = document.getElementById('api-provider').value;
    const model = document.getElementById('api-model').value.trim();
    const key = document.getElementById('api-key').value.trim();
    const statusEl = document.getElementById('api-status-msg');
    const button = document.getElementById('save-api-btn');

    button.textContent = 'Saving...';
    await saveState({
      apiProvider: provider,
      apiModel: model,
      apiKey: key
    });

    button.textContent = 'Save Oracle Settings';
    statusEl.textContent = key
      ? 'Oracle settings saved.'
      : 'Saved. The local 5-step judge will be used until an API key is added.';

    setTimeout(() => {
      statusEl.textContent = '';
    }, 3000);
  });
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

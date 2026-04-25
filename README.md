# Friction Mode

A Chrome extension that adds **intentional friction** between you and the AI,
because the best prompts are rarely the first ones that come to mind.

Works on **ChatGPT**, **Claude**, and **Gemini**.

> Bad prompts usually come from zero resistance.
> A small amount of friction produces better intent, better context, and better outputs.

---

## The five engines

Friction Mode is built around five small engines that fire at the right moment,
not all at once. Every engine is local-first; the AI Oracle is optional.

### 1. AI 5-Verdict Judge

When you hit send, Friction Mode intercepts the submit and asks a remote
"Oracle" (your configured LLM) to return **five named verdicts** that
critique your prompt, plus a rewritten "perfect prompt".

While the Oracle thinks, you can already edit your own prompt. You then:

1. Step through the 5 verdicts one by one.
2. Land on a side-by-side comparison — your revised prompt vs. the Oracle's rewrite.
3. Submit whichever is stronger.

If no API key is configured, a local 5-verdict fallback judge kicks in so the
flow still works offline.

### 2. Anti-Paste Engine

Paste more than ~300 characters and the normal "Send" flow is blocked. The
overlay opens immediately with a generic message while a lightweight background
API call classifies the paste as **code** or **text**.

- **Code detected** — you're prompted to specify the exact error or behavior
  you want fixed.
- **Text detected** — you're asked to explain what you want the AI to do with
  the content (summarize, rewrite, analyze, etc.).

Only after you write a short clarifying sentence does the submission go through,
with your summary prepended as user context.

This stops the classic "paste wall of text, type 'fix this', hope for the best"
anti-pattern.

### 3. Context Keeper

A persistent floating badge tracks how much of the AI's context window you've
used in the current conversation. Click it to open a detailed panel showing:

- **Words used / model limit** (ChatGPT ~96K, Claude ~150K, Gemini ~750K)
- **Context percentage** with color-coded status
- Per-model breakdown so you know when you're approaching the wall

The badge lives in the corner and updates live as you send and receive messages.

### 4. Cognitive Cooldown

Friction Mode keeps a rolling **session word count** of every prompt you
send. When it crosses a configurable threshold (default 150 words, slider range 50–300),
the chat is blocked by a **30-second reader's pause**. You can't skip it.
You're meant to actually read what the AI just told you.

A small floating badge in the corner shows `words / threshold` at all times,
so the cooldown never sneaks up on you.

When the timer ends, the session counter resets and you continue.

### 5. Prompt DNA

Every prompt you send is silently profiled against five quality dimensions.
Open the popup to see your **Prompt DNA** — a persistent dashboard that
treats prompt quality like a credit score.

What it tracks, entirely in `chrome.storage.local`:

- **Clarity** — are you stating *what* you want?
- **Context** — are you saying *who* it's for?
- **Purpose** — are you explaining *why*?
- **Specificity** — or are you hiding behind vague verbs like "help", "fix", "make it better"?
- **Discipline** — how often do you trigger cooldowns and anti-paste blocks?

The popup renders:

- A **0–100 Prompt Score** ring (color coded: green / amber / red)
- A **5-axis radar** showing exactly where you're weak
- Three stat tiles: prompts sent, edit rate, day streak
- A **7-day sparkline** of daily activity
- A single-line insight with the *worst* dimension and a concrete tip, e.g.
  *"Weakest: Context (Who) (12/100). Name the audience in your prompts."*

Reset at any time with the **Reset** button in the popup.

---

## Installation

1. Clone or download this repo.
2. Open `chrome://extensions/` in Chrome.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and pick the project folder.

Optionally, set up the Oracle:

1. Copy `config.example.js` to `config.js`.
2. Pick a provider and paste your key.
3. Reload the extension.

`config.js` is gitignored so your key stays local.

```js
// config.js
self.FRICTION_CONFIG = {
  apiProvider: 'openrouter',              // gemini | openai | openrouter | anthropic
  apiModel: 'meta-llama/llama-3.3-70b-instruct:free',
  apiKey:   'sk-or-...'                   // never commit this
};
```

Supported Oracle providers: **Gemini**, **OpenAI**, **OpenRouter**, **Anthropic**.
If no key is set, the local fallback still runs the 5-verdict flow.

---

## How a prompt actually flows

```
submit pressed
   │
   ├── large paste?          ──► Anti-Paste Engine
   │                              classify code vs text (background)
   │                              prompt for clarification ──► send
   │
   ├── session words ≥ limit? ──► Cognitive Cooldown (30s timer)
   │
   └── otherwise             ──► 5-Verdict Judge ──► comparison ──► send

  (in parallel)               ──► Prompt DNA records the event
   │                              Context Keeper updates badge
```

Everything is driven by a single content script that hooks `keydown` and
submit-button clicks on each supported site.

---

## Repo layout

```
Friction/
├── manifest.json
├── background.js       # service worker: remote Oracle + retries + local fallback
├── content.js          # main interception, overlays, cooldown, Prompt DNA tracker
├── overlay.css         # in-page overlay styling (verdicts, cooldown, badge)
├── popup.html
├── popup.js            # popup controls + Prompt DNA dashboard rendering
├── popup.css
├── config.example.js   # copy to config.js and add your key
└── icons/
```

Storage keys in `chrome.storage.local`:

| Key                     | Owner           | Purpose                                |
|-------------------------|-----------------|----------------------------------------|
| `frictionState`         | popup.js        | Enabled flag + cooldown threshold      |
| `frictionSessionWords:<platform>` | content.js | Per-platform rolling word count for the cooldown |
| `frictionDNA`           | content.js      | Aggregated Prompt DNA totals + daily   |
| `frictionFloatingBadgePositions` | content.js | Draggable badge positions (word + context) |

---

## Technical notes

- Manifest V3 Chrome extension, no build step.
- No backend. Remote Oracle calls go direct from the service worker to the
  configured provider.
- Retry logic for OpenRouter upstream flakes and OpenAI strict-schema
  rejections lives in `background.js`.
- Reasoning models (o1, deepseek-r1, gpt-oss, …) are handled: if `content`
  is empty we fall back to `reasoning`, `reasoning_content`, and
  `reasoning_details`.
- The Prompt DNA tracker debounces writes (150 ms) and listens to
  `chrome.storage.onChanged` so the popup's reset button clears the
  in-memory cache too.
- **Anti-Paste classification** makes a separate, cheap 10-token API call
  (truncated to 2000 chars) to classify pasted content as code or text.
  The overlay opens immediately with a generic title and updates in-place
  when the classification returns. No impact on Ghost Reflection or other
  flows.
- **Context Keeper** badge is draggable; position is saved in
  `chrome.storage.local` per platform.

---

## Privacy

- By default, nothing leaves your machine — the local fallback handles everything.
- If you configure an Oracle, only the prompt text is sent to that provider
  under your own API key.
- Prompt DNA stats are local-only. No telemetry, no sync, no server.

---

## Links

- Repo: <https://github.com/ayhanarashtasin/Friction_Hackathon>

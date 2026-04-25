// copy this to config.js, paste your key, done. config.js is gitignored so you don't leak it.
// whatever you put here beats the popup settings.

self.FRICTION_CONFIG = {
  // gemini / openai / openrouter / anthropic
  apiProvider: 'openrouter',

  // model id. some working free ones:
  // openrouter: meta-llama/llama-3.3-70b-instruct:free, openai/gpt-4o-mini
  // openai: gpt-4o-mini
  // gemini: gemini-2.5-flash
  // anthropic: claude-3-haiku-20240307
  apiModel: 'meta-llama/llama-3.3-70b-instruct:free',

  // paste key here. do NOT commit this file to git.
  apiKey: ''
};

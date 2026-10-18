import assert from "node:assert/strict";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Keep the initialization check offline and independent of personal Pi settings.
const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are the Pi Aftercare development assistant.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const modelRuntime = await ModelRuntime.create({
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new Error("Credential writes are disabled in the offline initialization check");
    },
    delete: async () => {},
  },
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
});

const { session } = await createAgentSession({
  cwd: process.cwd(),
  modelRuntime,
  resourceLoader,
  tools: [],
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
});

try {
  assert.deepEqual(session.getActiveToolNames(), []);
  assert.match(session.systemPrompt, /Pi Aftercare/);
  console.log("Pi SDK loaded and session created successfully; no model API was called.");
} finally {
  session.dispose();
}

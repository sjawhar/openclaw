import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const { getOAuthApiKeyMock, getActivePluginRegistryMock, resolvePluginProvidersMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn(async () => {
    throw new Error("built-in oauth refresh should not be called");
  }),
  getActivePluginRegistryMock: vi.fn(),
  resolvePluginProvidersMock: vi.fn(() => []),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: getOAuthApiKeyMock,
  getOAuthProviders: () => [{ id: "anthropic", envApiKey: "ANTHROPIC_API_KEY", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" }],
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: getActivePluginRegistryMock,
}));

vi.mock("../../plugins/providers.js", () => ({
  resolvePluginProviders: resolvePluginProvidersMock,
}));

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access?: string;
  refresh?: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: params.access ?? "expired-access-token",
        refresh: params.refresh ?? "refresh-token",
        expires: Date.now() - 60_000,
      },
    },
  };
}

describe("resolveApiKeyForProfile plugin OAuth refresh", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]);
  let tempRoot = "";
  let agentDir = "";

  beforeEach(async () => {
    getOAuthApiKeyMock.mockClear();
    resolvePluginProvidersMock.mockClear();
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-oauth-refresh-"));
    agentDir = path.join(tempRoot, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const plugin: ProviderPlugin = {
      id: "anthropic",
      label: "Anthropic OAuth",
      auth: [],
      formatApiKey: (cred) => `plugin:${cred.type === "oauth" ? cred.access : "invalid"}`,
      refreshOAuth: async (cred) => ({
        ...cred,
        access: "plugin-refreshed-access-token",
        refresh: "plugin-refreshed-refresh-token",
        expires: Date.now() + 3_600_000,
      }),
    };
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "openclaw-anthropic-oauth",
      provider: plugin,
      source: "/tmp/plugin",
    });
    getActivePluginRegistryMock.mockReturnValue(registry);
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("uses plugin refreshOAuth and formatApiKey before built-in oauth refreshers", async () => {
    const profileId = "anthropic:claude-oauth";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "anthropic",
      }),
      agentDir,
    );

    const result = await resolveApiKeyForProfile({
      cfg: { auth: { profiles: { [profileId]: { provider: "anthropic", mode: "oauth" } } } },
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "plugin:plugin-refreshed-access-token",
      provider: "anthropic",
      email: undefined,
    });
    expect(getOAuthApiKeyMock).not.toHaveBeenCalled();

    const saved = ensureAuthProfileStore(agentDir).profiles[profileId] as OAuthCredential;
    expect(saved.access).toBe("plugin-refreshed-access-token");
    expect(saved.refresh).toBe("plugin-refreshed-refresh-token");
    expect(saved.expires).toBeGreaterThan(Date.now());
  });
});

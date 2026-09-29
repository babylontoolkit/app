import { atom, computed, map } from 'nanostores';
import { PROVIDER_LIST } from '~/utils/constants';
import type { IProviderConfig } from '~/types/model';
import type { TabVisibilityConfig, TabWindowConfig, UserTabConfig } from '~/components/@settings/core/types';
import { DEFAULT_TAB_CONFIG } from '~/components/@settings/core/constants';
import { toggleTheme } from './theme';
import { create } from 'zustand';
import {
  DEFAULT_TOOLKIT_SYSTEMS,
  parseToolkitSystems,
  type ToolkitSystemsPreference,
} from '~/lib/agent/toolkit-systems';

export interface Shortcut {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlOrMetaKey?: boolean;
  action: () => void;
  description?: string; // Description of what the shortcut does
  isPreventDefault?: boolean; // Whether to prevent default browser behavior
}

export interface Shortcuts {
  toggleTheme: Shortcut;
  toggleTerminal: Shortcut;
}

export const URL_CONFIGURABLE_PROVIDERS = ['Ollama', 'LMStudio', 'OpenAILike'];
export const LOCAL_PROVIDERS = ['OpenAILike', 'LMStudio', 'Ollama'];

export type ProviderSetting = Record<string, IProviderConfig>;

// Simplified shortcuts store with only theme toggle
export const shortcutsStore = map<Shortcuts>({
  toggleTheme: {
    key: 'd',
    metaKey: true,
    altKey: true,
    shiftKey: true,
    action: () => toggleTheme(),
    description: 'Toggle theme',
    isPreventDefault: true,
  },
  toggleTerminal: {
    key: '`',
    ctrlOrMetaKey: true,
    action: () => {
      // This will be handled by the terminal component
    },
    description: 'Toggle terminal',
    isPreventDefault: true,
  },
});

// Create a single key for provider settings
const PROVIDER_SETTINGS_KEY = 'provider_settings';
const AUTO_ENABLED_KEY = 'auto_enabled_providers';

// Add this helper function at the top of the file
const isBrowser = typeof window !== 'undefined';

// Interface for configured provider info from server
interface ConfiguredProvider {
  name: string;
  isConfigured: boolean;
  configMethod: 'environment' | 'none';
}

// Fetch configured providers from server
const fetchConfiguredProviders = async (): Promise<ConfiguredProvider[]> => {
  try {
    const response = await fetch('/api/configured-providers');

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as { providers?: ConfiguredProvider[] };

    return data.providers || [];
  } catch (error) {
    console.error('Error fetching configured providers:', error);
    return [];
  }
};

// Initialize provider settings from both localStorage and server-detected configuration
const getInitialProviderSettings = (): ProviderSetting => {
  const initialSettings: ProviderSetting = {};

  // Start with default settings
  PROVIDER_LIST.forEach((provider) => {
    initialSettings[provider.name] = {
      ...provider,
      settings: {
        // Local providers should be disabled by default
        enabled: !LOCAL_PROVIDERS.includes(provider.name),
      },
    };
  });

  // Only try to load from localStorage in the browser
  if (isBrowser) {
    const savedSettings = localStorage.getItem(PROVIDER_SETTINGS_KEY);

    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings);
        Object.entries(parsed).forEach(([key, value]) => {
          if (initialSettings[key]) {
            initialSettings[key].settings = (value as IProviderConfig).settings;
          }
        });
      } catch (error) {
        console.error('Error parsing saved provider settings:', error);
      }
    }
  }

  return initialSettings;
};

// Auto-enable providers that are configured on the server
const autoEnableConfiguredProviders = async () => {
  if (!isBrowser) {
    return;
  }

  try {
    const configuredProviders = await fetchConfiguredProviders();
    const currentSettings = providersStore.get();
    const savedSettings = localStorage.getItem(PROVIDER_SETTINGS_KEY);
    const autoEnabledProviders = localStorage.getItem(AUTO_ENABLED_KEY);

    // Track which providers were auto-enabled to avoid overriding user preferences
    const previouslyAutoEnabled = autoEnabledProviders ? JSON.parse(autoEnabledProviders) : [];
    const newlyAutoEnabled: string[] = [];

    let hasChanges = false;

    configuredProviders.forEach(({ name, isConfigured, configMethod }) => {
      if (isConfigured && configMethod === 'environment' && LOCAL_PROVIDERS.includes(name)) {
        const currentProvider = currentSettings[name];

        if (currentProvider) {
          /*
           * Only auto-enable if:
           * 1. Provider is not already enabled, AND
           * 2. Either we haven't saved settings yet (first time) OR provider was previously auto-enabled
           */
          const hasUserSettings = savedSettings !== null;
          const wasAutoEnabled = previouslyAutoEnabled.includes(name);
          const shouldAutoEnable = !currentProvider.settings.enabled && (!hasUserSettings || wasAutoEnabled);

          if (shouldAutoEnable) {
            currentSettings[name] = {
              ...currentProvider,
              settings: {
                ...currentProvider.settings,
                enabled: true,
              },
            };
            newlyAutoEnabled.push(name);
            hasChanges = true;
          }
        }
      }
    });

    if (hasChanges) {
      // Update the store
      providersStore.set(currentSettings);

      // Save to localStorage
      localStorage.setItem(PROVIDER_SETTINGS_KEY, JSON.stringify(currentSettings));

      // Update the auto-enabled providers list
      const allAutoEnabled = [...new Set([...previouslyAutoEnabled, ...newlyAutoEnabled])];
      localStorage.setItem(AUTO_ENABLED_KEY, JSON.stringify(allAutoEnabled));

      console.log(`Auto-enabled providers: ${newlyAutoEnabled.join(', ')}`);
    }
  } catch (error) {
    console.error('Error auto-enabling configured providers:', error);
  }
};

export const providersStore = map<ProviderSetting>(getInitialProviderSettings());

// Export the auto-enable function for use in components
export const initializeProviders = autoEnableConfiguredProviders;

// Initialize providers when the module loads (in browser only)
if (isBrowser) {
  // Use a small delay to ensure DOM and other resources are ready
  setTimeout(() => {
    autoEnableConfiguredProviders();
  }, 100);
}

// Create a function to update provider settings that handles both store and persistence
export const updateProviderSettings = (provider: string, settings: ProviderSetting) => {
  const currentSettings = providersStore.get();

  // Create new provider config with updated settings
  const updatedProvider = {
    ...currentSettings[provider],
    settings: {
      ...currentSettings[provider].settings,
      ...settings,
    },
  };

  // Update the store with new settings
  providersStore.setKey(provider, updatedProvider);

  // Save to localStorage
  const allSettings = providersStore.get();
  localStorage.setItem(PROVIDER_SETTINGS_KEY, JSON.stringify(allSettings));

  // If this is a local provider, update the auto-enabled tracking
  if (LOCAL_PROVIDERS.includes(provider) && updatedProvider.settings.enabled !== undefined) {
    updateAutoEnabledTracking(provider, updatedProvider.settings.enabled);
  }
};

// Update auto-enabled tracking when user manually changes provider settings
const updateAutoEnabledTracking = (providerName: string, isEnabled: boolean) => {
  if (!isBrowser) {
    return;
  }

  try {
    const autoEnabledProviders = localStorage.getItem(AUTO_ENABLED_KEY);
    const currentAutoEnabled = autoEnabledProviders ? JSON.parse(autoEnabledProviders) : [];

    if (isEnabled) {
      // If user enables provider, add to auto-enabled list (for future detection)
      if (!currentAutoEnabled.includes(providerName)) {
        currentAutoEnabled.push(providerName);
        localStorage.setItem(AUTO_ENABLED_KEY, JSON.stringify(currentAutoEnabled));
      }
    } else {
      // If user disables provider, remove from auto-enabled list (respect user choice)
      const updatedAutoEnabled = currentAutoEnabled.filter((name: string) => name !== providerName);
      localStorage.setItem(AUTO_ENABLED_KEY, JSON.stringify(updatedAutoEnabled));
    }
  } catch (error) {
    console.error('Error updating auto-enabled tracking:', error);
  }
};

/**
 * The rungs of the MODEL TIER LADDER (§4.6.1a), cheapest first.
 *
 * Declared here rather than imported from `~/lib/.server/billing/model-tiers` because this module ships
 * in the CLIENT bundle and nothing under `.server/` may. The server is the authority — it re-derives
 * the rung on every generation and refuses anything it does not recognise — so the only cost of the two
 * lists disagreeing is that this browser asks for a rung the server declines to Standard, which is the
 * safe direction and exactly what an out-of-date tab already does.
 */
export const MODEL_TIER_IDS = ['standard', 'premium', 'platinum'] as const;

export type ModelTierId = (typeof MODEL_TIER_IDS)[number];

export const isDebugMode = atom(false);

// Define keys for localStorage
const SETTINGS_KEYS = {
  LATEST_BRANCH: 'isLatestBranch',
  AUTO_SELECT_TEMPLATE: 'autoSelectTemplate',
  CONTEXT_OPTIMIZATION: 'contextOptimizationEnabled',
  EVENT_LOGS: 'isEventLogsEnabled',
  PROMPT_ID: 'promptId',
  DEVELOPER_MODE: 'isDeveloperMode',

  /**
   * @deprecated The pre-ladder boolean (§4.6.1). READ ONLY, for the one-time migration below.
   *
   * Never written any more. It survives because a browser that holds `true` here belongs to a user who
   * opted into premium and paid for it — dropping the key silently downgrades every existing premium
   * user to Standard, with nothing on screen saying their preference changed.
   */
  PREMIUM_MODEL: 'extendedModelsEnabled',

  /** The user's chosen rung of the MODEL TIER LADDER (§4.6.1a). `'standard'` unless they pick up. */
  MODEL_TIER: 'modelTier',

  /**
   * The "Use Asset Library" preference (§4.4d, Control Panel → Features, default ON): whether THIS
   * user's generations are told about the admin-pinned Synty prototype library. Rides in the agent
   * request body; the server gate only honors an explicit `false`, so absent = ON.
   */
  USE_ASSET_LIBRARY: 'useAssetLibrary',

  /**
   * The "Toolkit systems" preference (§4.4e, Control Panel → Features, default `'auto'`): whether the
   * model should reach for the built-in controllers, decide for itself, or author its own
   * architecture. Rides in the agent request body; an unrecognised value resolves DOWN to `'auto'`,
   * which emits no block at all.
   */
  TOOLKIT_SYSTEMS: 'toolkitSystems',
} as const;

// Initialize settings from localStorage or defaults
const getInitialSettings = () => {
  const getStoredBoolean = (key: string, defaultValue: boolean): boolean => {
    if (!isBrowser) {
      return defaultValue;
    }

    const stored = localStorage.getItem(key);

    if (stored === null) {
      return defaultValue;
    }

    try {
      return JSON.parse(stored);
    } catch {
      return defaultValue;
    }
  };

  return {
    latestBranch: getStoredBoolean(SETTINGS_KEYS.LATEST_BRANCH, false),
    autoSelectTemplate: getStoredBoolean(SETTINGS_KEYS.AUTO_SELECT_TEMPLATE, true),
    contextOptimization: getStoredBoolean(SETTINGS_KEYS.CONTEXT_OPTIMIZATION, true),
    eventLogs: getStoredBoolean(SETTINGS_KEYS.EVENT_LOGS, true),
    useAssetLibrary: getStoredBoolean(SETTINGS_KEYS.USE_ASSET_LIBRARY, true),
    toolkitSystems: getStoredToolkitSystems(),
    promptId: isBrowser ? localStorage.getItem(SETTINGS_KEYS.PROMPT_ID) || 'default' : 'default',
    developerMode: getStoredBoolean(SETTINGS_KEYS.DEVELOPER_MODE, false),

    // Default STANDARD: every paid rung is opt-in and burns credits several times faster (§4.6.1a).
    modelTier: getStoredModelTier(),
  };
};

/**
 * The stored rung, MIGRATING the pre-ladder boolean on first read.
 *
 * Three rules, and each one fails silently in a different direction:
 *
 *  - **Migrate `extendedModelsEnabled === true` → `'premium'`.** Without it every user who had premium
 *    switched on is downgraded to Standard the moment they load the new bundle, and the only signal is
 *    a pill quietly naming a cheaper model. The old key is READ, never written — the new key is the
 *    only writer from here on, so the two can never disagree about what the user chose.
 *  - **Refuse anything unrecognised, DOWNWARD.** This value comes out of `localStorage`, which a user
 *    can hand-edit and any extension can write. It is the same rule as `parseUserEffort` and
 *    `resolveTierId`: never clamp UP, because inventing a more expensive rung than the user asked for
 *    is the direction that costs them money. (The server re-derives regardless — this only decides what
 *    we ask for.)
 *  - **Never throw ON A VALUE.** A malformed value is a locked-out builder if it escapes, so a parse
 *    failure is just another unrecognised value. ⚠️ Note the precise claim: `localStorage.getItem`
 *    itself can throw where storage is unavailable (Safari private mode, storage disabled by policy),
 *    and that is NOT guarded here — nor anywhere else in this module, which reads the same way in
 *    `getStoredBoolean` and every `update*` helper. Pre-existing and out of this rule's scope; stated
 *    rather than implied, because "never throws" written next to a `getItem` call reads as a promise
 *    the code does not make.
 */
function getStoredModelTier(): ModelTierId {
  if (!isBrowser) {
    return 'standard';
  }

  const stored = localStorage.getItem(SETTINGS_KEYS.MODEL_TIER);

  if (stored !== null) {
    /*
     * Accept both the bare string and a JSON-quoted one. `updateModelTier` writes the bare form, but a
     * hand-edited key or an older experiment may hold `"premium"` — and refusing a value the user
     * plainly meant, in favour of the cheap default, is a silent downgrade rather than a safe one.
     */
    const unquoted = stored.startsWith('"') ? safeParse(stored) : stored;

    return isModelTierId(unquoted) ? unquoted : 'standard';
  }

  // No new key: this browser predates the ladder. Carry the old opt-in over, once.
  return safeParse(localStorage.getItem(SETTINGS_KEYS.PREMIUM_MODEL) ?? '') === true ? 'premium' : 'standard';
}

/**
 * The stored "Toolkit systems" preference (§4.4e).
 *
 * `parseToolkitSystems` owns the whole decision, so the browser and the server can never disagree
 * about what a value means — this reads `localStorage` and hands it straight over. Unrecognised,
 * hand-edited and absent all land on `'auto'`, which is the shipped behaviour AND the free one.
 *
 * Both spellings are accepted for the same reason `getStoredModelTier` accepts both: `updateToolkitSystems`
 * writes the JSON-quoted form, and refusing a bare `prefer` that a user or an older build wrote would
 * silently revert a choice they made.
 */
function getStoredToolkitSystems(): ToolkitSystemsPreference {
  if (!isBrowser) {
    return DEFAULT_TOOLKIT_SYSTEMS;
  }

  const stored = localStorage.getItem(SETTINGS_KEYS.TOOLKIT_SYSTEMS);

  if (stored === null) {
    return DEFAULT_TOOLKIT_SYSTEMS;
  }

  return parseToolkitSystems(stored.startsWith('"') ? safeParse(stored) : stored);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isModelTierId(value: unknown): value is ModelTierId {
  return typeof value === 'string' && (MODEL_TIER_IDS as readonly string[]).includes(value);
}

// Initialize stores with persisted values
const initialSettings = getInitialSettings();

export const latestBranchStore = atom<boolean>(initialSettings.latestBranch);
export const autoSelectStarterTemplate = atom<boolean>(initialSettings.autoSelectTemplate);
export const enableContextOptimizationStore = atom<boolean>(initialSettings.contextOptimization);
export const isEventLogsEnabled = atom<boolean>(initialSettings.eventLogs);

/**
 * The "Use Asset Library" preference (§4.4d) — a per-user request preference like `modelTierStore`,
 * never enforcement: the agent proxy reads it off the request body and simply omits the library
 * block when it is false. Default ON.
 */
export const useAssetLibraryStore = atom<boolean>(initialSettings.useAssetLibrary);

/**
 * The "Toolkit systems" preference (§4.4e) — a per-user request preference like `useAssetLibraryStore`,
 * never enforcement: the proxy reads it off the request body and pushes an override block for
 * `'prefer'`/`'own'` only. The default `'auto'` pushes NOTHING, so the common case costs no tokens —
 * the baked batteries-included rule already states the balanced position.
 */
export const toolkitSystemsStore = atom<ToolkitSystemsPreference>(initialSettings.toolkitSystems);
export const promptStore = atom<string>(initialSettings.promptId);

/**
 * The user's chosen rung of the MODEL TIER LADDER (§4.6.1a).
 *
 * A rendering/request preference only — the server re-derives eligibility every generation
 * (`decideModelTier`), so a value here never grants a rung to a user below its credits threshold, and
 * an unrecognised one can never select a rung at all.
 */
export const modelTierStore = atom<ModelTierId>(initialSettings.modelTier);

/**
 * @deprecated Use `modelTierStore`. A read-only VIEW, kept for `Chat.client.tsx`'s send path (T12).
 *
 * Derived rather than stored, so there is exactly one source of truth for which rung is selected. Two
 * independent stores answering "what did the user pick?" is the two-writers drift this codebase keeps
 * rediscovering — and here it would show up as a pill and a picker disagreeing.
 */
export const premiumModelStore = computed(modelTierStore, (tier) => tier === 'premium');

// Helper functions to update settings with persistence
export const updateLatestBranch = (enabled: boolean) => {
  latestBranchStore.set(enabled);
  localStorage.setItem(SETTINGS_KEYS.LATEST_BRANCH, JSON.stringify(enabled));
};

export const updateAutoSelectTemplate = (enabled: boolean) => {
  autoSelectStarterTemplate.set(enabled);
  localStorage.setItem(SETTINGS_KEYS.AUTO_SELECT_TEMPLATE, JSON.stringify(enabled));
};

export const updateContextOptimization = (enabled: boolean) => {
  enableContextOptimizationStore.set(enabled);
  localStorage.setItem(SETTINGS_KEYS.CONTEXT_OPTIMIZATION, JSON.stringify(enabled));
};

export const updateEventLogs = (enabled: boolean) => {
  isEventLogsEnabled.set(enabled);
  localStorage.setItem(SETTINGS_KEYS.EVENT_LOGS, JSON.stringify(enabled));
};

export const updateUseAssetLibrary = (enabled: boolean) => {
  useAssetLibraryStore.set(enabled);
  localStorage.setItem(SETTINGS_KEYS.USE_ASSET_LIBRARY, JSON.stringify(enabled));
};

export const updateToolkitSystems = (preference: ToolkitSystemsPreference) => {
  toolkitSystemsStore.set(preference);
  localStorage.setItem(SETTINGS_KEYS.TOOLKIT_SYSTEMS, JSON.stringify(preference));
};

/**
 * Persist the chosen rung. Writes the NEW key only — the old boolean is read once and never written,
 * so a migrated browser cannot end up with two keys disagreeing about what the user picked.
 */
export const updateModelTier = (tier: ModelTierId) => {
  modelTierStore.set(tier);
  localStorage.setItem(SETTINGS_KEYS.MODEL_TIER, tier);
};

/** @deprecated Use `updateModelTier`. No callers remain in app code; kept for the wire alias (T12). */
export const updatePremiumModel = (enabled: boolean) => {
  updateModelTier(enabled ? 'premium' : 'standard');
};

export const updatePromptId = (id: string) => {
  promptStore.set(id);
  localStorage.setItem(SETTINGS_KEYS.PROMPT_ID, id);
};

// Initialize tab configuration from localStorage or defaults
const getInitialTabConfiguration = (): TabWindowConfig => {
  const defaultConfig: TabWindowConfig = {
    userTabs: DEFAULT_TAB_CONFIG.filter((tab): tab is UserTabConfig => tab.window === 'user'),
  };

  if (!isBrowser) {
    return defaultConfig;
  }

  try {
    const saved = localStorage.getItem('bolt_tab_configuration');

    if (!saved) {
      return defaultConfig;
    }

    const parsed = JSON.parse(saved);

    if (!parsed?.userTabs) {
      return defaultConfig;
    }

    // Ensure proper typing of loaded configuration
    return {
      userTabs: parsed.userTabs.filter((tab: TabVisibilityConfig): tab is UserTabConfig => tab.window === 'user'),
    };
  } catch (error) {
    console.warn('Failed to parse tab configuration:', error);
    return defaultConfig;
  }
};

// console.log('Initial tab configuration:', getInitialTabConfiguration());

export const tabConfigurationStore = map<TabWindowConfig>(getInitialTabConfiguration());

// Helper function to reset tab configuration
export const resetTabConfiguration = () => {
  const defaultConfig: TabWindowConfig = {
    userTabs: DEFAULT_TAB_CONFIG.filter((tab): tab is UserTabConfig => tab.window === 'user'),
  };

  tabConfigurationStore.set(defaultConfig);
  localStorage.setItem('bolt_tab_configuration', JSON.stringify(defaultConfig));
};

// First, let's define the SettingsStore interface
interface SettingsStore {
  isOpen: boolean;
  selectedTab: string;
  openSettings: () => void;
  closeSettings: () => void;
  setSelectedTab: (tab: string) => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  isOpen: false,
  selectedTab: 'user', // Default tab

  openSettings: () => {
    set({
      isOpen: true,
      selectedTab: 'user', // Always open to user tab
    });
  },

  closeSettings: () => {
    set({
      isOpen: false,
      selectedTab: 'user', // Reset to user tab when closing
    });
  },

  setSelectedTab: (tab: string) => {
    set({ selectedTab: tab });
  },
}));

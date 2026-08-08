// Remove unused imports
import React, { memo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Switch } from '~/components/ui/Switch';
import { useSettings } from '~/lib/hooks/useSettings';
import { classNames } from '~/utils/classNames';
import { toast } from 'react-toastify';
import type { ToolkitSystemsPreference } from '~/lib/agent/toolkit-systems';

interface FeatureToggle {
  id: string;
  title: string;
  description: string;
  icon: string;
  enabled: boolean;
  beta?: boolean;
  experimental?: boolean;
  tooltip?: string;
}

const FeatureCard = memo(
  ({
    feature,
    index,
    onToggle,
  }: {
    feature: FeatureToggle;
    index: number;
    onToggle: (id: string, enabled: boolean) => void;
  }) => (
    <motion.div
      key={feature.id}
      layoutId={feature.id}
      className={classNames(
        'relative group cursor-pointer',
        'bg-bolt-elements-background-depth-2',
        'hover:bg-bolt-elements-background-depth-3',
        'transition-colors duration-200',
        'rounded-lg overflow-hidden',
      )}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1 }}
    >
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={classNames(feature.icon, 'w-5 h-5 text-bolt-elements-textSecondary')} />
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-bolt-elements-textPrimary">{feature.title}</h4>
              {feature.beta && (
                <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/10 text-blue-500 font-medium">Beta</span>
              )}
              {feature.experimental && (
                <span className="px-2 py-0.5 text-xs rounded-full bg-orange-500/10 text-orange-500 font-medium">
                  Experimental
                </span>
              )}
            </div>
          </div>
          <Switch checked={feature.enabled} onCheckedChange={(checked) => onToggle(feature.id, checked)} />
        </div>
        <p className="mt-2 text-sm text-bolt-elements-textSecondary">{feature.description}</p>
        {feature.tooltip && <p className="mt-1 text-xs text-bolt-elements-textTertiary">{feature.tooltip}</p>}
      </div>
    </motion.div>
  ),
);

/**
 * The "Toolkit systems" choice (§4.4e) — three settings, so a `Switch` cannot carry it.
 *
 * Reported 2026-08-08: the same "mario kart clone" prompt produced a simulation-physics Mustang on one
 * model and hand-written movement on another, and there was no way to steer either. *"There are times
 * when I do want it to use the included interactive glTF script components and then there are times
 * when I need it to be creative itself and make its architecture."* That is a control, not a wording
 * problem — so it is a control.
 *
 * Each option states what it MEANS for the game rather than naming a mechanism: the person choosing
 * is deciding how their game should feel, not configuring a prompt.
 */
const TOOLKIT_SYSTEM_OPTIONS: { id: ToolkitSystemsPreference; label: string; description: string }[] = [
  {
    id: 'prefer',
    label: 'Prefer built-ins',
    description:
      "Reach for the Toolkit's ready-made controllers and interactive glTF script components wherever they fit. Fastest and most predictable, but the game inherits their feel.",
  },
  {
    id: 'auto',
    label: 'Let the model decide',
    description:
      'Judges from your request whether a built-in matches the feel you asked for, and writes its own where it does not. The default.',
  },
  {
    id: 'own',
    label: 'Author its own',
    description:
      'Designs movement, game rules and component structure from scratch for this project. Still uses the Toolkit for physics, animation, cameras, input and audio.',
  },
];

const ToolkitSystemsCard = memo(
  ({ value, onChange }: { value: ToolkitSystemsPreference; onChange: (next: ToolkitSystemsPreference) => void }) => (
    <motion.div
      className={classNames(
        'relative bg-bolt-elements-background-depth-2',
        'transition-colors duration-200',
        'rounded-lg overflow-hidden',
      )}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="p-4">
        <div className="flex items-center gap-3">
          <div className="i-ph:tree-structure w-5 h-5 text-bolt-elements-textSecondary" />
          <h4 className="font-medium text-bolt-elements-textPrimary">Toolkit systems</h4>
        </div>

        <p className="mt-2 text-sm text-bolt-elements-textSecondary">
          How much of your game should be built from the Toolkit&apos;s ready-made systems.
        </p>

        <div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Toolkit systems">
          {TOOLKIT_SYSTEM_OPTIONS.map((option) => {
            const selected = option.id === value;

            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange(option.id)}
                className={classNames(
                  'text-left rounded-md border p-3 transition-colors',
                  selected
                    ? 'border-purple-500 bg-purple-500/10'
                    : 'border-bolt-elements-borderColor hover:bg-bolt-elements-background-depth-3',
                )}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={classNames(
                      'w-4 h-4 shrink-0',
                      selected
                        ? 'i-ph:radio-button-fill text-purple-500'
                        : 'i-ph:circle text-bolt-elements-textTertiary',
                    )}
                  />
                  <span className="text-sm font-medium text-bolt-elements-textPrimary">{option.label}</span>
                </div>
                <p className="mt-1 pl-6 text-xs text-bolt-elements-textTertiary">{option.description}</p>
              </button>
            );
          })}
        </div>
      </div>
    </motion.div>
  ),
);

const FeatureSection = memo(
  ({
    title,
    features,
    icon,
    description,
    onToggleFeature,
  }: {
    title: string;
    features: FeatureToggle[];
    icon: string;
    description: string;
    onToggleFeature: (id: string, enabled: boolean) => void;
  }) => (
    <motion.div
      layout
      className="flex flex-col gap-4"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex items-center gap-3">
        <div className={classNames(icon, 'text-xl text-purple-500')} />
        <div>
          <h3 className="text-lg font-medium text-bolt-elements-textPrimary">{title}</h3>
          <p className="text-sm text-bolt-elements-textSecondary">{description}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {features.map((feature, index) => (
          <FeatureCard key={feature.id} feature={feature} index={index} onToggle={onToggleFeature} />
        ))}
      </div>
    </motion.div>
  ),
);

export default function FeaturesTab() {
  const {
    toolkitSystems,
    setToolkitSystems,
    autoSelectTemplate,
    isLatestBranch,
    contextOptimizationEnabled,
    eventLogs,
    useAssetLibrary,
    setAutoSelectTemplate,
    enableLatestBranch,
    enableContextOptimization,
    setEventLogs,
    setUseAssetLibrary,
    setPromptId,
    promptId,
  } = useSettings();

  // Enable features by default on first load
  React.useEffect(() => {
    // Only set defaults if values are undefined
    if (isLatestBranch === undefined) {
      enableLatestBranch(false); // Default: OFF - Don't auto-update from main branch
    }

    if (contextOptimizationEnabled === undefined) {
      enableContextOptimization(true); // Default: ON - Enable context optimization
    }

    if (autoSelectTemplate === undefined) {
      setAutoSelectTemplate(true); // Default: ON - Enable auto-select templates
    }

    if (promptId === undefined) {
      setPromptId('default'); // Default: 'default'
    }

    if (eventLogs === undefined) {
      setEventLogs(true); // Default: ON - Enable event logging
    }
  }, []); // Only run once on component mount

  const handleToggleFeature = useCallback(
    (id: string, enabled: boolean) => {
      switch (id) {
        case 'latestBranch': {
          enableLatestBranch(enabled);
          toast.success(`Main branch updates ${enabled ? 'enabled' : 'disabled'}`);
          break;
        }

        case 'autoSelectTemplate': {
          setAutoSelectTemplate(enabled);
          toast.success(`Auto select template ${enabled ? 'enabled' : 'disabled'}`);
          break;
        }

        case 'contextOptimization': {
          enableContextOptimization(enabled);
          toast.success(`Context optimization ${enabled ? 'enabled' : 'disabled'}`);
          break;
        }

        case 'eventLogs': {
          setEventLogs(enabled);
          toast.success(`Event logging ${enabled ? 'enabled' : 'disabled'}`);
          break;
        }

        case 'useAssetLibrary': {
          setUseAssetLibrary(enabled);
          toast.success(
            enabled
              ? 'Use Asset Library enabled — your games prototype with the Synty Asset Library'
              : 'Use Asset Library disabled — your games build without the asset library',
          );
          break;
        }

        default:
          break;
      }
    },
    [enableLatestBranch, setAutoSelectTemplate, enableContextOptimization, setEventLogs, setUseAssetLibrary],
  );

  /*
   * A toast on every change, like the asset-library toggle: this setting changes what the model
   * builds on the NEXT turn and nothing else on screen would say so.
   */
  const handleToolkitSystems = useCallback(
    (preference: ToolkitSystemsPreference) => {
      setToolkitSystems(preference);

      const said = {
        prefer: 'Toolkit systems preferred — the AI will reach for the built-in controllers',
        auto: 'Toolkit systems set to automatic — the AI decides from your request',
        own: 'Toolkit systems off — the AI will author its own game architecture',
      }[preference];

      toast.success(said);
    },
    [setToolkitSystems],
  );

  const features = {
    stable: [
      {
        /*
         * Per-user, and REAL (unlike the inert inherited toggles below): the value rides in every
         * /api/agent request body, and the proxy omits the §4.4d Synty library block when it is false
         * — so switching this off makes the pinned library behave as if it never existed for THIS
         * user's projects. Default ON.
         */
        id: 'useAssetLibrary',
        title: 'Use Asset Library',
        description: 'Prototype your games with our Synty Asset Library',
        icon: 'i-ph:cube',
        enabled: useAssetLibrary,
        tooltip:
          'When enabled, the AI prefers real 3D models, characters and levels from our curated Synty prototype library whenever you have not supplied your own assets - falling back to simple primitive shapes only when nothing suitable exists. Disable to build without the library.',
      },
      {
        id: 'latestBranch',
        title: 'Main Branch Updates',
        description: 'Get the latest updates from the main branch',
        icon: 'i-ph:git-branch',
        enabled: isLatestBranch,
        tooltip: 'Enabled by default to receive updates from the main development branch',
      },
      {
        id: 'autoSelectTemplate',
        title: 'Auto Select Template',
        description: 'Automatically select starter template',
        icon: 'i-ph:selection',
        enabled: autoSelectTemplate,
        tooltip: 'Enabled by default to automatically select the most appropriate starter template',
      },
      {
        id: 'contextOptimization',
        title: 'Context Optimization',

        /*
         * Copy deliberately says "always on" rather than upstream's "Optimize context for better
         * responses" (§4.2.8). The platform applies context optimization on EVERY generation — the
         * agent proxy never reads this setting, only the fail-closed upstream `/api/chat` path does —
         * so a user who switched it off and was told nothing would reasonably believe they had changed
         * how their generations are built, and be wrong. Shown for balance; described honestly.
         */
        description: 'Always on — every generation is built with an optimized context',
        icon: 'i-ph:brain',
        enabled: contextOptimizationEnabled,
        tooltip: 'This platform always optimizes the context it sends to the model',
      },
      {
        id: 'eventLogs',
        title: 'Event Logging',
        description: 'Enable detailed event logging and history',
        icon: 'i-ph:list-bullets',
        enabled: eventLogs,
        tooltip: 'Enabled by default to record detailed logs of system events and user actions',
      },
    ],
    beta: [],
  };

  return (
    <div className="flex flex-col gap-8">
      {/*
       * Main Branch Updates, Auto Select Template and the Prompt Library (removed below) are inherited
       * bolt.diy knobs that ONLY wire to the fail-closed upstream LLM path (`/api/chat` +
       * `app/lib/.server/llm/*`). They are inert on our `/api/agent` proxy AND misleading — they imply
       * this app tracks bolt.diy's main branch or that a user can swap our system prompt, neither of
       * which is true. Hidden, not deleted, to stay upstream-mergeable; their safe defaults are still
       * applied in the effect above.
       *
       * Context Optimization is shown (owner decision, 2026-07-22): a section holding a single row
       * looks broken rather than minimal, and two rows read as a deliberate list. It is equally inert,
       * so the ONLY thing that makes showing it acceptable is that its copy no longer claims to govern
       * anything — see the entry above. An inert control with honest copy is a statement of fact; an
       * inert control with upstream's copy is a lie the user can click.
       */}
      <FeatureSection
        title="Core Features"
        features={features.stable.filter(
          (feature) =>
            feature.id === 'useAssetLibrary' || feature.id === 'eventLogs' || feature.id === 'contextOptimization',
        )}
        icon="i-ph:check-circle"
        description="Essential features that are enabled by default for optimal performance"
        onToggleFeature={handleToggleFeature}
      />

      {/*
       * Placed AFTER Core Features deliberately: "Use Asset Library" is the owner-chosen first card
       * (§4.4d) and this does not displace it. The two are siblings — one decides where a game's
       * CONTENT comes from, this one decides where its ARCHITECTURE comes from — so they read as a
       * pair, and this one gets its own heading because it is a choice rather than a switch.
       */}
      <motion.div
        layout
        className="flex flex-col gap-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="flex items-center gap-3">
          <div className="i-ph:blueprint text-xl text-purple-500" />
          <div>
            <h3 className="text-lg font-medium text-bolt-elements-textPrimary">Game architecture</h3>
            <p className="text-sm text-bolt-elements-textSecondary">
              Whether the AI builds on the Toolkit&apos;s ready-made systems or designs its own
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ToolkitSystemsCard value={toolkitSystems} onChange={handleToolkitSystems} />
        </div>
      </motion.div>

      {features.beta.length > 0 && (
        <FeatureSection
          title="Beta Features"
          features={features.beta}
          icon="i-ph:test-tube"
          description="New features that are ready for testing but may have some rough edges"
          onToggleFeature={handleToggleFeature}
        />
      )}

      {/*
       * The upstream "Prompt Library" system-prompt picker was removed: our system prompt is built from
       * the synced Agent Reference docs + skills (§4.2/§4.3) in the `/api/agent` proxy, and the picker
       * only fed the fail-closed `/api/chat` path. Exposing it to a web-facing user implies they can
       * swap the platform prompt, which they cannot. The `promptId` default is still set above so the
       * inherited setting keeps a sane value.
       */}
    </div>
  );
}

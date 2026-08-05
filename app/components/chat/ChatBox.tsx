import React from 'react';
import { ClientOnly } from 'remix-utils/client-only';
import { classNames } from '~/utils/classNames';
import { PROVIDER_LIST } from '~/utils/constants';
import { ModelSelector } from '~/components/chat/ModelSelector';
import { APIKeyManager } from './APIKeyManager';
import { LOCAL_PROVIDERS } from '~/lib/stores/settings';
import FilePreview from './FilePreview';
import { ScreenshotStateManager } from './ScreenshotStateManager';
import { SendButton } from './SendButton.client';
import { IconButton } from '~/components/ui/IconButton';
import { toast } from 'react-toastify';
import { SpeechRecognitionButton } from '~/components/chat/SpeechRecognition';
import { ContextIndicator } from './ContextIndicator';
import { EffortPanel } from './EffortPanel';
import { SupabaseConnection } from './SupabaseConnection';
import { UnityConnection } from './UnityConnection';
import { ExpoQrModal } from '~/components/workbench/ExpoQrModal';
import styles from './BaseChat.module.scss';
import type { ProviderInfo } from '~/types/model';
import { ColorSchemeDialog } from '~/components/ui/ColorSchemeDialog';
import type { DesignScheme } from '~/types/design-scheme';
import type { ElementInfo } from '~/components/workbench/Inspector';
import { brand } from '~/config/brand';
import { McpTools } from './MCPTools';
import { WebSearch } from './WebSearch.client';
import { SkillAutocompleteMenu, useSkillAutocomplete } from './SkillAutocomplete';
import { useByokUnlocked } from '~/lib/hooks/useSession';
import { ModelTierPanel } from './ModelTierPanel';
import { ModelTierPill } from './ModelTierPill';
import { useStore } from '@nanostores/react';
import { projectId as projectIdStore } from '~/lib/persistence';

interface ChatBoxProps {
  isModelSettingsCollapsed: boolean;
  setIsModelSettingsCollapsed: (collapsed: boolean) => void;
  provider: any;
  providerList: any[];
  modelList: any[];
  apiKeys: Record<string, string>;
  isModelLoading: string | undefined;
  onApiKeysChange: (providerName: string, apiKey: string) => void;
  uploadedFiles: File[];
  imageDataList: string[];
  textareaRef: React.RefObject<HTMLTextAreaElement> | undefined;
  input: string;
  handlePaste: (e: React.ClipboardEvent) => void;
  TEXTAREA_MIN_HEIGHT: number;
  TEXTAREA_MAX_HEIGHT: number;
  isStreaming: boolean;
  handleSendMessage: (event: React.UIEvent, messageInput?: string) => void;
  isListening: boolean;
  startListening: () => void;
  stopListening: () => void;
  chatStarted: boolean;
  exportChat?: () => void;
  qrModalOpen: boolean;
  setQrModalOpen: (open: boolean) => void;
  handleFileUpload: () => void;
  setProvider?: ((provider: ProviderInfo) => void) | undefined;
  model?: string | undefined;
  setModel?: ((model: string) => void) | undefined;
  setUploadedFiles?: ((files: File[]) => void) | undefined;
  setImageDataList?: ((dataList: string[]) => void) | undefined;
  handleInputChange?: ((event: React.ChangeEvent<HTMLTextAreaElement>) => void) | undefined;
  handleStop?: (() => void) | undefined;
  enhancingPrompt?: boolean | undefined;
  enhancePrompt?: (() => void) | undefined;
  onWebSearchResult?: (result: string) => void;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
  designScheme?: DesignScheme;
  setDesignScheme?: (scheme: DesignScheme) => void;
  selectedElement?: ElementInfo | null;
  setSelectedElement?: ((element: ElementInfo | null) => void) | undefined;
}

export const ChatBox: React.FC<ChatBoxProps> = (props) => {
  /*
   * The ONE gate on all provider/model/key UI (§4.6.1). Read from the SERVER's session, never from a
   * client env var — a `VITE_`-prefixed flag would be a value the user can edit.
   */
  const byokUnlocked = useByokUnlocked();

  /*
   * Plan mode is only meaningful once a PROJECT exists (§4.2.9). On the landing page there is no
   * project yet, and the first message ALWAYS creates one — a creation turn, which the server forces
   * to Build regardless of this toggle (`decidePremium`/discuss-note both ignore the creation turn).
   * So with no project the toggle is locked to Build and disabled, mirroring how the premium pill and
   * the model selector need a project before they mean anything. A click explains rather than toggles.
   */
  const activeProjectId = useStore(projectIdStore);
  const planAvailable = Boolean(activeProjectId);
  const effectiveChatMode = planAvailable ? props.chatMode : 'build';

  /*
   * Setting the input through a synthetic change event is the existing convention in this codebase
   * (BaseChat does the same) — `setInput` is not threaded down this far, and inventing a second prop
   * chain for it would widen the diff against upstream for no behavioral gain.
   */
  const skillAutocomplete = useSkillAutocomplete(props.input, (value) => {
    props.handleInputChange?.({
      target: { value },
    } as React.ChangeEvent<HTMLTextAreaElement>);
  });

  return (
    <div
      className={classNames(
        'relative bg-bolt-elements-background-depth-2 backdrop-blur p-3 rounded-lg border border-bolt-elements-borderColor relative w-full max-w-chat mx-auto z-prompt',

        /*
         * {
         *   'sticky bottom-2': chatStarted,
         * },
         */
      )}
    >
      <svg className={classNames(styles.PromptEffectContainer)}>
        <defs>
          <linearGradient
            id="line-gradient"
            x1="20%"
            y1="0%"
            x2="-14%"
            y2="10%"
            gradientUnits="userSpaceOnUse"
            gradientTransform="rotate(-45)"
          >
            <stop offset="0%" stopColor="#b44aff" stopOpacity="0%"></stop>
            <stop offset="40%" stopColor="#b44aff" stopOpacity="80%"></stop>
            <stop offset="50%" stopColor="#b44aff" stopOpacity="80%"></stop>
            <stop offset="100%" stopColor="#b44aff" stopOpacity="0%"></stop>
          </linearGradient>
          <linearGradient id="shine-gradient">
            <stop offset="0%" stopColor="white" stopOpacity="0%"></stop>
            <stop offset="40%" stopColor="#ffffff" stopOpacity="80%"></stop>
            <stop offset="50%" stopColor="#ffffff" stopOpacity="80%"></stop>
            <stop offset="100%" stopColor="white" stopOpacity="0%"></stop>
          </linearGradient>
        </defs>
        <rect className={classNames(styles.PromptEffectLine)} pathLength="100" strokeLinecap="round"></rect>
        <rect className={classNames(styles.PromptShine)} x="48" y="24" width="70" height="1"></rect>
      </svg>
      {/*
       * PRO-GATED (SPEC §4.6.1, §4.1, §2.3). Pro gates EXACTLY ONE thing: BYOK + model selection.
       *
       * `byokUnlocked` is FALSE for everyone in the shipping default (PRO_FEATURES_ENABLED=false), so
       * the provider picker, the model selector and the key field are ABSENT from the DOM — not
       * disabled, not collapsed, not behind a paywall banner. Credits-mode UI contains zero provider
       * machinery, and a user in that mode never learns which model built their game.
       *
       * The server re-derives this on every generation (`resolveByok`), so revealing these controls
       * by hand in DevTools gets you a picker whose choices the server ignores.
       */}
      {byokUnlocked && (
        <div>
          <ClientOnly>
            {() => (
              <div className={props.isModelSettingsCollapsed ? 'hidden' : ''}>
                <ModelSelector
                  key={props.provider?.name + ':' + props.modelList.length}
                  model={props.model}
                  setModel={props.setModel}
                  modelList={props.modelList}
                  provider={props.provider}
                  setProvider={props.setProvider}
                  providerList={props.providerList || (PROVIDER_LIST as ProviderInfo[])}
                  apiKeys={props.apiKeys}
                  modelLoading={props.isModelLoading}
                />
                {(props.providerList || []).length > 0 &&
                  props.provider &&
                  !LOCAL_PROVIDERS.includes(props.provider.name) && (
                    <APIKeyManager
                      provider={props.provider}
                      apiKey={props.apiKeys[props.provider.name] || ''}
                      setApiKey={(key) => {
                        props.onApiKeysChange(props.provider.name, key);
                      }}
                    />
                  )}
              </div>
            )}
          </ClientOnly>
        </div>
      )}
      <FilePreview
        files={props.uploadedFiles}
        imageDataList={props.imageDataList}
        onRemove={(index) => {
          props.setUploadedFiles?.(props.uploadedFiles.filter((_, i) => i !== index));
          props.setImageDataList?.(props.imageDataList.filter((_, i) => i !== index));
        }}
      />
      <ClientOnly>
        {() => (
          <ScreenshotStateManager
            setUploadedFiles={props.setUploadedFiles}
            setImageDataList={props.setImageDataList}
            uploadedFiles={props.uploadedFiles}
            imageDataList={props.imageDataList}
          />
        )}
      </ClientOnly>
      {props.selectedElement && (
        <div className="flex mx-1.5 gap-2 items-center justify-between rounded-lg rounded-b-none border border-b-none border-bolt-elements-borderColor text-bolt-elements-textPrimary flex py-1 px-2.5 font-medium text-xs">
          <div className="flex gap-2 items-center lowercase">
            <code className="bg-accent-500 rounded-4px px-1.5 py-1 mr-0.5 text-white">
              {props?.selectedElement?.tagName}
            </code>
            selected for inspection
          </div>
          <button
            className="bg-transparent text-accent-500 pointer-auto"
            onClick={() => props.setSelectedElement?.(null)}
          >
            Clear
          </button>
        </div>
      )}
      <div
        className={classNames('relative shadow-xs border border-bolt-elements-borderColor backdrop-blur rounded-lg')}
      >
        <SkillAutocompleteMenu autocomplete={skillAutocomplete} />
        <textarea
          ref={props.textareaRef}
          className={classNames(
            'w-full pl-4 pt-4 pr-16 outline-none resize-none text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary bg-transparent text-sm',
            'transition-all duration-200',
            'hover:border-bolt-elements-focus',
          )}
          onDragEnter={(e) => {
            e.preventDefault();
            e.currentTarget.style.border = '2px solid #1488fc';
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.currentTarget.style.border = '2px solid #1488fc';
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.currentTarget.style.border = '1px solid var(--bolt-elements-borderColor)';
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.style.border = '1px solid var(--bolt-elements-borderColor)';

            const files = Array.from(e.dataTransfer.files);
            files.forEach((file) => {
              if (file.type.startsWith('image/')) {
                const reader = new FileReader();

                reader.onload = (e) => {
                  const base64Image = e.target?.result as string;
                  props.setUploadedFiles?.([...props.uploadedFiles, file]);
                  props.setImageDataList?.([...props.imageDataList, base64Image]);
                };
                reader.readAsDataURL(file);
              }
            });
          }}
          onKeyDown={(event) => {
            /*
             * The skill menu gets first refusal on the key. While it is open, Enter/Tab/arrows
             * belong to it — otherwise Enter would send a half-typed `/bt-sp` as a chat message.
             */
            skillAutocomplete.handleKeyDown(event);

            if (event.defaultPrevented) {
              return;
            }

            if (event.key === 'Enter') {
              if (event.shiftKey) {
                return;
              }

              event.preventDefault();

              if (props.isStreaming) {
                props.handleStop?.();
                return;
              }

              // ignore if using input method engine
              if (event.nativeEvent.isComposing) {
                return;
              }

              props.handleSendMessage?.(event);
            }
          }}
          value={props.input}
          onChange={(event) => {
            props.handleInputChange?.(event);
          }}
          onPaste={props.handlePaste}
          style={{
            minHeight: props.TEXTAREA_MIN_HEIGHT,
            maxHeight: props.TEXTAREA_MAX_HEIGHT,
          }}
          placeholder={
            effectiveChatMode === 'discuss'
              ? 'Plan mode — discuss ideas and next steps'
              : `How can ${brand.company} help you today?`
          }
          translate="no"
        />
        <ClientOnly>
          {() => (
            <SendButton
              show={props.input.length > 0 || props.isStreaming || props.uploadedFiles.length > 0}
              isStreaming={props.isStreaming}
              disabled={!props.providerList || props.providerList.length === 0}
              onClick={(event) => {
                if (props.isStreaming) {
                  props.handleStop?.();
                  return;
                }

                if (props.input.length > 0 || props.uploadedFiles.length > 0) {
                  props.handleSendMessage?.(event);
                }
              }}
            />
          )}
        </ClientOnly>
        {/*
         * The keyboard hint lives on its OWN line ABOVE the toolbar, left-aligned. It used to be the
         * middle child of the `justify-between` button row, so every button added there (the premium
         * model pill) squeezed it — a dedicated line decouples it from the toolbar's crowding. Still
         * only shown once the user is actually typing.
         */}
        {props.input.length > 3 ? (
          <div className="pt-2 pr-4 pl-[21px] text-xs text-bolt-elements-textTertiary">
            Use <kbd className="kdb px-1.5 py-0.5 rounded bg-bolt-elements-background-depth-2">Shift</kbd> +{' '}
            <kbd className="kdb px-1.5 py-0.5 rounded bg-bolt-elements-background-depth-2">Return</kbd> for a new line
          </div>
        ) : null}
        <div className="flex justify-between items-center text-sm p-4 pt-2">
          <div className="flex gap-1 items-center">
            {/*
             * The Unity Editor bridge (§4.17) leads the toolbar, in the slot the design-scheme picker
             * used to hold. That picker is HIDDEN, not deleted (upstream code — the hide-don't-delete
             * rule): it feeds `designScheme` through to the prompt, so removing the component would
             * mean unpicking the prop chain for a control the owner does not want surfaced.
             */}
            <UnityConnection />
            {false && <ColorSchemeDialog designScheme={props.designScheme} setDesignScheme={props.setDesignScheme} />}
            <McpTools />
            <IconButton title="Upload file" className="transition-all" onClick={() => props.handleFileUpload()}>
              <div className="i-ph:paperclip text-xl"></div>
            </IconButton>
            <WebSearch onSearchResult={(result) => props.onWebSearchResult?.(result)} disabled={props.isStreaming} />
            <IconButton
              title="Enhance prompt"
              disabled={props.input.length === 0 || props.enhancingPrompt}
              className={classNames('transition-all', props.enhancingPrompt ? 'opacity-100' : '')}
              onClick={() => {
                props.enhancePrompt?.();
                toast.success('Prompt enhanced!');
              }}
            >
              {props.enhancingPrompt ? (
                <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress text-xl animate-spin"></div>
              ) : (
                <div className="i-bolt:stars text-xl"></div>
              )}
            </IconButton>

            <SpeechRecognitionButton
              isListening={props.isListening}
              onStart={props.startListening}
              onStop={props.stopListening}
              disabled={props.isStreaming}
            />
            {/*
             * Build / Plan mode toggle (§4.2.9 — internally `chatMode: 'build' | 'discuss'`; the wire
             * value stays `discuss` so the server contract never moved, only the label). ONE always-
             * visible, always-labeled button showing the CURRENT mode; click to switch. The inherited
             * version was an unlabeled icon that only appeared mid-chat and only grew its label once
             * active — nobody found it.
             */}
            <IconButton
              title={
                !planAvailable
                  ? 'Plan mode unlocks once your project is created — your first message builds it.'
                  : effectiveChatMode === 'discuss'
                    ? 'Plan mode — nothing in your project changes. Click to switch to Build.'
                    : 'Build mode — the agent writes and edits your project files. Click to switch to Plan.'
              }
              className={classNames(
                'transition-all flex items-center gap-1 px-1.5',
                effectiveChatMode === 'discuss'
                  ? '!bg-bolt-elements-item-backgroundAccent !text-bolt-elements-item-contentAccent'
                  : 'bg-bolt-elements-item-backgroundDefault text-bolt-elements-item-contentDefault',
                !planAvailable ? 'opacity-50' : '',
              )}
              onClick={() => {
                if (!planAvailable) {
                  toast.info('Plan mode unlocks once your project is created. Your first message builds it.');
                  return;
                }

                props.setChatMode?.(effectiveChatMode === 'discuss' ? 'build' : 'discuss');
              }}
            >
              <div className={effectiveChatMode === 'discuss' ? 'i-ph:chats text-xl' : 'i-ph:hammer text-xl'} />
              <span>{effectiveChatMode === 'discuss' ? 'Plan' : 'Build'}</span>
            </IconButton>
            {props.chatStarted && <ContextIndicator />}
            {/*
             * The `/effort` picker (§4.2.9). Renders NOTHING until opened — it is a rarely-changed session
             * setting, and the row is already crowded. Unconditional (no `chatStarted` gate): the creation
             * turn takes the same floor as every other turn, so it must be settable before the first send.
             */}
            <EffortPanel />
            {/*
             * Also Pro-gated — and this one is easy to miss. When collapsed, this button RENDERS THE
             * MODEL NAME (`props.model`). Hiding the settings panel but leaving this toggle would put
             * "claude-sonnet-5" in the toolbar of a product whose whole premise is that credits users
             * never see or choose a model (§4.6.1). The model is a config property, not a user choice.
             */}
            {byokUnlocked && (
              <IconButton
                title="Model Settings"
                className={classNames('transition-all flex items-center gap-1', {
                  'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent':
                    props.isModelSettingsCollapsed,
                  'bg-bolt-elements-item-backgroundDefault text-bolt-elements-item-contentDefault':
                    !props.isModelSettingsCollapsed,
                })}
                onClick={() => props.setIsModelSettingsCollapsed(!props.isModelSettingsCollapsed)}
                disabled={!props.providerList || props.providerList.length === 0}
              >
                <div className={`i-ph:caret-${props.isModelSettingsCollapsed ? 'right' : 'down'} text-lg`} />
                {props.isModelSettingsCollapsed ? <span className="text-xs">{props.model}</span> : <span />}
              </IconButton>
            )}
          </div>
          {/*
           * The Game Backend (§4.15). Its TRIGGER is hidden — the action lives in the ⋯ main menu now —
           * but the component stays mounted here because it owns the dialog, the `open-supabase-connection`
           * listener that menu fires, and the per-chat project persistence (see `SupabaseConnection`).
           *
           * ⚠️ It renders an empty `relative` div, which is still a flex CHILD: left where it was, after
           * the model pill, it sat between the pill and the row's right edge and kept the pill off it.
           * Ahead of the pill it costs nothing and the pill is genuinely last.
           */}
          <SupabaseConnection />
          {/*
           * ── The RIGHT end of the composer row ──────────────────────────────────────
           *
           * The MODEL TIER picker (§4.6.1a) — a credits-mode control, deliberately NOT behind
           * `byokUnlocked`. It self-gates: it renders only for credits users and offers only the
           * operator-configured rungs, so it never reveals a free-form model picker.
           *
           * It sits at the RIGHT end (owner, 2026-08-04), in the slot the hidden Game Backend mark used
           * to occupy. Everything to the left acts on THIS message — attach, enhance, dictate, plan vs
           * build; the model is a standing property of the session, so it reads as a status rather than
           * as one more thing to press before sending.
           *
           * The PANEL sits beside the pill rather than inside it: its anchor must be a permanent flex
           * child so opening the popup cannot shift the row (§4.1a), and the pill is a plain
           * `IconButton` whose own box the absolutely-positioned popup would otherwise be measured
           * against. Same arrangement as `EffortPanel` in the left group.
           *
           * ⚠️ `items-center` is required on the wrapper: the left group sets its own, and without one
           * here the pill stretches to the row's height and its accent fill grows with it.
           *
           * ⚠️ And the anchor now comes AFTER the pill, unlike `EffortPanel` on the left. The popup is
           * `absolute … right-0`, so its right edge lands on its anchor's — which on the left of the
           * pill would hang the 320px panel 4px short of the row's edge for no reason. Last child puts
           * it flush with the composer.
           */}
          <div className="flex gap-1 items-center">
            <ModelTierPill />
            <ModelTierPanel />
          </div>
          <ExpoQrModal open={props.qrModalOpen} onClose={() => props.setQrModalOpen(false)} />
        </div>
      </div>
    </div>
  );
};

import React from 'react';

/*
 * Domain-appropriate starter prompts. This platform builds Babylon Toolkit 3D web games only (SPEC
 * §2.3 removes generic-website example prompts), so every example seeds a game the registry can match.
 */
const EXAMPLE_PROMPTS = [
  { text: 'Make me a mario kart racer clone complete with drifting mechanics' },
  { text: 'Build a third-person platformer with double-jump and collectibles' },
  { text: 'Create a top-down twin-stick shooter in a neon arena' },
  { text: 'Make a first-person maze explorer with a flashlight' },
  { text: 'Build a physics playground where I can knock over stacks of boxes' },
  { text: 'Create a split-screen local-multiplayer racing game' },
];

export function ExamplePrompts(sendMessage?: { (event: React.UIEvent, messageInput?: string): void | undefined }) {
  return (
    <div id="examples" className="relative flex flex-col gap-9 w-full max-w-3xl mx-auto flex justify-center mt-6">
      <div
        className="flex flex-wrap justify-center gap-2"
        style={{
          animation: '.25s ease-out 0s 1 _fade-and-move-in_g2ptj_1 forwards',
        }}
      >
        {EXAMPLE_PROMPTS.map((examplePrompt, index: number) => {
          return (
            <button
              key={index}
              onClick={(event) => {
                sendMessage?.(event, examplePrompt.text);
              }}
              className="border border-bolt-elements-borderColor rounded-full bg-gray-50 hover:bg-gray-100 dark:bg-gray-950 dark:hover:bg-gray-900 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary px-3 py-1 text-xs transition-theme"
            >
              {examplePrompt.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

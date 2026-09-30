/**
 * The explainer copy for each local dev-server failure cause (D27). One place, read by the explainer
 * dialog (the Local scenes section that also read it was removed by D55).
 */
import type { ExplainerCause } from '~/lib/local-scenes/explainer';

export const LOCAL_SCENE_EXPLAINER_COPY: Record<ExplainerCause, { title: string; body: (origin: string) => string }> = {
  'not-running': {
    title: "Your local scene server isn't running",
    body: (origin) =>
      `The game tried to load from ${origin}, but nothing answered. Start the Unity dev server (Babylon Toolkit ▸ Scene Exporter ▸ start the development server), or connect the Unity Bridge and ask the agent to start it.`,
  },
  blocked: {
    title: "This site isn't allowed to reach apps on your computer",
    body: () =>
      'Chrome asked whether this site may connect to apps on your device, and the answer was Block. To allow it: click the icon to the left of the address bar ▸ Site settings ▸ "Apps on device" (or "Local network access") ▸ Allow, then reload the preview.',
  },
  'old-exporter': {
    title: 'Your Unity exporter is too old for this',
    body: (origin) =>
      `The server at ${origin} answered but did not allow this site to read from it. Update the Babylon Toolkit exporter package to its latest version — newer versions send the headers this needs.`,
  },
};

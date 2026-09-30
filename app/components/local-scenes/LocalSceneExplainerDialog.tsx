/**
 * Explains a failed load from the user's local Unity dev server (D27). Driven entirely by
 * `localSceneExplainerStore`, which `startLocalSceneExplainer` sets at most once per cause per session.
 */
import { useStore } from '@nanostores/react';
import { Dialog, DialogButton, DialogDescription, DialogRoot, DialogTitle } from '~/components/ui/Dialog';
import { localSceneExplainerStore } from '~/lib/local-scenes/explainer';
import { LOCAL_SCENE_EXPLAINER_COPY as COPY } from './explainer-copy';

export function LocalSceneExplainerDialog() {
  const state = useStore(localSceneExplainerStore);

  if (!state) {
    return null;
  }

  const copy = COPY[state.cause];
  const close = () => localSceneExplainerStore.set(null);

  return (
    <DialogRoot open onOpenChange={close}>
      <Dialog showCloseButton={false}>
        <div className="p-6 flex flex-col gap-4">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body(state.origin)}</DialogDescription>
          <div className="flex justify-end">
            <DialogButton type="primary" onClick={close}>
              OK
            </DialogButton>
          </div>
        </div>
      </Dialog>
    </DialogRoot>
  );
}

/**
 * Global passkey prompt seam.
 *
 * The sync manager calls `requestPasskey()` when it needs to unlock the
 * credential vault. The app shell (app-root.ts) registers the actual
 * prompt implementation via `setPasskeyPrompt()` so that the sync manager
 * does not depend on Lit components.
 *
 * The registered function is responsible for unlocking the vault (e.g. by
 * opening the passkey modal, which calls `unlock()` internally) and
 * resolving to `true` on success or `false` if the user cancelled.
 */
type PasskeyPromptFn = () => Promise<boolean>;

let promptFn: PasskeyPromptFn | null = null;

export function setPasskeyPrompt(fn: PasskeyPromptFn): void {
  promptFn = fn;
}

export async function requestPasskey(): Promise<boolean> {
  if (!promptFn) return false;
  return promptFn();
}

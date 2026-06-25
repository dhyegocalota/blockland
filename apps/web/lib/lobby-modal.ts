// Open a lobby modal and wire its three close affordances — its own close button, a click on the
// backdrop (outside the panel), and the Escape key. The lobby reuses the in-game `#controls` element for
// its "instructions" modal, but that element's close handlers live in the engine's HUD wiring (hud.ts),
// which only runs once the game has started — so on the lobby they're absent and the modal gets stuck
// open. This wires them itself, and each handler detaches on close so reopening re-wires cleanly.
export function openLobbyModal(modal: HTMLElement, closeButton: HTMLElement | null): void {
  modal.hidden = false;

  function close(): void {
    modal.hidden = true;
    modal.removeEventListener('click', onBackdrop);
    closeButton?.removeEventListener('click', close);
    window.removeEventListener('keydown', onKey);
  }
  function onKey(event: KeyboardEvent): void {
    if (event.code === 'Escape') close();
  }
  function onBackdrop(event: MouseEvent): void {
    if (event.target === modal) close();
  }

  modal.addEventListener('click', onBackdrop);
  closeButton?.addEventListener('click', close);
  window.addEventListener('keydown', onKey);
}

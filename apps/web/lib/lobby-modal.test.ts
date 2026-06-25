// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { openLobbyModal } from './lobby-modal';

afterEach(() => { document.body.innerHTML = ''; });

function build(): { modal: HTMLElement; panel: HTMLElement; closeBtn: HTMLElement } {
  document.body.innerHTML = '<div id="controls" hidden><div class="panel"></div><button id="close"></button></div>';
  const modal = document.getElementById('controls')!;
  return { modal, panel: modal.querySelector('.panel')!, closeBtn: document.getElementById('close')! };
}

describe('openLobbyModal', () => {
  it('shows the modal', () => {
    const { modal, closeBtn } = build();
    openLobbyModal(modal, closeBtn);
    expect(modal.hidden).toBe(false);
  });

  it('closes on the close button', () => {
    const { modal, closeBtn } = build();
    openLobbyModal(modal, closeBtn);
    closeBtn.click();
    expect(modal.hidden).toBe(true);
  });

  it('closes on a backdrop click but not on a click inside the panel', () => {
    const { modal, panel, closeBtn } = build();
    openLobbyModal(modal, closeBtn);
    panel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.hidden).toBe(false);
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.hidden).toBe(true);
  });

  it('closes on Escape', () => {
    const { modal, closeBtn } = build();
    openLobbyModal(modal, closeBtn);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    expect(modal.hidden).toBe(true);
  });

  it('detaches its handlers on close, so a stray Esc afterward does nothing', () => {
    const { modal, closeBtn } = build();
    openLobbyModal(modal, closeBtn);
    closeBtn.click();
    modal.hidden = false; // somebody shows it again without re-wiring
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    expect(modal.hidden).toBe(false); // the old Esc handler is gone
  });
});

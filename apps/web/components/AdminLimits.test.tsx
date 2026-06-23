// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminLimits from './AdminLimits';
import type { RoomState } from '../lib/coop';

const baseRoom: RoomState = {
  peace: true, blockedStructures: [], pvp: false, chatEnabled: true, suspended: false,
  approvalRequired: false, playtimeLimitMin: 0, playtimeWindowH: 0, onlineAllowed: true, offlineAllowed: true,
};

function renderLimits(overrides: Partial<RoomState> = {}) {
  const setLimits = vi.fn();
  render(
    <AdminLimits
      room={{ ...baseRoom, ...overrides }}
      setLimits={setLimits}
      toggleOnlineAllowed={vi.fn()}
      toggleOfflineAllowed={vi.fn()}
    />,
  );
  const checkbox = () => screen.getByRole('checkbox') as HTMLInputElement;
  return { setLimits, checkbox };
}

afterEach(cleanup);

describe('AdminLimits play-time', () => {
  it('starts unlimited (checkbox off, inputs hidden) when the world has no limit', () => {
    const { checkbox } = renderLimits({ playtimeLimitMin: 0 });
    expect(checkbox().checked).toBe(false);
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('starts limited (checkbox on, inputs shown) when the world has a limit', () => {
    renderLimits({ playtimeLimitMin: 15, playtimeWindowH: 24 });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
  });

  it('enabling the limit reveals the inputs and auto-saves the default 5 min / 24 h', () => {
    const { setLimits, checkbox } = renderLimits({ playtimeLimitMin: 0, playtimeWindowH: 0 });
    fireEvent.click(checkbox());
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
    expect(setLimits).toHaveBeenCalledWith(5, 24);
  });

  it('disabling the limit auto-saves unlimited (0)', () => {
    const { setLimits, checkbox } = renderLimits({ playtimeLimitMin: 15, playtimeWindowH: 24 });
    fireEvent.click(checkbox());
    expect(setLimits).toHaveBeenCalledWith(0, 24);
  });

  it('editing a field auto-saves on blur, clamping a zero back to the default', () => {
    const { setLimits } = renderLimits({ playtimeLimitMin: 15, playtimeWindowH: 24 });
    const minutes = screen.getAllByRole('spinbutton')[0];
    fireEvent.change(minutes, { target: { value: '0' } });
    fireEvent.blur(minutes);
    expect(setLimits).toHaveBeenCalledWith(5, 24);
  });

  it('editing a field to a valid value auto-saves it', () => {
    const { setLimits } = renderLimits({ playtimeLimitMin: 15, playtimeWindowH: 24 });
    const minutes = screen.getAllByRole('spinbutton')[0];
    fireEvent.change(minutes, { target: { value: '10' } });
    fireEvent.blur(minutes);
    expect(setLimits).toHaveBeenCalledWith(10, 24);
  });
});

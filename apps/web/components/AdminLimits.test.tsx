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
  const save = () => fireEvent.submit(checkbox().closest('form')!);
  return { setLimits, checkbox, save };
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

  it('reveals the inputs when the limit is enabled', () => {
    const { checkbox } = renderLimits({ playtimeLimitMin: 0 });
    fireEvent.click(checkbox());
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
  });

  it('saves an unlimited (0) limit when the checkbox is off', () => {
    const { setLimits, save } = renderLimits({ playtimeLimitMin: 0, playtimeWindowH: 24 });
    save();
    expect(setLimits).toHaveBeenCalledWith(0, 24);
  });

  it('saves the entered minutes when the checkbox is on', () => {
    const { setLimits, save } = renderLimits({ playtimeLimitMin: 15, playtimeWindowH: 24 });
    save();
    expect(setLimits).toHaveBeenCalledWith(15, 24);
  });
});

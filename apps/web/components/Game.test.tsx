// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useGame = vi.fn();
vi.mock('../lib/hooks/use-game', () => ({ useGame: () => useGame() }));

import Game from './Game';

afterEach(cleanup);

describe('Game', () => {
  it('shows the load error when the tenant failed to resolve', () => {
    useGame.mockReturnValue({ failed: true });
    render(<Game />);
    expect(screen.getByText((_, node) => node?.id === 'loadError')).toBeInTheDocument();
  });

  it('renders nothing until the brand resolves', () => {
    useGame.mockReturnValue({ failed: false, brand: null });
    const { container } = render(<Game />);
    expect(container.firstChild).toBeNull();
  });
});

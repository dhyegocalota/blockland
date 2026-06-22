// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Leaderboard from './Leaderboard';

afterEach(cleanup);

describe('Leaderboard', () => {
  it('renders the collapsed toggle and stays closed until clicked', () => {
    render(<Leaderboard tenant="acme" />);
    expect(screen.getByRole('button')).toHaveAttribute('id', 'boardToggle');
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});

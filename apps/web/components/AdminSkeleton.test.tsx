// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AdminSkeleton from './AdminSkeleton';

afterEach(cleanup);

describe('AdminSkeleton', () => {
  it('renders the requested number of shimmer rows', () => {
    render(<AdminSkeleton rows={4} />);
    expect(screen.getByTestId('admin-skeleton').querySelectorAll('.adminSkeletonRow')).toHaveLength(4);
  });
});

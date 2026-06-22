// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ServiceWorker from './ServiceWorker';

afterEach(cleanup);

describe('ServiceWorker', () => {
  it('renders nothing and skips registration outside production', () => {
    const { container } = render(<ServiceWorker />);
    expect(container.firstChild).toBeNull();
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GameLoader from './GameLoader';
import { LoaderPhase, LoaderStage, type LoaderState } from '../lib/engine/loader-state';

afterEach(cleanup);

describe('GameLoader', () => {
  it('shows the on-brand world line and progress while loading', () => {
    const state: LoaderState = { phase: LoaderPhase.Loading, stage: LoaderStage.World };
    render(<GameLoader state={state} retry={() => {}} />);
    expect(document.getElementById('gameLoader')).toBeInTheDocument();
    expect(screen.getByText('Preparando seu mundo…')).toBeInTheDocument();
    expect(document.querySelector('.loaderFill')).toHaveStyle({ width: '90%' });
  });

  it('shows the engine stage line first', () => {
    const state: LoaderState = { phase: LoaderPhase.Loading, stage: LoaderStage.Engine };
    render(<GameLoader state={state} retry={() => {}} />);
    expect(screen.getByText('Carregando o motor do jogo…')).toBeInTheDocument();
  });

  it('renders the retry path on error instead of a blank screen', () => {
    const retry = vi.fn();
    const state: LoaderState = { phase: LoaderPhase.Error };
    render(<GameLoader state={state} retry={retry} />);
    expect(screen.getByText('Algo deu errado')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Tentar de novo'));
    expect(retry).toHaveBeenCalledOnce();
  });
});

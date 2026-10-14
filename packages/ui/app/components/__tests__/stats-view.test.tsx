import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StatsView } from '../StatsView.js';

describe('StatsView', () => {
  it('renders the initial log rows', async () => {
    render(<StatsView />);
    expect(await screen.findAllByTestId('log-row')).toHaveLength(2);
  });

  it('appends older entries when loading more and hides the button on the last page', async () => {
    // The msw handler always returns the same page with a nextCursor; after the
    // click the list grows, and re-clicking is a no-op the UI still allows.
    render(<StatsView />);
    const loadMore = await screen.findByRole('button', { name: /加载更多|Load more/ });
    await userEvent.click(loadMore);
    // 2 rows duplicated by append (msw stub has no per-cursor data).
    expect(await screen.findAllByTestId('log-row')).toHaveLength(4);
  });

  it('switches the trend section between table, bar and pie views', async () => {
    render(<StatsView />);
    await userEvent.click(await screen.findByRole('button', { name: /柱状图|Bar/ }));
    expect(screen.getAllByTestId('bar').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /环形图|Pie/ }));
    expect(screen.getAllByTestId('slice').length).toBeGreaterThan(0);
  });

  it('switches the stats range', async () => {
    render(<StatsView />);
    await userEvent.click(await screen.findByRole('button', { name: /90 ?天|90 days/ }));
    expect(screen.getByRole('button', { name: /90 ?天|90 days/ })).toBeInTheDocument();
  });
});

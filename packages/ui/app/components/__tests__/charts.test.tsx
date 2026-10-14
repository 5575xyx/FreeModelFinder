import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BarChart } from '../charts/BarChart.js';
import { DonutChart } from '../charts/DonutChart.js';
describe('BarChart', () => {
  it('renders one bar per point and labels the chart', () => {
    render(
      <BarChart
        points={[
          { label: '10-14', value: 3 },
          { label: '10-15', value: 0 },
        ]}
        ariaLabel="调用趋势"
      />,
    );
    expect(screen.getByRole('img', { name: '调用趋势' })).toBeInTheDocument();
    expect(screen.getAllByTestId('bar')).toHaveLength(2);
  });

  it('gives zero-value points a visible track instead of no bar at all', () => {
    render(<BarChart points={[{ label: 'x', value: 0 }]} ariaLabel="趋势" />);
    const bar = screen.getByTestId('bar');
    expect(bar.getAttribute('data-value')).toBe('0');
  });
});

describe('DonutChart', () => {
  it('renders one slice per entry and a non-zero total', () => {
    render(
      <DonutChart
        slices={[
          { label: 'a', value: 5 },
          { label: 'b', value: 5 },
        ]}
        ariaLabel="模型占比"
      />,
    );
    expect(screen.getByRole('img', { name: '模型占比' })).toBeInTheDocument();
    expect(screen.getAllByTestId('slice')).toHaveLength(2);
  });

  it('renders an empty state instead of dividing by zero when all values are zero', () => {
    render(
      <DonutChart
        slices={[
          { label: 'a', value: 0 },
          { label: 'b', value: 0 },
        ]}
        ariaLabel="占比"
      />,
    );
    expect(screen.getByTestId('chart-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('slice')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('NaN');
  });
});

import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SettingsView } from '../SettingsView';

async function openCustomTab() {
  render(<SettingsView aliases={{}} />);
  const tab = await screen.findByRole('tab', { name: /自定义|Custom/i });
  await userEvent.click(tab);
}

describe('SettingsView keep-alive', () => {
  it('renders a per-source keep-alive switch and interval with the 14-minute default', async () => {
    await openCustomTab();
    const toggle = await screen.findByRole('checkbox', { name: /参与保活|Keep-alive/ });
    expect(toggle).toBeInTheDocument();
    expect((toggle as HTMLInputElement).checked).toBe(true);
    const interval = screen.getByLabelText(/间隔（分钟）|Interval \(min\)/);
    expect(interval).toHaveValue(14);
  });

  it('lets the interval be edited and clamps to the 1..60 range', async () => {
    await openCustomTab();
    const interval = (await screen.findByLabelText(
      /间隔（分钟）|Interval \(min\)/,
    )) as HTMLInputElement;
    fireEvent.change(interval, { target: { value: '5' } });
    expect(interval).toHaveValue(5);
    fireEvent.change(interval, { target: { value: '999' } });
    expect(interval).toHaveValue(60);
  });
});

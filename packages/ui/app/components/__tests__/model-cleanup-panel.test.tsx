import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ModelCleanupLogPanel } from '../ModelCleanupLogPanel';
import { gateway, server } from '../../../test/server';

function serveLog(entries: Array<Record<string, unknown>>) {
  server.use(http.get(`${gateway}/api/model-cleanup-log`, () => HttpResponse.json({ entries })));
}

describe('ModelCleanupLogPanel', () => {
  it('shows the empty state when no entries exist', async () => {
    render(<ModelCleanupLogPanel />);
    await waitFor(() => {
      expect(screen.getByText('最近 24 小时没有自动清理记录。')).toBeTruthy();
    });
  });

  it('renders entries with pruning summary and removed model ids', async () => {
    const ts = Date.now() - 60_000;
    serveLog([
      {
        ts,
        removedModelIds: ['openrouter:llama-3'],
        fullyRemovedProviders: ['gemini'],
        allowlistEntriesPruned: 2,
        aliasEntriesPruned: 1,
        autoRoutePoolsEmptied: 1,
        defaultModelChanged: true,
      },
    ]);
    render(<ModelCleanupLogPanel />);
    await waitFor(() => {
      expect(screen.getByText('模型移除自动清理')).toBeTruthy();
    });
    expect(screen.getByText('清理 2 条允许列表')).toBeTruthy();
    expect(screen.getByText('清理 1 个别名')).toBeTruthy();
    expect(screen.getByText('清空 1 个路由池')).toBeTruthy();
    expect(screen.getByText('重置默认模型')).toBeTruthy();
    expect(screen.getByText(/上游移除整个 provider：gemini/)).toBeTruthy();
    expect(screen.getByText('openrouter:llama-3')).toBeTruthy();
  });

  it('excludes entries older than 24h', async () => {
    const oldTs = Date.now() - 2 * 86_400_000;
    serveLog([
      {
        ts: oldTs,
        removedModelIds: ['openrouter:old'],
        fullyRemovedProviders: [],
        allowlistEntriesPruned: 1,
        aliasEntriesPruned: 0,
        autoRoutePoolsEmptied: 0,
        defaultModelChanged: false,
      },
    ]);
    render(<ModelCleanupLogPanel />);
    await waitFor(() => {
      expect(screen.getByText('最近 24 小时没有自动清理记录。')).toBeTruthy();
    });
  });

  it('shows an error message on gateway failure', async () => {
    server.use(http.get(`${gateway}/api/model-cleanup-log`, () => HttpResponse.error()));
    render(<ModelCleanupLogPanel />);
    await waitFor(() => {
      expect(screen.getByText(/获取模型变动失败/)).toBeTruthy();
    });
  });
});

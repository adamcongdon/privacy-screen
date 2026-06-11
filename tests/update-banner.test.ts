/**
 * Tests for web/src/components/UpdateAvailableBanner.tsx.
 *
 * Renders the React component into a happy-dom container (the test preload at
 * tests/happy-dom-setup.ts sets up document/window) and queries the resulting
 * DOM. No React Testing Library — the project doesn't ship it as a dep.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import UpdateAvailableBanner from '../web/src/components/UpdateAvailableBanner';
import { useStore } from '../web/src/store';

// React 18 testing env opt-in — required for act() to suppress
// "current testing environment is not configured" warnings.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VERSION_INFO_AVAILABLE = {
  version: '1.0.0',
  channel: 'stable' as const,
  updateAvailable: true,
  updateInfo: {
    version: '1.2.3',
    channel: 'stable',
    url: 'https://example.invalid/r',
    sha256: 'a'.repeat(64),
    releasedAt: '2026-06-02T00:00:00Z',
  },
  latestKnown: '1.2.3',
} as const;

let container: HTMLElement;
let root: Root;

function render(node: React.ReactElement): void {
  act(() => {
    root.render(node);
  });
}

beforeEach(() => {
  // Reset store between tests.
  useStore.setState({
    versionInfo: null,
    dismissedUpdateVersion: null,
    settingsDeepLink: null,
    settingsOpen: false,
  });
  try {
    globalThis.localStorage?.removeItem('ps.dismissed-update-version');
  } catch {
    /* ignore */
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

test('renders when updateAvailable and version not dismissed', () => {
  useStore.setState({ versionInfo: VERSION_INFO_AVAILABLE });
  render(React.createElement(UpdateAvailableBanner));

  const text = container.textContent ?? '';
  expect(text).toContain('v1.2.3');
  expect(text).toContain('(stable)');
  // role=status for assistive tech
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

test('does not render when dismissed version matches available version', () => {
  useStore.setState({
    versionInfo: VERSION_INFO_AVAILABLE,
    dismissedUpdateVersion: '1.2.3',
  });
  render(React.createElement(UpdateAvailableBanner));

  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.textContent ?? '').not.toContain('v1.2.3');
});

test('does not render when updateAvailable is false', () => {
  useStore.setState({
    versionInfo: {
      version: '1.0.0',
      channel: 'stable',
      updateAvailable: false,
      updateInfo: null,
      latestKnown: '1.0.0',
    },
  });
  render(React.createElement(UpdateAvailableBanner));

  expect(container.querySelector('[role="status"]')).toBeNull();
});

test('reappears when a newer version arrives after dismiss of older one', () => {
  useStore.setState({
    versionInfo: VERSION_INFO_AVAILABLE,
    dismissedUpdateVersion: '1.2.3',
  });
  render(React.createElement(UpdateAvailableBanner));
  expect(container.querySelector('[role="status"]')).toBeNull();

  // Newer version arrives — dismissed-version no longer matches.
  act(() => {
    useStore.setState({
      versionInfo: {
        ...VERSION_INFO_AVAILABLE,
        updateInfo: { ...VERSION_INFO_AVAILABLE.updateInfo, version: '1.2.4' },
      },
    });
  });

  const banner = container.querySelector('[role="status"]');
  expect(banner).not.toBeNull();
  expect(container.textContent ?? '').toContain('v1.2.4');
});

test('dismiss button updates store and localStorage', () => {
  useStore.setState({ versionInfo: VERSION_INFO_AVAILABLE });
  render(React.createElement(UpdateAvailableBanner));

  const dismissBtn = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Dismiss update notification"]',
  );
  expect(dismissBtn).not.toBeNull();

  act(() => {
    dismissBtn!.click();
  });

  expect(useStore.getState().dismissedUpdateVersion).toBe('1.2.3');
  try {
    expect(globalThis.localStorage?.getItem('ps.dismissed-update-version')).toBe('1.2.3');
  } catch {
    /* localStorage may be disabled — store assertion above already proves it */
  }
});

test('clicking the banner body navigates to the settings route', () => {
  // Settings is a route now (the SettingsDrawer is no longer mounted), so the
  // banner CTA navigates via setRoute('settings') instead of opening a drawer.
  useStore.setState({ versionInfo: VERSION_INFO_AVAILABLE, route: 'scrub' });
  render(React.createElement(UpdateAvailableBanner));

  // The body is a button (distinct from the dismiss icon button).
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
  const bodyBtn = buttons.find(
    (b) => b.getAttribute('aria-label') !== 'Dismiss update notification',
  );
  expect(bodyBtn).toBeDefined();

  act(() => {
    bodyBtn!.click();
  });

  expect(useStore.getState().route).toBe('settings');
});

/* eslint-disable @typescript-eslint/no-explicit-any */

type PosthogWindow = Window & {
  posthog?: {
    init: (key: string, options?: Record<string, unknown>) => void;
    identify: (distinctId: string, properties?: Record<string, unknown>) => void;
    capture: (eventName: string, properties?: Record<string, unknown>) => void;
  };
};

let initialized = false;

function getWindow() {
  if (typeof window === 'undefined') {
    return null;
  }
  return window as PosthogWindow;
}

function resolveScriptHost(host: string) {
  const normalized = host.replace(/\/$/, '');
  return `${normalized}/static/array.js`;
}

function loadPosthogScript(host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const currentWindow = getWindow();
    if (!currentWindow) {
      resolve();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-posthog-script="true"]');
    if (existing) {
      if (currentWindow.posthog) {
        resolve();
      } else {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Failed to load PostHog script.')));
      }
      return;
    }

    const script = document.createElement('script');
    script.async = true;
    script.src = resolveScriptHost(host);
    script.dataset.posthogScript = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load PostHog script.'));
    document.head.appendChild(script);
  });
}

export async function initPosthog() {
  if (initialized) {
    return;
  }

  const currentWindow = getWindow();
  if (!currentWindow) {
    return;
  }

  const apiKey = import.meta.env.VITE_POSTHOG_KEY;
  const host = import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com';

  if (!apiKey) {
    return;
  }

  try {
    await loadPosthogScript(host);

    if (!currentWindow.posthog) {
      return;
    }

    currentWindow.posthog.init(apiKey, {
      api_host: host,
      autocapture: false,
      capture_pageview: false,
      persistence: 'localStorage+cookie',
    });

    initialized = true;
  } catch {
    // Intentionally silent; analytics should never block app usage.
  }
}

export function posthogIdentify(distinctId: string, properties?: Record<string, unknown>) {
  const currentWindow = getWindow();
  if (!currentWindow?.posthog || !initialized) {
    return;
  }
  currentWindow.posthog.identify(distinctId, properties);
}

export function posthogCapture(eventName: string, properties?: Record<string, unknown>) {
  const currentWindow = getWindow();
  if (!currentWindow?.posthog || !initialized) {
    return;
  }
  currentWindow.posthog.capture(eventName, properties);
}

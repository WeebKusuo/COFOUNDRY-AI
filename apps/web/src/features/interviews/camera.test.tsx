import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useCamera } from './camera';

function Probe() {
  const c = useCamera({ resume: true });
  return (
    <div>
      <span>{c.state}</span>
      <button onClick={() => c.stop()}>off</button>
    </div>
  );
}

function install(getUserMedia: () => Promise<unknown>) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia) },
  });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  window.sessionStorage.setItem('cofoundry-camera-self-view', 'on');
  return (navigator.mediaDevices as unknown as { getUserMedia: ReturnType<typeof vi.fn> })
    .getUserMedia;
}

afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  window.sessionStorage.clear();
});

describe('camera self-view stream lifetime', () => {
  it('stops a stream that arrives after the page was left', async () => {
    let resolve!: (s: unknown) => void;
    const stop = vi.fn();
    const gum = install(() => new Promise((r) => (resolve = r)));
    const r = render(<Probe />);
    expect(gum).toHaveBeenCalledTimes(1);
    r.unmount();
    await act(async () => resolve({ getTracks: () => [{ stop }] }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('opens one stream under StrictMode and stops it on unmount', async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const gum = install(async () => {
      const s = vi.fn();
      stops.push(s);
      return { getTracks: () => [{ stop: s }] };
    });
    const r = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await act(async () => new Promise((x) => setTimeout(x, 10)));
    expect(screen.getByText('on')).toBeInTheDocument();
    r.unmount();
    expect(gum).toHaveBeenCalledTimes(1);
    expect(stops.map((s) => s.mock.calls.length)).toEqual([1]);
  });

  it('discards a pending request when the camera is turned off first', async () => {
    let resolve!: (s: unknown) => void;
    const stop = vi.fn();
    install(() => new Promise((r) => (resolve = r)));
    render(<Probe />);
    await act(async () => screen.getByRole('button', { name: 'off' }).click());
    await act(async () => resolve({ getTracks: () => [{ stop }] }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByText('off', { selector: 'span' })).toBeInTheDocument();
  });
});

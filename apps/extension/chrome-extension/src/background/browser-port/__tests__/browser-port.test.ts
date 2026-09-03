import { describe, expect, it, vi } from 'vitest';
import type BrowserContext from '../../browser/context';
import { Mv3BrowserPort } from '../mv3';
import { FakeBrowserPort, blankObservation } from '../fake';

const STATE = {
  url: 'https://example.com',
  title: 'Example',
  screenshot: 'shot',
};

function mockPage() {
  return {
    detachPuppeteer: vi.fn().mockResolvedValue(undefined),
    attachPuppeteer: vi.fn().mockResolvedValue(true),
    waitForPageAndFramesLoad: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    goForward: vi.fn().mockResolvedValue(undefined),
    refreshPage: vi.fn().mockResolvedValue(undefined),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    scrollToPercent: vi.fn().mockResolvedValue(undefined),
    scrollToPreviousPage: vi.fn().mockResolvedValue(undefined),
    scrollToNextPage: vi.fn().mockResolvedValue(undefined),
    scrollToText: vi.fn().mockResolvedValue(true),
    getDropdownOptions: vi.fn().mockResolvedValue([{ index: 0, text: 'A', value: 'a' }]),
    selectDropdownOption: vi.fn().mockResolvedValue('Selected option "A"'),
    getDomElementByIndex: vi.fn().mockReturnValue({ xpath: '//button' }),
    clickElementNode: vi.fn().mockResolvedValue(undefined),
    inputTextElementNode: vi.fn().mockResolvedValue(undefined),
  };
}

function mockContext() {
  const page = mockPage();
  const context = {
    getState: vi.fn().mockResolvedValue({ ...STATE }),
    getCachedState: vi.fn().mockResolvedValue({ ...STATE }),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    openTab: vi.fn().mockResolvedValue(page),
    closeTab: vi.fn().mockResolvedValue(undefined),
    switchTab: vi.fn().mockResolvedValue(page),
    getCurrentPage: vi.fn().mockResolvedValue(page),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
  return { fns: context, page, context: context as unknown as BrowserContext };
}

describe('Mv3BrowserPort delegation', () => {
  it('observe reads fresh state by default and adapts the shape', async () => {
    const { fns, context } = mockContext();
    const port = new Mv3BrowserPort(context);

    const obs = await port.observe();

    expect(fns.getState).toHaveBeenCalledWith(false);
    expect(fns.getCachedState).not.toHaveBeenCalled();
    expect(obs.url).toBe(STATE.url);
    expect(obs.title).toBe(STATE.title);
    expect(obs.screenshot).toBe(STATE.screenshot);
    expect(obs.raw).toEqual({ ...STATE });
  });

  it('observe passes useVision/cached through to the underlying context', async () => {
    const { fns, context } = mockContext();
    const port = new Mv3BrowserPort(context);

    await port.observe({ useVision: true, cached: true });

    expect(fns.getCachedState).toHaveBeenCalledWith(true);
    expect(fns.getState).not.toHaveBeenCalled();
  });

  it('execute routes tab verbs to the context', async () => {
    const { fns, context } = mockContext();
    const port = new Mv3BrowserPort(context);

    expect(await port.execute({ kind: 'navigate', url: 'https://a.com' })).toMatchObject({ ok: true });
    expect(fns.navigateTo).toHaveBeenCalledWith('https://a.com');

    expect(await port.execute({ kind: 'openTab', url: 'https://b.com' })).toMatchObject({ ok: true });
    expect(fns.openTab).toHaveBeenCalledWith('https://b.com');

    expect(await port.execute({ kind: 'closeTab', tabId: 7 })).toMatchObject({ ok: true });
    expect(fns.closeTab).toHaveBeenCalledWith(7);

    expect(await port.execute({ kind: 'switchTab', tabId: 9 })).toMatchObject({ ok: true });
    expect(fns.switchTab).toHaveBeenCalledWith(9);
  });

  it('execute routes page verbs through the current page', async () => {
    const { page, context } = mockContext();
    const port = new Mv3BrowserPort(context, { useVision: true });

    expect(await port.execute({ kind: 'click', index: 3 })).toMatchObject({ ok: true });
    expect(page.getDomElementByIndex).toHaveBeenCalledWith(3);
    expect(page.clickElementNode).toHaveBeenCalledWith(true, { xpath: '//button' });

    expect(await port.execute({ kind: 'inputText', index: 4, text: 'hi' })).toMatchObject({ ok: true });
    expect(page.inputTextElementNode).toHaveBeenCalledWith(true, { xpath: '//button' }, 'hi');

    expect(await port.execute({ kind: 'scrollPage', direction: 'down' })).toMatchObject({ ok: true });
    expect(page.scrollToNextPage).toHaveBeenCalled();

    const dropdown = await port.execute({ kind: 'getDropdownOptions', index: 1 });
    expect(dropdown).toMatchObject({ ok: true, data: [{ index: 0, text: 'A', value: 'a' }] });
  });

  it('execute reports missing elements and driver errors instead of throwing', async () => {
    const { fns, page, context } = mockContext();
    page.getDomElementByIndex.mockReturnValue(null);
    const port = new Mv3BrowserPort(context);

    const missing = await port.execute({ kind: 'click', index: 99 });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('99');

    fns.navigateTo.mockRejectedValueOnce(new Error('blocked'));
    const failed = await port.execute({ kind: 'navigate', url: 'https://x.com' });
    expect(failed).toMatchObject({ ok: false, error: 'blocked' });
  });

  it('waitFor converts ms to the page settle call', async () => {
    const { page, context } = mockContext();
    const port = new Mv3BrowserPort(context);

    await port.waitFor({ timeoutMs: 2000 });

    expect(page.waitForPageAndFramesLoad).toHaveBeenCalledWith(2);
  });

  it('reconnect detaches and reattaches the current page', async () => {
    const { fns, page, context } = mockContext();
    const port = new Mv3BrowserPort(context);

    await port.reconnect();

    expect(page.detachPuppeteer).toHaveBeenCalled();
    expect(page.attachPuppeteer).toHaveBeenCalled();
    expect(fns.switchTab).not.toHaveBeenCalled();

    await port.reconnect({ tabId: 5 });
    expect(fns.switchTab).toHaveBeenCalledWith(5);
  });

  it('release delegates to context cleanup (tabs stay open, Chrome keeps running)', async () => {
    const { fns, context } = mockContext();
    const port = new Mv3BrowserPort(context);

    await port.release();

    expect(fns.cleanup).toHaveBeenCalled();
  });
});

describe('FakeBrowserPort', () => {
  it('replays scripted observations in order, sticking on the last', async () => {
    const port = new FakeBrowserPort({
      observations: [blankObservation({ url: 'https://a.com' }), blankObservation({ url: 'https://b.com' })],
    });

    expect((await port.observe()).url).toBe('https://a.com');
    expect((await port.observe()).url).toBe('https://b.com');
    expect((await port.observe()).url).toBe('https://b.com');
  });

  it('records executed actions and replays scripted results', async () => {
    const port = new FakeBrowserPort({ results: [{ ok: false, error: 'nope' }] });

    const first = await port.execute({ kind: 'navigate', url: 'https://a.com' });
    const second = await port.execute({ kind: 'click', index: 1 });

    expect(first).toMatchObject({ ok: false, error: 'nope' });
    expect(second).toMatchObject({ ok: true });
    expect(port.recorded).toEqual([
      { kind: 'navigate', url: 'https://a.com' },
      { kind: 'click', index: 1 },
    ]);
  });

  it('tracks wait/reconnect/release lifecycle calls', async () => {
    const port = new FakeBrowserPort();

    await port.waitFor();
    await port.waitFor();
    await port.reconnect();
    expect(port.released).toBe(false);
    await port.release();

    expect(port.waitCalls).toBe(2);
    expect(port.reconnectCalls).toBe(1);
    expect(port.released).toBe(true);
  });
});

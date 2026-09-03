import type BrowserContext from '../browser/context';
import type {
  BrowserAction,
  BrowserPort,
  ExecuteResult,
  Observation,
  ObserveOptions,
  ReconnectOptions,
  WaitOptions,
} from './types';

export interface Mv3BrowserPortOptions {
  /** Forwarded to Page click/input helpers for highlight capture. @default false */
  useVision?: boolean;
}

/**
 * MV3-backed BrowserPort: thin wrapper that delegates every verb to the
 * existing in-extension `BrowserContext`/`Page` code. No driver logic lives
 * here — only seam adaptation (argument routing, return-shape mapping,
 * error enveloping). This proves the current driver answers the plug.
 */
export class Mv3BrowserPort implements BrowserPort {
  private readonly useVision: boolean;

  constructor(
    private readonly context: BrowserContext,
    options?: Mv3BrowserPortOptions,
  ) {
    this.useVision = options?.useVision ?? false;
  }

  async observe(options?: ObserveOptions): Promise<Observation> {
    const useVision = options?.useVision ?? false;
    const state = options?.cached
      ? await this.context.getCachedState(useVision)
      : await this.context.getState(useVision);
    return { url: state.url, title: state.title, screenshot: state.screenshot, raw: state };
  }

  async execute(action: BrowserAction): Promise<ExecuteResult> {
    try {
      switch (action.kind) {
        case 'navigate':
          await this.context.navigateTo(action.url);
          return { ok: true, message: `Navigated to ${action.url}` };
        case 'openTab':
          await this.context.openTab(action.url);
          return { ok: true, message: `Opened tab ${action.url}` };
        case 'closeTab':
          await this.context.closeTab(action.tabId);
          return { ok: true, message: `Closed tab ${action.tabId}` };
        case 'switchTab':
          await this.context.switchTab(action.tabId);
          return { ok: true, message: `Switched to tab ${action.tabId}` };
        case 'goBack':
        case 'goForward':
        case 'refresh':
        case 'sendKeys':
        case 'scrollToPercent':
        case 'scrollPage':
        case 'scrollToText':
        case 'click':
        case 'inputText':
        case 'getDropdownOptions':
        case 'selectDropdownOption':
          return await this.executeOnPage(action);
        default:
          return { ok: false, error: `Unsupported action: ${String((action as BrowserAction).kind)}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executeOnPage(
    action: Extract<
      BrowserAction,
      | { kind: 'goBack' }
      | { kind: 'goForward' }
      | { kind: 'refresh' }
      | { kind: 'sendKeys' }
      | { kind: 'scrollToPercent' }
      | { kind: 'scrollPage' }
      | { kind: 'scrollToText' }
      | { kind: 'click' }
      | { kind: 'inputText' }
      | { kind: 'getDropdownOptions' }
      | { kind: 'selectDropdownOption' }
    >,
  ): Promise<ExecuteResult> {
    const page = await this.context.getCurrentPage();
    switch (action.kind) {
      case 'goBack':
        await page.goBack();
        return { ok: true, message: 'Navigated back' };
      case 'goForward':
        await page.goForward();
        return { ok: true, message: 'Navigated forward' };
      case 'refresh':
        await page.refreshPage();
        return { ok: true, message: 'Page refreshed' };
      case 'sendKeys':
        await page.sendKeys(action.keys);
        return { ok: true, message: `Sent keys ${action.keys}` };
      case 'scrollToPercent': {
        const element = action.index !== undefined ? page.getDomElementByIndex(action.index) : null;
        if (action.index !== undefined && !element) {
          return { ok: false, error: `Element with index ${action.index} does not exist` };
        }
        await page.scrollToPercent(action.yPercent, element ?? undefined);
        return { ok: true, message: `Scrolled to ${action.yPercent}%` };
      }
      case 'scrollPage':
        if (action.direction === 'up') {
          await page.scrollToPreviousPage();
        } else {
          await page.scrollToNextPage();
        }
        return { ok: true, message: `Scrolled ${action.direction}` };
      case 'scrollToText': {
        const found = await page.scrollToText(action.text);
        return found
          ? { ok: true, message: `Scrolled to text "${action.text}"` }
          : { ok: false, error: `Text "${action.text}" not found` };
      }
      case 'click': {
        const element = page.getDomElementByIndex(action.index);
        if (!element) {
          return { ok: false, error: `Element with index ${action.index} does not exist` };
        }
        await page.clickElementNode(this.useVision, element);
        return { ok: true, message: `Clicked element ${action.index}` };
      }
      case 'inputText': {
        const element = page.getDomElementByIndex(action.index);
        if (!element) {
          return { ok: false, error: `Element with index ${action.index} does not exist` };
        }
        await page.inputTextElementNode(this.useVision, element, action.text);
        return { ok: true, message: `Input "${action.text}" into element ${action.index}` };
      }
      case 'getDropdownOptions': {
        const options = await page.getDropdownOptions(action.index);
        return { ok: true, message: `Read ${options.length} dropdown options`, data: options };
      }
      case 'selectDropdownOption': {
        const message = await page.selectDropdownOption(action.index, action.text);
        return { ok: true, message };
      }
    }
  }

  async waitFor(options?: WaitOptions): Promise<void> {
    const page = await this.context.getCurrentPage();
    // waitForPageAndFramesLoad takes its override in seconds; WaitOptions speaks ms.
    await page.waitForPageAndFramesLoad(options?.timeoutMs !== undefined ? options.timeoutMs / 1000 : undefined);
  }

  async reconnect(options?: ReconnectOptions): Promise<void> {
    const page =
      options?.tabId !== undefined ? await this.context.switchTab(options.tabId) : await this.context.getCurrentPage();
    await page.detachPuppeteer();
    await page.attachPuppeteer();
  }

  async release(): Promise<void> {
    // BrowserContext.cleanup only detaches puppeteer sessions — tabs stay open
    // and the user's Chrome keeps running.
    await this.context.cleanup();
  }
}

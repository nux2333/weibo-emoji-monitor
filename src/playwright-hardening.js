'use strict';

/*
 * Global Playwright anti-hang guard.
 *
 * Preload this module with Node -r / --require. Business code keeps its own
 * shorter navigation/fetch timeouts; this layer is the final watchdog so a
 * single Browser/Page operation cannot block an entire batch forever.
 */

const HARDENED = Symbol.for('weibo.playwright.hardened');
const ORIGINAL = Symbol.for('weibo.playwright.original');
const LAST_HARD_TIMEOUT = Symbol.for('weibo.playwright.lastHardTimeout');

const ACTION_TIMEOUT_MS = positiveEnv(
  'PLAYWRIGHT_ACTION_TIMEOUT_MS',
  15000
);
const NAVIGATION_TIMEOUT_MS = positiveEnv(
  'PLAYWRIGHT_NAVIGATION_TIMEOUT_MS',
  60000
);
const GOTO_HARD_TIMEOUT_MS = positiveEnv(
  'PLAYWRIGHT_GOTO_HARD_TIMEOUT_MS',
  70000
);
const EVALUATE_HARD_TIMEOUT_MS = positiveEnv(
  'PLAYWRIGHT_EVALUATE_HARD_TIMEOUT_MS',
  45000
);
const NEW_PAGE_HARD_TIMEOUT_MS = positiveEnv(
  'PLAYWRIGHT_NEW_PAGE_HARD_TIMEOUT_MS',
  20000
);
const NEW_CONTEXT_HARD_TIMEOUT_MS = positiveEnv(
  'PLAYWRIGHT_NEW_CONTEXT_HARD_TIMEOUT_MS',
  20000
);
const LAUNCH_HARD_TIMEOUT_MS = positiveEnv(
  'PLAYWRIGHT_LAUNCH_HARD_TIMEOUT_MS',
  30000
);
const CLOSE_HARD_TIMEOUT_MS = positiveEnv(
  'PLAYWRIGHT_CLOSE_HARD_TIMEOUT_MS',
  7000
);

function positiveEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

class PlaywrightHardTimeoutError extends Error {
  constructor(label, timeoutMs) {
    /*
     * 带上 ERR_TIMED_OUT，让业务层现有的网络错误判断可以把这个
     * watchdog 超时当成可重试网络故障处理，而不是把整个 Batch 弄死。
     */
    super(
      `PLAYWRIGHT_HARD_TIMEOUT ERR_TIMED_OUT: ${label} 超过 ${timeoutMs}ms`
    );
    this.name = 'PlaywrightHardTimeoutError';
    this.code = 'PLAYWRIGHT_HARD_TIMEOUT';
    this.operation = label;
    this.timeoutMs = timeoutMs;
  }
}

function isHardTimeoutError(error) {
  return !!error && (
    error.code === 'PLAYWRIGHT_HARD_TIMEOUT'
    || /PLAYWRIGHT_HARD_TIMEOUT/i.test(String(error.message || ''))
  );
}

function isClosedTargetError(error) {
  const message = String(error?.message || error || '');
  return (
    /Target page, context or browser has been closed/i.test(message)
    || /Target closed/i.test(message)
    || /Browser has been closed/i.test(message)
    || /Context has been closed/i.test(message)
    || /Page has been closed/i.test(message)
  );
}

function rememberHardTimeout(target, label, timeoutMs) {
  if (!target) return;
  try {
    target[LAST_HARD_TIMEOUT] = {
      label,
      timeoutMs,
      at: Date.now()
    };
  } catch {
    // best effort only
  }
}

function normalizeClosedAfterHardTimeout(target, error) {
  if (!isClosedTargetError(error)) return error;

  const last = target?.[LAST_HARD_TIMEOUT];
  if (!last) return error;

  return new PlaywrightHardTimeoutError(
    last.label || 'Playwright operation',
    last.timeoutMs || 1
  );
}

function withHardTimeout(task, timeoutMs, label, onTimeout = null) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  const promise =
    typeof task === 'function'
      ? Promise.resolve().then(task)
      : Promise.resolve(task);

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;

      if (typeof onTimeout === 'function') {
        try {
          Promise.resolve(onTimeout()).catch(() => {});
        } catch {
          // best effort only
        }
      }

      const error = new PlaywrightHardTimeoutError(label, ms);
      console.error(`[PlaywrightGuard] ${error.message}`);
      reject(error);
    }, ms);

    timer.unref?.();

    promise.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function wrapMethod(target, methodName, wrapperFactory) {
  if (!target || typeof target[methodName] !== 'function') return;

  const current = target[methodName];
  if (current[HARDENED]) return;

  const original = current.bind(target);
  const wrapped = wrapperFactory(original);

  Object.defineProperty(wrapped, HARDENED, {
    value: true
  });
  Object.defineProperty(wrapped, ORIGINAL, {
    value: original
  });

  try {
    target[methodName] = wrapped;
  } catch (error) {
    console.warn(
      `[PlaywrightGuard] 无法包装 ${methodName}: ${error?.message || error}`
    );
  }
}

function hardenPage(page) {
  if (!page || page[HARDENED]) return page;

  try {
    Object.defineProperty(page, HARDENED, {
      value: true,
      configurable: false
    });
  } catch {
    return page;
  }

  try {
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  } catch {
    // ignore closed pages
  }

  const originalClose =
    typeof page.close === 'function'
      ? page.close.bind(page)
      : null;

  wrapMethod(page, 'goto', original => async (...args) => {
    const options = args[1] && typeof args[1] === 'object'
      ? args[1]
      : null;
    const requested = Number(options?.timeout);
    const hardMs = Number.isFinite(requested) && requested > 0
      ? Math.min(GOTO_HARD_TIMEOUT_MS, requested + 5000)
      : GOTO_HARD_TIMEOUT_MS;
    const label = `page.goto ${String(args[0] || '').slice(0, 160)}`;

    return withHardTimeout(
      () => original(...args),
      hardMs,
      label,
      () => {
        rememberHardTimeout(page, label, hardMs);
        return originalClose?.({ runBeforeUnload: false });
      }
    );
  });

  for (const methodName of ['evaluate', 'evaluateHandle']) {
    wrapMethod(page, methodName, original => async (...args) => {
      const label = `page.${methodName}`;

      try {
        return await withHardTimeout(
          () => original(...args),
          EVALUATE_HARD_TIMEOUT_MS,
          label,
          () => {
            rememberHardTimeout(page, label, EVALUATE_HARD_TIMEOUT_MS);
            return originalClose?.({ runBeforeUnload: false });
          }
        );
      } catch (error) {
        throw normalizeClosedAfterHardTimeout(page, error);
      }
    });
  }

  /*
   * page.goto/evaluate 的硬超时会主动关闭 Page。业务代码有时会 catch 掉
   * 第一个 timeout，随后继续 waitForTimeout；Playwright 此时只会抛
   * "Target page, context or browser has been closed"，导致原始 ERR_TIMED_OUT
   * 信息丢失，业务层无法识别为可重试网络错误。
   *
   * 这里把这种“硬超时后的二次 closed 错误”恢复成
   * PlaywrightHardTimeoutError，使所有 Batch 都能继续沿用现有重试逻辑。
   */
  wrapMethod(page, 'waitForTimeout', original => async (...args) => {
    try {
      return await original(...args);
    } catch (error) {
      throw normalizeClosedAfterHardTimeout(page, error);
    }
  });

  if (originalClose) {
    wrapMethod(page, 'close', original => async (...args) =>
      withHardTimeout(
        () => original(...args),
        CLOSE_HARD_TIMEOUT_MS,
        'page.close'
      )
    );
  }

  return page;
}

function hardenContext(context) {
  if (!context || context[HARDENED]) return context;

  try {
    Object.defineProperty(context, HARDENED, {
      value: true,
      configurable: false
    });
  } catch {
    return context;
  }

  try {
    for (const page of context.pages?.() || []) {
      hardenPage(page);
    }
    context.on?.('page', hardenPage);
  } catch {
    // ignore
  }

  wrapMethod(context, 'newPage', original => async (...args) => {
    const page = await withHardTimeout(
      () => original(...args),
      NEW_PAGE_HARD_TIMEOUT_MS,
      'browserContext.newPage'
    );
    return hardenPage(page);
  });

  wrapMethod(context, 'close', original => async (...args) =>
    withHardTimeout(
      () => original(...args),
      CLOSE_HARD_TIMEOUT_MS,
      'browserContext.close'
    )
  );

  return context;
}

function hardenBrowser(browser) {
  if (!browser || browser[HARDENED]) return browser;

  try {
    Object.defineProperty(browser, HARDENED, {
      value: true,
      configurable: false
    });
  } catch {
    return browser;
  }

  try {
    for (const context of browser.contexts?.() || []) {
      hardenContext(context);
    }
  } catch {
    // ignore
  }

  wrapMethod(browser, 'newContext', original => async (...args) => {
    const context = await withHardTimeout(
      () => original(...args),
      NEW_CONTEXT_HARD_TIMEOUT_MS,
      'browser.newContext'
    );
    return hardenContext(context);
  });

  wrapMethod(browser, 'close', original => async (...args) =>
    withHardTimeout(
      () => original(...args),
      CLOSE_HARD_TIMEOUT_MS,
      'browser.close'
    )
  );

  return browser;
}

function patchBrowserType(browserType, name) {
  if (!browserType) return;

  wrapMethod(browserType, 'launch', original => async (...args) => {
    const browser = await withHardTimeout(
      () => original(...args),
      LAUNCH_HARD_TIMEOUT_MS,
      `${name}.launch`
    );
    return hardenBrowser(browser);
  });

  wrapMethod(browserType, 'launchPersistentContext', original => async (...args) => {
    const context = await withHardTimeout(
      () => original(...args),
      LAUNCH_HARD_TIMEOUT_MS,
      `${name}.launchPersistentContext`
    );

    hardenContext(context);
    hardenBrowser(context.browser?.());
    return context;
  });
}

function installPlaywrightHardening() {
  let playwright;

  try {
    playwright = require('playwright');
  } catch (error) {
    console.warn(
      `[PlaywrightGuard] playwright 未安装，跳过共通防卡保护: ${error?.message || error}`
    );
    return false;
  }

  patchBrowserType(playwright.chromium, 'chromium');
  patchBrowserType(playwright.firefox, 'firefox');
  patchBrowserType(playwright.webkit, 'webkit');

  console.log(
    '[PlaywrightGuard] 共通防卡保护已启用'
    + ` | action=${ACTION_TIMEOUT_MS}ms`
    + ` | gotoHard=${GOTO_HARD_TIMEOUT_MS}ms`
    + ` | evaluateHard=${EVALUATE_HARD_TIMEOUT_MS}ms`
    + ` | newPageHard=${NEW_PAGE_HARD_TIMEOUT_MS}ms`
    + ` | closeHard=${CLOSE_HARD_TIMEOUT_MS}ms`
  );

  return true;
}

installPlaywrightHardening();

module.exports = {
  PlaywrightHardTimeoutError,
  isHardTimeoutError,
  withHardTimeout,
  hardenPage,
  hardenContext,
  hardenBrowser,
  installPlaywrightHardening
};
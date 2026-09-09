const path = require('path');
const { ProxyPool } = require('../proxy-pool');

const SCAN_PROXY_POOL =
  new ProxyPool({
    /*
     * Scan 优先使用我们自己维护、已经通过微博实测的健康代理池。
     * 不再直接从 SCDN 临时拉原始候选。
     */
    filePath:
      process.env.WEIBO_GOOD_PROXY_FILE
      || path.join(
        __dirname,
        '..',
        '..',
        'data',
        'weibo-good-proxies.txt'
      ),

    dynamicSource:
      '',

    rawPool:
      process.env.SUPERLIKE_SCAN_PROXY_POOL
      || '',

    fallback:
      process.env.SUPERLIKE_SCAN_PROXY
      || process.env.WEIBO_PROXY
      || '',

    cooldownMs:
      Number(
        process.env.SUPERLIKE_PROXY_COOLDOWN_MS
      )
      || 30 * 60 * 1000,

    name:
      'scan'
  });


async function acquireScanProxyWaiting() {
  while (true) {
    const assignment =
      await SCAN_PROXY_POOL.acquire();

    if (
      assignment?.proxy
      &&
      !assignment.allCoolingDown
    ) {
      return assignment;
    }

    if (
      assignment?.allCoolingDown
      &&
      Number.isFinite(
        Number(assignment.nextReadyAt)
      )
    ) {
      const waitMs =
        Math.max(
          1000,
          Number(assignment.nextReadyAt)
            - Date.now()
        );

      console.log(
        `[SuperLike] 健康代理全部冷却，等待最近代理恢复：约${Math.ceil(waitMs / 1000)}秒。`
      );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            waitMs
          )
      );

      continue;
    }

    return {
      configured: false,
      raw: null,
      proxy: null,
      masked: 'LOCAL'
    };
  }
}

class Weibo418Error extends Error {
  constructor(message = '微博 HTTP 418') {
    super(message);
    this.name = 'Weibo418Error';
    this.isWeibo418 = true;
  }
}

function isWeibo418Error(error) {
  return !!(
    error
    && (
      error.isWeibo418
      || error.name === 'Weibo418Error'
      || String(error.message || '').includes('HTTP 418')
    )
  );
}

function isProxyConnectionError(error) {
  const text =
    String(
      error?.message
      || error
      || ''
    );

  return (
    /ERR_TUNNEL_CONNECTION_FAILED/i.test(text)
    ||
    /ERR_PROXY_CONNECTION_FAILED/i.test(text)
    ||
    /ERR_SOCKS_CONNECTION_FAILED/i.test(text)
    ||
    /ERR_CONNECTION_RESET/i.test(text)
    ||
    /ERR_EMPTY_RESPONSE/i.test(text)
    ||
    /ERR_CONNECTION_CLOSED/i.test(text)
    ||
    /ERR_CONNECTION_REFUSED/i.test(text)
    ||
    /ERR_TIMED_OUT/i.test(text)
    ||
    /Timeout \d+ms exceeded/i.test(text)
    ||
    /Navigation timeout/i.test(text)
    ||
    /Failed to fetch/i.test(text)
    ||
    /PROXY_PAGE_INVALID/i.test(text)
    ||
    /407\b/i.test(text)
    ||
    /402\b/i.test(text)
    ||
    /proxy.*authentication/i.test(text)
    ||
    /proxy.*connection/i.test(text)
  );
}

async function assertPageNot418(page, response = null) {
  if (response && response.status && response.status() === 418) {
    throw new Weibo418Error('微博首页返回 HTTP 418');
  }

  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText().catch(() => '');

  if (
    title.includes('418')
    || bodyText.includes('HTTP ERROR 418')
    || bodyText.includes('HTTP 418')
  ) {
    throw new Weibo418Error('微博页面检测到 HTTP 418');
  }
}

module.exports = {
  SCAN_PROXY_POOL,
  acquireScanProxyWaiting,
  Weibo418Error,
  isWeibo418Error,
  isProxyConnectionError,
  assertPageNot418
};

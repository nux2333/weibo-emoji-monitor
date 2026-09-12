'use strict';

/*
 * Fresh Scan HTTP 扫描切换层
 *
 * 适用：
 *   - fresh-latest
 *   - fresh-hot
 *   - fresh-superlike
 *   - fresh-yishanshui
 *   - fresh-qa
 *
 * History 暂不切换，继续沿用原来的页面内 fetch 逻辑。
 *
 * 页面仍负责：
 *   - 打开真实超话首页
 *   - 点击/初始化目标分区
 *   - 建立游客 Cookie / 会话
 *   - 后续 Profile 检查
 *
 * Fresh 后续分页统一改为：
 *   BrowserContext APIRequestContext -> HTTP GET
 *
 * BrowserContext.request 与浏览器 Context 共用 Cookie Storage，
 * 因此不再需要 page.evaluate(fetch)，同时仍沿用当前代理/会话。
 */

const chaohuaApi = require('./superlike/chaohua-api');

const workerMode = String(
  process.env.SUPERLIKE_SCAN_WORKER_MODE || ''
).trim().toLowerCase();

const workerSource = String(
  process.env.SUPERLIKE_SCAN_WORKER_SOURCE || ''
).trim();

const enabled =
  workerMode === 'fresh'
  && [
    'latest-posts',
    'section-hot',
    'section-superlike',
    'section-yishanshui',
    'section-qa'
  ].includes(workerSource);

if (enabled) {
  const originalFetchChaohuaInPage =
    chaohuaApi.fetchChaohuaInPage;

  function sanitizeHeaders(headers) {
    const input =
      headers && typeof headers === 'object'
        ? headers
        : {};

    const blocked = new Set([
      'cookie',
      'host',
      'content-length',
      'connection',
      'proxy-connection',
      'accept-encoding',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'sec-fetch-user'
    ]);

    const output = {};

    for (const [key, value] of Object.entries(input)) {
      const normalized = String(key).toLowerCase();

      if (
        blocked.has(normalized)
        || value === undefined
        || value === null
      ) {
        continue;
      }

      output[key] = String(value);
    }

    if (!output.Accept && !output.accept) {
      output.Accept = 'application/json, text/plain, */*';
    }

    if (!output.Referer && !output.referer) {
      output.Referer = 'https://weibo.com/';
    }

    return output;
  }

  async function fetchViaHttp(
    page,
    url,
    headers = {},
    {
      maxAttempts = 3,
      retryDelaysMs = [500, 1000],
      timeoutMs = 12000
    } = {}
  ) {
    const requestContext =
      page?.context?.()?.request;

    if (
      !requestContext
      || typeof requestContext.get !== 'function'
    ) {
      console.warn(
        '[SuperLike][HTTP Fresh] BrowserContext.request 不可用，临时回退 page.fetch。'
      );

      return originalFetchChaohuaInPage(
        page,
        url,
        headers
      );
    }

    const requestHeaders =
      sanitizeHeaders(headers);

    let lastResult = null;

    for (
      let attempt = 1;
      attempt <= maxAttempts;
      attempt++
    ) {
      const startedAt = Date.now();

      try {
        const response =
          await requestContext.get(
            url,
            {
              headers: requestHeaders,
              timeout: Math.max(
                1000,
                Number(timeoutMs || 12000)
              ),
              failOnStatusCode: false
            }
          );

        const text =
          await response.text();

        let json = null;

        try {
          json = JSON.parse(text);
        } catch {
          // 非 JSON 保留 text，由上层继续按旧逻辑处理。
        }

        lastResult = {
          httpStatus: response.status(),
          ok: response.ok(),
          finalUrl: response.url(),
          text,
          json,
          error: null,
          attempt,
          elapsedMs: Date.now() - startedAt,
          transport: 'http-api-request'
        };
      } catch (error) {
        lastResult = {
          httpStatus: null,
          ok: false,
          finalUrl: url,
          text: '',
          json: null,
          error: error?.message || String(error),
          attempt,
          elapsedMs: Date.now() - startedAt,
          transport: 'http-api-request'
        };
      }

      console.log(
        `[SuperLike][HTTP Fresh] source=${workerSource} | attempt=${attempt}/${maxAttempts} | HTTP=${lastResult.httpStatus ?? '-'} | ${lastResult.elapsedMs}ms | ${url}`
      );

      if (lastResult.ok) {
        return lastResult;
      }

      if (
        lastResult.httpStatus === 418
        || lastResult.httpStatus === 403
        || lastResult.httpStatus === 432
      ) {
        return lastResult;
      }

      if (attempt >= maxAttempts) {
        break;
      }

      const delayMs =
        Number(
          retryDelaysMs[
            Math.min(
              attempt - 1,
              retryDelaysMs.length - 1
            )
          ] || 0
        );

      if (delayMs > 0) {
        await new Promise(
          resolve => setTimeout(resolve, delayMs)
        );
      }
    }

    return lastResult || {
      httpStatus: null,
      ok: false,
      finalUrl: url,
      text: '',
      json: null,
      error: 'HTTP fresh request returned no result',
      attempt: 0,
      elapsedMs: 0,
      transport: 'http-api-request'
    };
  }

  chaohuaApi.fetchChaohuaInPage =
    async function fetchChaohuaInPageHttp(
      page,
      url,
      headers = {}
    ) {
      return fetchViaHttp(
        page,
        url,
        headers,
        {
          maxAttempts: 3,
          retryDelaysMs: [500, 1000],
          timeoutMs: 12000
        }
      );
    };

  console.log(
    `[SuperLike][HTTP Fresh] ${workerSource} 已启用 HTTP APIRequestContext；后续分页不再使用 page.evaluate(fetch)；单次超时=12秒。`
  );
}

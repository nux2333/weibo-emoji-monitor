'use strict';

/*
 * Scan HTTP-only 共通层。
 *
 * 适用：
 *   - fresh-latest
 *   - fresh-hot
 *   - fresh-superlike
 *   - fresh-yishanshui
 *   - fresh-qa
 *   - history
 *
 * 流程：
 * 1. Chromium 完成真实首页 / 最新 / 最新发帖等初始化。
 * 2. 第一次进入后续 API 分页前，额外预热 m.weibo.cn 游客会话。
 * 3. 合并 desktop + mobile Cookie，并复制当前代理到独立 APIRequestContext。
 * 4. 关闭 Chromium PersistentContext。
 * 5. 后续抓帖分页 + Profile 校验全部使用独立 HTTP session。
 */

const { request } = require('playwright');
const chaohuaApi = require('./superlike/chaohua-api');
const profileApi = require('./superlike/profile');
const proxyModule = require('./superlike/proxy');

const workerMode = String(
  process.env.SUPERLIKE_SCAN_WORKER_MODE || ''
).trim().toLowerCase();

const workerSource = String(
  process.env.SUPERLIKE_SCAN_WORKER_SOURCE || ''
).trim();

const freshSources = new Set([
  'latest-posts',
  'section-hot',
  'section-superlike',
  'section-yishanshui',
  'section-qa'
]);

const enabled =
  workerMode === 'history'
  || (
    workerMode === 'fresh'
    && freshSources.has(workerSource)
  );

if (enabled) {
  const workerLabel =
    workerMode === 'history'
      ? 'history'
      : (workerSource || 'fresh');

  const originalAcquire =
    proxyModule.SCAN_PROXY_POOL.acquire.bind(
      proxyModule.SCAN_PROXY_POOL
    );

  const originalFetchChaohuaInPage =
    chaohuaApi.fetchChaohuaInPage;

  const originalCheckProfile =
    profileApi.checkUserSuperLikeByProfile;

  let currentAssignment = null;
  let httpContext = null;
  let creatingSession = null;

  function sleep(ms) {
    return new Promise(
      resolve => setTimeout(resolve, ms)
    );
  }

  function logPrefix(extra = '') {
    const base =
      `[SuperLike][Scan HTTP-only] mode=${workerMode} source=${workerLabel}`;

    return extra
      ? `${base}${extra}`
      : base;
  }

  function sanitizeHeaders(headers) {
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

    for (const [key, value] of Object.entries(headers || {})) {
      if (
        blocked.has(String(key).toLowerCase())
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

  proxyModule.SCAN_PROXY_POOL.acquire =
    async function acquireTrackedScanProxy(...args) {
      const assignment =
        await originalAcquire(...args);

      if (
        assignment?.proxy
        && !assignment.allCoolingDown
      ) {
        currentAssignment = assignment;
      }

      return assignment;
    };

  async function warmMobileVisitorSession(browserContext) {
    let mobilePage = null;

    try {
      const beforeCookies =
        await browserContext.cookies();

      const beforeMobile =
        beforeCookies.filter(
          cookie =>
            String(cookie?.domain || '')
              .includes('weibo.cn')
        );

      console.log(
        `${logPrefix('[MobileSession]')} 初始化前 Cookie=${beforeCookies.length} | m.weibo.cn域=${beforeMobile.length}`
      );

      mobilePage =
        await browserContext.newPage();

      const response =
        await mobilePage.goto(
          'https://m.weibo.cn/',
          {
            waitUntil: 'domcontentloaded',
            timeout: 12000
          }
        )
        .catch(
          error => {
            console.warn(
              `${logPrefix('[MobileSession]')} m.weibo.cn 导航提示：${error?.message || error}`
            );
            return null;
          }
        );

      await sleep(1500);

      const afterCookies =
        await browserContext.cookies();

      const afterMobile =
        afterCookies.filter(
          cookie =>
            String(cookie?.domain || '')
              .includes('weibo.cn')
        );

      const mobileNames =
        [...new Set(
          afterMobile.map(
            cookie => String(cookie?.name || '')
          ).filter(Boolean)
        )]
          .slice(0, 20)
          .join(',');

      console.log(
        `${logPrefix('[MobileSession]')} 初始化完成 | HTTP=${response?.status?.() ?? '-'} | Cookie=${afterCookies.length} | m.weibo.cn域=${afterMobile.length} | names=${mobileNames || '-'}`
      );

      return afterCookies;

    } catch (error) {
      console.warn(
        `${logPrefix('[MobileSession]')} 初始化失败，继续沿用已有Cookie：${error?.message || error}`
      );

      return browserContext.cookies();

    } finally {
      if (
        mobilePage
        && !mobilePage.isClosed()
      ) {
        try {
          await mobilePage.close();
        } catch {
          // ignore
        }
      }
    }
  }

  async function ensureHttpOnlySession(page) {
    if (httpContext) {
      return httpContext;
    }

    if (creatingSession) {
      return creatingSession;
    }

    creatingSession = (async () => {
      const browserContext =
        page?.context?.();

      if (!browserContext) {
        throw new Error(
          `${workerLabel} HTTP-only 无法取得 BrowserContext`
        );
      }

      const cookies =
        await warmMobileVisitorSession(
          browserContext
        );

      const proxy =
        currentAssignment?.proxy
        || null;

      const desktopCookieCount =
        cookies.filter(
          cookie =>
            String(cookie?.domain || '')
              .includes('weibo.com')
        ).length;

      const mobileCookieCount =
        cookies.filter(
          cookie =>
            String(cookie?.domain || '')
              .includes('weibo.cn')
        ).length;

      console.log(
        `${logPrefix()} 准备脱离 Chromium | Cookie=${cookies.length} | desktop=${desktopCookieCount} | mobile=${mobileCookieCount} | Proxy=${currentAssignment?.masked || 'LOCAL'}`
      );

      const independent =
        await request.newContext({
          ...(proxy ? { proxy } : {}),
          storageState: {
            cookies,
            origins: []
          },
          extraHTTPHeaders: {
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://weibo.com/'
          },
          ignoreHTTPSErrors: true
        });

      /*
       * scanner 后续仍可能调用 page.waitForTimeout。
       * 在关闭 Chromium 前替换为纯 Node sleep。
       */
      try {
        page.waitForTimeout =
          async ms => sleep(Number(ms) || 0);
      } catch {
        // ignore
      }

      httpContext = independent;

      try {
        await browserContext.close();

        console.log(
          `${logPrefix()} Chromium 已关闭；后续抓帖分页 + Profile 全部走独立 HTTP session。`
        );
      } catch (error) {
        console.warn(
          `${logPrefix()} Chromium 关闭失败：${error?.message || error}`
        );
      }

      return independent;
    })();

    try {
      return await creatingSession;
    } finally {
      creatingSession = null;
    }
  }

  async function httpGet(
    ctx,
    url,
    headers = {},
    maxAttempts = 3
  ) {
    let lastResult = null;

    for (
      let attempt = 1;
      attempt <= maxAttempts;
      attempt++
    ) {
      const startedAt = Date.now();

      try {
        const response =
          await ctx.get(
            url,
            {
              headers: sanitizeHeaders(headers),
              timeout: 12000,
              failOnStatusCode: false
            }
          );

        const text =
          await response.text();

        let json = null;

        try {
          json = JSON.parse(text);
        } catch {
          // 非 JSON 保留 text，由上层处理。
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
          transport: 'scan-http-only'
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
          transport: 'scan-http-only'
        };
      }

      console.log(
        `${logPrefix()} attempt=${attempt}/${maxAttempts} | HTTP=${lastResult.httpStatus ?? '-'} | ${lastResult.elapsedMs}ms | ${url}`
      );

      if (lastResult.ok) {
        return lastResult;
      }

      if (
        lastResult.httpStatus === 403
        || lastResult.httpStatus === 418
        || lastResult.httpStatus === 432
      ) {
        return lastResult;
      }

      if (attempt < maxAttempts) {
        await sleep(
          attempt === 1
            ? 500
            : 1000
        );
      }
    }

    return lastResult;
  }

  chaohuaApi.fetchChaohuaInPage =
    async function fetchScanHttpOnly(
      page,
      url,
      headers = {}
    ) {
      const ctx =
        await ensureHttpOnlySession(page);

      return httpGet(
        ctx,
        url,
        headers,
        3
      );
    };

  profileApi.checkUserSuperLikeByProfile =
    async function checkScanProfileByHttp(
      context,
      config,
      uid,
      reusableProfileContext = null
    ) {
      if (!httpContext) {
        console.warn(
          `${logPrefix('[Profile]')} UID=${uid} HTTP session 尚未建立，临时回退原 Profile。`
        );

        return originalCheckProfile(
          context,
          config,
          uid,
          reusableProfileContext
        );
      }

      const url =
        profileApi.buildProfileInPageApiUrl(
          config,
          uid
        );

      const result =
        await httpGet(
          httpContext,
          url,
          {
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://m.weibo.cn/'
          },
          2
        );

      const status =
        result?.httpStatus;

      if (
        status === 403
        || status === 418
        || status === 432
      ) {
        return {
          ok: false,
          blocked: status === 418,
          visitorRedirect: status === 403,
          hasSuperLike: null,
          status,
          httpStatus: status,
          url: result?.finalUrl || url,
          message: `HTTP ${status}`
        };
      }

      const text =
        String(result?.text || '');

      if (
        !result?.ok
        || text.trimStart().startsWith('<')
      ) {
        return {
          ok: false,
          blocked: false,
          hasSuperLike: null,
          status: status ?? null,
          url: result?.finalUrl || url,
          message:
            result?.error
            || (
              text.trimStart().startsWith('<')
                ? '返回HTML，不是JSON'
                : `HTTP ${status ?? '-'}`
            )
        };
      }

      let json = result.json;

      if (!json) {
        try {
          json = JSON.parse(text);
        } catch (error) {
          return {
            ok: false,
            blocked: false,
            hasSuperLike: null,
            status: status ?? null,
            url: result?.finalUrl || url,
            message: `JSON解析失败：${error.message}`
          };
        }
      }

      if (Number(json?.ok ?? 0) !== 1) {
        const apiErrno = Number(json?.errno);

        return {
          ok: false,
          blocked: false,
          hasSuperLike: null,
          status:
            apiErrno === 403
              ? 403
              : status,
          httpStatus: status,
          apiErrno:
            Number.isFinite(apiErrno)
              ? apiErrno
              : null,
          url: result?.finalUrl || url,
          message:
            apiErrno === 403
              ? 'API errno=403 请求被拒绝'
              : `API ok=${json?.ok}`
        };
      }

      const hasSuperLike =
        profileApi.profileHasSuperLike(json);

      const profilePosts =
        profileApi.getProfilePosts(
          json,
          uid
        );

      console.log(
        `${logPrefix('[Profile]')} UID=${uid} | HTTP=${status} | SuperLike=${hasSuperLike} | Posts=${profilePosts.length}`
      );

      return {
        ok: true,
        blocked: false,
        hasSuperLike,
        profilePosts,
        status,
        url: result?.finalUrl || url
      };
    };

  process.once(
    'exit',
    () => {
      httpContext = null;
    }
  );

  console.log(
    `${logPrefix()} 已启用：Chromium初始化 + m.weibo.cn游客预热后关闭；后续抓帖分页 + Profile 全HTTP；单次超时=12秒。`
  );
}

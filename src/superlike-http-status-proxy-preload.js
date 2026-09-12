'use strict';

/*
 * SuperLike HTTP 状态码兜底层。
 *
 * superlike-scan-http-only-preload 已负责 4xx / 网络错误；
 * 这里专门兜底 5xx，避免 502/503/504 被上层当作普通请求失败后直接结束本轮。
 *
 * 必须在 superlike-scan-http-only-preload 之后加载。
 */

const chaohuaApi = require('./superlike/chaohua-api');
const profileApi = require('./superlike/profile');

function isHttp5xx(status) {
  const code = Number(status);
  return Number.isFinite(code)
    && code >= 500
    && code < 600;
}

function proxyFailureError(stage, status, url, detail = '') {
  const code = Number(status);
  const suffix = detail
    ? ` | ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}`
    : '';

  return new Error(
    `PROXY_PAGE_INVALID：${stage} | HTTP=${code} | ${url || '-'}${suffix}`
  );
}

const originalFetchChaohuaInPage =
  chaohuaApi.fetchChaohuaInPage;

chaohuaApi.fetchChaohuaInPage =
  async function fetchChaohuaWith5xxProxyFallback(
    page,
    url,
    headers = {}
  ) {
    const result =
      await originalFetchChaohuaInPage(
        page,
        url,
        headers
      );

    if (isHttp5xx(result?.httpStatus)) {
      console.warn(
        `[SuperLike][HTTP状态代理故障] stage=chaohua分页 | HTTP=${result.httpStatus} | ${url} | 交给外层切换代理`
      );

      throw proxyFailureError(
        'chaohua分页',
        result.httpStatus,
        url,
        result.error || result.text || ''
      );
    }

    return result;
  };

const originalCheckUserSuperLikeByProfile =
  profileApi.checkUserSuperLikeByProfile;

profileApi.checkUserSuperLikeByProfile =
  async function checkProfileWith5xxProxyFallback(
    ...args
  ) {
    const result =
      await originalCheckUserSuperLikeByProfile(
        ...args
      );

    const status =
      result?.httpStatus
      ?? result?.status;

    if (isHttp5xx(status)) {
      const uid = args?.[2] ?? '-';
      const url = result?.url || '-';

      console.warn(
        `[SuperLike][HTTP状态代理故障] stage=Profile UID=${uid} | HTTP=${status} | ${url} | 交给外层切换代理`
      );

      throw proxyFailureError(
        `Profile UID=${uid}`,
        status,
        url,
        result?.message || ''
      );
    }

    return result;
  };

console.log(
  '[SuperLike][HTTP状态代理故障] 已启用：HTTP 5xx 统一视为代理故障并交给外层切换代理。'
);

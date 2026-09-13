'use strict';

/**
 * 共通：判断 HTTP 状态码是否应该切换代理。
 *
 * 统一规则：
 * - 400-499：全部切代理
 * - 500-599：切代理
 * - 其他状态码：不因 HTTP code 单独切代理
 *
 * 这里仅负责判定；调用方负责冷却/淘汰当前代理、重建 session 并重试。
 */
function shouldRotateProxyForHttpStatus(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return false;
  return (code >= 400 && code < 600);
}

/**
 * 共通：判断网络、代理、Playwright session/context 失效是否应该切换代理并重建会话。
 *
 * 特别包含：
 * - Target page/context/browser has been closed
 * - apiRequestContext 已关闭
 * - PLAYWRIGHT_HARD_TIMEOUT / browserContext.close 超时
 * 这些错误如果只等下一轮，会继续复用已经死亡的 request context，形成永久失败循环。
 */
function shouldRotateProxyForNetworkError(errorOrMessage) {
  const text = String(
    errorOrMessage?.message
    || errorOrMessage
    || ''
  );

  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_CERT_AUTHORITY_INVALID|ERR_CERT_COMMON_NAME_INVALID|ERR_CERT_DATE_INVALID|Failed to fetch|NetworkError|fetch failed|socket hang up|Timeout|AbortError|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONN|proxy|Target page, context or browser has been closed|Target page.*closed|context.*closed|browser.*closed|apiRequestContext.*closed|request context.*closed|PLAYWRIGHT_HARD_TIMEOUT|PlaywrightHardTimeoutError|browserContext\.close|browser\.close/i.test(text);
}

function shouldRotateProxy({ status = null, error = null, message = '' } = {}) {
  if (shouldRotateProxyForHttpStatus(status)) return true;
  return shouldRotateProxyForNetworkError(error || message);
}

module.exports = {
  shouldRotateProxy,
  shouldRotateProxyForHttpStatus,
  shouldRotateProxyForNetworkError
};

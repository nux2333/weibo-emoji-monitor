'use strict';

/**
 * 共通：判断 HTTP 状态码是否应该切换代理。
 *
 * 当前统一规则：
 * - 400：不切代理（通常更像请求参数/业务请求问题）
 * - 401-499（除 400）：切代理
 * - 500-599：切代理
 * - 其他状态码：不切代理
 *
 * 注意：这里只负责“要不要切代理”的判断。
 * 各脚本自行决定切换后是重试当前请求、重建 session，还是等待人工重发。
 */
function shouldRotateProxyForHttpStatus(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return false;
  if (code === 400) return false;
  return (code >= 401 && code < 500) || (code >= 500 && code < 600);
}

/**
 * 共通：判断网络/代理异常是否应该切换代理。
 */
function shouldRotateProxyForNetworkError(errorOrMessage) {
  const text = String(
    errorOrMessage?.message
    || errorOrMessage
    || ''
  );

  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_CERT_AUTHORITY_INVALID|ERR_CERT_COMMON_NAME_INVALID|ERR_CERT_DATE_INVALID|Failed to fetch|NetworkError|fetch failed|socket hang up|Timeout|AbortError|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONN|proxy/i.test(text);
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

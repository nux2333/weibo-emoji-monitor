'use strict';

/**
 * 创建一个可复用的微博评论自动化服务。
 *
 * 负责统一处理以下链路：
 * 1. 使用已有 HTTP 会话访问帖子页面（warm up）
 * 2. 识别是否被重定向到登录页
 * 3. 如果 CSRF 缺失，自动刷新帖子并重新抓取 Cookie
 * 4. 发送评论 POST 请求
 * 5. 处理代理错误 / 登录失效 / 重试切换
 *
 * @param {Object} options 配置项
 * @param {Object} [options.logger=console] 日志对象，需至少提供 log / warn 方法
 * @param {number} [options.httpTimeoutMs=15000] 单次 HTTP 请求超时时间
 * @param {number} [options.proxyRetries=3] 代理切换/重试最大次数
 * @param {string} [options.commentFp=''] 评论接口附带的 fp 参数
 * @param {Function|null} [options.rotateSessionFn=null] 代理切换回调，用于切换 Playwright / HTTP 上下文
 * @param {Function|null} [options.isHttpProxyFailureFn=null] 判断是否属于代理层 HTTP 错误的回调
 * @param {Function|null} [options.isLoginUrlFn=null] 判断 URL 是否为微博登录页的回调
 * @param {Function|null} [options.shortErrorFn=null] 把 Error 处理成短摘要字符串的回调
 * @param {string} [options.defaultComment=''] 默认评论文案
 * @returns {{
 *   setRuntime: Function,
 *   setApi: Function,
 *   setBrowserSession: Function,
 *   getApi: Function,
 *   getBrowserSession: Function,
 *   warmPost: Function,
 *   findCsrfToken: Function,
 *   sendCommentHttp: Function,
 *   refreshCsrfBeforePrompt: Function,
 *   submitComment: Function,
 *   isHttpProxyFailure: Function,
 *   isLoginUrl: Function,
 *   shortError: Function
 * }} 返回一个封装好的Service实例
 */
function createCommentAutoService({
  logger = console,
  httpTimeoutMs = 15000,
  proxyRetries = 3,
  commentFp = '',
  rotateSessionFn = null,
  isHttpProxyFailureFn = null,
  isLoginUrlFn = null,
  shortErrorFn = null,
  defaultComment = ''
} = {}) {
  let api = null;
  let browserSession = null;

  /**
   * 判断当前 HTTP 状态码是否属于典型代理/接口异常。
   *
   * 例如 4xx / 5xx 通常意味着代理失效、被拦截、登录状态异常或接口问题。
   * 若业务需要特别处理 400，允许在外层覆盖这个判断逻辑。
   *
   * @param {number|string|null} status HTTP 状态码
   * @returns {boolean} 是否属于代理错误或请求异常
   */
  const isHttpProxyFailure = isHttpProxyFailureFn || ((status) => {
    const code = Number(status);
    if (code === 400) return false;
    return (code >= 400 && code < 500) || (code >= 500 && code < 600);
  });

  /**
   * 判定给定 URL 是否为微博登录页或登录重定向页。
   *
   * 这一步很关键：如果 warmPost 后被重定向到登录入口，说明当前会话已失效，
   * 必须进行重新登录/重建 HTTP Session，而不是继续提交评论。
   *
   * @param {string} url 目标 URL
   * @returns {boolean} 是否是登录页
   */
  const isLoginUrl = isLoginUrlFn || ((url) => /newlogin|passport\.weibo|\/login/i.test(String(url || '')));

  /**
   * 将 Error 对象压缩为简短描述，便于日志输出和控制台定位问题。
   *
   * 采用优先级：message -> 提取关键错误码 -> 兜底字符串。
   *
   * @param {Error|string|unknown} error 原始错误对象
   * @returns {string} 压缩后的错误摘要
   */
  const shortError = shortErrorFn || ((error) => {
    const text = String(error?.message || error || 'unknown error');
    const first = text.split(/\r?\n/)[0];
    const match = first.match(/(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_[A-Z_]+|socket hang up|Timeout[^:]*)/i);
    return match ? match[1] : first.replace(/^apiRequestContext\.(?:get|post):\s*/i, '').slice(0, 180);
  });

  /**
   * 设置当前运行时依赖：HTTP API 对象和浏览器会话快照。
   * 这两个对象是后续 warm / csrf /评论三者共用的上下文。
   *
   * @param {Object|null} nextApi Playwright request context 或等价的 HTTP client
   * @param {Object|null} nextBrowserSession 浏览器会话信息，用于重建/切换代理时复用 Cookie / UA
   */
  function setRuntime(nextApi, nextBrowserSession) {
    api = nextApi;
    browserSession = nextBrowserSession;
  }

  /**
   * 获取当前 HTTP API 实例。
   *
   * @returns {Object|null} 当前可用的 API 客户端
   */
  function getApi() {
    return api;
  }

  /**
   * 获取当前浏览器会话状态。
   *
   * @returns {Object|null} 浏览器会话 / Cookie / UA 载体
   */
  function getBrowserSession() {
    return browserSession;
  }

  /**
   * 触发一次代理切换/会话切换。
   *
   * 这是一个封装层：不会直接知道具体切换逻辑，只会调用外部注入的 rotateSessionFn。
   * 成功后会同步更新当前 api 引用，保证后续请求继续使用新的会话。
   *
   * @returns {Promise<Object|null>} 新 API 对象，失败返回 null
   */
  async function rotateApi() {
    if (!rotateSessionFn || !api || !browserSession) return null;
    const nextApi = await rotateSessionFn(api, browserSession);
    if (nextApi) {
      api = nextApi;
      return nextApi;
    }
    return null;
  }

  /**
   * 拉取当前 HTTP Client 的 Cookie 状态。
   *
   * 这里专门用来读取 XSRF / CSRF 相关 cookie，这些 cookie 用于后续评论接口签名。
   *
   * @returns {Promise<Array>} 当前 cookie 列表
   */
  async function getHttpCookies() {
    if (!api) return [];
    const state = await api.storageState();
    return Array.isArray(state.cookies) ? state.cookies : [];
  }

  /**
   * 在 Cookie 列表中找出 CSRF 相关 token。
   *
   * 微博评论 API 通常要求带上 X-XSRF-TOKEN / X-CSRF-TOKEN，
   * 这些值常见于 cookie 名称 XSRF-TOKEN / _csrf 等中。
   *
   * @param {Array<Object>} cookies cookie 列表
   * @returns {{token: string, source: string}|null} 找到的 CSRF 信息，未找到则返回 null
   */
  function findCsrfToken(cookies) {
    const list = Array.isArray(cookies) ? cookies : [];
    for (const name of ['XSRF-TOKEN', 'XSRF_TOKEN', 'csrf', 'csrf_token', 'CSRF-TOKEN', '_csrf']) {
      const found = list.find(c => c.name === name && c.value);
      if (found) return { token: decodeURIComponent(found.value), source: `cookie:${name}` };
    }
    return null;
  }

  /**
   * 访问帖子页面并执行 warm up。
   *
   * 它不仅仅是为了拿页面，还能判断当前请求是否成功、是否被重定向到登录页、
   * 是否因为代理失效导致 4xx/5xx。 warmPost 是整个自动评论链路的前置探测。
   *
   * @param {string} postLink 帖子 URL
   * @returns {Promise<{status: number, url: string, ok: boolean}>} 请求结果摘要
   * @throws {Error} 若未初始化 HTTP 会话或未传入链接，则抛错
   */
  async function warmPost(postLink) {
    if (!api || !postLink) {
      throw new Error('HTTP 会话未初始化或缺少帖子链接');
    }
    const response = await api.get(postLink, {
      timeout: httpTimeoutMs,
      failOnStatusCode: false,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        Referer: 'https://weibo.com/'
      }
    });
    return { status: response.status(), url: response.url(), ok: response.ok() };
  }

  /**
   * 直接向微博评论接口发起 POST 请求。
   *
   * 前提条件是已经能从 Cookie 里拿到 CSRF token，否则无法正确完成评论。
   * 如果没有 CSRF，返回一个结构化的失败对象，而不是直接抛异常，供上层判断是否需要重新登录。
   *
   * @param {string|number} postId 帖子 ID
   * @param {string} postLink 帖子地址
   * @param {string} commentText 评论内容
   * @returns {Promise<Object>} 评论接口返回的 JSON / status / 原始 text 等信息
   */
  async function sendCommentHttp(postId, postLink, commentText) {
    if (!api) {
      throw new Error('HTTP 会话未初始化');
    }
    const csrf = findCsrfToken(await getHttpCookies());
    if (!csrf) {
      return { ok: false, status: null, json: null, text: 'CSRF token unavailable before comment POST', csrfSource: null, csrfMissing: true };
    }

    const form = { id: String(postId), comment: commentText, pic_id: '', is_repost: '0', comment_ori: '0', is_comment: '0' };
    if (commentFp) form.fp = commentFp;

    const response = await api.post('https://weibo.com/ajax/comments/create', {
      timeout: httpTimeoutMs,
      failOnStatusCode: false,
      form,
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: postLink,
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': csrf.token,
        'X-CSRF-TOKEN': csrf.token
      }
    });

    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { ok: response.ok(), status: response.status(), json, text, csrfSource: csrf.source, finalUrl: response.url() };
  }

  /**
   * 在发表评论之前确保 CSRF token 可用。
   *
   * 典型流程：
   * - 先检查当前 api 的 Cookie 中有无 CSRF
   * - 若没有，访问帖子页面以刷新 Cookie / session
   * - 若访问目标帖子返回登录页，说明当前会话失效
   * - 若返回 HTTP 错误码，则尝试切换代理并重试
   * - 若最终仍然无法拿到 CSRF，返回 loginExpired=true，以便上层触发重新登录
   *
   * @param {string} postLink 帖子链接
   * @returns {Promise<{api: Object, csrf: Object|null, loginExpired: boolean, error: Error|null}>}
   */
  async function refreshCsrfBeforePrompt(postLink) {
    let currentApi = api;
    let lastWarm = null;
    let lastError = null;

    let csrf = findCsrfToken(await getHttpCookies());
    if (csrf) return { api: currentApi, csrf, loginExpired: false, error: null };

    logger.log?.('[CSRF] HTTP Cookie中未找到 token，刷新帖子Cookie。');
    for (let attempt = 1; attempt <= proxyRetries; attempt += 1) {
      try {
        lastWarm = await warmPost(postLink);
        if (isLoginUrl(lastWarm.url)) {
          return { api: currentApi, csrf: null, loginExpired: true, error: null };
        }
        if (isHttpProxyFailure(lastWarm.status)) {
          logger.warn?.(`[CSRF] 刷新帖子 HTTP ${lastWarm.status}，自动切换代理`);
          if (attempt >= proxyRetries) break;
          const nextApi = await rotateApi();
          if (!nextApi) {
            lastError = new Error(`HTTP ${lastWarm.status}，没有可切换代理`);
            break;
          }
          currentApi = nextApi;
          continue;
        }

        csrf = findCsrfToken(await getHttpCookies());
        if (csrf) {
          if (attempt > 1) logger.log?.(`[CSRF] 刷新成功 | HTTP=${lastWarm.status}`);
          api = currentApi;
          return { api: currentApi, csrf, loginExpired: false, error: null };
        }
        lastError = new Error('刷新帖子后仍未取得 CSRF token');
      } catch (error) {
        lastError = error;
        logger.warn?.(`[CSRF] 刷新帖子失败：${shortError(error)}`);
        if (attempt >= proxyRetries) break;
        const nextApi = await rotateApi();
        if (!nextApi) break;
        currentApi = nextApi;
      }
    }

    api = currentApi;
    return { api: currentApi, csrf: null, loginExpired: true, error: lastError || new Error(`HTTP ${lastWarm?.status ?? '-'}`) };
  }

  /**
   * 统一提交评论的自动化入口。
   *
   * 它串联了整个链路，返回一个结构化状态，供上层决定：
   * - 继续评论
   * - 登录失效，需要重建会话
   * - 代理异常，切换执行上下文后重试
   * - 最终失败，跳过当前帖子
   *
   * @param {Object} params 输入参数
   * @param {string|number} params.postId 帖子 ID
   * @param {string} params.postLink 帖子链接
   * @param {string} [params.commentText=defaultComment] 要发送的评论文案
   * @returns {Promise<Object>} 返回统一状态对象，包含 type 和 result 信息
   */
  async function submitComment({ postId, postLink, commentText = defaultComment }) {
    if (!api) {
      throw new Error('HTTP 会话未初始化');
    }

    // 第一步：访问帖子页面，确认会话是否正常、代理是否有效。
    const warmResult = await warmPost(postLink);
    if (isHttpProxyFailure(warmResult.status)) {
      const nextApi = await rotateApi();
      if (nextApi) {
        return { type: 'retry', api: nextApi, warmResult, commentResult: null };
      }
      return { type: 'error', api, warmResult, commentResult: null, error: new Error(`HTTP ${warmResult.status}`) };
    }
    if (isLoginUrl(warmResult.url)) {
      return { type: 'login-expired', api, warmResult, commentResult: null };
    }

    // 第二步：评论前刷新 CSRF，并在失败时判定是否需要重建登录态。
    const csrfState = await refreshCsrfBeforePrompt(postLink);
    if (!csrfState.csrf) {
      return { type: 'login-expired', api: csrfState.api, warmResult, commentResult: null, error: csrfState.error };
    }

    // 第三步：执行正式提交评论。
    const commentResult = await sendCommentHttp(postId, postLink, commentText);
    return { type: 'comment', api: api || csrfState.api, warmResult, commentResult };
  }

  return {
    /**
     * 设置当前运行时依赖。
     * @param {Object|null} nextApi
     * @param {Object|null} nextBrowserSession
     */
    setRuntime,

    /**
     * 仅更新 api 实例，不改动 browserSession。
     * @param {Object|null} nextApi
     */
    setApi(nextApi) { api = nextApi; },

    /**
     * 仅更新 browserSession。
     * @param {Object|null} nextBrowserSession
     */
    setBrowserSession(nextBrowserSession) { browserSession = nextBrowserSession; },

    /**
     * 获取当前 HTTP API 实例。
     * @returns {Object|null}
     */
    getApi,

    /**
     * 获取当前 browserSession。
     * @returns {Object|null}
     */
    getBrowserSession,

    /**
     * 访问帖子并探测是否可用。
     */
    warmPost,

    /**
     * 从 Cookie 中抽取 CSRF token。
     */
    findCsrfToken,

    /**
     * 执行微博评论 POST。
     */
    sendCommentHttp,

    /**
     * 刷新 / 恢复 CSRF token。
     */
    refreshCsrfBeforePrompt,

    /**
     * 执行完整评论链路，并返回统一状态。
     */
    submitComment,

    /**
     * 判断是否为代理/HTTP 错误。
     */
    isHttpProxyFailure,

    /**
     * 判断是否为重定向到登录页。
     */
    isLoginUrl,

    /**
     * 压缩错误为短摘要。
     */
    shortError
  };
}

module.exports = { createCommentAutoService };

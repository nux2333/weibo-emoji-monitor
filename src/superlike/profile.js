const {
  getUid,
  getPostId,
  getCommentsCount,
  parsePostCreatedAtMs,
  getPostCreatedAt
} = require('./post-utils');
const { isProxyConnectionError } = require('./proxy');

const SCAN_PROFILE_HARD_TIMEOUT_MS = 15000;

function buildProfileInPageApiUrl(
  config,
  uid
) {
  const url =
    new URL(
      'https://m.weibo.cn/api/container/getIndex'
    );

  url.searchParams.set(
    'containerid',
    config.profileContainerId
  );

  /*
   * 先人为保留一次 %23，
   * URLSearchParams 再编码一次，
   * 最终得到 target_uid%2523{uid}
   */
  url.searchParams.set(
    'extparam',
    `target_uid%23${uid}`
  );

  url.searchParams.set(
    'luicode',
    '10000011'
  );

  url.searchParams.set(
    'lfid',
    config.chaoLikeListContainerId
  );

  url.searchParams.set(
    'launchid',
    '10000360-page_H5'
  );

  return url.toString();
}

function profileHasSuperLike(
  profileData
) {
  let profileText;

  try {
    profileText =
      typeof profileData === 'string'
        ? profileData
        : JSON.stringify(profileData);
  } catch (error) {
    console.log(
      `[SuperLike][ProfileText转换失败] ${error.message}`
    );
    return false;
  }


  return (
    profileText.includes('fans_title_superlike.png') ||
    profileText.includes('fans_title_superlike_on.png') ||
    profileText.includes('superlike') 
  );
}

function getProfilePosts(
  profileData,
  uid
) {
  const cards =
    Array.isArray(
      profileData?.data?.cards
    )
      ? profileData.data.cards
      : [];

  const posts = [];

  for (
    const card
    of cards
  ) {
    const groups =
      Array.isArray(
        card?.card_group
      )
        ? card.card_group
        : [];

    for (
      const item
      of groups
    ) {
      const post =
        item?.mblog;

      if (
        !post
        ||
        typeof post !== 'object'
      ) {
        continue;
      }

      const postUid =
        getUid(
          post
        );

      if (
        String(postUid || '')
        !==
        String(uid || '')
      ) {
        continue;
      }

      posts.push(
        post
      );
    }
  }

  return posts;
}

function pickProfileReplacementPost(profilePosts) {
  const oneMonthAgo =
    Date.now()
    - 30 * 24 * 60 * 60 * 1000;

  return profilePosts.find(
    post => {
      const comments =
        getCommentsCount(
          post
        );

      const createdAtMs =
        parsePostCreatedAtMs(
          post
        );

      return (
        comments !== null
        &&
        comments >= 1
        &&
        comments <= 4
        &&
        Number.isFinite(
          Number(createdAtMs)
        )
        &&
        Number(createdAtMs) >=
          oneMonthAgo
        &&
        Number(createdAtMs) <=
          Date.now()
      );
    }
  )
  || null;
}

async function checkUserSuperLikeByProfileInner(
  context,
  config,
  uid,
  reusableProfileContext = null
) {
  const apiUrl =
    buildProfileInPageApiUrl(
      config,
      uid
    );

  const pageUrl =
    new URL(
      'https://m.weibo.cn/p/index'
    );

  pageUrl.searchParams.set(
    'containerid',
    config.profileContainerId
  );

  pageUrl.searchParams.set(
    'extparam',
    `target_uid%23${uid}`
  );

  pageUrl.searchParams.set(
    'luicode',
    '10000011'
  );

  pageUrl.searchParams.set(
    'lfid',
    config.chaoLikeListContainerId
  );

  pageUrl.searchParams.set(
    'launchid',
    '10000360-page_H5'
  );

  console.log(
    `[SuperLike][ProfileURL] ${apiUrl}`
  );

  console.log(
    `[SuperLike][Profile页面] ${pageUrl.toString()}`
  );

  let profileContext =
    reusableProfileContext
    || null;

  const ownsProfileContext =
    !reusableProfileContext;

  let profilePage = null;

  try {
    /*
     * 真正模拟浏览器无痕访问：
     * - 新建匿名 BrowserContext，不继承登录 Cookie/localStorage
     * - 打开真实 /p/index 用户超话主页，而不是直接导航 API
     * - 监听页面自己发出的 profile_inpage XHR
     * - 一旦拿到目标 Response，就直接使用
     * - 拿到 Profile 后，阻止页面继续跳 passport / 登录页
     */
    if (!profileContext) {
      const parentBrowser =
        context.browser();

      if (
        !parentBrowser
        ||
        typeof parentBrowser.newContext
          !== 'function'
      ) {
        throw new Error(
          '无法创建游客 BrowserContext'
        );
      }

      profileContext =
        await parentBrowser.newContext({
          viewport: {
            width: 1280,
            height: 900
          }
        });
    }

    profilePage =
      await profileContext.newPage();

    let profileCaptured =
      false;

    await profilePage.route(
      '**/*',
      async route => {
        const request =
          route.request();

        const requestUrl =
          request.url();

        let host =
          '';

        try {
          host =
            new URL(
              requestUrl
            ).hostname
              .toLowerCase();
        } catch {
          host = '';
        }

        const isPassport =
          host ===
            'visitor.passport.weibo.cn'
          ||
          host ===
            'passport.weibo.cn'
          ||
          host ===
            'passport.weibo.com';

        /*
         * 只有在 Profile 数据已经拿到后，
         * 才拦截后续登录跳转。
         *
         * 在此之前不破坏微博正常的游客初始化流程。
         */
        if (
          isPassport
          &&
          profileCaptured
        ) {
          console.log(
            `[SuperLike][Profile游客模式] UID=${uid} Profile已取得，阻止后续登录跳转：${requestUrl}`
          );

          await route.abort();
          return;
        }

        await route.continue();
      }
    );

    console.log(
      `[SuperLike][Profile游客模式] UID=${uid} 使用匿名浏览器打开真实用户主页，等待页面自己的Profile XHR`
    );

    const maxAttempts = 2;
    const retryDelayMs = 500;
    const responseTimeoutMs = 7000;

    let result = null;

    for (
      let attempt = 1;
      attempt <= maxAttempts;
      attempt++
    ) {
      const startedAt =
        Date.now();

      let navigationError =
        null;

      try {
        const targetResponsePromise =
          profilePage.waitForResponse(
            response => {
              try {
                const responseUrl =
                  new URL(
                    response.url()
                  );

                if (
                  responseUrl.hostname !==
                    'm.weibo.cn'
                  ||
                  responseUrl.pathname !==
                    '/api/container/getIndex'
                ) {
                  return false;
                }

                const containerId =
                  responseUrl.searchParams.get(
                    'containerid'
                  );

                const extparam =
                  responseUrl.searchParams.get(
                    'extparam'
                  )
                  || '';

                return (
                  containerId ===
                    config.profileContainerId
                  &&
                  extparam.includes(
                    String(uid)
                  )
                );
              } catch {
                return false;
              }
            },
            {
              timeout:
                responseTimeoutMs
            }
          );

        /*
         * 每次都打开真实 H5 Profile 页面。
         * cache bust 避免第二次重试只命中浏览器缓存。
         */
        const attemptPageUrl =
          new URL(
            pageUrl.toString()
          );

        attemptPageUrl.searchParams.set(
          '_profile_retry',
          String(
            Date.now()
          )
        );

        const navigationPromise =
          profilePage.goto(
            attemptPageUrl.toString(),
            {
              waitUntil:
                'domcontentloaded',
              timeout:
                responseTimeoutMs
            }
          )
          .catch(
            error => {
              navigationError =
                error;

              console.log(
                `[SuperLike][Profile页面导航提示] UID=${uid} ${error.message}`
              );

              return null;
            }
          );

        const response =
          await targetResponsePromise;

        profileCaptured =
          true;

        /*
         * XHR 已经到手后，不要求页面最终停在哪儿。
         * 后续登录跳转会被 route 拦截。
         */
        await Promise.race([
          navigationPromise,
          profilePage.waitForTimeout(
            100
          )
        ]);

        const status =
          response.status();

        if (
          status >= 300
          &&
          status < 400
        ) {
          const location =
            response.headers()['location']
            || '';

          console.log(
            `[SuperLike][ProfileXHR重定向] UID=${uid} status=${status} location=${location || '-'}`
          );

          return {
            ok: false,
            blocked: false,
            visitorRedirect: true,
            hasSuperLike: null,
            status: 403,
            httpStatus: status,
            url:
              response.url(),
            message:
              `Profile XHR redirect ${status}${location ? ' -> ' + location : ''}`
          };
        }

        const text =
          await response.text();

        result = {
          ok:
            status >= 200
            &&
            status < 300,
          status,
          text,
          attempt,
          elapsedMs:
            Date.now()
            - startedAt,
          finalUrl:
            response.url(),
          error:
            null
        };

        console.log(
          `[SuperLike][ProfileResponse] UID=${uid} status=${status} attempt=${attempt}/${maxAttempts} elapsed=${result.elapsedMs}ms url=${result.finalUrl}`
        );

        if (
          status === 418
          ||
          status === 403
        ) {
          break;
        }

        const returnedHtml =
          text
            .trimStart()
            .startsWith('<');

        if (
          result.ok
          &&
          !returnedHtml
        ) {
          break;
        }

        if (
          attempt < maxAttempts
        ) {
          console.log(
            `[SuperLike][Profile请求重试] ${attempt}/${maxAttempts} 失败 | status=${status} | ${returnedHtml ? '返回HTML' : 'HTTP异常'} | ${retryDelayMs}ms后重试`
          );

          profileCaptured =
            false;

          await profilePage.waitForTimeout(
            retryDelayMs
          );
        }

      } catch (error) {
        const effectiveError =
          navigationError
          &&
          isProxyConnectionError(
            navigationError
          )
            ? navigationError
            : error;

        if (
          isProxyConnectionError(
            effectiveError
          )
        ) {
          console.log(
            `[SuperLike][Profile代理失败] UID=${uid} | ${effectiveError?.message || effectiveError} | 当前代理立即淘汰并切换`
          );

          throw effectiveError;
        }

        result = {
          ok: false,
          status: null,
          text: '',
          attempt,
          elapsedMs:
            Date.now()
            - startedAt,
          finalUrl:
            apiUrl,
          error:
            error.message
        };

        if (
          attempt < maxAttempts
        ) {
          console.log(
            `[SuperLike][Profile请求重试] ${attempt}/${maxAttempts} 失败 | status=- | error=${error.message} | ${retryDelayMs}ms后重试`
          );

          profileCaptured =
            false;

          await profilePage.waitForTimeout(
            retryDelayMs
          );

          continue;
        }
      }
    }

    if (
      !result
    ) {
      return {
        ok: false,
        hasSuperLike: null,
        status: null,
        url:
          apiUrl,
        message:
          'Profile 请求没有结果'
      };
    }

    if (
      result.error
    ) {
      if (
        isProxyConnectionError(
          result.error
        )
      ) {
        throw new Error(
          result.error
        );
      }

      return {
        ok: false,
        hasSuperLike: null,
        status:
          result.status,
        url:
          result.finalUrl,
        message:
          result.error
      };
    }

    if (
      !result.ok
    ) {
      return {
        ok: false,
        blocked:
          result.status === 418,
        hasSuperLike: null,
        status:
          result.status,
        url:
          result.finalUrl,
        message:
          `HTTP ${result.status}`
      };
    }

    console.log(
      `[SuperLike][Profile前100] ${result.text.slice(
        0,
        100
      )}`
    );

    if (
      result.text
        .trimStart()
        .startsWith('<')
    ) {
      return {
        ok: false,
        hasSuperLike: null,
        status:
          result.status,
        url:
          result.finalUrl,
        message:
          '返回HTML，不是JSON'
      };
    }

    let json;

    try {
      json =
        JSON.parse(
          result.text
        );

    } catch (error) {
      return {
        ok: false,
        hasSuperLike: null,
        status:
          result.status,
        url:
          result.finalUrl,
        message:
          `JSON解析失败：${error.message}`
      };
    }

    if (
      Number(
        json?.ok
        ?? 0
      )
      !== 1
    ) {
      const apiErrno =
        Number(
          json?.errno
        );

      return {
        ok: false,
        blocked: false,
        hasSuperLike: null,
        status:
          apiErrno === 403
            ? 403
            : result.status,
        httpStatus:
          result.status,
        apiErrno:
          Number.isFinite(
            apiErrno
          )
            ? apiErrno
            : null,
        url:
          result.finalUrl,
        message:
          apiErrno === 403
            ? 'API errno=403 请求被拒绝'
            : `API ok=${json?.ok}`
      };
    }

    const hasSuperLike =
      profileHasSuperLike(
        json
      );

    console.log(
      `[SuperLike][Profile结果] UID=${uid} SuperLike=${hasSuperLike}`
    );

    const profilePosts =
      getProfilePosts(
        json,
        uid
      );

    console.log(
      `[SuperLike][Profile帖子] UID=${uid} 提取到=${profilePosts.length}条`
    );

    if (
      profilePosts.length > 0
    ) {
      const preview =
        profilePosts
          .slice(
            0,
            5
          )
          .map(
            (post, index) =>
              `#${index + 1} Post=${getPostId(post) || '-'} 评论=${getCommentsCount(post) ?? '-'} 时间=${getPostCreatedAt(post) || '-'}`
          );

      for (
        const line
        of preview
      ) {
        console.log(
          `[SuperLike][Profile帖子] ${line}`
        );
      }
    }

    return {
      ok: true,
      blocked: false,
      hasSuperLike,
      profilePosts,
      status:
        result.status,
      url:
        result.finalUrl
    };

  } catch (error) {
    if (
      isProxyConnectionError(
        error
      )
    ) {
      throw error;
    }

    return {
      ok: false,
      blocked: false,
      hasSuperLike: null,
      status: null,
      url:
        apiUrl,
      message:
        error.message
    };

  } finally {
    if (
      profilePage
      &&
      !profilePage.isClosed()
    ) {
      try {
        await profilePage.close();
      } catch {
        // ignore
      }
    }

    if (
      profileContext
      &&
      ownsProfileContext
    ) {
      try {
        await profileContext.close();
      } catch {
        // ignore
      }
    }
  }
}

async function checkUserSuperLikeByProfile(
  context,
  config,
  uid,
  reusableProfileContext = null
) {
  let timer = null;

  const hardTimeout =
    new Promise(resolve => {
      timer =
        setTimeout(
          () => {
            console.log(
              `[SuperLike][Profile硬超时] UID=${uid} 超过${SCAN_PROFILE_HARD_TIMEOUT_MS / 1000}秒，立即fail-open，继续Scan。`
            );

            resolve({
              ok: false,
              hasSuperLike: null,
              status: null,
              url:
                buildProfileInPageApiUrl(
                  config,
                  uid
                ),
              message:
                `Profile hard timeout ${SCAN_PROFILE_HARD_TIMEOUT_MS}ms`
            });
          },
          SCAN_PROFILE_HARD_TIMEOUT_MS
        );
    });

  try {
    return await Promise.race([
      checkUserSuperLikeByProfileInner(
        context,
        config,
        uid,
        reusableProfileContext
      ),
      hardTimeout
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  buildProfileInPageApiUrl,
  profileHasSuperLike,
  getProfilePosts,
  pickProfileReplacementPost,
  checkUserSuperLikeByProfileInner,
  checkUserSuperLikeByProfile
};

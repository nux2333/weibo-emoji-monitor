const FEED_WAIT_MS =
  Number(process.env.SUPERLIKE_FEED_WAIT_MS)
  || 10000;

function parseChaohuaRequestUrl(
  requestUrl
) {
  try {
    const url =
      new URL(requestUrl);

    if (
      url.hostname !== 'weibo.com'
      ||
      url.pathname !==
        '/ajax_proxy/chaohua/page'
    ) {
      return null;
    }

    return {
      flowId:
        url.searchParams.get(
          'flowId'
        ),

      page:
        Number(
          url.searchParams.get(
            'page'
          )
          || 1
        ),

      url:
        requestUrl
    };

  } catch {
    return null;
  }
}

function waitForChaohuaResponse(
  page,
  targetFlowId,
  timeoutMs = FEED_WAIT_MS
) {
  return new Promise(resolve => {
    let done = false;

    const timer =
      setTimeout(
        () => {
          if (done) {
            return;
          }

          done = true;

          page.off(
            'response',
            onResponse
          );

          resolve(null);
        },

        timeoutMs
      );


    async function onResponse(
      response
    ) {
      if (done) {
        return;
      }

      const info =
        parseChaohuaRequestUrl(
          response.url()
        );

      if (
        !info
        ||
        info.flowId !==
          targetFlowId
      ) {
        return;
      }

      console.log(
        `[SuperLike][AJAX] status=${response.status()} flowId=${info.flowId} page=${info.page}`
      );

      if (response.status() === 418) {
        done = true;
        clearTimeout(timer);
        page.off('response', onResponse);
        resolve({
          http418: true,
          url: response.url(),
          page: info.page
        });
        return;
      }

      let json;

      try {
        json =
          await response.json();

      } catch {
        return;
      }


      if (
        response.status() < 200
        ||
        response.status() >= 300
      ) {
        return;
      }


      done = true;

      clearTimeout(
        timer
      );

      page.off(
        'response',
        onResponse
      );


      resolve({
        url:
          response.url(),

        page:
          info.page,

        json,

        requestHeaders:
          response.request().headers()
      });
    }


    page.on(
      'response',
      onResponse
    );
  });
}

async function clickPrimaryLatest(
  page
) {
  console.log(
    '[SuperLike] 等待一级“最新”Tab渲染...'
  );

  const timeoutMs = 15000;
  const startedAt = Date.now();

  while (
    Date.now() - startedAt < timeoutMs
  ) {

    /*
     * 只负责找到真正的“最新”文字节点。
     *
     * 不在 page.evaluate() 里面 click，
     * 而是返回 locator 后让 Playwright 真正点击。
     */
    const latest =
      page.locator(
        '.wbpro-textcut'
      )
      .filter({
        hasText: /^最新$/
      });


    const count =
      await latest.count();


    if (
      count > 0
    ) {

      for (
        let i = 0;
        i < count;
        i++
      ) {

        const textNode =
          latest.nth(i);


        if (
          !await textNode.isVisible()
        ) {
          continue;
        }


        /*
         * DOM：
         *
         * woo-box-item-inlineBlock
         *   └─ ...
         *       └─ wbpro-textcut "最新"
         *
         * 所以必须向上找到
         * woo-box-item-inlineBlock
         *
         * 不能点击 wbpro-tab2 总容器。
         */
        const tab =
          textNode.locator(
            'xpath=ancestor::div[contains(@class,"woo-box-item-inlineBlock")][1]'
          );


        if (
          await tab.count()
          ===
          0
        ) {
          continue;
        }


        if (
          !await tab.isVisible()
        ) {
          continue;
        }


        const html =
          await tab.evaluate(
            element =>
              element.outerHTML
          );


        console.log(
          `[SuperLike] 找到一级“最新”Tab：${html.slice(
            0,
            500
          )}`
        );


        /*
         * Playwright真实点击。
         */
        await tab.click({
          force: true
        });


        console.log(
          '[SuperLike] 已点击一级“最新”'
        );


        return true;
      }
    }


    /*
     * 第二层 DOM fallback：
     * 微博有时会改 .wbpro-textcut class，但文字“最新”仍在。
     * 这里不依赖具体 class，只找可见且文本精确为“最新”的节点，
     * 再向上找常见可点击父级。
     */
    const genericLatest =
      page.getByText(
        '最新',
        {
          exact: true
        }
      );

    const genericCount =
      await genericLatest.count();

    for (
      let i = 0;
      i < genericCount;
      i++
    ) {
      const node =
        genericLatest.nth(i);

      if (
        !await node.isVisible()
      ) {
        continue;
      }

      const clickable =
        node.locator(
          'xpath=ancestor::*[self::button or @role="tab" or contains(@class,"woo-box-item-inlineBlock")][1]'
        );

      if (
        await clickable.count()
        > 0
        &&
        await clickable.isVisible()
      ) {
        console.log(
          '[SuperLike] 通过通用文字定位找到一级“最新”Tab'
        );

        await clickable.click({
          force: true
        });

        console.log(
          '[SuperLike] 已点击一级“最新”（通用fallback）'
        );

        return true;
      }
    }


    await page.waitForTimeout(
      500
    );
  }


  console.error(
    '[SuperLike] 15秒内仍未找到一级“最新”Tab'
  );


  return false;
}

function extractLatestPostFlowId(
  feedJson
) {
  const items =
    Array.isArray(
      feedJson?.items
    )
      ? feedJson.items
      : [];


  for (
    const item
    of items
  ) {
    /*
     * 你给的 Response 中：
     *
     * item.category = "card"
     * item.data.itemid = "page_feed_child_tab"
     */
    const itemId =
      item?.itemid
      ??
      item?.data?.itemid;


    if (
      itemId !==
      'page_feed_child_tab'
    ) {
      continue;
    }


    const groups =
      item?.filter_group
      ??
      item?.data?.filter_group;


    if (
      !Array.isArray(groups)
    ) {
      continue;
    }


    const target =
      groups.find(
        group =>
          String(
            group?.name || ''
          ).trim()
          === '最新发帖'
      );


    if (
      target?.containerid
    ) {
      return String(
        target.containerid
      );
    }
  }


  return null;
}

function extractNextPageParams(
  json
) {
  const candidates = [
    json?.moreInfo?.params,
    json?.data?.moreInfo?.params,
    json?.data?.more_info?.params,
    json?.more_info?.params
  ];


  for (
    const params
    of candidates
  ) {
    if (
      params
      &&
      typeof params === 'object'
      &&
      Number(params.page) >= 2
    ) {
      return {
        page:
          Number(params.page),

        since_id:
          params.since_id
          !== undefined
          &&
          params.since_id
          !== null
            ? String(
                params.since_id
              )
            : null,

        max_id:
          params.max_id
          !== undefined
          &&
          params.max_id
          !== null
            ? String(
                params.max_id
              )
            : '0'
      };
    }
  }


  return null;
}

function extractTagNextPageParams(
  json
) {
  const candidates = [
    json?.moreInfo?.params,
    json?.data?.moreInfo?.params,
    json?.data?.more_info?.params,
    json?.more_info?.params
  ];

  for (
    const params
    of candidates
  ) {
    if (
      !params
      ||
      typeof params !== 'object'
    ) {
      continue;
    }

    const sinceId =
      params.since_id
      !== undefined
      &&
      params.since_id !== null
        ? String(params.since_id)
        : null;

    if (!sinceId) {
      continue;
    }

    return {
      page:
        params.page !== null
        &&
        params.page !== undefined
        &&
        params.page !== ''
        &&
        Number.isFinite(
          Number(params.page)
        )
          ? Number(params.page)
          : null,

      since_id:
        sinceId,

      max_id:
        params.max_id
        !== undefined
        &&
        params.max_id !== null
          ? String(params.max_id)
          : '0',

      count:
        params.count
        !== undefined
        &&
        params.count !== null
          ? String(params.count)
          : '15',

      page_common_ext:
        params.page_common_ext
        !== undefined
        &&
        params.page_common_ext !== null
          ? String(params.page_common_ext)
          : 'topicPrompt:1|page:tag_status_sort=1|hide_page:1'
    };
  }

  return null;
}

function buildTagSectionUrl(
  flowId,
  pageParams = null
) {
  const url =
    new URL(
      '/ajax_proxy/chaohua/page',
      'https://weibo.com'
    );

  url.searchParams.set(
    'flowId',
    flowId
  );

  if (!pageParams) {
    return url.toString();
  }

  if (
    pageParams.page !== null
    &&
    pageParams.page !== undefined
    &&
    pageParams.page !== ''
    &&
    Number.isFinite(
      Number(pageParams.page)
    )
  ) {
    url.searchParams.set(
      'page',
      String(pageParams.page)
    );
  }

  if (pageParams.since_id) {
    url.searchParams.set(
      'since_id',
      pageParams.since_id
    );
  }

  url.searchParams.set(
    'count',
    pageParams.count
    || '15'
  );

  url.searchParams.set(
    'max_id',
    pageParams.max_id
    ?? '0'
  );

  url.searchParams.set(
    'page_common_ext',
    pageParams.page_common_ext
    || 'topicPrompt:1|page:tag_status_sort=1|hide_page:1'
  );

  return url.toString();
}

function buildChaohuaUrl(
  flowId,
  pageParams = null,
  templateUrl = null
) {
  /*
   * 后续分页优先复制微博前端真实发出的 sort_time URL，
   * 保留它原本的所有 query 参数。
   *
   * 只替换分页相关参数，避免自己从零拼 URL 导致 403。
   */
  const url =
    templateUrl
      ? new URL(templateUrl)
      : new URL(
          '/ajax_proxy/chaohua/page',
          'https://weibo.com'
        );


  url.searchParams.set(
    'flowId',
    flowId
  );


  if (!pageParams) {
    return url.toString();
  }


  url.searchParams.set(
    'page',
    String(
      pageParams.page
    )
  );


  if (
    pageParams.since_id
  ) {
    url.searchParams.set(
      'since_id',
      pageParams.since_id
    );
  } else {
    url.searchParams.delete(
      'since_id'
    );
  }


  url.searchParams.set(
    'max_id',
    pageParams.max_id
    ?? '0'
  );


  return url.toString();
}

async function fetchJsonInPageWithRetry(
  page,
  url,
  {
    headers = {
      Accept:
        'application/json, text/plain, */*'
    },
    maxAttempts = 3,
    retryDelaysMs = [500, 1000],
    timeoutMs = 30000
  } = {}
) {
  let lastResult = null;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    const startedAt =
      Date.now();

    const result =
      await page.evaluate(
        async ({
          requestUrl,
          requestHeaders,
          requestTimeoutMs
        }) => {
          const controller =
            new AbortController();

          const timer =
            setTimeout(
              () =>
                controller.abort(),
              Math.max(
                1000,
                Number(
                  requestTimeoutMs
                  || 8000
                )
              )
            );

          try {
            const response =
              await fetch(
                requestUrl,
                {
                  method:
                    'GET',

                  credentials:
                    'include',

                  headers:
                    requestHeaders,

                  signal:
                    controller.signal
                }
              );

            const text =
              await response.text();

            let json = null;

            try {
              json =
                JSON.parse(
                  text
                );
            } catch {
              // 非 JSON 保留原始文本，由调用方判断。
            }

            clearTimeout(
              timer
            );

            return {
              httpStatus:
                response.status,

              ok:
                response.ok,

              finalUrl:
                response.url,

              text,

              json,

              error:
                null
            };

          } catch (error) {
            clearTimeout(
              timer
            );

            return {
              httpStatus:
                null,

              ok:
                false,

              finalUrl:
                requestUrl,

              text:
                '',

              json:
                null,

              error:
                error?.message
                || String(error)
            };
          }
        },

        {
          requestUrl:
            url,

          requestHeaders:
            headers,

          requestTimeoutMs:
            timeoutMs
        }
      );

    result.attempt =
      attempt;

    result.elapsedMs =
      Date.now()
      - startedAt;

    lastResult =
      result;

    const status =
      Number(
        result.httpStatus
      );

    const retryable =
      (
        result.httpStatus === null
        ||
        result.error
        ||
        status === 429
        ||
        status >= 500
      );

    /*
     * 418 不在这里盲目重试：
     * 交给上层现有的 418 / 代理切换逻辑处理。
     */
    if (
      result.ok
      ||
      status === 418
      ||
      !retryable
      ||
      attempt >= maxAttempts
    ) {
      return result;
    }

    const delayMs =
      retryDelaysMs[
        Math.min(
          attempt - 1,
          retryDelaysMs.length - 1
        )
      ]
      ?? 1000;

    console.log(
      `[SuperLike][Fetch重试] ${attempt}/${maxAttempts} 失败 | status=${result.httpStatus ?? '-'} | error=${result.error || '-'} | ${result.elapsedMs}ms | ${delayMs}ms后重试`
    );

    await page.waitForTimeout(
      delayMs
    );
  }

  return lastResult;
}

async function fetchChaohuaInPage(
  page,
  url,
  requestHeaders = null
) {
  /*
   * 浏览器 fetch 不能手工设置 Cookie / Referer / User-Agent 等受限头。
   * 这些由当前 weibo.com 页面上下文自动携带。
   *
   * 这里只复用第一页真实请求里的安全自定义 header，
   * 特别是微博可能依赖的 x-* / client-* 等字段。
   */
  const safeHeaders = {
    Accept:
      'application/json, text/plain, */*'
  };


  if (
    requestHeaders
    &&
    typeof requestHeaders === 'object'
  ) {
    for (
      const [
        rawName,
        rawValue
      ]
      of Object.entries(
        requestHeaders
      )
    ) {
      const name =
        String(
          rawName
          ||
          ''
        ).toLowerCase();

      if (
        !rawValue
      ) {
        continue;
      }

      if (
        name.startsWith('x-')
        ||
        name.startsWith('client-')
      ) {
        safeHeaders[
          rawName
        ] = String(
          rawValue
        );
      }
    }
  }


  const result =
    await fetchJsonInPageWithRetry(
      page,
      url,
      {
        headers:
          safeHeaders,
        maxAttempts:
          3,
        retryDelaysMs:
          [500, 1000]
      }
    );

  return {
    ...result,
    text:
      String(
        result?.text
        || ''
      ).slice(
        0,
        500
      )
  };
}

async function clickLatestPostTab(
  page
) {
  console.log(
    '[SuperLike] 等待二级“最新发帖”Tab渲染...'
  );

  const latestPost =
    page.getByText(
      '最新发帖',
      {
        exact: true
      }
    );

  await latestPost.first().waitFor({
    state: 'visible',
    timeout: 10000
  });

  const count =
    await latestPost.count();

  console.log(
    `[SuperLike] 找到 ${count} 个“最新发帖”候选`
  );

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const item =
      latestPost.nth(i);

    if (
      !(await item.isVisible())
    ) {
      continue;
    }

    await item.scrollIntoViewIfNeeded();

    console.log(
      '[SuperLike] 点击二级“最新发帖”...'
    );

    await item.click({
      timeout: 5000
    });

    return true;
  }

  throw new Error(
    '“最新发帖”已出现但没有可点击元素'
  );
}

async function triggerNextPage(
  page
) {
  await page.evaluate(
    () => {
      window.scrollTo(
        0,
        document.body.scrollHeight
      );

      const elements =
        Array.from(
          document.querySelectorAll('*')
        );

      let best = null;
      let bestAmount = 0;

      for (
        const el
        of elements
      ) {
        const style =
          window.getComputedStyle(el);

        if (
          ![
            'auto',
            'scroll'
          ].includes(
            style.overflowY
          )
        ) {
          continue;
        }

        const amount =
          el.scrollHeight
          - el.clientHeight;

        if (
          amount >
          bestAmount
        ) {
          bestAmount = amount;
          best = el;
        }
      }

      if (best) {
        best.scrollTop =
          best.scrollHeight;
      }
    }
  );

  await page.waitForTimeout(
    800
  );

  try {
    await page.mouse.wheel(
      0,
      4000
    );
  } catch {
    // ignore
  }
}

module.exports = {
  parseChaohuaRequestUrl,
  waitForChaohuaResponse,
  clickPrimaryLatest,
  extractLatestPostFlowId,
  extractNextPageParams,
  extractTagNextPageParams,
  buildTagSectionUrl,
  buildChaohuaUrl,
  fetchJsonInPageWithRetry,
  fetchChaohuaInPage,
  clickLatestPostTab,
  triggerNextPage
};

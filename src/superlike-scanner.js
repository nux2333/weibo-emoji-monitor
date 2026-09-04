const path = require('path');
const { chromium } = require('playwright');
const { db, initDatabase } = require('./db');

/**
 * ============================================================
 * SuperLike Batch - 从 _feed Response 解析“最新发帖”版
 *
 * 流程：
 * 1. 打开真实超话首页
 * 2. 点击一级“最新”
 * 3. 捕获 _-_feed 第一页真实 Response
 * 4. 从 Response:
 *      items
 *        -> page_feed_child_tab
 *        -> filter_group
 *        -> name = 最新发帖
 *        -> containerid = ..._-_sort_time
 * 5. 在当前页面上下文中请求 sort_time 第一页
 * 6. 从 sort_time Response 的 moreInfo.params 读取下一页：
 *      page
 *      since_id
 *      max_id
 * 7. 最多 50 页
 * 8. DB 已有 post_id > 10 后结束
 * 9. 评论 < 20 且无 chao_like 才入库
 * 10. 15 分钟后重新开始
 * ============================================================
 */

const SCAN_INTERVAL_MS =
  Number(process.env.SUPERLIKE_SCAN_INTERVAL_MS)
  || 15 * 60 * 1000;

const MAX_PAGES =
  Number(process.env.SUPERLIKE_MAX_PAGES)
  || 50;

const EXISTING_STOP_THRESHOLD =
  Number(process.env.SUPERLIKE_EXISTING_STOP_THRESHOLD)
  || 10;

const INITIAL_WAIT_MS =
  Number(process.env.SUPERLIKE_INITIAL_WAIT_MS)
  || 3000;

const FEED_WAIT_MS =
  Number(process.env.SUPERLIKE_FEED_WAIT_MS)
  || 10000;

const PAGE_DELAY_MS =
  Number(process.env.SUPERLIKE_PAGE_DELAY_MS)
  || 500;

const MAX_COMMENTS = 20;

let running = false;


/* ============================================================
 * DB
 * ============================================================ */

function initSuperLikeTable() {
  initDatabase();
}

function getSuperLikeMonitors() {
  initDatabase();

  return db.prepare(`
    SELECT
      id,
      name,
      url,
      enabled,
      monitor_type
    FROM monitors
    WHERE enabled = 1
      AND monitor_type = 'superlike'
    ORDER BY id
  `).all();
}

function postIdExists(postId) {
  if (!postId) {
    return false;
  }

  return !!db.prepare(`
    SELECT 1
    FROM superlike_posts
    WHERE post_id = ?
    LIMIT 1
  `).get(postId);
}


/* ============================================================
 * Monitor URL
 * ============================================================ */

function parseTopicHomepage(topicUrl) {
  const url =
    new URL(
      String(topicUrl || '').trim()
    );

  const match =
    url.pathname.match(
      /^\/p\/(100808[a-zA-Z0-9]+)\/?$/
    );

  if (!match) {
    throw new Error(
      `SuperLike monitor.url 必须是超话首页：https://weibo.com/p/100808xxxx。当前=${topicUrl}`
    );
  }

  const containerId =
    match[1];

  return {
    homepage:
      `https://weibo.com/p/${containerId}`,

    hotFlowId:
      containerId,

    feedFlowId:
      `${containerId}_-_feed`
  };
}


/* ============================================================
 * Post helpers
 * ============================================================ */

function stripHtml(value) {
  if (value == null) {
    return '';
  }

  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function getPostId(post) {
  const value =
    post?.idstr
    ?? post?.mid
    ?? post?.id;

  return (
    value === null ||
    value === undefined ||
    value === ''
  )
    ? ''
    : String(value);
}

function getUid(post) {
  const value =
    post?.user?.idstr
    ?? post?.user?.id
    ?? post?.uid;

  return (
    value === null ||
    value === undefined ||
    value === ''
  )
    ? ''
    : String(value);
}

function getUsername(post) {
  return (
    post?.user?.screen_name
    ?? post?.user?.name
    ?? null
  );
}

function getPostText(post) {
  return stripHtml(
    post?.text
    ?? post?.raw_text
    ?? post?.text_raw
    ?? ''
  );
}

function getCommentsCount(post) {
  const value =
    post?.comments_count
    ?? post?.comment_count;

  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function getPostCreatedAt(post) {
  const value =
    post?.created_at
    ?? post?.createdAt
    ?? null;

  return value
    ? String(value)
    : null;
}

function getPostLink(post) {
  const candidates = [
    post?.url,
    post?.mblog_url,
    post?.detail_url,
    post?.scheme
  ];

  for (const value of candidates) {
    if (
      typeof value === 'string'
      &&
      /^https?:\/\//i.test(value)
      &&
      value.toLowerCase().includes('weibo')
    ) {
      return value;
    }
  }

  const postId =
    getPostId(post);

  return postId
    ? `https://m.weibo.cn/detail/${postId}`
    : '';
}


/* ============================================================
 * Find Posts
 * ============================================================ */

function looksLikePost(obj) {
  if (
    !obj
    ||
    typeof obj !== 'object'
    ||
    Array.isArray(obj)
  ) {
    return false;
  }

  const postId =
    obj.idstr
    ?? obj.mid
    ?? obj.id;

  if (
    !postId
    ||
    !obj.user
  ) {
    return false;
  }

  return (
    obj.comments_count !== undefined
    ||
    obj.comment_count !== undefined
    ||
    obj.text !== undefined
    ||
    obj.raw_text !== undefined
    ||
    obj.text_raw !== undefined
    ||
    obj.reposts_count !== undefined
    ||
    obj.attitudes_count !== undefined
  );
}

function findPosts(
  value,
  result = [],
  visited = new Set()
) {
  if (
    !value
    ||
    typeof value !== 'object'
    ||
    visited.has(value)
  ) {
    return result;
  }

  visited.add(value);

  if (looksLikePost(value)) {
    result.push(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findPosts(
        item,
        result,
        visited
      );
    }

    return result;
  }

  for (
    const child
    of Object.values(value)
  ) {
    if (
      child
      &&
      typeof child === 'object'
    ) {
      findPosts(
        child,
        result,
        visited
      );
    }
  }

  return result;
}


/* ============================================================
 * SuperLike / icons
 * ============================================================ */

function hasSuperLike(post) {
  /*
   * 真实 Response 已确认：
   *
   * user.icons = [
   *   {
   *     name: "chao_like"
   *   }
   * ]
   *
   * 所以优先做精确判断。
   */
  const icons =
    Array.isArray(
      post?.user?.icons
    )
      ? post.user.icons
      : [];

  if (
    icons.some(
      icon =>
        String(
          icon?.name || ''
        ).toLowerCase()
        === 'chao_like'
    )
  ) {
    return true;
  }

  /*
   * 兼容未来字段变化。
   */
  let text = '';

  try {
    text =
      JSON.stringify(
        post?.user || {}
      ).toLowerCase();

  } catch {
    return false;
  }

  return (
    text.includes('"name":"chao_like"')
    ||
    text.includes('"name":"chaolike"')
    ||
    text.includes('"name":"super_like"')
    ||
    text.includes('"name":"superlike"')
  );
}

function extractIcons(post) {
  const icons =
    Array.isArray(
      post?.user?.icons
    )
      ? post.user.icons
      : [];

  return icons
    .map(
      icon =>
        String(
          icon?.name || ''
        ).trim()
    )
    .filter(Boolean)
    .filter(
      name =>
        name.toLowerCase()
        !== 'chao_like'
    );
}


/* ============================================================
 * Save
 * ============================================================ */

function saveTargetPost(
  monitorId,
  post
) {
  const postId =
    getPostId(post);

  if (!postId) {
    return {
      status: 'skip',
      reason: 'no_post_id'
    };
  }

  const commentsCount =
    getCommentsCount(post);

  if (
    commentsCount === null
  ) {
    return {
      status: 'skip',
      reason: 'unknown_comments'
    };
  }

  if (
    commentsCount >= MAX_COMMENTS
  ) {
    return {
      status: 'skip',
      reason: 'comments_full'
    };
  }

  if (
    hasSuperLike(post)
  ) {
    return {
      status: 'skip',
      reason: 'has_superlike'
    };
  }

  const uid =
    getUid(post);

  const username =
    getUsername(post);

  const postLink =
    getPostLink(post);

  const postText =
    getPostText(post);

  const postCreatedAt =
    getPostCreatedAt(post);

  const icons =
    extractIcons(post);

  const iconSummary =
    icons.length > 0
      ? icons.join(' / ')
      : '无';

  let rawJson = null;

  try {
    rawJson =
      JSON.stringify(post);

  } catch {
    rawJson = null;
  }

  db.prepare(`
    INSERT INTO superlike_posts(
      monitor_id,
      post_id,
      uid,
      username,
      post_link,
      post_text,
      comments_count,
      current_has_superlike,
      icon_summary,
      experience_7d,
      post_created_at,
      first_seen_at,
      last_seen_at,
      raw_json
    )
    VALUES(
      ?,?,?,?,?,?,?,
      0,
      ?,
      NULL,
      ?,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,
      ?
    )
  `).run(
    monitorId,
    postId,
    uid || null,
    username,
    postLink || null,
    postText,
    commentsCount,
    iconSummary,
    postCreatedAt,
    rawJson
  );

  return {
    status: 'inserted',
    postId,
    uid,
    username,
    postLink,
    commentsCount,
    iconSummary
  };
}


/* ============================================================
 * AJAX helpers
 * ============================================================ */

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


/**
 * ============================================================
 * 捕获指定 flowId 的下一条 Response
 * ============================================================
 */

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


/**
 * ============================================================
 * 点击一级“最新”
 * ============================================================
 */

async function clickPrimaryLatest(
  page
) {
  /*
   * 优先找一级导航：
   * 热门 / 最新 / 精华...
   *
   * 用共同容器排除其它“最新”文字。
   */
  const result =
    await page.evaluate(
      () => {
        function isVisible(el) {
          const rect =
            el.getBoundingClientRect();

          const style =
            window.getComputedStyle(
              el
            );

          return (
            rect.width > 0
            &&
            rect.height > 0
            &&
            style.display !== 'none'
            &&
            style.visibility !== 'hidden'
          );
        }


        const all =
          Array.from(
            document.querySelectorAll(
              'a,button,span,div,li'
            )
          )
          .filter(isVisible);


        const latestNodes =
          all.filter(
            node =>
              (
                node.textContent
                || ''
              ).trim()
              === '最新'
          );


        const hotNodes =
          all.filter(
            node =>
              (
                node.textContent
                || ''
              ).trim()
              === '热门'
          );


        for (
          const latest
          of latestNodes
        ) {
          let parent =
            latest.parentElement;

          let depth = 0;


          while (
            parent
            &&
            depth < 8
          ) {
            const text =
              (
                parent.textContent
                || ''
              )
                .replace(
                  /\s+/g,
                  ''
                );


            const containsHot =
              hotNodes.some(
                hot =>
                  parent.contains(hot)
              );


            if (
              containsHot
              &&
              text.includes('热门')
              &&
              text.includes('最新')
              &&
              text.length <= 100
            ) {
              const clickable =
                latest.closest(
                  'a,button,[role="tab"],[role="button"],li'
                )
                || latest;


              clickable.scrollIntoView({
                block: 'center'
              });


              clickable.click();


              return {
                clicked: true,
                html:
                  (
                    clickable.outerHTML
                    || ''
                  ).slice(
                    0,
                    300
                  )
              };
            }


            parent =
              parent.parentElement;

            depth++;
          }
        }


        return {
          clicked: false
        };
      }
    );


  if (
    result.clicked
  ) {
    console.log(
      `[SuperLike] 已点击一级“最新”：${result.html || ''}`
    );

    return true;
  }


  return false;
}


/**
 * ============================================================
 * 从 _feed Response 找“最新发帖” containerid
 * ============================================================
 */

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


/**
 * ============================================================
 * 从 Response 直接拿下一页参数
 *
 * 你给的 _feed Response 已确认：
 *
 * moreInfo: {
 *   pagingType: "cursor",
 *   params: {
 *     page: 2,
 *     since_id: "{\"max_id\":...}",
 *     max_id: 0
 *   }
 * }
 *
 * sort_time 也优先按同结构读取。
 * ============================================================
 */

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


function buildChaohuaUrl(
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


  /*
   * 第一页只有 flowId。
   */
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
  }


  url.searchParams.set(
    'max_id',
    pageParams.max_id
    ?? '0'
  );


  return url.toString();
}


/**
 * ============================================================
 * 页面内 AJAX
 *
 * 这次是在：
 *
 * 首页打开成功
 * -> 一级最新点击成功
 * -> _feed 请求 200 成功
 *
 * 之后才请求 sort_time。
 *
 * 比之前一进入页面就裸 fetch 多了一层真实前端状态。
 * ============================================================
 */

async function fetchChaohuaInPage(
  page,
  url
) {
  return await page.evaluate(
    async requestUrl => {
      const response =
        await fetch(
          requestUrl,
          {
            method:
              'GET',

            credentials:
              'include',

            headers: {
              Accept:
                'application/json, text/plain, */*'
            }
          }
        );


      const text =
        await response.text();


      let json;

      try {
        json =
          JSON.parse(
            text
          );

      } catch {
        throw new Error(
          `非JSON Response: ${text.slice(0, 200)}`
        );
      }


      return {
        httpStatus:
          response.status,

        ok:
          response.ok,

        json
      };
    },

    url
  );
}



/**
 * ============================================================
 * 等待并点击二级“最新发帖”
 * ============================================================
 */
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


/**
 * ============================================================
 * 滚动页面，让微博前端自己触发下一页 AJAX
 * ============================================================
 */
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


/**
 * ============================================================
 * Process Post Page
 * ============================================================
 */

function processPagePosts(
  monitorId,
  json,
  seenThisRun
) {
  const stats = {
    found: 0,
    duplicateInRun: 0,
    existingInDb: 0,
    unknownComments: 0,
    commentsFull: 0,
    hasSuperLike: 0,
    target: 0,
    inserted: 0
  };


  const posts =
    findPosts(
      json
    );


  for (
    const post
    of posts
  ) {
    const postId =
      getPostId(
        post
      );


    if (!postId) {
      continue;
    }


    if (
      seenThisRun.has(
        postId
      )
    ) {
      stats.duplicateInRun++;
      continue;
    }


    seenThisRun.add(
      postId
    );

    stats.found++;


    if (
      postIdExists(
        postId
      )
    ) {
      stats.existingInDb++;
      continue;
    }


    const commentsCount =
      getCommentsCount(
        post
      );


    if (
      commentsCount === null
    ) {
      stats.unknownComments++;
      continue;
    }


    if (
      commentsCount >=
      MAX_COMMENTS
    ) {
      stats.commentsFull++;
      continue;
    }


    if (
      hasSuperLike(
        post
      )
    ) {
      stats.hasSuperLike++;
      continue;
    }


    stats.target++;


    try {
      const saved =
        saveTargetPost(
          monitorId,
          post
        );


      if (
        saved.status ===
        'inserted'
      ) {
        stats.inserted++;


        console.log(
          [
            '[SuperLike][新增]',
            `UID=${saved.uid || '-'}`,
            `用户=${saved.username || '-'}`,
            `评论=${saved.commentsCount}`,
            `Icon=${saved.iconSummary || '无'}`,
            saved.postLink || '-'
          ].join(' | ')
        );
      }

    } catch (error) {
      if (
        String(
          error.message
        )
          .toLowerCase()
          .includes(
            'unique'
          )
      ) {
        stats.existingInDb++;
        continue;
      }

      throw error;
    }
  }


  return stats;
}


/* ============================================================
 * Scan one monitor
 * ============================================================ */

async function scanOneSuperLikeMonitor(
  monitor
) {
  const config =
    parseTopicHomepage(
      monitor.url
    );


  const profileDir =
    path.join(
      __dirname,
      '..',
      'data',
      'superlike-browser-profile'
    );


  let browser = null;


  const startedAt =
    Date.now();


  const seenThisRun =
    new Set();


  const total = {
    found: 0,
    duplicateInRun: 0,
    existingInDb: 0,
    unknownComments: 0,
    commentsFull: 0,
    hasSuperLike: 0,
    target: 0,
    inserted: 0
  };


  let totalExisting =
    0;

  let pagesScanned =
    0;

  let stopReason =
    `达到最大 ${MAX_PAGES} 页`;


  try {
    console.log('');
    console.log(
      '=============================================='
    );

    console.log(
      `SuperLike Monitor：${monitor.name}`
    );

    console.log(
      `真实超话首页：${config.homepage}`
    );

    console.log(
      `最新评论 flowId：${config.feedFlowId}`
    );

    console.log(
      `最多：${MAX_PAGES}页`
    );

    console.log(
      `DB旧Post > ${EXISTING_STOP_THRESHOLD} 后停止`
    );

    console.log(
      '=============================================='
    );


    browser =
      await chromium
        .launchPersistentContext(
          profileDir,
          {
            headless:
              process.env
                .SUPERLIKE_HEADLESS
              === '1',

            viewport: {
              width: 1280,
              height: 900
            }
          }
        );


    const page =
      browser.pages()[0]
      ||
      await browser.newPage();


    console.log(
      '[SuperLike] 打开真实超话首页...'
    );


    await page.goto(
      config.homepage,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          60 * 1000
      }
    );


    await page.waitForTimeout(
      INITIAL_WAIT_MS
    );


    /*
     * 先监听 _feed，再点击一级“最新”
     */
    const feedWaiter =
      waitForChaohuaResponse(
        page,
        config.feedFlowId,
        FEED_WAIT_MS
      );


    console.log(
      '[SuperLike] 点击一级“最新”...'
    );


    const clicked =
      await clickPrimaryLatest(
        page
      );


    if (!clicked) {
      stopReason =
        '未找到一级“最新”Tab';

      console.error(
        `[SuperLike] ${stopReason}`
      );

      return;
    }


    const feedResult =
      await feedWaiter;


    if (!feedResult) {
      stopReason =
        '点击一级“最新”后未捕获到 _feed Response';

      console.error(
        `[SuperLike] ${stopReason}`
      );

      return;
    }


    console.log(
      `[SuperLike] _feed 第一页成功：${feedResult.url}`
    );


    /*
     * 从 _feed Response 获取“最新发帖” flowId
     */
    const sortTimeFlowId =
      extractLatestPostFlowId(
        feedResult.json
      );


    if (!sortTimeFlowId) {
      stopReason =
        '_feed Response 中没有找到“最新发帖”containerid';

      console.error(
        `[SuperLike] ${stopReason}`
      );

      return;
    }


    console.log(
      `[SuperLike] 从 _feed Response 找到“最新发帖” flowId：${sortTimeFlowId}`
    );


    /*
     * 关键：
     * 监听器必须先挂，再点击 DOM。
     */
    const firstSortTimeWaiter =
      waitForChaohuaResponse(
        page,
        sortTimeFlowId,
        FEED_WAIT_MS
      );


    await clickLatestPostTab(
      page
    );


    const firstSortTimeResult =
      await firstSortTimeWaiter;


    if (!firstSortTimeResult) {
      stopReason =
        '点击“最新发帖”后未捕获到 sort_time 第一页';

      console.error(
        `[SuperLike] ${stopReason}`
      );

      return;
    }


    console.log(
      `[SuperLike] sort_time 第一页成功：${firstSortTimeResult.url}`
    );


    let current =
      firstSortTimeResult;


    for (
      let pageNumber = 1;
      pageNumber <= MAX_PAGES;
      pageNumber++
    ) {
      pagesScanned++;


      const pageStats =
        processPagePosts(
          monitor.id,
          current.json,
          seenThisRun
        );


      for (
        const key
        of Object.keys(total)
      ) {
        total[key] +=
          pageStats[key]
          || 0;
      }


      totalExisting +=
        pageStats.existingInDb;


      console.log(
        [
          `[第${pageNumber}页]`,
          `Post=${pageStats.found}`,
          `DB已有=${pageStats.existingInDb}`,
          `累计DB已有=${totalExisting}`,
          `评论>=20=${pageStats.commentsFull}`,
          `SuperLike=${pageStats.hasSuperLike}`,
          `新增=${pageStats.inserted}`
        ].join(' | ')
      );


      if (
        totalExisting >
        EXISTING_STOP_THRESHOLD
      ) {
        stopReason =
          `累计发现 ${totalExisting} 条 DB 已存在 post_id`;

        console.log(
          `[SuperLike] DB旧Post已超过 ${EXISTING_STOP_THRESHOLD}，结束本轮。`
        );

        break;
      }


      if (
        pageNumber >=
        MAX_PAGES
      ) {
        stopReason =
          `达到最大 ${MAX_PAGES} 页`;

        break;
      }


      /*
       * 下一页：
       * 先监听 sort_time，再滚动触发微博前端真实 AJAX。
       */
      const nextWaiter =
        waitForChaohuaResponse(
          page,
          sortTimeFlowId,
          FEED_WAIT_MS
        );


      console.log(
        '[SuperLike] 滚动页面，等待下一页 sort_time AJAX...'
      );


      await triggerNextPage(
        page
      );


      let next =
        await nextWaiter;


      /*
       * 第一次没触发时，再滚一次。
       */
      if (!next) {
        const retryWaiter =
          waitForChaohuaResponse(
            page,
            sortTimeFlowId,
            FEED_WAIT_MS
          );

        await triggerNextPage(
          page
        );

        next =
          await retryWaiter;
      }


      if (!next) {
        stopReason =
          `第${pageNumber}页后未触发下一页 sort_time AJAX`;

        console.log(
          `[SuperLike] ${stopReason}`
        );

        break;
      }


      current =
        next;
    }


  } catch (error) {
    stopReason =
      `异常：${error.message}`;

    throw error;

  } finally {
    if (browser) {
      try {
        await browser.close();

      } catch {
        // ignore
      }
    }


    const seconds =
      Math.round(
        (
          Date.now()
          -
          startedAt
        )
        /
        1000
      );


    console.log('');
    console.log(
      `========== ${monitor.name} 本轮结果 ==========`
    );

    console.log(
      '扫描页数：',
      pagesScanned
    );

    console.log(
      'Post：',
      total.found
    );

    console.log(
      'Response内重复：',
      total.duplicateInRun
    );

    console.log(
      'DB已有：',
      total.existingInDb
    );

    console.log(
      '评论数未知：',
      total.unknownComments
    );

    console.log(
      '评论>=20：',
      total.commentsFull
    );

    console.log(
      '已有SuperLike：',
      total.hasSuperLike
    );

    console.log(
      '符合候选：',
      total.target
    );

    console.log(
      '新增：',
      total.inserted
    );

    console.log(
      '停止原因：',
      stopReason
    );

    console.log(
      '耗时：',
      `${seconds}秒`
    );

    console.log(
      '=============================================='
    );
  }
}


/* ============================================================
 * One round
 * ============================================================ */

async function scanSuperLikePosts() {
  if (running) {
    console.log(
      '[SuperLike] 上一轮尚未结束，本轮跳过。'
    );

    return;
  }


  running = true;


  try {
    initDatabase();


    const monitors =
      getSuperLikeMonitors();


    if (
      monitors.length === 0
    ) {
      console.log('');
      console.log(
        '[SuperLike] 没有启用的 SuperLike Monitor。'
      );

      console.log(
        "需要 monitor_type='superlike' AND enabled=1"
      );

      return;
    }


    console.log(
      `[SuperLike] 本轮 ${monitors.length} 个 Monitor`
    );


    for (
      const monitor
      of monitors
    ) {
      try {
        await scanOneSuperLikeMonitor(
          monitor
        );

      } catch (error) {
        console.error(
          `[SuperLike] ${monitor.name} 扫描失败：`,
          error
        );
      }
    }

  } finally {
    running = false;
  }
}


/* ============================================================
 * Batch
 * ============================================================ */

async function startSuperLikeBatch() {
  initDatabase();


  console.log('');
  console.log(
    '################################################'
  );

  console.log(
    '# SuperLike Batch'
  );

  console.log(
    `# 每 ${SCAN_INTERVAL_MS / 60000} 分钟重新开始`
  );

  console.log(
    '# 一级最新 -> 捕获 _feed -> 解析最新发帖 containerid'
  );

  console.log(
    '# sort_time 分页使用 Response.moreInfo.params'
  );

  console.log(
    `# 最多 ${MAX_PAGES} 页`
  );

  console.log(
    `# DB已有 post_id > ${EXISTING_STOP_THRESHOLD} 时结束`
  );

  console.log(
    '# 评论<20 + 无SuperLike -> 入库'
  );

  console.log(
    '# Ctrl+C 停止'
  );

  console.log(
    '################################################'
  );


  await scanSuperLikePosts();


  setInterval(
    async () => {
      console.log('');
      console.log(
        '[SuperLike] 15分钟到，重新开始。'
      );


      try {
        await scanSuperLikePosts();

      } catch (error) {
        console.error(
          '[SuperLike] 定时扫描失败：',
          error
        );
      }
    },

    SCAN_INTERVAL_MS
  );
}


process.on(
  'SIGINT',
  () => {
    console.log('');
    console.log(
      '[SuperLike] Batch停止。'
    );

    process.exit(0);
  }
);


module.exports = {
  initSuperLikeTable,
  getSuperLikeMonitors,
  scanSuperLikePosts,
  scanOneSuperLikeMonitor,
  startSuperLikeBatch,
  hasSuperLike,
  extractIcons,
  findPosts,
  getPostId,
  getUid,
  getUsername,
  getPostText,
  getPostLink,
  getCommentsCount,
  postIdExists,
  parseTopicHomepage,
  parseChaohuaRequestUrl,
  clickPrimaryLatest,
  extractLatestPostFlowId,
  extractNextPageParams,
  buildChaohuaUrl,
  fetchChaohuaInPage,
  clickLatestPostTab,
  triggerNextPage
};


if (
  require.main === module
) {
  startSuperLikeBatch()
    .catch(
      error => {
        console.error(
          '[SuperLike] Batch启动失败：',
          error
        );

        process.exit(1);
      }
    );
}

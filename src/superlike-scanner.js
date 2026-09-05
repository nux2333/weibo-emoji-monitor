const {
  createBatchLogger
} = require('./batch-logger');

let batchLogger = null;

if (require.main === module) {
  batchLogger =
    createBatchLogger(
      'scan-superlike'
    );
}

const path = require('path');
const { chromium } = require('playwright');
const {
  ProxyPool
} = require('./proxy-pool');
const {
  initDatabase,
  getSuperLikeMonitors,
  superLikePostIdExists,
  getExistingSuperLikeUids,
  isSuperLikeUser,
  saveSuperLikeUser,
  saveSuperLikeTargetPost,
  deletePostsByUidSet,
  cleanupSuperLikePostsByUsersTable,
  getScanCheckpoint,
  saveScanCheckpoint
} = require('./db');

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
 * 6. 从 sort_time Response 的 moreInfo.params 读取下一页，并直接 AJAX 请求：
 *      page
 *      since_id
 *      max_id
 * 7. 最多 50 页
 * 8. DB 已有 post_id > 10 后结束
 * 9. UID不在 superlike_users + feed无chao_like + 评论<21 才入库
 * 10. 15 分钟后重新开始
 * ============================================================
 */

const DAY_SCAN_INTERVAL_MS =
  Number(process.env.SUPERLIKE_DAY_SCAN_INTERVAL_MS)
  || 20 * 60 * 1000;

const NIGHT_SCAN_INTERVAL_MS =
  Number(process.env.SUPERLIKE_NIGHT_SCAN_INTERVAL_MS)
  || 5 * 60 * 1000;

const RATE_LIMIT_BACKOFF_1_MS =
  Number(process.env.SUPERLIKE_418_BACKOFF_1_MS)
  || 30 * 60 * 1000;

const RATE_LIMIT_BACKOFF_2_MS =
  Number(process.env.SUPERLIKE_418_BACKOFF_2_MS)
  || 60 * 60 * 1000;

let consecutive418 = 0;

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

const MAX_COMMENTS = 21;

let running = false;

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


/* ============================================================
 * DB
 * ============================================================ */

function initSuperLikeTable() {
  initDatabase();
}

// 保留 scanner 内原函数名，实际数据库查询统一交给 db.js。
function postIdExists(postId) {
  return superLikePostIdExists(postId);
}


function parsePostCreatedAtMs(post) {
  const raw =
    getPostCreatedAt(post);

  if (!raw) {
    return null;
  }

  const ms =
    Date.parse(raw);

  return Number.isFinite(ms)
    ? ms
    : null;
}


function getNewestPostInfo(posts) {
  let best = null;

  for (
    const post
    of posts
  ) {
    const postId =
      getPostId(post);

    const createdAt =
      getPostCreatedAt(post);

    const createdAtMs =
      parsePostCreatedAtMs(post);

    if (
      !postId
      ||
      !Number.isFinite(
        Number(createdAtMs)
      )
    ) {
      continue;
    }

    if (
      !best
      ||
      createdAtMs >
        best.createdAtMs
    ) {
      best = {
        postId,
        createdAt,
        createdAtMs
      };
    }
  }

  return best;
}


function shouldStopAtCheckpoint(
  post,
  checkpoint
) {
  if (
    !checkpoint
    ||
    !checkpoint.latest_post_id
  ) {
    return false;
  }

  const postId =
    getPostId(post);

  if (!postId) {
    return false;
  }

  /*
   * 只按上一轮真实 post_id 判断 checkpoint。
   * 不再因为 created_at 比 checkpoint 时间早就停止，
   * 避免微博同一页/相邻页并非严格按发帖时间排序时漏帖。
   */
  return (
    String(postId) ===
    String(checkpoint.latest_post_id)
  );
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
    /ERR_CONNECTION_RESET/i.test(text)
    ||
    /ERR_CONNECTION_CLOSED/i.test(text)
    ||
    /ERR_CONNECTION_REFUSED/i.test(text)
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

  const topicHash =
    containerId.replace(
      /^100808/,
      ''
    );

  return {
    homepage:
      `https://weibo.com/p/${containerId}`,

    hotFlowId:
      containerId,

    feedFlowId:
      `${containerId}_-_feed`,

    topicHash,

    profileContainerId:
      `231140${topicHash}_-_profile_inpage`,

    chaoLikeListContainerId:
      `231140${topicHash}_-_chaolikenew`
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
  const uid =
    getUid(post);

  const postId =
    getPostId(post);

  if (
    !uid ||
    !postId
  ) {
    return '';
  }

  return `https://weibo.com/${uid}/${postId}`;
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

  const uid =
    getUid(post);

  if (!uid) {
    return {
      status: 'skip',
      reason: 'no_uid'
    };
  }

  /*
   * 三级判断 STEP 1：
   * UID 已经在 superlike_users 中 -> 直接忽略。
   * 这是纯本地 DB 查询，不产生额外微博请求。
   */
  const knownSuperLike =
    isSuperLikeUser(
      uid
    );

  if (knownSuperLike) {
    return {
      status: 'skip',
      reason: 'uid_in_superlike_users'
    };
  }

  /*
   * 三级判断 STEP 2：
   * 当前 feed Response 已明确带 chao_like。
   * 立即保存到 superlike_users，并立即清掉该 UID 已有候选。
   */
  if (
    hasSuperLike(post)
  ) {
    saveSuperLikeUser(
      monitorId,
      uid
    );

    deletePostsByUidSet(
      new Set([uid])
    );

    return {
      status: 'skip',
      reason: 'has_superlike'
    };
  }

  /*
   * 三级判断 STEP 3：
   * 评论 >= 21 不入库；0-20 才作为候选。
   */
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

  const username =
    getUsername(post);

  const postLink =
    getPostLink(post);

  const postText =
    getPostText(post);

  const postCreatedAt =
    getPostCreatedAt(post);

  const postCreatedAtMs =
    parsePostCreatedAtMs(post);

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

  return saveSuperLikeTargetPost({
    monitorId,
    postId,
    uid,
    username,
    postLink,
    postText,
    commentsCount,
    iconSummary,
    postCreatedAt,
    postCreatedAtMs,
    rawJson
  });
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


/**
 * ============================================================
 * 点击一级“最新”
 * ============================================================
 */
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


    await page.waitForTimeout(
      500
    );
  }


  console.error(
    '[SuperLike] 15秒内仍未找到一级“最新”Tab'
  );


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


  return await page.evaluate(
    async ({
      requestUrl,
      headers
    }) => {
      const response =
        await fetch(
          requestUrl,
          {
            method:
              'GET',

            credentials:
              'include',

            headers
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
        // 非 JSON 时保留原始文本，交给调用方打印诊断。
      }


      return {
        httpStatus:
          response.status,

        ok:
          response.ok,

        finalUrl:
          response.url,

        text:
          text.slice(
            0,
            500
          ),

        json
      };
    },

    {
      requestUrl:
        url,

      headers:
        safeHeaders
    }
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
 * 构造用户在当前超话的 profile_inpage API URL
 *
 * 页面形式：
 * https://m.weibo.cn/p/index?containerid=231140{hash}_-_profile_inpage
 *
 * 实际 JSON API：
 * https://m.weibo.cn/api/container/getIndex?... 
 *
 * extparam 的目标值是：
 * target_uid#123456
 *
 * 在这个接口里需要嵌套编码，所以最终 URL 会看到：
 * target_uid%2523123456
 * ============================================================
 */
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


/**
 * ============================================================
 * profile_inpage Response 是否存在超LIKE
 *
 * 优先判断页面实际展示的：
 * title_sub = "超LIKE"
 *
 * 同时兼容 scheme 中：
 * union_id=chao_like
 * union_id%3Dchao_like
 * union_id%253Dchao_like
 * ============================================================
 */
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
/**
 * ============================================================
 * 请求用户 profile_inpage 并判断当前是否有超LIKE
 *
 * 返回：
 * {
 *   ok: true,
 *   hasSuperLike: true/false,
 *   url
 * }
 *
 * 请求失败时：
 * {
 *   ok: false,
 *   hasSuperLike: null,
 *   ...
 * }
 * ============================================================
 */
async function checkUserSuperLikeByProfile(
  context,
  config,
  uid
) {
  const url =
    buildProfileInPageApiUrl(
      config,
      uid
    );

  console.log(
    `[SuperLike][ProfileURL] ${url}`
  );

  let profilePage = null;

  try {
    profilePage =
      await context.newPage();

    /*
     * 先打开 m.weibo.cn 首页，
     * 让 visitor/cookie/session 建立起来。
     */
    await profilePage.goto(
      'https://m.weibo.cn/',
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          30000
      }
    );

    await profilePage.waitForTimeout(
      1000
    );

    /*
     * 然后在浏览器页面上下文里 fetch JSON API。
     */
    const result =
      await profilePage.evaluate(
        async requestUrl => {
          try {
            const response =
              await fetch(
                requestUrl,
                {
                  method: 'GET',

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

            return {
              ok:
                response.ok,

              status:
                response.status,

              finalUrl:
                response.url,

              text
            };

          } catch (error) {
            return {
              ok: false,
              status: null,
              finalUrl: requestUrl,
              text: '',
              error:
                error.message
            };
          }
        },

        url
      );

    console.log(
      `[SuperLike][ProfileResponse] UID=${uid} status=${result.status} url=${result.finalUrl}`
    );

    if (
      result.error
    ) {
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
      return {
        ok: false,
        hasSuperLike: null,
        status:
          result.status,

        url:
          result.finalUrl,

        message:
          `API ok=${json?.ok}`
      };
    }

    const hasSuperLike =
      profileHasSuperLike(
        json
      );

    console.log(
      `[SuperLike][Profile结果] UID=${uid} SuperLike=${hasSuperLike}`
    );

    return {
      ok: true,
      hasSuperLike,
      status:
        result.status,

      url:
        result.finalUrl
    };

  } catch (error) {
    return {
      ok: false,
      hasSuperLike: null,
      status: null,
      url,
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
  }
}

/**
 * ============================================================
 * Process Post Page
 * ============================================================
 */

async function processPagePosts(
  monitorId,
  json,
  seenThisRun,
  seenUidThisRun,
  deleteUidSet,
  checkpoint
) {
  const stats = {
    found: 0,
    duplicateInRun: 0,
    duplicateUidInRun: 0,
    existingInDb: 0,
    unknownComments: 0,
    commentsFull: 0,
    hasSuperLike: 0,
    deleteQueued: 0,
    target: 0,
    inserted: 0,
    replaced: 0,
    checkpointReached: false,
    pageFullyAtOrBeforeCheckpoint: false,
    newestSeen: null
  };


  const posts =
    findPosts(
      json
    );


  stats.newestSeen =
    getNewestPostInfo(
      posts
    );


  /*
   * 第二重 checkpoint 时间兜底：
   * 只有“整页所有可识别帖子都有有效时间，并且全部 <= checkpoint 时间”
   * 才把本页视为旧页。任何一条时间缺失/解析失败/晚于 checkpoint，
   * 本页都不计入连续旧页，避免误停。
   */
  if (
    checkpoint
    && Number.isFinite(Number(checkpoint.latest_created_at_ms))
    && posts.length > 0
  ) {
    const checkpointMs = Number(checkpoint.latest_created_at_ms);
    let comparablePosts = 0;
    let allComparable = true;
    let allAtOrBefore = true;

    for (const post of posts) {
      const postId = getPostId(post);

      if (!postId) {
        continue;
      }

      const createdAtMs = parsePostCreatedAtMs(post);

      if (!Number.isFinite(Number(createdAtMs))) {
        allComparable = false;
        allAtOrBefore = false;
        break;
      }

      comparablePosts++;

      if (Number(createdAtMs) > checkpointMs) {
        allAtOrBefore = false;
        break;
      }
    }

    stats.pageFullyAtOrBeforeCheckpoint =
      comparablePosts > 0
      && allComparable
      && allAtOrBefore;
  }


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


    /*
     * 命中上一轮 checkpoint 时只做标记，不中断当前页。
     * 当前页剩余帖子仍全部处理，页处理完成后由外层停止翻页，
     * 防止同一页内部时间顺序不严格导致漏帖。
     */
    if (
      shouldStopAtCheckpoint(
        post,
        checkpoint
      )
    ) {
      if (!stats.checkpointReached) {
        console.log(
          `[SuperLike][Checkpoint] 本页发现上一轮 Post=${postId} time=${getPostCreatedAt(post) || '-'}；继续处理完整当前页。`
        );
      }

      stats.checkpointReached = true;
    }


    const uid =
      getUid(
        post
      );


    if (
      hasSuperLike(
        post
      )
    ) {
      stats.hasSuperLike++;

      if (uid) {
        if (!deleteUidSet.has(uid)) {
          stats.deleteQueued++;
        }

        deleteUidSet.add(uid);

        const userInserted =
          saveSuperLikeUser(monitorId, uid);

        console.log(
          userInserted
            ? `[SuperLike][SuperLike用户入库] UID=${uid} 已写入 superlike_users`
            : `[SuperLike][SuperLike用户已存在] UID=${uid} superlike_users 已有记录`
        );

        console.log(
          `[SuperLike][待删除] UID=${uid} feed Response发现 chao_like`
        );
      }

      continue;
    }


    /*
     * 每个用户只处理这一轮里遇到的第一条帖子。
     * sort_time 是从新到旧，所以第一条就是该用户本轮最新帖。
     */
    if (
      uid
      &&
      seenUidThisRun.has(
        uid
      )
    ) {
      stats.duplicateUidInRun++;
      continue;
    }


    if (uid) {
      seenUidThisRun.add(uid);
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


    if (!uid) {
      console.log(
        `[SuperLike][跳过] Post=${postId} 没有UID，不入库`
      );

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

      } else if (
        saved.status ===
        'replaced'
      ) {
        stats.replaced++;

        console.log(
          [
            '[SuperLike][更新UID最新帖]',
            `UID=${saved.uid || '-'}`,
            `用户=${saved.username || '-'}`,
            `评论=${saved.commentsCount}`,
            saved.postLink || '-'
          ].join(' | ')
        );

      } else if (
        saved.status ===
        'kept_existing'
      ) {
        stats.existingInDb++;
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
  monitor,
  deleteUidSet,
  forceLocal = false,
  proxyFailureCount = 0,
  local418FallbackError = null
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
	    'superlike-browser-profile-scan'
	  );

  let browser = null;
  let proxyAssignment = null;
  let delegatedToLocal = false;


  const startedAt =
    Date.now();


  const seenThisRun =
    new Set();

  const seenUidThisRun =
    new Set();

  const checkpoint =
    getScanCheckpoint(
      monitor.id
    );

  let newestThisRound =
    null;


  const total = {
    found: 0,
    duplicateInRun: 0,
    existingInDb: 0,
    unknownComments: 0,
    commentsFull: 0,
    hasSuperLike: 0,
    deleteQueued: 0,
    target: 0,
    inserted: 0,
    replaced: 0,
    duplicateUidInRun: 0
  };

  let pagesScanned =
    0;

  let stopReason =
    `达到最大 ${MAX_PAGES} 页`;

  /*
   * 只有确认本轮扫描边界是完整/安全的，才允许推进 checkpoint。
   *
   * 418、普通HTTP失败、异常中断：
   * 一律保留旧 checkpoint，避免下一轮跳过未扫描区间。
   */
  let checkpointSafeToAdvance =
    false;


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
      checkpoint
        ? `[SuperLike] 上次Checkpoint：${checkpoint.latest_created_at || '-'} / ${checkpoint.latest_post_id || '-'}`
        : '[SuperLike] 上次Checkpoint：无（首次运行）'
    );

    console.log(
      '=============================================='
    );


    proxyAssignment =
      forceLocal
        ? {
            configured: false,
            raw: null,
            proxy: null,
            masked: 'LOCAL'
          }
        : await SCAN_PROXY_POOL.acquire();

    if (
      proxyAssignment.allCoolingDown
    ) {
      const waitMinutes =
        Math.max(
          1,
          Math.ceil(
            (
              proxyAssignment.nextReadyAt
              - Date.now()
            )
            / 60000
          )
        );

      console.log(
        `[SuperLike] 找贴代理池全部处于418冷却中；最早约${waitMinutes}分钟后可用。`
      );

      if (
        local418FallbackError
      ) {
        throw local418FallbackError;
      }

      return;
    }

    const proxy =
      proxyAssignment.proxy;

    console.log(
      proxy
        ? `[SuperLike] 本轮优先使用健康代理：${proxyAssignment.masked}`
        : '[SuperLike] 当前轮使用本地IP'
    );

    browser =
      await chromium
        .launchPersistentContext(
          profileDir,
          {
            // 默认无窗口运行。
            // 如需临时显示浏览器窗口，可设置 SUPERLIKE_HEADLESS=0
            headless:
              process.env.SUPERLIKE_HEADLESS !== '0',

            ...(proxy ? { proxy } : {}),

            viewport: {
              width: 1280,
              height: 900
            }
          }
        );


    /*
     * Scanner 只需要 HTML / JS / XHR / fetch。
     * 图片、视频、字体都不参与帖子解析，直接拦截，减少网络请求和内存占用。
     */
    await browser.route(
      '**/*',
      async route => {
        const type =
          route.request()
            .resourceType();

        if (
          type === 'image'
          ||
          type === 'media'
          ||
          type === 'font'
        ) {
          await route.abort();
          return;
        }

        await route.continue();
      }
    );


    const page =
      browser.pages()[0]
      ||
      await browser.newPage();


    console.log(
      '[SuperLike] 打开真实超话首页...'
    );


    const homepageResponse =
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


    await assertPageNot418(
      page,
      homepageResponse
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


    if (feedResult?.http418) {
      throw new Weibo418Error('_feed 返回 HTTP 418');
    }


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


    /*
     * 后续分页始终以微博前端真实发出的第一页 sort_time 请求为模板。
     */
    const sortTimeRequestTemplateUrl =
      firstSortTimeResult.url;

    const sortTimeRequestTemplateHeaders =
      firstSortTimeResult.requestHeaders
      ||
      {};


    let current =
      firstSortTimeResult;

    // 第二重兜底：连续 3 个完整旧页才按时间边界停止。
    const CHECKPOINT_OLD_PAGE_THRESHOLD = 3;
    let consecutiveOldCheckpointPages = 0;


    for (
      let pageNumber = 1;
      pageNumber <= MAX_PAGES;
      pageNumber++
    ) {
      pagesScanned++;


      const pageStats =
        await processPagePosts(
          monitor.id,
          current.json,
          seenThisRun,
          seenUidThisRun,
          deleteUidSet,
          checkpoint
        );


      for (
        const key
        of Object.keys(total)
      ) {
        if (
          typeof pageStats[key]
          === 'number'
        ) {
          total[key] +=
            pageStats[key]
            || 0;
        }
      }


      if (
        pageStats.newestSeen
        &&
        (
          !newestThisRound
          ||
          pageStats.newestSeen.createdAtMs >
            newestThisRound.createdAtMs
        )
      ) {
        newestThisRound =
          pageStats.newestSeen;
      }


      console.log(
        [
          `[第${pageNumber}页]`,
          `Post=${pageStats.found}`,
          `同UID重复=${pageStats.duplicateUidInRun}`,
          `DB保留=${pageStats.existingInDb}`,
          `评论>=21=${pageStats.commentsFull}`,
          `SuperLike=${pageStats.hasSuperLike}`,
          `待删UID=${pageStats.deleteQueued}`,
          `新增=${pageStats.inserted}`,
          `更新UID=${pageStats.replaced}`
        ].join(' | ')
      );


      if (
        pageStats.checkpointReached
      ) {
        stopReason =
          '已找到上一轮 latest_post_id';

        console.log(
          '[SuperLike][Checkpoint] 第一重兜底命中：当前页已完整处理，停止请求下一页。'
        );

        checkpointSafeToAdvance =
          true;

        break;
      }


      if (checkpoint) {
        if (pageStats.pageFullyAtOrBeforeCheckpoint) {
          consecutiveOldCheckpointPages++;

          console.log(
            `[SuperLike][Checkpoint] 第二重兜底：第${pageNumber}页整页时间 <= checkpoint，连续旧页=${consecutiveOldCheckpointPages}/${CHECKPOINT_OLD_PAGE_THRESHOLD}`
          );
        } else {
          if (consecutiveOldCheckpointPages > 0) {
            console.log(
              `[SuperLike][Checkpoint] 第${pageNumber}页不满足整页旧时间条件，连续旧页计数 ${consecutiveOldCheckpointPages} -> 0`
            );
          }

          consecutiveOldCheckpointPages = 0;
        }

        if (
          consecutiveOldCheckpointPages >=
          CHECKPOINT_OLD_PAGE_THRESHOLD
        ) {
          stopReason =
            `未找到 latest_post_id，但连续 ${CHECKPOINT_OLD_PAGE_THRESHOLD} 个完整页面全部 <= checkpoint 时间`;

          console.log(
            `[SuperLike][Checkpoint] 第二重兜底命中：${stopReason}，停止请求下一页。`
          );

          checkpointSafeToAdvance =
            true;

          break;
        }
      }


      if (
        pageNumber >=
        MAX_PAGES
      ) {
        stopReason =
          `第三重兜底：达到最大 ${MAX_PAGES} 页`;

        /*
         * 首次运行没有旧 checkpoint，达到配置上限后可以建立新的 checkpoint。
         * 已有旧 checkpoint 时，如果只是撞到最大页数但仍没追到旧边界，
         * 说明中间可能还有未扫描数据，因此绝不能推进 checkpoint。
         */
        checkpointSafeToAdvance =
          !checkpoint;

        break;
      }


      /*
       * 下一页改为直接 AJAX：
       *
       * 从当前 sort_time JSON 的 moreInfo.params 读取
       * page / since_id / max_id，
       * 然后在已经打开的 weibo.com 页面上下文里直接 fetch。
       *
       * 不再滚动页面，不再触发图片/推荐/埋点等额外请求。
       */
      const nextParams =
        extractNextPageParams(
          current.json
        );


      if (!nextParams) {
        stopReason =
          `第${pageNumber}页没有下一页参数`;

        console.log(
          `[SuperLike] ${stopReason}`
        );

        checkpointSafeToAdvance =
          true;

        break;
      }


      const nextUrl =
        buildChaohuaUrl(
          sortTimeFlowId,
          nextParams,
          sortTimeRequestTemplateUrl
        );


      console.log(
        `[SuperLike] 直接请求下一页 sort_time：page=${nextParams.page}`
      );


      const nextResult =
        await fetchChaohuaInPage(
          page,
          nextUrl,
          sortTimeRequestTemplateHeaders
        );


      if (
        nextResult.httpStatus === 418
      ) {
        throw new Weibo418Error(
          'sort_time 下一页返回 HTTP 418'
        );
      }


      if (
        !nextResult.ok
      ) {
        stopReason =
          `sort_time 下一页 HTTP ${nextResult.httpStatus}`;

        console.log(
          `[SuperLike] ${stopReason}`
        );

        console.log(
          `[SuperLike][sort_time诊断] 模板URL=${sortTimeRequestTemplateUrl}`
        );

        console.log(
          `[SuperLike][sort_time诊断] 下一页URL=${nextUrl}`
        );

        console.log(
          `[SuperLike][sort_time诊断] Response=${nextResult.text || '-'}`
        );

        console.log(
          `[SuperLike][sort_time诊断] 模板Header=${Object.keys(
            sortTimeRequestTemplateHeaders
            ||
            {}
          ).join(',')}`
        );

        break;
      }


      current = {
        url:
          nextUrl,

        page:
          nextParams.page,

        json:
          nextResult.json
      };


      if (
        PAGE_DELAY_MS > 0
      ) {
        await page.waitForTimeout(
          PAGE_DELAY_MS
        );
      }
    }


  } catch (error) {
    stopReason =
      `异常：${error.message}`;

    if (
      isProxyConnectionError(error)
      &&
      proxyAssignment?.raw
      &&
      !forceLocal
    ) {
      SCAN_PROXY_POOL.remove(
        proxyAssignment.raw
      );

      console.log(
        `[SuperLike] 代理连接失败：${proxyAssignment.masked}`
      );

      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore
        }

        browser = null;
      }

      const nextFailureCount =
        proxyFailureCount + 1;

      delegatedToLocal =
        true;

      if (
        nextFailureCount < 5
      ) {
        console.log(
          `[SuperLike] 救援代理连接失败 ${nextFailureCount}/5，立即换下一个代理重试当前Monitor。`
        );

        return await scanOneSuperLikeMonitor(
          monitor,
          deleteUidSet,
          false,
          nextFailureCount,
          local418FallbackError
        );
      }

      console.log(
        '[SuperLike] 连续5个健康代理均连接失败，本轮切回本地IP。'
      );

      return await scanOneSuperLikeMonitor(
        monitor,
        deleteUidSet,
        true,
        nextFailureCount,
        local418FallbackError
      );
    }

    if (
      isWeibo418Error(error)
      &&
      forceLocal
    ) {
      console.log(
        '[SuperLike] 本地IP命中418。'
      );

      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore
        }

        browser = null;
      }

      throw error;
    }

    if (
      isWeibo418Error(error)
      &&
      proxyAssignment?.raw
      &&
      !forceLocal
    ) {
      SCAN_PROXY_POOL.markBlocked(
        proxyAssignment.raw
      );

      console.log(
        `[SuperLike] 救援代理也命中418，已进入冷却：${proxyAssignment.masked}`
      );

      console.log(
        '[SuperLike] 不再继续轮换代理，恢复本地418退避。'
      );

      if (
        local418FallbackError
      ) {
        throw local418FallbackError;
      }
    }

    throw error;

  } finally {
    if (browser) {
      try {
        await browser.close();

      } catch {
        // ignore
      }
    }


    /*
     * checkpoint 只在“本轮边界完整且安全”时推进。
     *
     * 特别注意：
     * 如果第N+1页418/失败，本轮前N页的数据仍然保留，
     * 但 checkpoint 不动；下一轮会从最新位置重新扫，
     * 直到重新追到旧 checkpoint，确保中间区间不会漏掉。
     */
    if (
      checkpointSafeToAdvance
      &&
      newestThisRound
    ) {
      try {
        saveScanCheckpoint(
          monitor.id,
          newestThisRound.postId,
          newestThisRound.createdAt,
          newestThisRound.createdAtMs
        );

        console.log(
          `[SuperLike][Checkpoint更新] ${newestThisRound.createdAt || '-'} / ${newestThisRound.postId}`
        );

      } catch (error) {
        console.error(
          '[SuperLike][Checkpoint更新失败]',
          error
        );
      }
    } else if (
      newestThisRound
      &&
      !checkpointSafeToAdvance
    ) {
      console.log(
        `[SuperLike][Checkpoint保留] 本轮未完整扫到安全边界，继续保留旧Checkpoint：${checkpoint?.latest_created_at || '-'} / ${checkpoint?.latest_post_id || '-'}`
      );
    }


    if (
      !delegatedToLocal
    ) {
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
      '评论>=21：',
      total.commentsFull
    );

    console.log(
      '已有SuperLike：',
      total.hasSuperLike
    );

    console.log(
      '本Monitor新增待删UID：',
      total.deleteQueued
    );

    console.log(
      '符合候选：',
      total.target
    );

    console.log(
      '同UID本轮重复：',
      total.duplicateUidInRun
    );

    console.log(
      '新增UID：',
      total.inserted
    );

    console.log(
      '更新UID最新帖：',
      total.replaced
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


    const deleteUidSet =
      new Set();

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
          monitor,
          deleteUidSet,
          false
        );

      } catch (error) {
        if (isWeibo418Error(error)) {
          throw error;
        }

        console.error(
          `[SuperLike] ${monitor.name} 扫描失败：`,
          error
        );
      }
    }


    console.log(
      `[SuperLike][轮询末尾清理] 本轮新确认 SuperLike UID=${deleteUidSet.size}；开始按 superlike_users 全表清理 superlike_posts...`
    );

    const deletedRows =
      cleanupSuperLikePostsByUsersTable();

    console.log(
      `[SuperLike][轮询末尾清理完成] 删除 superlike_posts 记录=${deletedRows}`
    );

  } finally {
    running = false;
  }
}


/* ============================================================
 * Batch
 * ============================================================ */

async function runSuperLikeRoundSafely(label = '本轮') {
  try {
    await scanSuperLikePosts();

    consecutive418 = 0;

    return {
      ok: true,
      rateLimited: false
    };

  } catch (error) {
    if (isWeibo418Error(error)) {
      /*
       * 使用代理池时：
       * 418只处罚当前代理，不处罚整个找贴脚本。
       * 下一轮按正常20/5分钟周期执行，并自动取下一个可用代理。
       */
      if (error.proxyPoolHandled) {
        consecutive418 = 0;

        console.error(
          `[SuperLike] ${label}命中 HTTP 418；当前代理已冷却。找贴脚本不做全局退避，下一轮按正常周期换下一个代理。`
        );

        return {
          ok: false,
          rateLimited: false,
          proxyRateLimited: true
        };
      }

      /*
       * 没有代理池/本地IP触发418时，仍保留原来的全局30/60分钟退避。
       */
      consecutive418++;

      console.error(
        `[SuperLike] ${label}命中微博 HTTP 418，本轮立即停止。连续418=${consecutive418}`
      );

      return {
        ok: false,
        rateLimited: true
      };
    }

    console.error(
      `[SuperLike] ${label}扫描失败，但 Batch 不会中断：`,
      error
    );

    return {
      ok: false,
      rateLimited: false
    };
  }
}


function getNormalScanIntervalMs() {
  const hour =
    new Date()
      .getHours();

  return hour >= 19
    ? NIGHT_SCAN_INTERVAL_MS
    : DAY_SCAN_INTERVAL_MS;
}


function getNextDelayMs(result) {
  if (!result?.rateLimited) {
    return getNormalScanIntervalMs();
  }

  return consecutive418 <= 1
    ? RATE_LIMIT_BACKOFF_1_MS
    : RATE_LIMIT_BACKOFF_2_MS;
}


async function startSuperLikeBatch() {
  try {
    initDatabase();
  } catch (error) {
    console.error(
      '[SuperLike] DB初始化失败，但 Batch 继续运行，下一轮会再次尝试：',
      error
    );
  }


  console.log('');
  console.log(
    '################################################'
  );

  console.log(
    '# SuperLike Batch'
  );

  console.log(
    `# 00:00-18:59：每 ${DAY_SCAN_INTERVAL_MS / 60000} 分钟`
  );

  console.log(
    `# 19:00-23:59：每 ${NIGHT_SCAN_INTERVAL_MS / 60000} 分钟`
  );

  console.log(
    `# HTTP 418退避：第一次 ${RATE_LIMIT_BACKOFF_1_MS / 60000} 分钟，连续418 ${RATE_LIMIT_BACKOFF_2_MS / 60000} 分钟`
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
    '# 命中上一轮 checkpoint（最新时间 + post_id）时结束'
  );

  console.log(
    '# 每个 monitor + UID 只保留一条最新帖子'
  );

  console.log(
    '# 评论<21 + feed无chao_like -> 入库（扫描过程不请求Profile）'
  );

  console.log(
    '# Ctrl+C 停止'
  );

  console.log(
    '################################################'
  );


  const scheduleNext = async (label) => {
    const result =
      await runSuperLikeRoundSafely(label);

    const delayMs =
      getNextDelayMs(result);

    console.log(
      `[SuperLike] 下一轮将在 ${Math.round(delayMs / 60000)} 分钟后开始。`
    );

    setTimeout(
      () => {
        console.log('');
        console.log(
          '[SuperLike] 到达下一轮时间，重新开始。'
        );

        void scheduleNext('定时');
      },
      delayMs
    );
  };


  await scheduleNext('首次');
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
  runSuperLikeRoundSafely,
  isWeibo418Error,
  assertPageNot418,
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
  getExistingSuperLikeUids,
  deleteSuperLikeUsersByUid: deletePostsByUidSet,
  parseTopicHomepage,
  parseChaohuaRequestUrl,
  clickPrimaryLatest,
  extractLatestPostFlowId,
  extractNextPageParams,
  buildChaohuaUrl,
  fetchChaohuaInPage,
  clickLatestPostTab,
  triggerNextPage,
  buildProfileInPageApiUrl,
  profileHasSuperLike,
  checkUserSuperLikeByProfile
};


if (
  require.main === module
) {
  startSuperLikeBatch()
    .catch(
      error => {
        /*
         * 最外层也不主动退出进程。
         * 正常扫描异常已经由 runSuperLikeRoundSafely() 吸收。
         */
        console.error(
          '[SuperLike] Batch主程序异常，但不主动退出：',
          error
        );
      }
    );
}

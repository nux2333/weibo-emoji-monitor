const { chromium } = require('playwright');

const {
  getMonitor,
  getMonitors,
  saveComments,
  saveApiResponse,
  saveDailyStats,
  updateMonitorStatus,
  updateLatestStatus,
  updateHistoryStatus,
  setHistoryNextPage,
  markHistoryCompleted,
  getInitialHistoryPage,
  getAllComments,
  getCommentIds
} = require('./db');

const { analyzeComments } = require('./emoji');

const {
  extractComments,
  normalizeCommentTime
} = require('./rebuild-comments');


const DEFAULT_PAGE_SIZE = 100;

// 成功页之间等待 0.5 秒
const PAGE_DELAY = 500;

// history 失败后 1 分钟重试当前页
const ERROR_RETRY_DELAY = 1 * 60 * 1000;

// 单次 API 请求超时 60 秒
const API_TIMEOUT = 60 * 1000;


/*
 * ============================================================
 * 运行锁
 * ============================================================
 *
 * 以前是：
 *
 * runningMonitors.add(monitorId)
 *
 * 那样同一个 monitor 只能跑一个任务。
 *
 * 现在改成：
 *
 * 1:latest
 * 1:history
 *
 * 所以：
 *
 * latest + history 可以同时运行
 *
 * 但：
 *
 * latest + latest
 * history + history
 *
 * 不允许重复启动。
 */

const runningJobs = new Set();


function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


/**
 * ============================================================
 * 日期
 * ============================================================
 */

function todayString() {

  const d =
    new Date();


  return (
    `${d.getFullYear()}-` +
    `${String(
      d.getMonth() + 1
    ).padStart(
      2,
      '0'
    )}-` +
    `${String(
      d.getDate()
    ).padStart(
      2,
      '0'
    )}`
  );
}


/**
 * ============================================================
 * JSON 配置
 * ============================================================
 */

function safeJsonArray(
  value
) {

  try {

    const parsed =
      JSON.parse(
        value || '[]'
      );


    return Array.isArray(
      parsed
    )
      ? parsed
      : [];

  } catch {

    return [];
  }
}


/**
 * ============================================================
 * 构造分页 URL
 * ============================================================
 *
 * 例如：
 *
 * page_num=1572
 * page_size=100
 */

function buildPageUrl(
  originalUrl,
  pageNum,
  pageSize
) {

  const u =
    new URL(
      originalUrl
    );


  u.searchParams.set(
    'page_num',
    String(
      pageNum
    )
  );


  u.searchParams.set(
    'page_size',
    String(
      pageSize
    )
  );


  return u.toString();
}


/**
 * ============================================================
 * 判断微博 API 是否真正成功
 * ============================================================
 *
 * HTTP 200 还不够。
 *
 * 微博自己的业务成功：
 *
 * code === 100000
 */

function isApiSuccess(
  data
) {

  return (
    data &&
    typeof data ===
      'object' &&
    Number(
      data.code
    ) === 100000
  );
}


/**
 * ============================================================
 * 获取 is_next
 * ============================================================
 *
 * 返回：
 *
 * true
 *   还有下一页
 *
 * false
 *   最后一页
 *
 * null
 *   response 没这个字段
 */

function getApiNextState(
  data
) {

  const value =

    data?.data?.data?.is_next ??

    data?.data?.is_next ??

    data?.is_next;


  if (
    value === undefined ||
    value === null
  ) {

    return null;
  }


  return Number(
    value
  ) === 1;
}


/**
 * ============================================================
 * 获取本页评论数量
 * ============================================================
 */

function getResultCount(
  data
) {

  return extractComments(
    data
  ).length;
}


/**
 * ============================================================
 * Comment ID
 * ============================================================
 */

function getCommentId(
  comment
) {

  const value =

    comment?.comment_id ??

    comment?.commentId ??

    comment?.id ??

    comment?.cid ??

    null;


  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {

    return null;
  }


  return String(
    value
  );
}


/**
 * ============================================================
 * 评论格式统一
 * ============================================================
 *
 * comment_time：
 *
 * 继续沿用 rebuild-comments.js
 * 里面现在的 normalizeCommentTime。
 *
 * 也就是说：
 *
 * 10 位秒时间戳
 *
 * 会转换成：
 *
 * 13 位毫秒时间戳
 */

function normalizeComment(
  comment
) {

  return {

    ...comment,


    comment_id:
      getCommentId(
        comment
      ),


    buyer_nickname:

      comment?.buyer_nickname ??

      comment?.buyerNickname ??

      comment?.username ??

      null,


    sku_name:

      comment?.sku_name ??

      comment?.skuName ??

      comment?.product ??

      null,


    content:

      String(

        comment?.content ??

        comment?.text ??

        ''
      ),


    comment_time:

      normalizeCommentTime(

        comment?.comment_time ??

        comment?.commentTime ??

        comment?.time ??

        null
      )
  };
}


function normalizeComments(
  data
) {

  return extractComments(
    data
  )

    .map(
      normalizeComment
    )

    .filter(
      comment =>
        Boolean(
          comment.comment_id
        )
    );
}


/**
 * ============================================================
 * 创建浏览器
 * ============================================================
 *
 * latest 和 history：
 *
 * 各自使用自己的 Chromium。
 *
 * 两个 batch 不共用 page，
 * 避免相互干扰。
 */

async function createBrowserPage(
  url
) {

  const browser =
    await chromium.launch({
      headless: true
    });


  const context =
    await browser.newContext({

      viewport: {
        width: 412,
        height: 915
      },


      userAgent:

        'Mozilla/5.0 (Linux; Android 15; Pixel 9) ' +

        'AppleWebKit/537.36 (KHTML, like Gecko) ' +

        'Chrome/151.0.0.0 Mobile Safari/537.36',


      isMobile: true,

      hasTouch: true,

      deviceScaleFactor: 2.625,

      locale: 'zh-CN'
    });


  const page =
    await context.newPage();


  await openOriginalPage(
    page,
    url
  );


  return {
    browser,
    context,
    page
  };
}


/**
 * ============================================================
 * 打开原始页面
 * ============================================================
 *
 * 主要目的是：
 *
 * 建立正确页面环境 / Cookie / Referer 环境。
 */

async function openOriginalPage(
  page,
  url
) {

  await page.goto(

    url,

    {

      waitUntil:
        'domcontentloaded',

      timeout:
        60000
    }
  );


  await page.waitForTimeout(
    2000
  );
}


/**
 * ============================================================
 * 请求 API 单页
 * ============================================================
 *
 * 这里只做两件事：
 *
 * 1.
 * 请求微博 API
 *
 * 2.
 * 保存 api_responses
 *
 *
 * crawlType：
 *
 * latest
 *
 * history
 *
 * legacy
 */

async function fetchCommentPage(
  page,
  originalUrl,
  monitorId,
  pageNum,
  pageSize = DEFAULT_PAGE_SIZE,
  crawlType = 'legacy'
) {

  const apiUrl =
    buildPageUrl(
      originalUrl,
      pageNum,
      pageSize
    );


  console.log('');

  console.log(
    `[${crawlType}] 请求第 ${pageNum} 页：${apiUrl}`
  );


  /*
   * 防止同一个异常被重复写 response。
   */

  let responseSaved =
    false;


  try {

    const result =
      await page.evaluate(

        async ({
          url,
          timeout
        }) => {

          const controller =
            new AbortController();


          const timer =
            setTimeout(

              () =>
                controller.abort(),

              timeout
            );


          try {

            const response =
              await fetch(

                url,

                {

                  method:
                    'GET',

                  credentials:
                    'include',

                  headers: {

                    Accept:
                      'application/json, text/plain, */*'
                  },

                  signal:
                    controller.signal
                }
              );


            const text =
              await response.text();


            let data;


            try {

              data =
                JSON.parse(
                  text
                );

            } catch (error) {

              return {

                ok: false,

                type:
                  'invalid_json',

                status:
                  response.status,

                responseText:
                  text,

                error:
                  `API 返回的不是 JSON：${text.slice(
                    0,
                    1000
                  )}`
              };
            }


            return {

              ok: true,

              status:
                response.status,

              data
            };


          } catch (error) {

            return {

              ok: false,

              type:

                error.name ===
                'AbortError'

                  ? 'timeout'

                  : 'network',


              status:
                null,


              responseText:
                null,


              error:

                error.message ||

                String(
                  error
                )
            };


          } finally {

            clearTimeout(
              timer
            );
          }
        },


        {
          url:
            apiUrl,

          timeout:
            API_TIMEOUT
        }
      );


    /**
     * ========================================================
     * fetch 本身成功
     * ========================================================
     */

    if (
      result.ok
    ) {


      /*
       * HTTP 状态失败
       */

      if (
        result.status < 200 ||
        result.status >= 300
      ) {

        const errorMessage =
          `HTTP 状态异常：${result.status}`;


        saveApiResponse({

          monitorId,

          pageNum,

          apiUrl,

          httpStatus:
            result.status,

          responseData:
            result.data,

          errorMessage,

          crawlType
        });


        responseSaved =
          true;


        throw new Error(
          errorMessage
        );
      }


      /*
       * HTTP 200，
       * 但是微博业务 code 不成功。
       */

      if (
        !isApiSuccess(
          result.data
        )
      ) {

        const errorMessage =

          `微博 API 业务失败，code=${

            result.data?.code ??

            'unknown'

          }`;


        saveApiResponse({

          monitorId,

          pageNum,

          apiUrl,

          httpStatus:
            result.status,

          responseData:
            result.data,

          errorMessage,

          crawlType
        });


        responseSaved =
          true;


        throw new Error(
          errorMessage
        );
      }


      /*
       * 真正成功。
       */

      saveApiResponse({

        monitorId,

        pageNum,

        apiUrl,

        httpStatus:
          result.status,

        responseData:
          result.data,

        errorMessage:
          null,

        crawlType
      });


      responseSaved =
        true;


      return result.data;
    }


    /**
     * ========================================================
     * fetch 失败
     * ========================================================
     */

    let errorMessage =

      result.error ||

      '未知 API 错误';


    if (
      result.type ===
      'timeout'
    ) {

      errorMessage =
        `API 请求超时（${API_TIMEOUT / 1000} 秒）`;


    } else if (
      result.type ===
      'network'
    ) {

      errorMessage =
        `网络请求失败：${errorMessage}`;
    }


    let responseData =
      null;


    if (
      result.responseText !== null &&
      result.responseText !== undefined
    ) {

      responseData = {

        raw_response:
          result.responseText
      };
    }


    saveApiResponse({

      monitorId,

      pageNum,

      apiUrl,

      httpStatus:
        result.status,

      responseData,

      errorMessage,

      crawlType
    });


    responseSaved =
      true;


    throw new Error(
      errorMessage
    );


  } catch (error) {

    /*
     * 如果异常发生在：
     *
     * page.evaluate
     * Playwright
     * browser context
     *
     * 而之前还没写 response，
     * 这里补一条错误 response。
     */

    if (
      !responseSaved
    ) {

      const errorMessage =

        error.message ||

        String(
          error
        );


      saveApiResponse({

        monitorId,

        pageNum,

        apiUrl,

        httpStatus:
          null,

        responseData:
          null,

        errorMessage:
          `Playwright/API 异常：${errorMessage}`,

        crawlType
      });
    }


    throw error;
  }
}


/**
 * ============================================================
 * 更新统计
 * ============================================================
 *
 * 注意：
 *
 * 新版 getAllComments(monitorId)
 * 已经真正按照 monitor_id 过滤。
 *
 * 多个 Monitor 不会串数据。
 */

function updateStats(
  monitorId
) {

  const monitor =
    getMonitor(
      monitorId
    );


  if (!monitor) {

    return null;
  }


  const emojis =
    safeJsonArray(
      monitor.emojis
    );


  const texts =
    safeJsonArray(
      monitor.texts
    );


  const allComments =
    getAllComments(
      monitorId
    );


  const stats =
    analyzeComments(

      allComments.map(

        comment => ({

          content:
            comment.content
        })
      ),

      emojis,

      texts
    );


  saveDailyStats(

    monitorId,

    {

      statDate:
        todayString(),

      ...stats
    }
  );


  return stats;
}


/**
 * ============================================================
 * Latest Batch
 * ============================================================
 *
 * 用途：
 *
 * 抓“最新新增评论”。
 *
 *
 * 每次运行：
 *
 * page 1
 * ↓
 * page 2
 * ↓
 * page 3
 * ↓
 *
 * 一旦发现某一整页的 comment_id
 * 在本轮启动前已经全部存在：
 *
 * STOP
 *
 *
 * 注意：
 *
 * existingAtStart 是
 * “本轮启动之前”的数据库快照。
 *
 * 这一点非常重要。
 *
 * 不然：
 *
 * page 1 新增评论保存以后，
 * 如果拿实时 DB 判断，
 * 后面可能把本轮刚插入的数据误认为旧数据。
 */

async function runLatestBatch(
  monitorId
) {

  const jobKey =
    `${monitorId}:latest`;


  /**
   * 防止 Latest 重复启动
   */

  if (
    runningJobs.has(
      jobKey
    )
  ) {

    console.log(
      `[latest] Monitor ${monitorId} 已经在运行`
    );


    return {

      skipped:
        true,

      reason:
        'already_running'
    };
  }


  const monitor =
    getMonitor(
      monitorId
    );


  if (!monitor) {

    throw new Error(
      `Monitor ${monitorId} 不存在`
    );
  }


  if (
    !monitor.enabled
  ) {

    console.log(
      `[latest] Monitor ${monitorId} 已停用`
    );


    return {

      skipped:
        true,

      reason:
        'disabled'
    };
  }


  runningJobs.add(
    jobKey
  );


  let browser =
    null;


  try {

    updateLatestStatus(
      monitorId,
      'running'
    );


    console.log('');

    console.log(
      `========== Latest Batch ${monitorId} ==========`
    );

    console.log(
      `名称：${monitor.name}`
    );

    console.log(
      '从第 1 页开始抓最新数据'
    );


    /**
     * ========================================================
     * 本轮开始前已有 ID 快照
     * ========================================================
     */

    const existingAtStart =
      getCommentIds(
        monitorId
      );


    console.log(
      `[latest] 本轮开始前数据库已有 ${existingAtStart.size} 个 comment_id`
    );


    /**
     * Browser
     */

    const session =
      await createBrowserPage(
        monitor.url
      );


    browser =
      session.browser;


    const page =
      session.page;


    let pageNum =
      1;


    let successPages =
      0;


    let newCommentCount =
      0;


    /**
     * ========================================================
     * Latest 循环
     * ========================================================
     */

    while (true) {


      /**
       * Latest 如果失败：
       *
       * 本次直接结束。
       *
       * 不像 History 那样无限 retry。
       *
       * 因为 Latest 之后每天还会自动再跑。
       */

      const data =
        await fetchCommentPage(

          page,

          monitor.url,

          monitorId,

          pageNum,

          DEFAULT_PAGE_SIZE,

          'latest'
        );


      successPages++;


      const comments =
        normalizeComments(
          data
        );


      /**
       * ======================================================
       * 只判断：
       *
       * 本轮启动前数据库是否存在
       * ======================================================
       */

      const newComments =
        comments.filter(

          comment =>

            !existingAtStart.has(

              String(
                comment.comment_id
              )
            )
        );


      console.log(
        `[latest] 第 ${pageNum} 页成功：result=${comments.length}，本轮开始前未存在=${newComments.length}`
      );


      /**
       * ======================================================
       * Latest 核心停止条件
       * ======================================================
       *
       * 当前这一页有评论，
       *
       * 并且：
       *
       * newComments.length === 0
       *
       * 说明整页都已经是数据库已有旧数据。
       *
       * 到这里停止。
       */

      if (
        comments.length > 0 &&
        newComments.length === 0
      ) {

        console.log(
          `[latest] 第 ${pageNum} 页全部 comment_id 已存在，停止 Latest。`
        );


        break;
      }


      /**
       * ======================================================
       * 保存新增 Comment
       * ======================================================
       */

      if (
        newComments.length > 0
      ) {

        saveComments(

          monitorId,

          newComments
        );


        newCommentCount +=
          newComments.length;
      }


      /**
       * ======================================================
       * 是否还有下一页
       * ======================================================
       */

      const hasNext =
        getApiNextState(
          data
        );


      if (
        hasNext === false
      ) {

        console.log(
          `[latest] 第 ${pageNum} 页 is_next=0，停止。`
        );


        break;
      }


      /**
       * 有些 response 可能没 is_next。
       *
       * 这时候：
       *
       * result=0
       *
       * 也认为没有下一页。
       */

      if (
        hasNext === null &&
        comments.length === 0
      ) {

        console.log(
          '[latest] 没有 is_next 且 result=0，停止。'
        );


        break;
      }


      pageNum++;


      if (
        PAGE_DELAY > 0
      ) {

        await sleep(
          PAGE_DELAY
        );
      }
    }


    /**
     * ========================================================
     * Latest 成功结束
     * ========================================================
     */

    const stats =
      updateStats(
        monitorId
      );


    updateLatestStatus(
      monitorId,
      'success'
    );


    console.log('');

    console.log(
      `[latest] 完成：成功页 ${successPages}，发现新评论 ${newCommentCount}`
    );


    return {

      successPages,

      newCommentCount,

      totalComments:
        stats?.totalComments ??
        null
    };


  } catch (error) {

    updateLatestStatus(
      monitorId,
      'error'
    );


    console.error(
      `[latest] Monitor ${monitorId} 失败：${error.message}`
    );


    throw error;


  } finally {

    if (
      browser
    ) {

      try {

        await browser.close();

      } catch {

        // ignore
      }
    }


    runningJobs.delete(
      jobKey
    );
  }
}


/**
 * ============================================================
 * History Batch
 * ============================================================
 *
 * 用途：
 *
 * 继续补历史数据。
 *
 *
 * 例如：
 *
 * history_next_page = 1572
 *
 *
 * 那么：
 *
 * 1572
 * ↓
 * 成功
 * ↓
 * history_next_page = 1573
 *
 *
 * 1573
 * ↓
 * 成功
 * ↓
 * history_next_page = 1574
 *
 *
 * 1574
 * ↓
 * 失败
 * ↓
 * history_next_page 仍然是 1574
 *
 *
 * 1 分钟后：
 *
 * 继续重试 1574
 */

async function runHistoryBatch(
  monitorId
) {

  const jobKey =
    `${monitorId}:history`;


  /**
   * History 重复启动保护
   */

  if (
    runningJobs.has(
      jobKey
    )
  ) {

    console.log(
      `[history] Monitor ${monitorId} 已经在运行`
    );


    return {

      skipped:
        true,

      reason:
        'already_running'
    };
  }


  let monitor =
    getMonitor(
      monitorId
    );


  if (!monitor) {

    throw new Error(
      `Monitor ${monitorId} 不存在`
    );
  }


  if (
    !monitor.enabled
  ) {

    console.log(
      `[history] Monitor ${monitorId} 已停用`
    );


    return {

      skipped:
        true,

      reason:
        'disabled'
    };
  }


  /**
   * 历史已经全部完成，
   * 就不再启动。
   */

  if (
    Number(
      monitor.history_completed
    ) === 1
  ) {

    console.log(
      `[history] Monitor ${monitorId} 历史数据已经补全，跳过。`
    );


    return {

      skipped:
        true,

      reason:
        'completed'
    };
  }


  runningJobs.add(
    jobKey
  );


  let browser =
    null;


  try {

    updateHistoryStatus(
      monitorId,
      'running'
    );


    /**
     * ========================================================
     * 获取真正的 History 断点
     * ========================================================
     *
     * 新数据库：
     *
     * 直接拿 history_next_page
     *
     *
     * 旧数据库第一次升级：
     *
     * 从 legacy response 的最大成功页 + 1 推导。
     */

    let pageNum =
      getInitialHistoryPage(
        monitorId
      );


    console.log('');

    console.log(
      `========== History Batch ${monitorId} ==========`
    );


    console.log(
      `名称：${monitor.name}`
    );


    console.log(
      `[history] 从第 ${pageNum} 页继续`
    );


    /**
     * Browser
     */

    const session =
      await createBrowserPage(
        monitor.url
      );


    browser =
      session.browser;


    let page =
      session.page;


    let successPages =
      0;


    let processedComments =
      0;


    /**
     * ========================================================
     * History 主循环
     * ========================================================
     */

    while (true) {


      let data;


      /**
       * ======================================================
       * 当前页 Retry Loop
       * ======================================================
       *
       * 注意：
       *
       * 失败时 pageNum 不变。
       *
       * 所以永远不会跳过失败页。
       */

      while (true) {

        try {

          data =
            await fetchCommentPage(

              page,

              monitor.url,

              monitorId,

              pageNum,

              DEFAULT_PAGE_SIZE,

              'history'
            );


          /*
           * 当前页真正成功。
           */

          break;


        } catch (error) {


          updateHistoryStatus(
            monitorId,
            'error'
          );


          console.error('');

          console.error(
            `[history] 第 ${pageNum} 页失败：${error.message}`
          );


          console.error(
            `[history] ${ERROR_RETRY_DELAY / 60000} 分钟后继续重试第 ${pageNum} 页`
          );


          /**
           * 等待 1 分钟
           */

          await sleep(
            ERROR_RETRY_DELAY
          );


          /**
           * 重新打开商品页面。
           *
           * 你之前遇到过：
           *
           * 连续请求失败，
           * 重新启动以后又能成功几条。
           *
           * 所以 Retry 时重新 page.goto 一次，
           * 相当于刷新页面环境。
           */

          try {

            await openOriginalPage(
              page,
              monitor.url
            );


          } catch (openError) {

            console.error(
              `[history] 重新打开原页面失败：${openError.message}`
            );
          }


          updateHistoryStatus(
            monitorId,
            'running'
          );
        }
      }


      /**
       * ======================================================
       * 当前页成功
       * ======================================================
       */

      successPages++;


      const comments =
        normalizeComments(
          data
        );


      console.log(
        `[history] 第 ${pageNum} 页成功：result=${comments.length}`
      );


      /**
       * ======================================================
       * 保存 Comments
       * ======================================================
       *
       * 即使 Latest 已经抓到同样 comment_id：
       *
       * comments 表有：
       *
       * UNIQUE(monitor_id, comment_id)
       *
       * saveComments 会走 UPSERT，
       *
       * 所以不会重复。
       */

      if (
        comments.length > 0
      ) {

        saveComments(

          monitorId,

          comments
        );


        processedComments +=
          comments.length;
      }


      /**
       * ======================================================
       * 下一页状态
       * ======================================================
       */

      const hasNext =
        getApiNextState(
          data
        );


      /**
       * ======================================================
       * ★只有当前页真正成功以后
       * 才移动 History 断点
       * ======================================================
       *
       * page 1572 成功：
       *
       * history_next_page = 1573
       */

      setHistoryNextPage(

        monitorId,

        pageNum + 1
      );


      /**
       * ======================================================
       * 已经最后一页
       * ======================================================
       */

      if (
        hasNext === false
      ) {

        console.log(
          `[history] 第 ${pageNum} 页 is_next=0，历史补全完成。`
        );


        markHistoryCompleted(
          monitorId
        );


        break;
      }


      /**
       * response 没 is_next，
       * 但已经 0 条。
       */

      if (
        hasNext === null &&
        comments.length === 0
      ) {

        console.log(
          '[history] 没有 is_next 且 result=0，历史补全完成。'
        );


        markHistoryCompleted(
          monitorId
        );


        break;
      }


      /**
       * 真正进入下一页
       */

      pageNum++;


      if (
        PAGE_DELAY > 0
      ) {

        await sleep(
          PAGE_DELAY
        );
      }
    }


    /**
     * ========================================================
     * History 完成
     * ========================================================
     */

    const stats =
      updateStats(
        monitorId
      );


    updateHistoryStatus(
      monitorId,
      'success'
    );


    console.log('');

    console.log(
      `[history] 完成：成功页 ${successPages}，处理评论 ${processedComments}`
    );


    return {

      successPages,

      processedComments,

      totalComments:
        stats?.totalComments ??
        null
    };


  } catch (error) {

    updateHistoryStatus(
      monitorId,
      'error'
    );


    console.error(
      `[history] Monitor ${monitorId} 失败：${error.message}`
    );


    throw error;


  } finally {

    if (
      browser
    ) {

      try {

        await browser.close();

      } catch {

        // ignore
      }
    }


    runningJobs.delete(
      jobKey
    );
  }
}


/**
 * ============================================================
 * Run Monitor
 * ============================================================
 *
 * 一个 Monitor：
 *
 * 同时启动：
 *
 * Latest
 *
 * +
 *
 * History
 *
 *
 * Promise.allSettled：
 *
 * 两个互相不影响。
 *
 * 一个失败，
 * 另一个还可以继续运行。
 */

async function runMonitor(
  monitorId
) {

  const monitor =
    getMonitor(
      monitorId
    );


  if (!monitor) {

    throw new Error(
      `Monitor ${monitorId} 不存在`
    );
  }


  if (
    !monitor.enabled
  ) {

    console.log(
      `Monitor ${monitorId} 已停用`
    );


    return [];
  }


  updateMonitorStatus(
    monitorId,
    'running'
  );


  console.log('');

  console.log(
    `========== 启动 Monitor ${monitorId}：Latest + History ==========`
  );


  /**
   * ==========================================================
   * 真正并行
   * ==========================================================
   */

  const results =
    await Promise.allSettled([

      runLatestBatch(
        monitorId
      ),

      runHistoryBatch(
        monitorId
      )
    ]);


  const rejected =
    results.filter(

      result =>
        result.status ===
        'rejected'
    );


  if (
    rejected.length === 0
  ) {

    updateMonitorStatus(
      monitorId,
      'success'
    );


  } else {

    updateMonitorStatus(
      monitorId,
      'error'
    );
  }


  return results;
}


/**
 * ============================================================
 * Server 启动时执行
 * ============================================================
 *
 * 这里有一个特别重要的地方。
 *
 *
 * 你现在 server.js 大概率是：
 *
 * await runAllMonitors();
 *
 * startScheduler();
 *
 *
 * 但是 History 可能：
 *
 * 跑几个小时
 *
 * 或者失败后一直 retry。
 *
 *
 * 如果这里 await 所有 History：
 *
 * startScheduler 永远不会执行。
 *
 *
 * 所以：
 *
 * runAllMonitors()
 *
 * 只负责“启动”所有 Monitor，
 *
 * 然后立刻 return。
 */

async function runAllMonitors() {

  const monitors =
    getMonitors(
      true
    );


  console.log(
    `当前共有 ${monitors.length} 个启用监控`
  );


  for (
    const monitor of monitors
  ) {

    runMonitor(
      monitor.id
    ).catch(

      error =>
        console.error(
          `Monitor ${monitor.id} failed：${error.message}`
        )
    );
  }


  return {

    started:
      monitors.length
  };
}


/**
 * ============================================================
 * 每日 Latest
 * ============================================================
 *
 * Scheduler 只运行 Latest。
 *
 * 不会每天重新触发 History。
 */

async function runAllLatestMonitors() {

  const monitors =
    getMonitors(
      true
    );


  console.log(
    `开始执行 ${monitors.length} 个 Latest Batch`
  );


  const results =
    await Promise.allSettled(

      monitors.map(

        monitor =>
          runLatestBatch(
            monitor.id
          )
      )
    );


  for (
    let i = 0;
    i < results.length;
    i++
  ) {

    if (
      results[i].status ===
      'rejected'
    ) {

      console.error(
        `Latest ${monitors[i].id} failed：${

          results[i].reason?.message ||

          results[i].reason

        }`
      );
    }
  }


  return results;
}


/**
 * ============================================================
 * 获取下一次 06:00
 * ============================================================
 */

function getNextSixAM() {

  const now =
    new Date();


  const next =
    new Date(
      now
    );


  next.setHours(
    6,
    0,
    0,
    0
  );


  if (
    next <= now
  ) {

    next.setDate(
      next.getDate() + 1
    );
  }


  return next;
}


/**
 * ============================================================
 * Scheduler
 * ============================================================
 *
 * 每天 06:00：
 *
 * 只执行 Latest。
 */

function startScheduler() {

  const schedule =
    () => {


      const next =
        getNextSixAM();


      const delay =
        next.getTime() -
        Date.now();


      console.log(
        `下一次自动 Latest 抓取：${next.toLocaleString()}`
      );


      setTimeout(

        async () => {

          try {

            await runAllLatestMonitors();


          } catch (error) {

            console.error(
              `定时 Latest 抓取失败：${error.message}`
            );


          } finally {

            schedule();
          }

        },

        delay
      );
    };


  schedule();
}


/**
 * ============================================================
 * 旧接口兼容：getResumeState
 * ============================================================
 *
 * 以前 monitor.js 有这个概念：
 *
 * last response
 *
 * →
 *
 * 推断下一页。
 *
 *
 * 新版 History 已经不这么做了。
 *
 * 真正断点：
 *
 * monitors.history_next_page
 *
 *
 * 但为了防止其他旧代码 require 这个函数报错，
 * 这里继续保留。
 */

function getResumeState(
  monitor
) {

  if (
    !monitor
  ) {

    return {

      startPage:
        1,

      responsesAlreadyComplete:
        false,

      reason:
        'monitor 不存在'
    };
  }


  if (
    Number(
      monitor.history_completed
    ) === 1
  ) {

    return {

      startPage:

        Number(
          monitor.history_next_page
        ) || 1,


      responsesAlreadyComplete:
        true,


      reason:
        'history 已完成'
    };
  }


  const startPage =
    getInitialHistoryPage(
      monitor.id
    );


  return {

    startPage,


    responsesAlreadyComplete:
      false,


    reason:
      `history 从第 ${startPage} 页继续`
  };
}


/**
 * ============================================================
 * 旧接口兼容：fetchAllResponses
 * ============================================================
 *
 * 如果其他脚本还直接调用：
 *
 * fetchAllResponses(...)
 *
 * 就转到新版 History Batch。
 */

async function fetchAllResponses(
  url,
  monitorId,
  startPage = null
) {

  const monitor =
    getMonitor(
      monitorId
    );


  if (!monitor) {

    throw new Error(
      `Monitor ${monitorId} 不存在`
    );
  }


  /**
   * 如果旧调用明确传了 startPage，
   * 就把它设置成 History 断点。
   */

  if (
    startPage !== null &&
    startPage !== undefined
  ) {

    setHistoryNextPage(

      monitorId,

      Number(
        startPage
      )
    );
  }


  return runHistoryBatch(
    monitorId
  );
}


/**
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {

  /*
   * 主入口
   */

  runMonitor,

  runAllMonitors,

  runAllLatestMonitors,


  /*
   * 两个 Batch
   */

  runLatestBatch,

  runHistoryBatch,


  /*
   * Scheduler
   */

  startScheduler,


  /*
   * 工具 / 兼容接口
   */

  buildPageUrl,

  getResumeState,

  fetchCommentPage,

  fetchAllResponses,

  getApiNextState,

  getResultCount
};
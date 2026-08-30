const { chromium } = require('playwright');

const {
  db,
  getMonitor,
  getMonitors,
  saveApiResponse,
  saveDailyStats,
  updateMonitorStatus,
  getAllComments
} = require('./db');

const { analyzeComments } = require('./emoji');
const { rebuildComments } = require('./rebuild-comments');

const DEFAULT_PAGE_SIZE = 100;

// 成功页之间等待
const PAGE_DELAY = 500;

// 失败后等待 3 分钟，继续重试同一页
const ERROR_RETRY_DELAY = 3 * 60 * 1000;

// 单次 API 超时
const API_TIMEOUT = 60 * 1000;

const runningMonitors = new Set();


function todayString() {
  const d = new Date();

  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}


/**
 * 构造分页 URL
 */
function buildPageUrl(originalUrl, pageNum, pageSize) {
  const u = new URL(originalUrl);

  u.searchParams.set('page_num', String(pageNum));
  u.searchParams.set('page_size', String(pageSize));

  return u.toString();
}


/**
 * 判断是否还有下一页
 *
 * 微博当前：
 *
 * data.is_next = 1  有下一页
 * data.is_next = 0  没下一页
 */
function getApiNextState(data) {
  const value =
    data?.data?.is_next ??
    data?.is_next;

  if (value === undefined || value === null) {
    return null;
  }

  return Number(value) === 1;
}


/**
 * 获取当前 response 的评论条数。
 *
 * 注意：
 * 这里只用于日志。
 *
 * monitor.js 不再解析并保存 comments。
 */
function getResultCount(data) {
  if (Array.isArray(data?.data?.result)) {
    return data.data.result.length;
  }

  if (Array.isArray(data?.result)) {
    return data.result.length;
  }

  return 0;
}


/**
 * 微博业务是否成功
 *
 * 正常：
 *
 * {
 *   "code": 100000,
 *   "msg": "success"
 * }
 */
function isApiSuccess(data) {
  if (!data || typeof data !== 'object') {
    return false;
  }

  return Number(data.code) === 100000;
}


/**
 * 查询最近一次 api_response
 */
function getLatestResponse(monitorId) {
  return db.prepare(`
    SELECT
      id,
      monitor_id,
      page_num,
      api_url,
      http_status,
      response_json,
      error_message,
      created_at
    FROM api_responses
    WHERE monitor_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(monitorId);
}


/**
 * 判断启动时从第几页开始。
 *
 *
 * 情况1：
 *
 * 上一次完整运行 success
 *
 * => 新的一轮监控
 * => 从 page 1 开始
 *
 *
 * 情况2：
 *
 * 程序运行中被关闭
 * monitor.last_status = running
 *
 * 最新 response 是失败的：
 *
 * page 7 error
 *
 * => 从 page 7 重试
 *
 *
 * 情况3：
 *
 * page 6 保存成功以后程序突然关闭，
 * 还没来得及请求 page 7
 *
 * => 从 page 7 开始
 */
function getStartPage(monitor) {

  /**
   * 上一轮完整成功。
   *
   * 这是新的一轮抓取。
   */
  if (monitor.last_status === 'success') {
    console.log('上一轮抓取已经完整成功，本次从第 1 页开始。');

    return 1;
  }


  const latest =
    getLatestResponse(monitor.id);


  /**
   * 从来没有 response。
   */
  if (!latest) {
    console.log('没有历史 response，从第 1 页开始。');

    return 1;
  }


  const hasError =
    latest.error_message !== null &&
    String(latest.error_message).trim() !== '';


  /**
   * ★ 最后一页失败
   *
   * page 7 ERROR
   *
   * => 继续 page 7
   */
  if (hasError) {

    console.log(
      `检测到最后一次请求失败：第 ${latest.page_num} 页`
    );

    console.log(
      `本次重新请求第 ${latest.page_num} 页。`
    );

    return Number(latest.page_num);
  }


  /**
   * 最后一页成功，但程序中途停止。
   *
   * page 6 SUCCESS
   *
   * => page 7
   */
  const nextPage =
    Number(latest.page_num) + 1;


  console.log(
    `最后一次成功请求：第 ${latest.page_num} 页`
  );

  console.log(
    `本次从第 ${nextPage} 页继续。`
  );


  return nextPage;
}


/**
 * 请求单页。
 *
 * ★这里只做两件事：
 *
 * 1. 请求 API
 * 2. 保存 api_responses
 *
 * 完全不写 comments。
 */
async function fetchCommentPage(
  page,
  originalUrl,
  monitorId,
  pageNum,
  pageSize
) {

  const apiUrl =
    buildPageUrl(
      originalUrl,
      pageNum,
      pageSize
    );


  console.log('');
  console.log(
    `请求第 ${pageNum} 页：${apiUrl}`
  );


  let responseSaved = false;


  try {

    const result =
      await page.evaluate(

        async ({ url, timeout }) => {

          const controller =
            new AbortController();


          const timer =
            setTimeout(
              () => controller.abort(),
              timeout
            );


          try {

            const response =
              await fetch(
                url,
                {
                  method: 'GET',

                  credentials: 'include',

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
                JSON.parse(text);

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
                  `API 返回的不是 JSON：${text.slice(0, 1000)}`
              };
            }


            return {
              ok: true,
              status: response.status,
              data
            };


          } catch (error) {

            return {
              ok: false,

              type:
                error.name === 'AbortError'
                  ? 'timeout'
                  : 'network',

              status:
                null,

              responseText:
                null,

              error:
                error.message ||
                String(error)
            };


          } finally {

            clearTimeout(timer);
          }

        },

        {
          url: apiUrl,
          timeout: API_TIMEOUT
        }
      );


    /**
     * =====================================
     * fetch 本身成功
     * =====================================
     */
    if (result.ok) {


      /**
       * HTTP 非 2xx
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

          errorMessage
        });


        responseSaved = true;


        throw new Error(
          errorMessage
        );
      }


      /**
       * =====================================
       *
       * ★ 微博业务失败
       *
       * HTTP可能还是200，
       * 但是：
       *
       * code != 100000
       *
       * =====================================
       */
      if (!isApiSuccess(result.data)) {


        /**
         * 你要求：
         *
         * response_json：
         * 保存完整 response
         *
         * error_message：
         * 也保存完整 response JSON
         */
        let errorResponseJson;


        try {

          errorResponseJson =
            JSON.stringify(result.data);

        } catch (error) {

          errorResponseJson =
            String(result.data);
        }


        saveApiResponse({
          monitorId,
          pageNum,
          apiUrl,

          httpStatus:
            result.status,

          responseData:
            result.data,

          errorMessage:
            errorResponseJson
        });


        responseSaved = true;


        throw new Error(
          `微博 API 业务错误：${errorResponseJson}`
        );
      }


      /**
       * =====================================
       *
       * ★ 真正成功
       *
       * HTTP成功
       * code === 100000
       *
       * =====================================
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
          null
      });


      responseSaved = true;


      return result.data;
    }


    /**
     * =====================================
     * fetch 本身失败
     * =====================================
     */

    let errorMessage =
      result.error ||
      '未知 API 错误';


    if (result.type === 'timeout') {

      errorMessage =
        `API 请求超时（${API_TIMEOUT / 1000} 秒）`;

    } else if (result.type === 'network') {

      errorMessage =
        `网络请求失败：${errorMessage}`;
    }


    let responseData = null;


    if (result.responseText != null) {

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

      errorMessage
    });


    responseSaved = true;


    throw new Error(
      errorMessage
    );


  } catch (error) {


    /**
     * 如果前面还没有保存 response，
     * 说明可能是 Playwright 本身异常。
     */
    if (!responseSaved) {

      const message =
        error.message ||
        String(error);


      saveApiResponse({
        monitorId,
        pageNum,
        apiUrl,

        httpStatus:
          null,

        responseData:
          null,

        errorMessage:
          `Playwright/API 异常：${message}`
      });
    }


    throw error;
  }
}


/**
 * 抓取全部 response
 *
 * ★核心规则：
 *
 * 失败：
 * pageNum 不增加
 *
 * 成功：
 * 才允许 pageNum++
 *
 *
 * monitor.js 完全不写 comments。
 */
async function fetchAllResponses(
  url,
  monitorId,
  startPage
) {

  const browser =
    await chromium.launch({
      headless: true
    });


  const page =
    await browser.newPage({

      viewport: {
        width: 390,
        height: 844
      },

      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
        'Version/17.0 Mobile/15E148 Safari/604.1'
    });


  let pageNum =
    startPage;


  let successPages = 0;


  try {

    console.log('');
    console.log('================================');
    console.log(`开始抓取：${url}`);
    console.log(`开始页：${pageNum}`);
    console.log('抓取阶段只保存 api_responses。');
    console.log('comments 将在全部抓取结束后统一解析。');
    console.log('================================');


    /**
     * 先打开页面。
     *
     * 用于获得 Cookie / 浏览器环境。
     */
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


    while (true) {


      let data;


      /**
       * =====================================
       *
       * 当前页 retry loop
       *
       * =====================================
       *
       * 只有成功才能离开。
       *
       * 所以：
       *
       * page 7失败
       * ↓
       * page 7
       * ↓
       * page 7
       * ↓
       * 成功
       * ↓
       * page 8
       */
      while (true) {

        try {

          data =
            await fetchCommentPage(
              page,
              url,
              monitorId,
              pageNum,
              DEFAULT_PAGE_SIZE
            );


          /**
           * ★成功
           *
           * 才能跳出 retry loop。
           */
          break;


        } catch (error) {


          console.error('');
          console.error(
            `第 ${pageNum} 页请求失败`
          );


          console.error(
            error.message
          );


          console.error(
            `失败 URL：${buildPageUrl(
              url,
              pageNum,
              DEFAULT_PAGE_SIZE
            )}`
          );


          console.error(
            '失败 response 已保存到 api_responses。'
          );


          console.error(
            `${ERROR_RETRY_DELAY / 60000} 分钟后继续重试第 ${pageNum} 页。`
          );


          /**
           * ★注意
           *
           * 这里完全没有：
           *
           * pageNum++
           *
           * 所以失败永远停在当前页。
           */
          await new Promise(
            resolve =>
              setTimeout(
                resolve,
                ERROR_RETRY_DELAY
              )
          );


          /**
           * 重试之前重新打开页面，
           * 刷新 Cookie / 浏览器状态。
           */
          try {

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


          } catch (openError) {

            console.error(
              `重新打开页面失败：${openError.message}`
            );
          }
        }
      }


      /**
       * =====================================
       *
       * 到这里说明当前页：
       *
       * HTTP成功
       * +
       * code === 100000
       *
       * =====================================
       */

      successPages++;


      const resultCount =
        getResultCount(data);


      console.log(
        `第 ${pageNum} 页成功，result=${resultCount} 条`
      );


      /**
       * API明确告诉我们：
       *
       * 没有下一页。
       */
      const hasNext =
        getApiNextState(data);


      if (hasNext === false) {

        console.log('');
        console.log(
          `第 ${pageNum} 页 is_next=0`
        );

        console.log(
          '所有 response 已经抓取完成。'
        );


        break;
      }


      /**
       * 防御性判断。
       *
       * 如果没有 is_next，
       * 同时 result=0，
       * 那也结束。
       */
      if (
        hasNext === null &&
        resultCount === 0
      ) {

        console.log('');
        console.log(
          'API 没有返回 is_next，并且 result=0。'
        );

        console.log(
          '认为已经没有下一页。'
        );


        break;
      }


      /**
       * =====================================
       *
       * ★★★ 最重要的地方 ★★★
       *
       * 只有成功页才：
       *
       * pageNum++
       *
       * =====================================
       */
      pageNum++;


      if (PAGE_DELAY > 0) {

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              PAGE_DELAY
            )
        );
      }
    }


    return {
      successPages,
      lastPage:
        pageNum
    };


  } finally {

    await browser.close();
  }
}


/**
 * 执行单个 Monitor
 */
async function runMonitor(monitorId) {


  if (
    runningMonitors.has(monitorId)
  ) {

    console.log(
      `Monitor ${monitorId} 已经在运行`
    );

    return;
  }


  /**
   * 非常重要：
   *
   * 必须先读取 monitor。
   *
   * 因为这里需要知道启动前的：
   *
   * last_status
   *
   * 不能先 update 成 running。
   */
  const monitor =
    getMonitor(monitorId);


  if (!monitor) {

    throw new Error(
      `Monitor ${monitorId} 不存在`
    );
  }


  if (!monitor.enabled) {

    console.log(
      `Monitor ${monitorId} 已停用`
    );

    return;
  }


  runningMonitors.add(
    monitorId
  );


  try {


    console.log('');
    console.log(
      `========== Monitor ${monitorId} ==========`
    );

    console.log(
      `名称：${monitor.name}`
    );


    /**
     * ★在把状态改成 running 之前
     * 先计算开始页。
     */
    const startPage =
      getStartPage(monitor);


    updateMonitorStatus(
      monitorId,
      'running'
    );


    /**
     * =====================================
     *
     * STEP 1
     *
     * 先把所有 API response 抓完
     *
     * =====================================
     */
    const fetchResult =
      await fetchAllResponses(
        monitor.url,
        monitorId,
        startPage
      );


    console.log('');
    console.log('================================');
    console.log('Response 抓取完成');
    console.log(`成功页数：${fetchResult.successPages}`);
    console.log(`最后页：${fetchResult.lastPage}`);
    console.log('================================');


    /**
     * =====================================
     *
     * STEP 2
     *
     * 所有 response 抓完以后，
     * 才统一解析 comments
     *
     * =====================================
     */
    console.log('');
    console.log('开始从 api_responses 解析 comments...');


    const rebuildResult =
      rebuildComments({
        monitorId
      });


    console.log('');
    console.log(
      `comments 解析完成：新增 ${rebuildResult.insertedCount} 条，` +
      `已存在跳过 ${rebuildResult.skippedCount} 条`
    );


    /**
     * =====================================
     *
     * STEP 3
     *
     * comments 全部处理完以后
     * 再重新计算统计
     *
     * =====================================
     */

    const emojis =
      JSON.parse(
        monitor.emojis || '[]'
      );


    const texts =
      JSON.parse(
        monitor.texts || '[]'
      );


    const allDb =
      getAllComments(
        monitorId
      );


    const stats =
      analyzeComments(
        allDb.map(
          item => ({
            content:
              item.content
          })
        ),

        emojis,
        texts
      );


    saveDailyStats({
      monitorId,

      statDate:
        todayString(),

      ...stats
    });


    updateMonitorStatus(
      monitorId,
      'success'
    );


    console.log('');
    console.log(
      '========== Monitor 完成 =========='
    );

    console.log(
      `数据库评论总数：${stats.totalComments}`
    );

    console.log(
      `本次新增：${rebuildResult.insertedCount}`
    );


    return stats;


  } catch (error) {


    console.error(
      `Monitor ${monitorId} 抓取失败：`,
      error
    );


    updateMonitorStatus(
      monitorId,
      'error'
    );


    throw error;


  } finally {


    runningMonitors.delete(
      monitorId
    );
  }
}


/**
 * 执行全部 Monitor
 */
async function runAllMonitors() {

  const monitors =
    getMonitors(true);


  console.log(
    `当前共有 ${monitors.length} 个启用监控`
  );


  for (const monitor of monitors) {

    try {

      await runMonitor(
        monitor.id
      );


    } catch (error) {

      console.error(
        `Monitor ${monitor.id} failed:`,
        error.message
      );
    }
  }
}


/**
 * 下一个每天 06:00
 */
function getNextSixAM() {

  const now =
    new Date();


  const next =
    new Date(now);


  next.setHours(
    6,
    0,
    0,
    0
  );


  if (next <= now) {

    next.setDate(
      next.getDate() + 1
    );
  }


  return next;
}


/**
 * Scheduler
 */
function startScheduler() {

  const schedule = () => {

    const next =
      getNextSixAM();


    const delay =
      next.getTime() -
      Date.now();


    console.log(
      `下一次自动抓取：${next.toLocaleString()}`
    );


    setTimeout(

      async () => {

        try {

          await runAllMonitors();

        } finally {

          schedule();
        }
      },

      delay
    );
  };


  schedule();
}


module.exports = {
  runMonitor,
  runAllMonitors,
  startScheduler,
  fetchAllResponses,
  fetchCommentPage,
  buildPageUrl
};
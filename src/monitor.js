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

// 成功页之间等待 0.5 秒
const PAGE_DELAY = 500;

// 失败后 1 分钟重试当前页
const ERROR_RETRY_DELAY = 1 * 60 * 1000;

// 单次 API 请求超时 60 秒
const API_TIMEOUT = 60 * 1000;


const runningMonitors = new Set();


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


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
 * 微博 API 是否业务成功
 *
 * 只有：
 *
 * code === 100000
 *
 * 才算成功。
 */
function isApiSuccess(data) {
  return (
    data &&
    typeof data === 'object' &&
    Number(data.code) === 100000
  );
}


/**
 * 是否还有下一页
 *
 * data.is_next = 1
 * => 有下一页
 *
 * data.is_next = 0
 * => 没有下一页
 */
function getApiNextState(data) {
  const value =
    data?.data?.is_next ??
    data?.is_next;

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  return Number(value) === 1;
}


/**
 * 当前 response 返回多少条评论。
 *
 * monitor.js 不解析 comments，
 * 这里只用于日志和兜底判断。
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
 * 获取这个 monitor 最新的一条 api_response。
 *
 * 注意：
 *
 * 我们不再使用：
 *
 * getLatestFailedApiResponse()
 *
 * 因为那会找到“历史上的某次失败”，
 * 而我们真正需要判断的是：
 *
 * 最新的一条 response 到底成功还是失败。
 */
function getLatestApiResponseRecord(monitorId) {
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
 * 判断一条 DB response 是否业务成功。
 */
function responseRecordIsSuccess(record) {
  if (!record) {
    return false;
  }

  if (
    record.error_message !== null &&
    String(record.error_message).trim() !== ''
  ) {
    return false;
  }

  if (!record.response_json) {
    return false;
  }

  try {
    const data =
      JSON.parse(record.response_json);

    return isApiSuccess(data);

  } catch (error) {
    return false;
  }
}


/**
 * 判断最近一次成功 response 是否已经是最后一页。
 */
function responseRecordIsLastPage(record) {
  if (!record) {
    return false;
  }

  if (!responseRecordIsSuccess(record)) {
    return false;
  }

  try {
    const data =
      JSON.parse(record.response_json);

    return getApiNextState(data) === false;

  } catch (error) {
    return false;
  }
}


/**
 * ==========================================
 * 重启 / 新一轮抓取的起点判断
 * ==========================================
 *
 * 情况 A
 *
 * monitor.last_status === success
 *
 * 表示上一轮已经完整结束。
 *
 * => 新一轮从 page 1 开始
 *
 *
 * 情况 B
 *
 * monitor.last_status === running / error
 *
 * 表示上一轮没有正常完成。
 *
 * 查看 api_responses 最新一条：
 *
 * 最新 page7 ERROR
 * => page7 重试
 *
 * 最新 page7 SUCCESS
 * => page8
 *
 *
 * 情况 C
 *
 * 最新成功页已经：
 *
 * is_next = 0
 *
 * 说明实际上 response 已经全部抓完，
 * 只是服务可能在 rebuild / 更新状态之前停止。
 *
 * => 不重新请求
 * => 直接 rebuild-comments
 */
function getResumeState(monitor) {

  /**
   * 上一轮完整完成。
   *
   * 今天 / 下一次 scheduler 再运行时，
   * 属于新的抓取轮次。
   */
  if (monitor.last_status === 'success') {

    return {
      startPage: 1,
      responsesAlreadyComplete: false,
      reason:
        '上一轮已经成功完成，本轮从第 1 页开始'
    };
  }


  const latest =
    getLatestApiResponseRecord(
      monitor.id
    );


  /**
   * 没有任何 response。
   */
  if (!latest) {

    return {
      startPage: 1,
      responsesAlreadyComplete: false,
      reason:
        '没有历史 response，从第 1 页开始'
    };
  }


  /**
   * 最新 response 是失败页。
   *
   * ★重新请求当前失败页
   */
  if (!responseRecordIsSuccess(latest)) {

    return {
      startPage:
        Number(latest.page_num),

      responsesAlreadyComplete:
        false,

      reason:
        `最新记录第 ${latest.page_num} 页失败，重新请求第 ${latest.page_num} 页`
    };
  }


  /**
   * 最新 response 成功，
   * 而且已经是最后一页。
   *
   * 这种情况通常是：
   *
   * API 已经全部抓完
   * ↓
   * 还没 rebuild
   * ↓
   * 服务被关闭
   *
   * 那么重启后不要去请求不存在的下一页。
   */
  if (
    responseRecordIsLastPage(
      latest
    )
  ) {

    return {
      startPage:
        Number(latest.page_num),

      responsesAlreadyComplete:
        true,

      reason:
        `最新成功记录第 ${latest.page_num} 页已经 is_next=0，直接继续 rebuild`
    };
  }


  /**
   * 最新页成功，但是还有下一页。
   *
   * ★成功页才跳下一页
   */
  return {
    startPage:
      Number(latest.page_num) + 1,

    responsesAlreadyComplete:
      false,

    reason:
      `最新记录第 ${latest.page_num} 页成功，从第 ${Number(latest.page_num) + 1} 页继续`
  };
}


/**
 * ==========================================
 * 请求单页
 * ==========================================
 *
 * 这里只负责：
 *
 * 1. 请求微博 API
 * 2. 保存 api_responses
 *
 * ★完全不保存 comments
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
     * ========================================
     * fetch 正常拿到 HTTP response
     * ========================================
     */
    if (result.ok) {


      /**
       * HTTP 本身失败。
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
       * ========================================
       * ★微博业务 code 判断
       * ========================================
       *
       * HTTP 200 也不能代表成功。
       *
       * 只有：
       *
       * code === 100000
       *
       * 才能继续下一页。
       */
      if (
        !isApiSuccess(
          result.data
        )
      ) {

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
            JSON.stringify(
              result.data
            );

        } catch (error) {

          errorResponseJson =
            String(
              result.data
            );
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
       * ========================================
       * ★真正成功
       * ========================================
       *
       * HTTP 2xx
       * +
       * code === 100000
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
     * ========================================
     * 网络 / 超时 / 非 JSON
     * ========================================
     */

    let errorMessage =
      result.error ||
      '未知 API 错误';


    if (
      result.type === 'timeout'
    ) {

      errorMessage =
        `API 请求超时（${API_TIMEOUT / 1000} 秒）`;

    } else if (
      result.type === 'network'
    ) {

      errorMessage =
        `网络请求失败：${errorMessage}`;
    }


    let responseData = null;


    /**
     * 即使不是 JSON，
     * 也尽量把服务器返回内容留下。
     */
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

      errorMessage
    });


    responseSaved = true;


    throw new Error(
      errorMessage
    );


  } catch (error) {


    /**
     * 如果异常发生在 Playwright 层，
     * 前面还没有保存过 response，
     * 那么这里补一条错误记录。
     */
    if (!responseSaved) {

      const errorMessage =
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
          `Playwright/API 异常：${errorMessage}`
      });
    }


    throw error;
  }
}


/**
 * ==========================================
 * 抓取全部 response
 * ==========================================
 *
 * ★核心原则：
 *
 * 失败：
 *
 * pageNum 不增加
 *
 *
 * 成功：
 *
 * 才 pageNum++
 *
 *
 * monitor.js：
 *
 * 完全不写 comments。
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


  let pageNum =
    startPage;


  let successPages = 0;


  try {

    console.log('');
    console.log('================================');
    console.log(`开始抓取：${url}`);
    console.log(`开始页：${pageNum}`);
    console.log('抓取阶段只保存 api_responses');
    console.log('不会写入 comments');
    console.log('================================');


	page.on(
	  'request',
	  request => {

	    if (
	      request.url().includes(
	        '/aj/shop/product/comments'
	      )
	    ) {

	      console.log('');
	      console.log('========== PROGRAM REQUEST ==========');
	      console.log('URL:', request.url());
	      console.log(
	        JSON.stringify(
	          request.headers(),
	          null,
	          2
	        )
	      );
	      console.log('=====================================');
	    }
	  }
	);
	
    /**
     * 先访问原页面。
     *
     * 主要用于：
     *
     * Cookie
     * 登录状态
     * 浏览器环境
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
       * ======================================
       * 当前页 retry loop
       * ======================================
       *
       * 注意：
       *
       * 这个 while 里面绝对没有 pageNum++
       *
       * 所以失败以后永远还在当前页。
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
           * ★只有成功才 break
           */
          break;


        } catch (error) {

          console.error('');
          console.error(
            `第 ${pageNum} 页失败`
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
            '失败 response 已保存到 api_responses'
          );

          console.error(
            `${ERROR_RETRY_DELAY / 60000} 分钟后继续重试第 ${pageNum} 页`
          );


          /**
           * ★没有 pageNum++
           */
          await sleep(
            ERROR_RETRY_DELAY
          );


          /**
           * 重试前重新进入原页面。
           *
           * 尽量刷新：
           *
           * Cookie
           * session
           * 页面状态
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
       * ======================================
       * 到这里说明当前页真正成功
       * ======================================
       *
       * HTTP 2xx
       * +
       * code === 100000
       */

      successPages++;


      const resultCount =
        getResultCount(
          data
        );


      console.log(
        `第 ${pageNum} 页成功，result=${resultCount} 条`
      );


      const hasNext =
        getApiNextState(
          data
        );


      /**
       * API 明确：
       *
       * is_next = 0
       */
      if (
        hasNext === false
      ) {

        console.log('');
        console.log(
          `第 ${pageNum} 页 is_next=0`
        );

        console.log(
          '所有 response 已抓取完成'
        );


        return {
          successPages,
          lastPage:
            pageNum
        };
      }


      /**
       * API 没有 is_next，
       * 同时 result = 0。
       *
       * 防止无限翻页。
       */
      if (
        hasNext === null &&
        resultCount === 0
      ) {

        console.log('');
        console.log(
          'API 没有 is_next，并且 result=0，停止翻页'
        );


        return {
          successPages,
          lastPage:
            pageNum
        };
      }


      /**
       * ======================================
       * ★★★ 唯一 pageNum++ 的位置 ★★★
       * ======================================
       *
       * 只有成功页才能来到这里。
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


  } finally {

    await browser.close();
  }
}


/**
 * ==========================================
 * 执行单个 Monitor
 * ==========================================
 */
async function runMonitor(monitorId) {


  /**
   * 防止同一个 monitor 重复执行。
   */
  if (
    runningMonitors.has(
      monitorId
    )
  ) {

    console.log(
      `Monitor ${monitorId} 已经在运行`
    );

    return;
  }


  /**
   * ★必须在 updateMonitorStatus('running') 之前读取。
   *
   * 因为我们需要知道：
   *
   * 上一次状态到底是：
   *
   * success
   * running
   * error
   */
  const monitor =
    getMonitor(
      monitorId
    );


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

    console.log(
      `上一次状态：${monitor.last_status || '无'}`
    );


    /**
     * ======================================
     * ★先算续跑点
     * ======================================
     */
    const resume =
      getResumeState(
        monitor
      );


    console.log(
      `续跑判断：${resume.reason}`
    );


    /**
     * 算完以后再改成 running。
     */
    updateMonitorStatus(
      monitorId,
      'running'
    );


    /**
     * ======================================
     * STEP 1
     *
     * 抓取 response
     * ======================================
     */
    if (
      !resume.responsesAlreadyComplete
    ) {

      const fetchResult =
        await fetchAllResponses(
          monitor.url,
          monitorId,
          resume.startPage
        );


      console.log('');
      console.log('================================');
      console.log('response 抓取完成');
      console.log(
        `本次成功请求页数：${fetchResult.successPages}`
      );

      console.log(
        `最后页：${fetchResult.lastPage}`
      );

      console.log('================================');


    } else {

      console.log('');
      console.log(
        '上一次 response 实际已经全部抓完'
      );

      console.log(
        '跳过 API 请求，直接继续 rebuild-comments'
      );
    }


    /**
     * ======================================
     * STEP 2
     *
     * response 全部完成后：
     *
     * rebuild comments
     * ======================================
     */
    console.log('');
    console.log(
      '开始从 api_responses 统一解析 comments...'
    );


    const rebuildResult =
      rebuildComments({
        monitorId
      });


    console.log('');
    console.log(
      `comments rebuild 完成：新增 ${rebuildResult.insertedCount} 条，已存在跳过 ${rebuildResult.skippedCount} 条`
    );


    /**
     * ======================================
     * STEP 3
     *
     * 重新计算当前 comments 总统计
     * ======================================
     */
    const emojis =
      JSON.parse(
        monitor.emojis ||
        '[]'
      );


    const texts =
      JSON.parse(
        monitor.texts ||
        '[]'
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


    /**
     * 保存当天统计。
     */
    saveDailyStats({
      monitorId,

      statDate:
        todayString(),

      ...stats
    });


    /**
     * 整轮真正完成。
     */
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
      `本次 rebuild 新增：${rebuildResult.insertedCount}`
    );


    return stats;


  } catch (error) {

    console.error('');
    console.error(
      `Monitor ${monitorId} 执行失败：`,
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
 * ==========================================
 * 执行全部启用 Monitor
 * ==========================================
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
    const monitor
    of monitors
  ) {

    try {

      await runMonitor(
        monitor.id
      );


    } catch (error) {

      console.error(
        `Monitor ${monitor.id} failed：${error.message}`
      );
    }
  }
}


/**
 * 下一次 06:00
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
 * 每天 06:00 scheduler
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

  buildPageUrl,
  getResumeState,
  fetchCommentPage,
  fetchAllResponses
};
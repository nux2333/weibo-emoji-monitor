const express = require('express');
const path = require('path');

const {
  db,
  initDatabase,
  getMonitors,
  getMonitor,
  createMonitor,
  updateMonitor,
  deleteMonitor,
  getMonitorResult,
  getDailyStats,
  getComments,
  getAllApiResponses,
  getApiResponses,
  getApiResponseById
} = require('./src/db');

const {
  syncMonitorsFromConfig
} = require('./src/config');

const {
  runMonitor,
  runAllMonitors,
  startScheduler
} = require('./src/monitor');

const {
  rebuildComments,
  extractComments,
  isSuccessfulResponse
} = require('./src/rebuild-comments');


const app = express();

const PORT =
  process.env.PORT || 3000;

const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN || 'change-me';


app.use(
  express.json({
    limit: '2mb'
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);


/**
 * Admin 权限检查
 */
function checkAdmin(
  req,
  res,
  next
) {

  const token =
    req.headers['x-admin-token'] ||
    req.query.token;


  if (
    token !== ADMIN_TOKEN
  ) {

    return res
      .status(401)
      .json({
        success: false,
        message: '未授权'
      });
  }


  next();
}


/**
 * 安全解析 JSON
 */
function safeJson(
  value,
  fallback
) {

  try {

    return JSON.parse(
      value || ''
    );

  } catch {

    return fallback;
  }
}


/**
 * 判断 error_message 是否有内容
 */
function hasErrorMessage(row) {

  return (
    row?.error_message !== null &&
    row?.error_message !== undefined &&
    String(
      row.error_message
    ).trim() !== ''
  );
}


/**
 * ==========================================
 * 页面
 * ==========================================
 */

app.get(
  '/',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );
  }
);


app.get(
  '/admin',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'admin.html'
      )
    );
  }
);


app.get(
  '/api-responses',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'api-responses.html'
      )
    );
  }
);


/**
 * ==========================================
 * 普通 API
 * ==========================================
 */

app.get(
  '/api/monitors',
  (req, res) => {

    try {

      const data =
        getMonitors(true)
          .map(
            monitor => ({
              id:
                monitor.id,

              name:
                monitor.name,

              emojis:
                safeJson(
                  monitor.emojis,
                  []
                ),

              texts:
                safeJson(
                  monitor.texts,
                  []
                ),

              enabled:
                !!monitor.enabled,

              last_run_at:
                monitor.last_run_at,

              last_status:
                monitor.last_status
            })
          );


      res.json({
        success: true,
        data
      });


    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          message: error.message
        });
    }
  }
);


app.get(
  '/api/monitors/:id/result',
  (req, res) => {

    try {

      const result =
        getMonitorResult(
          Number(
            req.params.id
          )
        );


      if (result) {

        result.emoji_stats =
          safeJson(
            result.emoji_stats,
            {}
          );

        result.text_stats =
          safeJson(
            result.text_stats,
            {}
          );
      }


      res.json({
        success: true,
        data: result || null
      });


    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          message: error.message
        });
    }
  }
);


app.get(
  '/api/monitors/:id/history',
  (req, res) => {

    try {

      const limit =
        Math.min(
          Number(
            req.query.limit
          ) || 30,
          365
        );


      const data =
        getDailyStats(
          Number(
            req.params.id
          ),
          limit
        ).map(
          row => ({
            ...row,

            emoji_stats:
              safeJson(
                row.emoji_stats,
                {}
              ),

            text_stats:
              safeJson(
                row.text_stats,
                {}
              )
          })
        );


      res.json({
        success: true,
        data
      });


    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          message: error.message
        });
    }
  }
);


app.get(
  '/api/monitors/:id/comments',
  (req, res) => {

    try {

      const limit =
        Math.min(
          Number(
            req.query.limit
          ) || 100,
          1000
        );


      const data =
        getComments(
          Number(
            req.params.id
          ),
          limit
        );


      res.json({
        success: true,
        data
      });


    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          message: error.message
        });
    }
  }
);


/**
 * ==========================================
 * Admin Monitor API
 * ==========================================
 */

app.get(
  '/api/admin/monitors',
  checkAdmin,
  (req, res) => {

    try {

      const data =
        getMonitors(false)
          .map(
            monitor => ({
              ...monitor,

              emojis:
                safeJson(
                  monitor.emojis,
                  []
                ),

              texts:
                safeJson(
                  monitor.texts,
                  []
                ),

              enabled:
                !!monitor.enabled
            })
          );


      res.json({
        success: true,
        data
      });


    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          message: error.message
        });
    }
  }
);


app.post(
  '/api/admin/monitors',
  checkAdmin,
  (req, res) => {

    try {

      const {
        name,
        url,
        emojis = [],
        texts = [],
        enabled = true
      } = req.body;


      if (
        !name ||
        !url
      ) {

        return res
          .status(400)
          .json({
            success: false,
            message:
              '名称和 URL 不能为空'
          });
      }


      const id =
        createMonitor({
          name,
          url,
          emojis,
          texts,
          enabled
        });


      /**
       * 新建后自动抓取
       */
      setImmediate(
        () => {

          runMonitor(id)
            .catch(
              error =>
                console.error(
                  error
                )
            );
        }
      );


      res.json({
        success: true,
        id
      });


    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          message: error.message
        });
    }
  }
);


app.put(
  '/api/admin/monitors/:id',
  checkAdmin,
  (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );


      const monitor =
        getMonitor(id);


      if (!monitor) {

        return res
          .status(404)
          .json({
            success: false,
            message:
              '监控项目不存在'
          });
      }


      const {
        name,
        url,
        emojis = [],
        texts = [],
        enabled = true
      } = req.body;


      updateMonitor(
        id,
        {
          name,
          url,
          emojis,
          texts,
          enabled
        }
      );


      /**
       * 更新后自动执行一次
       */
      setImmediate(
        () => {

          runMonitor(id)
            .catch(
              error =>
                console.error(
                  error
                )
            );
        }
      );


      res.json({
        success: true
      });


    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          message: error.message
        });
    }
  }
);


app.delete(
  '/api/admin/monitors/:id',
  checkAdmin,
  (req, res) => {

    try {

      deleteMonitor(
        Number(
          req.params.id
        )
      );


      res.json({
        success: true
      });


    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          message: error.message
        });
    }
  }
);


app.post(
  '/api/admin/monitors/:id/run',
  checkAdmin,
  (req, res) => {

    const id =
      Number(
        req.params.id
      );


    if (
      !getMonitor(id)
    ) {

      return res
        .status(404)
        .json({
          success: false,
          message:
            '监控项目不存在'
        });
    }


    setImmediate(
      () => {

        runMonitor(id)
          .catch(
            error =>
              console.error(
                error
              )
          );
      }
    );


    res.json({
      success: true,
      message:
        '已开始抓取'
    });
  }
);


/**
 * ==========================================
 * API Responses 管理页面
 * ==========================================
 *
 * generation_status：
 *
 * 请求失败
 * 无评论数据
 * 未生成
 * 部分已生成
 * 已全部生成
 *
 *
 * ★重要：
 *
 * 是否已经生成只按照：
 *
 * comment_id
 *
 * 全局判断。
 *
 * 不按照 monitor_id。
 */
app.get(
  '/api/admin/api-responses',
  checkAdmin,
  (req, res) => {

    try {

      const monitorId =
        req.query.monitorId
          ? Number(
              req.query.monitorId
            )
          : null;


      const generationStatus =
        String(
          req.query.generationStatus || ''
        ).trim();


      const page =
        Math.max(
          1,
          Number(
            req.query.page
          ) || 1
        );


      const pageSize =
        Math.min(
          200,
          Math.max(
            10,
            Number(
              req.query.pageSize
            ) || 50
          )
        );


      /**
       * 这里不再限制 500 条。
       *
       * 因为 generation_status 不是数据库字段，
       * 必须先把符合 Monitor 条件的 Response 取出，
       * 计算生成状态后再筛选、再分页。
       */
      let rows;


      if (monitorId) {

        rows =
          db.prepare(`
            SELECT
              ar.*,
              m.name AS monitor_name
            FROM api_responses ar
            LEFT JOIN monitors m
              ON m.id = ar.monitor_id
            WHERE ar.monitor_id = ?
            ORDER BY ar.id DESC
          `)
            .all(
              monitorId
            );

      } else {

        rows =
          db.prepare(`
            SELECT
              ar.*,
              m.name AS monitor_name
            FROM api_responses ar
            LEFT JOIN monitors m
              ON m.id = ar.monitor_id
            ORDER BY ar.id DESC
          `)
            .all();
      }


      /**
       * 一次性读出 comments 表所有 comment_id。
       *
       * 避免每条 response 都去查数据库。
       *
       * ★全局 comment_id
       */
      const generatedIds =
        new Set(
          db.prepare(`
            SELECT comment_id
            FROM comments
          `)
            .all()
            .map(
              row =>
                String(
                  row.comment_id
                )
            )
        );


      let data =
        rows.map(
          row => {

            let comments = [];

            let generatedCount = 0;

            let currentGenerationStatus =
              '请求失败';


            /**
             * 失败 response
             */
            if (
              hasErrorMessage(row)
            ) {

              currentGenerationStatus =
                '请求失败';

            } else if (
              row.response_json
            ) {

              try {

                const raw =
                  JSON.parse(
                    row.response_json
                  );


                if (
                  !isSuccessfulResponse(
                    raw
                  )
                ) {

                  currentGenerationStatus =
                    '请求失败';

                } else {

                  comments =
                    extractComments(
                      raw
                    );


                  if (
                    comments.length === 0
                  ) {

                    currentGenerationStatus =
                      '无评论数据';

                  } else {

                    generatedCount =
                      comments.filter(
                        comment => {

                          const rawId =
                            comment.comment_id ??
                            comment.commentId ??
                            comment.id ??
                            comment.cid;


                          if (
                            rawId === null ||
                            rawId === undefined ||
                            rawId === ''
                          ) {

                            return false;
                          }


                          return generatedIds.has(
                            String(
                              rawId
                            )
                          );
                        }
                      ).length;


                    if (
                      generatedCount ===
                      comments.length
                    ) {

                      currentGenerationStatus =
                        '已全部生成';

                    } else if (
                      generatedCount > 0
                    ) {

                      currentGenerationStatus =
                        '部分已生成';

                    } else {

                      currentGenerationStatus =
                        '未生成';
                    }
                  }
                }


              } catch (error) {

                currentGenerationStatus =
                  'JSON解析失败';
              }


            } else {

              currentGenerationStatus =
                '无 Response JSON';
            }


            return {
              ...row,

              comment_count:
                comments.length,

              generated_count:
                generatedCount,

              generation_status:
                currentGenerationStatus
            };
          }
        );


      /**
       * 先按生成状态筛选，再分页。
       */
      if (generationStatus) {

        data =
          data.filter(
            row =>
              row.generation_status ===
              generationStatus
          );
      }


      const total =
        data.length;


      const totalPages =
        Math.max(
          1,
          Math.ceil(
            total / pageSize
          )
        );


      const currentPage =
        Math.min(
          page,
          totalPages
        );


      const startIndex =
        (currentPage - 1) *
        pageSize;


      const pageData =
        data.slice(
          startIndex,
          startIndex + pageSize
        );


      res.json({
        success: true,

        data:
          pageData,

        pagination: {
          page:
            currentPage,

          pageSize,

          total,

          totalPages
        }
      });


    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          message: error.message
        });
    }
  }
);

/**
 * 查看单条 Response
 */
app.get(
  '/api/admin/api-responses/:id',
  checkAdmin,
  (req, res) => {

    try {

      const row =
        getApiResponseById(
          Number(
            req.params.id
          )
        );


      if (!row) {

        return res
          .status(404)
          .json({
            success: false,
            message:
              'Response 不存在'
          });
      }


      res.json({
        success: true,
        data: row
      });


    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          message: error.message
        });
    }
  }
);


/**
 * ==========================================
 * 手动生成某一条 Response 的 comments
 * ==========================================
 *
 * ★不再调用 normalizeComments
 *
 * ★不再调用 saveComments
 *
 * ★统一走 rebuildComments
 *
 * ★只处理当前 response ID
 */
app.post(
  '/api/admin/api-responses/:id/generate',
  checkAdmin,
  (req, res) => {

    try {

      const responseId =
        Number(
          req.params.id
        );


      if (
        !Number.isInteger(
          responseId
        ) ||
        responseId <= 0
      ) {

        return res
          .status(400)
          .json({
            success: false,
            message:
              'Response ID 无效'
          });
      }


      const row =
        getApiResponseById(
          responseId
        );


      if (!row) {

        return res
          .status(404)
          .json({
            success: false,
            message:
              'Response 不存在'
          });
      }


      if (
        !row.response_json ||
        String(
          row.response_json
        ).trim() === ''
      ) {

        return res
          .status(400)
          .json({
            success: false,
            message:
              '这条 Response 没有 JSON 数据'
          });
      }


      /**
       * error_message 有内容，
       * 说明这条 response 是失败记录。
       */
      if (
        hasErrorMessage(row)
      ) {

        return res
          .status(400)
          .json({
            success: false,
            message:
              '这条 Response 是失败记录，不能生成 comments'
          });
      }


      /**
       * 提前检查 JSON 和 code。
       */
      let raw;


      try {

        raw =
          JSON.parse(
            row.response_json
          );


      } catch {

        return res
          .status(400)
          .json({
            success: false,
            message:
              'response_json 不是有效 JSON'
          });
      }


      if (
        !isSuccessfulResponse(
          raw
        )
      ) {

        return res
          .status(400)
          .json({
            success: false,
            message:
              `这条 Response code=${raw?.code}，不是成功 Response`
          });
      }


      const comments =
        extractComments(
          raw
        );


      if (
        comments.length === 0
      ) {

        return res
          .status(400)
          .json({
            success: false,
            message:
              '没有从 Response 中识别到评论'
          });
      }


      /**
       * ★只 rebuild 当前这一条 response
       */
      const result =
        rebuildComments({
          responseId
        });


      res.json({
        success: true,

        message:
          `生成完成：解析 ${result.parsedCommentCount} 条，新增 ${result.insertedCount} 条，已存在跳过 ${result.skippedCount} 条`,

        responseId,

        parsedCommentCount:
          result.parsedCommentCount,

        insertedCount:
          result.insertedCount,

        skippedCount:
          result.skippedCount,

        invalidCommentCount:
          result.invalidCommentCount,

        insertErrorCount:
          result.insertErrorCount
      });


    } catch (error) {

      console.error(
        '手动生成 comments 失败：',
        error
      );


      res
        .status(500)
        .json({
          success: false,
          message:
            error.message
        });
    }
  }
);


/**
 * ==========================================
 * Server 启动
 * ==========================================
 */
async function start() {

  initDatabase();

  syncMonitorsFromConfig();


  app.listen(
    PORT,
    async () => {

      console.log(
        '===================================='
      );

      console.log(
        'Weibo Emoji Monitor'
      );

      console.log(
        `http://localhost:${PORT}`
      );

      console.log(
        `http://localhost:${PORT}/admin`
      );

      console.log(
        `http://localhost:${PORT}/api-responses`
      );

      console.log(
        '===================================='
      );


      /**
       * 启动时自动执行一次。
       */
      try {

        await runAllMonitors();

      } catch (error) {

        console.error(
          '启动时抓取失败:',
          error
        );
      }


      /**
       * 每日 Scheduler
       */
      startScheduler();
    }
  );
}


start()
  .catch(
    error => {

      console.error(
        'Server startup failed:',
        error
      );

      process.exit(1);
    }
  );
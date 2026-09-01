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
 * 首页评论看板 API
 * ==========================================
 *
 * 数据列表、统计都直接读取 comments 表。
 *
 * 属性规则：
 * 1. 柠檬水：content 包含 🍋 / 💛 / 柠檬水 任意一个
 * 2. 甜玉米：content 包含 🌽 / 甜玉米 任意一个
 * 3. 两种都没命中：无属性
 *
 * 同一条评论允许同时属于“柠檬水”和“甜玉米”。
 */
app.get(
  '/api/comments-dashboard',
  (req, res) => {

    try {

      const requestedPage =
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
            20,
            Number(
              req.query.pageSize
            ) || 100
          )
        );

      const attribute =
        String(
          req.query.attribute || ''
        ).trim();

      const keyword =
        String(
          req.query.keyword || ''
        ).trim();


      const lemonCondition = `
        (
          c.content LIKE '%🍋%' OR
          c.content LIKE '%💛%' OR
		  c.content LIKE '%水水%' OR
		  c.content LIKE '%田柠%' OR
		  c.content LIKE '%柠檬%'
        )
      `;

      const cornCondition = `
        (
          c.content LIKE '%🌽%' OR
		  c.content LIKE '%🌙%'  OR
		  c.content LIKE '%cpf%'  OR
          c.content LIKE '%甜玉米%'  OR
		  c.content LIKE '%米米%'  OR
		  c.content LIKE '%雷朋%'
        )
      `;


      /**
       * 顶部统计：
       * 永远统计 comments 表全部数据，
       * 不受当前列表筛选影响。
       */
      const stats =
        db.prepare(`
          SELECT
            SUM(
              CASE
                WHEN ${lemonCondition}
                THEN 1
                ELSE 0
              END
            ) AS lemon_count,

            SUM(
              CASE
                WHEN ${cornCondition}
                THEN 1
                ELSE 0
              END
            ) AS corn_count,

            SUM(
              CASE
                WHEN NOT ${lemonCondition}
                 AND NOT ${cornCondition}
                THEN 1
                ELSE 0
              END
            ) AS none_count

          FROM comments c
        `).get();


      const where = [];
      const params = [];


      if (
        attribute === 'lemon'
      ) {

        where.push(
          lemonCondition
        );

      } else if (
        attribute === 'corn'
      ) {

        where.push(
          cornCondition
        );

      } else if (
        attribute === 'none'
      ) {

        where.push(`
          NOT ${lemonCondition}
          AND NOT ${cornCondition}
        `);
      }


      if (keyword) {

        where.push(`
          (
            c.comment_id LIKE ? OR
            COALESCE(c.buyer_nickname, '') LIKE ? OR
            COALESCE(c.sku_name, '') LIKE ? OR
            c.content LIKE ?
          )
        `);

        const like =
          `%${keyword}%`;

        params.push(
          like,
          like,
          like,
          like
        );
      }


      const whereSql =
        where.length
          ? `WHERE ${where.join(' AND ')}`
          : '';


      const totalRow =
        db.prepare(`
          SELECT
            COUNT(*) AS total
          FROM comments c
          ${whereSql}
        `).get(
          ...params
        );


      const total =
        Number(
          totalRow?.total || 0
        );

      const totalPages =
        Math.max(
          1,
          Math.ceil(
            total / pageSize
          )
        );

      const page =
        Math.min(
          requestedPage,
          totalPages
        );

      const offset =
        (page - 1) *
        pageSize;


      const rows =
        db.prepare(`
          SELECT
            c.id,
            c.monitor_id,
            c.comment_id,
            c.buyer_nickname,
            c.sku_name,
            c.content,
            c.comment_time,
            c.first_seen_at,

            CASE
              WHEN ${lemonCondition}
              THEN 1
              ELSE 0
            END AS is_lemon,

            CASE
              WHEN ${cornCondition}
              THEN 1
              ELSE 0
            END AS is_corn

          FROM comments c
          ${whereSql}

          ORDER BY
            CASE
              WHEN c.comment_time GLOB '[0-9]*'
              THEN CAST(c.comment_time AS INTEGER)
              ELSE 0
            END DESC,
            c.id DESC

          LIMIT ?
          OFFSET ?
        `).all(
          ...params,
          pageSize,
          offset
        );


      const data =
        rows.map(
          row => {

            const attributes = [];

            if (row.is_lemon) {
              attributes.push(
                '柠檬水'
              );
            }

            if (row.is_corn) {
              attributes.push(
                '甜玉米'
              );
            }

            if (
              attributes.length === 0
            ) {
              attributes.push(
                '无属性'
              );
            }

            return {
              id:
                row.id,

              monitor_id:
                row.monitor_id,

              comment_id:
                row.comment_id,

              buyer_nickname:
                row.buyer_nickname || '',

              sku_name:
                row.sku_name || '',

              content:
                row.content || '',

              comment_time:
                row.comment_time,

              first_seen_at:
                row.first_seen_at,

              attributes
            };
          }
        );


      res.json({
        success: true,

        stats: {
          lemon:
            Number(
              stats?.lemon_count || 0
            ),

          corn:
            Number(
              stats?.corn_count || 0
            ),

          none:
            Number(
              stats?.none_count || 0
            )
        },

        data,

        pagination: {
          page,
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
          message:
            error.message
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
          req.query.generationStatus ||
          ''
        ).trim();


      /**
       * JSON 模糊检索关键词
       */
      const keyword =
        String(
          req.query.keyword ||
          ''
        ).trim();


      const requestedPage =
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
       * ==================================================
       * 查询 api_responses
       * ==================================================
       *
       * keyword：
       *
       * response_json LIKE '%keyword%'
       *
       * 所以可以搜索：
       *
       * comment_id
       * buyer_nickname
       * 评论正文
       * uid
       * sku
       * 以及 JSON 中任何文本
       *
       * 是对数据库全部 api_responses 检索，
       * 不是只搜当前页。
       */
      const where = [];

      const params = [];


      if (
        monitorId
      ) {

        where.push(
          'ar.monitor_id = ?'
        );

        params.push(
          monitorId
        );

      }


      if (
        keyword
      ) {

        where.push(
          `COALESCE(
            ar.response_json,
            ''
          ) LIKE ?`
        );

        params.push(
          `%${keyword}%`
        );

      }


      const whereSql =
        where.length

          ? `WHERE ${
              where.join(
                ' AND '
              )
            }`

          : '';


      const rows =
        db.prepare(`
          SELECT
            ar.*,
            m.name AS monitor_name

          FROM api_responses ar

          LEFT JOIN monitors m
            ON m.id =
               ar.monitor_id

          ${whereSql}

          ORDER BY
            ar.id DESC
        `)
          .all(
            ...params
          );


      /**
       * ==================================================
       * comments 表中已有 comment_id
       * ==================================================
       */
      const generatedIds =
        new Set(

          db.prepare(`
            SELECT
              comment_id
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


      /**
       * ==================================================
       * 计算生成状态
       * ==================================================
       */
      let data =
        rows.map(
          row => {

            let comments = [];

            let generatedCount = 0;

            let currentGenerationStatus =
              '请求失败';


            /**
             * 请求失败
             */
            if (
              hasErrorMessage(
                row
              )
            ) {

              currentGenerationStatus =
                '请求失败';

            }


            /**
             * 有 Response JSON
             */
            else if (
              row.response_json
            ) {

              try {

                const raw =
                  JSON.parse(
                    row.response_json
                  );


                /**
                 * API 本身返回失败
                 */
                if (
                  !isSuccessfulResponse(
                    raw
                  )
                ) {

                  currentGenerationStatus =
                    '请求失败';

                }

                else {

                  comments =
                    extractComments(
                      raw
                    );


                  /**
                   * Response 中没有评论
                   */
                  if (
                    comments.length ===
                    0
                  ) {

                    currentGenerationStatus =
                      '无评论数据';

                  }

                  else {

                    /**
                     * 判断这些 comment_id
                     * 有多少已经存在 comments 表
                     */
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


                          return (
                            generatedIds.has(
                              String(
                                rawId
                              )
                            )
                          );

                        }
                      ).length;


                    /**
                     * 全部存在
                     */
                    if (
                      generatedCount ===
                      comments.length
                    ) {

                      currentGenerationStatus =
                        '已全部生成';

                    }


                    /**
                     * 部分存在
                     */
                    else if (
                      generatedCount > 0
                    ) {

                      currentGenerationStatus =
                        '部分已生成';

                    }


                    /**
                     * 一个都没有
                     */
                    else {

                      currentGenerationStatus =
                        '未生成';

                    }

                  }

                }

              } catch (error) {

                currentGenerationStatus =
                  'JSON解析失败';

              }

            }


            /**
             * 没有 Response JSON
             */
            else {

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
       * ==================================================
       * 生成状态过滤
       * ==================================================
       */
      if (
        generationStatus
      ) {

        data =
          data.filter(
            row =>
              row.generation_status ===
              generationStatus
          );

      }


      /**
       * ==================================================
       * 分页
       * ==================================================
       */
      const total =
        data.length;


      const totalPages =
        Math.max(
          1,
          Math.ceil(
            total /
            pageSize
          )
        );


      const currentPage =
        Math.min(
          requestedPage,
          totalPages
        );


      const startIndex =
        (
          currentPage - 1
        ) *
        pageSize;


      const pageData =
        data.slice(

          startIndex,

          startIndex +
          pageSize

        );


      /**
       * ==================================================
       * Response
       * ==================================================
       */
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

      console.error(
        '查询 api_responses 失败：',
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

       // await runAllMonitors();

      } catch (error) {

        console.error(
          '启动时抓取失败:',
          error
        );
      }


      /**
       * 每日 Scheduler
       */
      // startScheduler();
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
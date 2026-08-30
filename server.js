const express = require('express');
const path = require('path');

const {
  initDatabase,
  getMonitors,
  getMonitor,
  createMonitor,
  updateMonitor,
  deleteMonitor,
  getMonitorResult,
  getDailyStats,
  getComments
} = require('./src/db');

const {
  syncMonitorsFromConfig
} = require('./src/config');

const {
  runMonitor,
  runAllMonitors,
  startScheduler
} = require('./src/monitor');


const app = express();

const PORT =
  process.env.PORT || 3000;

const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN || 'change-me';


app.use(
  express.json({
    limit: '1mb'
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
 * =========================
 * 后台 Token 验证
 * =========================
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

    return res.status(401).json({
      success: false,
      message: '未授权'
    });

  }

  next();
}


/**
 * =========================
 * 页面
 * =========================
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


/**
 * =========================
 * 前台 API
 * =========================
 */


/**
 * 获取所有启用的监控
 */

app.get(
  '/api/monitors',
  (req, res) => {

    try {

      const monitors =
        getMonitors(true);

      res.json({

        success: true,

        data:
          monitors.map(
            item => ({

              id:
                item.id,

              name:
                item.name,

              emojis:
                JSON.parse(
                  item.emojis || '[]'
                ),

              texts:
                JSON.parse(
                  item.texts || '[]'
                ),

              enabled:
                !!item.enabled,

              last_run_at:
                item.last_run_at,

              last_status:
                item.last_status

            })
          )

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/**
 * 获取最新统计
 */

app.get(
  '/api/monitors/:id/result',
  (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );

      const result =
        getMonitorResult(id);

      if (!result) {

        return res.json({

          success: true,

          data: null

        });

      }


      result.emoji_stats =
        JSON.parse(
          result.emoji_stats || '{}'
        );

      result.text_stats =
        JSON.parse(
          result.text_stats || '{}'
        );


      res.json({

        success: true,

        data: result

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/**
 * 获取历史统计
 */

app.get(
  '/api/monitors/:id/history',
  (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );

      const limit =
        Math.min(
          Number(
            req.query.limit
          ) || 30,
          365
        );


      const data =
        getDailyStats(
          id,
          limit
        );


      res.json({

        success: true,

        data:
          data.map(
            item => ({

              ...item,

              emoji_stats:
                JSON.parse(
                  item.emoji_stats || '{}'
                ),

              text_stats:
                JSON.parse(
                  item.text_stats || '{}'
                )

            })
          )

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/**
 * 获取评论
 */

app.get(
  '/api/monitors/:id/comments',
  (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );

      const limit =
        Math.min(
          Number(
            req.query.limit
          ) || 100,
          1000
        );


      const comments =
        getComments(
          id,
          limit
        );


      res.json({

        success: true,

        data: comments

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/**
 * =========================
 * 后台 API
 * =========================
 */


/**
 * 获取所有监控
 */

app.get(
  '/api/admin/monitors',
  checkAdmin,
  (req, res) => {

    try {

      const monitors =
        getMonitors(false);


      res.json({

        success: true,

        data:
          monitors.map(
            item => ({

              ...item,

              emojis:
                JSON.parse(
                  item.emojis || '[]'
                ),

              texts:
                JSON.parse(
                  item.texts || '[]'
                ),

              enabled:
                !!item.enabled

            })
          )

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/**
 * =========================
 * 手动添加监控
 * =========================
 *
 * 这个接口仍然保留。
 *
 * 但是你以后正常使用时，
 * 推荐直接修改 monitors.json。
 */

app.post(
  '/api/admin/monitors',
  checkAdmin,
  async (req, res) => {

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

        return res.status(400).json({

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
       * 添加以后立即抓取
       */

      setImmediate(
        async () => {

          try {

            await runMonitor(id);

          } catch (error) {

            console.error(

              `Monitor ${id} first run failed:`,

              error

            );

          }

        }
      );


      res.json({

        success: true,

        id

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/**
 * =========================
 * 修改监控
 * =========================
 */

app.put(
  '/api/admin/monitors/:id',
  checkAdmin,
  async (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );


      const monitor =
        getMonitor(id);


      if (!monitor) {

        return res.status(404).json({

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
       * 修改以后立即重新抓取
       */

      setImmediate(
        async () => {

          try {

            await runMonitor(id);

          } catch (error) {

            console.error(

              `Monitor ${id} update run failed:`,

              error

            );

          }

        }
      );


      res.json({

        success: true

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/**
 * =========================
 * 删除监控
 * =========================
 */

app.delete(
  '/api/admin/monitors/:id',
  checkAdmin,
  (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );


      deleteMonitor(id);


      res.json({

        success: true

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/**
 * =========================
 * 手动立即抓取
 * =========================
 */

app.post(
  '/api/admin/monitors/:id/run',
  checkAdmin,
  async (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );


      const monitor =
        getMonitor(id);


      if (!monitor) {

        return res.status(404).json({

          success: false,

          message:
            '监控项目不存在'

        });

      }


      /**
       * 不阻塞 HTTP
       */

      setImmediate(
        async () => {

          try {

            await runMonitor(id);

          } catch (error) {

            console.error(

              `Manual monitor ${id} failed:`,

              error

            );

          }

        }
      );


      res.json({

        success: true,

        message:
          '已开始抓取'

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/**
 * =========================
 * 启动
 * =========================
 */

async function start() {

  try {

    /**
     * 1.
     * 初始化数据库
     */

    initDatabase();


    /**
     * 2.
     * 读取 monitors.json
     *
     * 如果 JSON 中有新的 Monitor，
     * 自动写入数据库。
     *
     * 如果已经存在，
     * 自动更新配置。
     */

    console.log('');
    console.log(
      '开始同步 monitors.json...'
    );


    try {

      syncMonitorsFromConfig();

      console.log(
        'monitors.json 同步完成'
      );

    } catch (error) {

      console.error(
        'monitors.json 同步失败：',
        error
      );

      /**
       * 配置文件错误时直接停止启动，
       * 避免后台运行错误配置。
       */

      process.exit(1);

    }


    /**
     * 3.
     * 启动 HTTP Server
     */

    app.listen(
      PORT,
      async () => {

        console.log('');

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
          '===================================='
        );

        console.log('');


        /**
         * 4.
         * 启动后立即抓取
         */

        console.log(
          '开始执行启动时抓取...'
        );


        try {

          await runAllMonitors();

        } catch (error) {

          console.error(
            '启动时抓取失败:',
            error
          );

        }


        /**
         * 5.
         * 启动每日 06:00 自动任务
         */

        startScheduler();


        console.log(
          '每日自动抓取任务已启动'
        );

      }
    );

  } catch (error) {

    console.error(
      'Server startup failed:',
      error
    );

    process.exit(1);

  }

}


start();
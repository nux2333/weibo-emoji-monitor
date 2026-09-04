const path = require('path');
const { chromium } = require('playwright');
const { db } = require('./db');


/**
 * ============================================================
 * 配置
 * ============================================================
 */

/**
 * 默认每15分钟扫描一次。
 *
 * 可以通过环境变量修改：
 *
 * SUPERLIKE_SCAN_INTERVAL_MS
 */
const SCAN_INTERVAL_MS =
	Number(process.env.SUPERLIKE_SCAN_INTERVAL_MS)
	|| 15 * 60 * 1000;


/**
 * 每轮滚动次数。
 *
 * 默认30次。
 *
 * 后面如果觉得抓得不够深，
 * 可以继续调大。
 */
const SCROLL_TIMES =
	Number(process.env.SUPERLIKE_SCROLL_TIMES)
	|| 30;


/**
 * 每次滚动后的等待时间。
 */
const SCROLL_DELAY_MS =
	Number(process.env.SUPERLIKE_SCROLL_DELAY_MS)
	|| 1000;


/**
 * 页面第一次打开以后，
 * 等待接口加载。
 */
const INITIAL_WAIT_MS =
	Number(process.env.SUPERLIKE_INITIAL_WAIT_MS)
	|| 3000;


/**
 * 评论数必须小于20。
 *
 * 0～19：允许入库
 * >=20：不入库
 */
const MAX_COMMENTS = 20;


/**
 * 防止：
 *
 * 上一轮还没结束，
 * 下一轮又启动。
 */
let running = false;


/**
 * ============================================================
 * 数据库初始化
 * ============================================================
 */
function initSuperLikeTable() {

	db.exec(`
    CREATE TABLE IF NOT EXISTS superlike_posts (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      monitor_id INTEGER,

      post_id TEXT NOT NULL UNIQUE,

      uid TEXT,

      username TEXT,

      post_link TEXT,

      post_text TEXT,

      comments_count INTEGER NOT NULL DEFAULT 0,

      current_has_superlike INTEGER NOT NULL DEFAULT 0,

      icon_summary TEXT,

      experience_7d INTEGER,

      post_created_at TEXT,

      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      raw_json TEXT,

      FOREIGN KEY(monitor_id)
        REFERENCES monitors(id)
        ON DELETE CASCADE
    )
  `);


	ensureColumn(
		'superlike_posts',
		'monitor_id',
		'INTEGER'
	);

	ensureColumn(
		'superlike_posts',
		'uid',
		'TEXT'
	);

	ensureColumn(
		'superlike_posts',
		'username',
		'TEXT'
	);

	ensureColumn(
		'superlike_posts',
		'post_link',
		'TEXT'
	);

	ensureColumn(
		'superlike_posts',
		'post_text',
		'TEXT'
	);

	ensureColumn(
		'superlike_posts',
		'comments_count',
		'INTEGER NOT NULL DEFAULT 0'
	);

	ensureColumn(
		'superlike_posts',
		'current_has_superlike',
		'INTEGER NOT NULL DEFAULT 0'
	);

	ensureColumn(
		'superlike_posts',
		'icon_summary',
		'TEXT'
	);

	ensureColumn(
		'superlike_posts',
		'experience_7d',
		'INTEGER'
	);

	ensureColumn(
		'superlike_posts',
		'post_created_at',
		'TEXT'
	);

	ensureColumn(
		'superlike_posts',
		'first_seen_at',
		'TEXT'
	);

	ensureColumn(
		'superlike_posts',
		'last_seen_at',
		'TEXT'
	);

	ensureColumn(
		'superlike_posts',
		'raw_json',
		'TEXT'
	);


	db.exec(`
    CREATE INDEX IF NOT EXISTS
      idx_superlike_posts_monitor
    ON superlike_posts(monitor_id)
  `);

	db.exec(`
    CREATE INDEX IF NOT EXISTS
      idx_superlike_posts_uid
    ON superlike_posts(uid)
  `);

	db.exec(`
    CREATE INDEX IF NOT EXISTS
      idx_superlike_posts_comments_count
    ON superlike_posts(comments_count)
  `);

	db.exec(`
    CREATE INDEX IF NOT EXISTS
      idx_superlike_posts_superlike
    ON superlike_posts(current_has_superlike)
  `);

	db.exec(`
    CREATE INDEX IF NOT EXISTS
      idx_superlike_posts_last_seen
    ON superlike_posts(last_seen_at)
  `);
}

function getSuperLikeMonitors() {

	return db.prepare(`
    SELECT
      id,
      name,
      url,
      enabled
    FROM monitors
    WHERE enabled = 1
      AND monitor_type = 'superlike'
    ORDER BY id
  `).all();
}

/**
 * ============================================================
 * 自动补数据库Column
 * ============================================================
 */
function ensureColumn(
	tableName,
	columnName,
	columnType
) {

	const columns =
		db.prepare(
			`PRAGMA table_info(${tableName})`
		).all();


	const exists =
		columns.some(
			column =>
				column.name === columnName
		);


	if (exists) {
		return;
	}


	console.log(
		`[SuperLike] 增加数据库字段：${columnName}`
	);


	db.exec(`
    ALTER TABLE ${tableName}
    ADD COLUMN ${columnName} ${columnType}
  `);
}


/**
 * ============================================================
 * HTML → 普通文本
 * ============================================================
 */
function stripHtml(value) {

	if (
		value === null ||
		value === undefined
	) {
		return '';
	}


	return String(value)

		.replace(
			/<br\s*\/?>/gi,
			'\n'
		)

		.replace(
			/<[^>]+>/g,
			''
		)

		.replace(
			/&nbsp;/gi,
			' '
		)

		.replace(
			/&lt;/gi,
			'<'
		)

		.replace(
			/&gt;/gi,
			'>'
		)

		.replace(
			/&amp;/gi,
			'&'
		)

		.replace(
			/&quot;/gi,
			'"'
		)

		.replace(
			/&#39;/gi,
			"'"
		)

		.trim();
}


/**
 * ============================================================
 * post_id
 * ============================================================
 */
function getPostId(post) {

	const value =
		post?.idstr
		?? post?.mid
		?? post?.id;


	if (
		value === null ||
		value === undefined ||
		value === ''
	) {
		return '';
	}


	return String(value);
}


/**
 * ============================================================
 * UID
 * ============================================================
 */
function getUid(post) {

	const value =
		post?.user?.idstr
		?? post?.user?.id
		?? post?.uid;


	if (
		value === null ||
		value === undefined ||
		value === ''
	) {
		return '';
	}


	return String(value);
}


/**
 * ============================================================
 * 用户名
 * ============================================================
 */
function getUsername(post) {

	return (
		post?.user?.screen_name
		?? post?.user?.name
		?? null
	);
}


/**
 * ============================================================
 * 帖子内容
 * ============================================================
 */
function getPostText(post) {

	return stripHtml(
		post?.text
		?? post?.raw_text
		?? post?.text_raw
		?? ''
	);
}


/**
 * ============================================================
 * 评论数
 * ============================================================
 */
function getCommentsCount(post) {

	const value =
		post?.comments_count
		?? post?.comment_count
		?? 0;


	const number =
		Number(value);


	if (
		!Number.isFinite(number)
	) {
		return 0;
	}


	return number;
}


/**
 * ============================================================
 * 发布时间
 * ============================================================
 */
function getPostCreatedAt(post) {

	const value =
		post?.created_at
		?? post?.createdAt
		?? null;


	return value
		? String(value)
		: null;
}


/**
 * ============================================================
 * 帖子Link
 * ============================================================
 */
function getPostLink(post) {

	const candidates = [

		post?.scheme,

		post?.url,

		post?.mblog_url,

		post?.detail_url

	];


	for (
		const value of candidates
	) {

		if (
			typeof value !== 'string'
		) {
			continue;
		}


		/**
		 * 某些scheme可能是：
		 *
		 * sinaweibo://...
		 *
		 * 这种暂时不要。
		 */
		if (
			value.startsWith(
				'http://'
			)
			||
			value.startsWith(
				'https://'
			)
		) {

			if (
				value.includes(
					'weibo'
				)
			) {

				return value;
			}
		}
	}


	/**
	 * 没拿到原始Link时，
	 * 使用移动端detail。
	 */
	const postId =
		getPostId(post);


	if (postId) {

		return (
			`https://m.weibo.cn/detail/${postId}`
		);
	}


	return '';
}


/**
 * ============================================================
 * 判断一个JSON对象是不是微博
 * ============================================================
 */
function looksLikePost(obj) {

	if (
		!obj ||
		typeof obj !== 'object' ||
		Array.isArray(obj)
	) {

		return false;
	}


	const postId =
		obj.idstr
		?? obj.mid
		?? obj.id;


	if (!postId) {
		return false;
	}


	/**
	 * 必须有user。
	 *
	 * 主要为了避免把：
	 *
	 * 评论
	 * 用户资料
	 * 其他对象
	 *
	 * 错认为微博。
	 */
	if (!obj.user) {
		return false;
	}


	return (

		obj.text !== undefined

		||

		obj.raw_text !== undefined

		||

		obj.text_raw !== undefined

		||

		obj.comments_count !== undefined

		||

		obj.reposts_count !== undefined

		||

		obj.attitudes_count !== undefined

	);
}


/**
 * ============================================================
 * 从JSON中递归找微博
 * ============================================================
 */
function findPosts(
	value,
	result = [],
	visited = new Set()
) {

	if (
		!value ||
		typeof value !== 'object'
	) {
		return result;
	}


	if (
		visited.has(value)
	) {
		return result;
	}


	visited.add(value);


	if (
		looksLikePost(value)
	) {

		result.push(value);
	}


	if (
		Array.isArray(value)
	) {

		for (
			const item of value
		) {

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
			child &&
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


/**
 * ============================================================
 * 是否存在超Like
 * ============================================================
 *
 * IMPORTANT：
 *
 * 现在这里仍然属于“兼容判断”。
 *
 * 等你把真实超话response里的icon结构给我，
 * 后续可以改成精确字段判断。
 *
 * 只扫描 user，
 * 不扫描帖子正文。
 *
 * 避免有人正文写：
 *
 * “今天终于有超Like了”
 *
 * 被误判。
 */
function hasSuperLike(post) {

	if (!post?.user) {
		return false;
	}


	let text;


	try {

		text =
			JSON.stringify(
				post.user
			).toLowerCase();

	} catch {

		return false;
	}


	return (

		text.includes(
			'chao_like'
		)

		||

		text.includes(
			'chaolike'
		)

		||

		text.includes(
			'chao-like'
		)

		||

		text.includes(
			'super_like'
		)

		||

		text.includes(
			'superlike'
		)

		||

		text.includes(
			'超like'
		)

	);
}


/**
 * ============================================================
 * 当前Icon
 * ============================================================
 *
 * 页面以后显示：
 *
 * 当前带着什么icon
 *
 * 这里先通用提取：
 *
 * icon
 * badge
 * medal
 * label
 * level
 * pendant
 * title
 *
 * 等真实response确定以后，
 * 再进一步精确化。
 */
function extractIcons(post) {

	const user =
		post?.user;


	if (!user) {
		return [];
	}


	const result =
		new Set();


	const visited =
		new Set();


	const iconKeyPattern =
		/icon|badge|medal|label|level|pendant|title/i;


	function walk(
		value,
		keyName = ''
	) {

		if (
			value === null ||
			value === undefined
		) {

			return;
		}


		/**
		 * String
		 */
		if (
			typeof value === 'string'
		) {

			if (
				!iconKeyPattern.test(
					keyName
				)
			) {

				return;
			}


			const text =
				value.trim();


			if (!text) {
				return;
			}


			if (
				text.length > 100
			) {

				return;
			}


			/**
			 * 不要把图片地址
			 * 当成icon名称显示。
			 */
			if (
				/^https?:\/\//i.test(
					text
				)
			) {

				return;
			}


			/**
			 * 不展示超Like。
			 *
			 * 因为有超Like的人
			 * 本来就不会进入候选池。
			 */
			if (
				/chao[_-]?like|chaolike|super[_-]?like|superlike|超like/i
					.test(text)
			) {

				return;
			}


			result.add(text);

			return;
		}


		/**
		 * Number / Boolean
		 */
		if (
			typeof value !== 'object'
		) {
			return;
		}


		if (
			visited.has(value)
		) {
			return;
		}


		visited.add(value);


		if (
			Array.isArray(value)
		) {

			for (
				const item of value
			) {

				walk(
					item,
					keyName
				);
			}


			return;
		}


		for (
			const [
				key,
				child
			]
			of Object.entries(value)
		) {

			walk(
				child,
				key
			);
		}
	}


	walk(user);


	return Array.from(
		result
	);
}


/**
 * ============================================================
 * 保存候选帖子
 * ============================================================
 *
 * 唯一入库条件：
 *
 * 1. 无超Like
 * 2. 评论数 < 20
 */
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


	/**
	 * 评论 >= 20
	 *
	 * 不入库
	 */
	if (
		commentsCount >=
		MAX_COMMENTS
	) {

		return {

			status: 'skip',

			reason: 'comments_full'

		};
	}


	/**
	 * 已有超Like
	 *
	 * 不入库
	 */
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


	/**
	 * 看数据库以前有没有。
	 */
	const exists =
		db.prepare(`
      SELECT id
      FROM superlike_posts
      WHERE post_id = ?
    `).get(
			postId
		);


	/**
	 * ========================================================
	 * UPSERT
	 * ========================================================
	 *
	 * experience_7d 不更新。
	 *
	 * 因为以后这个字段可能由另一个程序计算。
	 */
	db.prepare(`
    INSERT INTO superlike_posts (

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

    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      0,
      ?,
      NULL,
      ?,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,
      ?
    )

    ON CONFLICT(post_id)

    DO UPDATE SET

      monitor_id =
        excluded.monitor_id,

      uid =
        excluded.uid,

      username =
        excluded.username,

      post_link =
        excluded.post_link,

      post_text =
        excluded.post_text,

      comments_count =
        excluded.comments_count,

      current_has_superlike = 0,

      icon_summary =
        excluded.icon_summary,

      post_created_at =
        COALESCE(
          excluded.post_created_at,
          superlike_posts.post_created_at
        ),

      last_seen_at =
        CURRENT_TIMESTAMP,

      raw_json =
        excluded.raw_json
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

		status:
			exists
				? 'updated'
				: 'inserted',

		postId,

		uid,

		username,

		postLink,

		commentsCount,

		iconSummary

	};
}


/**
 * ============================================================
 * 处理一个Response JSON
 * ============================================================
 */
function processResponseJson(
	monitorId,
	json,
	seenThisRun
) {

	const posts =
		findPosts(json);


	const stats = {

		found: 0,

		duplicate: 0,

		commentsFull: 0,

		hasSuperLike: 0,

		target: 0,

		inserted: 0,

		updated: 0

	};


	for (
		const post of posts
	) {

		const postId =
			getPostId(post);


		if (!postId) {
			continue;
		}


		/**
		 * 同一轮请求里，
		 * 同一个微博可能重复出现在不同JSON中。
		 */
		if (
			seenThisRun.has(
				postId
			)
		) {

			stats.duplicate++;

			continue;
		}


		seenThisRun.add(
			postId
		);


		stats.found++;


		const commentsCount =
			getCommentsCount(post);


		/**
		 * 第一层：
		 * 评论数筛选
		 */
		if (
			commentsCount >=
			MAX_COMMENTS
		) {

			stats.commentsFull++;

			continue;
		}


		/**
		 * 第二层：
		 * 超Like筛选
		 */
		if (
			hasSuperLike(post)
		) {

			stats.hasSuperLike++;

			continue;
		}


		/**
		 * 到这里就是候选目标。
		 */
		stats.target++;


		const result =
			saveTargetPost(
				monitorId,
				post
			);


		if (
			result.status ===
			'inserted'
		) {

			stats.inserted++;


			console.log(
				[
					'[新增]',
					`UID=${result.uid || '-'}`,
					`用户=${result.username || '-'}`,
					`评论=${result.commentsCount}`,
					`Icon=${result.iconSummary || '无'}`,
					result.postLink || '-'
				].join(' | ')
			);

		} else if (
			result.status ===
			'updated'
		) {

			stats.updated++;
		}
	}


	return stats;
}


/**
 * ============================================================
 * 执行一轮扫描
 * ============================================================
 */
async function scanOneSuperLikeMonitor(
	monitor
) {

	const topicUrl =
		monitor.url;


	console.log('');
	console.log(
		'=============================================='
	);

	console.log(
		`SuperLike：${monitor.name}`
	);

	console.log(
		`Monitor ID：${monitor.id}`
	);

	console.log(
		`URL：${topicUrl}`
	);

	console.log(
		'=============================================='
	);


	const profileDir =
		path.join(
			__dirname,
			'..',
			'data',
			'superlike-browser-profile'
		);


	let browser = null;


	const total = {

		found: 0,

		duplicate: 0,

		commentsFull: 0,

		hasSuperLike: 0,

		target: 0,

		inserted: 0,

		updated: 0

	};


	const startedAt =
		Date.now();


	try {

		browser =
			await chromium.launchPersistentContext(
				profileDir,
				{

					headless:
						process.env.SUPERLIKE_HEADLESS
						=== '1',

					viewport: {
						width: 1280,
						height: 900
					}
				}
			);


		const page =
			browser.pages()[0]
			|| await browser.newPage();


		const seenThisRun =
			new Set();


		const pendingResponses =
			new Set();


		page.on(
			'response',
			response => {

				const task =
					(async () => {

						try {

							const contentType =
								(
									response.headers()[
									'content-type'
									] || ''
								).toLowerCase();


							if (
								!contentType.includes(
									'application/json'
								)
							) {
								return;
							}


							const responseUrl =
								response.url();


							if (
								!responseUrl
									.toLowerCase()
									.includes('weibo')
							) {
								return;
							}


							let json;


							try {

								json =
									await response.json();

							} catch {

								return;
							}


							const stats =
								processResponseJson(
									monitor.id,
									json,
									seenThisRun
								);


							for (
								const key
								of Object.keys(total)
							) {

								total[key] +=
									stats[key] || 0;
							}


						} catch (error) {

							console.error(
								'[SuperLike] Response处理失败：',
								error.message
							);
						}

					})();


				pendingResponses.add(task);


				task.finally(
					() => {

						pendingResponses.delete(
							task
						);

					}
				);
			}
		);


		console.log(
			`[SuperLike] 打开：${monitor.name}`
		);


		await page.goto(
			topicUrl,
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


		for (
			let i = 1;
			i <= SCROLL_TIMES;
			i++
		) {

			await page.evaluate(
				() => {

					window.scrollTo(
						0,
						document.body.scrollHeight
					);

				}
			);


			await page.waitForTimeout(
				SCROLL_DELAY_MS
			);


			if (
				i % 5 === 0
			) {

				console.log(
					`[SuperLike] ${monitor.name} 滚动 ${i}/${SCROLL_TIMES}`
				);
			}
		}


		await page.waitForTimeout(
			2000
		);


		if (
			pendingResponses.size > 0
		) {

			await Promise.allSettled(
				Array.from(
					pendingResponses
				)
			);
		}


		const seconds =
			Math.round(
				(
					Date.now()
					- startedAt
				) / 1000
			);


		console.log('');
		console.log(
			`========== ${monitor.name} 结果 ==========`
		);

		console.log(
			'扫描微博：',
			total.found
		);

		console.log(
			'评论>=20：',
			total.commentsFull
		);

		console.log(
			'已有超Like：',
			total.hasSuperLike
		);

		console.log(
			'符合候选：',
			total.target
		);

		console.log(
			'新入库：',
			total.inserted
		);

		console.log(
			'更新：',
			total.updated
		);

		console.log(
			'耗时：',
			`${seconds}秒`
		);


	} finally {

		if (browser) {

			await browser.close();
		}
	}
}


/**
 * ============================================================
 * 手动启动Batch
 * ============================================================
 *
 * 这是你现在真正需要的运行模式：
 *
 *
 * node src/superlike-scanner.js
 *
 * ↓
 *
 * 马上扫描一次
 *
 * ↓
 *
 * 等15分钟
 *
 * ↓
 *
 * 再扫描一次
 *
 * ↓
 *
 * 一直循环
 *
 * ↓
 *
 * Ctrl+C停止
 *
 *
 * server.js完全不会自动启动这里。
 */
async function startSuperLikeBatch() {

	initSuperLikeTable();


	const minutes =
		SCAN_INTERVAL_MS
		/ 1000
		/ 60;


	console.log('');
	console.log(
		'################################################'
	);

	console.log(
		'# SuperLike Batch'
	);

	console.log(
		`# 每 ${minutes} 分钟扫描一次`
	);

	console.log(
		'# 条件：无超Like + 评论 < 20'
	);

	console.log(
		'# Ctrl+C 停止'
	);

	console.log(
		'################################################'
	);

	console.log('');


	/**
	 * ========================================================
	 * 第一轮立即执行
	 * ========================================================
	 */
	try {

		await scanSuperLikePosts();

	} catch (error) {

		console.error(
			'[SuperLike] 第一轮执行失败：',
			error
		);
	}


	/**
	 * ========================================================
	 * 后面每15分钟运行
	 * ========================================================
	 */
	setInterval(
		async () => {

			console.log('');
			console.log(
				'[SuperLike] 到达下一轮执行时间'
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


async function scanSuperLikePosts() {

  if (running) {

    console.log(
      '[SuperLike] 上一轮还没结束，本轮跳过。'
    );

    return;
  }


  running = true;


  try {

    initSuperLikeTable();


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
        "请在 monitors 表配置 monitor_type='superlike'。"
      );

      return;
    }


    console.log('');
    console.log(
      `[SuperLike] 本轮共 ${monitors.length} 个 Monitor`
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

        /**
         * 一个Monitor失败，
         * 不影响下一个Monitor继续执行。
         */
      }
    }


  } finally {

    running = false;
  }
}


/**
 * ============================================================
 * Ctrl+C
 * ============================================================
 */
process.on(
	'SIGINT',
	() => {

		console.log('');
		console.log(
			'[SuperLike] 收到Ctrl+C，Batch停止。'
		);

		process.exit(0);
	}
);


/**
 * ============================================================
 * Export
 * ============================================================
 */
module.exports = {

	initSuperLikeTable,

	scanSuperLikePosts,

	startSuperLikeBatch,

	hasSuperLike,

	extractIcons,

	findPosts,

	getPostId,

	getUid,

	getUsername,

	getPostText,

	getPostLink,

	getCommentsCount

};


/**
 * ============================================================
 * ★ 直接执行本文件时才启动Batch
 * ============================================================
 *
 * node src/superlike-scanner.js
 *
 * 会进入这里。
 *
 *
 * 如果server.js里只是require这个文件：
 *
 * require('./src/superlike-scanner')
 *
 * 不会启动Batch。
 *
 *
 * 所以server和Batch彻底分离。
 */
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
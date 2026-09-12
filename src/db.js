const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(DATA_DIR, 'monitor.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);

/*
 * SQLite 骞跺彂璁剧疆锛?
 * - WAL锛氳鍐欏苟鍙戞洿鍙嬪ソ锛孲canner/Recheck/Web 鍚屾椂杩愯鏃跺噺灏戜簰鐩搁樆濉炪€?
 * - busy_timeout锛氶亣鍒板叾浠?writer 鏃舵渶澶氱瓑寰?10 绉掞紝涓嶇珛鍗虫姏 SQLITE_BUSY銆?
 * - synchronous=NORMAL锛歐AL 涓嬪吋椤惧彲闈犳€т笌鍐欏叆鎬ц兘銆?
 *
 * 杩欎簺鏄繛鎺ョ骇/鏁版嵁搴撶骇璁剧疆锛屾瘡涓?Node 杩涚▼鍚姩鏃舵墽琛屼竴娆″嵆鍙€?
 */
db.exec(`
  PRAGMA busy_timeout = 10000;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
`);

let databaseInitialized = false;

function tableHasColumn(tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some(row => row.name === columnName);
}

function ensureColumn(tableName, columnName, definition) {
  if (tableHasColumn(tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  console.log(`鏁版嵁搴撳瓧娈靛凡琛ュ厖锛?{tableName}.${columnName}`);
}

function migrateSuperlikePostsIfNeeded() {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type='table' AND name='superlike_posts'
  `).get();

  if (!row) return;

  const sql = String(row.sql || '');
  const hasMonitorId = tableHasColumn('superlike_posts', 'monitor_id');
  const hasOldUniquePostId =
    /post_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sql);

  if (hasMonitorId && !hasOldUniquePostId) return;

  console.log('鍗囩骇 superlike_posts 琛ㄧ粨鏋?..');

  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE superlike_posts RENAME TO superlike_posts_old;

    CREATE TABLE superlike_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER,
      post_id TEXT NOT NULL,
      uid TEXT,
      username TEXT,
      post_link TEXT,
      post_text TEXT,
      comments_count INTEGER NOT NULL DEFAULT 0,
      initial_comments_count INTEGER,
      current_has_superlike INTEGER NOT NULL DEFAULT 0,
      moved_flag INTEGER NOT NULL DEFAULT 0,
      icon_summary TEXT,
      experience_7d INTEGER,
      initial_experience_7d INTEGER,
      post_created_at TEXT,
      /* 鍏ュ簱鏃堕棿锛氬浐瀹氫繚瀛樹腑鍥芥椂闂达紙UTC+8锛夛紝绮剧‘鍒扮锛涘悗缁?UPDATE 涓嶄慨鏀?*/
      inserted_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comment_last_checked_at TEXT,
      comment_next_check_at TEXT,
      profile_last_checked_at TEXT,
      profile_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      raw_json TEXT,
      UNIQUE(monitor_id, post_id),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    INSERT INTO superlike_posts(
      id, monitor_id, post_id, uid, username, post_link, post_text,
      comments_count, current_has_superlike, icon_summary, experience_7d,
      post_created_at, first_seen_at, last_seen_at, raw_json
    )
    SELECT
      id,
      ${hasMonitorId ? 'monitor_id' : 'NULL'},
      post_id, uid, username, post_link, post_text,
      comments_count, current_has_superlike, icon_summary, experience_7d,
      post_created_at, first_seen_at, last_seen_at, raw_json
    FROM superlike_posts_old;

    DROP TABLE superlike_posts_old;
    PRAGMA foreign_keys = ON;
  `);
}

function migrateSuperlikeUsersIfNeeded() {
  const tableExists = name =>
    !!db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
      LIMIT 1
    `).get(name);

  const getColumns = name =>
    db.prepare(`PRAGMA table_info(${name})`).all()
      .map(item => String(item.name));

  const oldTableExists =
    tableExists('superlike_users_old');

  const currentExists =
    tableExists('superlike_users');

  /*
   * 涓婁竴娆¤縼绉诲鏋滃湪 INSERT 闃舵澶辫触锛?
   * SQLite 鍙兘宸茬粡鐣欎笅锛?
   *   superlike_users_old = 鍘熷鏁版嵁
   *   superlike_users     = 鏂板缓浣嗕负绌虹殑琛?
   *
   * 杩欓噷鍏堜紭鍏堟仮澶嶈繖涓€滃崐杩佺Щ鈥濈姸鎬併€?
   */
  if (oldTableExists) {
    console.log(
      '妫€娴嬪埌涓婃 superlike_users 杩佺Щ鏈畬鎴愶紝姝ｅ湪鑷姩鎭㈠鍘熸暟鎹?..'
    );

    if (currentExists) {
      db.exec('DROP TABLE superlike_users');
    }

    db.exec(
      'ALTER TABLE superlike_users_old RENAME TO superlike_users'
    );
  }

  if (!tableExists('superlike_users')) {
    return;
  }

  const columns =
    getColumns('superlike_users');

  const obsoleteColumns = [
    'first_seen_at',
    'first_seen_date',
    'last_seen_date'
  ];

  if (
    obsoleteColumns.every(
      column => !columns.includes(column)
    )
  ) {
    return;
  }

  console.log(
    '鏁寸悊 superlike_users 琛ㄧ粨鏋勶細绉婚櫎 first_seen_at / first_seen_date / last_seen_date...'
  );

  const hasScanDate =
    columns.includes('scan_date');

  const hasFirstSeenDate =
    columns.includes('first_seen_date');

  const hasFirstSeenAt =
    columns.includes('first_seen_at');

  const hasInsertedAt =
    columns.includes('inserted_at');

  const hasLastSeenAt =
    columns.includes('last_seen_at');

  const hasFirstSeenRank =
    columns.includes('first_seen_rank');

  const hasLastSeenRank =
    columns.includes('last_seen_rank');

  const scanDateExpr =
    [
      hasScanDate
        ? "NULLIF(scan_date, '')"
        : null,
      hasFirstSeenDate
        ? "NULLIF(first_seen_date, '')"
        : null,
      hasFirstSeenAt
        ? "date(first_seen_at, '+8 hours')"
        : null,
      "date('now', '+8 hours')"
    ]
      .filter(Boolean)
      .join(', ');

  const insertedExpr =
    [
      hasInsertedAt
        ? "NULLIF(inserted_at, '')"
        : null,
      hasFirstSeenAt
        ? "datetime(first_seen_at, '+8 hours')"
        : null,
      "datetime('now', '+8 hours')"
    ]
      .filter(Boolean)
      .join(', ');

  const lastSeenExpr =
    [
      hasLastSeenAt
        ? "CASE WHEN last_seen_at IS NOT NULL AND last_seen_at <> '' THEN datetime(last_seen_at, '+8 hours') END"
        : null,
      "datetime('now', '+8 hours')"
    ]
      .filter(Boolean)
      .join(', ');

  db.exec('BEGIN IMMEDIATE');

  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;

      ALTER TABLE superlike_users
        RENAME TO superlike_users_old;

      CREATE TABLE superlike_users (
        monitor_id INTEGER NOT NULL,
        uid TEXT PRIMARY KEY,
        scan_date TEXT NOT NULL DEFAULT (date('now', '+8 hours')),
        inserted_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
        first_seen_rank INTEGER,
        last_seen_rank INTEGER,
        FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
      );

      INSERT INTO superlike_users(
        monitor_id,
        uid,
        scan_date,
        inserted_at,
        last_seen_at,
        first_seen_rank,
        last_seen_rank
      )
      SELECT
        monitor_id,
        uid,
        COALESCE(${scanDateExpr}),
        COALESCE(${insertedExpr}),
        COALESCE(${lastSeenExpr}),
        ${hasFirstSeenRank ? 'first_seen_rank' : 'NULL'},
        ${hasLastSeenRank ? 'last_seen_rank' : 'NULL'}
      FROM superlike_users_old;

      DROP TABLE superlike_users_old;

      PRAGMA foreign_keys = ON;
    `);

    db.exec('COMMIT');

    console.log(
      'superlike_users 琛ㄧ粨鏋勬暣鐞嗗畬鎴愩€?
    );

  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }

    throw error;
  }
}

function initDatabase() {
  if (databaseInitialized) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      emojis TEXT NOT NULL DEFAULT '[]',
      texts TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      monitor_type TEXT NOT NULL DEFAULT 'comments',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_run_at TEXT,
      last_status TEXT,
      history_next_page INTEGER,
      history_completed INTEGER NOT NULL DEFAULT 0,
      latest_last_run_at TEXT,
      latest_last_status TEXT,
      history_last_run_at TEXT,
      history_last_status TEXT
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      comment_id TEXT NOT NULL,
      buyer_nickname TEXT,
      customerid TEXT,
      sku_name TEXT,
      content TEXT NOT NULL,
      comment_time TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(monitor_id, comment_id),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      page_num INTEGER NOT NULL,
      api_url TEXT NOT NULL,
      http_status INTEGER,
      response_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      crawl_type TEXT NOT NULL DEFAULT 'legacy',
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      stat_date TEXT NOT NULL,
      total_comments INTEGER NOT NULL DEFAULT 0,
      emoji_total INTEGER NOT NULL DEFAULT 0,
      non_emoji_total INTEGER NOT NULL DEFAULT 0,
      emoji_stats TEXT NOT NULL DEFAULT '{}',
      text_stats TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(monitor_id, stat_date),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS superlike_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER,
      post_id TEXT NOT NULL,
      uid TEXT,
      username TEXT,
      post_link TEXT,
      post_text TEXT,
      comments_count INTEGER NOT NULL DEFAULT 0,
      current_has_superlike INTEGER NOT NULL DEFAULT 0,
      icon_summary TEXT,
      experience_7d INTEGER,
      post_created_at TEXT,
      /* 鍏ュ簱鏃堕棿锛氬浐瀹氫繚瀛樹腑鍥芥椂闂达紙UTC+8锛夛紝绮剧‘鍒扮锛涘悗缁?UPDATE 涓嶄慨鏀?*/
      inserted_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT,
      UNIQUE(monitor_id, post_id),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );


    CREATE TABLE IF NOT EXISTS superlike_list_state (
      monitor_id INTEGER PRIMARY KEY,
      last_uid TEXT,
      scan_date TEXT,
      last_total INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );


    CREATE TABLE IF NOT EXISTS superlike_users (
      monitor_id INTEGER NOT NULL,
      uid TEXT PRIMARY KEY,
      scan_date TEXT NOT NULL DEFAULT (date('now', '+8 hours')),
      inserted_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      first_seen_rank INTEGER,
      last_seen_rank INTEGER,
      experience_7d INTEGER,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );


    CREATE TABLE IF NOT EXISTS superlike_scan_checkpoint (
      monitor_id INTEGER PRIMARY KEY,
      latest_post_id TEXT,
      latest_created_at TEXT,
      latest_created_at_ms INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );


    /*
     * Scan 鏂偣缁壂娓告爣銆?
     * 涓庢寮?checkpoint 鍒嗙锛氭寮?checkpoint 鍙湪瀹夊叏杩藉埌鏃ц竟鐣屽悗鎺ㄨ繘锛?
     * resume 鍙褰曗€滀笅涓€椤典粠鍝噷缁х画鈥濓紝澶辫触/杈惧埌50椤垫椂淇濈暀銆?
     */
    CREATE TABLE IF NOT EXISTS superlike_scan_resume (
      monitor_id INTEGER PRIMARY KEY,
      checkpoint_post_id TEXT,
      checkpoint_created_at_ms INTEGER,
      sort_time_flow_id TEXT NOT NULL,
      template_url TEXT NOT NULL,
      next_page INTEGER NOT NULL,
      next_since_id TEXT,
      next_max_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    /*
     * 鍒嗗尯鐙珛 Resume銆?
     * 姣忎釜 monitor + source_key 鍗曠嫭淇濆瓨 tag_status_sort 鐨勪笅涓€椤?cursor銆?
     */
    CREATE TABLE IF NOT EXISTS superlike_scan_source_resume (
      monitor_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      flow_id TEXT NOT NULL,
      next_page INTEGER,
      next_since_id TEXT,
      next_max_id TEXT,
      next_count TEXT,
      next_page_common_ext TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(monitor_id, source_key),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    /*
     * 鍒嗗尯 Fresh 杈圭晫锛?
     * 璁板綍姣忎釜鍒嗗尯涓婁竴杞€滄渶鏂扮殑涓€鏉?post_id鈥濄€?
     * 涓嬩竴杞粠绗竴椤靛紑濮嬩竴鐩存壂鍒扮瑙佽繖涓?post_id 涓烘銆?
     */
    CREATE TABLE IF NOT EXISTS superlike_scan_source_checkpoint (
      monitor_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      latest_post_id TEXT NOT NULL,
      latest_created_at TEXT,
      latest_created_at_ms INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(monitor_id, source_key),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    /*
     * Fresh 姣忎釜鏉ユ簮鏈€鍚庝竴娆♀€滃畬鏁磋拷鍒板畨鍏ㄨ竟鐣屸€濈殑鎴愬姛鏃堕棿銆?
     * 鐢ㄤ簬鏈哄櫒瀹曟満鍚?Catch-up锛岄伩鍏嶅彧渚濊禆 page/cursor銆?
     */
    CREATE TABLE IF NOT EXISTS superlike_scan_success_state (
      monitor_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      last_successful_scan_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(monitor_id, source_key),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS superlike_pool_exit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      uid TEXT NOT NULL,
      exit_date TEXT NOT NULL DEFAULT (date('now', '+8 hours')),
      reason TEXT NOT NULL DEFAULT 'BECAME_SUPERLIKE',
      exited_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      UNIQUE(uid, exit_date, reason),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    /*
     * 鍊欓€夋睜浠婃棩鈥滄瘯涓氫汉鏁扳€濈疮璁°€?
     * 涓嶄繚瀛樻瘡涓?UID锛屽彧淇濆瓨姣忓ぉ绱浜烘暟銆?
     */
    CREATE TABLE IF NOT EXISTS superlike_pool_exit_daily (
      exit_date TEXT PRIMARY KEY,
      user_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
    );

    /*
     * SuperLike 椤甸潰榛戠矇鍏抽敭璇嶃€?
     * 椤甸潰鈥?涓嶆樉绀虹尓 鈥濈瓫閫変細妫€鏌ワ細
     * username / post_text / icon_summary銆?
     */
    CREATE TABLE IF NOT EXISTS superlike_black_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );


    /*
     * 榛戠矇鐢ㄦ埛琛ㄣ€?
     * uid 浣滀负绋冲畾鍞竴鏍囪瘑锛涚敤鎴峰悕鍜屼富椤甸摼鎺ョ敤浜庡睍绀?浜哄伐纭銆?
     */
    CREATE TABLE IF NOT EXISTS black_fan_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      username TEXT,
      profile_link TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    /*
     * 褰撳ぉ鎺掗櫎 UID锛?
     * 鏌愪釜鐢ㄦ埛浠绘剰鍊欓€夊笘璇勮杈惧埌 21 鍚庯紝褰撳ぉ涓嶅啀鎶撳彇璇?UID 鐨勫叾浠栧笘瀛愩€?
     * 鏃ユ湡鍥哄畾鎸変腑鍥芥椂闂达紙UTC+8锛夈€?
     */
    CREATE TABLE IF NOT EXISTS superlike_old_refresh_state (
      monitor_id INTEGER NOT NULL,
      uid TEXT NOT NULL,
      checked_date TEXT NOT NULL DEFAULT (date('now', '+8 hours')),
      result TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      PRIMARY KEY(monitor_id, uid, checked_date),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS superlike_daily_excluded_users (
      monitor_id INTEGER NOT NULL,
      uid TEXT NOT NULL,
      exclude_date TEXT NOT NULL DEFAULT (date('now', '+8 hours')),
      reason TEXT NOT NULL DEFAULT 'COMMENTS_21',
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      PRIMARY KEY(monitor_id, uid, exclude_date),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );
  `);

  ensureColumn('comments', 'buyer_nickname', 'TEXT');
  ensureColumn('comments', 'customerid', 'TEXT');
  ensureColumn('comments', 'sku_name', 'TEXT');

  ensureColumn('monitors', 'monitor_type', "TEXT NOT NULL DEFAULT 'comments'");
  ensureColumn('monitors', 'history_next_page', 'INTEGER');
  ensureColumn('monitors', 'history_completed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('monitors', 'latest_last_run_at', 'TEXT');
  ensureColumn('monitors', 'latest_last_status', 'TEXT');
  ensureColumn('monitors', 'history_last_run_at', 'TEXT');
  ensureColumn('monitors', 'history_last_status', 'TEXT');

  ensureColumn('api_responses', 'crawl_type', "TEXT NOT NULL DEFAULT 'legacy'");

  ensureColumn('superlike_list_state', 'scan_date', 'TEXT');
  ensureColumn('superlike_list_state', 'last_total', 'INTEGER');

  // SuperLike 楂樻晥澶嶆闃熷垪瀛楁銆?
  // 鏃ф暟鎹簱浼氬湪鍚姩鏃惰嚜鍔ㄨˉ鍒楋紝涓嶉渶瑕佹墜宸?migration銆?
  // 鍏ュ簱鏃堕棿鍥哄畾涓轰腑鍥芥椂闂达紙UTC+8锛夛紝绮剧‘鍒扮銆?
  // SQLite ALTER TABLE 涓嶈兘缁欐柊澧炲垪鐩存帴浣跨敤 datetime() 闈炲父閲忛粯璁ゅ€硷紝
  // 鎵€浠ユ棫搴撳厛琛ュ垪锛屽啀鍥炲～锛涙柊鏁版嵁鐢?CREATE TABLE 鐨?DEFAULT 鑷姩鍐欏叆銆?
  ensureColumn('superlike_posts', 'inserted_at', 'TEXT');

  db.exec(`
    UPDATE superlike_posts
    SET inserted_at = CASE
      WHEN first_seen_at IS NOT NULL
        THEN datetime(first_seen_at, '+8 hours')
      ELSE datetime('now', '+8 hours')
    END
    WHERE inserted_at IS NULL
       OR TRIM(inserted_at) = ''
  `);

    ensureColumn('superlike_posts', 'comment_last_checked_at', 'TEXT');
  ensureColumn('superlike_posts', 'comment_next_check_at', 'TEXT');
  ensureColumn('superlike_posts', 'profile_last_checked_at', 'TEXT');
  ensureColumn('superlike_posts', 'profile_status', "TEXT NOT NULL DEFAULT 'UNKNOWN'");
  ensureColumn('superlike_posts', 'experience_7d', 'INTEGER');
  ensureColumn('superlike_posts', 'initial_comments_count', 'INTEGER');
  ensureColumn('superlike_posts', 'initial_experience_7d', 'INTEGER');

  /*
   * initial_comments_count 淇濈暀鍏煎鍥炲～銆?
   * initial_experience_7d 涓嶅啀鐢?initDatabase() 鑷姩琛ワ紱
   * 鍙湪琛ョ粡楠屽€艰剼鏈涓€娆″彇寰楃粡楠屽€兼椂鍐欏叆銆?
   */
  db.exec(`
    UPDATE superlike_posts
    SET
      initial_comments_count =
        COALESCE(initial_comments_count, comments_count)
    WHERE initial_comments_count IS NULL
  `);

  /*
   * superlike_users 绮剧畝锛?
   * inserted_at = 绗竴娆″叆搴撲腑鍥芥椂闂达紙姘镐笉鏇存柊锛?
   * last_seen_at = 鏈€杩戜竴娆＄‘璁や腑鍥芥椂闂达紙浼氭洿鏂帮級
   * first_seen_at / first_seen_date / last_seen_date 涓嶅啀淇濈暀銆?
   */
  migrateSuperlikeUsersIfNeeded();

  ensureColumn('superlike_users', 'scan_date', 'TEXT');
  ensureColumn('superlike_users', 'inserted_at', 'TEXT');
  ensureColumn('superlike_users', 'last_seen_at', 'TEXT');
  ensureColumn('superlike_users', 'first_seen_rank', 'INTEGER');
  ensureColumn('superlike_users', 'last_seen_rank', 'INTEGER');
  ensureColumn('superlike_users', 'experience_7d', 'INTEGER');

  // 鍏煎鏃у簱锛氫互鍓?superlike_users 浣跨敤 (monitor_id, uid) 澶嶅悎涓婚敭锛?
  // 鐜板湪瑕佹眰 uid 鍏ㄥ眬鍞竴銆傚厛鍚堝苟/鍒犻櫎閲嶅 uid锛屽啀寤虹珛鍞竴绱㈠紩銆?
  db.exec(`
    DELETE FROM superlike_users
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM superlike_users
      GROUP BY uid
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_superlike_users_uid_unique
      ON superlike_users(uid);
  `);

  migrateSuperlikePostsIfNeeded();

  // 鍊欓€夊笘鏄惁宸茬粡鎼繍鍒板井鍗氱兢銆傛棫鏁版嵁搴撳惎鍔ㄦ椂鑷姩琛ュ垪銆?
  ensureColumn('superlike_posts', 'moved_flag', 'INTEGER NOT NULL DEFAULT 0');
  
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_monitors_type_enabled
      ON monitors(monitor_type, enabled);

    CREATE INDEX IF NOT EXISTS idx_comments_monitor
      ON comments(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_comments_comment_id
      ON comments(comment_id);
    CREATE INDEX IF NOT EXISTS idx_comments_time
      ON comments(comment_time);

    CREATE INDEX IF NOT EXISTS idx_api_responses_page
      ON api_responses(monitor_id, page_num);
    CREATE INDEX IF NOT EXISTS idx_api_responses_crawl_page
      ON api_responses(monitor_id, crawl_type, page_num);

    CREATE INDEX IF NOT EXISTS idx_daily_stats_monitor_date
      ON daily_stats(monitor_id, stat_date);

    CREATE INDEX IF NOT EXISTS idx_superlike_posts_monitor
      ON superlike_posts(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_uid
      ON superlike_posts(uid);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_comments
      ON superlike_posts(comments_count);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_superlike
      ON superlike_posts(current_has_superlike);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_last_seen
      ON superlike_posts(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_comment_due
      ON superlike_posts(comment_next_check_at, comments_count);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_profile_due
      ON superlike_posts(profile_last_checked_at, first_seen_at, uid);


    CREATE INDEX IF NOT EXISTS idx_superlike_users_scan_date
      ON superlike_users(scan_date);
    CREATE INDEX IF NOT EXISTS idx_superlike_users_uid
      ON superlike_users(uid);

    CREATE INDEX IF NOT EXISTS idx_superlike_black_keywords_enabled
      ON superlike_black_keywords(enabled, keyword);

    CREATE INDEX IF NOT EXISTS idx_black_fan_users_uid
      ON black_fan_users(uid);

    CREATE INDEX IF NOT EXISTS idx_superlike_daily_excluded_date_uid
      ON superlike_daily_excluded_users(exclude_date, uid);

    CREATE INDEX IF NOT EXISTS idx_black_fan_users_username
      ON black_fan_users(username);
  `);

  /*
   * 鍒濆榛戠矇鍏抽敭璇嶃€?
   * INSERT OR IGNORE锛氫互鍚庢墜宸ュ鍔?淇敼鍏抽敭璇嶄笉浼氳鍚姩杩囩▼瑕嗙洊銆?
   */
  const seedBlackKeyword =
    db.prepare(`
      INSERT OR IGNORE INTO superlike_black_keywords(
        keyword,
        enabled
      )
      VALUES(?,1)
    `);

  for (
    const keyword
    of [
      '闆锋湅',
      '娓?,
      'lp'
    ]
  ) {
    seedBlackKeyword.run(
      keyword
    );
  }

  /*
   * 鍙湁瀹屾暣鍒濆鍖栨垚鍔熷悗鎵嶇疆涓?true銆?
   * 涓婇潰浠绘剰 migration / DDL 澶辫触閮戒細鐩存帴鎶涢敊锛?
   * 涓嬫璋冪敤浠嶄細閲嶆柊灏濊瘯鍒濆鍖栥€?
   */
  databaseInitialized = true;
}


/* ============================================================
 * SuperLike DB helpers
 * ============================================================ */

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

function superLikePostIdExists(postId) {
  initDatabase();

  if (!postId) {
    return false;
  }

  return !!db.prepare(`
    SELECT 1
    FROM superlike_posts
    WHERE post_id = ?
    LIMIT 1
  `).get(String(postId));
}

function getExistingSuperLikeUids() {
  initDatabase();

  return new Set(
    db.prepare(`
      SELECT DISTINCT uid
      FROM superlike_posts
      WHERE uid IS NOT NULL
        AND uid <> ''
    `).all()
      .map(row => String(row.uid))
  );
}

function getLocalDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function isSuperLikeUser(uid) {
  initDatabase();

  const normalizedUid =
    String(uid || '').trim();

  if (!normalizedUid) {
    return false;
  }

  return !!db.prepare(`
    SELECT 1
    FROM superlike_users
    WHERE uid = ?
    LIMIT 1
  `).get(
    normalizedUid
  );
}

function getRecentSuperLikeProfileStatus(
  monitorId,
  uid,
  cacheMinutes = 15
) {
  initDatabase();

  const normalizedMonitorId =
    Number(monitorId);

  const normalizedUid =
    String(uid || '').trim();

  const minutes =
    Math.max(
      0,
      Number(cacheMinutes) || 0
    );

  if (
    !Number.isFinite(normalizedMonitorId)
    ||
    normalizedMonitorId <= 0
    ||
    !normalizedUid
  ) {
    return null;
  }

  const row =
    db.prepare(`
      SELECT
        profile_status,
        profile_last_checked_at
      FROM superlike_posts
      WHERE monitor_id = ?
        AND uid = ?
        AND profile_last_checked_at IS NOT NULL
        AND datetime(profile_last_checked_at)
            >= datetime('now', '-' || ? || ' minutes')
      ORDER BY datetime(profile_last_checked_at) DESC
      LIMIT 1
    `).get(
      normalizedMonitorId,
      normalizedUid,
      minutes
    );

  return row
    ? {
        status:
          String(
            row.profile_status
            || 'UNKNOWN'
          ),

        checkedAt:
          row.profile_last_checked_at
          || null
      }
    : null;
}

function markSuperLikeProfileChecked(
  monitorId,
  uid,
  status
) {
  initDatabase();

  const normalizedMonitorId =
    Number(monitorId);

  const normalizedUid =
    String(uid || '').trim();

  const normalizedStatus =
    String(status || 'UNKNOWN')
      .trim()
      .toUpperCase();

  if (
    !Number.isFinite(normalizedMonitorId)
    ||
    normalizedMonitorId <= 0
    ||
    !normalizedUid
  ) {
    return 0;
  }

  const result =
    db.prepare(`
      UPDATE superlike_posts
      SET
        profile_last_checked_at = CURRENT_TIMESTAMP,
        profile_status = ?
      WHERE monitor_id = ?
        AND uid = ?
    `).run(
      normalizedStatus,
      normalizedMonitorId,
      normalizedUid
    );

  return result.changes || 0;
}

function saveSuperLikeUser(monitorId, uid, scanDate = null, experience7d = null) {
  initDatabase();

  const normalizedMonitorId = Number(monitorId);
  const normalizedUid = String(uid || '').trim();

  if (!Number.isFinite(normalizedMonitorId) || normalizedMonitorId <= 0) {
    throw new Error('saveSuperLikeUser 缂哄皯鏈夋晥 monitorId');
  }

  if (!normalizedUid) {
    return false;
  }

  const date = scanDate || getLocalDateString();

  const normalizedExperience7d =
    Number.isFinite(Number(experience7d))
      ? Number(experience7d)
      : null;

  const existed = !!db.prepare(`
    SELECT 1
    FROM superlike_users
    WHERE uid = ?
    LIMIT 1
  `).get(normalizedUid);

  db.prepare(`
    INSERT INTO superlike_users(
      monitor_id,
      uid,
      scan_date,
      inserted_at,
      last_seen_at,
      experience_7d
    )
    VALUES(
      ?, ?, ?,
      datetime('now', '+8 hours'),
      datetime('now', '+8 hours'),
      ?
    )
    ON CONFLICT(uid)
    DO UPDATE SET
      scan_date = excluded.scan_date,
      last_seen_at = datetime('now', '+8 hours'),
      experience_7d = COALESCE(excluded.experience_7d, superlike_users.experience_7d)
  `).run(
    normalizedMonitorId,
    normalizedUid,
    date,
    normalizedExperience7d
  );

  return !existed;
}

function saveSuperLikeTargetPost(data = {}) {
  initDatabase();

  const monitorId = Number(data.monitorId);
  const postId = String(data.postId || '').trim();
  const uid = String(data.uid || '').trim();
  const username = data.username || '';
  const postLink = data.postLink || null;
  const postText = data.postText || '';
  const commentsCount = Number(data.commentsCount);
  const iconSummary = data.iconSummary || '鏃?;
  const postCreatedAt = data.postCreatedAt || null;
  const postCreatedAtMs = Number(data.postCreatedAtMs);
  const rawJson = data.rawJson || null;
  const experience7d =
    data.experience7d !== null
    &&
    data.experience7d !== undefined
    &&
    data.experience7d !== ''
    &&
    Number.isFinite(
      Number(
        data.experience7d
      )
    )
      ? Number(
          data.experience7d
        )
      : null;
  const profileStatus =
    String(data.profileStatus || 'UNKNOWN')
      .trim()
      .toUpperCase();

  if (!Number.isFinite(monitorId) || monitorId <= 0) {
    throw new Error('saveSuperLikeTargetPost 缂哄皯鏈夋晥 monitorId');
  }
  if (!postId) {
    throw new Error('saveSuperLikeTargetPost 缂哄皯 postId');
  }
  if (!uid) {
    throw new Error('saveSuperLikeTargetPost 缂哄皯 uid');
  }

  const existing = db.prepare(`
    SELECT
      id,
      post_id,
      comments_count,
      post_created_at,
      initial_comments_count,
      initial_experience_7d
    FROM superlike_posts
    WHERE monitor_id = ?
      AND uid = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(monitorId, uid);

  const initialCommentsCount =
    existing
    &&
    Number.isFinite(
      Number(
        existing.initial_comments_count
      )
    )
      ? Number(
          existing.initial_comments_count
        )
      : (
          Number.isFinite(
            commentsCount
          )
            ? commentsCount
            : null
        );

  const initialExperience7d =
    existing
    &&
    existing.initial_experience_7d !== null
    &&
    existing.initial_experience_7d !== undefined
    &&
    Number.isFinite(
      Number(
        existing.initial_experience_7d
      )
    )
      ? Number(
          existing.initial_experience_7d
        )
      : experience7d;

  if (existing) {
    const existingComments = Number(existing.comments_count);
    const existingMs = existing.post_created_at
      ? Date.parse(existing.post_created_at)
      : null;

    /*
     * 鍚?UID 鍊欓€夊笘鏇挎崲瑙勫垯锛?
     * 1) 涓嶅悓鑷劧鏃ワ細浼樺厛鏃ユ湡鏇存柊鐨勫笘瀛愶紝涓嶆瘮杈冭瘎璁烘暟銆?
     * 2) 鍚屼竴鑷劧鏃ワ細浼樺厛璇勮鏁版洿澶氱殑甯栧瓙銆?
     * 3) 鍚屾棩涓旇瘎璁烘暟鐩稿悓锛氬啀鐢ㄥ彂甯栨椂闂存洿鏅氱殑甯栧瓙鍏滃簳銆?
     *
     * 鏃ユ湡鎸?post_created_at 鎵€甯︽椂闂磋В鏋愬悗鐨勬湰鍦版棩鏈熸瘮杈冦€?
     */
    const toDateKey =
      ms => {
        if (
          !Number.isFinite(
            Number(ms)
          )
        ) {
          return null;
        }

        return new Intl.DateTimeFormat(
          'en-CA',
          {
            timeZone:
              'Asia/Shanghai',
            year:
              'numeric',
            month:
              '2-digit',
            day:
              '2-digit'
          }
        ).format(
          new Date(
            Number(ms)
          )
        );
      };

    const existingDateKey =
      toDateKey(
        existingMs
      );

    const newDateKey =
      toDateKey(
        postCreatedAtMs
      );

    let shouldReplace =
      false;

    if (
      newDateKey
      &&
      existingDateKey
      &&
      newDateKey !== existingDateKey
    ) {
      shouldReplace =
        newDateKey > existingDateKey;

    } else if (
      newDateKey
      &&
      existingDateKey
      &&
      newDateKey === existingDateKey
    ) {
      shouldReplace =
        (
          Number.isFinite(
            commentsCount
          )
          &&
          (
            !Number.isFinite(
              existingComments
            )
            ||
            commentsCount
            >
            existingComments
          )
        )
        ||
        (
          Number.isFinite(
            commentsCount
          )
          &&
          Number.isFinite(
            existingComments
          )
          &&
          commentsCount
          === existingComments
          &&
          Number.isFinite(
            postCreatedAtMs
          )
          &&
          (
            !Number.isFinite(
              existingMs
            )
            ||
            postCreatedAtMs
            >
            existingMs
          )
        );

    } else {
      /*
       * 浠讳竴甯栧瓙鏃堕棿鏃犳硶瑙ｆ瀽鏃讹紝閫€鍥炴棫瑙勫垯锛岄伩鍏嶅洜涓哄潖鏃堕棿瀛楁瀹屽叏鏃犳硶鏇存柊銆?
       */
      shouldReplace =
        (
          Number.isFinite(
            commentsCount
          )
          &&
          (
            !Number.isFinite(
              existingComments
            )
            ||
            commentsCount
            >
            existingComments
          )
        )
        ||
        (
          Number.isFinite(
            commentsCount
          )
          &&
          Number.isFinite(
            existingComments
          )
          &&
          commentsCount
          === existingComments
          &&
          Number.isFinite(
            postCreatedAtMs
          )
          &&
          (
            !Number.isFinite(
              existingMs
            )
            ||
            postCreatedAtMs
            >
            existingMs
          )
        );
    }

    if (!shouldReplace) {
      if (
        profileStatus !== 'UNKNOWN'
        ||
        experience7d !== null
      ) {
        db.prepare(`
          UPDATE superlike_posts
          SET
            profile_status = CASE
              WHEN ? = 'UNKNOWN' THEN profile_status
              ELSE ?
            END,
            profile_last_checked_at = CASE
              WHEN ? = 'UNKNOWN' THEN profile_last_checked_at
              ELSE CURRENT_TIMESTAMP
            END,
            experience_7d = COALESCE(?, experience_7d)
          WHERE monitor_id = ?
            AND uid = ?
        `).run(
          profileStatus,
          profileStatus,
          profileStatus,
          experience7d,
          monitorId,
          uid
        );
      }

      return {
        status: 'kept_existing',
        postId: String(existing.post_id),
        uid
      };
    }

    db.prepare(`
      DELETE FROM superlike_posts
      WHERE monitor_id = ?
        AND uid = ?
    `).run(monitorId, uid);
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
      initial_comments_count,
      current_has_superlike,
      icon_summary,
      experience_7d,
      initial_experience_7d,
      post_created_at,
      inserted_at,
      first_seen_at,
      last_seen_at,
      profile_last_checked_at,
      profile_status,
      raw_json
    )
    VALUES(
      ?,?,?,?,?,?,?,?,
      0,
      ?,
      ?,
      ?,
      ?,
      datetime('now', '+8 hours'),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,
      CASE WHEN ? = 'UNKNOWN' THEN NULL ELSE CURRENT_TIMESTAMP END,
      ?,
      ?
    )
  `).run(
    monitorId,
    postId,
    uid,
    username,
    postLink,
    postText,
    commentsCount,
    initialCommentsCount,
    iconSummary,
    experience7d,
    initialExperience7d,
    postCreatedAt,
    profileStatus,
    profileStatus,
    rawJson
  );

  return {
    status: existing ? 'replaced' : 'inserted',
    postId,
    uid,
    username,
    postLink,
    commentsCount,
    iconSummary,
    experience7d
  };
}

function setSuperLikePostMoved(postRowId, moved) {
  initDatabase();

  const id = Number(postRowId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('setSuperLikePostMoved 缂哄皯鏈夋晥甯栧瓙ID');
  }

  const movedFlag = moved ? 1 : 0;

  const result = db.prepare(`
    UPDATE superlike_posts
    SET moved_flag = ?
    WHERE id = ?
  `).run(movedFlag, id);

  return Number(result.changes || 0);
}


function setSuperLikePostsMoved(postRowIds, moved = true) {
  initDatabase();

  const ids = Array.from(
    new Set(
      (postRowIds || [])
        .map(id => Number(id))
        .filter(id => Number.isFinite(id) && id > 0)
    )
  );

  if (ids.length === 0) {
    return 0;
  }

  const movedFlag = moved ? 1 : 0;
  const CHUNK_SIZE = 500;
  let changed = 0;

  db.exec('BEGIN');

  try {
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');

      const result = db.prepare(`
        UPDATE superlike_posts
        SET moved_flag = ?
        WHERE id IN (${placeholders})
      `).run(movedFlag, ...chunk);

      changed += Number(result.changes || 0);
    }

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback error
    }
    throw error;
  }

  return changed;
}


function deletePostsByUidSet(uidSet) {
  initDatabase();

  const uids = Array.from(uidSet || [])
    .map(uid => String(uid || '').trim())
    .filter(Boolean);

  if (uids.length === 0) {
    return 0;
  }

  const CHUNK_SIZE = 500;
  let deleted = 0;

  db.exec('BEGIN');

  try {
    for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
      const chunk = uids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');

      const result = db.prepare(`
        DELETE FROM superlike_posts
        WHERE uid IN (${placeholders})
      `).run(...chunk);

      deleted += result.changes || 0;
    }

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback error
    }
    throw error;
  }

  return deleted;
}

function markDailyExcludedUser(
  monitorId,
  uid,
  reason = 'COMMENTS_21'
) {
  initDatabase();

  if (!monitorId || !uid) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_daily_excluded_users(
      monitor_id,
      uid,
      exclude_date,
      reason,
      created_at
    )
    VALUES(
      ?, ?,
      date('now', '+8 hours'),
      ?,
      datetime('now', '+8 hours')
    )
    ON CONFLICT(monitor_id, uid, exclude_date)
    DO UPDATE SET
      reason = excluded.reason
  `).run(
    Number(monitorId),
    String(uid),
    String(reason || 'COMMENTS_21')
  );

  return true;
}

function isDailyExcludedUser(
  monitorId,
  uid
) {
  initDatabase();

  if (!monitorId || !uid) {
    return false;
  }

  return !!db.prepare(`
    SELECT 1
    FROM superlike_daily_excluded_users
    WHERE monitor_id = ?
      AND uid = ?
      AND exclude_date = date('now', '+8 hours')
    LIMIT 1
  `).get(
    Number(monitorId),
    String(uid)
  );
}

function cleanupOldDailyExcludedUsers() {
  initDatabase();

  const result = db.prepare(`
    DELETE FROM superlike_daily_excluded_users
    WHERE exclude_date < date('now', '+8 hours', '-7 days')
  `).run();

  return Number(result.changes || 0);
}


function cleanupSuperLikePostsByUsersTable() {
  initDatabase();

  const matched =
    db.prepare(`
      SELECT
        COUNT(DISTINCT uid) AS user_count
      FROM superlike_posts
      WHERE uid IN (
        SELECT uid
        FROM superlike_users
      )
    `).get();

  const result =
    db.prepare(`
      DELETE FROM superlike_posts
      WHERE uid IN (
        SELECT uid
        FROM superlike_users
      )
    `).run();

  const deletedUsers =
    Number(
      matched?.user_count || 0
    );

  if (deletedUsers > 0) {
    addSuperLikePoolExitCount(
      deletedUsers
    );
  }

  return result.changes || 0;
}

function getScanCheckpoint(monitorId) {
  initDatabase();

  return db.prepare(`
    SELECT
      monitor_id,
      latest_post_id,
      latest_created_at,
      latest_created_at_ms
    FROM superlike_scan_checkpoint
    WHERE monitor_id = ?
  `).get(monitorId) || null;
}

function saveScanCheckpoint(
  monitorId,
  latestPostId,
  latestCreatedAt,
  latestCreatedAtMs
) {
  initDatabase();

  if (
    !latestPostId
    || !Number.isFinite(Number(latestCreatedAtMs))
  ) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_scan_checkpoint(
      monitor_id,
      latest_post_id,
      latest_created_at,
      latest_created_at_ms,
      updated_at
    )
    VALUES(
      ?, ?, ?, ?,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(monitor_id)
    DO UPDATE SET
      latest_post_id = excluded.latest_post_id,
      latest_created_at = excluded.latest_created_at,
      latest_created_at_ms = excluded.latest_created_at_ms,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    monitorId,
    String(latestPostId),
    latestCreatedAt || null,
    Number(latestCreatedAtMs)
  );

  return true;
}

function getScanResume(monitorId) {
  initDatabase();

  return db.prepare(`
    SELECT
      monitor_id,
      checkpoint_post_id,
      checkpoint_created_at_ms,
      sort_time_flow_id,
      template_url,
      next_page,
      next_since_id,
      next_max_id,
      updated_at
    FROM superlike_scan_resume
    WHERE monitor_id = ?
  `).get(monitorId) || null;
}


function saveScanResume(
  monitorId,
  checkpoint,
  sortTimeFlowId,
  templateUrl,
  nextParams
) {
  initDatabase();

  if (
    !monitorId
    || !sortTimeFlowId
    || !templateUrl
    || !nextParams
    || Number(nextParams.page) < 1
  ) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_scan_resume(
      monitor_id,
      checkpoint_post_id,
      checkpoint_created_at_ms,
      sort_time_flow_id,
      template_url,
      next_page,
      next_since_id,
      next_max_id,
      updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id)
    DO UPDATE SET
      checkpoint_post_id=excluded.checkpoint_post_id,
      checkpoint_created_at_ms=excluded.checkpoint_created_at_ms,
      sort_time_flow_id=excluded.sort_time_flow_id,
      template_url=excluded.template_url,
      next_page=excluded.next_page,
      next_since_id=excluded.next_since_id,
      next_max_id=excluded.next_max_id,
      updated_at=CURRENT_TIMESTAMP
  `).run(
    Number(monitorId),
    checkpoint?.latest_post_id
      ? String(checkpoint.latest_post_id)
      : null,
    Number.isFinite(Number(checkpoint?.latest_created_at_ms))
      ? Number(checkpoint.latest_created_at_ms)
      : null,
    String(sortTimeFlowId),
    String(templateUrl),
    Number(nextParams.page),
    nextParams.since_id == null
      ? null
      : String(nextParams.since_id),
    nextParams.max_id == null
      ? '0'
      : String(nextParams.max_id)
  );

  return true;
}


function clearScanResume(monitorId) {
  initDatabase();

  const result =
    db.prepare(`
      DELETE FROM superlike_scan_resume
      WHERE monitor_id = ?
    `).run(Number(monitorId));

  return Number(result.changes || 0);
}


function getScanSourceCheckpoint(
  monitorId,
  sourceKey
) {
  initDatabase();

  return db.prepare(`
    SELECT
      monitor_id,
      source_key,
      latest_post_id,
      latest_created_at,
      latest_created_at_ms,
      updated_at
    FROM superlike_scan_source_checkpoint
    WHERE monitor_id = ?
      AND source_key = ?
  `).get(
    Number(monitorId),
    String(sourceKey)
  ) || null;
}


function saveScanSourceCheckpoint(
  monitorId,
  sourceKey,
  latestPostId,
  latestCreatedAt,
  latestCreatedAtMs
) {
  initDatabase();

  if (
    !monitorId
    ||
    !sourceKey
    ||
    !latestPostId
  ) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_scan_source_checkpoint(
      monitor_id,
      source_key,
      latest_post_id,
      latest_created_at,
      latest_created_at_ms,
      updated_at
    )
    VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id, source_key)
    DO UPDATE SET
      latest_post_id = excluded.latest_post_id,
      latest_created_at = excluded.latest_created_at,
      latest_created_at_ms = excluded.latest_created_at_ms,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    Number(monitorId),
    String(sourceKey),
    String(latestPostId),
    latestCreatedAt || null,
    Number.isFinite(
      Number(latestCreatedAtMs)
    )
      ? Number(latestCreatedAtMs)
      : null
  );

  return true;
}


function getScanSuccessState(
  monitorId,
  sourceKey
) {
  initDatabase();

  return db.prepare(`
    SELECT
      monitor_id,
      source_key,
      last_successful_scan_at_ms,
      updated_at
    FROM superlike_scan_success_state
    WHERE monitor_id = ?
      AND source_key = ?
  `).get(
    Number(monitorId),
    String(sourceKey)
  ) || null;
}


function saveScanSuccessState(
  monitorId,
  sourceKey,
  successfulAtMs = Date.now()
) {
  initDatabase();

  const value =
    Number(successfulAtMs);

  if (
    !monitorId
    ||
    !sourceKey
    ||
    !Number.isFinite(value)
  ) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_scan_success_state(
      monitor_id,
      source_key,
      last_successful_scan_at_ms,
      updated_at
    )
    VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id, source_key)
    DO UPDATE SET
      last_successful_scan_at_ms =
        excluded.last_successful_scan_at_ms,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    Number(monitorId),
    String(sourceKey),
    Math.floor(value)
  );

  return true;
}


function getScanSourceResume(
  monitorId,
  sourceKey
) {
  initDatabase();

  return db.prepare(`
    SELECT
      monitor_id,
      source_key,
      flow_id,
      next_page,
      next_since_id,
      next_max_id,
      next_count,
      next_page_common_ext,
      updated_at
    FROM superlike_scan_source_resume
    WHERE monitor_id = ?
      AND source_key = ?
  `).get(
    Number(monitorId),
    String(sourceKey)
  ) || null;
}


function saveScanSourceResume(
  monitorId,
  sourceKey,
  flowId,
  nextParams
) {
  initDatabase();

  if (
    !monitorId
    ||
    !sourceKey
    ||
    !flowId
    ||
    !nextParams
    ||
    !nextParams.since_id
  ) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_scan_source_resume(
      monitor_id,
      source_key,
      flow_id,
      next_page,
      next_since_id,
      next_max_id,
      next_count,
      next_page_common_ext,
      updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id, source_key)
    DO UPDATE SET
      flow_id = excluded.flow_id,
      next_page = excluded.next_page,
      next_since_id = excluded.next_since_id,
      next_max_id = excluded.next_max_id,
      next_count = excluded.next_count,
      next_page_common_ext = excluded.next_page_common_ext,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    Number(monitorId),
    String(sourceKey),
    String(flowId),
    Number.isFinite(
      Number(nextParams.page)
    )
      ? Number(nextParams.page)
      : null,
    String(nextParams.since_id),
    nextParams.max_id == null
      ? '0'
      : String(nextParams.max_id),
    nextParams.count == null
      ? '15'
      : String(nextParams.count),
    nextParams.page_common_ext == null
      ? 'topicPrompt:1|page:tag_status_sort=1|hide_page:1'
      : String(nextParams.page_common_ext)
  );

  return true;
}


function clearScanSourceResume(
  monitorId,
  sourceKey
) {
  initDatabase();

  const result =
    db.prepare(`
      DELETE FROM superlike_scan_source_resume
      WHERE monitor_id = ?
        AND source_key = ?
    `).run(
      Number(monitorId),
      String(sourceKey)
    );

  return Number(
    result.changes || 0
  );
}


function addSuperLikePoolExitCount(
  count
) {
  initDatabase();

  const value =
    Math.max(
      0,
      Math.floor(
        Number(count) || 0
      )
    );

  if (value <= 0) {
    return getTodaySuperLikePoolExitCount();
  }

  db.prepare(`
    INSERT INTO superlike_pool_exit_daily(
      exit_date,
      user_count,
      updated_at
    )
    VALUES(
      date('now', '+8 hours'),
      ?,
      datetime('now', '+8 hours')
    )
    ON CONFLICT(exit_date)
    DO UPDATE SET
      user_count =
        superlike_pool_exit_daily.user_count
        + excluded.user_count,
      updated_at =
        datetime('now', '+8 hours')
  `).run(
    value
  );

  return getTodaySuperLikePoolExitCount();
}


function getTodaySuperLikePoolExitCount() {
  initDatabase();

  const row =
    db.prepare(`
      SELECT user_count
      FROM superlike_pool_exit_daily
      WHERE exit_date =
        date('now', '+8 hours')
    `).get();

  return Number(
    row?.user_count || 0
  );
}


function getMonitors(onlyEnabled = true) {
  initDatabase();
  return onlyEnabled
    ? db.prepare(`SELECT * FROM monitors WHERE enabled=1 ORDER BY id`).all()
    : db.prepare(`SELECT * FROM monitors ORDER BY id`).all();
}

function getMonitor(id) {
  initDatabase();
  return db.prepare(`SELECT * FROM monitors WHERE id=?`).get(id);
}

function getMonitorByUrl(url) {
  initDatabase();
  return db.prepare(`SELECT * FROM monitors WHERE url=? LIMIT 1`).get(url);
}

function createMonitor({
  name, url, emojis = [], texts = [], enabled = true,
  monitor_type = 'comments', monitorType = null
}) {
  initDatabase();
  const type = monitorType || monitor_type || 'comments';
  const result = db.prepare(`
    INSERT INTO monitors(
      name,url,emojis,texts,enabled,monitor_type,
      history_next_page,history_completed
    ) VALUES(?,?,?,?,?,?,1,0)
  `).run(
    name, url, JSON.stringify(emojis), JSON.stringify(texts),
    enabled ? 1 : 0, type
  );
  return Number(result.lastInsertRowid);
}

function updateMonitor(id, {
  name, url, emojis = [], texts = [], enabled = true,
  monitor_type = null, monitorType = null
}) {
  initDatabase();
  const current = getMonitor(id);
  const type = monitorType || monitor_type || current?.monitor_type || 'comments';
  db.prepare(`
    UPDATE monitors SET
      name=?, url=?, emojis=?, texts=?, enabled=?, monitor_type=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    name, url, JSON.stringify(emojis), JSON.stringify(texts),
    enabled ? 1 : 0, type, id
  );
}

function updateMonitorStatus(id, status) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET
      last_status=?, last_run_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, id);
}

function updateLatestStatus(monitorId, status) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET
      latest_last_status=?, latest_last_run_at=CURRENT_TIMESTAMP,
      last_status=?, last_run_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, status, monitorId);
}

function updateHistoryStatus(monitorId, status) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET
      history_last_status=?, history_last_run_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, monitorId);
}

function setHistoryNextPage(monitorId, pageNum) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET history_next_page=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(Number(pageNum), monitorId);
}

function markHistoryCompleted(monitorId) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET
      history_completed=1,
      history_last_status='success',
      history_last_run_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(monitorId);
}

function resetHistoryProgress(monitorId, pageNum = 1) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET
      history_next_page=?, history_completed=0,
      history_last_status=NULL, history_last_run_at=NULL,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(Number(pageNum), monitorId);
}

function getInitialHistoryPage(monitorId) {
  initDatabase();
  const monitor = getMonitor(monitorId);
  if (!monitor) throw new Error(`Monitor ${monitorId} 涓嶅瓨鍦╜);

  if (monitor.history_next_page != null && Number(monitor.history_next_page) >= 1) {
    return Number(monitor.history_next_page);
  }

  const rows = db.prepare(`
    SELECT page_num,http_status,response_json,error_message,crawl_type
    FROM api_responses
    WHERE monitor_id=?
      AND COALESCE(crawl_type,'legacy') IN ('legacy','history')
    ORDER BY page_num DESC,id DESC
  `).all(monitorId);

  let maxSuccessfulPage = 0;
  for (const row of rows) {
    if (row.error_message && String(row.error_message).trim()) continue;
    if (!row.response_json) continue;
    if (row.http_status != null &&
        (Number(row.http_status) < 200 || Number(row.http_status) >= 300)) continue;
    try {
      const raw = JSON.parse(row.response_json);
      if (Number(raw?.code) !== 100000) continue;
      maxSuccessfulPage = Math.max(maxSuccessfulPage, Number(row.page_num) || 0);
    } catch {}
  }

  const nextPage = maxSuccessfulPage > 0 ? maxSuccessfulPage + 1 : 1;
  setHistoryNextPage(monitorId, nextPage);
  console.log(`Monitor ${monitorId} 鍒濆鍖?History 鏂偣锛?{nextPage}`);
  return nextPage;
}

function deleteMonitor(id) {
  initDatabase();
  db.prepare(`DELETE FROM monitors WHERE id=?`).run(id);
}

function normalizeNullable(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function saveComment(monitorId, comment) {
  initDatabase();

  const commentId = String(
    comment.comment_id ?? comment.commentId ?? comment.id ?? comment.cid ?? ''
  );
  if (!commentId) return false;

  const content = String(comment.content ?? comment.text ?? '');
  const commentTime = normalizeNullable(
    comment.comment_time ?? comment.commentTime ?? comment.time ?? null
  );
  const buyerNickname = normalizeNullable(
    comment.buyer_nickname ?? comment.buyerNickname ??
    comment.username ?? comment.user_nickname ?? null
  );
  const customerid = normalizeNullable(
    comment.customerid ?? comment.customer_id ?? comment.uid ?? comment.user_id ?? null
  );
  const skuName = normalizeNullable(
    comment.sku_name ?? comment.skuName ?? comment.product ?? null
  );

  db.prepare(`
    INSERT INTO comments(
      monitor_id,comment_id,buyer_nickname,customerid,sku_name,
      content,comment_time
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(monitor_id,comment_id) DO UPDATE SET
      buyer_nickname=CASE
        WHEN comments.buyer_nickname IS NULL OR TRIM(comments.buyer_nickname)=''
        THEN excluded.buyer_nickname ELSE comments.buyer_nickname END,
      customerid=CASE
        WHEN comments.customerid IS NULL OR TRIM(comments.customerid)=''
        THEN excluded.customerid ELSE comments.customerid END,
      sku_name=CASE
        WHEN comments.sku_name IS NULL OR TRIM(comments.sku_name)=''
        THEN excluded.sku_name ELSE comments.sku_name END,
      comment_time=CASE
        WHEN comments.comment_time IS NULL OR TRIM(comments.comment_time)=''
        THEN excluded.comment_time ELSE comments.comment_time END,
      last_seen_at=CURRENT_TIMESTAMP
  `).run(
    monitorId, commentId, buyerNickname, customerid,
    skuName, content, commentTime
  );

  return true;
}

function saveComments(monitorId, comments) {
  initDatabase();
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const comment of comments || []) {
      if (saveComment(monitorId, comment)) count++;
    }
    db.exec('COMMIT');
    return count;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const commentOrderSql = `
  CASE
    WHEN comment_time GLOB '[0-9]*'
    THEN CAST(comment_time AS INTEGER)
    ELSE 0
  END DESC,
  id DESC
`;

function getComments(monitorId, limit = 100) {
  initDatabase();
  return db.prepare(`
    SELECT * FROM comments
    WHERE monitor_id=?
    ORDER BY ${commentOrderSql}
    LIMIT ?
  `).all(monitorId, limit);
}

function getAllComments(monitorId = null) {
  initDatabase();
  if (monitorId !== null && monitorId !== undefined) {
    return db.prepare(`
      SELECT * FROM comments
      WHERE monitor_id=?
      ORDER BY ${commentOrderSql}
    `).all(monitorId);
  }
  return db.prepare(`
    SELECT * FROM comments ORDER BY ${commentOrderSql}
  `).all();
}

function getCommentIds(monitorId) {
  initDatabase();
  return new Set(
    db.prepare(`SELECT comment_id FROM comments WHERE monitor_id=?`)
      .all(monitorId)
      .map(row => String(row.comment_id))
  );
}

function saveApiResponse({
  monitorId, pageNum, apiUrl,
  httpStatus = null, responseData = null,
  errorMessage = null, crawlType = 'legacy'
}) {
  initDatabase();
  let responseJson = null;
  try {
    responseJson = responseData == null ? null : JSON.stringify(responseData);
  } catch (e) {
    responseJson = JSON.stringify({ serializationError: e.message });
  }

  const result = db.prepare(`
    INSERT INTO api_responses(
      monitor_id,page_num,api_url,http_status,response_json,error_message,crawl_type
    ) VALUES(?,?,?,?,?,?,?)
  `).run(
    monitorId, pageNum, apiUrl, httpStatus,
    responseJson, errorMessage, crawlType || 'legacy'
  );

  return Number(result.lastInsertRowid);
}

function getApiResponses(monitorId, limit = 500) {
  initDatabase();
  return db.prepare(`
    SELECT ar.*,m.name AS monitor_name
    FROM api_responses ar
    LEFT JOIN monitors m ON m.id=ar.monitor_id
    WHERE ar.monitor_id=?
    ORDER BY ar.id DESC LIMIT ?
  `).all(monitorId, limit);
}

function getAllApiResponses(limit = 500) {
  initDatabase();
  return db.prepare(`
    SELECT ar.*,m.name AS monitor_name
    FROM api_responses ar
    LEFT JOIN monitors m ON m.id=ar.monitor_id
    ORDER BY ar.id DESC LIMIT ?
  `).all(limit);
}

function getApiResponseById(id) {
  initDatabase();
  return db.prepare(`
    SELECT ar.*,m.name AS monitor_name
    FROM api_responses ar
    LEFT JOIN monitors m ON m.id=ar.monitor_id
    WHERE ar.id=?
  `).get(id);
}

function getLatestFailedApiResponse(monitorId, crawlType = null) {
  initDatabase();
  if (crawlType) {
    return db.prepare(`
      SELECT * FROM api_responses
      WHERE monitor_id=? AND crawl_type=?
        AND error_message IS NOT NULL AND TRIM(error_message)<>''
      ORDER BY id DESC LIMIT 1
    `).get(monitorId, crawlType);
  }
  return db.prepare(`
    SELECT * FROM api_responses
    WHERE monitor_id=?
      AND error_message IS NOT NULL AND TRIM(error_message)<>''
    ORDER BY id DESC LIMIT 1
  `).get(monitorId);
}

function getLatestApiResponse(monitorId, crawlType = null) {
  initDatabase();
  if (crawlType) {
    return db.prepare(`
      SELECT * FROM api_responses
      WHERE monitor_id=? AND crawl_type=?
      ORDER BY id DESC LIMIT 1
    `).get(monitorId, crawlType);
  }
  return db.prepare(`
    SELECT * FROM api_responses
    WHERE monitor_id=?
    ORDER BY id DESC LIMIT 1
  `).get(monitorId);
}

function saveDailyStats(monitorIdOrObject, maybeStats = null) {
  initDatabase();
  let monitorId, stats;

  if (
    typeof monitorIdOrObject === 'object' &&
    monitorIdOrObject !== null &&
    maybeStats === null
  ) {
    monitorId = Number(monitorIdOrObject.monitorId);
    stats = { ...monitorIdOrObject };
    delete stats.monitorId;
  } else {
    monitorId = Number(monitorIdOrObject);
    stats = maybeStats || {};
  }

  if (!monitorId) throw new Error('saveDailyStats 缂哄皯 monitorId');

  const statDate = stats.statDate || new Date().toISOString().slice(0, 10);

  db.prepare(`
    INSERT INTO daily_stats(
      monitor_id,stat_date,total_comments,emoji_total,
      non_emoji_total,emoji_stats,text_stats
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(monitor_id,stat_date) DO UPDATE SET
      total_comments=excluded.total_comments,
      emoji_total=excluded.emoji_total,
      non_emoji_total=excluded.non_emoji_total,
      emoji_stats=excluded.emoji_stats,
      text_stats=excluded.text_stats,
      updated_at=CURRENT_TIMESTAMP
  `).run(
    monitorId, statDate,
    stats.totalComments ?? 0,
    stats.emojiTotal ?? 0,
    stats.nonEmojiTotal ?? 0,
    JSON.stringify(stats.emojiStats || {}),
    JSON.stringify(stats.textStats || {})
  );
}

function getDailyStats(monitorId, limit = 30) {
  initDatabase();
  return db.prepare(`
    SELECT * FROM daily_stats
    WHERE monitor_id=?
    ORDER BY stat_date DESC
    LIMIT ?
  `).all(monitorId, limit);
}

function getMonitorResult(monitorId) {
  initDatabase();
  return db.prepare(`
    SELECT ds.*,m.name AS monitor_name
    FROM daily_stats ds
    LEFT JOIN monitors m ON m.id=ds.monitor_id
    WHERE ds.monitor_id=?
    ORDER BY ds.stat_date DESC
    LIMIT 1
  `).get(monitorId);
}

module.exports = {
  db, initDatabase,
  getMonitors, getMonitor, getMonitorByUrl,
  createMonitor, updateMonitor, updateMonitorStatus, deleteMonitor,
  updateLatestStatus, updateHistoryStatus, setHistoryNextPage,
  markHistoryCompleted, resetHistoryProgress, getInitialHistoryPage,
  saveComment, saveComments, getComments, getAllComments, getCommentIds,
  saveApiResponse, getApiResponses, getAllApiResponses, getApiResponseById,
  getLatestFailedApiResponse, getLatestApiResponse,
  saveDailyStats, getDailyStats, getMonitorResult,
  getSuperLikeMonitors,
  superLikePostIdExists,
  getExistingSuperLikeUids,
  isSuperLikeUser,
  getRecentSuperLikeProfileStatus,
  markSuperLikeProfileChecked,
  saveSuperLikeUser,
  saveSuperLikeTargetPost,
  setSuperLikePostMoved,
  setSuperLikePostsMoved,
  deletePostsByUidSet,
  markDailyExcludedUser,
  isDailyExcludedUser,
  cleanupOldDailyExcludedUsers,
  cleanupSuperLikePostsByUsersTable,
  getScanCheckpoint,
  saveScanCheckpoint,
  getScanResume,
  saveScanResume,
  clearScanResume,
  getScanSourceCheckpoint,
  saveScanSourceCheckpoint,
  getScanSuccessState,
  saveScanSuccessState,
  getScanSourceResume,
  saveScanSourceResume,
  clearScanSourceResume,
  addSuperLikePoolExitCount,
  getTodaySuperLikePoolExitCount
};


const {
  spawn
} = require('child_process');
const path = require('path');

const ROOT =
  path.join(
    __dirname,
    '..'
  );

const SCANNER =
  path.join(
    ROOT,
    'src',
    'superlike-scanner.js'
  );

const PLAYWRIGHT_GUARD =
  path.join(
    ROOT,
    'src',
    'playwright-hardening.js'
  );

const POSTGRES_PRELOAD =
  path.join(
    ROOT,
    'src',
    'postgres-preload.js'
  );

const UNIFIED_SCAN_RESUME_PRELOAD =
  path.join(
    ROOT,
    'src',
    'unified-scan-resume-preload.js'
  );

const UNIFIED_SCAN_CHECKPOINT_PRELOAD =
  path.join(
    ROOT,
    'src',
    'unified-scan-checkpoint-preload.js'
  );

const HTTP_FRESH_LATEST_PRELOAD =
  path.join(
    ROOT,
    'src',
    'superlike-http-latest-preload.js'
  );

const QA_HTTP_ONLY_PRELOAD =
  path.join(
    ROOT,
    'src',
    'superlike-qa-http-only-preload.js'
  );

const WORKER_STAGGER_MS =
  Math.max(
    0,
    Number(
      process.env.SUPERLIKE_WORKER_STAGGER_MS
    )
    || 3000
  );

const workers = [
  {
    label: 'fresh-latest',
    mode: 'fresh',
    source: 'latest-posts',
    startDelayMs: 0
  },
  {
    label: 'fresh-hot',
    mode: 'fresh',
    source: 'section-hot',
    startDelayMs: WORKER_STAGGER_MS
  },
  {
    label: 'fresh-superlike',
    mode: 'fresh',
    source: 'section-superlike',
    startDelayMs: WORKER_STAGGER_MS * 2
  },
  {
    label: 'fresh-yishanshui',
    mode: 'fresh',
    source: 'section-yishanshui',
    startDelayMs: WORKER_STAGGER_MS * 3
  },
  {
    label: 'fresh-qa',
    mode: 'fresh',
    source: 'section-qa',
    startDelayMs: WORKER_STAGGER_MS * 4
  },
  {
    label: 'history',
    mode: 'history',
    source: '',
    startDelayMs: WORKER_STAGGER_MS * 5
  }
];

const WORKER_ONLY =
  String(
    process.env.SUPERLIKE_WORKER_ONLY
    || ''
  ).trim();

const selectedWorkers =
  WORKER_ONLY
    ? workers.filter(
        spec =>
          spec.label === WORKER_ONLY
      )
    : workers;

const children =
  new Map();

let stopping =
  false;

function startWorker(
  spec
) {
  if (stopping) {
    return;
  }

  const env = {
    ...process.env,
    SUPERLIKE_SCAN_WORKER_MODE:
      spec.mode,
    SUPERLIKE_SCAN_WORKER_LABEL:
      spec.label
  };

  if (spec.source) {
    env.SUPERLIKE_SCAN_WORKER_SOURCE =
      spec.source;
  } else {
    delete env.SUPERLIKE_SCAN_WORKER_SOURCE;
  }

  if (spec.source === 'section-hot') {
    env.SUPERLIKE_HOT_PAGES = '20';
  }

  if (spec.source === 'section-superlike') {
    env.SUPERLIKE_TAG_SECTION_PAGES = '10';
  }

  console.log(
    `[SuperLikeWorkers] 启动 ${spec.label} | mode=${spec.mode} | source=${spec.source || '-'}`
  );

  const child =
    spawn(
      process.execPath,
      [
        '--require',
        POSTGRES_PRELOAD,
        '--require',
        UNIFIED_SCAN_RESUME_PRELOAD,
        '--require',
        UNIFIED_SCAN_CHECKPOINT_PRELOAD,
        '--require',
        HTTP_FRESH_LATEST_PRELOAD,
        '--require',
        QA_HTTP_ONLY_PRELOAD,
        '--require',
        PLAYWRIGHT_GUARD,
        SCANNER
      ],
      {
        cwd:
          ROOT,
        env,
        stdio:
          [
            'ignore',
            'ignore',
            'inherit'
          ],
        windowsHide:
          true
      }
    );

  children.set(
    spec.label,
    child
  );

  child.once(
    'error',
    error => {
      console.error(
        `[SuperLikeWorkers] ${spec.label} 子进程启动失败：${error?.stack || error}`
      );
    }
  );

  child.once(
    'exit',
    (
      code,
      signal
    ) => {
      children.delete(
        spec.label
      );

      console.log(
        `[SuperLikeWorkers] ${spec.label} 已退出 | code=${code ?? '-'} | signal=${signal || '-'}`
      );

      if (stopping) {
        return;
      }

      console.log(
        `[SuperLikeWorkers] ${spec.label} 5秒后自动重启`
      );

      setTimeout(
        () =>
          startWorker(
            spec
          ),
        5000
      );
    }
  );
}

function stopAll() {
  if (stopping) {
    return;
  }

  stopping =
    true;

  console.log(
    '[SuperLikeWorkers] 正在停止全部 worker...'
  );

  for (
    const child
    of children.values()
  ) {
    try {
      child.kill(
        'SIGINT'
      );
    } catch {
      // ignore
    }
  }

  setTimeout(
    () => {
      for (
        const child
        of children.values()
      ) {
        try {
          child.kill(
            'SIGTERM'
          );
        } catch {
          // ignore
        }
      }
    },
    3000
  );
}

process.on(
  'SIGINT',
  stopAll
);

process.on(
  'SIGTERM',
  stopAll
);

console.log('');
console.log(
  '################################################'
);
console.log(
  '# SuperLike Worker Launcher'
);
console.log(
  '# Fresh: latest / hot / superlike / yishanshui / qa'
);
console.log(
  `# Fresh错峰：每个来源间隔 ${WORKER_STAGGER_MS / 1000} 秒；History最后启动`
);
console.log(
  '# History: 1 worker'
);
console.log(
  '# JYZ: disabled'
);
console.log(
  '# Database: PostgreSQL (DATABASE_URL)'
);
console.log(
  '# Resume: 统一 superlike_scan_resume(monitor_id, source_key)'
);
console.log(
  '# Checkpoint: 统一 superlike_scan_checkpoint(monitor_id, source_key)'
);
console.log(
  '# Scan分页: HTTP APIRequestContext'
);
console.log(
  '# fresh-qa实验: QA初始化后关闭Chromium，分页+Profile全HTTP'
);
console.log(
  '# Browser profile: 除fresh-qa外每个worker独立'
);
console.log(
  '# Playwright: 每个子worker启用共通防卡watchdog'
);
console.log(
  '# Windows: child console hidden'
);
console.log(
  '################################################'
);
console.log('');

if (
  WORKER_ONLY
  &&
  selectedWorkers.length === 0
) {
  console.error(
    `[SuperLikeWorkers] 未找到指定Worker：${WORKER_ONLY}`
  );
  process.exitCode = 1;
} else if (WORKER_ONLY) {
  console.log(
    `[SuperLikeWorkers] 单独启动：${WORKER_ONLY}`
  );
}

for (
  const spec
  of selectedWorkers
) {
  const delayMs =
    Number(
      spec.startDelayMs
      || 0
    );

  if (delayMs <= 0) {
    startWorker(
      spec
    );
    continue;
  }

  console.log(
    `[SuperLikeWorkers] ${spec.label} 错峰等待 ${Math.round(delayMs / 1000)} 秒后启动`
  );

  setTimeout(
    () =>
      startWorker(
        spec
      ),
    delayMs
  );
}
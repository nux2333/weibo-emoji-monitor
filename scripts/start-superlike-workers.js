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

const workers = [
  {
    label: 'fresh-latest',
    mode: 'fresh',
    source: 'latest-posts'
  },
  {
    label: 'fresh-superlike',
    mode: 'fresh',
    source: 'section-superlike'
  },
  {
    label: 'fresh-yishanshui',
    mode: 'fresh',
    source: 'section-yishanshui'
  },
  {
    label: 'fresh-qa',
    mode: 'fresh',
    source: 'section-qa'
  },
  {
    label: 'history',
    mode: 'history',
    source: ''
  }
];

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

  console.log(
    `[SuperLikeWorkers] 启动 ${spec.label} | mode=${spec.mode} | source=${spec.source || '-'}`
  );

  const child =
    spawn(
      process.execPath,
      [SCANNER],
      {
        cwd:
          ROOT,
        env,
        /*
         * 子 worker 自己通过 batch-logger 写入 logs/。
         * Launcher 不需要继承子进程 stdout/stderr。
         *
         * Windows 下 windowsHide=true 可以避免每个 worker
         * 弹出独立的黑色命令行窗口。
         */
        stdio:
          'ignore',
        windowsHide:
          true
      }
    );

  children.set(
    spec.label,
    child
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
  '# Fresh: latest / superlike / yishanshui / qa'
);
console.log(
  '# History: 1 worker'
);
console.log(
  '# JYZ: disabled'
);
console.log(
  '# SQLite: 共用同一个 WAL DB'
);
console.log(
  '# Browser profile: 每个 worker 独立'
);
console.log(
  '# Windows: child console hidden'
);
console.log(
  '################################################'
);
console.log('');

for (
  const spec
  of workers
) {
  startWorker(
    spec
  );
}

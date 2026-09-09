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

const JYZ_SERVICE =
  path.join(
    ROOT,
    'scripts',
    'jyz-service.js'
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

let jyzServiceChild =
  null;

let stopping =
  false;

function startJyzService() {
  if (
    stopping
    ||
    jyzServiceChild
  ) {
    return;
  }

  console.log(
    '[SuperLikeWorkers] 启动 JYZ Service | profile=data/superlike-browser-profile-scan'
  );

  const child =
    spawn(
      process.execPath,
      [JYZ_SERVICE],
      {
        cwd:
          ROOT,
        env:
          process.env,
        stdio:
          'inherit'
      }
    );

  jyzServiceChild =
    child;

  child.once(
    'exit',
    (
      code,
      signal
    ) => {
      jyzServiceChild =
        null;

      console.log(
        `[SuperLikeWorkers] JYZ Service 已退出 | code=${code ?? '-'} | signal=${signal || '-'}`
      );

      if (stopping) {
        return;
      }

      console.log(
        '[SuperLikeWorkers] JYZ Service 5秒后自动重启'
      );

      setTimeout(
        startJyzService,
        5000
      );
    }
  );
}


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
        stdio:
          'inherit'
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

  if (jyzServiceChild) {
    try {
      jyzServiceChild.kill(
        'SIGINT'
      );
    } catch {
      // ignore
    }
  }

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
  '# JYZ: 1 service，独占老主 scanner profile'
);
console.log(
  '# SQLite: 共用同一个 WAL DB'
);
console.log(
  '# Browser profile: 每个 worker 独立'
);
console.log(
  '################################################'
);
console.log('');

startJyzService();

for (
  const spec
  of workers
) {
  startWorker(
    spec
  );
}

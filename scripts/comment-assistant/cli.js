const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE_ROOT = path.join(ROOT, 'data', 'comment-assistant-profiles');
const LEGACY_PROFILE_DIR = path.join(ROOT, 'data', 'comment-assistant-profile');
const INDEX_JS = path.join(__dirname, 'index.js');
const PG_PRELOAD = path.join(ROOT, 'src', 'postgres-preload.js');
const LOOP_COMMENT_LIMIT = 20;
const FREQUENT_PATTERN = /(评论(?:操作)?(?:太|过于)?频繁|评论.*频繁|频繁.*评论|操作(?:太|过于)?频繁|操作频繁|请不要频繁)/i;

function hasProfileData(profileDir) {
  if (!fs.existsSync(profileDir)) return false;
  const candidates = [
    path.join(profileDir, 'Default', 'Network', 'Cookies'),
    path.join(profileDir, 'Default', 'Cookies'),
    path.join(profileDir, 'Local State')
  ];
  return candidates.some(file => fs.existsSync(file));
}

function getProfiles() {
  const profiles = [];

  if (fs.existsSync(LEGACY_PROFILE_DIR) && hasProfileData(LEGACY_PROFILE_DIR)) {
    profiles.push({ name: 'default', dir: LEGACY_PROFILE_DIR, legacy: true });
  }

  if (fs.existsSync(PROFILE_ROOT)) {
    const names = fs.readdirSync(PROFILE_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));

    for (const name of names) {
      const dir = path.join(PROFILE_ROOT, name);
      if (!hasProfileData(dir)) continue;
      profiles.push({ name, dir, legacy: false });
    }
  }

  return profiles;
}

function printProfiles(profiles) {
  if (!profiles.length) {
    console.log('没有找到已经使用过的评论账号 Profile。');
    return;
  }

  console.log('已保存的评论账号：');
  console.log('----------------------------------------------');
  profiles.forEach((profile, index) => {
    const legacy = profile.legacy ? ' (旧版默认Profile)' : '';
    console.log(`${index + 1}. ${profile.name}${legacy}`);
  });
  console.log('----------------------------------------------');
  console.log('单账号：npm run comment-assistant -- 1');
  console.log('循环全部账号1圈：npm run comment-assistant -- loop 1');
}

function buildEnv(profile, extraEnv = {}) {
  return {
    ...process.env,
    COMMENT_ACCOUNT: profile.name,
    COMMENT_ASSISTANT_PROFILE: profile.dir,
    ...extraEnv
  };
}

function runAssistant(profile) {
  const env = buildEnv(profile);

  console.log(`[账号选择] ID=${profile.id} | ${profile.name}`);

  const child = spawn(process.execPath, ['-r', PG_PRELOAD, INDEX_JS], {
    cwd: ROOT,
    env,
    stdio: 'inherit'
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 0;
  });
}

function runAssistantOnce(profile, round, totalRounds) {
  return new Promise(resolve => {
    const env = buildEnv(profile, {
      COMMENT_TARGET_LIMIT: String(LOOP_COMMENT_LIMIT),
      COMMENT_LOOP_MODE: '1',
      COMMENT_LOOP_ROUND: String(round)
    });

    console.log('\n============================================================');
    console.log(`[Loop ${round}/${totalRounds}] 开始账号 ID=${profile.id} | ${profile.name} | 本账号最多=${LOOP_COMMENT_LIMIT}条`);
    console.log('============================================================');

    const child = spawn(process.execPath, ['-r', PG_PRELOAD, INDEX_JS], {
      cwd: ROOT,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: false
    });

    let tail = '';
    let frequent = false;
    let stopping = false;

    const inspect = chunk => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-4000);
      if (!frequent && FREQUENT_PATTERN.test(tail)) {
        frequent = true;
        stopping = true;
        console.warn(`\n[Loop] ⚠️ 账号 ${profile.name} 检测到评论频繁，立即跳过该账号。`);
        child.kill();
      }
    };

    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      inspect(chunk);
    });
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      inspect(chunk);
    });

    child.on('error', error => {
      console.error(`[Loop] 账号 ${profile.name} 启动失败：${error.message}`);
      resolve({ code: 1, signal: null, frequent: false, error });
    });

    child.on('close', (code, signal) => {
      if (frequent) {
        console.log(`[Loop] 账号 ${profile.name} 已因评论频繁结束，继续下一个账号。`);
      } else if (signal && !stopping) {
        console.warn(`[Loop] 账号 ${profile.name} 被信号 ${signal} 终止，继续下一个账号。`);
      } else {
        console.log(`[Loop] 账号 ${profile.name} 完成 | exitCode=${code ?? '-'}。`);
      }
      resolve({ code, signal, frequent });
    });
  });
}

async function runLoop(profiles, loopCount) {
  if (!profiles.length) {
    console.error('没有找到已经登录过的评论账号 Profile，无法执行 loop。');
    process.exitCode = 1;
    return;
  }

  console.log(`[Loop] 共 ${profiles.length} 个账号 | 循环 ${loopCount} 圈 | 每账号每圈最多 ${LOOP_COMMENT_LIMIT} 条评论`);
  console.log(`[Loop] 总理论上限：${profiles.length * loopCount * LOOP_COMMENT_LIMIT} 条`);

  for (let round = 1; round <= loopCount; round += 1) {
    console.log(`\n#################### Loop ${round}/${loopCount} ####################`);
    for (const profile of profiles) {
      await runAssistantOnce(profile, round, loopCount);
    }
  }

  console.log(`\n[Loop] ✅ ${loopCount} 圈全部完成。`);
}

function runDefaultAssistant() {
  const child = spawn(process.execPath, ['-r', PG_PRELOAD, INDEX_JS], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit'
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 0;
  });
}

const arg = String(process.argv[2] || '').trim();
const secondArg = String(process.argv[3] || '').trim();
const profiles = getProfiles().map((profile, index) => ({ ...profile, id: index + 1 }));

if (/^(list|ls)$/i.test(arg)) {
  printProfiles(profiles);
} else if (/^loop$/i.test(arg)) {
  const loopCount = Number(secondArg || 1);
  if (!Number.isInteger(loopCount) || loopCount < 1) {
    console.error('loop 次数必须是大于等于 1 的整数，例如：npm run comment-assistant -- loop 1');
    process.exitCode = 1;
  } else {
    runLoop(profiles, loopCount).catch(error => {
      console.error(`[Loop] 异常：${error.message}`);
      process.exitCode = 1;
    });
  }
} else if (/^\d+$/.test(arg)) {
  const id = Number(arg);
  const profile = profiles.find(item => item.id === id);
  if (!profile) {
    console.error(`没有账号 ID=${id}。`);
    printProfiles(profiles);
    process.exitCode = 1;
  } else {
    runAssistant(profile);
  }
} else if (arg) {
  const profile = profiles.find(item => item.name === arg);
  if (!profile) {
    console.error(`没有找到账号：${arg}`);
    printProfiles(profiles);
    process.exitCode = 1;
  } else {
    runAssistant(profile);
  }
} else {
  runDefaultAssistant();
}

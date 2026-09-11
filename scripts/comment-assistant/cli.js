const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE_ROOT = path.join(ROOT, 'data', 'comment-assistant-profiles');
const LEGACY_PROFILE_DIR = path.join(ROOT, 'data', 'comment-assistant-profile');
const INDEX_JS = path.join(__dirname, 'index.js');
const PG_PRELOAD = path.join(ROOT, 'src', 'postgres-preload.js');

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
    profiles.push({
      name: 'default',
      dir: LEGACY_PROFILE_DIR,
      legacy: true
    });
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
    console.log(`Profile目录：${PROFILE_ROOT}`);
    return;
  }

  console.log('已保存的评论账号：');
  console.log('----------------------------------------------');
  profiles.forEach((profile, index) => {
    const legacy = profile.legacy ? ' (旧版默认Profile)' : '';
    console.log(`${index + 1}. ${profile.name}${legacy}`);
    console.log(`   ${profile.dir}`);
  });
  console.log('----------------------------------------------');
  console.log('启动示例：npm run comment-assistant -- 1');
}

function runAssistant(profile) {
  const env = {
    ...process.env,
    COMMENT_ACCOUNT: profile.name,
    COMMENT_ASSISTANT_PROFILE: profile.dir
  };

  console.log(`[账号选择] ID=${profile.id} | ${profile.name}`);
  console.log(`[账号选择] Profile=${profile.dir}`);

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
const profiles = getProfiles().map((profile, index) => ({
  ...profile,
  id: index + 1
}));

if (/^(list|ls)$/i.test(arg)) {
  printProfiles(profiles);
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

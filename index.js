import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MARKER = 'local-kimi-cli-login'; // Local registration marker, not a credential.
const SCOPED_MARKER = 'local-kimi-cli-login:scoped';
const kimiRoot = () => process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
const tokenFile = account => join(kimiRoot(), 'credentials', `${account.credentialName}.json`);
const helper = fileURLToPath(new URL('./token.ps1', import.meta.url));
const renewals = new Map();

const primary = {
  id: 'kimi-cli', name: 'Kimi CLI 登录', suffix: 'CLI 登录',
  base: 'https://api.kimi.com/coding/v1', oauthHost: 'https://auth.kimi.com',
  credentialName: 'kimi-code',
};

function section(source, name) {
  const start = source.indexOf(`[${name}]`);
  if (start < 0) throw new Error(`Kimi CLI 配置缺少 ${name}。`);
  const end = source.indexOf('\n[', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

function quoted(sectionText, name) {
  const match = sectionText.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"\\s*$`, 'm'));
  if (!match) throw new Error(`Kimi CLI 配置缺少 ${name}。`);
  return match[1];
}

async function scopedAccount() {
  const config = await readFile(join(kimiRoot(), 'config.toml'), 'utf8');
  const base = quoted(section(config, 'providers."managed:kimi-code"'), 'base_url');
  const oauth = section(config, 'providers."managed:kimi-code".oauth');
  const key = quoted(oauth, 'key');
  const oauthHost = quoted(oauth, 'oauth_host');
  const credentialName = key.replace(/^oauth\//, '');
  if (!/^kimi-code-env-[0-9a-f]{16}$/.test(credentialName) ||
      !['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1'].includes(base) ||
      !['https://auth.kimi.com', 'https://auth.kimi.ai'].includes(oauthHost)) {
    throw new Error('Kimi CLI 环境账号配置不受支持。');
  }
  return { name: 'Kimi CLI 环境账号', suffix: 'CLI 环境账号', base, oauthHost, credentialName };
}

async function accountFor(stored) {
  if (!stored || stored.key === MARKER) return primary;
  if (stored.key === SCOPED_MARKER) return scopedAccount();
  throw new Error('未知的 Kimi CLI 登录标记，请重新连接账号。');
}

function loginMethod(label, resolve, marker) {
  return {
    type: 'oauth', label,
    authorize: async () => {
      const account = await resolve();
      await getToken(account);
      return {
        url: '', method: 'auto',
        instructions: `正在连接${account.name}，无需复制密钥或重新网页登录。`,
        callback: async () => ({ type: 'success', key: marker }),
      };
    },
  };
}

async function getToken(account, force = false) {
  let token;
  try { token = JSON.parse(await readFile(tokenFile(account), 'utf8')); }
  catch { throw new Error('找不到 Kimi CLI 登录。请先在本机运行 kimi login。'); }
  if (!token.access_token) throw new Error('Kimi CLI 尚未登录，请运行 kimi login。');
  if (!force && Number(token.expires_at) > Date.now() / 1000 + 300) return token.access_token;
  let renewal = renewals.get(account.credentialName);
  if (!renewal) {
    renewal = (async () => {
      const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      try {
        const args = ['-NoProfile', '-NonInteractive', '-File', helper,
          '-CredentialName', account.credentialName, '-OAuthHost', account.oauthHost, '-ApiBase', account.base];
        if (force) args.push('-ForceRefresh');
        const { stdout } = await run(shell, args, { windowsHide: true, timeout: 60000, maxBuffer: 65536 });
        const value = stdout.trim();
        if (!value || /\s/.test(value)) throw new Error('Invalid token output');
        return value;
      } catch { throw new Error('Kimi CLI 登录刷新失败，请打开 Kimi CLI 检查登录状态。'); }
    })().finally(() => { renewals.delete(account.credentialName); });
    renewals.set(account.credentialName, renewal);
  }
  return renewal;
}

async function authenticatedFetch(account, input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== new URL(account.base).origin || !url.pathname.startsWith('/coding/v1/')) {
    throw new Error('Kimi CLI 凭据只能发送至所属账号的 Kimi Code API。');
  }
  async function send(force) {
    const headers = new Headers(request.headers);
    headers.delete('x-api-key');
    headers.set('Authorization', `Bearer ${await getToken(account, force)}`);
    return fetch(new Request(request.clone(), { headers, redirect: 'manual' }));
  }
  let response = await send(false);
  if (response.status === 401) {
    await response.body?.cancel();
    response = await send(true);
  }
  return response;
}

function configModel(id, name, context, efforts = ['low', 'high', 'max']) {
  return {
    id, name, reasoning: true, attachment: true, tool_call: true,
    limit: { context, output: 32768 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: Object.fromEntries(efforts.map(effort => [effort, { reasoningEffort: effort }])),
  };
}

export const KimiCLILoginPlugin = async () => {
  const { id, name, suffix, base } = primary;
  return {
  config: async config => {
    config.provider ??= {};
    config.provider[id] = {
      name, npm: '@ai-sdk/openai', api: base,
      options: { baseURL: base },
      models: {
        'kimi-for-coding': configModel('kimi-for-coding', `K2.8 Preview · ${suffix}`, 1048576),
        'kimi-for-coding-highspeed': configModel('kimi-for-coding-highspeed', `K2.7 Code Highspeed · ${suffix}`, 262144, ['high']),
        'k3': configModel('k3', `K3 · ${suffix}`, 1048576),
        'k3-256k': configModel('k3-256k', `K3 256K · ${suffix}`, 262144),
      },
    };
  },
  auth: {
    provider: id,
    methods: [
      loginMethod('复用本机 Kimi CLI 默认账号', async () => primary, MARKER),
      loginMethod('复用本机 Kimi CLI 环境账号', scopedAccount, SCOPED_MARKER),
    ],
    loader: async getAuth => {
      const account = await accountFor(await getAuth());
      return { baseURL: account.base, apiKey: MARKER, fetch: (input, init) => authenticatedFetch(account, input, init) };
    },
    usage: async getAuth => {
      const account = await accountFor(await getAuth());
      const { base } = account;
      const planRequest = authenticatedFetch(account, `${base}/me`, { signal: AbortSignal.timeout(5000) })
        .then(async response => response.ok ? response.json() : null)
        .then(account => typeof account?.user_level_name === 'string' ? account.user_level_name.trim() : '')
        .catch(() => '');
      const response = await authenticatedFetch(account, `${base}/usages`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Kimi 额度读取失败（HTTP ${response.status}）。`);
      const payload = await response.json();
      const windows = [];
      for (const [key, name, span] of [['limit_5h', '5h', 18000], ['limit_7d', '7d', 604800]]) {
        const entry = payload.usages?.[key];
        if (typeof entry?.used_ratio !== 'number' || !Number.isFinite(entry.used_ratio) || entry.used_ratio < 0) continue;
        const window = { name, used: entry.used_ratio * 100, span };
        if (typeof entry.reset_time === 'string' && Number.isFinite(Date.parse(entry.reset_time))) {
          window.resetsAt = entry.reset_time;
        }
        windows.push(window);
      }
      if (!windows.length) throw new Error('Kimi 未返回可识别的 5 小时或 7 天额度。');
      return { plan: await planRequest, user: account.name, windows };
    },
  },
  provider: {
    id,
    models: async (given, options) => {
      const account = await accountFor(options?.auth);
      const { base, suffix } = account;
      const response = await authenticatedFetch(account, `${base}/models`);
      if (!response.ok) throw new Error(`Kimi 模型列表读取失败（HTTP ${response.status}）。`);
      const payload = await response.json();
      const out = {};
      for (const m of payload.data || []) {
        if (!m.id) continue;
        const prior = given.models[m.id] || {};
        const efforts = m.think_efforts?.valid_efforts || ['high'];
        out[m.id] = {
          ...prior, id: m.id, providerID: id,
          name: `${m.display_name || m.id} · ${suffix}`,
          api: { id: m.id, url: base, npm: '@ai-sdk/openai' },
          limit: { context: m.context_length || prior.limit?.context || 262144, output: 32768 },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          capabilities: {
            temperature: true, reasoning: !!m.supports_reasoning, attachment: !!m.supports_image_in,
            toolcall: true, input: { text: true, image: !!m.supports_image_in }, output: { text: true },
          },
          options: {}, headers: {},
          variants: Object.fromEntries(efforts.map(effort => [effort, { reasoningEffort: effort }])),
        };
      }
      if (!Object.keys(out).length) throw new Error('Kimi 账号未返回可用模型。');
      return out;
    },
  },
  };
};

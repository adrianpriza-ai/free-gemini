// 🧪 Deterministic process.env for adapter tests.
//
// The shared core (src/config.js → mergePlatformEnv) merges process.env into
// every request's config, so machine-specific vars would make assertions
// flaky. We scrub outbound-proxy vars (they flip /health proxy.mode between
// 'direct' and 'outbound') and pin API_KEY to the DEFAULT_CONFIG value.

const SET_EMPTY = [
  'HTTPS_PROXY', 'https_proxy',
  'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy',
];

const REMOVE = ['NETLIFY', 'VERCEL', 'API_KEYS', 'API-KEY'];

/**
 * Scrub env vars that would make adapter tests machine-dependent.
 * Returns a restore() function to undo every change.
 */
export function setupTestEnv() {
  const saved = new Map();
  for (const key of [...SET_EMPTY, ...REMOVE]) saved.set(key, process.env[key]);

  for (const key of SET_EMPTY) process.env[key] = '';
  for (const key of REMOVE) delete process.env[key];
  process.env.API_KEY = 'sk-gemini'; // must match DEFAULT_CONFIG.apiKeys

  return function restore() {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Build a Request against the test origin. */
export function req(path, init) {
  return new Request('http://localhost' + path, init);
}

/** Fetch a JSON endpoint through an adapter call and return status + body. */
export async function jsonOf(response) {
  const body = await response.json();
  return { status: response.status, headers: response.headers, body };
}

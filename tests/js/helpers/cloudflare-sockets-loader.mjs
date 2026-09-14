// 🧪 Custom ESM loader that stubs the 'cloudflare:sockets' built-in module
// (available only inside Cloudflare Workers) so cloudflare/worker.js can be
// imported under plain Node.js in tests.
//
// Used via module.register() from adapters.cloudflare.test.mjs.

const STUB_SOURCE = [
  "// Test stub for the 'cloudflare:sockets' Workers-only built-in.",
  '// The proxy pool never runs in tests; every call fails loudly.',
  'export function connect() {',
  "  return Promise.reject(new Error('cloudflare:sockets is stubbed in tests'));",
  '}',
].join('\n');

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:sockets') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(STUB_SOURCE),
    };
  }
  return nextResolve(specifier, context);
}

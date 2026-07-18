// Run: npm install --save-dev vitest  →  then  npm test
/** @type {import('vitest/config').UserConfig} */
module.exports = {
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: true,
    testTimeout: 15000,
    // DAEMON-AUTOSTART-3-V1: ruflo >=3.32 auto-spawns a detached daemon on
    // every CLI invocation for the caller's cwd. Several suites spawn hook
    // helpers (ruflo-train, route-capture, …) that exec `ruflo` from tmp-dir
    // fixtures — cwds no claude-flow.config.json gate can cover. Pinning the
    // opt-out here reaches every child the suite spawns (observed: render
    // storms after full-suite runs kept finding one fresh tempdir daemon).
    env: { RUFLO_DAEMON_AUTOSTART: '0' },
  },
};

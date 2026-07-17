// Run: npm install --save-dev vitest  →  then  npm test
/** @type {import('vitest/config').UserConfig} */
module.exports = {
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: true,
    testTimeout: 15000,
  },
};

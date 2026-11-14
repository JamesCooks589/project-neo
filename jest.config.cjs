/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: [
    '<rootDir>/packages/workflow-core/dist/test',
    '<rootDir>/packages/http-adapter/dist/test',
    '<rootDir>/tools/fixture-api/dist/test',
    '<rootDir>/tools/runner/dist/test',
  ],
  testMatch: ['**/*.test.js'],
  transform: {},
  collectCoverageFrom: [
    'packages/*/dist/src/**/*.js',
    'tools/*/dist/src/**/*.js',
    '!**/cli.js',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: { branches: 85, functions: 90, lines: 90, statements: 90 },
  },
  clearMocks: true,
};

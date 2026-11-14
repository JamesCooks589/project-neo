/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/packages/workflow-core/dist/test'],
  testMatch: ['**/*.test.js'],
  transform: {},
  collectCoverageFrom: ['packages/workflow-core/dist/src/**/*.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: { branches: 85, functions: 90, lines: 90, statements: 90 },
  },
  clearMocks: true,
};

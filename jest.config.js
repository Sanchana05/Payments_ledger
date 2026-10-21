/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Concurrency/crash tests talk to a real PostgreSQL; run files serially.
  maxWorkers: 1,
  testTimeout: 180000,
};

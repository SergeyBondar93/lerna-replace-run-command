"use strict";

module.exports = {
  // ensure `npm cit` uses clean cache
  cacheDirectory: "./node_modules/.cache/jest",
  clearMocks: true,
  // windows ci is terribly slow, so let's not burden it with coverage
  collectCoverage: process.env.CI && process.env.TRAVIS_OS_NAME !== "windows",
  collectCoverageFrom: [
    "{commands,core,utils}/**/*.js",
    "!commands/create/lerna-module-data.js",
    "!**/__helpers__/**",
  ],
  modulePathIgnorePatterns: ["/__fixtures__/"],
  // roots: ["<rootDir>/commands", "<rootDir>/core", "<rootDir>/utils"],
  setupFiles: ["./helpers/silence-logging"],
  setupFilesAfterEnv: ["<rootDir>/setup-unit-test-timeout.js"],
  testEnvironment: "node",
  testRunner: "jest-circus/runner",
};
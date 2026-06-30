module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', {}],
  },
  collectCoverageFrom: ['src/**/*.(t|j)s', '!src/**/*.spec.ts', '!src/main.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  // 静默 NestJS Logger(避免 controller.content() 的防御性 error handler 污染 stderr)
  setupFiles: ['<rootDir>/test/logger.setup.cjs'],
  // nanoid v5 纯 ESM,在 CJS 测试环境用本地 CJS mock 替换
  moduleNameMapper: {
    '^nanoid$': '<rootDir>/test/mocks/nanoid.cjs',
  },
};

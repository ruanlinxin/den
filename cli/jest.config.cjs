module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  // cli 源是 ESM(type:module + module ESNext),ts-jest 编译为 CJS 供 jest 运行
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'commonjs',
          moduleResolution: 'node',
          esModuleInterop: true,
          strict: true,
          types: ['node', 'jest'],
          skipLibCheck: true,
          lib: ['ES2023'],
        },
      },
    ],
  },
};

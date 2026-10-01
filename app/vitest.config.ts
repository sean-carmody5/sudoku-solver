import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // CV + ONNX tests run real images through the pipeline; keep them from
    // flaking when the machine is busy (e.g. a training run alongside).
    testTimeout: 30000,
    hookTimeout: 60000,
  },
})
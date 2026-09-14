import { defineConfig } from 'tsdown'
import { karakaBundle } from '../tsdown.ts'

export default defineConfig(({ env }) => karakaBundle(['index'], env?.DSH_BUILD_FACE, true))

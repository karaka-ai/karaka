import { defineConfig } from 'tsdown'
import { karakaBundle } from '../tsdown.ts'

export default defineConfig(({ env }) => karakaBundle(['index', 'session-reference'], env?.DSH_BUILD_FACE))

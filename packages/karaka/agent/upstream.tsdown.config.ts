/** Build upstream packages with their own configs; Karaka owns a separate artifact pass. */
import { fileURLToPath } from 'node:url'
import upstream from '../../../tsdown.config.ts'
export default (options: Parameters<typeof upstream>[0]) => {
  const config = upstream(options)
  return { ...config, cwd: fileURLToPath(new URL('../../../', import.meta.url)), workspace: [...config.workspace, '!packages/karaka/*'] }
}

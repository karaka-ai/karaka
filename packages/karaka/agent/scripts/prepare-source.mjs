/** Keep the application source launcher on the repository's source import map. */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

await writeFile(fileURLToPath(new URL('../../../../tsconfig.karaka.json', import.meta.url)), JSON.stringify({
  extends: './tsconfig.base.json',
  files: [],
}, null, 2) + '\n')

/** Build the source resolver from the unchanged upstream map plus Karaka additions. */
import ts from 'typescript'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const upstream = ts.readConfigFile(resolve(root, 'tsconfig.base.json'), ts.sys.readFile)
if (upstream.error) throw new Error(ts.flattenDiagnosticMessageText(upstream.error.messageText, '\n'))
const paths = { ...upstream.config.compilerOptions.paths }
for (const name of ['agent', 'identity', 'server-auth', 'browser-auth', 'transport-http', 'mcp-application']) {
  paths[`@karaka-ai/${name}`] = [`./packages/karaka/${name}/src/index.ts`]
}
paths['@karaka-ai/identity/session-reference'] = ['./packages/karaka/identity/src/session-reference.ts']
paths['@karaka-ai/mcp-application/tool-policy'] = ['./packages/karaka/mcp-application/src/tool-policy.ts']
paths['@karaka-ai/transport-http/browser'] = ['./packages/karaka/transport-http/src/browser.ts']
paths['@karaka-ai/agent/tool-policy'] = ['./packages/karaka/agent/src/tool-policy.ts']
paths['@karaka-ai/agent/tools'] = ['./packages/karaka/agent/src/tools.ts']
await writeFile(resolve(root, 'tsconfig.karaka.json'), JSON.stringify({
  extends: './tsconfig.base.json',
  compilerOptions: { paths },
  files: [],
}, null, 2) + '\n')

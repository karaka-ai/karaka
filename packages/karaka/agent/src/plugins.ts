/** Bundled Cordis modules exposed to Karaka compositions. */

import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import * as plugin93 from '@deepseek-ai/cordis-plugin-hmr'
import * as plugin94 from '@deepseek-ai/cordis-plugin-timer'
import * as plugin0 from '@deepseek-ai/dsh-agent'
import * as plugin1 from '@deepseek-ai/dsh-agent-default-model'
import * as plugin2 from '@deepseek-ai/dsh-agent-instructions'
import * as plugin3 from '@deepseek-ai/dsh-agent-loop'
import * as plugin4 from '@deepseek-ai/dsh-agent-presets'
import * as plugin5 from '@deepseek-ai/dsh-api-gateway'
import * as plugin6 from '@deepseek-ai/dsh-api-session-controller'
import * as plugin7 from '@deepseek-ai/dsh-attachment-local'
import * as plugin8 from '@deepseek-ai/dsh-bash-sandbox'
import * as plugin9 from '@deepseek-ai/dsh-command-compact'
import * as plugin10 from '@deepseek-ai/dsh-command-feedback'
import * as plugin11 from '@deepseek-ai/dsh-command-goal'
import * as plugin12 from '@deepseek-ai/dsh-commands'
import * as plugin13 from '@deepseek-ai/dsh-compaction-basic'
import * as plugin14 from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import * as plugin15 from '@deepseek-ai/dsh-credentials-local'
import * as plugin16 from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as plugin17 from '@deepseek-ai/dsh-fs-observation-policy'
import * as plugin18 from '@deepseek-ai/dsh-fs-sandbox'
import * as plugin19 from '@deepseek-ai/dsh-goal'
import * as plugin20 from '@deepseek-ai/dsh-goal-round-driver'
import * as plugin21 from '@deepseek-ai/dsh-host-webserver'
import * as plugin22 from '@deepseek-ai/dsh-jobs-local'
import * as plugin23 from '@deepseek-ai/dsh-llm'
import * as plugin24 from '@deepseek-ai/dsh-llm-deepseek'
import * as plugin25 from '@deepseek-ai/dsh-llm-pi-ai'
import * as plugin26 from '@deepseek-ai/dsh-llm-retry'
import * as plugin27 from '@deepseek-ai/dsh-permission-presets'
import * as plugin28 from '@deepseek-ai/dsh-plan-mode'
import * as plugin29 from '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
import * as plugin30 from '@deepseek-ai/dsh-pwsh-sandbox'
import * as plugin31 from '@deepseek-ai/dsh-repeat-tool-reminder'
import * as plugin32 from '@deepseek-ai/dsh-sandbox-local'
import * as plugin33 from '@deepseek-ai/dsh-sandbox-policy'
import * as plugin34 from '@deepseek-ai/dsh-session'
import * as plugin35 from '@deepseek-ai/dsh-session-checkpoint-policy'
import * as plugin36 from '@deepseek-ai/dsh-session-log-deepseek'
import * as plugin37 from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as plugin38 from '@deepseek-ai/dsh-session-persistence-sqlite'
import * as plugin39 from '@deepseek-ai/dsh-session-projection'
import * as plugin40 from '@deepseek-ai/dsh-session-projection-cache'
import * as plugin41 from '@deepseek-ai/dsh-session-query-sqlite'
import * as plugin42 from '@deepseek-ai/dsh-session-telemetry-otel'
import * as plugin43 from '@deepseek-ai/dsh-session-title'
import * as plugin44 from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import * as plugin45 from '@deepseek-ai/dsh-settings-file'
import * as plugin46 from '@deepseek-ai/dsh-shell-env'
import * as plugin47 from '@deepseek-ai/dsh-skill'
import * as plugin48 from '@deepseek-ai/dsh-skill-badge'
import * as plugin49 from '@deepseek-ai/dsh-skill-filesystem'
import * as plugin50 from '@deepseek-ai/dsh-spill-local'
import * as plugin51 from '@deepseek-ai/dsh-spill-policy'
import * as plugin52 from '@deepseek-ai/dsh-storage'
import * as plugin53 from '@deepseek-ai/dsh-storage-domain'
import * as plugin54 from '@deepseek-ai/dsh-storage-json'
import * as plugin55 from '@deepseek-ai/dsh-subagent'
import * as plugin56 from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as plugin57 from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as plugin58 from '@deepseek-ai/dsh-subprocess-local'
import * as plugin59 from '@deepseek-ai/dsh-system-prompt'
import * as plugin60 from '@deepseek-ai/dsh-token-meter'
import * as plugin61 from '@deepseek-ai/dsh-tool-bash'
import * as plugin62 from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as plugin63 from '@deepseek-ai/dsh-tool-fs'
import * as plugin64 from '@deepseek-ai/dsh-tool-fs-search'
import * as plugin65 from '@deepseek-ai/dsh-tool-goal'
import * as plugin66 from '@deepseek-ai/dsh-tool-jobs'
import * as plugin67 from '@deepseek-ai/dsh-tool-pwsh'
import * as plugin68 from '@deepseek-ai/dsh-tool-ralph'
import * as plugin69 from '@deepseek-ai/dsh-tool-skill'
import * as plugin70 from '@deepseek-ai/dsh-tool-str-replace-editor'
import * as plugin71 from '@deepseek-ai/dsh-tool-subagent'
import * as plugin72 from '@deepseek-ai/dsh-tool-subagent-control'
import * as plugin73 from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import * as plugin74 from '@deepseek-ai/dsh-tool-subagent-report'
import * as plugin75 from '@deepseek-ai/dsh-tool-todo'
import * as plugin76 from '@deepseek-ai/dsh-tool-web'
import * as plugin77 from '@deepseek-ai/dsh-tool-workflow'
import * as plugin78 from '@deepseek-ai/dsh-tools'
import * as plugin79 from '@deepseek-ai/dsh-typert-loader'
import * as plugin80 from '@deepseek-ai/dsh-typert-registry'
import * as plugin81 from '@deepseek-ai/dsh-user-approval'
import * as plugin82 from '@deepseek-ai/dsh-user-questions'
import * as plugin83 from '@deepseek-ai/dsh-web'
import * as plugin84 from '@deepseek-ai/dsh-web-fetch-http'
import * as plugin85 from '@deepseek-ai/dsh-web-search-deepseek'
import * as plugin86 from '@deepseek-ai/dsh-workflow-worker-thread'
import * as plugin87 from '@deepseek-ai/dsh-workspace'
import * as plugin88 from '@karaka-ai/mcp-application'
import * as plugin89 from '@karaka-ai/server-auth'
import * as plugin90 from '@karaka-ai/transport-http'
import * as plugin91 from '@deepseek-ai/dsh-persona'
import * as plugin92 from '@deepseek-ai/dsh-agent-tool-presentation'

/** Karaka-owned module names resolved before local package resolution. */
export const bundledPlugins: Readonly<Record<string, unknown>> = Object.freeze({
  '@karaka-ai/agent/agent': plugin0,
  '@karaka-ai/agent/agent-default-model': plugin1,
  '@karaka-ai/agent/agent-instructions': plugin2,
  '@karaka-ai/agent/agent-loop': plugin3,
  '@karaka-ai/agent/agent-presets': plugin4,
  '@karaka-ai/agent/api-gateway': plugin5,
  '@karaka-ai/agent/api-session-controller': plugin6,
  '@karaka-ai/agent/attachment-local': plugin7,
  '@karaka-ai/agent/bash-sandbox': plugin8,
  '@karaka-ai/agent/command-compact': plugin9,
  '@karaka-ai/agent/command-feedback': plugin10,
  '@karaka-ai/agent/command-goal': plugin11,
  '@karaka-ai/agent/commands': plugin12,
  '@karaka-ai/agent/compaction-basic': plugin13,
  '@karaka-ai/agent/compaction-tool-result-pruner': plugin14,
  '@karaka-ai/agent/credentials-local': plugin15,
  '@karaka-ai/agent/deepseek-llm-api-extensions': plugin16,
  '@karaka-ai/agent/fs-observation-policy': plugin17,
  '@karaka-ai/agent/fs-sandbox': plugin18,
  '@karaka-ai/agent/goal': plugin19,
  '@karaka-ai/agent/goal-round-driver': plugin20,
  '@karaka-ai/agent/host-webserver': plugin21,
  '@karaka-ai/agent/jobs-local': plugin22,
  '@karaka-ai/agent/llm': plugin23,
  '@karaka-ai/agent/llm-deepseek': plugin24,
  '@karaka-ai/agent/llm-pi-ai': plugin25,
  '@karaka-ai/agent/llm-retry': plugin26,
  '@karaka-ai/agent/permission-presets': plugin27,
  '@karaka-ai/agent/plan-mode': plugin28,
  '@karaka-ai/agent/plugin-package-inventory-deepseek': plugin29,
  '@karaka-ai/agent/pwsh-sandbox': plugin30,
  '@karaka-ai/agent/repeat-tool-reminder': plugin31,
  '@karaka-ai/agent/sandbox-local': plugin32,
  '@karaka-ai/agent/sandbox-policy': plugin33,
  '@karaka-ai/agent/session': plugin34,
  '@karaka-ai/agent/session-checkpoint-policy': plugin35,
  '@karaka-ai/agent/session-log-deepseek': plugin36,
  '@karaka-ai/agent/session-persistence-jsonl': plugin37,
  '@karaka-ai/agent/session-persistence-sqlite': plugin38,
  '@karaka-ai/agent/session-projection': plugin39,
  '@karaka-ai/agent/session-projection-cache': plugin40,
  '@karaka-ai/agent/session-query-sqlite': plugin41,
  '@karaka-ai/agent/session-telemetry-otel': plugin42,
  '@karaka-ai/agent/session-title': plugin43,
  '@karaka-ai/agent/session-title-first-prompt-llm': plugin44,
  '@karaka-ai/agent/settings-file': plugin45,
  '@karaka-ai/agent/shell-env': plugin46,
  '@karaka-ai/agent/skill': plugin47,
  '@karaka-ai/agent/skill-badge': plugin48,
  '@karaka-ai/agent/skill-filesystem': plugin49,
  '@karaka-ai/agent/spill-local': plugin50,
  '@karaka-ai/agent/spill-policy': plugin51,
  '@karaka-ai/agent/storage': plugin52,
  '@karaka-ai/agent/storage-domain': plugin53,
  '@karaka-ai/agent/storage-json': plugin54,
  '@karaka-ai/agent/subagent': plugin55,
  '@karaka-ai/agent/subagent-fork-in-process': plugin56,
  '@karaka-ai/agent/subagent-spawn-in-process': plugin57,
  '@karaka-ai/agent/subprocess-local': plugin58,
  '@karaka-ai/agent/system-prompt': plugin59,
  '@karaka-ai/agent/token-meter': plugin60,
  '@karaka-ai/agent/tool-bash': plugin61,
  '@karaka-ai/agent/tool-call-timeout-policy': plugin62,
  '@karaka-ai/agent/tool-fs': plugin63,
  '@karaka-ai/agent/tool-fs-search': plugin64,
  '@karaka-ai/agent/tool-goal': plugin65,
  '@karaka-ai/agent/tool-jobs': plugin66,
  '@karaka-ai/agent/tool-pwsh': plugin67,
  '@karaka-ai/agent/tool-ralph': plugin68,
  '@karaka-ai/agent/tool-skill': plugin69,
  '@karaka-ai/agent/tool-str-replace-editor': plugin70,
  '@karaka-ai/agent/tool-subagent': plugin71,
  '@karaka-ai/agent/tool-subagent-control': plugin72,
  '@karaka-ai/agent/tool-subagent-control/list-agents': plugin73,
  '@karaka-ai/agent/tool-subagent-report': plugin74,
  '@karaka-ai/agent/tool-todo': plugin75,
  '@karaka-ai/agent/tool-web': plugin76,
  '@karaka-ai/agent/tool-workflow': plugin77,
  '@karaka-ai/agent/tools': plugin78,
  '@karaka-ai/agent/typert-loader': plugin79,
  '@karaka-ai/agent/typert-registry': plugin80,
  '@karaka-ai/agent/user-approval': plugin81,
  '@karaka-ai/agent/user-questions': plugin82,
  '@karaka-ai/agent/web': plugin83,
  '@karaka-ai/agent/web-fetch-http': plugin84,
  '@karaka-ai/agent/web-search-deepseek': plugin85,
  '@karaka-ai/agent/workflow-worker-thread': plugin86,
  '@karaka-ai/agent/workspace': plugin87,
  '@karaka-ai/agent/mcp-application': plugin88,
  '@karaka-ai/agent/server-auth': plugin89,
  '@karaka-ai/agent/transport-http': plugin90,
  '@karaka-ai/agent/persona': plugin91,
  '@karaka-ai/agent/agent-tool-presentation': plugin92,
  '@karaka-ai/agent/hmr': plugin93,
  '@karaka-ai/agent/timer': plugin94,
})

/**
 * Install Karaka's bundled modules into one Loader instance.
 * @param loader - Loader that will mount the Karaka host and Agent Presets.
 */
export function installBundledPlugins(loader: Loader): void {
  for (const [name, plugin] of Object.entries(bundledPlugins)) {
    loader.builtins[name] = plugin
  }
}

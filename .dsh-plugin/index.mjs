/**
 * Host plugin of @ljwei-stak/dsh-compositor for DeepSeek Harness.
 *
 * Gives Harness agents everything needed to build and edit Compositor
 * (.comp) image projects: live format documentation read from the synced
 * github.com/robbietilton/Compositor checkout, a forward-compatible
 * validator, atomic manifest writes, layer PNG/mask generation and a
 * best-effort flattened preview. The checkout is the single source of truth
 * — nothing about the format is frozen in the plugin, so `git pull` in the
 * checkout is all it takes to follow upstream.
 */
import z from '@deepseek-ai/schemastery'
import { loadRepoDocs } from './shared/comp-docs.mjs'
import { buildCompositorTools } from './shared/comp-tools.mjs'

/** Cordis plugin name; equals the profile entry id in cordis.patch.yml. */
export const name = 'dsh-compositor'
/** Optional services only; registration happens through ctx.inject(['tools']). */
export const inject = []

export const Config = z.object({
  repoDir: z.string().default('F:\\everyAI\\dsh-Compositor\\Compositor').description('Compositor 源码库（git clone）的本地路径。插件的格式知识（blend modes、adjustment kinds、版本上限、各种限制）都从这个库的 docs/ 实时解析，git pull 之后自动跟上上游更新。'),
  agentTools: z.boolean().default(true).description('向 Harness 的 Agent 提供 compositor_* 工具（文档、校验、原子写入、图层 PNG、预览、清理）。'),
  previewEnabled: z.boolean().default(true).description('启用 compositor_preview（需要可选依赖 sharp 做图片解码；未安装时工具会明确报告）。'),
  docsMaxChars: z.number().step(1000).min(10000).max(2000000).default(200000).description('compositor_docs 单次返回的文档字符上限。'),
}).description('Compositor 图像项目工具')

/**
 * Register the agent tools once the host's `tools` service is up (optional:
 * without it the plugin simply contributes nothing, never fails the boot).
 */
export function registerAgentTools(ctx, state = {}, definitions = null) {
  if (typeof ctx?.inject !== 'function') { state.error = 'no inject'; return null }
  try {
    return ctx.inject(['tools'], toolCtx => {
      toolCtx.effect(() => {
        const tools = definitions ?? buildCompositorTools({ config: toolCtx.config ?? {} })
        const disposers = tools.map(tool => toolCtx.tools.register(tool))
        state.registered = tools.length
        return () => {
          state.registered = 0
          for (const disposer of disposers) { try { disposer?.() } catch { /* gone */ } }
        }
      }, 'dsh-compositor: agent tools')
    })
  } catch (error) {
    state.error = String(error?.message ?? error)
    return null
  }
}

export function apply(ctx, config = {}) {
  const state = { registered: 0 }

  if (config.agentTools === false) {
    ctx.logger.info('agent tools disabled by settings')
    return
  }

  // Report the checkout status once at startup: it is the compatibility
  // contract, so make it visible when it is missing or unreadable.
  loadRepoDocs(config.repoDir || 'F:\\everyAI\\dsh-Compositor\\Compositor')
    .then(docs => {
      if (!docs.repoExists) ctx.logger.warn(`Compositor checkout not found at ${docs.repoDir} — tools will run on built-in fallback docs; set the repoDir setting to the git clone of github.com/robbietilton/Compositor`)
      else ctx.logger.info(`using Compositor checkout ${docs.repoDir}${docs.git?.commit ? ` @ ${docs.git.commit}` : ''} (v1–${docs.vocab.maxVersion}, ${docs.vocab.blendModes.length} blend modes from ${docs.vocab.blendModesSource})`)
    })
    .catch(() => { /* reported per call */ })

  const definitions = buildCompositorTools({ config })
  if (config.previewEnabled === false) {
    const filtered = definitions.filter(tool => tool.name !== 'compositor_preview')
    definitions.length = 0
    definitions.push(...filtered)
  }
  registerAgentTools(ctx, state, definitions)
}

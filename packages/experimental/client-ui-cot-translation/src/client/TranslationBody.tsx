/** Translation controls for one expanded reasoning body. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, MarkdownText, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CotTranslationPreferences } from '../preferences.ts'
import { ReasoningTranslation, type TranslateText, type TranslationState } from './translation.ts'
import { NS } from './locales.ts'
import css from './Translation.module.css'

/** Registry-side values and callbacks bound for the reasoning contribution. */
export interface TranslationBodyInjected {
  hooks: {
    preferences: HostObservable<CotTranslationPreferences>
    translationLocale: HostObservable<LocaleSnapshot>
    translationLimit: HostObservable<number>
  }
  translate: TranslateText
}

export type TranslationBodyProps = PropsRuntime<'conversation.chat.reasoning-body'>
  & PropsLocale<typeof NS> & InjectFace<TranslationBodyInjected>

/**
 * Render translated reasoning, retaining the complete original until a failed request is retried.
 * @param props - original reasoning, translation preferences, and cancellation-aware callback.
 * @returns compact Markdown and its display-only translation controls.
 */
export function TranslationBody(props: TranslationBodyProps) {
  const { text, running, translate, t } = props
  const preferences = props.usePreferences(value => value)
  const locale = props.useTranslationLocale(value => value.active)
  const maxTextChars = props.useTranslationLimit(value => value)
  const targetLanguage = preferences.targetLanguage === 'auto' ? locale : preferences.targetLanguage
  const [state, setState] = useState<TranslationState>({ text, pending: false, failed: false })
  const [original, setOriginal] = useState(false)
  const translation = useRef<ReasoningTranslation>()
  useEffect(() => {
    const controller = new ReasoningTranslation({ provider: preferences.provider, targetLanguage }, maxTextChars, translate, setState)
    translation.current = controller
    return () => { controller.dispose(); translation.current = undefined }
  }, [preferences.provider, targetLanguage, maxTextChars, translate])
  useEffect(() => { translation.current?.update(text, running) },
    [text, running, preferences.provider, targetLanguage, maxTextChars, translate])
  const labels = useMemo(() => ({ code: { copyLabel: t('copy'), copiedLabel: t('copied'),
    toolbarLabels: { codeLabel: t('codeTitle'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap') } }, footnotes: t('footnotes') }), [t])
  const showOriginal = original || state.failed
  return <div data-cot-translation="true" data-translation-state={state.failed ? 'failed' : state.pending ? 'pending' : 'ready'}
    data-translation-view={showOriginal ? 'original' : 'translated'}>
    <div className={css.toolbar}>
      <Button size="sm" variant="ghost" aria-pressed={!showOriginal} disabled={state.failed}
        onClick={() => { setOriginal(false) }}>{t('translation')}</Button>
      <Button size="sm" variant="ghost" aria-pressed={showOriginal} onClick={() => { setOriginal(true) }}>{t('original')}</Button>
      {state.pending && <span role="status" aria-label={t('translating')}><IconLoadingOutlineRegular size={14} className={css.spinner} /></span>}
      {state.failed && <><span className={css.failure} role="status">{t('failed')}</span>
        <Button size="sm" variant="ghost" onClick={() => { translation.current?.retry() }}>{t('retry')}</Button></>}
    </div>
    <MarkdownText text={showOriginal ? text : state.text} streaming={running} labels={labels} variant="compact" />
  </div>
}

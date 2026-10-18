'use client';

import { useCallback } from 'react';
import { useT } from '../lib/i18n';

/** Business chrome follows the same locale as the surrounding Desktop shell. */
export function useBusinessCopy() {
  const { locale } = useT();
  const copy = useCallback((ko: string, en: string) => locale === 'ko' ? ko : en, [locale]);
  return { copy, locale, dateLocale: locale === 'ko' ? 'ko-KR' : 'en-US' };
}

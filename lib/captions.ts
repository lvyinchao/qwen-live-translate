export interface CaptionPreferences {
  /** Compatibility summary: at least one caption line is visible. */
  subtitles: boolean;
  sourceSubtitles: boolean;
  targetSubtitles: boolean;
}

/** Old sessions used one switch; missing preferences retain bilingual defaults. */
export function captionPreferences(value: Partial<CaptionPreferences> = {}): CaptionPreferences {
  const sourceSubtitles = value.sourceSubtitles ?? value.subtitles ?? true;
  const targetSubtitles = value.targetSubtitles ?? value.subtitles ?? true;
  return { subtitles: sourceSubtitles || targetSubtitles, sourceSubtitles, targetSubtitles };
}

/** Legacy callers can still toggle both lines; partial new changes preserve the other line. */
export function mergeCaptionPreferences(current: Partial<CaptionPreferences>, changes: unknown) {
  const previous = captionPreferences(current);
  const input = changes && typeof changes === 'object' ? changes as Partial<CaptionPreferences> : {};
  const legacy = typeof input.subtitles === 'boolean' ? input.subtitles : undefined;
  return captionPreferences({
    sourceSubtitles: (typeof input.sourceSubtitles === 'boolean' ? input.sourceSubtitles : undefined) ?? legacy ?? previous.sourceSubtitles,
    targetSubtitles: (typeof input.targetSubtitles === 'boolean' ? input.targetSubtitles : undefined) ?? legacy ?? previous.targetSubtitles,
  });
}

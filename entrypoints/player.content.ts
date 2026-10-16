import { decode64 } from '../lib/audio';
import { sameArchiveUtterance } from '../lib/archive';
import { activeSegment, planDub, clockDiscontinuity } from '../lib/timeline';
import { mediaIdentity } from '../lib/adapters';
import { pageVideos, inspectVideos, youtubePlayer } from '../lib/discovery';
import type { PlaybackSession, TranslationSegment } from '../lib/types';
import { normalizeUILanguage, t } from '../lib/i18n';
import { isOlderStateVersion } from '../lib/session';
import type { UILanguage } from '../lib/types';

type TerminalReason = 'natural' | 'timeline-cut' | 'overlap-cut' | 'seek-stop' |
  'language-switch' | 'stop' | 'error' | 'video-ended' | 'player-lost';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  main(ctx) {
    let player: Player | null = null;
    let locale: UILanguage = 'en';
    let localeVersion = 0;
    const mediaRescans = new Set<() => void>();
    void chrome.runtime
      .sendMessage({ target: 'background', type: 'ui:get' })
      .then((result) => {
        if (result?.ok && localeVersion === 0)
          locale = normalizeUILanguage(result.value);
      })
      .catch(() => {});
    window.addEventListener(
      'message',
      (event) => {
        if (
          event.source !== window ||
          event.origin !== location.origin ||
          event.data?.type !== 'qvd:tencent-media'
        )
          return;
        const media = event.data.media;
        if (
          !media ||
          typeof media.url !== 'string' ||
          typeof media.playlist !== 'string' ||
          media.playlist.length > 256 * 1024
        )
          return;
        void chrome.runtime
          .sendMessage({
            target: 'background',
            type: 'media:tencent-info',
            media,
          })
          .then(() => { for (const complete of [...mediaRescans]) complete(); })
          .catch(() => { for (const complete of [...mediaRescans]) complete(); });
      },
      { signal: ctx.signal },
    );
    window.postMessage({ type: 'qvd:request-media' }, location.origin);
    class Player {
      video: HTMLVideoElement;
      session: PlaybackSession;
      segments: TranslationSegment[] = [];
      audio = new Audio();
      preloaded?: { segment: TranslationSegment; audio: HTMLAudioElement; blob: string };
      audioListeners = new Map<HTMLAudioElement, AbortController>();
      host = document.createElement('div');
      caption = document.createElement('div');
      original: { muted: boolean; volume: number };
      abort = new AbortController();
      expectedPause = false;
      expectedPlay = false;
      userPaused = false;
      waiting = false;
      audioBlocked = false;
      playPending = false;
      current?: TranslationSegment;
      blob?: string;
      loaded = false;
      anchor = { media: 0, audio: 0 };
      lastClock?: { position: number; at: number };
      pendingSeek = false;
      epochStartPosition = 0;
      sourceAtAttach = '';
      started = new Set<string>();
      skipped = new Set<string>();
      terminated = new Set<string>();
      endedMetrics = new Set<string>();
      currentPreloadHit = false;
      previousTickAt?: number;
      tickGapMs = 0;
      maxTickGapMs = 0;
      pendingTerminals: Record<string, unknown>[] = [];
      timer: ReturnType<typeof setInterval>;
      tickTimer: ReturnType<typeof setInterval>;
      frame?: number;
      constructor(video: HTMLVideoElement, session: PlaybackSession) {
        this.video = video;
        this.session = session;
        this.epochStartPosition = session.position;
        this.sourceAtAttach = video.currentSrc || video.src;
        this.original = { muted: video.muted, volume: video.volume };
        this.pauseVideo();
        video.muted = true;
        this.configureAudio(this.audio);
        this.host.dataset.qvdOverlay = '';
        this.host.style.cssText =
          'position:absolute;inset:0;pointer-events:none;z-index:2147483646;';
        const shadow = this.host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent =
          ':host{font-family:system-ui,sans-serif}.caption{position:absolute;bottom:12%;left:8%;right:8%;text-align:center;display:flex;flex-direction:column;align-items:center;gap:5px}.caption[hidden]{display:none!important}.line{max-width:100%;padding:6px 12px;background:rgba(10,18,30,.85);color:white;border-radius:6px;font-size:clamp(14px,2.3vw,25px);line-height:1.45;text-shadow:0 1px 2px #000;white-space:pre-wrap}.source{font-size:clamp(11px,1.4vw,17px);color:#cbd5e1}.note{font-size:12px;color:#f9cd87}';
        this.caption.className = 'caption';
        shadow.append(style, this.caption, this.audio);
        this.placeOverlay();
        this.mix(session.originalVolume, session.dubVolume, session.subtitles);
        const listen = (name: string, fn: () => void) =>
          video.addEventListener(name, fn, { signal: this.abort.signal });
        listen('pause', () => {
          if (this.expectedPause) this.expectedPause = false;
          else this.userPaused = true;
          this.audio.pause();
          this.clock();
        });
        listen('play', () => {
          if (this.expectedPlay) this.expectedPlay = false;
          else {
            this.userPaused = false;
            this.audioBlocked = false;
          }
          if (this.buffering()) this.pauseVideo();
          this.clock();
          this.tick();
        });
        listen('seeking', () => {
          this.pendingSeek = true;
          this.clearAudio(true, 'seek-stop');
          this.segments = [];
          this.session.phase = 'buffering';
          this.lastClock = {
            position: video.currentTime,
            at: performance.now(),
          };
          this.pauseVideo();
          this.send('player:seek', {
            position: video.currentTime,
            paused: this.userPaused,
          });
        });
        listen('seeked', () => {
          this.clock();
          this.tick();
        });
        listen('waiting', () => {
          this.waiting = true;
          this.audio.pause();
        });
        listen('playing', () => {
          this.waiting = false;
          this.tick();
        });
        listen('ratechange', () => {
          if (this.current && this.loaded)
            this.anchor = {
              media: video.currentTime,
              audio: this.audio.currentTime,
            };
          this.tick();
          this.clock();
        });
        listen('ended', () => {
          this.clearAudio(true, 'video-ended');
          this.clock();
        });
        document.addEventListener(
          'fullscreenchange',
          () => this.placeOverlay(),
          { signal: this.abort.signal },
        );
        document.addEventListener(
          'pointerdown',
          () => {
            if (this.audioBlocked) {
              this.audioBlocked = false;
              this.userPaused = false;
              const audio = this.audio;
              this.audioStage('play-call');
              void audio
                .play()
                .then(() => {
                  if (this.abort.signal.aborted || audio !== this.audio) return;
                  this.audioStage('play-resolved');
                  return this.resumeVideo();
                })
                .catch(() => {
                  if (this.abort.signal.aborted || audio !== this.audio) return;
                  this.audioBlocked = true;
                  this.userPaused = true;
                  this.pauseVideo();
                });
            }
          },
          { signal: this.abort.signal },
        );
        this.tickTimer = setInterval(() => this.tick(), 50);
        this.timer = setInterval(() => {
          if (
            !video.isConnected ||
            (!['youtube', 'bilibili'].includes(session.candidate.site) &&
              (video.currentSrc || video.src) !== this.sourceAtAttach) ||
            mediaIdentity(location.href) !==
              (session.candidate.frameMediaId ?? session.candidate.mediaId) ||
            document.querySelector('#movie_player.ad-showing') ||
            (session.candidate.site === 'youtube' &&
              youtubePlayer(inspectVideos(true))[0]?.id !== video.dataset.qvdId)
          ) {
            this.destroy('player-lost');
            this.send('player:lost', { terminals: this.takeTerminals() });
            if (player === this) player = null;
            return;
          }
          this.clock();
          this.tick();
        }, 250);
        const frame = () => {
          if (this.abort.signal.aborted) return;
          this.tick();
          this.frame = video.requestVideoFrameCallback?.(frame);
        };
        this.frame = video.requestVideoFrameCallback?.(frame);
      }
      configureAudio(audio: HTMLAudioElement) {
        const controller = new AbortController();
        this.audioListeners.set(audio, controller);
        audio.volume = this.session.dubVolume;
        audio.preservesPitch = true;
        audio.preload = 'auto';
        audio.addEventListener(
          'loadedmetadata',
          () => {
            const segment = audio === this.audio ? this.current :
              this.preloaded?.audio === audio ? this.preloaded.segment : undefined;
            if (segment) this.audioStage('metadata', audio, segment);
            if (audio !== this.audio || audio.currentSrc !== this.blob) return;
            this.loaded = true;
            this.tick();
          },
          { signal: controller.signal },
        );
        audio.addEventListener(
          'playing',
          () => {
            if (audio !== this.audio || audio.currentSrc !== this.blob) return;
            const s = this.current;
            if (!s || this.started.has(s.id)) return;
            this.started.add(s.id);
            this.audioStage('playing');
            this.send('player:metric', {
              ...this.audioSnapshot(),
              kind: 'start',
              segmentId: s.id,
              mediaTime: this.video.currentTime,
              error: this.video.currentTime - s.start,
              partial: s.start < this.epochStartPosition - 0.3,
              rate: audio.playbackRate,
            });
          },
          { signal: controller.signal },
        );
        audio.addEventListener(
          'ended',
          () => {
            if (audio !== this.audio || audio.currentSrc !== this.blob) return;
            const s = this.current;
            if (s && !this.endedMetrics.has(s.id)) {
              this.endedMetrics.add(s.id);
              this.send('player:metric', {
                ...this.audioSnapshot(),
                kind: 'end',
                segmentId: s.id,
                mediaTime: this.video.currentTime,
                error: this.video.currentTime - s.end,
              });
              this.finishCurrent('natural');
            }
          },
          { signal: controller.signal },
        );
      }
      audioSnapshot(audio = this.audio, segment = this.current) {
        return {
          frontendAt: performance.now(),
          videoTime: this.video.currentTime,
          audioTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          audioDuration: segment?.audioDuration,
          sourceStart: segment?.start,
          sourceEnd: segment?.end,
          readyState: audio.readyState,
          preloadHit: audio === this.audio ? this.currentPreloadHit : this.preloaded?.audio === audio,
          readyThrough: this.session.readyThrough,
          stateVersion: this.session.stateVersion ?? 0,
          tickGapMs: this.tickGapMs,
          maxTickGapMs: this.maxTickGapMs,
          videoRate: this.video.playbackRate,
          audioRate: audio.playbackRate,
          videoPaused: this.video.paused,
          audioPaused: audio.paused,
          phase: this.session.phase,
        };
      }
      audioStage(stage: string, audio = this.audio, segment = this.current) {
        if (!segment) return;
        this.send('player:metric', { kind: 'audio-stage', stage, segmentId: segment.id,
          ...this.audioSnapshot(audio, segment) });
      }
      finishCurrent(reason: TerminalReason) {
        const segment = this.current;
        if (!segment || !this.started.has(segment.id) || this.terminated.has(segment.id)) return;
        this.terminated.add(segment.id);
        const remaining = Math.max(0, segment.audioDuration - this.audio.currentTime);
        const actualReason = this.audio.ended || remaining === 0 ? 'natural' : reason;
        const event = { kind: 'terminal', reason: actualReason, segmentId: segment.id,
          ...this.audioSnapshot(), sourceTime: this.video.currentTime,
          remaining, error: this.video.currentTime - segment.end };
        const message = { type: 'player:metric', sessionId: this.session.id,
          epoch: this.session.epoch, languageVersion: this.session.languageVersion ?? 0, ...event };
        this.pendingTerminals.push(message);
        this.send('player:metric', event);
        if (remaining > 0 && actualReason !== 'natural' &&
            ['timeline-cut', 'overlap-cut'].includes(actualReason) && !this.skipped.has(segment.id)) {
          this.skipped.add(segment.id);
          this.send('player:skip', { segmentId: segment.id, remaining, reason: actualReason });
        }
      }
      takeTerminals() {
        return this.pendingTerminals.splice(0);
      }
      releaseAudio(audio: HTMLAudioElement) {
        this.audioListeners.get(audio)?.abort();
        this.audioListeners.delete(audio);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio.remove();
      }
      clearPreload() {
        if (!this.preloaded) return;
        this.releaseAudio(this.preloaded.audio);
        URL.revokeObjectURL(this.preloaded.blob);
        this.preloaded = undefined;
      }
      preloadUpcoming() {
        if (this.abort.signal.aborted) return;
        const position = this.video.currentTime;
        const candidate = [
          activeSegment(this.segments, position),
          ...this.segments.filter((segment) => segment.start > position).sort((a, b) => a.start - b.start),
        ].find((segment) => segment && segment.id !== this.current?.id);
        if (!candidate || candidate.id === this.preloaded?.segment.id) return;
        this.clearPreload();
        const audio = new Audio();
        const blob = URL.createObjectURL(new Blob([decode64(candidate.audio)], { type: 'audio/wav' }));
        this.configureAudio(audio);
        this.preloaded = { segment: candidate, audio, blob };
        this.audio.parentNode?.appendChild(audio);
        audio.src = blob;
        audio.load();
        this.audioStage('preload', audio, candidate);
      }
      send(type: string, data: Record<string, unknown> = {}) {
        void chrome.runtime
          .sendMessage({
            target: 'background',
            type,
            sessionId: this.session.id,
            epoch: this.session.epoch,
            languageVersion: this.session.languageVersion ?? 0,
            ...data,
          })
          .catch(() => {});
      }
      clock() {
        const now = performance.now(),
          position = this.video.currentTime;
        if (
          this.lastClock &&
          clockDiscontinuity(
            this.lastClock.position,
            position,
            (now - this.lastClock.at) / 1000,
            this.video.playbackRate,
          )
        ) {
          this.pendingSeek = true;
          this.clearAudio(true, 'seek-stop');
          this.segments = [];
          this.session.phase = 'buffering';
          this.lastClock = { position, at: now };
          this.pauseVideo();
          this.send('player:seek', { position, paused: this.userPaused });
        }
        this.lastClock = { position, at: now };
        this.send('player:clock', {
          position: this.video.currentTime,
          rate: this.video.playbackRate,
          userPaused: this.userPaused,
          ended: this.video.ended,
        });
      }
      buffering() {
        return ['preparing', 'buffering', 'error'].includes(this.session.phase);
      }
      pauseVideo() {
        if (!this.video.paused) {
          this.expectedPause = true;
          this.video.pause();
        }
      }
      async resumeVideo() {
        if (this.video.paused && !this.userPaused && !this.audioBlocked) {
          this.expectedPlay = true;
          try {
            await this.video.play();
          } catch {
            this.expectedPlay = false;
            this.caption.textContent = t(
              locale,
              '请点击视频播放按钮，继续观看',
            );
          }
        }
      }
      state(next: PlaybackSession): boolean {
        const version = next.languageVersion ?? 0;
        const currentVersion = this.session.languageVersion ?? 0;
        if (
          next.id !== this.session.id ||
          version < currentVersion ||
          (version === currentVersion && next.language !== this.session.language) ||
          (version === currentVersion && next.epoch < this.session.epoch) ||
          isOlderStateVersion(this.session, next) ||
          (this.pendingSeek && version === currentVersion && next.epoch <= this.session.epoch)
        )
          return false;
        if (next.epoch !== this.session.epoch || version !== currentVersion) {
          this.pendingSeek = false;
          this.epochStartPosition = next.position;
          this.clearAudio(true, version !== currentVersion ? 'language-switch' : 'seek-stop');
          this.segments = [];
          this.skipped.clear();
          this.started.clear();
          this.terminated.clear();
          this.endedMetrics.clear();
        }
        this.session = next;
        this.mix(next.originalVolume, next.dubVolume, next.subtitles);
        if (next.phase === 'error') {
          this.video.muted = this.original.muted;
          this.video.volume = this.original.volume;
        }
        if (this.buffering()) {
          this.pauseVideo();
          this.audio.pause();
        } else if (next.phase === 'playing') void this.resumeVideo();
        this.tick();
        return true;
      }
      add(segment: TranslationSegment, epoch: number, languageVersion = 0): boolean {
        if (
          epoch !== this.session.epoch ||
          languageVersion !== (this.session.languageVersion ?? 0) ||
          segment.language !== this.session.language ||
          segment.mediaId !== this.session.candidate.mediaId
        )
          return false;
        this.segments = this.segments.filter(
          (s) =>
            s.id !== segment.id &&
            !sameArchiveUtterance(s, segment),
        );
        this.segments.push(segment);
        this.segments = this.segments.filter(
          (s) => s.end > this.video.currentTime - 300,
        );
        this.tick();
        return true;
      }
      mix(original: number, dub: number, subtitles: boolean) {
        this.session.originalVolume = original;
        this.session.dubVolume = dub;
        this.session.subtitles = subtitles;
        this.video.muted = original === 0;
        this.video.volume = original;
        this.audio.volume = dub;
        if (this.preloaded) this.preloaded.audio.volume = dub;
        this.caption.hidden = !subtitles;
      }
      placeOverlay() {
        const fullscreen = document.fullscreenElement;
        let ancestor: Node | null = this.video;
        while (ancestor && ancestor !== fullscreen)
          ancestor =
            ancestor.parentNode instanceof ShadowRoot
              ? ancestor.parentNode.host
              : ancestor.parentNode;
        const root = this.video.getRootNode();
        const parent =
          fullscreen && ancestor === fullscreen
            ? fullscreen
            : (this.video.parentElement ??
              (root instanceof ShadowRoot ? root : null));
        if (parent && !(parent instanceof HTMLVideoElement))
          parent.append(this.host);
      }

      clearAudio(clearPreload = false, reason: TerminalReason = 'timeline-cut') {
        this.finishCurrent(reason);
        if (clearPreload) this.clearPreload();
        this.audio.pause();
        this.audio.removeAttribute('src');
        if (this.blob) URL.revokeObjectURL(this.blob);
        this.blob = undefined;
        this.current = undefined;
        this.loaded = false;
        this.playPending = false;
        this.currentPreloadHit = false;
      }
      tick() {
        if (this.abort.signal.aborted) return;
        const now = performance.now();
        this.tickGapMs = this.previousTickAt === undefined ? 0 : Math.max(0, now - this.previousTickAt);
        this.previousTickAt = now;
        this.maxTickGapMs = Math.max(this.maxTickGapMs, this.tickGapMs);
        const position = this.video.currentTime;
        this.preloadUpcoming();
        const segment = activeSegment(this.segments, position);
        // Enforce the last acknowledged boundary locally; a delayed round trip
        // must not let the picture run through an untranslated interval.
        if (!this.buffering() && !this.video.paused &&
            position >= this.session.readyThrough - 0.02 &&
            position < this.session.candidate.duration - 0.02) {
          this.session.phase = 'buffering';
          this.pauseVideo();
          this.clock();
        }
        if (this.buffering()) {
          this.audio.pause();
          this.caption.textContent =
            this.session.phase === 'error'
              ? t(locale, '翻译已停止，请查看侧边栏')
              : t(locale, '正在准备译音 · 已准备 {seconds} 秒', {
                  seconds: Math.max(
                    0,
                    this.session.readyThrough - position,
                  ).toFixed(0),
                });
          return;
        }
        if (this.current && this.current.id !== segment?.id) {
          this.clearAudio(false, position < this.current.end ? 'overlap-cut' : 'timeline-cut');
        }
        if (!segment) {
          this.caption.replaceChildren();
          return;
        }
        if (this.current?.id !== segment.id) {
          this.clearAudio();
          this.current = segment;
          this.anchor = { media: segment.start, audio: 0 };
          this.currentPreloadHit = this.preloaded?.segment.id === segment.id;
          if (this.preloaded?.segment.id === segment.id) {
            this.releaseAudio(this.audio);
            this.audio = this.preloaded.audio;
            this.audio.volume = this.session.dubVolume;
            this.blob = this.preloaded.blob;
            this.preloaded = undefined;
            this.loaded = this.audio.readyState >= HTMLMediaElement.HAVE_METADATA;
          } else {
            this.blob = URL.createObjectURL(new Blob([decode64(segment.audio)], { type: 'audio/wav' }));
            this.audio.src = this.blob;
          }
          this.audioStage('activate');
          this.preloadUpcoming();
          const source = document.createElement('div'),
            translated = document.createElement('div');
          source.className = 'line source';
          source.textContent = segment.sourceText;
          translated.className = 'line';
          translated.textContent = segment.text;
          this.caption.replaceChildren(
            ...(segment.sourceText ? [source] : []),
            translated,
          );
        }
        if (this.video.paused || this.waiting || !this.loaded) {
          this.audio.pause();
          return;
        }
        const plan = planDub(segment, position, this.video.playbackRate);
        const offset =
          this.anchor.audio +
          ((position - this.anchor.media) / this.video.playbackRate) *
            plan.rate;
        if (position >= segment.end) {
          this.finishCurrent('timeline-cut');
          this.audio.pause();
          return;
        }
        if (this.audio.ended || this.audio.currentTime >= segment.audioDuration) {
          this.finishCurrent('natural');
          return;
        }
        if (this.terminated.has(segment.id)) return;
        this.audio.playbackRate = plan.rate;
        // The source clock predicts completion, but the media element can lag by
        // tens of milliseconds. Let its real tail finish before the source turn
        // ends; seeking/pausing at the predicted end silently cuts that tail.
        if (offset < segment.audioDuration && Math.abs(this.audio.currentTime - offset) > 0.12)
          this.audio.currentTime = Math.max(
            0,
            Math.min(offset, segment.audioDuration),
          );
        if (this.audio.paused && !this.playPending && !this.audioBlocked) {
          this.playPending = true;
          const audio = this.audio;
          this.audioStage('play-call');
          void audio
            .play()
            .then(() => {
              if (this.abort.signal.aborted || audio !== this.audio || this.current?.id !== segment.id) return;
              this.audioStage('play-resolved');
            })
            .catch(() => {
              if (this.abort.signal.aborted || audio !== this.audio || !this.current || this.current.id !== segment.id) return;
              this.audioBlocked = true;
              this.userPaused = true;
              this.pauseVideo();
              this.caption.textContent = t(
                locale,
                '请点击视频一次，允许播放译音',
              );
              this.clock();
            })
            .finally(() => {
              if (audio === this.audio) this.playPending = false;
            });
        }
      }
      destroy(reason: TerminalReason = 'stop') {
        if (this.abort.signal.aborted) return;
        this.abort.abort();
        clearInterval(this.timer);
        clearInterval(this.tickTimer);
        if (this.frame !== undefined)
          this.video.cancelVideoFrameCallback?.(this.frame);
        this.clearAudio(true, reason);
        this.releaseAudio(this.audio);
        this.host.remove();
        this.video.muted = this.original.muted;
        this.video.volume = this.original.volume;
      }
    }
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== chrome.runtime.id) return;
      if (message.type === 'player:rescan-media') {
        // Other frames must not win tabs.sendMessage's first-response race.
        if (location.hostname !== 'v.qq.com') return;
        let done = false;
        const complete = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          mediaRescans.delete(complete);
          respond({ ok: true });
        };
        const timer = setTimeout(complete, 300);
        mediaRescans.add(complete);
        window.postMessage({ type: 'qvd:request-media' }, location.origin);
        return true;
      }
      if (message.type === 'ui:changed') {
        localeVersion++;
        locale = normalizeUILanguage(message.language);
        player?.tick();
        respond({ ok: true });
        return;
      }
      if (message.type === 'player:highlight') {
        const allowed =
          !/(^|\.)youtube\.com$/.test(location.hostname) ||
          youtubePlayer(inspectVideos(true))[0]?.id === message.id;
        const v =
          allowed && pageVideos().find((v) => v.dataset.qvdId === message.id);
        if (v) {
          v.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const outline = v.style.outline;
          v.style.outline = '3px solid #2bd2b2';
          setTimeout(() => {
            v.style.outline = outline;
          }, 1800);
        }
        respond({ ok: true });
        return;
      }
      if (message.type === 'player:attach') {
        player?.destroy();
        const s = message.session as PlaybackSession;
        const selected =
          s.candidate.site === 'youtube'
            ? youtubePlayer(inspectVideos(true))[0]?.id
            : s.candidate.id;
        const video = pageVideos().find(
          (v) => selected === s.candidate.id && v.dataset.qvdId === selected,
        );
        if (video) player = new Player(video, s);
        respond({ ok: Boolean(video), position: video?.currentTime, rate: video?.playbackRate, userPaused: player?.userPaused });
        return;
      }
      if (message.type === 'player:language') {
        const next = message.session as PlaybackSession;
        if (
          !player ||
          player.session.id !== next.id ||
          (next.languageVersion ?? 0) <= (player.session.languageVersion ?? 0)
        ) {
          respond({ ok: false });
          return;
        }
        const position = player.video.currentTime;
        const rate = player.video.playbackRate;
        const userPaused = player.userPaused;
        player.state({
          ...next,
          position,
          rate,
          readyThrough: position,
          inputThrough: position,
        });
        respond({ ok: true, position, rate, userPaused, terminals: player.takeTerminals() });
        return;
      }
      if (message.type === 'player:stop') {
        if (message.sessionId && player?.session.id !== message.sessionId) {
          respond({ ok: false });
          return;
        }
        player?.destroy();
        const terminals = player?.takeTerminals() ?? [];
        player = null;
        respond({ ok: true, terminals });
        return;
      }
      if (message.type === 'player:state') {
        const accepted = player?.state(message.session) ?? false;
        if (accepted && message.session.phase === 'error') {
          player?.destroy('error');
          const terminals = player?.takeTerminals() ?? [];
          player = null;
          respond({ ok: true, terminals });
          return;
        }
        respond({ ok: accepted, terminals: accepted ? player?.takeTerminals() : [] });
        return;
      }
      if (message.type === 'player:segment') {
        const accepted = player?.add(message.segment, message.epoch, message.languageVersion) ?? false;
        respond({ ok: accepted, terminals: accepted ? player?.takeTerminals() : [] });
        return;
      }
      if (message.type === 'player:mix') {
        if ((message.sessionId && player?.session.id !== message.sessionId) ||
            (message.languageVersion !== undefined &&
              (player?.session.languageVersion ?? 0) !== message.languageVersion)) {
          respond({ ok: false });
          return;
        }
        player?.mix(
          message.originalVolume,
          message.dubVolume,
          message.subtitles,
        );
        respond({ ok: true });
        return;
      }
    });
    ctx.onInvalidated(() => player?.destroy());
  },
});

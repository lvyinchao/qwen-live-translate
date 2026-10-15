import { decode64 } from '../lib/audio';
import { activeSegment, planDub, clockDiscontinuity } from '../lib/timeline';
import { mediaIdentity } from '../lib/adapters';
import { pageVideos, inspectVideos, youtubePlayer } from '../lib/discovery';
import type { PlaybackSession, TranslationSegment } from '../lib/types';
import { normalizeUILanguage, t } from '../lib/i18n';
import type { UILanguage } from '../lib/types';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  main(ctx) {
    let player: Player | null = null;
    let locale: UILanguage = 'en';
    let localeVersion = 0;
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
          .catch(() => {});
      },
      { signal: ctx.signal },
    );
    window.postMessage({ type: 'qvd:request-media' }, location.origin);
    class Player {
      video: HTMLVideoElement;
      session: PlaybackSession;
      segments: TranslationSegment[] = [];
      audio = new Audio();
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
      epochStartPosition = 0;
      started = new Set<string>();
      skipped = new Set<string>();
      timer: ReturnType<typeof setInterval>;
      frame?: number;
      constructor(video: HTMLVideoElement, session: PlaybackSession) {
        this.video = video;
        this.session = session;
        this.epochStartPosition = session.position;
        this.original = { muted: video.muted, volume: video.volume };
        this.pauseVideo();
        video.muted = true;
        this.audio.preservesPitch = true;
        this.audio.preload = 'auto';
        this.audio.addEventListener(
          'loadedmetadata',
          () => {
            this.loaded = true;
            this.tick();
          },
          { signal: this.abort.signal },
        );
        this.audio.addEventListener(
          'playing',
          () => {
            const s = this.current;
            if (!s || this.started.has(s.id)) return;
            this.started.add(s.id);
            this.send('player:metric', {
              kind: 'start',
              segmentId: s.id,
              mediaTime: video.currentTime,
              error: video.currentTime - s.start,
              partial: s.start < this.epochStartPosition - 0.3,
              rate: this.audio.playbackRate,
            });
          },
          { signal: this.abort.signal },
        );
        this.audio.addEventListener(
          'ended',
          () => {
            const s = this.current;
            if (s)
              this.send('player:metric', {
                kind: 'end',
                segmentId: s.id,
                mediaTime: video.currentTime,
                error: video.currentTime - s.end,
              });
          },
          { signal: this.abort.signal },
        );
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
          this.clearAudio();
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
          this.clearAudio();
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
              void this.audio
                .play()
                .then(() => this.resumeVideo())
                .catch(() => {
                  this.audioBlocked = true;
                  this.userPaused = true;
                  this.pauseVideo();
                });
            }
          },
          { signal: this.abort.signal },
        );
        this.timer = setInterval(() => {
          if (
            !video.isConnected ||
            mediaIdentity(location.href) !==
              (session.candidate.frameMediaId ?? session.candidate.mediaId) ||
            document.querySelector('#movie_player.ad-showing') ||
            (session.candidate.site === 'youtube' &&
              youtubePlayer(inspectVideos(true))[0]?.id !== video.dataset.qvdId)
          ) {
            this.send('player:lost');
            this.destroy();
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
      send(type: string, data: Record<string, unknown> = {}) {
        void chrome.runtime
          .sendMessage({
            target: 'background',
            type,
            sessionId: this.session.id,
            epoch: this.session.epoch,
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
          this.clearAudio();
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
      state(next: PlaybackSession) {
        if (next.id !== this.session.id || next.epoch < this.session.epoch)
          return;
        if (next.epoch !== this.session.epoch) {
          this.epochStartPosition = next.position;
          this.clearAudio();
          this.segments = [];
          this.skipped.clear();
          this.started.clear();
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
      }
      add(segment: TranslationSegment, epoch: number) {
        if (epoch !== this.session.epoch) return;
        this.segments = this.segments.filter(
          (s) =>
            s.id !== segment.id &&
            !(
              Math.abs(s.start - segment.start) < 0.05 &&
              Math.abs(s.end - segment.end) < 0.05
            ),
        );
        this.segments.push(segment);
        this.segments = this.segments.filter(
          (s) => s.end > this.video.currentTime - 300,
        );
        this.tick();
      }
      mix(original: number, dub: number, subtitles: boolean) {
        this.session.originalVolume = original;
        this.session.dubVolume = dub;
        this.session.subtitles = subtitles;
        this.video.muted = original === 0;
        this.video.volume = original;
        this.audio.volume = dub;
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

      clearAudio() {
        this.audio.pause();
        this.audio.removeAttribute('src');
        if (this.blob) URL.revokeObjectURL(this.blob);
        this.blob = undefined;
        this.current = undefined;
        this.loaded = false;
      }
      tick() {
        if (this.abort.signal.aborted) return;
        const position = this.video.currentTime;
        const segment = activeSegment(this.segments, position);
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
          if (
            position >= this.current.end - 0.03 &&
            this.audio.currentTime < this.current.audioDuration - 0.1 &&
            !this.skipped.has(this.current.id)
          ) {
            this.skipped.add(this.current.id);
            this.send('player:skip', {
              segmentId: this.current.id,
              remaining: this.current.audioDuration - this.audio.currentTime,
            });
          }
          this.clearAudio();
        }
        if (!segment) {
          this.caption.replaceChildren();
          return;
        }
        if (this.current?.id !== segment.id) {
          this.clearAudio();
          this.current = segment;
          this.anchor = { media: segment.start, audio: 0 };
          this.blob = URL.createObjectURL(
            new Blob([decode64(segment.audio)], { type: 'audio/wav' }),
          );
          this.audio.src = this.blob;
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
        if (position >= segment.end || offset >= segment.audioDuration) {
          this.audio.pause();
          return;
        }
        this.audio.playbackRate = plan.rate;
        if (Math.abs(this.audio.currentTime - offset) > 0.12)
          this.audio.currentTime = Math.max(
            0,
            Math.min(offset, segment.audioDuration),
          );
        if (this.audio.paused && !this.playPending && !this.audioBlocked) {
          this.playPending = true;
          void this.audio
            .play()
            .catch(() => {
              if (!this.current || this.current.id !== segment.id) return;
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
              this.playPending = false;
            });
        }
      }
      destroy() {
        if (this.abort.signal.aborted) return;
        this.abort.abort();
        clearInterval(this.timer);
        if (this.frame !== undefined)
          this.video.cancelVideoFrameCallback?.(this.frame);
        this.clearAudio();
        this.host.remove();
        this.video.muted = this.original.muted;
        this.video.volume = this.original.volume;
      }
    }
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== chrome.runtime.id) return;
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
        respond({ ok: Boolean(video) });
        return;
      }
      if (message.type === 'player:stop') {
        player?.destroy();
        player = null;
        respond({ ok: true });
        return;
      }
      if (message.type === 'player:state') {
        player?.state(message.session);
        if (message.session.phase === 'error') {
          player?.destroy();
          player = null;
        }
        respond({ ok: true });
        return;
      }
      if (message.type === 'player:segment') {
        player?.add(message.segment, message.epoch);
        respond({ ok: true });
        return;
      }
      if (message.type === 'player:mix') {
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

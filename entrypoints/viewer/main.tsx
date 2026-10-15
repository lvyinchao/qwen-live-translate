import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { activeSegment, planDub } from '../../lib/timeline';
import { decode64 } from '../../lib/audio';
import {
  compatCanPlay,
  compatError,
  type CompatPacket,
  type CompatState,
} from '../../lib/compat';
import type { TranslationSegment } from '../../lib/types';
import './style.css';
const stamp = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
function App() {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  const video = useRef<HTMLVideoElement>(null),
    frame = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<CompatState | null>(null),
    [error, setError] = useState(''),
    [position, setPosition] = useState(0),
    [playing, setPlaying] = useState(false),
    [buffering, setBuffering] = useState(true),
    [captions, setCaptions] = useState(true),
    [caption, setCaption] = useState<TranslationSegment | null>(null),
    [original, setOriginal] = useState(0),
    [dub, setDub] = useState(1),
    [rate, setRate] = useState(1),
    [skipped, setSkipped] = useState(0);
  const ctl = useRef({
    paused: false,
    initial: true,
    subtitles: true,
    original: 0,
    dub: 1,
    rate: 1,
  });
  const zh = state?.uiLanguage === 'zh';
  const text = (en: string, cn: string) => (zh ? cn : en);
  useEffect(() => {
    if (!id || !video.current) {
      setError('Missing capture session.');
      return;
    }
    const v = video.current;
    const ac = new AbortController();
    const channel = new BroadcastChannel(`qvd-capture-${id}`);
    const media = new MediaSource();
    const objectURL = URL.createObjectURL(media);
    v.src = objectURL;
    v.volume = 0;
    let source: SourceBuffer | undefined,
      currentState: CompatState | null = null,
      seq = 0,
      requested = 0,
      buffer: Blob | null = null,
      appendBusy = false,
      segment: TranslationSegment | null = null,
      audioURL = '',
      segments: TranslationSegment[] = [],
      playingRequest = false,
      audioPending = false,
      lastClock = 0,
      closed = false;
    const audio = new Audio();
    audio.preservesPitch = true;
    audio.hidden = true;
    audio.dataset.role = 'translation';
    document.body.append(audio);
    const stopped = () =>
      currentState?.phase === 'error' || currentState?.phase === 'stopped';
    const clearAudio = () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (audioURL) URL.revokeObjectURL(audioURL);
      audioURL = '';
      segment = null;
    };
    const fail = (e: unknown) => {
      if (closed) return;
      setError(e instanceof Error ? e.message : String(e));
      ctl.current.paused = true;
      v.pause();
      clearAudio();
    };
    const finishMedia = () => {
      if (
        currentState?.phase === 'ended' &&
        seq >= currentState.chunks &&
        !buffer &&
        !appendBusy &&
        source &&
        !source.updating &&
        media.readyState === 'open'
      ) {
        try {
          media.endOfStream();
        } catch {}
      }
    };
    const request = () => {
      if (
        closed ||
        !source ||
        source.updating ||
        buffer ||
        appendBusy ||
        !currentState ||
        seq >= currentState.chunks
      )
        return;
      if (requested && performance.now() - requested < 5000) return;
      requested = performance.now();
      channel.postMessage({ type: 'get', seq });
    };
    const append = async () => {
      if (!source || source.updating || !buffer || appendBusy) return;
      appendBusy = true;
      const blob = buffer;
      buffer = null;
      try {
        source.appendBuffer(await blob.arrayBuffer());
      } catch (e) {
        fail(e);
      } finally {
        appendBusy = false;
      }
    };
    media.addEventListener(
      'sourceopen',
      () => {
        try {
          source = media.addSourceBuffer('video/webm;codecs="vp8,opus"');
          source.mode = 'segments';
          source.addEventListener(
            'error',
            () => fail(new Error('The captured video could not be played.')),
            { signal: ac.signal },
          );
          source.addEventListener(
            'updateend',
            () => {
              // Keep at most two minutes of past video in the browser's media buffer.
              if (
                source &&
                !source.updating &&
                source.buffered.length &&
                v.currentTime - source.buffered.start(0) > 150
              ) {
                source.remove(0, v.currentTime - 120);
                return;
              }
              void append();
              request();
              finishMedia();
            },
            { signal: ac.signal },
          );
          request();
        } catch (e) {
          fail(e);
        }
      },
      { signal: ac.signal },
    );
    channel.onmessage = (e) => {
      const m = e.data as CompatPacket;
      if (m.type === 'state') {
        if (m.state.id !== id) return;
        currentState = m.state;
        setState(m.state);
        if (stopped()) {
          v.pause();
          clearAudio();
          setCaption(null);
          if (m.state.error) setError(m.state.error);
        }
        request();
        finishMedia();
      }
      if (m.type === 'segment') {
        if (segments.some((s) => s.id === m.segment.id)) return;
        segments.push(m.segment);
        segments.sort((a, b) => a.start - b.start);
        segments = segments.filter((s) => s.end >= v.currentTime - 120);
      }
      if (m.type === 'chunk' && m.seq === seq && !buffer && !appendBusy) {
        seq++;
        requested = 0;
        buffer = m.blob;
        void append();
      }
    };
    channel.postMessage({ type: 'hello' });
    const tick = () => {
      if (closed) return;
      const s = currentState,
        c = ctl.current,
        now = v.currentTime;
      if (!s) return;
      if (performance.now() - lastClock > 500) {
        channel.postMessage({ type: 'clock', position: now });
        lastClock = performance.now();
        setPosition(now);
        request();
      }
      const buffered = v.buffered.length
        ? v.buffered.end(v.buffered.length - 1)
        : 0;
      const ready = compatCanPlay(
        now,
        s.readyThrough,
        buffered,
        s.phase === 'ended',
        c.initial,
      );
      setBuffering((!ready || v.readyState < 3) && !stopped());
      if (c.paused || !ready || stopped()) {
        v.pause();
        audio.pause();
        setPlaying(false);
        return;
      }
      c.initial = false;
      v.playbackRate = c.rate;
      v.volume = c.original;
      if (v.paused && !playingRequest) {
        playingRequest = true;
        void v
          .play()
          .catch(() => {
            c.paused = true;
            setError(
              zh ? '请点击播放以开始观看' : 'Click Play to begin watching.',
            );
          })
          .finally(() => (playingRequest = false));
      }
      setPlaying(!v.paused);
      if (
        segment &&
        now >= segment.end - 0.03 &&
        !segment.skipped &&
        planDub(segment, segment.start, c.rate).truncated &&
        audio.currentTime < segment.audioDuration - 0.05
      ) {
        segment.skipped = true;
        setSkipped((n) => n + 1);
      }
      const active = activeSegment(segments, now);
      setCaption(c.subtitles ? (active ?? null) : null);
      if (!active || v.paused || v.readyState < 3) {
        clearAudio();
        return;
      }
      const plan = planDub(active, now, v.playbackRate);
      if (plan.expired) {
        clearAudio();
        return;
      }
      if (segment?.id !== active.id) {
        clearAudio();
        segment = active;
        audioURL = URL.createObjectURL(
          new Blob([decode64(active.audio)], { type: 'audio/wav' }),
        );
        audio.src = audioURL;
        audio.dataset.segmentId = active.id;
        audio.dataset.sourceStart = String(active.start);
        audio.dataset.sourceEnd = String(active.end);
        audio.dataset.truncated = String(plan.truncated);
      }
      audio.volume = c.dub;
      audio.playbackRate = plan.rate;
      if (Math.abs(audio.currentTime - plan.offset) > 0.16)
        try {
          audio.currentTime = Math.max(
            0,
            Math.min(plan.offset, active.audioDuration),
          );
        } catch {}
      if (audio.paused && !audioPending) {
        audioPending = true;
        const currentId = active.id;
        void audio
          .play()
          .catch((error) => {
            if (segment?.id !== currentId || error?.name === 'AbortError')
              return;
            c.paused = true;
            fail(new Error('Click Play to enable translated audio.'));
          })
          .finally(() => {
            audioPending = false;
          });
      }
    };
    const timer = setInterval(tick, 40);
    v.addEventListener('waiting', () => audio.pause(), { signal: ac.signal });
    v.addEventListener(
      'seeking',
      () => {
        clearAudio();
        ctl.current.initial = false;
      },
      { signal: ac.signal },
    );
    v.addEventListener(
      'error',
      () => fail(new Error(v.error?.message ?? 'Video playback failed.')),
      { signal: ac.signal },
    );
    void chrome.runtime
      .sendMessage({ target: 'background', type: 'compat:get' })
      .then((r) => {
        if (r.ok && r.value?.id === id) {
          currentState = r.value;
          setState(r.value);
        } else fail(new Error('This capture session has ended.'));
      });
    return () => {
      closed = true;
      ac.abort();
      clearInterval(timer);
      channel.close();
      clearAudio();
      audio.remove();
      v.pause();
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(objectURL);
    };
  }, [id]);
  useEffect(() => {
    document.documentElement.lang = zh ? 'zh-CN' : 'en';
    document.title = zh ? '听译 · 兼容播放器' : 'Qwen Video Dub · Player';
  }, [zh]);
  useEffect(() => {
    ctl.current.subtitles = captions;
    ctl.current.original = original;
    ctl.current.dub = dub;
    ctl.current.rate = rate;
    if (!captions) setCaption(null);
  }, [captions, original, dub, rate]);
  const toggle = () => {
    ctl.current.paused = !ctl.current.paused;
    if (!ctl.current.paused) setError('');
    setPlaying(!ctl.current.paused);
  };
  const seek = (n: number) => {
    if (video.current) {
      video.current.currentTime = n;
      setPosition(n);
    }
  };
  return (
    <main>
      <header>
        <div className="brand">
          Qwen Video Dub{' '}
          <span>{text('Compatibility player', '兼容播放器')}</span>
        </div>
        <button
          onClick={() =>
            void chrome.runtime.sendMessage({
              target: 'background',
              type: 'compat:stop',
            })
          }
        >
          {text('Stop translation', '停止翻译')}
        </button>
      </header>
      <h1>
        {state?.candidate.title ??
          text('Connecting to capture…', '正在连接采集…')}
      </h1>
      <p className="intro">
        {text(
          'The source tab plays silently while this window buffers its picture and translated voice. Keep the source video visible in its tab.',
          '原标签页静音提供画面与声音，本窗口缓冲后播放译音。请保持原标签页中的视频可见。',
        )}
      </p>
      <div className="screen" ref={frame}>
        <video ref={video} playsInline />
        {captions && caption && (
          <div className="captions">
            <div>{caption.sourceText}</div>
            <strong>{caption.text}</strong>
          </div>
        )}
        {buffering && (
          <div className="loading">
            {text('Preparing translated video…', '正在准备翻译画面…')}
            <small>
              {text('Translated', '已译')} {stamp(state?.readyThrough ?? 0)} ·{' '}
              {text('Captured', '已采集')} {stamp(state?.capturedThrough ?? 0)}
            </small>
          </div>
        )}
        <div className="controls">
          <button
            disabled={!!state && ['error', 'stopped'].includes(state.phase)}
            onClick={toggle}
          >
            {playing ? text('Pause', '暂停') : text('Play', '播放')}
          </button>
          <span>{stamp(position)}</span>
          <input
            aria-label={text(
              'Seek in translated buffer',
              '在已翻译缓冲区内跳转',
            )}
            type="range"
            min={Math.max(0, position - 120)}
            max={Math.max(0.01, state?.readyThrough ?? 0)}
            value={position}
            step=".1"
            onChange={(e) => seek(+e.target.value)}
          />
          <select
            aria-label={text('Playback speed', '播放速度')}
            value={rate}
            onChange={(e) => setRate(+e.target.value)}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((n) => (
              <option key={n} value={n}>
                {n}×
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              void (document.fullscreenElement
                ? document.exitFullscreen()
                : frame.current?.requestFullscreen())
            }
          >
            {text('Fullscreen', '全屏')}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {compatError(error, state?.uiLanguage ?? 'en')}
        </p>
      )}
      <div className="mix">
        <label>
          {text('Original audio', '原声音量')}
          <input
            type="range"
            min="0"
            max="1"
            step=".01"
            value={original}
            onChange={(e) => setOriginal(+e.target.value)}
          />
        </label>
        <label>
          {text('Translated audio', '译音音量')}
          <input
            type="range"
            min="0"
            max="1"
            step=".01"
            value={dub}
            onChange={(e) => setDub(+e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={captions}
            onChange={(e) => setCaptions(e.target.checked)}
          />
          {text('Bilingual subtitles', '双语字幕')}
        </label>
      </div>
      <footer>
        {text(
          'Original voice · Video and translation share the recorded timeline. Seeking is limited to the translated buffer.',
          '保留原音色 · 画面与译音使用同一录制时间轴，可在已翻译缓冲区内跳转。',
        )}
        <br />
        {text(
          'Audio and scripts save in local chunks and merge when translation stops or finishes.',
          '音频和脚本分段暂存本机，停止或完成翻译时自动合并。',
        )}{' '}
        {skipped > 0 &&
          text(
            `${skipped} utterances skipped expired audio.`,
            `${skipped} 句已跳过过期译音。`,
          )}{' '}
        {state?.sourcePaused &&
          text(
            'Source paused while the prepared buffer catches up.',
            '正在准备缓冲，原播放器已自动暂停。',
          )}
        {state?.phase === 'stopped' &&
          text(
            'Translation stopped. Source settings restored.',
            '翻译已停止，原播放器设置已恢复。',
          )}
        {state?.phase === 'ended' &&
          text('Capture and translation complete.', '采集及翻译完成。')}
      </footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);

"use client";

import { useEffect, useRef, useState } from "react";
import { AGENTS, type AgentKey } from "@/domain/agents";
import { AGENT_VOICE } from "@/domain/agent-voice";

type Turn = { who: "you" | "agent"; text: string; source?: string };

/** Picks the installed browser voice closest to the agent's hints (fallback path only). */
function pickBrowserVoice(key: AgentKey): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  for (const hint of AGENT_VOICE[key].hints) {
    const v = voices.find((x) => x.name.toLowerCase().includes(hint.toLowerCase()));
    if (v) return v;
  }
  return voices.find((v) => v.lang.startsWith("en")) ?? voices[0] ?? null;
}

/** 16 kHz mono 16-bit PCM WAV from captured audio frames. */
function encodeWav(frames: Float32Array[], sampleRate: number): Blob {
  const target = 16000;
  const total = frames.reduce((n, f) => n + f.length, 0);
  const input = new Float32Array(total);
  let o = 0;
  for (const f of frames) {
    input.set(f, o);
    o += f.length;
  }
  const ratio = sampleRate / target;
  const outLen = Math.floor(input.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    const s = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const str = (off: number, s: string) => [...s].forEach((c, i) => dv.setUint8(off + i, c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, target, true);
  dv.setUint32(28, target * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Talk to an agent. Speech is produced and recognised on the server (Windows speech engine),
 * so it works in any browser; the browser's own speech is only a fallback.
 */
export function AgentVoice({ agentKey }: { agentKey: AgentKey }) {
  const agent = AGENTS[agentKey];
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.getVoices();
    return () => {
      audioRef.current?.pause();
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    };
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns]);

  const speak = async (text: string) => {
    if (muted) return;
    audioRef.current?.pause();
    try {
      const res = await fetch(`/api/agents/${agentKey}/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (res.ok && res.status === 200) {
        setEngine(res.headers.get("x-voice"));
        const url = URL.createObjectURL(await res.blob());
        const a = new Audio(url);
        audioRef.current = a;
        a.onplay = () => setSpeaking(true);
        a.onended = () => {
          setSpeaking(false);
          URL.revokeObjectURL(url);
        };
        a.onerror = () => setSpeaking(false);
        await a.play();
        return;
      }
    } catch {
      // fall through to the browser's own speech
    }
    if (typeof speechSynthesis === "undefined") {
      setNote("No speech engine is available here; the answer is shown as text.");
      return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickBrowserVoice(agentKey);
    if (v) u.voice = v;
    u.pitch = AGENT_VOICE[agentKey].pitch;
    u.rate = AGENT_VOICE[agentKey].rate;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    speechSynthesis.speak(u);
  };

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setQuestion("");
    setNote(null);
    setTurns((t) => [...t, { who: "you", text }]);
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${agentKey}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: text }) });
      const data = (await res.json()) as { answer?: string; source?: string; error?: string };
      const answer = data.answer ?? data.error ?? "I could not answer that.";
      setTurns((t) => [...t, { who: "agent", text: answer, source: data.source }]);
      void speak(answer);
    } catch {
      setTurns((t) => [...t, { who: "agent", text: "I could not reach my records just now." }]);
    } finally {
      setBusy(false);
    }
  };

  /** Hold-to-talk: records from the microphone until pressed again, then sends it to be transcribed. */
  const listen = async () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    setNote(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      setNote("Microphone access was refused or no microphone was found.");
      return;
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const frames: Float32Array[] = [];
    proc.onaudioprocess = (e) => frames.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc);
    proc.connect(ctx.destination);
    setListening(true);
    const autoStop = setTimeout(() => recRef.current?.stop(), 15_000);
    recRef.current = {
      stop: async () => {
        clearTimeout(autoStop);
        proc.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        await ctx.close().catch(() => undefined);
        recRef.current = null;
        setListening(false);
        const wav = encodeWav(frames, ctx.sampleRate);
        if (wav.size < 2000) {
          setNote("I did not hear anything.");
          return;
        }
        setBusy(true);
        try {
          const res = await fetch(`/api/agents/${agentKey}/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
          const data = (await res.json()) as { text?: string; error?: string };
          setBusy(false);
          if (data.text) void ask(data.text);
          else setNote(data.error ?? "I could not make out any words. Try again, a little closer to the microphone.");
        } catch {
          setBusy(false);
          setNote("The recording could not be sent.");
        }
      },
    };
  };

  return (
    <section className="hud rounded-md border border-line bg-surface" style={{ "--agent": agent.color } as React.CSSProperties}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow text-text">Talk to {agent.name}</span>
        <span className="text-[12px] text-muted">
          {AGENT_VOICE[agentKey].style} · answers only from recorded work{engine ? <> · voice: {engine === "windows" ? "Windows (basic)" : engine}</> : null}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {speaking ? (
            <span className="flex items-end gap-0.5" aria-label="speaking">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="voice-bar w-1 rounded-sm" style={{ background: agent.color, animationDelay: `${i * 0.12}s` }} />
              ))}
            </span>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={() => setMuted((m) => !m)} title={muted ? "Unmute" : "Mute"}>
            {muted ? "Muted" : "Sound on"}
          </button>
        </span>
      </div>
      <div ref={logRef} className="max-h-64 space-y-2 overflow-y-auto px-4 py-3">
        {turns.length === 0 ? <p className="text-[13.5px] text-muted">Ask what {agent.name} is doing, what it has been doing today, or about a dealership by name. Press Mic, speak, then press it again to send.</p> : null}
        {turns.map((t, i) => (
          <div key={i} className={`max-w-[88%] rounded-md px-3 py-2 text-[13.5px] leading-relaxed ${t.who === "you" ? "ml-auto bg-charcoal-2" : "border border-line"}`} style={t.who === "agent" ? { borderColor: `${agent.color}66` } : undefined}>
            <span className="num mr-2 text-[10px] uppercase tracking-[0.12em]" style={{ color: t.who === "agent" ? agent.color : "var(--color-muted)" }}>
              {t.who === "agent" ? agent.name : "You"}
            </span>
            {t.text}
            {t.source === "rules" ? <span className="num ml-2 text-[10px] uppercase tracking-[0.1em] text-faint">from records</span> : t.source === "ai" ? <span className="num ml-2 text-[10px] uppercase tracking-[0.1em] text-faint">ai · grounded</span> : null}
          </div>
        ))}
        {note ? <p className="text-[12.5px] text-warn">{note}</p> : null}
      </div>
      <form
        className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <button type="button" className={`btn btn-sm ${listening ? "btn-primary" : ""}`} onClick={() => void listen()} disabled={busy} title={listening ? "Press to send" : "Press, speak, press again to send"}>
          {listening ? "Listening… press to send" : "Mic"}
        </button>
        <input className="input flex-1" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={`Ask ${agent.name} a question`} disabled={busy} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !question.trim()}>
          Ask
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void ask("Give me a briefing of what you have been doing.")} disabled={busy}>
          Briefing
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void speak(`Hi, I'm ${agent.name}, the ${agent.role.toLowerCase()}.`)} disabled={busy} title="Hear this agent's voice">
          Test voice
        </button>
      </form>
      <style>{`@keyframes voice-bar{0%,100%{height:4px}50%{height:16px}} .voice-bar{height:4px;animation:voice-bar .7s ease-in-out infinite}`}</style>
    </section>
  );
}

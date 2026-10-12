import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Speech through the Windows speech engine (System.Speech via PowerShell), so agents can talk
 * and listen from any browser — including ones with no speech engine of their own. On a
 * machine without PowerShell or the engine, both functions return null and the browser's own
 * speech is used instead.
 */

const PS = process.platform === "win32" ? "powershell.exe" : null;

function runPowerShell(script: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    if (!PS) return resolve({ ok: false, out: "not windows" });
    const child = spawn(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, out: code === 0 ? out.trim() : `${err || out}`.trim() });
    });
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, out: e.message });
    });
  });
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export type WindowsVoice = { gender: "Male" | "Female"; pitch: string; rate: number };

/** Speaks `text` to a WAV file and returns its bytes, or null when the engine is unavailable. */
export async function synthesizeWav(text: string, voice: WindowsVoice): Promise<Buffer | null> {
  if (!PS) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), "di-tts-"));
  const ssmlPath = path.join(dir, "say.xml");
  const wavPath = path.join(dir, "say.wav");
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><prosody pitch="${voice.pitch}">${xml(text.slice(0, 1200))}</prosody></speak>`;
  await writeFile(ssmlPath, ssml, "utf8");
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `try { $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::${voice.gender}) } catch {}`,
    `$s.Rate = ${Math.max(-10, Math.min(10, Math.round(voice.rate)))}`,
    `$s.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}')`,
    `$s.SpeakSsml([System.IO.File]::ReadAllText('${ssmlPath.replace(/'/g, "''")}'))`,
    "$s.Dispose()",
    "'ok'",
  ].join("; ");
  try {
    const r = await runPowerShell(script, 30_000);
    if (!r.ok) return null;
    return await readFile(wavPath);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Transcribes a 16 kHz mono 16-bit PCM WAV with the Windows dictation recognizer. */
export async function recognizeWav(wav: Buffer): Promise<string | null> {
  if (!PS) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), "di-stt-"));
  const wavPath = path.join(dir, "in.wav");
  await writeFile(wavPath, wav);
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine",
    "$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))",
    `$r.SetInputToWaveFile('${wavPath.replace(/'/g, "''")}')`,
    "$parts = @()",
    // Recognize() keeps returning the final phrase once the file is exhausted; stop on the first repeat.
    "for ($i = 0; $i -lt 6; $i++) { $res = $r.Recognize(); if ($null -eq $res) { break }; if ($parts.Count -gt 0 -and $parts[-1] -eq $res.Text) { break }; $parts += $res.Text }",
    "$r.Dispose()",
    "($parts -join ' ')",
  ].join("; ");
  try {
    const r = await runPowerShell(script, 45_000);
    if (!r.ok) return null;
    return r.out.trim() || "";
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Narration backends for the demo video.
 *
 * Two engines, selected with VO_ENGINE:
 *
 *   say         macOS built-in. No account, no cost, noticeably synthetic.
 *   higgsfield  Higgsfield text-to-speech. Needs `higgsfield auth login` and a
 *               selected workspace. Costs about 2 credits per segment.
 *
 * Either way the output is normalised to the same AAC parameters so the concat
 * step downstream does not care which produced it.
 *
 * Neither is a substitute for recording the narration in a human voice, which is
 * what docs/DEMO_SCRIPT.md documents how to swap in.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

import { spoken } from "./segments.mjs";

export const ENGINE = process.env.VO_ENGINE ?? "higgsfield";

/** macOS `say` voice. */
export const SAY_VOICE = process.env.VO_VOICE ?? "Samantha";

/**
 * Higgsfield preset voice: Sloane, chosen on a side-by-side read of the hook.
 * For reference on pace, the same line clocked Zane 10.2s, Orion 11.8s,
 * Sloane 14.4s, Marcus 16.3s.
 */
export const HF_VOICE_ID = process.env.HF_VOICE_ID ?? "b57b22a0-f287-405b-bc82-6f08f5e6bb1f";
export const HF_VARIANT = process.env.HF_VARIANT ?? "elevenlabs";

const run = (cmd, args) =>
  String(execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 << 20 }));

const ff = (args) => run("ffmpeg", ["-y", "-loglevel", "error", ...args]);

function toAac(input, out) {
  ff(["-i", input, "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "160k", out]);
}

function viaSay(text, out) {
  const aiff = out.replace(/\.\w+$/, ".aiff");
  // Plain aiff only: passing --data-format makes `say` reject the output file.
  run("say", ["-v", SAY_VOICE, "-o", aiff, spoken(text)]);
  toAac(aiff, out);
}

function viaHiggsfield(text, out) {
  const created = run("higgsfield", [
    "generate", "create", "text2speech_v2",
    "--prompt", spoken(text),
    "--variant", HF_VARIANT,
    "--voice-id", HF_VOICE_ID,
    "--voice-type", "preset",
    "--json",
  ]);
  const [jobId] = JSON.parse(created);
  if (!jobId) throw new Error(`Higgsfield returned no job id: ${created}`);

  const done = JSON.parse(run("higgsfield", ["generate", "wait", jobId, "--json"]));
  if (done.status !== "completed") {
    throw new Error(`Higgsfield job ${jobId} ended as ${done.status}`);
  }
  const url = done.result_url;
  if (!url) throw new Error(`Higgsfield job ${jobId} completed with no result_url`);

  const mp3 = out.replace(/\.\w+$/, ".mp3");
  run("curl", ["-sSL", "--max-time", "180", "-o", mp3, url]);
  if (!existsSync(mp3)) throw new Error(`download failed for ${url}`);
  toAac(mp3, out);
}

/**
 * Synthesises one segment's narration.
 *
 * @param text - Narration text, whitespace-collapsed internally
 * @param out - Destination .m4a path
 * @returns Duration in seconds
 */
export function synthesise(text, out) {
  // Cache on the exact text plus engine and voice, so rebuilding for a visual or
  // mix change costs nothing. Higgsfield charges per generation.
  const key = createHash("sha256")
    .update([ENGINE, SAY_VOICE, HF_VOICE_ID, HF_VARIANT, spoken(text)].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  const CACHE = "docs/media/.vo-cache";
  mkdirSync(CACHE, { recursive: true });
  const cached = `${CACHE}/${key}.m4a`;

  if (existsSync(cached)) {
    copyFileSync(cached, out);
  } else {
    if (ENGINE === "higgsfield") viaHiggsfield(text, out);
    else if (ENGINE === "say") viaSay(text, out);
    else throw new Error(`unknown VO_ENGINE ${JSON.stringify(ENGINE)}; use say or higgsfield`);
    copyFileSync(out, cached);
  }

  const d = Number(
    run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
                    "-of", "default=nw=1:nk=1", out]).trim(),
  );
  if (!Number.isFinite(d) || d <= 0) throw new Error(`no audio produced for ${out}`);
  return d;
}

export function describeEngine() {
  return ENGINE === "higgsfield"
    ? `higgsfield ${HF_VARIANT} voice=${HF_VOICE_ID.slice(0, 8)}`
    : `macOS say voice=${SAY_VOICE}`;
}

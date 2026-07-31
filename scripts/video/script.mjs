/**
 * Generates docs/DEMO_SCRIPT.md from the same segment list that builds the video,
 * so the written script cannot drift from what the video actually says.
 *
 *   node scripts/video/script.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { SEGMENTS, estimateSeconds, spoken } from "./segments.mjs";

/**
 * Measured durations from the last build, when available. Falling back to the
 * word-count estimate would make this file claim a runtime the video does not
 * have, which is exactly the sort of small inaccuracy that erodes trust.
 */
const TIMINGS_PATH = "docs/media/timings.json";
const measured = existsSync(TIMINGS_PATH)
  ? JSON.parse(readFileSync(TIMINGS_PATH, "utf8"))
  : null;
// Segment length is the narration length: that is what build.mjs assembles to,
// and summing it matches the finished file. `hold` in timings.json carries
// per-segment padding, and summing that claimed a runtime the video never had.
const holdFor = (seg) =>
  measured?.segments?.find((s) => s.id === seg.id)?.narration ??
  estimateSeconds(seg.narration);

const mmss = (t) => {
  const w = Math.round(t);
  return `${Math.floor(w / 60)}:${String(w % 60).padStart(2, "0")}`;
};
const TICK = "`";
const FENCE = TICK.repeat(3);

/**
 * Duration of an asciicast, in seconds.
 *
 * Read from the file rather than written down. This number was hardcoded at 13
 * and the capture had since been re-recorded at 18.6, which is the same drift
 * that has bitten every hand-maintained figure in this repository.
 */
function castSeconds(path) {
  const events = readFileSync(path, "utf8").trim().split("\n").slice(1).filter((l) => l.trim());
  return JSON.parse(events[events.length - 1])[0];
}

function onScreen(seg) {
  if (seg.kind === "terminal") {
    // Name the command this segment actually captured. Hardcoding `npm start`
    // mislabelled the agent segment, which is a separate live paid call made
    // through the buyer skill with its own on-chain transaction. That
    // undersold it rather than merely being inaccurate.
    const command = seg.cast?.includes("skill") ? "npm run buy -- --verify" : "npm start";
    return `Real asciinema capture of ${TICK}${command}${TICK}, slowed to fill the narration.`;
  }
  if (seg.kind === "code") {
    const files = seg.code.files.map((f) => `${TICK}${f.path}${TICK}`).join(" and ");
    return `Code panels read off disk at build time: ${files}. Caption: ${seg.code.note}`;
  }
  if (seg.slide.layout === "image") {
    return `Full-frame screenshot: ${TICK}${seg.slide.image}${TICK}`;
  }
  const s = seg.slide;
  const heading = s.title ?? s.subtitle ?? [s.line1, s.line2].filter(Boolean).join(" ");
  return heading
    ? `Slide, ${s.layout} layout. Heading: "${heading}".`
    : `Slide, ${s.layout} layout.`;
}

const rows = [];
let at = 0;
for (const seg of SEGMENTS) {
  const secs = holdFor(seg);
  rows.push({ seg, from: mmss(at), to: mmss(at + secs), secs });
  at += secs;
}

const body = rows
  .map(
    ({ seg, from, to }) => `## ${from} to ${to} · ${seg.id}

**On screen.** ${onScreen(seg)}

**Narration.**

> ${spoken(seg.narration)}`,
  )
  .join("\n\n---\n\n");

const md = `# Demo video script

Runtime **${mmss(at)}**, against the bounty's five minute ceiling.

Generated from ${TICK}scripts/video/segments.mjs${TICK}, which is also what builds the
video, with per-segment timings measured from the rendered audio, so this file and
the video cannot disagree.

${FENCE}bash
node scripts/video/script.mjs     # regenerate this file
node scripts/video/build.mjs      # build docs/media/demo-video.mp4
${FENCE}

## Re-recording the narration in your own voice

The rendered video ships with a synthesised narrator (${measured?.engine ?? "macOS say"}). Every visual in it is real, but the voice is not, and for a submission
that trades on credibility a human read is better. Two ways to replace it.

Whole track, against the timings below:

${FENCE}bash
ffmpeg -i docs/media/demo-video.mp4 -i your-voice.m4a \\
  -map 0:v -map 1:a -c:v copy -c:a aac -shortest docs/media/demo-video-vo.mp4
${FENCE}

Or segment by segment, dropping your own audio into ${TICK}docs/media/.build/${TICK} under
the matching segment id and re-running the build, which reassembles and re-times
around whatever audio it finds.

---

${body}

---

## Notes for a live take

- The run itself takes about ${Math.round(castSeconds("docs/media/demo.cast"))} seconds. The video slows the real capture to
  fill the narration. If you present live instead, pause between the two acts
  rather than rushing your delivery.
- Say two things out loud, because they pre-empt the sharpest objections a
  technical judge will raise. First, the verifier shares a process with the buyer
  in this demo and would be an independent party in production. Second, we wrote
  the dishonest seller, so the fair question is whether the check survives a liar
  we did not write.
- Never show ${TICK}.env${TICK} on screen.
- Each take spends about 0.02 testnet HBAR. Retakes are effectively free, but
  transaction ids change every run, so capture links from the take you keep.
- Rehearse once before recording. It confirms the facilitator is reachable and
  warms the mirror node.
`;

writeFileSync("docs/DEMO_SCRIPT.md", md);
console.log(`wrote docs/DEMO_SCRIPT.md  ${rows.length} segments, runtime ${mmss(at)}`);

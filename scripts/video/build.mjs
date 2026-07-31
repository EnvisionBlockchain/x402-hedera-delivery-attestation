/**
 * Builds the demo video from the declarative segment list.
 *
 * Per segment: render a 1920x1080 still (or use the real terminal capture),
 * synthesise the narration, hold the visual for exactly as long as the narration
 * runs. Then concat, then mix a score underneath.
 *
 * Everything visual is real. Slides are typeset from this repo's own content, code
 * panels are excerpts read off disk at build time and anchored on distinctive
 * lines so they fail loudly rather than drift silently, and the terminal segment
 * is a genuine asciinema PTY capture of `npm start`.
 *
 * Visual language follows envisionblockchain.com: near-black ground, Source Serif
 * display, IBM Plex for sans and mono, the cyan-to-lavender gradient used once per
 * frame, tight corner radii.
 *
 *   node scripts/video/build.mjs
 *   VO_ENGINE=higgsfield node scripts/video/build.mjs
 *   NO_MUSIC=1 node scripts/video/build.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { MUSIC, SEGMENTS, THEME as T } from "./segments.mjs";
import { describeEngine, synthesise } from "./narrate.mjs";

const W = 1920;
const H = 1080;
const FPS = 30;
const WORK = "docs/media/.build";
const OUT = "docs/media/demo-video.mp4";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const run = (cmd, args) =>
  String(execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }));
const ff = (args) => run("ffmpeg", ["-y", "-loglevel", "error", ...args]);

const durationOf = (f) =>
  Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
                         "-of", "default=nw=1:nk=1", f]).trim());

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// ------------------------------------------------------------------ brand shell

const FONTS =
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&" +
  "family=IBM+Plex+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap";

const shell = (inner) => `<!doctype html><meta charset=utf-8>
<link rel=stylesheet href="${FONTS}">
<style>
  *{box-sizing:border-box;margin:0}
  body{width:${W}px;height:${H}px;background:${T.bg};color:${T.text};overflow:hidden;
    font-family:${T.ffSans};display:flex;flex-direction:column;justify-content:center;
    padding:92px 110px;position:relative;-webkit-font-smoothing:antialiased}
  /* the signature iridescent hairline, once per frame and never louder */
  body::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;
    background:linear-gradient(100deg,${T.iri1},${T.iri3})}
  .kicker{font-family:${T.ffMono};color:${T.iri1};font-size:21px;letter-spacing:.2em;
    text-transform:uppercase}
  h1{font-family:${T.ffDisplay};font-size:92px;line-height:1.04;letter-spacing:-.02em;font-weight:600}
  h2{font-family:${T.ffDisplay};font-size:58px;line-height:1.1;letter-spacing:-.016em;
    font-weight:600;margin-bottom:48px}
  .lede{font-family:${T.ffDisplay};font-size:74px;line-height:1.12;font-weight:600;letter-spacing:-.018em}
  .lede em{font-style:normal;background:linear-gradient(100deg,${T.iri1},${T.iri3});
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{font-size:33px;color:${T.dim};margin-top:34px;line-height:1.4;max-width:1340px}
  .foot{position:absolute;left:110px;bottom:70px;color:${T.dimmer};font-size:21px;font-family:${T.ffMono}}
  .note{margin-top:46px;color:${T.dim};font-size:26px;line-height:1.5;
    border-left:2px solid ${T.iri4};padding-left:26px;max-width:1420px}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:52px}
  .card{background:${T.panel};border:1px solid ${T.line};border-radius:6px;padding:40px 42px}
  .card h3{font-family:${T.ffMono};font-size:20px;letter-spacing:.16em;text-transform:uppercase;
    font-weight:500;margin-bottom:28px}
  .ok h3{color:${T.good}} .no h3{color:${T.bad}}
  li{font-size:28px;line-height:1.7;list-style:none;padding-left:36px;position:relative;color:${T.text}}
  .ok li::before{content:"\\2192";position:absolute;left:0;color:${T.good}}
  .no li::before{content:"\\00D7";position:absolute;left:0;color:${T.bad};font-size:32px}
  table{width:100%;border-collapse:collapse;font-size:29px}
  td{padding:28px 22px;border-bottom:1px solid ${T.line};vertical-align:top}
  td.k{font-weight:500;width:44%} td.v{color:${T.dim}}
  .hl{margin-top:42px;background:${T.bgLift};border:1px solid ${T.line};border-radius:6px;
    padding:30px 34px;font-family:${T.ffMono};font-size:25px;text-align:center;
    color:${T.iri2};letter-spacing:-.01em}
  pre{font-family:${T.ffMono};font-size:21px;line-height:1.55;background:${T.bgLift};
    border:1px solid ${T.line};border-radius:6px;padding:26px 30px;overflow:hidden;
    white-space:pre;color:${T.text}}
  .fname{font-family:${T.ffMono};color:${T.iri1};font-size:20px;margin:0 0 12px 2px}
  .kw{color:${T.iri3}}.str{color:${T.iri2}}.cm{color:${T.dimmer};font-style:italic}
  img{width:100%;max-height:760px;border-radius:6px;border:1px solid ${T.line};
    object-fit:cover;object-position:top}
  table.tree td,table.steps td{padding:15px 22px;font-size:26px}
  td.p{font-family:${T.ffMono};color:${T.iri1};white-space:pre;width:40%;font-size:24px}
  table.steps td.n{font-family:${T.ffMono};color:${T.dimmer};width:56px;font-size:22px}
  table.steps td.p{width:34%}
</style>${inner}`;

const layouts = {
  hook: (s) =>
    shell(`<div class=lede>${esc(s.line1)}<br><em>${esc(s.line2)}</em></div>
      <div class=sub>${esc(s.line3)}</div>`),

  close: (s) =>
    shell(`<div class=kicker>${esc(s.kicker)}</div>
      <h1 style="margin-top:30px">${esc(s.line1)}<br>${esc(s.line2)}</h1>
      <div class=foot>${esc(s.footer)}</div>`),

  split: (s) =>
    shell(`<h2>${esc(s.title)}</h2><div class=cols>
      <div class="card ok"><h3>${esc(s.leftHeading)}</h3><ul>
        ${s.left.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>
      <div class="card no"><h3>${esc(s.rightHeading)}</h3><ul>
        ${s.right.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>
      </div><div class=note>${esc(s.note)}</div>`),

  compare: (s) =>
    shell(`<h2>${esc(s.title)}</h2><table>
      ${s.rows.map((r) => `<tr><td class=k>${esc(r.left)}</td><td class=v>${esc(r.right)}</td></tr>`).join("")}
      </table><div class=hl>${esc(s.highlight)}</div><div class=note>${esc(s.note)}</div>`),

  image: (s) => shell(`<h2>${esc(s.title)}</h2><img src="${basename(s.image)}" alt="">`),

  // Repo tour. Every path is checked against disk so the slide cannot describe
  // a layout the repo no longer has.
  tree: (s) => {
    const rows = s.entries.map((e) => {
      if (!existsSync(e.path)) throw new Error(`tree slide references missing path ${e.path}`);
      return `<tr><td class=p>${esc(e.label)}</td><td class=v>${esc(e.what)}</td></tr>`;
    });
    return shell(`<h2>${esc(s.title)}</h2>
      <table class=tree>${rows.join("")}</table>
      <div class=note>${esc(s.note)}</div>`);
  },

  // Run-it-yourself. Each npm command is verified to exist in package.json.
  steps: (s) => {
    const defined = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    const rows = s.steps.map((st, i) => {
      const script = st.cmd.startsWith("npm run ")
        ? st.cmd.slice(8)
        : st.cmd === "npm start"
          ? "start"
          : st.cmd === "npm test"
            ? "test"
            : null;
      if (script !== null && !(script in defined)) {
        throw new Error(`steps slide references missing npm script ${JSON.stringify(script)}`);
      }
      return `<tr><td class=n>${i + 1}</td><td class=p>${esc(st.cmd)}</td>
        <td class=v>${esc(st.what)}</td></tr>`;
    });
    return shell(`<h2>${esc(s.title)}</h2>
      <table class=steps>${rows.join("")}</table>
      <div class=note>${esc(s.note)}</div>`);
  },
};

function highlight(src) {
  return esc(src)
    .replace(/(\/\/[^\n]*)/g, "<span class=cm>$1</span>")
    .replace(/\b(const|let|return|function|export|async|await|if|import|from|new|type)\b/g,
             "<span class=kw>$1</span>")
    .replace(/(&quot;[^&]*?&quot;|`[^`]*?`|'[^']*?')/g, "<span class=str>$1</span>");
}

function excerpt({ path, find, lines }) {
  const all = readFileSync(path, "utf8").split("\n");
  const at = all.findIndex((l) => l.includes(find));
  if (at < 0) throw new Error(`anchor ${JSON.stringify(find)} not found in ${path}`);
  return { path, body: all.slice(at, at + lines).join("\n").replace(/\s+$/, "") };
}

const codeSlide = (c) => {
  const panels = c.files.map(excerpt);
  return shell(`<h2>${esc(c.title)}</h2>
    <div class=cols style="grid-template-columns:${panels.length > 1 ? "1fr 1fr" : "1fr"}">
      ${panels.map((p) => `<div><div class=fname>${esc(p.path)}</div><pre>${highlight(p.body)}</pre></div>`).join("")}
    </div><div class=note>${esc(c.note)}</div>`);
};

// ------------------------------------------------------------------- rendering

function renderStill(html, out, assets = []) {
  const page = `${WORK}/${basename(out, ".png")}.html`;
  writeFileSync(page, html);
  for (const a of assets) run("cp", [a, `${WORK}/${basename(a)}`]);
  run(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    `--window-size=${W},${H}`, "--default-background-color=05070bff",
    // webfonts need a beat to arrive or the frame renders in a fallback face
    "--virtual-time-budget=6000",
    `--screenshot=${process.cwd()}/${out}`, `file://${process.cwd()}/${page}`,
  ]);
}

const stillClip = (png, seconds, out) =>
  ff(["-loop", "1", "-framerate", String(FPS), "-i", png, "-t", seconds.toFixed(3),
      "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${T.bg},format=yuv420p`,
      "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "20", out]);

const castDuration = (cast) => {
  const ev = readFileSync(cast, "utf8").trim().split("\n").slice(1).filter((l) => l.trim());
  return JSON.parse(ev[ev.length - 1])[0];
};

/**
 * Real capture, slowed toward the narration length but never past MIN_SPEED.
 *
 * Stretching a 13 second run across a minute reads as broken rather than
 * deliberate: the narration describes the payment while the screen still shows the
 * startup banner. So the playback is floored, and whatever narration is left plays
 * over a hold on the final frame, which is the contrast table and the payoff of
 * the whole segment anyway.
 */
const MIN_SPEED = 0.5;

function terminalClip(cast, seconds, out) {
  const gif = `${WORK}/term.gif`;
  const speed = Math.max(MIN_SPEED, Math.min(1, castDuration(cast) / Math.max(1, seconds - 2)));
  run("agg", ["--theme", "asciinema", "--font-size", "26", "--line-height", "1.45",
              "--fps-cap", String(FPS), "--speed", speed.toFixed(3), cast, gif]);
  const raw = `${WORK}/term-raw.mp4`;
  ff(["-i", gif, "-vf",
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${T.bg},format=yuv420p`,
      "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "20", raw]);
  const have = durationOf(raw);
  ff(["-i", raw, "-vf", `tpad=stop_mode=clone:stop_duration=${Math.max(0, seconds - have).toFixed(3)}`,
      "-t", seconds.toFixed(3), "-r", String(FPS),
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", out]);
  return { have, speed };
}

const mux = (v, a, out) =>
  ff(["-i", v, "-i", a, "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "copy", "-shortest", out]);

/** Generates the score once and caches it; regenerating costs credits. */
function score(seconds) {
  if (existsSync(MUSIC.file)) {
    console.log(`  score: reusing ${MUSIC.file}`);
    return MUSIC.file;
  }
  console.log(`  score: generating ${Math.ceil(seconds)}s bed`);
  const [id] = JSON.parse(run("higgsfield", ["generate", "create", "sonilo_music",
    "--prompt", MUSIC.prompt, "--duration", String(Math.ceil(seconds)), "--json"]));
  const done = JSON.parse(run("higgsfield", ["generate", "wait", id, "--json"]));
  if (done.status !== "completed" || !done.result_url) {
    throw new Error(`score job ${id} ended as ${done.status}`);
  }
  run("curl", ["-sSL", "--max-time", "300", "-o", MUSIC.file, done.result_url]);
  return MUSIC.file;
}

/** Mixes the bed under the finished narration, looping and fading as needed. */
function addScore(video, bed, out) {
  const total = durationOf(video);
  ff(["-i", video, "-stream_loop", "-1", "-i", bed,
      "-filter_complex",
      `[1:a]volume=${MUSIC.gainDb}dB,atrim=0:${total.toFixed(3)},` +
      `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, total - 3).toFixed(3)}:d=3[bed];` +
      // normalize=0 is the important part: amix otherwise divides by the input count
      // and the narration loses 6dB the moment a bed is added.
      `[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,`+
      `alimiter=level_in=1:limit=0.95[a]`,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]);
}

// ----------------------------------------------------------------------- build

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

console.log(`Building demo video  ${describeEngine()}  ${W}x${H}@${FPS}\n`);

const clips = [];
const timings = [];
let total = 0;

for (const seg of SEGMENTS) {
  const audio = `${WORK}/${seg.id}.m4a`;
  const narration = synthesise(seg.narration, audio);
  const hold = narration + 0.7;
  total += hold;
  timings.push({ id: seg.id, narration: +narration.toFixed(2), hold: +hold.toFixed(2) });

  const silent = `${WORK}/${seg.id}-v.mp4`;
  if (seg.kind === "terminal") {
    const { have, speed } = terminalClip(seg.cast, hold, silent);
    console.log(`  ${seg.id.padEnd(18)} ${hold.toFixed(1)}s  capture ${speed.toFixed(2)}x -> ${have.toFixed(1)}s`);
  } else {
    const html = seg.kind === "code" ? codeSlide(seg.code) : layouts[seg.slide.layout](seg.slide);
    renderStill(html, `${WORK}/${seg.id}.png`, seg.slide?.image ? [seg.slide.image] : []);
    stillClip(`${WORK}/${seg.id}.png`, hold, silent);
    console.log(`  ${seg.id.padEnd(18)} ${hold.toFixed(1)}s  ${seg.kind}`);
  }

  const clip = `${WORK}/${seg.id}-final.mp4`;
  mux(silent, audio, clip);
  clips.push(clip);
}

// Round first, then split, or 179.6s formats as "2:60".
const mmss = (t) => {
  const w = Math.round(t);
  return `${Math.floor(w / 60)}:${String(w % 60).padStart(2, "0")}`;
};
console.log(`\n  narration total ${mmss(total)} (ceiling 5:00)`);
if (total > 300) console.warn("  WARNING: over the five minute limit");

writeFileSync("docs/media/timings.json",
  JSON.stringify({ engine: describeEngine(), segments: timings }, null, 2) + "\n");

const list = `${WORK}/concat.txt`;
writeFileSync(list, clips.map((c) => `file '${basename(c)}'`).join("\n"));
const dry = `${WORK}/joined.mp4`;
ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", dry]);

if (process.env.NO_MUSIC) {
  ff(["-i", dry, "-c", "copy", "-movflags", "+faststart", OUT]);
  console.log("  score: skipped (NO_MUSIC)");
} else {
  addScore(dry, score(durationOf(dry) + 8), OUT);
}

console.log(`\n  wrote ${OUT}\n  ${mmss(durationOf(OUT))}  ${W}x${H}`);

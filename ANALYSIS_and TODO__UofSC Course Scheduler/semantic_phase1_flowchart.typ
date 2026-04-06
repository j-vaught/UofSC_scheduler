#set page(width: 11in, height: 7.5in, margin: (x: 0.6in, top: 0.5in, bottom: 0.5in))
#set text(font: "New Computer Modern", size: 9pt)

#let garnet = rgb("#73000A")
#let atlantic = rgb("#466A9F")
#let congaree = rgb("#1F414D")
#let horseshoe = rgb("#65780B")
#let warm-grey = rgb("#676156")
#let black90 = rgb("#363636")
#let black10 = rgb("#ECECEC")
#let light-blue = rgb("#e8f0fe")
#let light-tan = rgb("#f5f0e6")
#let light-green = rgb("#eef5e6")
#let light-purple = rgb("#f0e8fe")

#let box-at(x, y, w, h, body, fill: white, stroke: black90, text-color: black) = {
  place(dx: x, dy: y,
    rect(width: w, height: h, radius: 0pt, fill: fill, stroke: 1pt + stroke,
      align(center + horizon, text(size: 7.5pt, fill: text-color, body))
    )
  )
}

#let ln(x1, y1, x2, y2, color: black90) = {
  place(dx: 0pt, dy: 0pt, line(start: (x1, y1), end: (x2, y2), stroke: 1.2pt + color))
}

#let hd(x, y, dx, dy, color: black90) = {
  let len = calc.sqrt(dx * dx + dy * dy)
  if len == 0 { return }
  let ux = dx / len; let uy = dy / len
  let px = -uy; let py = ux; let s = 4.0
  place(dx: 0pt, dy: 0pt, polygon(fill: color, stroke: none,
    (x * 1pt, y * 1pt),
    ((x - s*ux + s*0.4*px)*1pt, (y - s*uy + s*0.4*py)*1pt),
    ((x - s*ux - s*0.4*px)*1pt, (y - s*uy - s*0.4*py)*1pt)))
}

#let arr(x1, y1, x2, y2, color: black90) = {
  ln(x1, y1, x2, y2, color: color)
  hd(x2.pt(), y2.pt(), (x2 - x1).pt(), (y2 - y1).pt(), color: color)
}

// ================================================================
// TITLE
// ================================================================

#align(center, text(size: 16pt, weight: "bold", fill: garnet)[Semantic Search: Phase 1 --- Build-Time Artifacts])
#v(1pt)
#align(center, text(size: 9pt, fill: warm-grey)[UofSC Course Scheduler --- J.C. Vaught --- April 2026])
#v(2pt)
#align(center, text(size: 8pt, fill: warm-grey)[Offline process, run once per semester via `build_embeddings.py`])

// ================================================================
// Layout following the editor sketch:
//
//   Row 1:  [Model/A02]              [Course Data/A01]
//   Row 2:      [Extract Phrases/A03]    [Extract Descriptions/A04]
//   Row 3:      [Embed Phrases/A05]      [Embed Courses/A06]
//   Row 4:              [PCA/A07]
//   Row 5:  [phrases.json/A08]  [courses.json/A09]  [pca.json/A10]
//
// Model feeds both embed steps (A05, A06) via elbowed arrows.
// Course Data feeds both extract steps (A03, A04).
// ================================================================

// Column positions
#let col-l = 80pt    // left column center
#let col-cl = 220pt  // center-left
#let col-cr = 430pt  // center-right
#let col-r = 570pt   // right column center

// Box sizes
#let bw = 180pt    // standard box width
#let bh = 32pt     // standard box height
#let bw-out = 160pt // output box width

// Row Y positions
#let y1 = 55pt
#let y2 = 140pt
#let y3 = 225pt
#let y4 = 310pt
#let y5 = 400pt

// ================================================================
// ROW 1: Course Data (right) + Model (left)
// ================================================================

// A01: Course Data
#box-at(col-cr, y1, bw, bh,
  [*Course Data from USC*],
  fill: light-tan, stroke: warm-grey)

// A02: Model
#box-at(col-l - 50pt, y1, bw, bh,
  [*Embedding Model*\
  MiniLM-L6-v2],
  fill: light-purple, stroke: congaree)

// ================================================================
// ROW 2: Extract Phrases (center-left) + Extract Descriptions (center-right)
// ================================================================

// A03: Extract Phrases
#box-at(col-cl - 80pt, y2, bw, bh,
  [*Extract Academic Phrases*],
  fill: light-blue, stroke: atlantic)

// A04: Prepare Course Info
#box-at(col-cr, y2, bw, bh,
  [*Prepare Course Information*],
  fill: light-blue, stroke: atlantic)

// ================================================================
// ROW 3: Embed Phrases (center-left) + Embed Courses (center-right)
// ================================================================

// A05: Embed Phrases
#box-at(col-cl - 80pt, y3, bw, bh,
  [*Embed Phrase Information*],
  fill: light-blue, stroke: atlantic)

// A06: Embed Courses
#box-at(col-cr, y3, bw, bh,
  [*Embed Course Information*],
  fill: light-blue, stroke: atlantic)

// ================================================================
// ROW 4: PCA (centered)
// ================================================================

// A07: Compression Layer
#box-at(col-cl + 20pt, y4, bw, bh,
  [*Compression Layer*],
  fill: light-blue, stroke: atlantic)

// ================================================================
// ROW 5: Three output files
// ================================================================

// A08: Phrase Embeddings
#box-at(20pt, y5, bw-out, bh,
  [*Phrase Embeddings*],
  fill: light-green, stroke: horseshoe)

// A09: Course Embeddings
#box-at(col-cl + 10pt, y5, bw-out, bh,
  [*Course Embeddings*],
  fill: light-green, stroke: horseshoe)

// A10: Compression Parameters
#box-at(col-cr + 20pt, y5, bw-out, bh,
  [*Compression Parameters*],
  fill: light-green, stroke: horseshoe)

// ================================================================
// ARROWS
// ================================================================

// Centers of key boxes
#let a01-cx = col-cr + bw/2   // 520
#let a02-cx = col-l - 50pt + bw/2  // 120
#let a03-cx = col-cl - 80pt + bw/2  // 230
#let a04-cx = col-cr + bw/2   // 520
#let a05-cx = col-cl - 80pt + bw/2  // 230
#let a06-cx = col-cr + bw/2   // 520
#let a07-cx = col-cl + 20pt + bw/2  // 330
#let a08-cx = 20pt + bw-out/2  // 100
#let a09-cx = col-cl + 10pt + bw-out/2  // 310
#let a10-cx = col-cr + 20pt + bw-out/2  // 530

// A01 (Data) → A04 (Prepare Course) — straight down
#arr(a04-cx, y1 + bh, a04-cx, y2)

// A01 (Data) → A03 (Extract Phrases) — elbow: down then left
#ln(a01-cx - 40pt, y1 + bh, a01-cx - 40pt, y1 + bh + 16pt)
#ln(a01-cx - 40pt, y1 + bh + 16pt, a03-cx, y1 + bh + 16pt)
#arr(a03-cx, y1 + bh + 16pt, a03-cx, y2)

// A03 → A05 (Embed Phrases) — straight down
#arr(a03-cx, y2 + bh, a03-cx, y3)

// A04 → A06 (Embed Courses) — straight down
#arr(a04-cx, y2 + bh, a04-cx, y3)

// A02 (Model) → A05 (Embed Phrases) — elbow: down, right, down
#let m-bus-y = y2 + bh/2  // midway through row 2
#ln(a02-cx - 20pt, y1 + bh, a02-cx - 20pt, m-bus-y, color: congaree)
#ln(a02-cx - 20pt, m-bus-y, a05-cx - 40pt, m-bus-y, color: congaree)
#arr(a05-cx - 40pt, m-bus-y, a05-cx - 40pt, y3, color: congaree)

// A02 (Model) → A06 (Embed Courses) — elbow: down, right far, down
#ln(a02-cx + 20pt, y1 + bh, a02-cx + 20pt, m-bus-y - 15pt, color: congaree)
#ln(a02-cx + 20pt, m-bus-y - 15pt, a06-cx - 40pt, m-bus-y - 15pt, color: congaree)
#arr(a06-cx - 40pt, m-bus-y - 15pt, a06-cx - 40pt, y3, color: congaree)

// A05 → A07 (Compression) — elbow: down, right
#let merge-y = y3 + bh + 18pt
#ln(a05-cx, y3 + bh, a05-cx, merge-y)
#ln(a05-cx, merge-y, a07-cx - 30pt, merge-y)
#arr(a07-cx - 30pt, merge-y, a07-cx - 30pt, y4)

// A06 → A07 (Compression) — elbow: down, left
#ln(a06-cx, y3 + bh, a06-cx, merge-y)
#ln(a06-cx, merge-y, a07-cx + 30pt, merge-y)
#arr(a07-cx + 30pt, merge-y, a07-cx + 30pt, y4)

// A07 → A08 (Phrase Embeddings) — elbow: down, left
#let fan-y = y4 + bh + 20pt
#ln(a07-cx - 30pt, y4 + bh, a07-cx - 30pt, fan-y, color: horseshoe)
#ln(a07-cx - 30pt, fan-y, a08-cx, fan-y, color: horseshoe)
#arr(a08-cx, fan-y, a08-cx, y5, color: horseshoe)

// A07 → A09 (Course Embeddings) — straight down
#arr(a07-cx, y4 + bh, a09-cx, y5, color: horseshoe)

// A07 → A10 (Compression Params) — elbow: down, right
#ln(a07-cx + 30pt, y4 + bh, a07-cx + 30pt, fan-y, color: horseshoe)
#ln(a07-cx + 30pt, fan-y, a10-cx, fan-y, color: horseshoe)
#arr(a10-cx, fan-y, a10-cx, y5, color: horseshoe)

// ================================================================
// Footer
// ================================================================

#place(dx: 100pt, dy: y5 + bh + 10pt,
  text(size: 7.5pt, fill: warm-grey, style: "italic")[All three files placed in `static/data/` and served to the browser as cached static assets])

// Legend
#let LG = y5 + bh + 30pt
#place(dx: 0pt, dy: LG,
  rect(width: 706pt, height: 28pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 0.5pt + black10, inset: 5pt,
    grid(columns: (12pt, auto, 28pt, 12pt, auto, 28pt, 12pt, auto, 28pt, 12pt, auto),
      column-gutter: 4pt, align: horizon,
      rect(width: 12pt, height: 12pt, fill: light-blue, stroke: 1pt + atlantic),
      text(size: 7pt)[Computation],
      [],
      rect(width: 12pt, height: 12pt, fill: light-tan, stroke: 1pt + warm-grey),
      text(size: 7pt)[Input data],
      [],
      rect(width: 12pt, height: 12pt, fill: light-green, stroke: 1pt + horseshoe),
      text(size: 7pt)[Output artifacts],
      [],
      rect(width: 12pt, height: 12pt, fill: light-purple, stroke: 1pt + congaree),
      text(size: 7pt)[ML model],
    )
  )
)

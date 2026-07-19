#set page(width: 11in, height: 7in, margin: (x: 0.6in, top: 0.5in, bottom: 0.4in))
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
// Centered symmetric layout
//
// Page content width: 706pt (11in - 1.2in margins)
// Page center: 353pt
//
// Two symmetric columns offset from center:
//   Left column center:  353 - 130 = 223
//   Right column center: 353 + 130 = 483
//
// Single centered items at 353
// Three output items evenly spaced
// ================================================================

#let cx = 353pt       // page center
#let gap = 130pt      // half-gap between paired columns
#let lc = cx - gap    // left column center = 223
#let rc = cx + gap    // right column center = 483

#let bw = 185pt       // box width
#let bh = 32pt        // box height
#let bw-out = 155pt   // output box width

// Row Y positions (generous spacing)
#let y1 = 55pt        // inputs
#let y2 = 130pt       // extract/prepare
#let y3 = 205pt       // embed
#let y4 = 290pt       // compression
#let y5 = 375pt       // outputs

// ================================================================
// ROW 1: Two inputs, symmetric
// ================================================================

#box-at(lc - bw/2, y1, bw, bh,
  [*Embedding Model*\
  MiniLM-L6-v2],
  fill: light-purple, stroke: congaree)

#box-at(rc - bw/2, y1, bw, bh,
  [*Course Data from USC*],
  fill: light-tan, stroke: warm-grey)

// ================================================================
// ROW 2: Extract + Prepare, symmetric
// ================================================================

#box-at(lc - bw/2, y2, bw, bh,
  [*Extract Academic Phrases*],
  fill: light-blue, stroke: atlantic)

#box-at(rc - bw/2, y2, bw, bh,
  [*Prepare Course Information*],
  fill: light-blue, stroke: atlantic)

// ================================================================
// ROW 3: Embed, symmetric
// ================================================================

#box-at(lc - bw/2, y3, bw, bh,
  [*Embed Phrase Information*],
  fill: light-blue, stroke: atlantic)

#box-at(rc - bw/2, y3, bw, bh,
  [*Embed Course Information*],
  fill: light-blue, stroke: atlantic)

// ================================================================
// ROW 4: Compression, centered
// ================================================================

#box-at(cx - bw/2, y4, bw, bh,
  [*Compression Layer*],
  fill: light-blue, stroke: atlantic)

// ================================================================
// ROW 5: Three outputs, evenly spaced
// ================================================================

#let out-gap = 185pt   // spacing between output box centers
#let oc1 = cx - out-gap  // left output center
#let oc2 = cx             // middle output center
#let oc3 = cx + out-gap   // right output center

#box-at(oc1 - bw-out/2, y5, bw-out, bh,
  [*Phrase Embeddings*],
  fill: light-green, stroke: horseshoe)

#box-at(oc2 - bw-out/2, y5, bw-out, bh,
  [*Course Embeddings*],
  fill: light-green, stroke: horseshoe)

#box-at(oc3 - bw-out/2, y5, bw-out, bh,
  [*Compression Parameters*],
  fill: light-green, stroke: horseshoe)

// ================================================================
// ARROWS — all enter/leave at box center-bottom or center-top
// ================================================================

// --- Data feeds down ---

// Course Data → Prepare Course (straight down, center)
#arr(rc, y1 + bh, rc, y2)

// Course Data → Extract Phrases (elbow: down from center, left, down to center)
#let bus1 = y1 + bh + 14pt
#ln(rc, y1 + bh, rc, bus1)
#ln(rc, bus1, lc, bus1)
#arr(lc, bus1, lc, y2)

// Extract Phrases → Embed Phrases (straight down)
#arr(lc, y2 + bh, lc, y3)

// Prepare Course → Embed Courses (straight down)
#arr(rc, y2 + bh, rc, y3)

// --- Model feeds embed steps ---

// --- Model feeds embed steps (bypasses row 2 via outside edges) ---

// Model → Embed Phrases: down left side, enter from left
#let ml-x = lc - bw/2 - 15pt  // just outside left edge of left column
#ln(ml-x + 15pt, y1 + bh, ml-x, y1 + bh, color: congaree)  // stub left
#ln(ml-x, y1 + bh, ml-x, y3 + bh/2, color: congaree)       // down
#arr(ml-x, y3 + bh/2, lc - bw/2, y3 + bh/2, color: congaree) // right into box

// Model → Embed Courses: down right side far, enter from right
#let mr-x = rc + bw/2 + 15pt  // just outside right edge of right column
#ln(lc + 30pt, y1 + bh, lc + 30pt, y1 + bh + 5pt, color: congaree)  // stub down
#ln(lc + 30pt, y1 + bh + 5pt, mr-x, y1 + bh + 5pt, color: congaree) // right
#ln(mr-x, y1 + bh + 5pt, mr-x, y3 + bh/2, color: congaree)          // down
#arr(mr-x, y3 + bh/2, rc + bw/2, y3 + bh/2, color: congaree)         // left into box

// --- Embed steps feed compression ---

// Embed Phrases → Compression (elbow: down, right to center)
#let merge-y2 = y3 + bh + 16pt
#ln(lc, y3 + bh, lc, merge-y2)
#ln(lc, merge-y2, cx, merge-y2)
#arr(cx, merge-y2, cx, y4)

// Embed Courses → Compression (elbow: down, left to center)
#ln(rc, y3 + bh, rc, merge-y2)
#ln(rc, merge-y2, cx, merge-y2)
// (merges into the same center arrow above)

// --- Compression fans out to three outputs ---

#let fan-y2 = y4 + bh + 16pt

// Compression → Phrase Embeddings (elbow: down, left)
#ln(cx, y4 + bh, cx, fan-y2, color: horseshoe)
#ln(cx, fan-y2, oc1, fan-y2, color: horseshoe)
#arr(oc1, fan-y2, oc1, y5, color: horseshoe)

// Compression → Course Embeddings (straight down center)
#arr(cx, y4 + bh, oc2, y5, color: horseshoe)

// Compression → Compression Parameters (elbow: down, right)
#ln(cx, fan-y2, oc3, fan-y2, color: horseshoe)
#arr(oc3, fan-y2, oc3, y5, color: horseshoe)

// ================================================================
// Footer + Legend
// ================================================================

#place(dx: cx - 200pt, dy: y5 + bh + 8pt,
  text(size: 7.5pt, fill: warm-grey, style: "italic")[All three files placed in `static/data/` and served to the browser as cached static assets])

#let LG = y5 + bh + 26pt
#place(dx: 0pt, dy: LG,
  rect(width: 706pt, height: 26pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 0.5pt + black10, inset: 5pt,
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

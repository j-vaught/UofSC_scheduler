#set page(width: 11in, height: 20in, margin: (x: 0.5in, top: 0.4in, bottom: 0.4in))
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
#let light-decision = rgb("#f0f4ff")
#let light-green = rgb("#eef5e6")
#let light-red = rgb("#fde8e8")

// === Drawing primitives ===

#let box-at(x, y, w, h, body, fill: white, stroke: black90, text-color: black) = {
  place(dx: x, dy: y,
    rect(width: w, height: h, radius: 0pt, fill: fill, stroke: 1pt + stroke,
      align(center + horizon, text(size: 8pt, fill: text-color, body))
    )
  )
}

#let hline(x1, y1, x2, y2, color: black90) = {
  place(dx: 0pt, dy: 0pt,
    line(start: (x1, y1), end: (x2, y2), stroke: 1.2pt + color)
  )
}

#let head(x, y, dx, dy, color: black90) = {
  let len = calc.sqrt(dx * dx + dy * dy)
  if len == 0 { return }
  let ux = dx / len
  let uy = dy / len
  let px = -uy
  let py = ux
  let s = 4.0
  place(dx: 0pt, dy: 0pt,
    polygon(fill: color, stroke: none,
      (x * 1pt, y * 1pt),
      ((x - s * ux + s * 0.4 * px) * 1pt, (y - s * uy + s * 0.4 * py) * 1pt),
      ((x - s * ux - s * 0.4 * px) * 1pt, (y - s * uy - s * 0.4 * py) * 1pt),
    )
  )
}

// Straight arrow
#let arr(x1, y1, x2, y2, color: black90) = {
  hline(x1, y1, x2, y2, color: color)
  head(x2.pt(), y2.pt(), (x2 - x1).pt(), (y2 - y1).pt(), color: color)
}

// Right-angle arrow: vertical then horizontal (or vice versa)
#let arr-vh(x1, y1, x2, y2, color: black90) = {
  hline(x1, y1, x1, y2, color: color)
  hline(x1, y2, x2, y2, color: color)
  head(x2.pt(), y2.pt(), (x2 - x1).pt(), 0.0, color: color)
}

#let arr-hv(x1, y1, x2, y2, color: black90) = {
  hline(x1, y1, x2, y1, color: color)
  hline(x2, y1, x2, y2, color: color)
  head(x2.pt(), y2.pt(), 0.0, (y2 - y1).pt(), color: color)
}

#let lbl(x, y, body) = {
  place(dx: x, dy: y, text(size: 6.5pt, fill: warm-grey, body))
}

#let section(x, y, body) = {
  place(dx: x, dy: y, text(size: 11pt, weight: "bold", fill: garnet, body))
}

// ================================================================
// TITLE
// ================================================================

#align(center, text(size: 16pt, weight: "bold", fill: garnet)[UofSC Course Scheduler: Search System Flowchart])
#v(1pt)
#align(center, text(size: 9pt, fill: warm-grey)[J.C. Vaught --- April 2026])

// ================================================================
// Layout constants
// ================================================================
// Left column: decision cascade (x ~ 20..220)
// Center column: action boxes for code paths (x ~ 280..460)
// Right column: API + render (x ~ 520..700)

// Decision column
#let dx = 30pt     // decision box left edge
#let dw = 200pt    // decision box width
#let dc = 130pt    // decision center x

// Action column
#let ax = 290pt
#let aw = 180pt
#let ac = 380pt    // action center x

// ================================================================
// INPUT PARSING SECTION
// ================================================================

#section(0pt, 42pt, [INPUT PARSING])

// Start box
#box-at(dc - 90pt, 68pt, 180pt, 28pt, [*User enters search text*], fill: black10)
#arr(dc, 96pt, dc, 122pt)

// Decision 1: Subject code
#let d1y = 122pt
#box-at(dx, d1y, dw, 34pt, [Match `^[A-Za-z]{3,4}$`?\
3--4 letters only], fill: light-decision, stroke: atlantic)
#lbl(dc + 4pt, d1y + 35pt, [No])
#arr(dc, d1y + 34pt, dc, d1y + 60pt)

// Action 1
#let a1y = d1y + 4pt
#box-at(ax, a1y, aw, 32pt, [*Subject Search*\
Levenshtein fuzzy match\
API subject query], fill: light-blue, stroke: atlantic, text-color: congaree)
#arr(dx + dw, d1y + 17pt, ax, a1y + 16pt, color: atlantic)
#lbl(dx + dw + 4pt, d1y + 5pt, [Yes])

// Decision 2: Range/wildcard
#let d2y = d1y + 60pt
#box-at(dx, d2y, dw, 34pt, [Match range/wildcard?\
`CSCE 500+`, `5xx`, `x77`], fill: light-decision, stroke: atlantic)
#lbl(dc + 4pt, d2y + 35pt, [No])
#arr(dc, d2y + 34pt, dc, d2y + 60pt)

#let a2y = a1y + 46pt
#box-at(ax, a2y, aw, 32pt, [*Range Search*\
Subject query + client\
range filter function], fill: light-blue, stroke: atlantic, text-color: congaree)
#arr(dx + dw, d2y + 17pt, ax, a2y + 16pt, color: atlantic)
#lbl(dx + dw + 4pt, d2y + 5pt, [Yes])

// Decision 3: Partial number
#let d3y = d2y + 60pt
#box-at(dx, d3y, dw, 34pt, [Match `SUBJ` + 1--2 digits?\
`CSCE 5`, `MATH 55`], fill: light-decision, stroke: atlantic)
#lbl(dc + 4pt, d3y + 35pt, [No])
#arr(dc, d3y + 34pt, dc, d3y + 60pt)

#let a3y = a2y + 46pt
#box-at(ax, a3y, aw, 32pt, [*Partial Search*\
Implicit `5xx` / `55x`\
prefix filter], fill: light-blue, stroke: atlantic, text-color: congaree)
#arr(dx + dw, d3y + 17pt, ax, a3y + 16pt, color: atlantic)
#lbl(dx + dw + 4pt, d3y + 5pt, [Yes])

// Decision 4: Full course code
#let d4y = d3y + 60pt
#box-at(dx, d4y, dw, 34pt, [Match full course code?\
`CSCE 145`, `CSCE145`], fill: light-decision, stroke: atlantic)
#lbl(dc + 4pt, d4y + 35pt, [No])
#arr(dc, d4y + 34pt, dc, d4y + 60pt)

#let a4y = a3y + 46pt
#box-at(ax, a4y, aw, 32pt, [*Exact Course*\
Normalize → `CSCE 145`\
alias query], fill: light-blue, stroke: atlantic, text-color: congaree)
#arr(dx + dw, d4y + 17pt, ax, a4y + 16pt, color: atlantic)
#lbl(dx + dw + 4pt, d4y + 5pt, [Yes])

// Decision 5: CRN
#let d5y = d4y + 60pt
#box-at(dx, d5y, dw, 30pt, [Match `^` + `\d{5}$` ?\
5-digit CRN], fill: light-decision, stroke: atlantic)
#lbl(dc + 4pt, d5y + 31pt, [No])
#arr(dc, d5y + 30pt, dc, d5y + 55pt)

#let a5y = a4y + 46pt
#box-at(ax, a5y, aw, 28pt, [*CRN Lookup*\
Direct CRN query], fill: light-blue, stroke: atlantic, text-color: congaree)
#arr(dx + dw, d5y + 15pt, ax, a5y + 14pt, color: atlantic)
#lbl(dx + dw + 4pt, d5y + 3pt, [Yes])

// Decision 6: Length check
#let d6y = d5y + 55pt
#box-at(dx, d6y, dw, 28pt, [Length $>=$ 5 characters?], fill: light-decision, stroke: atlantic)

// No → error
#let ey = d6y + 2pt
#box-at(ax, ey, 120pt, 24pt, [*Error hint*: too short], fill: light-red, stroke: garnet, text-color: garnet)
#arr(dx + dw, d6y + 14pt, ax, ey + 12pt, color: garnet)
#lbl(dx + dw + 4pt, d6y + 2pt, [No])

// Yes → semantic pipeline
#lbl(dc + 4pt, d6y + 29pt, [Yes])
#arr(dc, d6y + 28pt, dc, d6y + 52pt)
#box-at(dc - 90pt, d6y + 52pt, 180pt, 28pt, [*Enter Semantic Pipeline*], fill: garnet, stroke: garnet, text-color: white)

// ================================================================
// Action boxes → API Query (single vertical bus on the right)
// ================================================================

#let busx = ax + aw + 30pt  // bus line x position = 500pt
#let apiy = a5y + 50pt      // API box y

// Horizontal taps from each action box to the bus
#hline(ax + aw, a1y + 16pt, busx, a1y + 16pt, color: black90)
#hline(ax + aw, a2y + 16pt, busx, a2y + 16pt, color: black90)
#hline(ax + aw, a3y + 16pt, busx, a3y + 16pt, color: black90)
#hline(ax + aw, a4y + 16pt, busx, a4y + 16pt, color: black90)
#hline(ax + aw, a5y + 14pt, busx, a5y + 14pt, color: black90)

// Vertical bus line
#hline(busx, a1y + 16pt, busx, apiy, color: black90)
#head(busx.pt(), apiy.pt(), 0.0, 1.0, color: black90)

// API Query box
#box-at(busx - 100pt, apiy, 200pt, 30pt,
  [*USC API Query*\
  classes.sc.edu or bulletin API\
  via local cache proxy], fill: black10)

// Filters
#arr(busx, apiy + 30pt, busx, apiy + 50pt)
#box-at(busx - 100pt, apiy + 50pt, 200pt, 24pt,
  [*Client-side filters*\
  range, open sections, size], fill: black10)

// Render
#arr(busx, apiy + 74pt, busx, apiy + 94pt)
#box-at(busx - 80pt, apiy + 94pt, 160pt, 24pt,
  [*Render grouped results*], fill: black10)


// ================================================================
// SEMANTIC SEARCH PIPELINE
// ================================================================

#let sy = d6y + 115pt  // start of semantic section

#section(0pt, sy, [SEMANTIC SEARCH PIPELINE])

#let s1y = sy + 30pt   // row 1 y
#let bw = 170pt        // box width for pipeline

// Step 1: Load resources
#box-at(0pt, s1y, 155pt, 55pt,
  [*1. Load Resources*\
  #text(size: 7pt)[Transformers.js model (23 MB, CDN)\
  Phrase embeddings (2.4 MB)\
  Course embeddings (4.4 MB)\
  PCA params (1 MB)\
  _Cached after first load_]], fill: light-tan, stroke: warm-grey)
#arr(155pt, s1y + 27pt, 175pt, s1y + 27pt)

// Step 2: Embed query
#box-at(175pt, s1y, 150pt, 55pt,
  [*2. Embed Query*\
  #text(size: 7pt)[User text → MiniLM-L6-v2\
  Output: 384-dim vector\
  PCA project → 128-dim\
  L2 normalize]], fill: light-blue, stroke: atlantic)
#arr(325pt, s1y + 27pt, 345pt, s1y + 27pt)

// Step 3: Phrase expansion
#box-at(345pt, s1y, 160pt, 55pt,
  [*3. Phrase Expansion*\
  #text(size: 7pt)[Cosine sim vs 6,313 phrases\
  Filter: similarity > 0.25\
  Skip exact query string\
  Select top 8 phrases]], fill: light-blue, stroke: atlantic)
#arr(505pt, s1y + 27pt, 525pt, s1y + 27pt)

// Search list
#box-at(525pt, s1y, 130pt, 55pt,
  [*Search List*\
  #text(size: 7pt)[Original query\
  + 8 expanded phrases\
  = *9 concurrent searches*]], fill: light-green, stroke: horseshoe)

// Row 2: Two parallel paths
#let s2y = s1y + 80pt

// Arrow down from search list
#arr(590pt, s1y + 55pt, 590pt, s2y)

// Step 4a: API search (right)
#box-at(505pt, s2y, bw, 45pt,
  [*4a. Live API Search*\
  #text(size: 7pt)[9 concurrent keyword queries\
  USC bulletin or classes API\
  Dedupe by course code]], fill: light-blue, stroke: atlantic)

// Arrow from embed query down to step 4b
#arr-vh(250pt, s1y + 55pt, 80pt, s2y, color: atlantic)

// Step 4b: Local search (left)
#box-at(10pt, s2y, bw, 45pt,
  [*4b. Local Database Search*\
  #text(size: 7pt)[Cosine sim vs 9,732 courses\
  (title + description embeddings)\
  Top 30 with sim > 0.30]], fill: light-blue, stroke: atlantic)

// Row 3: Merge
#let s3y = s2y + 70pt

// Both converge to merge
#arr-vh(95pt, s2y + 45pt, 350pt, s3y, color: black90)
#arr-vh(590pt, s2y + 45pt, 350pt + 120pt, s3y, color: black90)

#box-at(280pt, s3y, 200pt, 32pt,
  [*5. Merge + Dedupe*\
  #text(size: 7pt)[Combine API + local results\
  Unique by course code]], fill: black10)

// Row 4: Score
#let s4y = s3y + 52pt
#arr(380pt, s3y + 32pt, 380pt, s4y)

#box-at(260pt, s4y, 240pt, 50pt,
  [*6. Score All Results*\
  #text(size: 7pt)[Batch-embed all titles via Transformers.js\
  PCA project each title → 128-dim\
  Cosine similarity vs query vector\
  *Filter out courses with sim < 0.15*]], fill: light-blue, stroke: atlantic)

// Row 5: Availability
#let s5y = s4y + 70pt
#arr(380pt, s4y + 50pt, 380pt, s5y)

#box-at(260pt, s5y, 240pt, 45pt,
  [*7. Availability Cross-Reference*\
  #text(size: 7pt)[Fetch live sections by subject (concurrent)\
  If "current term only": remove courses not offered\
  If "open only": remove full sections]], fill: light-tan, stroke: warm-grey)

// Row 6: Render
#let s6y = s5y + 65pt
#arr(380pt, s5y + 45pt, 380pt, s6y)

#box-at(290pt, s6y, 180pt, 32pt,
  [*8. Render Results*\
  #text(size: 7pt)[Sort by similarity score, top 50\
  Show "Also searched" phrase tags]], fill: garnet, stroke: garnet, text-color: white)


// ================================================================
// LEGEND
// ================================================================

#let ly = s6y + 55pt
#place(dx: 0pt, dy: ly,
  rect(width: 680pt, height: 50pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 0.5pt + black10, inset: 8pt,
    grid(columns: (12pt, auto, 20pt, 12pt, auto, 20pt, 12pt, auto, 20pt, 12pt, auto, 20pt, 12pt, auto),
      column-gutter: 4pt, row-gutter: 0pt, align: horizon,
      rect(width: 12pt, height: 12pt, fill: light-blue, stroke: 1pt + atlantic),
      text(size: 7pt)[Client computation],
      [],
      rect(width: 12pt, height: 12pt, fill: light-tan, stroke: 1pt + warm-grey),
      text(size: 7pt)[Data / API calls],
      [],
      rect(width: 12pt, height: 12pt, fill: garnet, stroke: 1pt + garnet),
      text(size: 7pt)[Entry / exit],
      [],
      rect(width: 12pt, height: 12pt, fill: light-green, stroke: 1pt + horseshoe),
      text(size: 7pt)[Intermediate data],
      [],
      rect(width: 12pt, height: 12pt, fill: light-decision, stroke: 1pt + atlantic),
      text(size: 7pt)[Decision node],
    )
  )
)

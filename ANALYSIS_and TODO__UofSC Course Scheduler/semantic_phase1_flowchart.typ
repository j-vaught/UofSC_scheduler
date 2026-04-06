#set page(width: 11in, height: 9.5in, margin: (x: 0.6in, top: 0.5in, bottom: 0.5in))
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

#let arr-hv(x1, y1, x2, y2, color: black90) = {
  ln(x1, y1, x2, y1, color: color)
  ln(x2, y1, x2, y2, color: color)
  hd(x2.pt(), y2.pt(), 0.0, (y2 - y1).pt(), color: color)
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
// Layout: centered column, top to bottom
// Page content width ~706pt (11in - 1.2in margins)
// Center reference: 353pt
// ================================================================

#let cx = 353pt  // center x

// ================================================================
// ROW 1: Course Data (input)
// ================================================================

#let r1 = 58pt
#let r1w = 240pt

#box-at(cx - r1w/2, r1, r1w, 48pt,
  [*Course Data Source*\
  `course_data.json` --- 9,732 courses\
  Scraped from USC academic bulletin API\
  Fields: code, title, description],
  fill: light-tan, stroke: warm-grey)

#arr(cx, r1 + 48pt, cx, r1 + 78pt)

// ================================================================
// ROW 2: Extract phrases + Load model (side by side)
// ================================================================

#let r2 = r1 + 78pt
#let r2w = 220pt
#let r2gap = 60pt  // gap between the two boxes

#box-at(cx - r2w - r2gap/2, r2, r2w, 55pt,
  [*Extract Academic Phrases*\
  Generate all bigrams + trigrams\
  from course titles and descriptions\
  Filter: min 5 occurrences, all unique words\
  Remove stopwords + academic filler\
  *Result: 6,313 phrases*],
  fill: light-blue, stroke: atlantic)

#box-at(cx + r2gap/2, r2, r2w, 55pt,
  [*Load Embedding Model*\
  `all-MiniLM-L6-v2`\
  384-dim sentence embeddings\
  Trained on 1B+ English sentence pairs\
  General-purpose English model],
  fill: light-purple, stroke: congaree)

// Arrow from data down, then split left and right
#let split-y = r1 + 63pt
// Left branch
#ln(cx, split-y, cx - r2gap/2 - r2w/2, split-y, color: black90)
#arr(cx - r2gap/2 - r2w/2, split-y, cx - r2gap/2 - r2w/2, r2, color: black90)
// Right branch
#ln(cx, split-y, cx + r2gap/2 + r2w/2, split-y, color: black90)
#arr(cx + r2gap/2 + r2w/2, split-y, cx + r2gap/2 + r2w/2, r2, color: black90)

// ================================================================
// ROW 3: Embed phrases + Embed courses (side by side)
// Both receive input from row 2
// ================================================================

#let r3 = r2 + 90pt
#let r3w = 220pt

#box-at(cx - r3w - r2gap/2, r3, r3w, 52pt,
  [*Embed All 6,313 Phrases*\
  Pass each phrase through MiniLM model\
  "deep learning" → 384 float values\
  "neural networks" → 384 float values\
  Output: 6,313 $times$ 384 matrix],
  fill: light-blue, stroke: atlantic)

#box-at(cx + r2gap/2, r3, r3w, 52pt,
  [*Embed All 9,732 Courses*\
  Input per course: title + ". " + description\
  Full semantic content captured\
  Output: 9,732 $times$ 384 matrix\
  ~15 seconds on CPU],
  fill: light-blue, stroke: atlantic)

// Arrows from row 2 to row 3
// Left: Extract phrases → Embed phrases
#arr(cx - r2gap/2 - r2w/2, r2 + 55pt, cx - r2gap/2 - r2w/2, r3, color: atlantic)
// Right: Load model feeds both embed boxes
// Model center → down, then split left and right
#let model-cx = cx + r2gap/2 + r2w/2
#let model-split-y = r2 + 70pt
#arr(model-cx, r2 + 55pt, model-cx, model-split-y, color: congaree)
// Right branch: straight down to embed courses
#arr(model-cx, model-split-y, model-cx, r3, color: congaree)
// Left branch: over to embed phrases
#let phrase-cx = cx - r2gap/2 - r2w/2 + r2w  // right edge of embed phrases box
#ln(model-cx, model-split-y, phrase-cx, model-split-y, color: congaree)
#arr(phrase-cx, model-split-y, phrase-cx, r3, color: congaree)

// ================================================================
// ROW 4: PCA (full width, centered)
// ================================================================

#let r4 = r3 + 90pt
#let r4w = 500pt

// Arrows from both embed boxes down to PCA
#let pca-top-y = r4
#let merge-y = r3 + 68pt
#arr(cx - r2gap/2 - r2w/2, r3 + 52pt, cx - r2gap/2 - r2w/2, merge-y, color: atlantic)
#ln(cx - r2gap/2 - r2w/2, merge-y, cx, merge-y, color: atlantic)
#arr(cx + r2gap/2 + r2w/2, r3 + 52pt, cx + r2gap/2 + r2w/2, merge-y, color: atlantic)
#ln(cx + r2gap/2 + r2w/2, merge-y, cx, merge-y, color: atlantic)
#arr(cx, merge-y, cx, r4, color: atlantic)

#box-at(cx - r4w/2, r4, r4w, 62pt,
  [*PCA Dimensionality Reduction*\
  Concatenate phrase + course vectors into single matrix: 16,045 $times$ 384\
  Compute SVD, keep top 128 principal components\
  Project all vectors: 384-dim → *128-dim* (retains *81% of variance*)\
  L2 normalize each projected vector to unit length\
  Quantize to *int8*: multiply by 127, clamp to \[-128, 127\], round to nearest integer],
  fill: light-blue, stroke: atlantic)

// ================================================================
// ROW 5: Three output files (fanning out)
// ================================================================

#let r5 = r4 + 100pt
#let r5w = 190pt
#let r5gap = 20pt
#let total-r5 = 3 * r5w + 2 * r5gap  // 610pt
#let r5-left = cx - total-r5/2

// Fan-out arrow from PCA center
#arr(cx, r4 + 62pt, cx, r5, color: horseshoe)
// Left branch
#arr-hv(cx, r4 + 75pt, r5-left + r5w/2, r5, color: horseshoe)
// Right branch
#arr-hv(cx, r4 + 75pt, r5-left + 2*r5w + 2*r5gap + r5w/2 - r5w, r5, color: horseshoe)

#box-at(r5-left, r5, r5w, 60pt,
  [*phrase\_embeddings.json*\
  6,313 entries\
  phrase string → int8\[128\] vector\
  Example: `"deep learning": [-42, 17, ...]`\
  *File size: 2.4 MB*],
  fill: light-green, stroke: horseshoe)

#box-at(r5-left + r5w + r5gap, r5, r5w, 60pt,
  [*course\_embeddings.json*\
  9,732 entries\
  code, title, subject, key\
  vec: int8\[128\]\
  *File size: 4.4 MB*],
  fill: light-green, stroke: horseshoe)

#box-at(r5-left + 2*(r5w + r5gap), r5, r5w, 60pt,
  [*pca\_params.json*\
  mean: float32\[384\] (centering)\
  components: float32\[128\]\[384\]\
  (128 principal component vectors)\
  *File size: 1.0 MB*],
  fill: light-green, stroke: horseshoe)

// Served to browser label
#place(dx: cx - 120pt, dy: r5 + 68pt,
  text(size: 7.5pt, fill: warm-grey, style: "italic")[All three files placed in `static/data/` and served to browser as cached static assets])

// ================================================================
// Legend
// ================================================================

#let LG = r5 + 100pt
#place(dx: 0pt, dy: LG,
  rect(width: 706pt, height: 30pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 0.5pt + black10, inset: 6pt,
    grid(columns: (12pt, auto, 28pt, 12pt, auto, 28pt, 12pt, auto, 28pt, 12pt, auto),
      column-gutter: 4pt, align: horizon,
      rect(width: 12pt, height: 12pt, fill: light-blue, stroke: 1pt + atlantic),
      text(size: 7pt)[Computation step],
      [],
      rect(width: 12pt, height: 12pt, fill: light-tan, stroke: 1pt + warm-grey),
      text(size: 7pt)[Input data],
      [],
      rect(width: 12pt, height: 12pt, fill: light-green, stroke: 1pt + horseshoe),
      text(size: 7pt)[Output artifacts (served to browser)],
      [],
      rect(width: 12pt, height: 12pt, fill: light-purple, stroke: 1pt + congaree),
      text(size: 7pt)[ML model],
    )
  )
)

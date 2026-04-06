#set page(width: 11in, height: 10in, margin: (x: 0.5in, top: 0.4in, bottom: 0.4in))
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

#let sec(x, y, body) = { place(dx: x, dy: y, text(size: 12pt, weight: "bold", fill: garnet, body)) }

// ================================================================
// TITLE
// ================================================================

#align(center, text(size: 16pt, weight: "bold", fill: garnet)[Semantic Search: Phase 1 --- Build-Time Artifacts])
#v(1pt)
#align(center, text(size: 9pt, fill: warm-grey)[UofSC Course Scheduler --- J.C. Vaught --- April 2026])
#v(2pt)
#align(center, text(size: 8pt, fill: warm-grey)[Offline process, run once per semester via `build_embeddings.py`])

// ================================================================
// Row 1: Data → Extract → Model
// ================================================================

#let r1 = 60pt

#box-at(0pt, r1, 165pt, 48pt,
  [*Course Data Source*\
  `course_data.json`\
  9,732 courses scraped from\
  USC academic bulletin API\
  Fields: code, title, description],
  fill: light-tan, stroke: warm-grey)

#arr(165pt, r1 + 24pt, 210pt, r1 + 24pt)

#box-at(210pt, r1, 200pt, 48pt,
  [*Extract Academic Phrases*\
  Generate all bigrams + trigrams\
  from course titles and descriptions\
  Filter: min 5 occurrences, unique words\
  Remove stopwords + academic filler],
  fill: light-blue, stroke: atlantic)

#arr(410pt, r1 + 24pt, 460pt, r1 + 24pt)

#box-at(460pt, r1, 175pt, 48pt,
  [*Load Embedding Model*\
  `all-MiniLM-L6-v2`\
  384-dim sentence embeddings\
  Trained on 1B+ English pairs\
  General-purpose English model],
  fill: light-purple, stroke: congaree)

// Result count
#box-at(210pt, r1 + 62pt, 200pt, 22pt,
  [Result: *6,313 academic phrases*],
  fill: white, stroke: atlantic)

// ================================================================
// Row 2: Embed phrases + courses
// ================================================================

#let r2 = r1 + 110pt

#arr(547pt, r1 + 48pt, 547pt, r2)

#box-at(90pt, r2, 230pt, 48pt,
  [*Embed All 6,313 Phrases*\
  Pass each phrase through MiniLM model\
  "deep learning" → 384 float values\
  "neural networks" → 384 float values\
  Output: 6,313 $times$ 384 matrix],
  fill: light-blue, stroke: atlantic)

#arr(547pt, r2 + 16pt, 320pt, r2 + 16pt, color: atlantic)

#box-at(90pt, r2 + 65pt, 230pt, 48pt,
  [*Embed All 9,732 Courses*\
  Input per course: title + ". " + description\
  Full semantic content captured\
  Output: 9,732 $times$ 384 matrix\
  ~15 seconds on CPU],
  fill: light-blue, stroke: atlantic)

#arr(547pt, r2 + 32pt, 547pt, r2 + 65pt + 16pt)
#arr(547pt, r2 + 65pt + 16pt, 320pt, r2 + 65pt + 16pt, color: atlantic)

// ================================================================
// Row 3: PCA
// ================================================================

#let r3 = r2 + 145pt

#arr(205pt, r2 + 113pt, 205pt, r3)

#box-at(50pt, r3, 520pt, 55pt,
  [*PCA Dimensionality Reduction*\
  Concatenate phrase + course vectors into single matrix: 16,045 $times$ 384\
  Compute SVD, keep top 128 principal components\
  Project all vectors: 384-dim → *128-dim* (retains *81% of variance*)\
  L2 normalize each projected vector to unit length\
  Quantize to *int8*: multiply by 127, clamp to \[-128, 127\], round to nearest integer],
  fill: light-blue, stroke: atlantic)

// ================================================================
// Row 4: Output files
// ================================================================

#let r4 = r3 + 88pt

#arr(310pt, r3 + 55pt, 310pt, r4)

#box-at(10pt, r4, 185pt, 55pt,
  [*phrase\_embeddings.json*\
  6,313 entries\
  `\{ "deep learning": [-42, 17, ...], ... \}`\
  Phrase string → int8\[128\] vector\
  *File size: 2.4 MB*],
  fill: light-green, stroke: horseshoe)

#box-at(215pt, r4, 185pt, 55pt,
  [*course\_embeddings.json*\
  9,732 entries\
  code, title, subject, key\
  + vec: int8\[128\]\
  *File size: 4.4 MB*],
  fill: light-green, stroke: horseshoe)

#box-at(420pt, r4, 185pt, 55pt,
  [*pca\_params.json*\
  mean: float32\[384\] (centering vector)\
  components: float32\[128\]\[384\]\
  (128 principal component vectors)\
  *File size: 1.0 MB*],
  fill: light-green, stroke: horseshoe)

// Fan-out arrows
#arr-hv(310pt, r3 + 55pt, 102pt, r4, color: horseshoe)
#arr(310pt, r3 + 55pt, 310pt, r4, color: horseshoe)
#arr-hv(310pt, r3 + 55pt, 512pt, r4, color: horseshoe)

// ================================================================
// Legend
// ================================================================

#let LG = r4 + 75pt
#place(dx: 0pt, dy: LG,
  rect(width: 720pt, height: 30pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 0.5pt + black10, inset: 6pt,
    grid(columns: (12pt, auto, 20pt, 12pt, auto, 20pt, 12pt, auto, 20pt, 12pt, auto),
      column-gutter: 4pt, align: horizon,
      rect(width: 12pt, height: 12pt, fill: light-blue, stroke: 1pt + atlantic),
      text(size: 7pt)[Computation],
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

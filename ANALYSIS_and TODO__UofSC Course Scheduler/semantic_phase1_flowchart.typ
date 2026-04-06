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
#let bw = 200pt    // standard box width
#let bh = 52pt     // standard box height
#let bw-out = 185pt // output box width

// Row Y positions
#let y1 = 55pt
#let y2 = 155pt
#let y3 = 270pt
#let y4 = 385pt
#let y5 = 500pt

// ================================================================
// ROW 1: Course Data (right) + Model (left)
// ================================================================

// A01: Course Data Source
#box-at(col-cr - 10pt, y1, bw + 10pt, bh,
  [*Course Data Source*\
  `course_data.json` --- 9,732 courses\
  Scraped from USC academic bulletin API\
  Fields: code, title, description],
  fill: light-tan, stroke: warm-grey)

// A02: MiniLM Model
#box-at(col-l - 50pt, y1, bw, bh,
  [*Embedding Model*\
  `all-MiniLM-L6-v2`\
  384-dim sentence embeddings\
  Trained on 1B+ English sentence pairs],
  fill: light-purple, stroke: congaree)

// ================================================================
// ROW 2: Extract Phrases (center-left) + Extract Descriptions (center-right)
// ================================================================

// A03: Extract Academic Phrases
#box-at(col-cl - 95pt, y2, bw + 10pt, bh + 5pt,
  [*Extract Academic Phrases*\
  Generate bigrams + trigrams\
  from titles and descriptions\
  Filter: min 5 occurrences, unique words\
  Remove stopwords + academic filler\
  *Result: 6,313 phrases*],
  fill: light-blue, stroke: atlantic)

// A04: Extract Course Descriptions
#box-at(col-cr - 10pt, y2, bw + 10pt, bh,
  [*Prepare Course Texts*\
  Concatenate: title + ". " + description\
  for each of 9,732 courses\
  Full semantic content per course],
  fill: light-blue, stroke: atlantic)

// ================================================================
// ROW 3: Embed Phrases (center-left) + Embed Courses (center-right)
// ================================================================

// A05: Embed Phrases
#box-at(col-cl - 95pt, y3, bw + 10pt, bh,
  [*Embed 6,313 Phrases*\
  Each phrase → MiniLM model\
  "deep learning" → 384 float values\
  Output: 6,313 $times$ 384 matrix],
  fill: light-blue, stroke: atlantic)

// A06: Embed Courses
#box-at(col-cr - 10pt, y3, bw + 10pt, bh,
  [*Embed 9,732 Courses*\
  Each text → MiniLM model\
  Output: 9,732 $times$ 384 matrix\
  ~15 seconds on CPU],
  fill: light-blue, stroke: atlantic)

// ================================================================
// ROW 4: PCA (centered)
// ================================================================

// A07: PCA
#box-at(col-cl - 30pt, y4, 350pt, 62pt,
  [*PCA Dimensionality Reduction*\
  Concatenate phrase + course vectors: 16,045 $times$ 384\
  Compute SVD, keep top 128 principal components\
  Project: 384-dim → *128-dim* (retains *81% of variance*)\
  L2 normalize, quantize to *int8* \[-128, 127\]],
  fill: light-blue, stroke: atlantic)

// ================================================================
// ROW 5: Three output files
// ================================================================

// A08: phrase_embeddings.json
#box-at(20pt, y5, bw-out, 55pt,
  [*phrase\_embeddings.json*\
  6,313 phrases → int8\[128\]\
  `"deep learning": [-42, 17, ...]`\
  *2.4 MB*],
  fill: light-green, stroke: horseshoe)

// A09: course_embeddings.json
#box-at(col-cl + 10pt, y5, bw-out, 55pt,
  [*course\_embeddings.json*\
  9,732 courses with metadata\
  code, title, subject, key, vec\
  *4.4 MB*],
  fill: light-green, stroke: horseshoe)

// A10: pca_params.json
#box-at(col-cr + 20pt, y5, bw-out, 55pt,
  [*pca\_params.json*\
  mean: float32\[384\]\
  components: float32\[128\]\[384\]\
  *1.0 MB*],
  fill: light-green, stroke: horseshoe)

// ================================================================
// ARROWS
// ================================================================

// A01 (Course Data) → A04 (Extract Descriptions) — straight down
#arr(col-cr + 95pt, y1 + bh, col-cr + 95pt, y2)

// A01 (Course Data) → A03 (Extract Phrases) — elbow: down then left
#ln(col-cr + 50pt, y1 + bh, col-cr + 50pt, y1 + bh + 18pt, color: black90)
#ln(col-cr + 50pt, y1 + bh + 18pt, col-cl - 5pt, y1 + bh + 18pt, color: black90)
#arr(col-cl - 5pt, y1 + bh + 18pt, col-cl - 5pt, y2, color: black90)

// A03 (Extract Phrases) → A05 (Embed Phrases) — straight down
#arr(col-cl - 5pt, y2 + bh + 5pt, col-cl - 5pt, y3)

// A04 (Extract Descriptions) → A06 (Embed Courses) — straight down
#arr(col-cr + 95pt, y2 + bh, col-cr + 95pt, y3)

// A02 (Model) → A05 (Embed Phrases) — elbow: down, right, down
#ln(col-l, y1 + bh, col-l, y2 + 30pt, color: congaree)
#ln(col-l, y2 + 30pt, col-cl - 50pt, y2 + 30pt, color: congaree)
#ln(col-cl - 50pt, y2 + 30pt, col-cl - 50pt, y3 - 15pt, color: congaree)
#arr(col-cl - 50pt, y3 - 15pt, col-cl - 50pt, y3, color: congaree)

// A02 (Model) → A06 (Embed Courses) — elbow: down, right far, down
#ln(col-l + 50pt, y1 + bh, col-l + 50pt, y2 + 15pt, color: congaree)
#ln(col-l + 50pt, y2 + 15pt, col-cr + 50pt, y2 + 15pt, color: congaree)
#ln(col-cr + 50pt, y2 + 15pt, col-cr + 50pt, y3 - 15pt, color: congaree)
#arr(col-cr + 50pt, y3 - 15pt, col-cr + 50pt, y3, color: congaree)

// A05 (Embed Phrases) → A07 (PCA) — elbow: down, right to PCA left
#ln(col-cl - 5pt, y3 + bh, col-cl - 5pt, y3 + bh + 25pt, color: atlantic)
#ln(col-cl - 5pt, y3 + bh + 25pt, col-cl + 70pt, y3 + bh + 25pt, color: atlantic)
#ln(col-cl + 70pt, y3 + bh + 25pt, col-cl + 70pt, y4 - 12pt, color: atlantic)
#arr(col-cl + 70pt, y4 - 12pt, col-cl + 70pt, y4, color: atlantic)

// A06 (Embed Courses) → A07 (PCA) — elbow: down, left to PCA right
#ln(col-cr + 50pt, y3 + bh, col-cr + 50pt, y3 + bh + 25pt, color: atlantic)
#ln(col-cr + 50pt, y3 + bh + 25pt, col-cl + 220pt, y3 + bh + 25pt, color: atlantic)
#ln(col-cl + 220pt, y3 + bh + 25pt, col-cl + 220pt, y4 - 12pt, color: atlantic)
#arr(col-cl + 220pt, y4 - 12pt, col-cl + 220pt, y4, color: atlantic)

// A07 (PCA) → A08 (phrase_embeddings.json)
#ln(col-cl + 50pt, y4 + 62pt, col-cl + 50pt, y4 + 82pt, color: horseshoe)
#ln(col-cl + 50pt, y4 + 82pt, 112pt, y4 + 82pt, color: horseshoe)
#arr(112pt, y4 + 82pt, 112pt, y5, color: horseshoe)

// A07 (PCA) → A09 (course_embeddings.json)
#arr(col-cl + 145pt, y4 + 62pt, col-cl + 145pt, y5, color: horseshoe)

// A07 (PCA) → A10 (pca_params.json)
#ln(col-cl + 240pt, y4 + 62pt, col-cl + 240pt, y4 + 82pt, color: horseshoe)
#ln(col-cl + 240pt, y4 + 82pt, col-cr + 112pt, y4 + 82pt, color: horseshoe)
#arr(col-cr + 112pt, y4 + 82pt, col-cr + 112pt, y5, color: horseshoe)

// ================================================================
// Footer
// ================================================================

#place(dx: 130pt, dy: y5 + 63pt,
  text(size: 7.5pt, fill: warm-grey, style: "italic")[All three files placed in `static/data/` and served to the browser as cached static assets])

// Legend
#let LG = y5 + 85pt
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

#set page(width: 14in, height: 22in, margin: (x: 0.5in, top: 0.4in, bottom: 0.4in))
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
#let light-red = rgb("#fde8e8")
#let light-purple = rgb("#f0e8fe")

// === Drawing primitives ===

#let box-at(x, y, w, h, body, fill: white, stroke: black90, text-color: black) = {
  place(dx: x, dy: y,
    rect(width: w, height: h, radius: 0pt, fill: fill, stroke: 1pt + stroke,
      align(center + horizon, text(size: 7.5pt, fill: text-color, body))
    )
  )
}

#let note-at(x, y, w, body) = {
  place(dx: x, dy: y,
    rect(width: w, radius: 0pt, fill: rgb("#fffff0"), stroke: 0.5pt + warm-grey, inset: 5pt,
      text(size: 6.5pt, fill: black90, body)
    )
  )
}

#let hline(x1, y1, x2, y2, color: black90) = {
  place(dx: 0pt, dy: 0pt,
    line(start: (x1, y1), end: (x2, y2), stroke: 1.2pt + color)
  )
}

#let dashed-line(x1, y1, x2, y2, color: warm-grey) = {
  place(dx: 0pt, dy: 0pt,
    line(start: (x1, y1), end: (x2, y2), stroke: (paint: color, thickness: 0.8pt, dash: "dashed"))
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

#let arr(x1, y1, x2, y2, color: black90) = {
  hline(x1, y1, x2, y2, color: color)
  head(x2.pt(), y2.pt(), (x2 - x1).pt(), (y2 - y1).pt(), color: color)
}

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
  place(dx: x, dy: y, text(size: 12pt, weight: "bold", fill: garnet, body))
}

#let subsec(x, y, body) = {
  place(dx: x, dy: y, text(size: 10pt, weight: "bold", fill: atlantic, body))
}

// ================================================================
// TITLE
// ================================================================

#align(center, text(size: 18pt, weight: "bold", fill: garnet)[Semantic Search Pipeline: Detailed Architecture])
#v(1pt)
#align(center, text(size: 9pt, fill: warm-grey)[UofSC Course Scheduler --- J.C. Vaught --- April 2026])

// ================================================================
// SECTION 1: BUILD-TIME (offline, one-time)
// ================================================================

#let by = 48pt
#section(0pt, by, [PHASE 1: BUILD-TIME ARTIFACTS #text(size: 9pt, weight: "regular", fill: warm-grey)[(offline, run once per semester)]])

#let b1y = by + 28pt

// Course data source
#box-at(0pt, b1y, 150pt, 40pt,
  [*Course Data*\
  `course_data.json`\
  9,732 courses\
  (code, title, description)],
  fill: light-tan, stroke: warm-grey)

#arr(150pt, b1y + 20pt, 180pt, b1y + 20pt)

// Extract phrases
#box-at(180pt, b1y, 165pt, 40pt,
  [*Extract Phrases*\
  Bigrams + trigrams from\
  titles and descriptions\
  `min_count=5`, unique words],
  fill: light-blue, stroke: atlantic)

#note-at(180pt, b1y + 44pt, 165pt,
  [Filters: stopwords, academic filler\
  ("course", "student", "includes"...)\
  Keeps: "deep learning", "heat transfer",\
  "financial markets", "neural networks"\
  Result: *6,313 phrases*])

#arr(345pt, b1y + 20pt, 380pt, b1y + 20pt)

// Load model
#box-at(380pt, b1y, 160pt, 40pt,
  [*Load Embedding Model*\
  `all-MiniLM-L6-v2`\
  384-dim sentence embeddings\
  Trained on 1B+ English pairs],
  fill: light-purple, stroke: congaree)

// Two outputs from model
#arr(540pt, b1y + 12pt, 600pt, b1y + 12pt)
#arr(540pt, b1y + 28pt, 600pt, b1y + 28pt)

// Embed phrases
#let ep_y = b1y - 12pt
#box-at(600pt, ep_y, 170pt, 35pt,
  [*Embed 6,313 Phrases*\
  Each phrase → 384-dim vector\
  "deep learning" → $arrow.r$ \[0.023, -0.118, ...\]],
  fill: light-blue, stroke: atlantic)

// Embed courses
#let ec_y = b1y + 30pt
#box-at(600pt, ec_y, 170pt, 35pt,
  [*Embed 9,732 Courses*\
  title + ". " + description\
  → 384-dim vector per course],
  fill: light-blue, stroke: atlantic)

// PCA
#let pca_y = b1y + 90pt

#arr(685pt, ep_y + 35pt, 685pt, pca_y, color: atlantic)
#arr(685pt, ec_y + 35pt, 685pt, pca_y, color: atlantic)

#box-at(580pt, pca_y, 210pt, 55pt,
  [*PCA Dimensionality Reduction*\
  Fit on combined phrase + course vectors\
  Project: 384-dim → *128-dim*\
  L2 normalize each vector\
  Quantize to *int8* ($-128$ to $127$)\
  Variance retained: ~81%],
  fill: light-blue, stroke: atlantic)

#note-at(580pt, pca_y + 59pt, 210pt,
  [*Why PCA?* Reduces file sizes by 3$times$ while\
  retaining 81% of similarity structure.\
  *Why int8?* Each 128-dim vector = 128 bytes\
  in JSON, vs 512 bytes for float32.])

// Output files
#let oy = pca_y + 115pt

#arr(685pt, pca_y + 55pt, 685pt, oy)

// Three output files
#box-at(420pt, oy, 145pt, 50pt,
  [*phrase\_embeddings.json*\
  6,313 entries\
  phrase → int8\[128\]\
  *2.4 MB*],
  fill: light-green, stroke: horseshoe)

#box-at(580pt, oy, 145pt, 50pt,
  [*course\_embeddings.json*\
  9,732 entries\
  code, title, subject,\
  key, vec: int8\[128\]\
  *4.4 MB*],
  fill: light-green, stroke: horseshoe)

#box-at(740pt, oy, 145pt, 50pt,
  [*pca\_params.json*\
  mean: float\[384\]\
  components: float\[128\]\[384\]\
  *1.0 MB*],
  fill: light-green, stroke: horseshoe)

// Fan out from PCA to three output files
#arr-hv(685pt, pca_y + 55pt, 492pt, oy, color: horseshoe)
#arr(685pt, pca_y + 55pt, 685pt, oy, color: horseshoe)
#arr-hv(685pt, pca_y + 55pt, 812pt, oy, color: horseshoe)


// ================================================================
// SECTION 2: RUNTIME (in browser)
// ================================================================

#let ry = oy + 80pt
#section(0pt, ry, [PHASE 2: RUNTIME SEARCH #text(size: 9pt, weight: "regular", fill: warm-grey)[(in browser, every keyword search)]])

// --- Step 1: User input ---
#let r1y = ry + 28pt
#subsec(0pt, r1y, [Step 1: User Input])

#box-at(0pt, r1y + 18pt, 200pt, 30pt,
  [*User types keyword query*\
  e.g. "car engineering", "brain science"],
  fill: black10, stroke: black90)

#note-at(210pt, r1y + 18pt, 190pt,
  [Input already classified as keyword (not subject\
  code, course code, CRN, or range pattern).\
  Minimum 5 characters required.])

// --- Step 2: Load resources ---
#let r2y = r1y + 65pt
#subsec(0pt, r2y, [Step 2: Lazy-Load Resources (first search only)])

#arr(100pt, r1y + 48pt, 100pt, r2y + 18pt)

#box-at(0pt, r2y + 18pt, 200pt, 55pt,
  [*Load Transformers.js*\
  ES module from CDN\
  `\@xenova/transformers\@2.17.2`\
  Initialize pipeline:\
  `feature-extraction`\
  Model: `Xenova/all-MiniLM-L6-v2`],
  fill: light-tan, stroke: warm-grey)

#box-at(220pt, r2y + 18pt, 155pt, 55pt,
  [*Load phrase\_embeddings*\
  2.4 MB JSON\
  Parse + build normalized\
  Float32 vectors for all\
  6,313 phrases],
  fill: light-tan, stroke: warm-grey)

#box-at(395pt, r2y + 18pt, 155pt, 55pt,
  [*Load course\_embeddings*\
  4.4 MB JSON\
  Parse + build normalized\
  Float32 vectors for all\
  9,732 courses],
  fill: light-tan, stroke: warm-grey)

#box-at(570pt, r2y + 18pt, 130pt, 55pt,
  [*Load pca\_params*\
  1.0 MB JSON\
  Mean vector (384)\
  Components (128$times$384)],
  fill: light-tan, stroke: warm-grey)

#note-at(720pt, r2y + 18pt, 190pt,
  [All four loads fire in *parallel*.\
  Total first-time download: ~31 MB.\
  *All cached by browser* --- subsequent\
  searches skip this step entirely.\
  Model ONNX files: ~23 MB (quantized).])

#lbl(0pt, r2y + 76pt, [Concurrent])
#hline(0pt, r2y + 73pt, 700pt, r2y + 73pt, color: warm-grey)

// --- Step 3: Embed query ---
#let r3y = r2y + 100pt
#subsec(0pt, r3y, [Step 3: Embed the Query])

#arr(100pt, r2y + 73pt, 100pt, r3y + 20pt)

#box-at(0pt, r3y + 20pt, 195pt, 42pt,
  [*Sentence Embedding*\
  Pass full query text to model\
  "car engineering" → 384 floats\
  Captures semantic meaning],
  fill: light-blue, stroke: atlantic)

#arr(195pt, r3y + 41pt, 230pt, r3y + 41pt)

#box-at(230pt, r3y + 20pt, 195pt, 42pt,
  [*PCA Projection*\
  Subtract mean (384 floats)\
  Multiply by components^T\
  Result: 128-dim vector],
  fill: light-blue, stroke: atlantic)

#arr(425pt, r3y + 41pt, 460pt, r3y + 41pt)

#box-at(460pt, r3y + 20pt, 130pt, 42pt,
  [*L2 Normalize*\
  $arrow.r.double$ unit vector\
  in PCA space],
  fill: light-blue, stroke: atlantic)

#note-at(620pt, r3y + 20pt, 280pt,
  [*Why the real model instead of word lookup?*\
  The model understands _any_ English --- colloquial terms,\
  misspellings, phrases it never saw in training data.\
  "car" → understands automotive/vehicle/mechanical.\
  "brain science" → understands neuroscience/cognition.\
  Word-averaging would fail on out-of-vocabulary terms.])

#note-at(620pt, r3y + 73pt, 280pt,
  [*Performance:* ~50--100ms per query on modern hardware.\
  Model weights are in WASM/WebGPU --- runs entirely\
  in browser, no server round-trip.])

// --- Step 4: Phrase expansion ---
#let r4y = r3y + 110pt
#subsec(0pt, r4y, [Step 4: Expand Query into Academic Phrases])

#arr(525pt, r3y + 62pt, 525pt, r4y + 20pt)

#box-at(0pt, r4y + 20pt, 230pt, 52pt,
  [*Cosine Similarity Search*\
  Query vector vs all 6,313 phrase vectors\
  $"sim"(q, p) = q dot p$ (both unit vectors)\
  ~6,313 dot products of 128 dims\
  *< 1ms on any device*],
  fill: light-blue, stroke: atlantic)

#arr(230pt, r4y + 46pt, 270pt, r4y + 46pt)

#box-at(270pt, r4y + 20pt, 180pt, 52pt,
  [*Filter + Select*\
  Discard phrases with sim < 0.25\
  Skip exact match of query\
  Rank by similarity\
  *Take top 8 phrases*],
  fill: light-blue, stroke: atlantic)

#arr(450pt, r4y + 46pt, 490pt, r4y + 46pt)

#box-at(490pt, r4y + 20pt, 160pt, 52pt,
  [*Build Search List*\
  \[original query\]\
  + \[8 expanded phrases\]\
  = *9 search terms*],
  fill: light-green, stroke: horseshoe)

#note-at(680pt, r4y + 20pt, 220pt,
  [*Example:* "machine learning" expands to:\
  1. "machine learning" _(original)_\
  2. "deep learning"\
  3. "data mining"\
  4. "neural networks"\
  5. "artificial intelligence"\
  6. "deep neural networks"\
  7. "statistical programming"\
  8. "artificial intelligence ai"\
  9. "supervised training"])

// --- Step 5: Dual search ---
#let r5y = r4y + 100pt
#subsec(0pt, r5y, [Step 5: Dual Search --- Live API + Local Database])

#arr(570pt, r4y + 72pt, 570pt, r5y + 20pt)

// API search (left)
#box-at(0pt, r5y + 20pt, 250pt, 60pt,
  [*5a. Live API Keyword Search*\
  Fire *9 concurrent* requests to\
  USC bulletin API (catalog) or\
  USC classes API (current term)\
  Each: `\{ field: "keyword", value: term \}`\
  Deduplicate results by course code],
  fill: light-blue, stroke: atlantic)

#arr-hv(570pt, r5y + 20pt, 125pt, r5y + 20pt, color: atlantic)

// Local search (right)
#box-at(380pt, r5y + 20pt, 250pt, 60pt,
  [*5b. Local Embedding Search*\
  Query vector vs 9,732 course vectors\
  (pre-computed from title + description)\
  Cosine similarity, threshold *> 0.30*\
  *Top 30 matches*\
  Catches courses API keywords missed],
  fill: light-blue, stroke: atlantic)

#arr(570pt, r5y + 20pt, 505pt, r5y + 20pt, color: atlantic)

#note-at(660pt, r5y + 20pt, 230pt,
  [*Why both?*\
  API search finds courses by keyword matching\
  in titles and descriptions (USC's search).\
  Local search finds courses by _semantic_\
  similarity to the query concept.\
  \
  A course about "Bayesian Networks" won't\
  match the keyword "machine learning" but\
  its description embedding is semantically\
  close. The local search catches it.])

#note-at(660pt, r5y + 100pt, 230pt,
  [*Why 0.30 threshold for local?*\
  Local vectors encode full title+description\
  (richer text), so similarities are higher and\
  more reliable than title-only comparisons.\
  0.30 keeps precision high.])

// --- Step 6: Merge ---
#let r6y = r5y + 105pt
#subsec(0pt, r6y, [Step 6: Merge and Deduplicate])

#arr(125pt, r5y + 80pt, 125pt, r6y + 20pt)
#arr(505pt, r5y + 80pt, 505pt, r6y + 20pt)

#box-at(170pt, r6y + 20pt, 280pt, 35pt,
  [*Merge by course code*\
  API results + local results\
  If same course found in both, keep one (API preferred)\
  Typical: 60--120 unique candidates],
  fill: black10, stroke: black90)

#arr-vh(125pt, r6y + 20pt, 170pt, r6y + 37pt, color: black90)
#arr-vh(505pt, r6y + 20pt, 450pt, r6y + 37pt, color: black90)

// --- Step 7: Score ---
#let r7y = r6y + 75pt
#subsec(0pt, r7y, [Step 7: Score and Filter Results])

#arr(310pt, r6y + 55pt, 310pt, r7y + 20pt)

#box-at(0pt, r7y + 20pt, 220pt, 55pt,
  [*Batch Embed All Titles*\
  Collect all candidate titles\
  Single model call: all titles at once\
  Output: N $times$ 384-dim matrix\
  (~100ms for 80 titles)],
  fill: light-blue, stroke: atlantic)

#arr(220pt, r7y + 47pt, 260pt, r7y + 47pt)

#box-at(260pt, r7y + 20pt, 180pt, 55pt,
  [*PCA + Normalize Each*\
  For each title vector:\
  Subtract mean, multiply\
  by components^T → 128-dim\
  L2 normalize],
  fill: light-blue, stroke: atlantic)

#arr(440pt, r7y + 47pt, 480pt, r7y + 47pt)

#box-at(480pt, r7y + 20pt, 180pt, 55pt,
  [*Cosine Sim vs Query*\
  $"score" = q dot t_i$\
  *Discard if score < 0.15*\
  Sort descending\
  *Keep top 50*],
  fill: light-blue, stroke: atlantic)

#note-at(690pt, r7y + 20pt, 210pt,
  [*Why embed titles again here?*\
  The API results only have titles (not\
  descriptions). We need the _model's_\
  understanding of each title vs the query,\
  not just keyword overlap.\
  \
  "Automotive System Fundamentals" scores\
  0.47 against "car engineering" despite\
  sharing zero words.])

#note-at(690pt, r7y + 88pt, 210pt,
  [*Why 0.15 threshold?*\
  Lower than local search (0.30) because\
  title-only embeddings are shorter text\
  and produce lower but still meaningful\
  similarity scores. 0.15 removes clear\
  noise while keeping borderline-relevant\
  courses.])

// --- Step 8: Availability ---
#let r8y = r7y + 110pt
#subsec(0pt, r8y, [Step 8: Cross-Reference with Live Term Data])

#arr(570pt, r7y + 75pt, 570pt, r8y + 20pt)

#box-at(100pt, r8y + 20pt, 250pt, 55pt,
  [*Fetch Live Sections*\
  Extract unique subjects from results\
  Fire *concurrent* subject queries to\
  classes API for selected term\
  Build map: code → \{sections, hasOpen\}],
  fill: light-tan, stroke: warm-grey)

#arr(350pt, r8y + 47pt, 400pt, r8y + 47pt)

#box-at(400pt, r8y + 20pt, 220pt, 55pt,
  [*Apply Filters*\
  If "current term only" checked:\
  #h(6pt) remove courses not offered this term\
  If "open sections only" checked:\
  #h(6pt) remove courses with no open sections\
  Add availability badges to all],
  fill: light-tan, stroke: warm-grey)

#note-at(650pt, r8y + 20pt, 240pt,
  [*API calls here:* one per unique subject in\
  results. Typically 10--25 subjects. All fire\
  concurrently → latency = single round-trip.\
  \
  This is the _only_ step where current-term\
  filtering happens. All prior steps search\
  the full catalog regardless of term.])

// --- Step 9: Render ---
#let r9y = r8y + 100pt
#subsec(0pt, r9y, [Step 9: Render])

#arr(510pt, r8y + 75pt, 510pt, r9y + 20pt)

#box-at(180pt, r9y + 20pt, 300pt, 50pt,
  [*Display Results*\
  Group by course code, sorted by similarity score\
  Show "Also searched:" expanded phrase tags\
  Each course: code, title, availability badge\
  Expandable: sections, prerequisites, offering history],
  fill: garnet, stroke: garnet, text-color: white)

// ================================================================
// SUMMARY BOX
// ================================================================

#let sy = r9y + 95pt

#place(dx: 0pt, dy: sy,
  rect(width: 900pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 1pt + black10, inset: 12pt,
    [
      #text(size: 10pt, weight: "bold", fill: garnet)[Summary of Resources and Performance]\
      #v(4pt)
      #grid(columns: (220pt, 220pt, 220pt, 220pt), column-gutter: 8pt,
        [
          #text(size: 8pt, weight: "bold")[Static Files (cached)]\
          #text(size: 7pt)[
          - Transformers.js + model: 23 MB
          - phrase\_embeddings.json: 2.4 MB
          - course\_embeddings.json: 4.4 MB
          - pca\_params.json: 1.0 MB
          - *Total first load: ~31 MB*
          ]
        ],
        [
          #text(size: 8pt, weight: "bold")[API Calls per Search]\
          #text(size: 7pt)[
          - Phrase expansion: 0 (local math)
          - Keyword searches: *9 concurrent*
          - Local DB search: 0 (local math)
          - Availability: 10--25 concurrent
          - *Total latency: ~1--2 seconds*
          ]
        ],
        [
          #text(size: 8pt, weight: "bold")[Client Computation]\
          #text(size: 7pt)[
          - Query embedding: ~50--100ms
          - Phrase similarity: < 1ms
          - Local course similarity: ~5ms
          - Title batch embedding: ~100ms
          - *Total compute: ~200ms*
          ]
        ],
        [
          #text(size: 8pt, weight: "bold")[Build Step (once/semester)]\
          #text(size: 7pt)[
          - `scrape_courses.py`: ~12 min
          - `build_embeddings.py`: ~30 sec
          - Requires: sentence-transformers
          - Re-run when catalog changes
          ]
        ],
      )
    ]
  )
)

// ================================================================
// LEGEND
// ================================================================

#let ly = sy + 115pt
#place(dx: 0pt, dy: ly,
  rect(width: 900pt, height: 35pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 0.5pt + black10, inset: 8pt,
    grid(columns: (12pt, auto, 24pt, 12pt, auto, 24pt, 12pt, auto, 24pt, 12pt, auto, 24pt, 12pt, auto),
      column-gutter: 4pt, align: horizon,
      rect(width: 12pt, height: 12pt, fill: light-blue, stroke: 1pt + atlantic),
      text(size: 7pt)[Client-side computation],
      [],
      rect(width: 12pt, height: 12pt, fill: light-tan, stroke: 1pt + warm-grey),
      text(size: 7pt)[Data loading / API calls],
      [],
      rect(width: 12pt, height: 12pt, fill: light-green, stroke: 1pt + horseshoe),
      text(size: 7pt)[Static data artifacts],
      [],
      rect(width: 12pt, height: 12pt, fill: light-purple, stroke: 1pt + congaree),
      text(size: 7pt)[ML model],
      [],
      rect(width: 12pt, height: 12pt, fill: garnet, stroke: 1pt + garnet),
      text(size: 7pt)[Entry / exit],
    )
  )
)

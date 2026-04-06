#set page(width: 14in, height: 24in, margin: (x: 0.5in, top: 0.4in, bottom: 0.4in))
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

// === Primitives ===

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

#let dln(x1, y1, x2, y2, color: warm-grey) = {
  place(dx: 0pt, dy: 0pt, line(start: (x1, y1), end: (x2, y2), stroke: (paint: color, thickness: 0.8pt, dash: "dashed")))
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

#let arr-vh(x1, y1, x2, y2, color: black90) = {
  ln(x1, y1, x1, y2, color: color)
  ln(x1, y2, x2, y2, color: color)
  hd(x2.pt(), y2.pt(), (x2 - x1).pt(), 0.0, color: color)
}

#let lbl(x, y, body) = { place(dx: x, dy: y, text(size: 6.5pt, fill: warm-grey, body)) }

#let sec(x, y, body) = { place(dx: x, dy: y, text(size: 12pt, weight: "bold", fill: garnet, body)) }

#let subsec(x, y, body) = { place(dx: x, dy: y, text(size: 10pt, weight: "bold", fill: atlantic, body)) }

// ================================================================
// TITLE
// ================================================================

#align(center, text(size: 18pt, weight: "bold", fill: garnet)[Semantic Search Pipeline: Detailed Architecture])
#v(1pt)
#align(center, text(size: 9pt, fill: warm-grey)[UofSC Course Scheduler --- J.C. Vaught --- April 2026])

// ================================================================
// PHASE 1: BUILD-TIME
// ================================================================

#let P1 = 50pt
#sec(0pt, P1, [PHASE 1: BUILD-TIME ARTIFACTS #text(size: 9pt, weight: "regular", fill: warm-grey)[(offline, run once per semester)]])

// Row 1: Data → Extract → Model
#let r1 = P1 + 30pt

#box-at(0pt, r1, 160pt, 42pt,
  [*Course Data Source*\
  `course_data.json`\
  9,732 courses\
  code, title, description],
  fill: light-tan, stroke: warm-grey)

#arr(160pt, r1 + 21pt, 200pt, r1 + 21pt)

#box-at(200pt, r1, 180pt, 42pt,
  [*Extract Academic Phrases*\
  Bigrams + trigrams from\
  all titles and descriptions\
  `min_count >= 5`, all unique words],
  fill: light-blue, stroke: atlantic)

#arr(380pt, r1 + 21pt, 420pt, r1 + 21pt)

#box-at(420pt, r1, 170pt, 42pt,
  [*Load Embedding Model*\
  `all-MiniLM-L6-v2`\
  384-dim sentence embeddings\
  Trained on 1B+ English pairs],
  fill: light-purple, stroke: congaree)


// Row 2: Embed phrases and courses
#let r2 = r1 + 115pt

#arr(510pt, r1 + 42pt, 510pt, r2)

// Embed phrases
#box-at(200pt, r2, 210pt, 42pt,
  [*Embed All 6,313 Phrases*\
  Each phrase passed through model\
  "deep learning" → \[0.023, -0.118, ...\]\
  Output: 6313 $times$ 384 matrix],
  fill: light-blue, stroke: atlantic)

#arr(510pt, r2 + 14pt, 410pt, r2 + 14pt, color: atlantic)

// Embed courses
#box-at(200pt, r2 + 58pt, 210pt, 42pt,
  [*Embed All 9,732 Courses*\
  Input: title + ". " + description\
  Full semantic content per course\
  Output: 9732 $times$ 384 matrix],
  fill: light-blue, stroke: atlantic)

#arr(510pt, r2 + 28pt, 510pt, r2 + 58pt + 14pt)
#arr(510pt, r2 + 58pt + 14pt, 410pt, r2 + 58pt + 14pt, color: atlantic)


// Row 3: PCA
#let r3 = r2 + 125pt

#arr(305pt, r2 + 100pt, 305pt, r3)

#box-at(130pt, r3, 350pt, 50pt,
  [*PCA Dimensionality Reduction*\
  Fit SVD on combined matrix (6,313 + 9,732 = 16,045 vectors $times$ 384)\
  Keep top 128 principal components → project all vectors to 128-dim\
  L2 normalize each projected vector to unit length\
  Quantize to int8: multiply by 127, clamp to \[-128, 127\], round to integer],
  fill: light-blue, stroke: atlantic)


// Row 4: Output files
#let r4 = r3 + 105pt

#arr(305pt, r3 + 50pt, 305pt, r4)

// Three files fanning out
#box-at(20pt, r4, 170pt, 50pt,
  [*phrase\_embeddings.json*\
  6,313 entries\
  `\{ "deep learning": [-42, 17, ...], ... \}`\
  phrase string → int8\[128\]\
  *File size: 2.4 MB*],
  fill: light-green, stroke: horseshoe)

#box-at(220pt, r4, 170pt, 50pt,
  [*course\_embeddings.json*\
  9,732 entries\
  code, title, subject, key\
  + vec: int8\[128\]\
  *File size: 4.4 MB*],
  fill: light-green, stroke: horseshoe)

#box-at(420pt, r4, 170pt, 50pt,
  [*pca\_params.json*\
  mean: float32\[384\]\
  components: float32\[128\]\[384\]\
  (128 principal component vectors)\
  *File size: 1.0 MB*],
  fill: light-green, stroke: horseshoe)

#arr-hv(305pt, r3 + 50pt, 105pt, r4, color: horseshoe)
#arr(305pt, r3 + 50pt, 305pt, r4, color: horseshoe)
#arr-hv(305pt, r3 + 50pt, 505pt, r4, color: horseshoe)



// ================================================================
// PHASE 2: RUNTIME
// ================================================================

#let P2 = r4 + 100pt
#sec(0pt, P2, [PHASE 2: RUNTIME SEARCH #text(size: 9pt, weight: "regular", fill: warm-grey)[(in browser, every keyword search)]])

// --- Step 1 ---
#let s1 = P2 + 30pt
#subsec(0pt, s1, [Step 1: User Input])

#box-at(0pt, s1 + 22pt, 220pt, 32pt,
  [*User types keyword query*\
  Examples: "car engineering", "brain science",\
  "transfer of heat", "money and investing"],
  fill: black10)


// --- Step 2 ---
#let s2 = s1 + 80pt
#subsec(0pt, s2, [Step 2: Lazy-Load Resources #text(size: 8pt, weight: "regular", fill: warm-grey)[(first keyword search only, all in parallel)]])

#arr(110pt, s1 + 54pt, 110pt, s2 + 24pt)

#box-at(0pt, s2 + 24pt, 175pt, 58pt,
  [*Load Transformers.js*\
  ES module import from CDN\
  `\@xenova/transformers\@2.17.2`\
  Initialize pipeline:\
  `feature-extraction`\
  Model: `Xenova/all-MiniLM-L6-v2`],
  fill: light-tan, stroke: warm-grey)

#box-at(195pt, s2 + 24pt, 150pt, 58pt,
  [*Load Phrase Embeddings*\
  `phrase_embeddings.json`\
  2.4 MB JSON → parse\
  Build normalized Float32\
  vectors for 6,313 phrases],
  fill: light-tan, stroke: warm-grey)

#box-at(365pt, s2 + 24pt, 155pt, 58pt,
  [*Load Course Embeddings*\
  `course_embeddings.json`\
  4.4 MB JSON → parse\
  Build normalized Float32\
  vectors for 9,732 courses],
  fill: light-tan, stroke: warm-grey)

#box-at(540pt, s2 + 24pt, 135pt, 58pt,
  [*Load PCA Params*\
  `pca_params.json`\
  1.0 MB JSON → parse\
  Mean: 384 floats\
  Components: 128$times$384],
  fill: light-tan, stroke: warm-grey)


#dln(0pt, s2 + 84pt, 675pt, s2 + 84pt, color: warm-grey)
#lbl(0pt, s2 + 86pt, [All four load concurrently via `Promise.all()`])

// --- Step 3 ---
#let s3 = s2 + 120pt
#subsec(0pt, s3, [Step 3: Embed the User's Query])

#arr(110pt, s2 + 86pt, 110pt, s3 + 24pt)

#box-at(0pt, s3 + 24pt, 210pt, 45pt,
  [*Sentence Embedding*\
  Pass raw query text to MiniLM model\
  "car engineering" → 384 float values\
  Model understands full English],
  fill: light-blue, stroke: atlantic)

#arr(210pt, s3 + 46pt, 250pt, s3 + 46pt)

#box-at(250pt, s3 + 24pt, 200pt, 45pt,
  [*PCA Projection*\
  For each of 128 output dims:\
  #h(4pt) $d_i = sum_(j=0)^(383) ("raw"_j - "mean"_j) dot C_(i,j)$\
  Result: 128-dimensional vector],
  fill: light-blue, stroke: atlantic)

#arr(450pt, s3 + 46pt, 490pt, s3 + 46pt)

#box-at(490pt, s3 + 24pt, 130pt, 45pt,
  [*L2 Normalize*\
  $v_i = v_i / ||v||$\
  Unit vector in\
  shared PCA space],
  fill: light-blue, stroke: atlantic)




// --- Step 4 ---
#let s4 = s3 + 150pt
#subsec(0pt, s4, [Step 4: Expand Query into Academic Phrases])

#arr(555pt, s3 + 69pt, 555pt, s4 + 24pt)

#box-at(0pt, s4 + 24pt, 255pt, 50pt,
  [*Cosine Similarity Search*\
  Query vector vs all 6,313 phrase vectors\
  $"sim"(q, p) = q dot p$ #h(4pt) (both are unit vectors)\
  6,313 dot products of 128 dimensions\
  *Completes in < 1 ms* on any device],
  fill: light-blue, stroke: atlantic)

#arr(255pt, s4 + 49pt, 300pt, s4 + 49pt)

#box-at(300pt, s4 + 24pt, 195pt, 50pt,
  [*Filter and Select*\
  Discard phrases with sim < 0.25\
  Skip if phrase = exact query string\
  (but keep rearrangements!)\
  Rank remaining by similarity\
  *Select top 8 phrases*],
  fill: light-blue, stroke: atlantic)

#arr(495pt, s4 + 49pt, 540pt, s4 + 49pt)

#box-at(540pt, s4 + 24pt, 160pt, 50pt,
  [*Build Search List*\
  1. Original query\
  2--9. Top 8 expanded phrases\
  \
  *= 9 search terms total*],
  fill: light-green, stroke: horseshoe)




// --- Step 5 ---
#let s5 = s4 + 195pt
#subsec(0pt, s5, [Step 5: Dual Search --- Live API + Local Database #text(size: 8pt, weight: "regular", fill: warm-grey)[(parallel)]])

#arr(620pt, s4 + 74pt, 620pt, s5 + 24pt)

// Left: API search
#box-at(0pt, s5 + 24pt, 300pt, 62pt,
  [*5a. Live API Keyword Search*\
  Fire all *9 search terms concurrently* to\
  USC bulletin API (catalog mode) or\
  USC classes API (current-term mode)\
  Each request: `\{ field: "keyword", value: "deep learning" \}`\
  Collect all returned courses, deduplicate by course code],
  fill: light-blue, stroke: atlantic)

#arr-hv(620pt, s5 + 24pt, 150pt, s5 + 24pt, color: atlantic)

// Right: Local search
#box-at(380pt, s5 + 24pt, 300pt, 62pt,
  [*5b. Local Embedding Search*\
  Query vector vs all 9,732 pre-computed course vectors\
  (these encode full title + description, not just title)\
  Cosine similarity: $q dot c_i$ for each course\
  Keep courses with similarity *> 0.30*\
  *Take top 30 matches*],
  fill: light-blue, stroke: atlantic)

#arr(620pt, s5 + 24pt, 530pt, s5 + 24pt, color: atlantic)




// --- Step 6 ---
#let s6 = s5 + 190pt
#subsec(0pt, s6, [Step 6: Merge and Deduplicate])

#arr(150pt, s5 + 86pt, 150pt, s6 + 28pt)
#arr(530pt, s5 + 86pt, 530pt, s6 + 28pt)

#box-at(200pt, s6 + 24pt, 300pt, 40pt,
  [*Merge by course code*\
  Combine all API results + all local results\
  If same course found in both sources, keep one copy\
  Typical result: *60--120 unique candidate courses*],
  fill: black10)

#arr-vh(150pt, s6 + 28pt, 200pt, s6 + 44pt, color: black90)
#arr-vh(530pt, s6 + 28pt, 500pt, s6 + 44pt, color: black90)



// --- Step 7 ---
#let s7 = s6 + 100pt
#subsec(0pt, s7, [Step 7: Score and Filter All Candidate Results])

#arr(350pt, s6 + 64pt, 350pt, s7 + 24pt)

#box-at(0pt, s7 + 24pt, 230pt, 52pt,
  [*Batch-Embed All Titles*\
  Collect all candidate course titles\
  Single model call (batched):\
  N titles → N $times$ 384-dim vectors\
  *~100ms for 80 titles*],
  fill: light-blue, stroke: atlantic)

#arr(230pt, s7 + 50pt, 270pt, s7 + 50pt)

#box-at(270pt, s7 + 24pt, 200pt, 52pt,
  [*PCA + Normalize Each Title*\
  For each title's 384-dim vector:\
  Subtract mean, multiply by C^T\
  → 128-dim PCA vector\
  L2 normalize to unit length],
  fill: light-blue, stroke: atlantic)

#arr(470pt, s7 + 50pt, 510pt, s7 + 50pt)

#box-at(510pt, s7 + 24pt, 190pt, 52pt,
  [*Cosine Similarity vs Query*\
  $"score"_i = q dot t_i$\
  *Discard if score < 0.15*\
  Sort remaining by score desc.\
  *Keep top 50 results*],
  fill: light-blue, stroke: atlantic)




// --- Step 8 ---
#let s8 = s7 + 195pt
#subsec(0pt, s8, [Step 8: Cross-Reference with Live Term Data])

#arr(605pt, s7 + 76pt, 605pt, s8 + 24pt)

#box-at(50pt, s8 + 24pt, 280pt, 55pt,
  [*Fetch Live Section Data*\
  Extract unique subject codes from results\
  (e.g., CSCE, MATH, STAT, BIOL, FINA...)\
  Fire *concurrent* subject queries to classes API\
  for the user's selected term\
  Build map: course code → \{sections, hasOpen\}],
  fill: light-tan, stroke: warm-grey)

#arr(330pt, s8 + 51pt, 390pt, s8 + 51pt)

#box-at(390pt, s8 + 24pt, 250pt, 55pt,
  [*Apply User's Filters*\
  If *"current term only"* is checked:\
  #h(8pt) remove courses with no sections this term\
  If *"open sections only"* is checked:\
  #h(8pt) remove courses where all sections are full\
  For remaining: add availability badge\
  #h(8pt) (term label / FULL / N/A)],
  fill: light-tan, stroke: warm-grey)



// --- Step 9 ---
#let s9 = s8 + 115pt
#subsec(0pt, s9, [Step 9: Render Results])

#arr(515pt, s8 + 79pt, 515pt, s9 + 24pt)

#box-at(200pt, s9 + 24pt, 340pt, 52pt,
  [*Display Ranked Results*\
  Group by course code, sorted by cosine similarity score\
  Header: "Also searched:" with expanded phrase tags\
  Each course: code, title, similarity-based relevance, availability badge\
  Expandable: individual sections, prerequisites, offering history],
  fill: garnet, stroke: garnet, text-color: white)


// ================================================================
// SUMMARY
// ================================================================

#let SU = s9 + 105pt

#place(dx: 0pt, dy: SU,
  rect(width: 900pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 1pt + black10, inset: 14pt,
    [
      #text(size: 11pt, weight: "bold", fill: garnet)[Summary of Resources and Performance]\
      #v(6pt)
      #grid(columns: (220pt, 220pt, 220pt, 220pt), column-gutter: 8pt,
        [
          #text(size: 8.5pt, weight: "bold")[Static Files (browser-cached)]\
          #v(2pt)
          #text(size: 7.5pt)[
          - Transformers.js + ONNX model: *23 MB*
          - phrase\_embeddings.json: *2.4 MB*
          - course\_embeddings.json: *4.4 MB*
          - pca\_params.json: *1.0 MB*
          - *Total first load: ~31 MB*
          - Subsequent loads: 0 (all cached)
          ]
        ],
        [
          #text(size: 8.5pt, weight: "bold")[API Calls per Search]\
          #v(2pt)
          #text(size: 7.5pt)[
          - Phrase expansion: *0* (local math)
          - Keyword searches: *9 concurrent*
          - Local DB search: *0* (local math)
          - Title scoring: *0* (local model)
          - Availability: *10--25 concurrent*
          - *Total latency: ~1--2 seconds*
          ]
        ],
        [
          #text(size: 8.5pt, weight: "bold")[Client-Side Computation]\
          #v(2pt)
          #text(size: 7.5pt)[
          - Query embedding: *50--100ms*
          - Phrase similarity (6,313): *< 1ms*
          - Local course similarity (9,732): *~5ms*
          - Title batch embedding (~80): *~100ms*
          - PCA projections: *< 1ms*
          - *Total compute: ~200ms*
          ]
        ],
        [
          #text(size: 8.5pt, weight: "bold")[Build Step (once per semester)]\
          #v(2pt)
          #text(size: 7.5pt)[
          - `scrape_courses.py`: *~12 min*\
            #h(8pt) (9,732 API calls, concurrent)
          - `build_embeddings.py`: *~30 sec*\
            #h(8pt) (requires sentence-transformers)
          - Output: 3 JSON files (7.8 MB)
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

#let LG = SU + 145pt
#place(dx: 0pt, dy: LG,
  rect(width: 900pt, height: 35pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 0.5pt + black10, inset: 8pt,
    grid(columns: (12pt, auto, 24pt, 12pt, auto, 24pt, 12pt, auto, 24pt, 12pt, auto, 24pt, 12pt, auto),
      column-gutter: 4pt, align: horizon,
      rect(width: 12pt, height: 12pt, fill: light-blue, stroke: 1pt + atlantic),
      text(size: 7.5pt)[Client-side computation],
      [],
      rect(width: 12pt, height: 12pt, fill: light-tan, stroke: 1pt + warm-grey),
      text(size: 7.5pt)[Data loading / API calls],
      [],
      rect(width: 12pt, height: 12pt, fill: light-green, stroke: 1pt + horseshoe),
      text(size: 7.5pt)[Static data artifacts],
      [],
      rect(width: 12pt, height: 12pt, fill: light-purple, stroke: 1pt + congaree),
      text(size: 7.5pt)[ML model],
      [],
      rect(width: 12pt, height: 12pt, fill: garnet, stroke: 1pt + garnet),
      text(size: 7.5pt)[Entry / exit points],
    )
  )
)

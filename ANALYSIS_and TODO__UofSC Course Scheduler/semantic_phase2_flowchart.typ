#set page(width: 11in, height: 17in, margin: (x: 0.5in, top: 0.4in, bottom: 0.4in))
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

#let subsec(x, y, body) = { place(dx: x, dy: y, text(size: 10pt, weight: "bold", fill: atlantic, body)) }

// ================================================================
// TITLE
// ================================================================

#align(center, text(size: 16pt, weight: "bold", fill: garnet)[Semantic Search: Phase 2 --- Runtime Pipeline])
#v(1pt)
#align(center, text(size: 9pt, fill: warm-grey)[UofSC Course Scheduler --- J.C. Vaught --- April 2026])
#v(2pt)
#align(center, text(size: 8pt, fill: warm-grey)[Executes in the browser on every keyword search (5+ character non-code input)])

// ================================================================
// Step 1: User Input
// ================================================================

#let s1 = 55pt
#subsec(0pt, s1, [Step 1: User Input])

#box-at(0pt, s1 + 22pt, 260pt, 32pt,
  [*User types keyword query*\
  Examples: "car engineering", "brain science",\
  "transfer of heat", "money and investing"],
  fill: black10)

// ================================================================
// Step 2: Load Resources
// ================================================================

#let s2 = s1 + 80pt
#subsec(0pt, s2, [Step 2: Lazy-Load Resources #text(size: 8pt, weight: "regular", fill: warm-grey)[(first keyword search only)]])

#arr(130pt, s1 + 54pt, 130pt, s2 + 24pt)

#box-at(0pt, s2 + 24pt, 170pt, 55pt,
  [*Transformers.js Model*\
  ES module from CDN\
  `Xenova/all-MiniLM-L6-v2`\
  ONNX quantized: *~23 MB*\
  Cached by browser],
  fill: light-tan, stroke: warm-grey)

#box-at(190pt, s2 + 24pt, 140pt, 55pt,
  [*Phrase Embeddings*\
  6,313 phrases\
  int8\[128\] vectors\
  *2.4 MB*],
  fill: light-tan, stroke: warm-grey)

#box-at(350pt, s2 + 24pt, 140pt, 55pt,
  [*Course Embeddings*\
  9,732 courses\
  int8\[128\] vectors\
  *4.4 MB*],
  fill: light-tan, stroke: warm-grey)

#box-at(510pt, s2 + 24pt, 130pt, 55pt,
  [*PCA Params*\
  Mean: float\[384\]\
  Components:\
  float\[128\]\[384\]\
  *1.0 MB*],
  fill: light-tan, stroke: warm-grey)

#dln(0pt, s2 + 81pt, 640pt, s2 + 81pt, color: warm-grey)
#lbl(0pt, s2 + 84pt, [All four load concurrently via `Promise.all()` --- total first-time: ~31 MB, cached thereafter])

// ================================================================
// Step 3: Embed Query
// ================================================================

#let s3 = s2 + 120pt
#subsec(0pt, s3, [Step 3: Embed the User's Query])

#arr(130pt, s2 + 84pt, 130pt, s3 + 24pt)

#box-at(0pt, s3 + 24pt, 200pt, 48pt,
  [*Sentence Embedding*\
  Pass raw query to MiniLM model\
  "car engineering" → 384 floats\
  Understands any English input\
  *~50--100ms*],
  fill: light-blue, stroke: atlantic)

#arr(200pt, s3 + 48pt, 240pt, s3 + 48pt)

#box-at(240pt, s3 + 24pt, 195pt, 48pt,
  [*PCA Projection*\
  Subtract mean (384 floats)\
  Multiply by components matrix\
  → 128-dimensional vector],
  fill: light-blue, stroke: atlantic)

#arr(435pt, s3 + 48pt, 475pt, s3 + 48pt)

#box-at(475pt, s3 + 24pt, 150pt, 48pt,
  [*L2 Normalize*\
  $v_i = v_i / ||v||$\
  Result: unit vector in\
  shared 128-dim PCA space],
  fill: light-blue, stroke: atlantic)

// ================================================================
// Step 4: Phrase Expansion
// ================================================================

#let s4 = s3 + 105pt
#subsec(0pt, s4, [Step 4: Expand Query into Academic Phrases])

#arr(550pt, s3 + 72pt, 550pt, s4 + 24pt)

#box-at(0pt, s4 + 24pt, 225pt, 52pt,
  [*Cosine Similarity Search*\
  Query vector vs all 6,313 phrase vectors\
  $"sim"(q, p) = q dot p$ (unit vectors)\
  6,313 dot products $times$ 128 dims\
  *< 1ms on any device*],
  fill: light-blue, stroke: atlantic)

#arr(225pt, s4 + 50pt, 265pt, s4 + 50pt)

#box-at(265pt, s4 + 24pt, 180pt, 52pt,
  [*Filter and Select*\
  Discard phrases with sim < 0.25\
  Skip exact query string match\
  (keep rearrangements)\
  Rank by similarity\
  *Select top 8 phrases*],
  fill: light-blue, stroke: atlantic)

#arr(445pt, s4 + 50pt, 490pt, s4 + 50pt)

#box-at(490pt, s4 + 24pt, 155pt, 52pt,
  [*Build Search List*\
  1. Original query\
  2--9. Top 8 phrases\
  \
  *= 9 search terms*],
  fill: light-green, stroke: horseshoe)

// ================================================================
// Step 5: Dual Search
// ================================================================

#let s5 = s4 + 110pt
#subsec(0pt, s5, [Step 5: Dual Search --- Live API + Local Database #text(size: 8pt, weight: "regular", fill: warm-grey)[(parallel)]])

#arr(567pt, s4 + 76pt, 567pt, s5 + 24pt)

#box-at(0pt, s5 + 24pt, 290pt, 60pt,
  [*5a. Live API Keyword Search*\
  Fire all *9 search terms concurrently*\
  USC bulletin API (catalog) or classes API (term)\
  Each: `\{ field: "keyword", value: term \}`\
  Collect results, deduplicate by course code\
  *Always returns fresh data*],
  fill: light-blue, stroke: atlantic)

#arr-hv(567pt, s5 + 24pt, 145pt, s5 + 24pt, color: atlantic)

#box-at(355pt, s5 + 24pt, 290pt, 60pt,
  [*5b. Local Embedding Search*\
  Query vector vs 9,732 pre-computed course vectors\
  (encode full title + description text)\
  Cosine similarity, keep sim *> 0.30*\
  *Top 30 matches*\
  Catches courses API keyword search missed],
  fill: light-blue, stroke: atlantic)

#arr(567pt, s5 + 24pt, 500pt, s5 + 24pt, color: atlantic)

// ================================================================
// Step 6: Merge
// ================================================================

#let s6 = s5 + 115pt
#subsec(0pt, s6, [Step 6: Merge and Deduplicate])

#arr(145pt, s5 + 84pt, 145pt, s6 + 28pt)
#arr(500pt, s5 + 84pt, 500pt, s6 + 28pt)

#box-at(180pt, s6 + 24pt, 300pt, 38pt,
  [*Merge by course code*\
  Combine all API results + all local results\
  Deduplicate: keep one copy per course code\
  Typical: *60--120 unique candidate courses*],
  fill: black10)

#arr-vh(145pt, s6 + 28pt, 180pt, s6 + 43pt, color: black90)
#arr-vh(500pt, s6 + 28pt, 480pt, s6 + 43pt, color: black90)

// ================================================================
// Step 7: Score
// ================================================================

#let s7 = s6 + 95pt
#subsec(0pt, s7, [Step 7: Score and Filter All Results])

#arr(330pt, s6 + 62pt, 330pt, s7 + 24pt)

#box-at(0pt, s7 + 24pt, 210pt, 52pt,
  [*Batch-Embed All Titles*\
  Collect all candidate course titles\
  Single batched model call\
  N titles → N $times$ 384-dim vectors\
  *~100ms for ~80 titles*],
  fill: light-blue, stroke: atlantic)

#arr(210pt, s7 + 50pt, 250pt, s7 + 50pt)

#box-at(250pt, s7 + 24pt, 185pt, 52pt,
  [*PCA + Normalize Each*\
  For each title's 384-dim vector:\
  Subtract mean, multiply by C^T\
  → 128-dim PCA vector\
  L2 normalize to unit length],
  fill: light-blue, stroke: atlantic)

#arr(435pt, s7 + 50pt, 475pt, s7 + 50pt)

#box-at(475pt, s7 + 24pt, 180pt, 52pt,
  [*Cosine Sim vs Query*\
  $"score"_i = q dot t_i$\
  *Discard if score < 0.15*\
  Sort remaining descending\
  *Keep top 50 results*],
  fill: light-blue, stroke: atlantic)

// ================================================================
// Step 8: Availability
// ================================================================

#let s8 = s7 + 110pt
#subsec(0pt, s8, [Step 8: Cross-Reference with Live Term Data])

#arr(565pt, s7 + 76pt, 565pt, s8 + 24pt)

#box-at(30pt, s8 + 24pt, 270pt, 52pt,
  [*Fetch Live Section Data*\
  Extract unique subjects from results\
  (CSCE, MATH, STAT, BIOL, FINA...)\
  Fire *concurrent* subject queries\
  to classes API for selected term\
  Build map: code → \{sections, hasOpen\}],
  fill: light-tan, stroke: warm-grey)

#arr(300pt, s8 + 50pt, 350pt, s8 + 50pt)

#box-at(350pt, s8 + 24pt, 260pt, 52pt,
  [*Apply User's Filters*\
  If *"current term only"* checked:\
  #h(6pt) remove courses not offered this term\
  If *"open sections only"* checked:\
  #h(6pt) remove full sections\
  Add availability badge to each course],
  fill: light-tan, stroke: warm-grey)

// ================================================================
// Step 9: Render
// ================================================================

#let s9 = s8 + 110pt
#subsec(0pt, s9, [Step 9: Render Results])

#arr(480pt, s8 + 76pt, 480pt, s9 + 24pt)

#box-at(150pt, s9 + 24pt, 360pt, 48pt,
  [*Display Ranked Results*\
  Group by course code, sorted by cosine similarity score\
  Header: "Also searched:" with expanded phrase tags\
  Each course: code, title, availability badge\
  Expandable: individual sections, prerequisites, offering history],
  fill: garnet, stroke: garnet, text-color: white)

// ================================================================
// Summary
// ================================================================

#let SU = s9 + 100pt

#place(dx: 0pt, dy: SU,
  rect(width: 720pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 1pt + black10, inset: 12pt,
    [
      #text(size: 10pt, weight: "bold", fill: garnet)[Performance Summary]\
      #v(4pt)
      #grid(columns: (170pt, 170pt, 170pt, 170pt), column-gutter: 8pt,
        [
          #text(size: 8pt, weight: "bold")[First-Time Download]\
          #v(2pt)
          #text(size: 7pt)[
          Model: *23 MB* (CDN, cached)\
          Phrases: *2.4 MB*\
          Courses: *4.4 MB*\
          PCA: *1.0 MB*\
          *Total: ~31 MB*
          ]
        ],
        [
          #text(size: 8pt, weight: "bold")[API Calls per Search]\
          #v(2pt)
          #text(size: 7pt)[
          Keyword: *9 concurrent*\
          Availability: *10--25 concurrent*\
          Local search: *0* (math only)\
          Scoring: *0* (model in browser)\
          *Latency: ~1--2 sec*
          ]
        ],
        [
          #text(size: 8pt, weight: "bold")[Client Computation]\
          #v(2pt)
          #text(size: 7pt)[
          Query embed: *50--100ms*\
          Phrase search: *< 1ms*\
          Local search: *~5ms*\
          Title embeds: *~100ms*\
          *Total: ~200ms*
          ]
        ],
        [
          #text(size: 8pt, weight: "bold")[Build Step]\
          #v(2pt)
          #text(size: 7pt)[
          Scrape: *~12 min* (once)\
          Embed: *~30 sec*\
          Output: *7.8 MB* (3 files)\
          Re-run per semester
          ]
        ],
      )
    ]
  )
)

// ================================================================
// Legend
// ================================================================

#let LG = SU + 110pt
#place(dx: 0pt, dy: LG,
  rect(width: 720pt, height: 30pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 0.5pt + black10, inset: 6pt,
    grid(columns: (12pt, auto, 20pt, 12pt, auto, 20pt, 12pt, auto, 20pt, 12pt, auto),
      column-gutter: 4pt, align: horizon,
      rect(width: 12pt, height: 12pt, fill: light-blue, stroke: 1pt + atlantic),
      text(size: 7pt)[Client-side computation],
      [],
      rect(width: 12pt, height: 12pt, fill: light-tan, stroke: 1pt + warm-grey),
      text(size: 7pt)[Data loading / API calls],
      [],
      rect(width: 12pt, height: 12pt, fill: light-green, stroke: 1pt + horseshoe),
      text(size: 7pt)[Intermediate data],
      [],
      rect(width: 12pt, height: 12pt, fill: garnet, stroke: 1pt + garnet),
      text(size: 7pt)[Entry / exit],
    )
  )
)

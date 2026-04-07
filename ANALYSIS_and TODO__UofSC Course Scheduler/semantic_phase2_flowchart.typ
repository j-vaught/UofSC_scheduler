#set page(width: 11in, height: 14in, margin: (x: 0.5in, top: 0.4in, bottom: 0.4in))
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

#let subsec(x, y, body) = { place(dx: x, dy: y, text(size: 9pt, weight: "bold", fill: atlantic, body)) }

// ================================================================
// Layout constants — centered symmetric
// ================================================================

#let cx = 360pt       // page center
#let gap = 140pt      // half-gap between paired columns
#let lc = cx - gap    // left center = 220
#let rc = cx + gap    // right center = 500

#let bw = 180pt       // standard box width
#let bh = 30pt        // standard box height
#let bw-s = 150pt     // small box width (for 3-across rows)

// Row positions
#let y1 = 50pt
#let y2 = 110pt
#let y3 = 205pt
#let y4 = 290pt
#let y5 = 375pt
#let y6 = 460pt
#let y7 = 535pt
#let y8 = 625pt
#let y9 = 710pt

// ================================================================
// TITLE
// ================================================================

#align(center, text(size: 16pt, weight: "bold", fill: garnet)[Semantic Search: Phase 2 --- Runtime Pipeline])
#v(1pt)
#align(center, text(size: 9pt, fill: warm-grey)[UofSC Course Scheduler --- J.C. Vaught --- April 2026])
#v(1pt)
#align(center, text(size: 8pt, fill: warm-grey)[Executes in the browser on every keyword search])

// ================================================================
// STEP 1: User Query
// ================================================================

#subsec(0pt, y1, [Step 1])
#box-at(cx - bw/2, y1, bw, bh,
  [*User Query*],
  fill: black10)

#arr(cx, y1 + bh, cx, y2)

// ================================================================
// STEP 2: Load Resources (4 boxes, first time only)
// ================================================================

#subsec(0pt, y2, [Step 2])

#let r2w = 140pt
#let r2-positions = (
  cx - r2w*2 - 15pt,
  cx - r2w/2 - 5pt,
  cx + r2w/2 + 5pt,
  cx + r2w*2 - r2w + 15pt,
)

#box-at(r2-positions.at(0), y2, r2w, 40pt,
  [*Load AI Model*\
  MiniLM-L6-v2],
  fill: light-tan, stroke: warm-grey)

#box-at(r2-positions.at(1), y2, r2w, 40pt,
  [*Load Phrase Embeddings*],
  fill: light-tan, stroke: warm-grey)

#box-at(r2-positions.at(2), y2, r2w, 40pt,
  [*Load Course Embeddings*],
  fill: light-tan, stroke: warm-grey)

#box-at(r2-positions.at(3), y2, r2w, 40pt,
  [*Load Compression Params*],
  fill: light-tan, stroke: warm-grey)

#dln(r2-positions.at(0), y2 + 44pt, r2-positions.at(3) + r2w, y2 + 44pt, color: warm-grey)
#place(dx: r2-positions.at(0), dy: y2 + 46pt, text(size: 6.5pt, fill: warm-grey)[All four load concurrently --- ~31 MB first time, cached thereafter])

// Arrow from step 2 to step 3
#arr(cx, y2 + 56pt, cx, y3)

// ================================================================
// STEP 3: Embed Query (3 boxes left to right)
// ================================================================

#subsec(0pt, y3, [Step 3])

#let s3-gap = 165pt
#let s3-l = cx - s3-gap
#let s3-r = cx + s3-gap

#box-at(s3-l - bw-s/2, y3, bw-s, bh,
  [*Embed Query*],
  fill: light-blue, stroke: atlantic)

#box-at(cx - bw-s/2, y3, bw-s, bh,
  [*Compress to 128-dim*],
  fill: light-blue, stroke: atlantic)

#box-at(s3-r - bw-s/2, y3, bw-s, bh,
  [*Normalize*],
  fill: light-blue, stroke: atlantic)

#arr(s3-l + bw-s/2, y3 + bh/2, cx - bw-s/2, y3 + bh/2)
#arr(cx + bw-s/2, y3 + bh/2, s3-r - bw-s/2, y3 + bh/2)

// Arrow down from normalize to step 4
#arr(s3-r, y3 + bh, s3-r, y4)

// ================================================================
// STEP 4: Phrase Expansion (3 boxes left to right)
// ================================================================

#subsec(0pt, y4, [Step 4])

#box-at(s3-l - bw-s/2, y4, bw-s, bh,
  [*Find Related Phrases*],
  fill: light-blue, stroke: atlantic)

#box-at(cx - bw-s/2, y4, bw-s, bh,
  [*Filter and Rank*],
  fill: light-blue, stroke: atlantic)

#box-at(s3-r - bw-s/2, y4, bw-s, bh,
  [*Build Search List*],
  fill: light-green, stroke: horseshoe)

#arr(s3-l + bw-s/2, y4 + bh/2, cx - bw-s/2, y4 + bh/2)
#arr(cx + bw-s/2, y4 + bh/2, s3-r - bw-s/2, y4 + bh/2)

// Arrow from search list down, centering to step 5
#arr(s3-r, y4 + bh, s3-r, y4 + bh + 15pt)
// Fan out to two boxes
#ln(s3-r, y4 + bh + 15pt, lc, y4 + bh + 15pt)
#ln(s3-r, y4 + bh + 15pt, rc, y4 + bh + 15pt)
#arr(lc, y4 + bh + 15pt, lc, y5)
#arr(rc, y4 + bh + 15pt, rc, y5)

// ================================================================
// STEP 5: Dual Search (2 boxes side by side)
// ================================================================

#subsec(0pt, y5, [Step 5])

#box-at(lc - bw/2, y5, bw, bh,
  [*Search Live USC API*],
  fill: light-blue, stroke: atlantic)

#box-at(rc - bw/2, y5, bw, bh,
  [*Search Local Database*],
  fill: light-blue, stroke: atlantic)

// Both converge to merge
#let merge-bus = y5 + bh + 15pt
#ln(lc, y5 + bh, lc, merge-bus)
#ln(rc, y5 + bh, rc, merge-bus)
#ln(lc, merge-bus, rc, merge-bus)
#arr(cx, merge-bus, cx, y6)

// ================================================================
// STEP 6: Merge (centered)
// ================================================================

#subsec(0pt, y6, [Step 6])

#box-at(cx - bw/2, y6, bw, bh,
  [*Merge and Deduplicate*],
  fill: black10)

#arr(cx, y6 + bh, cx, y7)

// ================================================================
// STEP 7: Score (3 boxes left to right)
// ================================================================

#subsec(0pt, y7, [Step 7])

#box-at(s3-l - bw-s/2, y7, bw-s, bh,
  [*Embed All Titles*],
  fill: light-blue, stroke: atlantic)

#box-at(cx - bw-s/2, y7, bw-s, bh,
  [*Compress and Normalize*],
  fill: light-blue, stroke: atlantic)

#box-at(s3-r - bw-s/2, y7, bw-s, bh,
  [*Score and Rank*],
  fill: light-blue, stroke: atlantic)

#arr(s3-l + bw-s/2, y7 + bh/2, cx - bw-s/2, y7 + bh/2)
#arr(cx + bw-s/2, y7 + bh/2, s3-r - bw-s/2, y7 + bh/2)

// Arrow down to step 8
#arr(s3-r, y7 + bh, s3-r, y7 + bh + 15pt)
#ln(s3-r, y7 + bh + 15pt, cx, y7 + bh + 15pt)
#arr(cx, y7 + bh + 15pt, cx, y8)

// ================================================================
// STEP 8: Availability (2 boxes side by side)
// ================================================================

#subsec(0pt, y8, [Step 8])

#box-at(lc - bw/2, y8, bw, bh,
  [*Check Availability*],
  fill: light-tan, stroke: warm-grey)

#box-at(rc - bw/2, y8, bw, bh,
  [*Apply User Filters*],
  fill: light-tan, stroke: warm-grey)

// Arrow between and down
#arr(lc + bw/2, y8 + bh/2, rc - bw/2, y8 + bh/2)
#arr(rc, y8 + bh, rc, y8 + bh + 15pt)
#ln(rc, y8 + bh + 15pt, cx, y8 + bh + 15pt)
#arr(cx, y8 + bh + 15pt, cx, y9)

// ================================================================
// STEP 9: Render (centered)
// ================================================================

#subsec(0pt, y9, [Step 9])

#box-at(cx - bw/2, y9, bw, bh,
  [*Display Results*],
  fill: garnet, stroke: garnet, text-color: white)

// ================================================================
// KEY: What each step means
// ================================================================

#let ky = y9 + 55pt

#place(dx: 0pt, dy: ky,
  rect(width: 720pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 1pt + black10, inset: 10pt,
    [
      #text(size: 10pt, weight: "bold", fill: garnet)[Step Descriptions]\
      #v(4pt)
      #grid(columns: (60pt, 1fr), row-gutter: 4pt,
        text(size: 7.5pt, weight: "bold")[Step 1],
        text(size: 7.5pt)[*User Query* --- User types a keyword phrase (5+ chars) such as "machine learning" or "car engineering."],
        text(size: 7.5pt, weight: "bold")[Step 2],
        text(size: 7.5pt)[*Load Resources* --- On first keyword search only: download the AI model (~23 MB from CDN), phrase embeddings (2.4 MB), course embeddings (4.4 MB), and compression parameters (1 MB). All four load in parallel and are cached by the browser.],
        text(size: 7.5pt, weight: "bold")[Step 3],
        text(size: 7.5pt)[*Embed Query* --- Pass the raw query text through MiniLM-L6-v2 to produce a 384-dim vector, then compress to 128 dimensions via PCA projection and normalize to unit length. This captures the semantic meaning of any English input (~50--100ms).],
        text(size: 7.5pt, weight: "bold")[Step 4],
        text(size: 7.5pt)[*Phrase Expansion* --- Compare the query vector against 6,313 pre-computed academic phrase vectors by cosine similarity. Select the top 8 most similar phrases (sim > 0.25), producing 9 total search terms (original + 8 expanded).],
        text(size: 7.5pt, weight: "bold")[Step 5],
        text(size: 7.5pt)[*Dual Search* --- Fire all 9 search terms concurrently to the USC API (live, always fresh). Simultaneously search 9,732 pre-computed course embeddings locally (catches courses the API keyword search misses). Both run in parallel.],
        text(size: 7.5pt, weight: "bold")[Step 6],
        text(size: 7.5pt)[*Merge* --- Combine results from both sources, deduplicate by course code. Typically produces 60--120 unique candidate courses.],
        text(size: 7.5pt, weight: "bold")[Step 7],
        text(size: 7.5pt)[*Score and Rank* --- Batch-embed all candidate titles through the model, compress via PCA, then score each by cosine similarity to the query vector. Discard courses below 0.15 similarity. Sort descending, keep top 50.],
        text(size: 7.5pt, weight: "bold")[Step 8],
        text(size: 7.5pt)[*Availability* --- Fetch live section data from USC for the selected term (concurrent by subject). If "current term only" is checked, remove courses not offered. If "open only," remove full sections. Add availability badges.],
        text(size: 7.5pt, weight: "bold")[Step 9],
        text(size: 7.5pt)[*Display* --- Show results grouped by course code, sorted by similarity. Display "Also searched" phrase tags. Each course expandable for sections, prerequisites, and offering history.],
      )
    ]
  )
)

// ================================================================
// Legend
// ================================================================

#let LG = ky + 260pt
#place(dx: 0pt, dy: LG,
  rect(width: 720pt, height: 26pt, radius: 0pt, fill: rgb("#fafafa"), stroke: 0.5pt + black10, inset: 5pt,
    grid(columns: (12pt, auto, 24pt, 12pt, auto, 24pt, 12pt, auto, 24pt, 12pt, auto),
      column-gutter: 4pt, align: horizon,
      rect(width: 12pt, height: 12pt, fill: light-blue, stroke: 1pt + atlantic),
      text(size: 7pt)[Client computation],
      [],
      rect(width: 12pt, height: 12pt, fill: light-tan, stroke: 1pt + warm-grey),
      text(size: 7pt)[Data / API calls],
      [],
      rect(width: 12pt, height: 12pt, fill: light-green, stroke: 1pt + horseshoe),
      text(size: 7pt)[Intermediate data],
      [],
      rect(width: 12pt, height: 12pt, fill: garnet, stroke: 1pt + garnet),
      text(size: 7pt)[Output],
    )
  )
)

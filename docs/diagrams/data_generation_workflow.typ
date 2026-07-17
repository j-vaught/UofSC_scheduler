#import "@preview/cetz:0.5.2"

#set page(width: 14in, height: 6.75in, margin: 0.22in, fill: white)
#set text(font: "New Computer Modern", size: 8pt)

#let garnet = rgb("#73000A")
#let black90 = rgb("#363636")
#let black70 = rgb("#5C5C5C")
#let black30 = rgb("#C7C7C7")
#let black10 = rgb("#ECECEC")
#let atlantic = rgb("#466A9F")
#let horseshoe = rgb("#65780B")
#let honeycomb = rgb("#A49137")
#let sandstorm = rgb("#FFF2E3")
#let pale-blue = rgb("#E8EEF6")
#let pale-green = rgb("#EFF3E2")

#cetz.canvas(length: 0.45in, y: -1, background: white, padding: 0.08, {
  import cetz.draw: *

  let step(x, y, w, h, number, title, body, fill: white, stroke: black70) = {
    rect((x, y), (x + w, y + h), fill: fill, stroke: 1.1pt + stroke, radius: 0pt)
    rect((x, y), (x + 0.72, y + h), fill: stroke, stroke: none, radius: 0pt)
    content((x + 0.36, y + h / 2), anchor: "center", text(size: 10pt, weight: "bold", fill: white, number))
    content(
      (x + 0.95, y + 0.24),
      anchor: "north-west",
      block(
        width: (w - 1.2) * 0.45in,
        stack(
          dir: ttb,
          spacing: 3pt,
          text(size: 8pt, weight: "bold", fill: stroke, title),
          text(size: 6.55pt, fill: black90, body),
        ),
      ),
    )
  }

  let arrow(x1, y1, x2, y2, color: black70) = {
    line((x1, y1), (x2, y2), stroke: 1.5pt + color, mark: (end: ">"))
  }

  let band(y, h, label, fill, stroke) = {
    rect((0.45, y), (29.15, y + h), fill: fill, stroke: 1.1pt + stroke, radius: 0pt)
    rect((0.45, y), (3.25, y + h), fill: stroke, stroke: none, radius: 0pt)
    content((1.85, y + h / 2), anchor: "center", text(size: 6pt, weight: "bold", fill: white, label))
  }

  rect((0, 0), (29.6, 1.18), fill: garnet, stroke: none, radius: 0pt)
  content((0.45, 0.4), anchor: "west", text(size: 15pt, weight: "bold", fill: white)[Build and Data-Generation Workflow])
  content((29.15, 0.4), anchor: "east", text(size: 7pt, fill: white)[One-time migration and periodic releases])

  band(1.62, 4.55, [ONE-TIME MIGRATION], black10, black90)
  step(3.72, 2.12, 4.45, 3.52, [1], [Freeze parity fixtures], [Capture representative solver, prerequisite, transcript, planner, and offering-analysis outputs before ports begin.], fill: white, stroke: black90)
  step(8.58, 2.12, 4.45, 3.52, [2], [Port runtime logic], [Move scheduling and analysis into browser-safe cores and Web Workers while keeping the existing UI modules.], fill: pale-blue, stroke: atlantic)
  step(13.44, 2.12, 4.45, 3.52, [3], [Add static data store], [Introduce the release manifest, immutable shards, service worker, Cache Storage, and IndexedDB indexes.], fill: pale-green, stroke: horseshoe)
  step(18.3, 2.12, 4.45, 3.52, [4], [Establish live API access], [Validate the final deployment origin for direct current-term search, details, and faculty requests.], fill: sandstorm, stroke: garnet)
  step(23.16, 2.12, 5.45, 3.52, [5], [Validate and cut over], [Run parity, accessibility, request-count, bundle, and desktop screenshot checks before removing the Python runtime path.], fill: white, stroke: black90)
  arrow(8.17, 3.88, 8.58, 3.88)
  arrow(13.03, 3.88, 13.44, 3.88, color: atlantic)
  arrow(17.89, 3.88, 18.3, 3.88, color: horseshoe)
  arrow(22.75, 3.88, 23.16, 3.88, color: garnet)

  band(6.55, 7.35, [PERIODIC RELEASE], sandstorm, honeycomb)
  step(3.72, 7.12, 3.82, 2.62, [1], [Detect changed sources], [New grade workbook or completed term. Catalog, building, or curriculum changes follow their own cadence.], fill: white, stroke: honeycomb)
  step(7.93, 7.12, 3.82, 2.62, [2], [Pull each term once], [Reuse the complete section pull for grade matching and offering history. Preserve failed coverage as unknown.], fill: white, stroke: honeycomb)
  step(12.14, 7.12, 3.82, 2.62, [3], [Aggregate], [Build privacy-safe course grades, professor summaries, term offerings, enrollment, and capacity.], fill: pale-green, stroke: horseshoe)
  step(16.35, 7.12, 3.82, 2.62, [4], [Refresh only affected data], [Regenerate catalog embeddings only when catalog text changes. Refresh buildings and maps independently.], fill: pale-blue, stroke: atlantic)
  step(20.56, 7.12, 3.82, 2.62, [5], [Validate and shard], [Check schemas, privacy, coverage, duplicates, impossible values, sizes, and hashes.], fill: white, stroke: black90)
  step(24.77, 7.12, 3.84, 2.62, [6], [Publish atomically], [Upload immutable bundles first. Publish `manifest.json` last to activate the release.], fill: pale-green, stroke: horseshoe)
  arrow(7.54, 8.43, 7.93, 8.43, color: honeycomb)
  arrow(11.75, 8.43, 12.14, 8.43, color: honeycomb)
  arrow(15.96, 8.43, 16.35, 8.43, color: horseshoe)
  arrow(20.17, 8.43, 20.56, 8.43, color: atlantic)
  arrow(24.38, 8.43, 24.77, 8.43, color: black90)

  step(3.72, 10.25, 8.0, 2.72, [A], [Completed-term release], [Run when an official grade workbook or finalized term becomes available. Grades, professor aggregates, and offering history update together.], fill: white, stroke: garnet)
  step(12.14, 10.25, 7.98, 2.72, [B], [Catalog release], [Run when bulletin content materially changes. Rebuild course records, phrase embeddings, course embeddings, and PCA parameters.], fill: white, stroke: atlantic)
  step(20.56, 10.25, 8.05, 2.72, [C], [Independent updates], [Buildings update when aliases change. Major maps update with curricula. Site notices publish without rebuilding other data.], fill: white, stroke: horseshoe)

  rect((3.72, 13.28), (28.61, 13.68), fill: black90, stroke: none, radius: 0pt)
  content((16.17, 13.48), anchor: "center", text(size: 6.8pt, weight: "bold", fill: white)[Every release finishes with tests, hash verification, bundle-size reporting, and a desktop screenshot pass.])
})
